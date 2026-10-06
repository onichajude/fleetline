import { createClient, esc, hm, ago, haversine, localDate, tileLayer } from "/shared/client.js";
import { teamPanel } from "./team.js";

const client = createClient("fleetline.dispatch");
const $ = (s) => document.querySelector(s);

const ST = {
  enroute: ["En route", "var(--info)"], delayed: ["Delayed", "var(--warn)"], at_stop: ["At stop", "var(--ok)"],
  returning: ["Returning", "var(--ok)"], assigned: ["Assigned", "var(--assigned)"], idle: ["Idle", "var(--idle)"],
  offline: ["No signal", "var(--crit)"], off: ["Off shift", "var(--idle)"], maint: ["Maintenance", "var(--maint)"],
};
const FILTERS = [
  ["all", "All", () => true],
  ["moving", "On route", (v) => ["enroute", "delayed", "at_stop", "returning", "assigned"].includes(v.status)],
  ["delayed", "Delayed", (v) => v.status === "delayed"],
  ["idle", "Idle", (v) => v.status === "idle"],
  ["offline", "No signal", (v) => v.status === "offline"],
  ["off", "Off shift", (v) => v.status === "off" || v.status === "maint"],
];

const S = {
  me: null, config: null, fleet: new Map(), routes: new Map(), places: [], depots: [], drivers: [], alerts: [], analytics: null,
  anDate: localDate(), sel: { vid: null, rid: null }, tab: "vehicle", filter: "all", q: "", armed: null,
  builder: { active: false, stops: [], name: "", vehicle: "", depot: "" }, placeDraft: null, forms: {}, track: [], connected: false, users: [], resetFor: null, team: null, teamDate: localDate(), profile: null,
};

/* ---------- boot ---------- */
client.onSession((s) => { if (!s) location.reload(); });
if (client.session && client.session.user.role !== "driver") boot().catch(showLogin);
else showLogin();

function showLogin(err) {
  $("#app").hidden = true; $("#login").hidden = false;
  if (err?.message) $("#lerr").textContent = err.message;
  $("#lu").focus();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#lerr").textContent = "";
  try { await client.login($("#lu").value.trim(), $("#lp").value, "dispatch", $("#lcode").value.trim()); $("#login").hidden = true; await boot(); }
  catch (err) {
    $("#lerr").textContent = err.message;
    // Accounts with two-step sign-in need the code from the authenticator app.
    if (err.data?.mfa_required) { $("#lcodeWrap").hidden = false; $("#lcode").value = ""; $("#lcode").focus(); }
  }
});
$("#logout").addEventListener("click", () => client.logout());

/** Staff without two-step sign-in must set it up before the console loads any fleet data. */
async function showMfaSetup() {
  $("#login").hidden = true; $("#app").hidden = true; $("#mfa").hidden = false;
  const { secret, otpauth_uri } = await client.post("/api/me/mfa/setup");
  $("#mfaSecret").textContent = secret.match(/.{1,4}/g).join(" ");
  $("#mfaLink").href = otpauth_uri;
  $("#mfaCode").focus();
}
$("#mfaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#mfaErr").textContent = "";
  try {
    const r = await client.post("/api/me/mfa/enable", { code: $("#mfaCode").value.trim() });
    client.setToken(r.token);
    $("#mfa").hidden = true;
    await boot();
  } catch (err) { $("#mfaErr").textContent = err.message; }
});
$("#mfaCancel").addEventListener("click", () => client.logout());

async function boot() {
  const who = await client.get("/api/me");
  if (who.mfa_setup_required) return showMfaSetup();
  const [me, config, fleet, routes, places, depots, alerts, drivers] = await Promise.all([
    who, client.get("/api/config"), client.get("/api/fleet"), client.get("/api/routes"), client.get("/api/places"),
    client.get("/api/depots"), client.get("/api/alerts"), client.get("/api/drivers"),
  ]);
  Object.assign(S, { me, config, places, depots, alerts, drivers });
  if (me.role === "admin") S.users = await client.get("/api/users");
  fleet.forEach((v) => S.fleet.set(v.id, v));
  routes.forEach((r) => S.routes.set(r.id, r));
  $("#login").hidden = true; $("#app").hidden = false;
  $("#who").textContent = `${me.name} · ${me.role}`;
  $("#legend").innerHTML = ["enroute", "delayed", "at_stop", "assigned", "idle", "offline", "maint"].map((k) => `<span><i style="--c:${ST[k][1]}"></i>${ST[k][0]}</span>`).join("");
  initMap();
  connectSocket();
  setInterval(tickClock, 1000); tickClock();
  setInterval(refreshFleet, 20e3);
  setInterval(() => { if (S.tab === "analytics") loadAnalytics(); if (S.tab === "team" && !S.profile) loadTeam(); }, 30e3);
  const first = [...S.fleet.values()].find((v) => v.position && v.status !== "off") || [...S.fleet.values()][0];
  if (first) selectVehicle(first.id, false);
  render(true);
}
async function refreshFleet() {
  try { (await client.get("/api/fleet")).forEach((v) => { S.fleet.set(v.id, v); upsertMarker(v); }); scheduleRender(); } catch {}
}
function tickClock() {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString([], { hour12: false });
  $("#date").textContent = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/* ---------- socket ---------- */
let socket;
function connectSocket() {
  socket = io({ auth: { token: client.session.token } });
  const setLive = (on) => { S.connected = on; $("#live").classList.toggle("on", on); $("#live span").textContent = on ? "Live" : "Reconnecting"; };
  socket.on("connect", () => { setLive(true); refreshFleet(); });
  socket.on("disconnect", () => setLive(false));
  socket.on("connect_error", (e) => { setLive(false); if (e.message === "unauthorized") client.logout(); if (e.message === "mfa_setup_required") showMfaSetup(); });
  socket.on("vehicle", (v) => {
    const prev = S.fleet.get(v.id);
    S.fleet.set(v.id, v);
    upsertMarker(v);
    if (v.id === S.sel.vid && v.position && v.position.t !== prev?.position?.t) {
      S.track.push([v.position.lat, v.position.lng]);
      trackLine.setLatLngs(S.track);
    }
    scheduleRender();
  });
  socket.on("route", (r) => {
    S.routes.set(r.id, r);
    if (S.sel.rid === r.id || S.fleet.get(S.sel.vid)?.route?.id === r.id) drawOverlay();
    scheduleRender();
  });
  socket.on("alert", (a) => {
    S.alerts.unshift(a);
    if (a.severity === "crit") toast(`${a.vehicle_code || ""} ${a.message}`.trim(), true);
    if (a.kind === "route_done" && S.tab === "analytics") loadAnalytics();
    if (a.kind === "signup" && S.me.role === "admin") client.get("/api/users").then((u) => { S.users = u; render(true); }).catch(() => {});
    scheduleRender();
  });
}

/* ---------- map ---------- */
let map, vehLayer, placeLayer, routeLayer, trackLine, draftPin;
const markers = new Map(), placeMarkers = new Map();
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true });
  // Re-measure when the map's box changes (window resize, layout switch, page shown after loading hidden).
  // If the page loaded while hidden, the box had no size yet, so frame the city on the first real size.
  let framed = false;
  const frameCity = () => {
    const el = document.getElementById("map");
    if (!el.clientWidth || !el.clientHeight) return;
    const pts = [...S.depots, ...S.places].map((p) => [p.lat, p.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30] }); else map.setView([20, 0], 2);
    framed = true;
  };
  new ResizeObserver(() => { map.invalidateSize(); if (!framed) frameCity(); }).observe(document.getElementById("map"));
  tileLayer(S.config.tileUrl, { attribution: S.config.tileAttribution, maxZoom: 19 }).addTo(map);
  placeLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  trackLine = L.polyline([], { color: "#2c68bd", weight: 3, opacity: 0.55 }).addTo(map);
  vehLayer = L.layerGroup().addTo(map);
  for (const d of S.depots) {
    L.marker([d.lat, d.lng], { icon: L.divIcon({ className: "", html: `<div class="dm">${esc(d.code)}</div>`, iconSize: [34, 22], iconAnchor: [17, 11] }), zIndexOffset: 500 })
      .bindTooltip(esc(d.name), { direction: "top", offset: [0, -10] }).addTo(map);
  }
  drawPlaces();
  S.fleet.forEach(upsertMarker);
  map.setView([20, 0], 2); // placeholder until the box has a size
  frameCity();
  map.on("click", (e) => {
    if (!S.placeDraft) return;
    S.placeDraft = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) };
    if (draftPin) draftPin.setLatLng(e.latlng);
    else draftPin = L.marker(e.latlng, { icon: L.divIcon({ className: "", html: `<div class="newpin"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
    render(true);
  });
}
function drawPlaces() {
  placeLayer.clearLayers(); placeMarkers.clear();
  for (const p of S.places) {
    const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<div class="pm"></div>`, iconSize: [13, 13], iconAnchor: [6.5, 6.5] }) })
      .bindTooltip(esc(p.name), { direction: "top", offset: [0, -6] });
    m.on("click", () => {
      if (!S.builder.active) return;
      const i = S.builder.stops.indexOf(p.id);
      if (i >= 0) S.builder.stops.splice(i, 1); else S.builder.stops.push(p.id);
      render(true);
    });
    m.addTo(placeLayer); placeMarkers.set(p.id, m);
  }
}
function upsertMarker(v) {
  let m = markers.get(v.id);
  if (!v.position) { if (m) { vehLayer.removeLayer(m); markers.delete(v.id); } return; }
  const ll = [v.position.lat, v.position.lng];
  if (!m) {
    m = L.marker(ll, { icon: L.divIcon({ className: "", html: `<div class="vm"><span class="b"></span><span class="a"></span><span class="l"></span></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000 });
    m.on("click", () => selectVehicle(v.id));
    m.addTo(vehLayer); markers.set(v.id, m);
  } else m.setLatLng(ll);
  const el = m.getElement()?.firstElementChild;
  if (!el) return;
  el.style.setProperty("--c", ST[v.status][1]);
  el.classList.toggle("sel", v.id === S.sel.vid);
  el.classList.toggle("still", !(v.position.speed > 3) || ["off", "offline"].includes(v.status));
  el.classList.toggle("faded", ["off", "offline"].includes(v.status));
  el.querySelector(".a").style.transform = `rotate(${Math.round(v.position.heading || 0)}deg)`;
  el.querySelector(".l").textContent = v.code;
}
function stopColor(s) {
  const grace = S.config.lateGraceMin * 60e3;
  if (s.status === "completed") return s.arrived_at && s.planned_at && s.arrived_at > s.planned_at + grace ? "var(--warn)" : "var(--ok)";
  if (s.status === "arrived") return "var(--accent)";
  if (s.status === "skipped") return "var(--idle)";
  return "var(--info)";
}
function badge(lat, lng, n, color) {
  L.marker([lat, lng], { icon: L.divIcon({ className: "", html: `<div class="sb" style="--c:${color}">${n}</div>`, iconSize: [22, 22], iconAnchor: [11, 26] }), zIndexOffset: 800, interactive: false }).addTo(routeLayer);
}
function drawOverlay() {
  if (!routeLayer) return;
  routeLayer.clearLayers();
  for (const [id, m] of placeMarkers) m.getElement()?.firstElementChild?.classList.toggle("drafted", S.builder.active && S.builder.stops.includes(id));
  const banner = $("#banner");
  banner.hidden = !(S.builder.active || S.placeDraft);
  if (S.placeDraft) banner.innerHTML = `Adding a place: <b>click the map</b> where it is, then finish in the Setup tab.`;
  else if (S.builder.active) banner.innerHTML = `Route builder: <b>click places on the map</b> to add stops in order.`;
  if (S.builder.active) {
    const depot = S.depots.find((d) => d.id === Number(S.builder.depot));
    const pts = S.builder.stops.map((id) => S.places.find((p) => p.id === id)).filter(Boolean);
    const line = [...(depot ? [depot] : []), ...pts, ...(depot && pts.length ? [depot] : [])].map((p) => [p.lat, p.lng]);
    if (line.length > 1) L.polyline(line, { color: "#e0601a", weight: 3, dashArray: "8 7" }).addTo(routeLayer);
    pts.forEach((p, i) => badge(p.lat, p.lng, i + 1, "var(--accent)"));
    return;
  }
  const r = S.sel.rid ? S.routes.get(S.sel.rid) : S.routes.get(S.fleet.get(S.sel.vid)?.route?.id);
  if (!r) return;
  if (r.geometry?.coords) L.polyline(r.geometry.coords, { color: "#e0601a", weight: 5, opacity: 0.8 }).addTo(routeLayer);
  else {
    const line = [...(r.depot_lat != null ? [[r.depot_lat, r.depot_lng]] : []), ...r.stops.map((s) => [s.lat, s.lng])];
    L.polyline(line, { color: "#e0601a", weight: 3, dashArray: "8 7" }).addTo(routeLayer);
  }
  r.stops.forEach((s) => badge(s.lat, s.lng, s.seq, stopColor(s)));
}

/* ---------- selection ---------- */
async function selectVehicle(id, switchTab = true) {
  S.sel.vid = id; S.sel.rid = null; S.armed = null;
  if (switchTab) setTab("vehicle");
  S.fleet.forEach(upsertMarker);
  const v = S.fleet.get(id);
  S.track = [];
  trackLine?.setLatLngs([]);
  drawOverlay();
  render(true);
  if (v?.position && map) map.panTo([v.position.lat, v.position.lng], { animate: true });
  try {
    const since = Math.max(v?.shift_started_at || 0, Date.now() - 4 * 3600e3);
    const pts = await client.get(`/api/vehicles/${id}/track?since=${since}`);
    if (S.sel.vid !== id) return;
    S.track = pts.filter((p) => p.accuracy_m == null || p.accuracy_m <= 150).map((p) => [p.lat, p.lng]);
    trackLine.setLatLngs(S.track);
    trackLine.setStyle({ color: getComputedStyle(document.documentElement).getPropertyValue("--info").trim() || "#2c68bd" });
  } catch {}
}
function selectRoute(id) {
  S.sel.rid = S.sel.rid === id ? null : id;
  const r = S.routes.get(id);
  if (S.sel.rid && r) {
    if (r.vehicle_id && ["active", "dispatched"].includes(r.status)) { S.sel.vid = r.vehicle_id; S.fleet.forEach(upsertMarker); }
    const pts = r.geometry?.coords?.length ? r.geometry.coords.slice() : r.stops.map((s) => [s.lat, s.lng]);
    if (r.depot_lat != null) pts.push([r.depot_lat, r.depot_lng]);
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }
  drawOverlay();
  render(true);
}
function setTab(t) {
  S.tab = t;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
  if (t === "analytics") loadAnalytics();
  if (t === "team" && !S.profile) loadTeam();
}
async function loadTeam() {
  try {
    const [team, users] = await Promise.all([client.get(`/api/team?date=${S.teamDate}`), S.me.role === "admin" ? client.get("/api/users") : Promise.resolve(S.users)]);
    S.team = team; S.users = users; render(true);
  } catch (e) { toast(e.message, true); }
}
/** Opens a driver or vehicle performance page in the Team tab. */
async function openProfile(type, id) {
  S.profile = { type, id, data: null };
  setTab("team"); panel.scrollTop = 0; render(true);
  try {
    const data = await client.get(`/api/${type === "driver" ? "drivers" : "vehicles"}/${id}/profile?date=${S.teamDate}`);
    if (S.profile?.id === id && S.profile.type === type) { S.profile.data = data; lastPanel = ""; render(true); }
  } catch (e) { toast(e.message, true); S.profile = null; render(true); }
}
async function loadAnalytics() {
  try { S.analytics = await client.get(`/api/analytics?date=${S.anDate}`); render(true); } catch (e) { toast(e.message, true); }
}

/* ---------- rendering ---------- */
let holdPanel = false, holdList = false, lastPanel = "", renderQueued = false;
const panel = $("#panel"), vlist = $("#vlist");
panel.addEventListener("pointerdown", () => (holdPanel = true));
vlist.addEventListener("pointerdown", () => (holdList = true));
window.addEventListener("pointerup", () => setTimeout(() => { holdPanel = false; holdList = false; }, 0));
function scheduleRender() { if (renderQueued) return; renderQueued = true; setTimeout(() => { renderQueued = false; render(false); }, 300); }

function render(force) {
  renderKpis();
  if (force || !holdList) { const st = vlist.scrollTop; renderFleet(); vlist.scrollTop = st; }
  const ae = document.activeElement;
  const typing = ae && panel.contains(ae) && ["SELECT", "INPUT", "TEXTAREA"].includes(ae.tagName);
  if (force || (!holdPanel && !typing)) {
    const html = { vehicle: vehiclePanel, routes: routesPanel, analytics: analyticsPanel, alerts: alertsPanel, team: () => teamPanel(S), setup: setupPanel }[S.tab]();
    if (html !== lastPanel) { const st = panel.scrollTop; panel.innerHTML = html; panel.scrollTop = st; lastPanel = html; }
  }
  const open = S.alerts.filter((a) => !a.acked_at && a.severity !== "info").length;
  $("#acnt").hidden = !open; $("#acnt").textContent = open;
  const pending = S.users.filter((u) => u.approval === "pending").length;
  $("#tcnt").hidden = !pending; $("#tcnt").textContent = pending;
  drawOverlay();
}
const todayRoutes = () => [...S.routes.values()].filter((r) => r.service_date === localDate() && r.status !== "draft");
function renderKpis() {
  const vs = [...S.fleet.values()];
  const onShift = vs.filter((v) => !["off", "maint"].includes(v.status)).length;
  const delayed = vs.filter((v) => v.status === "delayed").length;
  const offline = vs.filter((v) => v.status === "offline").length;
  const grace = (S.config?.lateGraceMin || 10) * 60e3;
  let total = 0, done = 0, arrived = 0, ontime = 0;
  for (const r of todayRoutes()) for (const s of r.stops) {
    if (r.status !== "cancelled") total++;
    if (s.status === "completed") done++;
    if (s.arrived_at) { arrived++; if (!s.planned_at || s.arrived_at <= s.planned_at + grace) ontime++; }
  }
  const open = S.alerts.filter((a) => !a.acked_at && a.severity !== "info").length;
  $("#kpis").innerHTML = [
    ["On shift", `${onShift}<small>/${vs.length}</small>`, ""], ["Delayed", delayed, delayed ? "warn" : ""], ["No signal", offline, offline ? "crit" : ""],
    ["Delivered", `${done}<small>/${total}</small>`, ""], ["On-time", arrived ? `${Math.round((ontime / arrived) * 100)}<small>%</small>` : "—", arrived && ontime / arrived < 0.8 ? "warn" : ""],
    ["Open alerts", open, open ? "crit" : ""],
  ].map(([l, v, c]) => `<div class="kpi ${c}"><dt>${l}</dt><dd>${v}</dd></div>`).join("");
}
function vSub(v) {
  if (v.status === "maint") return "In maintenance";
  if (v.status === "off") return v.position ? `Off shift · last seen ${ago(v.position.t)}` : "Off shift";
  const who = v.driver ? v.driver.name : "";
  if (v.status === "offline") return `${who} · last fix ${ago(v.position?.t)}`;
  if (v.route?.next) return `${who} · ${v.route.code} ${v.route.done + 1}/${v.route.total} ${v.route.next.name}${v.route.next.status === "arrived" ? " · on site" : v.route.next.eta ? " · ETA " + hm(v.route.next.eta) : ""}`;
  if (v.route) return `${who} · ${v.route.code} all stops done`;
  return `${who} · no route`;
}
function renderFleet() {
  const vs = [...S.fleet.values()];
  $("#chips").innerHTML = FILTERS.map(([k, l, f]) => `<button class="chip" data-f="${k}" aria-pressed="${S.filter === k}">${l}<b>${vs.filter(f).length}</b></button>`).join("");
  const f = FILTERS.find((x) => x[0] === S.filter)[2], q = S.q.toLowerCase();
  const list = vs.filter((v) => f(v) && (!q || `${v.code} ${v.plate || ""} ${v.driver?.name || ""} ${v.type}`.toLowerCase().includes(q)));
  vlist.innerHTML = list.length ? list.map((v) => {
    const [l, c] = ST[v.status];
    const moving = v.position && !["off", "offline"].includes(v.status);
    return `<button class="vrow" data-vid="${v.id}" aria-current="${v.id === S.sel.vid}" style="--c:${c}"><span class="stripe"></span>
      <span><span class="id">${esc(v.code)}</span><span class="st">${l}</span></span><span class="spd">${moving ? Math.round(v.position.speed || 0) + " km/h" : "—"}</span>
      <span class="sub">${esc(vSub(v))}</span></button>`;
  }).join("") : `<div class="empty">No vehicles match.</div>`;
}
function etaChain(v, r) {
  // Client-side ETA for each pending stop: straight-line × 1.35 at 32 km/h plus dwell.
  const out = {};
  if (!v?.position || !r) return out;
  let t = Date.now(), prev = v.position;
  for (const s of r.stops) {
    if (s.status === "arrived") { t += (s.dwell_min || 8) * 60e3; prev = s; continue; }
    if (s.status !== "pending") continue;
    t += ((haversine(prev, s) * 1.35) / 1000 / 32) * 3600e3;
    out[s.id] = t; t += (s.dwell_min || 8) * 60e3; prev = s;
  }
  return out;
}
function vehiclePanel() {
  const v = S.fleet.get(S.sel.vid);
  if (!v) return `<div class="empty">Select a vehicle on the map or in the fleet list.</div>`;
  const [l, c] = ST[v.status];
  const r = v.route ? S.routes.get(v.route.id) : null;
  const p = v.position;
  const moving = p && !["off", "offline"].includes(v.status);
  let h = `<div class="vh-top"><div><div class="eyebrow">${esc(v.type)}${v.plate ? " · " + esc(v.plate) : ""}</div><h2>${esc(v.code)}</h2>
    <div class="muted">${v.driver ? `${esc(v.driver.name)}${v.driver.phone ? ` · <span class="mono">${esc(v.driver.phone)}</span>` : ""}` : "No driver on shift"}</div></div>
    <span class="pill" style="--c:${c}">${l}</span></div>
    <dl class="stats">
      <div><dt>Speed</dt><dd><b>${moving ? Math.round(p.speed || 0) : 0}</b> km/h <small>/ ${v.speed_limit_kmh} limit</small></dd></div>
      <div><dt>Last GPS fix</dt><dd>${p ? ago(p.t) : "never"}${p?.accuracy ? ` <small>±${Math.round(p.accuracy)} m</small>` : ""}</dd></div>
      <div><dt>Shift started</dt><dd>${v.shift_started_at ? hm(v.shift_started_at) : "—"}</dd></div>
      <div><dt>Coordinates</dt><dd>${p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "—"}</dd></div>
    </dl>`;
  if (r) {
    const eta = etaChain(v, r);
    const grace = S.config.lateGraceMin * 60e3;
    const done = r.stops.filter((s) => ["completed", "skipped"].includes(s.status)).length;
    const cur = r.stops.find((s) => ["pending", "arrived"].includes(s.status));
    h += `<h3>${esc(r.code)} · ${esc(r.name)}</h3><div class="muted" style="margin-bottom:6px">${r.status === "dispatched" ? "Sent to driver, not started" : `${done} of ${r.stops.length} stops done`}${r.geometry?.meters ? ` · ${(r.geometry.meters / 1000).toFixed(1)} km planned` : ""}</div><ol class="tl">`;
    for (const s of r.stops) {
      const late = s.arrived_at && s.planned_at ? Math.round((s.arrived_at - s.planned_at) / 60e3) : null;
      const tag = s.status === "completed" ? (late > S.config.lateGraceMin ? `+${late} min` : "Delivered") : s.status === "arrived" ? "On site" : s.status === "skipped" ? "Skipped" : s === cur ? "Next" : "";
      const tm = s.arrived_at ? `Plan ${hm(s.planned_at)} · Arrived ${hm(s.arrived_at)}${s.completed_at && s.status === "completed" ? ` · Done ${hm(s.completed_at)}` : ""}`
        : s.status === "skipped" ? `Plan ${hm(s.planned_at)}` : `Plan ${hm(s.planned_at)} · ETA ${eta[s.id] ? hm(eta[s.id]) : "—"}${eta[s.id] && s.planned_at && eta[s.id] > s.planned_at + grace ? " (late)" : ""}`;
      h += `<li class="${s === cur ? "cur" : ""}" style="--c:${stopColor(s)}"><span class="n">${s.seq}</span><span class="nm">${esc(s.name)}</span><span class="tag">${tag}</span><span class="tm">${tm}</span>${s.note ? `<span class="note">“${esc(s.note)}”</span>` : ""}</li>`;
    }
    h += `</ol>`;
  } else if (v.status !== "maint") {
    h += `<h3>Assignment</h3><div class="muted">No route assigned. Plan one from the Routes tab.</div>`;
  }
  h += `<div class="btns">`;
  if (r && ["dispatched", "active"].includes(r.status)) h += `<button class="btn danger ${S.armed === "cancel" + r.id ? "armed" : ""}" data-act="rcancel" data-rid="${r.id}">${S.armed === "cancel" + r.id ? "Confirm cancel" : "Cancel route"}</button>`;
  if (!r && v.status !== "maint") h += `<button class="btn primary" data-act="newroute" data-vid="${v.id}">Plan a route</button>`;
  h += `<button class="btn" data-act="maint" data-vid="${v.id}" data-on="${v.maintenance ? 0 : 1}">${v.maintenance ? "Return to service" : "Mark in maintenance"}</button>`;
  h += `<button class="btn" data-act="teamveh" data-id="${v.id}">Condition &amp; performance</button>`;
  if (v.driver) h += `<button class="btn" data-act="teamdrv" data-id="${v.driver.id}">${esc(v.driver.name.split(" ")[0])}'s profile</button>`;
  return h + `</div>`;
}
function vehicleOptions(selected, routeId = null) {
  const ok = [...S.fleet.values()].filter((v) => !v.maintenance && (!v.route || v.route.id === routeId));
  return `<option value="">Choose vehicle…</option>` + ok.map((v) => `<option value="${v.id}" ${String(v.id) === String(selected) ? "selected" : ""}>${esc(v.code)} · ${v.driver ? esc(v.driver.name) : ST[v.status][0]}</option>`).join("");
}
function optimizeIds(ids, start) {
  const pts = ids.map((id) => S.places.find((p) => p.id === id));
  if (pts.length < 3) return ids;
  const st = start || pts[0];
  let left = pts.map((_, i) => i), order = [], cur = st;
  while (left.length) { let bi = 0; left.forEach((i, j) => { if (haversine(cur, pts[i]) < haversine(cur, pts[left[bi]])) bi = j; }); cur = pts[left[bi]]; order.push(left.splice(bi, 1)[0]); }
  const cost = (o) => { let c = 0, p = st; for (const i of o) { c += haversine(p, pts[i]); p = pts[i]; } return c + (start ? haversine(p, start) : 0); };
  let improved = true;
  while (improved) { improved = false;
    for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
      const o = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
      if (cost(o) < cost(order) - 1e-6) { order = o; improved = true; }
    } }
  return order.map((i) => ids[i]);
}
function routesPanel() {
  let h = "";
  const B = S.builder;
  if (B.active) {
    const depot = S.depots.find((d) => d.id === Number(B.depot));
    const pts = B.stops.map((id) => S.places.find((p) => p.id === id)).filter(Boolean);
    let m = 0, prev = depot || pts[0];
    for (const p of pts) { m += haversine(prev, p); prev = p; }
    if (depot && pts.length) m += haversine(prev, depot);
    const km = (m * 1.35) / 1000, min = (km / 32) * 60 + pts.reduce((s, p) => s + (p.dwell_min || 8), 0);
    h += `<div class="builder"><div class="row" style="justify-content:space-between"><b>New route</b><span class="muted">${B.stops.length} stops</span></div>
      <input class="inp" data-b="name" placeholder="Route name, e.g. Friday pharmacy run" value="${esc(B.name)}" aria-label="Route name">
      <div class="row"><select data-b="depot" aria-label="Start and end depot"><option value="">No depot (start at first stop)</option>${S.depots.map((d) => `<option value="${d.id}" ${String(d.id) === String(B.depot) ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></div>
      ${pts.length ? `<ol>${pts.map((p, k) => `<li>${esc(p.name)}<button data-act="bdel" data-k="${k}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join("")}</ol>` : `<p class="muted" style="margin:0">Click place squares on the map, or pick from the list below.</p>`}
      <select data-b="add" aria-label="Add a stop"><option value="">Add a stop…</option>${S.places.filter((p) => !B.stops.includes(p.id)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>
      ${pts.length ? `<div class="est"><span>≈ ${km.toFixed(1)} km</span><span>≈ ${Math.round(min)} min incl. stops</span></div>` : ""}
      <div class="row"><select data-b="vehicle" aria-label="Vehicle">${vehicleOptions(B.vehicle)}</select><button class="btn" data-act="bopt" ${B.stops.length < 3 ? "disabled" : ""}>Optimize order</button></div>
      <div class="row"><button class="btn primary" data-act="bsave" data-dispatch="1" ${!B.stops.length || !B.vehicle ? "disabled" : ""}>Dispatch to driver</button>
      <button class="btn" data-act="bsave" ${!B.stops.length ? "disabled" : ""}>Save draft</button><button class="btn" data-act="bcancel">Cancel</button></div></div>`;
  } else h += `<div class="row" style="justify-content:space-between;margin-bottom:10px"><span class="muted">${S.routes.size} routes</span><button class="btn primary" data-act="newroute">New route</button></div>`;
  const today = localDate();
  const groups = [["On the road", (r) => r.status === "active"], ["Sent to driver", (r) => r.status === "dispatched"], ["Drafts", (r) => r.status === "draft"],
    ["Finished today", (r) => ["completed", "cancelled"].includes(r.status) && r.service_date === today]];
  const pill = { active: ["Active", "var(--info)"], dispatched: ["Dispatched", "var(--assigned)"], draft: ["Draft", "var(--muted)"], completed: ["Completed", "var(--ok)"], cancelled: ["Cancelled", "var(--crit)"] };
  const grace = S.config.lateGraceMin * 60e3;
  for (const [title, f] of groups) {
    const list = [...S.routes.values()].filter(f).sort((a, b) => a.code.localeCompare(b.code));
    if (!list.length) continue;
    h += `<h3>${title}</h3>`;
    for (const r of list) {
      const [pl, pc] = pill[r.status];
      const done = r.stops.filter((s) => s.status === "completed").length, ontime = r.stops.filter((s) => s.arrived_at && s.arrived_at <= s.planned_at + grace).length;
      const meta = r.status === "draft" ? `${r.stops.length} stops${r.depot_name ? " · from " + esc(r.depot_name) : ""}` :
        `${esc(r.vehicle_code || "—")} · ${done}/${r.stops.length} delivered · ${ontime} on time${r.completed_at ? " · ended " + hm(r.completed_at) : ""}`;
      h += `<div class="rcard ${S.sel.rid === r.id ? "sel" : ""}" data-rid="${r.id}"><div class="r1"><span><span class="rid">${esc(r.code)}</span> ${esc(r.name)}</span><span class="pill" style="--c:${pc}">${pl}</span></div>
        <div class="meta">${meta}${r.geometry?.meters ? ` · ${(r.geometry.meters / 1000).toFixed(1)} km` : ""}</div>
        <div class="prog">${r.stops.map((s) => `<i class="${s.status === "completed" && s.arrived_at > s.planned_at + grace ? "late" : s.status}"></i>`).join("")}</div>`;
      if (r.status === "draft" || r.status === "dispatched") {
        h += `<div class="row"><select data-rsel="${r.id}" aria-label="Vehicle for ${esc(r.code)}">${vehicleOptions(r.vehicle_id || "", r.id)}</select>
          <button class="btn sm primary" data-act="rdispatch" data-rid="${r.id}">${r.status === "draft" ? "Dispatch" : "Reassign"}</button>
          ${r.stops.length > 2 ? `<button class="btn sm" data-act="ropt" data-rid="${r.id}">Optimize</button>` : ""}
          ${r.status === "draft" ? `<button class="btn sm danger ${S.armed === "del" + r.id ? "armed" : ""}" data-act="rdelete" data-rid="${r.id}">${S.armed === "del" + r.id ? "Confirm delete" : "Delete"}</button>`
            : `<button class="btn sm danger ${S.armed === "cancel" + r.id ? "armed" : ""}" data-act="rcancel" data-rid="${r.id}">${S.armed === "cancel" + r.id ? "Confirm cancel" : "Cancel"}</button>`}</div>`;
      } else if (r.status === "active") {
        h += `<div class="row"><button class="btn sm danger ${S.armed === "cancel" + r.id ? "armed" : ""}" data-act="rcancel" data-rid="${r.id}">${S.armed === "cancel" + r.id ? "Confirm cancel" : "Cancel route"}</button></div>`;
      }
      h += `</div>`;
    }
  }
  return h;
}
function analyticsPanel() {
  const A = S.analytics;
  let h = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><label class="muted" for="anDate">Day</label><input class="inp" type="date" id="anDate" value="${S.anDate}" max="${localDate()}"></div>`;
  if (!A) return h + `<div class="empty">Loading analytics…</div>`;
  const sum = (k) => A.vehicles.reduce((s, v) => s + v[k], 0);
  const arrived = sum("ontime") + sum("late");
  const speeding = A.alertCounts.find((a) => a.kind === "speeding")?.n || 0;
  h += `<div class="mini">
    <div><dt>On-time arrivals</dt><dd>${arrived ? Math.round((sum("ontime") / arrived) * 100) : "—"}<small>${arrived ? "%" : ""}</small></dd></div>
    <div><dt>Delivered</dt><dd>${sum("delivered")} <small>${sum("skipped")} skipped</small></dd></div>
    <div><dt>Fleet distance</dt><dd>${sum("km").toFixed(1)} <small>km</small></dd></div>
    <div><dt>Driving time</dt><dd>${(sum("drivingMin") / 60).toFixed(1)} <small>h</small></dd></div>
    <div><dt>Shift time</dt><dd>${(sum("shiftMin") / 60).toFixed(1)} <small>h</small></dd></div>
    <div><dt>Speeding events</dt><dd>${speeding}</dd></div></div>`;
  const used = A.hours.filter((x) => x.ontime + x.late > 0).map((x) => x.h);
  const h0 = Math.min(6, ...used), h1 = Math.max(A.date === localDate() ? new Date().getHours() : 20, ...used, h0 + 3);
  const hrs = A.hours.slice(h0, h1 + 1);
  const W = 340, H = 150, pl = 26, pr = 6, pt = 8, pb = 20;
  const max = Math.max(4, Math.ceil(Math.max(...hrs.map((x) => x.ontime + x.late)) / 4) * 4);
  const y = (v) => pt + (H - pt - pb) * (1 - v / max), bw = (W - pl - pr) / hrs.length;
  let c = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Deliveries by hour">`;
  for (const g of [0, max / 2, max]) c += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(g)}" y2="${y(g)}"/><text x="${pl - 5}" y="${y(g) + 3}" text-anchor="end">${g}</text>`;
  hrs.forEach((d, i) => {
    const x = pl + i * bw + bw * 0.2, w = bw * 0.6;
    if (d.ontime) c += `<rect x="${x}" y="${y(d.ontime)}" width="${w}" height="${y(0) - y(d.ontime)}" fill="var(--ok)" rx="1.5"/>`;
    if (d.late) c += `<rect x="${x}" y="${y(d.ontime + d.late)}" width="${w}" height="${y(d.ontime) - y(d.ontime + d.late)}" fill="var(--warn)" rx="1.5"/>`;
    if (hrs.length <= 10 || i % 2 === 0) c += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${String(d.h).padStart(2, "0")}</text>`;
  });
  h += `<h3>Deliveries by hour</h3>${c}</svg><div class="lg"><span><i style="--c:var(--ok)"></i>On time</span><span><i style="--c:var(--warn)"></i>Late (&gt;${A.graceMin} min)</span></div>`;
  h += `<h3>Vehicle activity</h3><div class="util">`;
  for (const v of A.vehicles) {
    const shift = Math.max(v.shiftMin, v.drivingMin), pct = (x) => (shift ? (x / shift) * 100 : 0).toFixed(1);
    h += `<span class="vid">${esc(v.code)}</span>${shift ? `<span class="bar" title="Driving ${Math.round(v.drivingMin)} min of ${Math.round(shift)} min on shift"><i style="width:${pct(v.drivingMin)}%;background:var(--info)"></i><i style="width:${pct(shift - v.drivingMin)}%;background:var(--ok);opacity:.55"></i></span>` : `<span class="muted" style="font-size:11.5px">No shift</span>`}<span class="km">${v.km.toFixed(1)} km</span>`;
  }
  h += `</div><div class="lg"><span><i style="--c:var(--info)"></i>Driving</span><span><i style="--c:var(--ok)"></i>Stopped on shift</span></div>`;
  h += `<h3>Routes</h3>`;
  if (!A.routes.length) h += `<div class="muted">No routes ran on this day.</div>`;
  else {
    h += `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Route</th><th>Veh.</th><th>Delivered</th><th>On time</th><th>Plan km</th><th>Status</th></tr></thead><tbody>`;
    for (const r of A.routes) h += `<tr><td>${esc(r.code)}</td><td>${esc(r.vehicle_code || "—")}</td><td>${r.delivered}/${r.total}</td><td>${r.arrived ? Math.round((r.ontime / r.arrived) * 100) + "%" : "—"}</td><td>${r.plannedKm ? r.plannedKm.toFixed(1) : "—"}</td><td>${r.status}</td></tr>`;
    h += `</tbody></table></div>`;
  }
  return h;
}
function alertsPanel() {
  if (!S.alerts.length) return `<div class="empty">No alerts in the last 36 hours.</div>`;
  const C = { info: "var(--info)", warn: "var(--warn)", crit: "var(--crit)" };
  return `<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="muted">${S.alerts.filter((a) => !a.acked_at && a.severity !== "info").length} need attention</span><button class="btn sm" data-act="ackall">Acknowledge all</button></div><ul class="alist">` +
    S.alerts.slice(0, 150).map((a) => `<li class="${a.acked_at || a.severity === "info" ? "ack" : ""}" style="--c:${C[a.severity]}"><span class="s"></span>
      <span class="m">${a.vehicle_id ? `<button class="vl" data-act="goveh" data-vid="${a.vehicle_id}">${esc(a.vehicle_code)}</button> ` : ""}${esc(alertText(a))}</span>
      ${a.acked_at || a.severity === "info" ? "<span></span>" : `<button class="btn sm" data-act="ack" data-id="${a.id}">Ack</button>`}<span class="t">${new Date(a.created_at).toLocaleDateString() !== new Date().toLocaleDateString() ? new Date(a.created_at).toLocaleDateString([], { day: "numeric", month: "short" }) + " " : ""}${hm(a.created_at)}</span></li>`).join("") + `</ul>`;
}
const fv = (k) => esc(S.forms[k] ?? "");
// Alert text often starts with the vehicle code, which the UI already shows as a link.
const alertText = (a) => (a.vehicle_code && a.message.startsWith(a.vehicle_code + " ") ? a.message.slice(a.vehicle_code.length + 1) : a.message);
// Inline "set a new password" row for admins resetting someone else's password.
function resetRow(u) {
  if (S.resetFor !== u.id) return `<button class="btn sm" data-act="pwreset" data-id="${u.id}">Reset password</button>`;
  return `<span class="row"><input class="inp" type="password" data-f="reset.pw" value="${fv("reset.pw")}" placeholder="New password (8+)" aria-label="New password for ${esc(u.name)}" autocomplete="new-password">
    <button class="btn sm primary" data-act="pwresetsave" data-id="${u.id}">Save</button><button class="btn sm" data-act="pwresetcancel">Cancel</button></span>`;
}
function setupPanel() {
  const isAdmin = S.me.role === "admin";
  let h = `<h3>Your account</h3>
    <div class="form" style="margin-bottom:4px"><span class="muted">Signed in as <b>${esc(S.me.username)}</b> (${esc(S.me.role)}). Changing your password signs you out on your other devices.</span>
    <input class="inp" type="password" data-f="pw.current" value="${fv("pw.current")}" placeholder="Current password" aria-label="Current password" autocomplete="current-password">
    <div class="two"><input class="inp" type="password" data-f="pw.new" value="${fv("pw.new")}" placeholder="New password (8+ characters)" aria-label="New password" autocomplete="new-password">
    <input class="inp" type="password" data-f="pw.confirm" value="${fv("pw.confirm")}" placeholder="Repeat new password" aria-label="Repeat new password" autocomplete="new-password"></div>
    <div><button class="btn sm primary" data-act="pwchange">Change password</button></div></div>
    <p class="muted" style="margin:8px 0 0">Two-step sign-in: <b>${S.me.mfa_enabled ? "on" : "off"}</b>${S.me.mfa_enabled ? " (authenticator app)" : ` · <button class="btn link" data-act="mfaon">Turn on</button>`}</p>`;
  h += `<h3>Places</h3>`;
  if (S.placeDraft) {
    h += `<div class="builder form"><b>New place</b>
      <label>Name<input class="inp" data-f="place.name" value="${fv("place.name")}" placeholder="e.g. Bayview Pharmacy"></label>
      <label>Address (optional)<input class="inp" data-f="place.address" value="${fv("place.address")}"></label>
      <div class="two"><label>Typical stop time (min)<input class="inp" type="number" min="1" max="240" data-f="place.dwell" value="${fv("place.dwell") || 8}"></label>
      <label>Location<span class="mono" style="padding:6px 0">${S.placeDraft.lat ? `${S.placeDraft.lat}, ${S.placeDraft.lng}` : "Click the map"}</span></label></div>
      <div class="row"><button class="btn primary" data-act="psave" ${S.placeDraft.lat ? "" : "disabled"}>Save place</button><button class="btn" data-act="pcancel">Cancel</button></div></div>`;
  } else h += `<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="muted">${S.places.length} delivery places</span><button class="btn sm primary" data-act="padd">Add place</button></div>`;
  h += `<ul class="list">${S.places.map((p) => `<li><span>${esc(p.name)} <span class="muted">· ${p.dwell_min} min</span></span><span class="row"><button class="btn link" data-act="pzoom" data-id="${p.id}">Show</button><button class="btn sm danger ${S.armed === "pdel" + p.id ? "armed" : ""}" data-act="pdel" data-id="${p.id}">${S.armed === "pdel" + p.id ? "Confirm" : "Delete"}</button></span></li>`).join("")}</ul>`;

  h += `<h3>Drivers</h3>`;
  if (isAdmin) h += `<div class="form" style="margin-bottom:8px"><div class="two"><input class="inp" data-f="drv.name" placeholder="Full name" value="${fv("drv.name")}" aria-label="Driver name"><input class="inp" data-f="drv.phone" placeholder="Phone" value="${fv("drv.phone")}" aria-label="Driver phone"></div>
    <div class="two"><input class="inp" data-f="drv.username" placeholder="Username" value="${fv("drv.username")}" aria-label="Driver username" autocomplete="off"><input class="inp" type="password" data-f="drv.password" placeholder="Password (8+ characters)" value="${fv("drv.password")}" aria-label="Driver password" autocomplete="new-password"></div>
    <div class="two"><input class="inp" data-f="drv.license" placeholder="Licence number (optional)" value="${fv("drv.license")}" aria-label="Licence number">
    <select data-f="drv.vehicle" aria-label="Vehicle"><option value="">Assign vehicle (optional)…</option>${[...S.fleet.values()].map((v) => `<option value="${v.id}" ${String(S.forms["drv.vehicle"]) === String(v.id) ? "selected" : ""}>${esc(v.code)} · ${esc(v.type)}</option>`).join("")}</select></div>
    <div><button class="btn sm primary" data-act="dadd">Add driver</button></div></div>`;
  h += `<ul class="list">${S.drivers.map((d) => `<li><span><button class="btn link" data-act="teamdrv" data-id="${d.id}">${esc(d.name)}</button> <span class="muted mono">@${esc(d.username)}${d.usual_vehicle ? " · " + esc(d.usual_vehicle) : ""}</span>${d.active ? "" : ` <span class="muted">(disabled)</span>`}</span><span class="row"><span class="muted">${d.on_shift_vehicle ? "On shift · " + esc(d.on_shift_vehicle) : "Off shift"}</span>${isAdmin ? resetRow(d) : ""}</span></li>`).join("")}</ul>`;
  if (isAdmin) {
    const staff = S.users.filter((u) => u.role !== "driver" && u.id !== S.me.id);
    const admins = S.users.filter((u) => u.role === "admin" && u.active).length;
    h += `<h3>Staff</h3>
      ${admins < 2 ? `<div class="cond" style="--c:var(--warn);margin-bottom:8px;font-size:12.5px">Add a second admin. If the only admin loses their authenticator phone, nobody can reset it.</div>` : ""}
      <div class="form" style="margin-bottom:8px"><div class="two"><input class="inp" data-f="stf.name" placeholder="Full name" value="${fv("stf.name")}" aria-label="Staff name">
      <select data-f="stf.role" aria-label="Role"><option value="dispatcher" ${S.forms["stf.role"] !== "admin" ? "selected" : ""}>Dispatcher</option><option value="admin" ${S.forms["stf.role"] === "admin" ? "selected" : ""}>Admin</option></select></div>
      <div class="two"><input class="inp" data-f="stf.username" placeholder="Username" value="${fv("stf.username")}" aria-label="Staff username" autocomplete="off">
      <input class="inp" type="password" data-f="stf.password" placeholder="Temporary password (8+)" value="${fv("stf.password")}" aria-label="Temporary password" autocomplete="new-password"></div>
      <div><button class="btn sm primary" data-act="staffadd">Add staff</button></div></div>
      ${staff.length ? `<ul class="list">${staff.map((u) => `<li><span>${esc(u.name)} <span class="muted mono">@${esc(u.username)} · ${esc(u.role)}</span>${u.active ? "" : ` <span class="muted">(deactivated)</span>`}</span><span class="row">${resetRow(u)}<button class="btn sm ${S.armed === "mfareset" + u.id ? "danger armed" : ""}" data-act="mfareset" data-id="${u.id}">${S.armed === "mfareset" + u.id ? "Confirm" : "Reset two-step"}</button><button class="btn sm ${u.active ? "danger" : ""} ${S.armed === "staffact" + u.id ? "armed" : ""}" data-act="staffact" data-id="${u.id}" data-on="${u.active ? 0 : 1}">${S.armed === "staffact" + u.id ? "Confirm" : u.active ? "Deactivate" : "Reactivate"}</button></span></li>`).join("")}</ul>` : `<p class="muted">No other staff accounts.</p>`}
      <p class="muted" style="font-size:12px">Resetting a password signs that person out on all their devices. A driver on shift stops sending GPS until they sign in again. Resetting two-step sign-in (lost phone) makes them set it up again at their next sign-in.</p>`;

    // Privacy requests: right of access and erasure for drivers.
    const sel = S.forms["priv.driver"] || "";
    const chosen = S.drivers.find((d) => String(d.id) === String(sel));
    h += `<h3>Privacy requests</h3><div class="form">
      <span class="muted" style="font-size:12px">When a driver asks for a copy of their data, export it. When they leave and ask for deletion, erase it: their name, contact details and location history are removed; trips and deliveries stay as anonymous business records.</span>
      <select data-f="priv.driver" aria-label="Driver"><option value="">Choose driver…</option>${S.drivers.map((d) => `<option value="${d.id}" ${String(sel) === String(d.id) ? "selected" : ""}>${esc(d.name)} (@${esc(d.username)})</option>`).join("")}</select>
      ${chosen ? `<div class="row"><button class="btn sm" data-act="privexport" data-id="${chosen.id}">Export data (JSON)</button></div>
        <div class="row"><input class="inp" data-f="priv.confirm" value="${fv("priv.confirm")}" placeholder="Type ${esc(chosen.username)} to confirm" aria-label="Type the username to confirm erasure">
        <button class="btn sm danger" data-act="priverase" data-id="${chosen.id}">Erase personal data</button></div>` : ""}</div>`;

    h += `<h3>Audit log</h3>${S.audit ? `<div class="tbl-wrap"><table class="audit"><tbody>${S.audit.map((e) => `<tr><td>${new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</td>
        <td><span class="act">${esc(e.action)}</span><br><span class="muted">${esc(e.actor_username || "system")}${e.target_type ? ` → ${esc(e.target_type)} ${esc(e.target_id ?? "")}` : ""}${e.details ? ` · ${esc(JSON.stringify(e.details)).slice(0, 120)}` : ""}</span></td></tr>`).join("")}</tbody></table></div>
      ${S.audit.length >= 50 ? `<button class="btn sm" data-act="auditmore">Older entries</button>` : ""}`
      : `<button class="btn sm" data-act="auditload">Show audit log</button><p class="muted" style="font-size:12px">Sign-ins, password and two-step changes, approvals, data exports and erasures, route and vehicle changes.</p>`}`;
  }

  h += `<h3>Vehicles</h3>`;
  if (isAdmin) h += `<div class="form" style="margin-bottom:8px"><div class="two"><input class="inp" data-f="veh.code" placeholder="Code, e.g. VAN-206" value="${fv("veh.code")}" aria-label="Vehicle code"><input class="inp" data-f="veh.type" placeholder="Type, e.g. Cargo van" value="${fv("veh.type")}" aria-label="Vehicle type"></div>
    <div class="two"><input class="inp" data-f="veh.plate" placeholder="Plate" value="${fv("veh.plate")}" aria-label="Plate"><input class="inp" type="number" data-f="veh.limit" placeholder="Speed limit km/h (90)" value="${fv("veh.limit")}" aria-label="Speed limit"></div>
    <div class="two"><input class="inp" type="number" min="0" data-f="veh.odo" placeholder="Odometer now (km)" value="${fv("veh.odo")}" aria-label="Current odometer in km"><input class="inp" type="number" min="1000" data-f="veh.interval" placeholder="Service every (km), 10000" value="${fv("veh.interval")}" aria-label="Service interval in km"></div>
    <div class="two"><select data-f="veh.depot" aria-label="Home depot"><option value="">Home depot…</option>${S.depots.map((d) => `<option value="${d.id}" ${String(S.forms["veh.depot"]) === String(d.id) ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select>
    <select data-f="veh.driver" aria-label="Usual driver"><option value="">Usual driver…</option>${S.drivers.map((d) => `<option value="${d.id}" ${String(S.forms["veh.driver"]) === String(d.id) ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></div>
    <div><button class="btn sm primary" data-act="vadd">Add vehicle</button></div></div>`;
  h += `<ul class="list">${[...S.fleet.values()].map((v) => `<li><span><span class="mono">${esc(v.code)}</span> <span class="muted">· ${esc(v.type)} · ${v.speed_limit_kmh} km/h limit</span></span><span class="pill" style="--c:${ST[v.status][1]}">${ST[v.status][0]}</span></li>`).join("")}</ul>`;
  if (!isAdmin) h += `<p class="muted">Sign in as an admin to add drivers and vehicles.</p>`;
  return h;
}

/* ---------- events ---------- */
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; setTab(b.dataset.tab); panel.scrollTop = 0; render(true); });
$("#q").addEventListener("input", (e) => { S.q = e.target.value; render(true); });
$("#chips").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { S.filter = b.dataset.f; render(true); } });
vlist.addEventListener("click", (e) => { const b = e.target.closest("[data-vid]"); if (b) selectVehicle(Number(b.dataset.vid)); });
panel.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.f) S.forms[t.dataset.f] = t.value;
  if (t.dataset.b === "name") S.builder.name = t.value;
});
panel.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "anDate") { S.anDate = t.value || localDate(); S.analytics = null; loadAnalytics(); t.blur(); return; }
  if (t.id === "teamDate") { S.teamDate = t.value || localDate(); S.team = null; loadTeam(); t.blur(); return; }
  if (t.dataset.f) S.forms[t.dataset.f] = t.value;
  if (t.dataset.f === "priv.driver") { delete S.forms["priv.confirm"]; t.blur(); lastPanel = ""; render(true); return; }
  if (t.dataset.b === "depot") S.builder.depot = t.value;
  if (t.dataset.b === "vehicle") {
    S.builder.vehicle = t.value;
    const v = S.fleet.get(Number(t.value));
    if (v && !S.builder.depot && v.depot_id) S.builder.depot = String(v.depot_id);
  }
  if (t.dataset.b === "add" && t.value) S.builder.stops.push(Number(t.value));
  if (t.dataset.b) { t.blur(); render(true); }
});
panel.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) {
    const card = e.target.closest("[data-rid]");
    if (card && !e.target.closest("select")) selectRoute(Number(card.dataset.rid));
    return;
  }
  const act = b.dataset.act, rid = Number(b.dataset.rid);
  const arm = (key) => { if (S.armed === key) { S.armed = null; return true; } S.armed = key; render(true); return false; };
  try {
    if (act === "newroute") {
      const v = b.dataset.vid ? S.fleet.get(Number(b.dataset.vid)) : null;
      Object.assign(S.builder, { active: true, stops: [], name: "", vehicle: v ? String(v.id) : "", depot: v?.depot_id ? String(v.depot_id) : String(S.depots[0]?.id || "") });
      S.sel.rid = null; S.placeDraft = null; setTab("routes");
    } else if (act === "bdel") S.builder.stops.splice(Number(b.dataset.k), 1);
    else if (act === "bopt") { const d = S.depots.find((x) => x.id === Number(S.builder.depot)); S.builder.stops = optimizeIds(S.builder.stops, d); }
    else if (act === "bcancel") S.builder.active = false;
    else if (act === "bsave") {
      b.disabled = true;
      const r = await client.post("/api/routes", { name: S.builder.name, place_ids: S.builder.stops, depot_id: S.builder.depot || null, vehicle_id: b.dataset.dispatch ? S.builder.vehicle : null });
      S.routes.set(r.id, r); S.builder.active = false; S.sel.rid = r.id;
      toast(b.dataset.dispatch ? `${r.code} sent to ${r.vehicle_code}` : `${r.code} saved as a draft`);
    } else if (act === "rdispatch") {
      const sel = panel.querySelector(`select[data-rsel="${rid}"]`);
      if (!sel?.value) { sel?.focus(); toast("Choose a vehicle first.", true); return; }
      b.disabled = true;
      const r = await client.post(`/api/routes/${rid}/dispatch`, { vehicle_id: Number(sel.value) });
      S.routes.set(r.id, r); toast(`${r.code} sent to ${r.vehicle_code}`);
    } else if (act === "ropt") { const r = await client.post(`/api/routes/${rid}/optimize`); S.routes.set(r.id, r); S.sel.rid = r.id; toast(`${r.code} stop order optimized`); }
    else if (act === "rcancel") { if (!arm("cancel" + rid)) return; const r = await client.post(`/api/routes/${rid}/cancel`); S.routes.set(r.id, r); toast(`${r.code} cancelled`); }
    else if (act === "rdelete") { if (!arm("del" + rid)) return; await client.del(`/api/routes/${rid}`); S.routes.delete(rid); if (S.sel.rid === rid) S.sel.rid = null; toast("Draft deleted"); }
    else if (act === "maint") { await client.patch(`/api/vehicles/${b.dataset.vid}`, { maintenance: b.dataset.on === "1" }); await refreshFleet(); }
    else if (act === "ack") { await client.post(`/api/alerts/${b.dataset.id}/ack`); const a = S.alerts.find((x) => x.id === Number(b.dataset.id)); if (a) a.acked_at = Date.now(); }
    else if (act === "ackall") { await client.post("/api/alerts/ack-all"); S.alerts.forEach((a) => (a.acked_at ||= Date.now())); }
    else if (act === "goveh") { selectVehicle(Number(b.dataset.vid)); return; }
    else if (act === "padd") { S.placeDraft = {}; S.builder.active = false; }
    else if (act === "pcancel") { S.placeDraft = null; if (draftPin) { map.removeLayer(draftPin); draftPin = null; } }
    else if (act === "psave") {
      const p = await client.post("/api/places", { name: S.forms["place.name"], address: S.forms["place.address"], dwell_min: Number(S.forms["place.dwell"] || 8), ...S.placeDraft });
      S.places.push(p); S.places.sort((a, z) => a.name.localeCompare(z.name)); drawPlaces();
      S.placeDraft = null; if (draftPin) { map.removeLayer(draftPin); draftPin = null; }
      ["place.name", "place.address", "place.dwell"].forEach((k) => delete S.forms[k]);
      toast(`${p.name} added`);
    } else if (act === "pzoom") { const p = S.places.find((x) => x.id === Number(b.dataset.id)); if (p) { map.setView([p.lat, p.lng], 16); placeMarkers.get(p.id)?.openTooltip(); } return; }
    else if (act === "pdel") { const pid = Number(b.dataset.id); if (!arm("pdel" + pid)) return; await client.del(`/api/places/${pid}`); S.places = S.places.filter((p) => p.id !== pid); drawPlaces(); toast("Place deleted"); }
    else if (act === "teamdrv") { await openProfile("driver", Number(b.dataset.id)); return; }
    else if (act === "teamveh") { await openProfile("vehicle", Number(b.dataset.id)); return; }
    else if (act === "teamback") { S.profile = null; loadTeam(); }
    else if (act === "approve") {
      const uid = Number(b.dataset.id), sel = panel.querySelector(`select[data-approve="${uid}"]`);
      await client.post(`/api/users/${uid}/approve`, { vehicle_id: sel?.value || null });
      const u = S.users.find((x) => x.id === uid);
      S.drivers = await client.get("/api/drivers"); await loadTeam(); refreshFleet();
      toast(`${u ? u.name : "Driver"} approved. They can sign in now.`);
    } else if (act === "decline") {
      const uid = Number(b.dataset.id);
      if (!arm("decline" + uid)) return;
      await client.post(`/api/users/${uid}/decline`); await loadTeam(); toast("Sign-up declined.");
    } else if (act === "service") {
      const vid = Number(b.dataset.id);
      const data = await client.post(`/api/vehicles/${vid}/service`, { note: S.forms["svc.note"] || "" });
      delete S.forms["svc.note"];
      if (S.profile?.type === "vehicle" && S.profile.id === vid) S.profile.data = data;
      toast(`Service recorded for ${data.vehicle.code}.`);
    }
    else if (act === "pwchange") {
      const cur = S.forms["pw.current"] || "", next = S.forms["pw.new"] || "";
      if (!cur || !next) { toast("Enter your current password and a new one.", true); return; }
      if (next !== S.forms["pw.confirm"]) { toast("The two new passwords don't match.", true); return; }
      const r = await client.post("/api/me/password", { current_password: cur, new_password: next });
      client.setToken(r.token);
      if (socket) socket.auth.token = r.token;
      ["pw.current", "pw.new", "pw.confirm"].forEach((k) => delete S.forms[k]);
      toast("Password changed. Your other devices have been signed out.");
    } else if (act === "mfaon") { await showMfaSetup(); return; }
    else if (act === "staffadd") {
      const u = await client.post("/api/users", { name: S.forms["stf.name"], username: S.forms["stf.username"], password: S.forms["stf.password"], role: S.forms["stf.role"] || "dispatcher" });
      ["stf.name", "stf.username", "stf.password", "stf.role"].forEach((k) => delete S.forms[k]);
      S.users = await client.get("/api/users");
      toast(`${u.name} added as ${u.role}. They'll set up two-step sign-in when they first sign in.`);
    } else if (act === "staffact") {
      const uid = Number(b.dataset.id);
      if (!arm("staffact" + uid)) return;
      await client.patch(`/api/users/${uid}`, { active: b.dataset.on === "1" });
      S.users = await client.get("/api/users");
      toast(b.dataset.on === "1" ? "Account reactivated." : "Account deactivated and signed out everywhere.");
    }
    else if (act === "mfareset") {
      const uid = Number(b.dataset.id);
      if (!arm("mfareset" + uid)) return;
      await client.post(`/api/users/${uid}/mfa-reset`);
      toast("Two-step sign-in reset. They'll set it up again at their next sign-in.");
    } else if (act === "auditload") { S.audit = await client.get("/api/audit?limit=50"); }
    else if (act === "auditmore") { S.audit = S.audit.concat(await client.get(`/api/audit?limit=50&before=${S.audit[S.audit.length - 1].id}`)); }
    else if (act === "privexport") {
      const d = S.drivers.find((x) => x.id === Number(b.dataset.id));
      await client.download(`/api/drivers/${b.dataset.id}/export`, `fleetline-driver-${d?.username || b.dataset.id}.json`);
      toast("Export downloaded. Send it to the driver securely.");
    } else if (act === "priverase") {
      const r = await client.post(`/api/drivers/${b.dataset.id}/erase`, { confirm_username: S.forms["priv.confirm"] || "" });
      ["priv.driver", "priv.confirm"].forEach((k) => delete S.forms[k]);
      S.drivers = await client.get("/api/drivers"); S.users = await client.get("/api/users");
      toast(`Personal data erased (${r.positions_deleted} location points deleted).`);
    } else if (act === "pwreset") { S.resetFor = Number(b.dataset.id); delete S.forms["reset.pw"]; }
    else if (act === "pwresetcancel") { S.resetFor = null; delete S.forms["reset.pw"]; }
    else if (act === "pwresetsave") {
      const uid = Number(b.dataset.id), u = S.users.find((x) => x.id === uid);
      await client.post(`/api/users/${uid}/password`, { new_password: S.forms["reset.pw"] || "" });
      S.resetFor = null; delete S.forms["reset.pw"];
      toast(`New password set for ${u ? u.name : "that user"}. They've been signed out everywhere.`);
    }
    else if (act === "dadd") {
      const d = await client.post("/api/drivers", { name: S.forms["drv.name"], username: S.forms["drv.username"], password: S.forms["drv.password"], phone: S.forms["drv.phone"], license_no: S.forms["drv.license"], vehicle_id: S.forms["drv.vehicle"] || null });
      S.drivers = await client.get("/api/drivers"); if (S.me.role === "admin") S.users = await client.get("/api/users"); ["drv.name", "drv.username", "drv.password", "drv.phone", "drv.license", "drv.vehicle"].forEach((k) => delete S.forms[k]);
      toast(`${d.name} can now sign in to the driver app as ${d.username}`);
    } else if (act === "vadd") {
      const v = await client.post("/api/vehicles", { code: S.forms["veh.code"], type: S.forms["veh.type"], plate: S.forms["veh.plate"], speed_limit_kmh: S.forms["veh.limit"], depot_id: S.forms["veh.depot"], default_driver_id: S.forms["veh.driver"], odometer_km: S.forms["veh.odo"], service_interval_km: S.forms["veh.interval"] });
      ["veh.code", "veh.type", "veh.plate", "veh.limit", "veh.depot", "veh.driver", "veh.odo", "veh.interval"].forEach((k) => delete S.forms[k]);
      await refreshFleet(); toast(`${v.code} added`);
    }
  } catch (err) { toast(err.message, true); }
  S.armed = null;
  lastPanel = ""; // redraw even if the markup is unchanged, so cleared form fields really clear
  render(true);
});

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg; t.classList.toggle("err", isErr); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 3000);
}
