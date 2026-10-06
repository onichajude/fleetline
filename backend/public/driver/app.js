import { createClient, esc, hm, ago, haversine, tileLayer } from "/shared/client.js";
import { signupHtml, checkHtml, statsHtml } from "./extras.js";

const client = createClient("fleetline.driver");
const root = document.getElementById("root");
const QKEY = "fleetline.driver.queue";

const S = { state: null, picked: null, armed: null, skipReason: "", note: "", loading: false, view: "today", profile: null, check: { items: {}, notes: "", later: false } };
const G = { watchId: null, status: "off", last: null, lastRecorded: null, lastSentAt: null, error: "", flushing: false, wake: null, gapWarn: false };
let queue = [];
try { queue = JSON.parse(localStorage.getItem(QKEY)) || []; } catch { queue = []; }
const saveQueue = () => { try { localStorage.setItem(QKEY, JSON.stringify(queue.slice(-5000))); } catch {} };

if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/driver/sw.js", { scope: "/driver/" }).catch(() => {});
client.onSession((s) => { if (!s) { stopGps(); location.reload(); } });

/* ---------- screens ---------- */
function loginScreen(msg = "") {
  root.innerHTML = `<form class="login" id="lf">
    <div class="brand">${logo()} Fleetline Driver</div>
    <h1>Sign in</h1>
    <label>Username<input id="lu" autocomplete="username" autocapitalize="none" required></label>
    <label>Password<input id="lp" type="password" autocomplete="current-password" required></label>
    <div class="err" id="le">${esc(msg)}</div>
    <button class="btn primary block" type="submit">Sign in</button>
    <button class="btn block" type="button" id="toSignup">New driver? Request an account</button>
    ${insecureNote()}
  </form>`;
  document.getElementById("toSignup").addEventListener("click", signupScreen);
  document.getElementById("lf").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await client.login(document.getElementById("lu").value.trim(), document.getElementById("lp").value, "driver"); await start(); }
    catch (err) { document.getElementById("le").textContent = err.message; }
  });
}
function signupScreen() {
  root.innerHTML = signupHtml();
  const v = (id) => document.getElementById(id).value;
  document.getElementById("su-back").addEventListener("click", () => loginScreen());
  document.getElementById("sf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("su-err");
    err.textContent = "";
    try {
      const r = await client.post("/api/auth/register", { name: v("su-name").trim(), phone: v("su-phone").trim(), license_no: v("su-lic").trim(),
        vehicle_type: v("su-type"), username: v("su-user").trim().toLowerCase(), password: v("su-pass") });
      root.innerHTML = `<div class="login card" style="margin-top:8vh;padding:20px"><h1>Request sent</h1><p>${esc(r.message)}</p>
        <p class="muted">Your username is <b>${esc(v("su-user").trim().toLowerCase())}</b>. Sign in once your dispatcher approves you.</p>
        <button class="btn primary block" id="su-done">Back to sign in</button></div>`;
      document.getElementById("su-done").addEventListener("click", () => loginScreen());
    } catch (ex) { err.textContent = ex.message; }
  });
  document.getElementById("su-name").focus();
}
const logo = () => `<svg width="28" height="28" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="7" fill="var(--fg)"/><path d="M7 20 L13 10 L17 16 L23 8" stroke="var(--accent)" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const insecureNote = () => isSecureContext ? "" :
  `<div class="warnbox crit">Phones only share location over a secure connection. Open the <b>https://</b> address your dispatcher gave you instead of this one.</div>`;

function shell() {
  root.innerHTML = `
    <header class="top"><div class="brand">${logo()} Fleetline</div><span class="muted" id="who"></span></header>
    <div class="seg2 views" role="tablist"><button role="tab" data-act="view" data-v="today" aria-pressed="true">Today</button><button role="tab" data-act="view" data-v="stats" aria-pressed="false">My stats</button></div>
    <section id="stats" class="statsview" hidden></section>
    <div id="gps"></div>
    <section id="check"></section>
    <div id="warn"></div>
    <section id="body"></section>
    <div id="minimap" hidden></div>
    <section id="list"></section>
    <div class="foot" id="foot"></div>
    <section id="account"></section>`;
  root.addEventListener("click", onClick);
  root.addEventListener("input", (e) => { if (e.target.id === "note") S.note = e.target.value; if (e.target.id === "chknotes") S.check.notes = e.target.value; });
  root.addEventListener("change", (e) => { if (e.target.id === "reason") S.skipReason = e.target.value; });
}

async function start() {
  shell();
  renderAccount(false);
  await loadState();
  connectSocket();
  setInterval(loadState, 60e3);
  setInterval(flush, 5000);
  setInterval(updateGps, 1000);
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { if (S.state?.shift) requestWake(); if (G.last && Date.now() - G.last.t > 60e3) G.gapWarn = true; loadState(); flush(); }
  });
}
if (client.session?.user?.role === "driver") start().catch((e) => loginScreen(e.message)); else loginScreen();

async function loadState() {
  try {
    S.state = await client.get("/api/driver/state");
    if (S.state.shift && G.watchId == null) startGps();
    if (!S.state.shift && G.watchId != null) stopGps();
    render();
  } catch (e) { if (S.state) toast(e.message, true); else loginScreen(e.message); }
}
let socket;
function connectSocket() {
  socket = io({ auth: { token: client.session.token } });
  socket.on("route", (r) => {
    const prev = S.state?.route;
    if (!prev || prev.id !== r.id) { toast(r.status === "cancelled" ? `Route ${r.code} was cancelled` : `New route: ${r.code} · ${r.stops.length} stops`); navigator.vibrate?.([200, 100, 200]); }
    else if (r.status === "cancelled") { toast(`Dispatch cancelled ${r.code}`, true); navigator.vibrate?.([300, 100, 300]); }
    loadState();
  });
  socket.on("connect", () => loadState());
  socket.on("connect_error", (e) => { if (e.message === "unauthorized") client.logout(); });
}

/* ---------- GPS ---------- */
function startGps() {
  if (!("geolocation" in navigator)) { G.status = "unsupported"; return updateGps(); }
  if (!isSecureContext) { G.status = "insecure"; return updateGps(); }
  G.status = "waiting";
  G.watchId = navigator.geolocation.watchPosition(onPos, onPosError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  requestWake();
  updateGps();
}
function stopGps() {
  if (G.watchId != null) navigator.geolocation.clearWatch(G.watchId);
  G.watchId = null; G.status = "off";
  G.wake?.release?.().catch(() => {}); G.wake = null;
}
function onPos(p) {
  const c = p.coords;
  const pt = { lat: c.latitude, lng: c.longitude, accuracy: Math.round(c.accuracy), t: p.timestamp || Date.now(),
    speed: c.speed != null && !Number.isNaN(c.speed) ? +(c.speed * 3.6).toFixed(1) : null,
    heading: c.heading != null && !Number.isNaN(c.heading) ? Math.round(c.heading) : null };
  G.last = pt; G.status = "live";
  const r = G.lastRecorded;
  // Record a fix every 10 m of movement or every 15 s when stationary.
  if (!r || haversine(r, pt) >= 10 || pt.t - r.t >= 15000) { queue.push(pt); G.lastRecorded = pt; saveQueue(); }
  updateGps(); updateMe();
}
function onPosError(e) {
  G.status = e.code === 1 ? "denied" : "error";
  G.error = e.message;
  updateGps();
}
async function flush() {
  if (G.flushing || !queue.length || !navigator.onLine || !S.state?.shift) return;
  G.flushing = true;
  const batch = queue.slice(0, 500);
  try {
    await client.post("/api/driver/positions", { points: batch });
    queue.splice(0, batch.length); saveQueue(); G.lastSentAt = Date.now();
  } catch (e) {
    if (e.status === 409) { queue = []; saveQueue(); }
  } finally { G.flushing = false; updateGps(); }
}
async function requestWake() {
  try { if ("wakeLock" in navigator && !G.wake && document.visibilityState === "visible") { G.wake = await navigator.wakeLock.request("screen"); G.wake.addEventListener("release", () => (G.wake = null)); } } catch {}
}
function updateGps() {
  const el = document.getElementById("gps");
  if (!el) return;
  if (!S.state?.shift) { el.innerHTML = ""; return; }
  const meta = {
    live: ["var(--ok)", "GPS live"], waiting: ["var(--warn)", "Finding your location…"], denied: ["var(--crit)", "Location blocked"],
    error: ["var(--crit)", "GPS problem"], off: ["var(--idle)", "GPS off"], unsupported: ["var(--crit)", "This browser has no GPS access"], insecure: ["var(--crit)", "Needs a secure (https) address"],
  }[G.status];
  const stale = G.status === "live" && G.last && Date.now() - G.last.t > 45e3;
  const color = stale ? "var(--warn)" : meta[0];
  const sent = G.lastSentAt ? `sent ${ago(G.lastSentAt)}` : "not sent yet";
  el.innerHTML = `<div class="gps ${G.status === "live" && !stale ? "live" : ""}" style="--c:${color}"><span class="dot"></span>
    <span><b>${stale ? "Weak GPS signal" : meta[1]}</b><br><span class="muted">${G.last ? `±${G.last.accuracy} m · ${sent}${queue.length > 1 ? ` · ${queue.length} waiting` : ""}` : esc(G.error || "")}${navigator.onLine ? "" : " · offline, saving locally"}</span></span>
    <span class="sp">${G.last?.speed != null ? Math.round(G.last.speed) : "–"}<small> km/h</small></span></div>`;
  const w = document.getElementById("warn");
  let warn = "";
  if (G.status === "denied") warn = `<div class="warnbox crit">Location access is blocked. Open your browser's site settings, allow <b>Location</b> for this app, then reload.</div>`;
  else if (G.status === "insecure") warn = insecureNote();
  else if (G.gapWarn) warn = `<div class="warnbox">Tracking paused while the app was closed or the phone was locked. Keep Fleetline open on screen while driving. <button class="btn sm" data-act="dismissgap">OK</button></div>`;
  if (w.innerHTML !== warn) w.innerHTML = warn;
}

/* ---------- route rendering ---------- */
const STOP = { pending: ["var(--info)", ""], arrived: ["var(--accent)", "On site"], completed: ["var(--ok)", "Delivered"], skipped: ["var(--idle)", "Skipped"] };
const navUrl = (s) => /iPhone|iPad|iPod/.test(navigator.userAgent)
  ? `https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d`
  : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;

function renderCheck() {
  const el = document.getElementById("check");
  if (!el || el.contains(document.activeElement)) return; // don't interrupt typing
  const st = S.state;
  const html = st?.shift && !st.inspection_done && !S.check.later && S.view === "today" ? checkHtml(st, S.check) : "";
  if (el.innerHTML !== html) el.innerHTML = html;
}
async function loadProfile() {
  try { S.profile = await client.get("/api/driver/profile"); } catch (e) { toast(e.message, true); }
  if (S.view === "stats") document.getElementById("stats").innerHTML = statsHtml(S.profile);
}
function render() {
  const st = S.state;
  root.dataset.view = S.view;
  for (const b of document.querySelectorAll(".views button")) b.setAttribute("aria-pressed", String(b.dataset.v === S.view));
  document.getElementById("stats").hidden = S.view !== "stats";
  renderCheck();
  document.getElementById("who").textContent = st.user.name;
  updateGps();
  const body = document.getElementById("body"), list = document.getElementById("list"), foot = document.getElementById("foot"), mm = document.getElementById("minimap");
  const typing = document.activeElement && ["TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && body.contains(document.activeElement);

  if (!st.shift && st.privacy?.required) {
    // Location is only collected after the driver has read and accepted the current notice.
    mm.hidden = true; list.innerHTML = "";
    const n = st.privacy.notice;
    body.innerHTML = `<div class="card" style="display:flex;flex-direction:column;gap:12px"><h1>${esc(n.title)}</h1>
      <ul class="notice">${n.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
      <p class="muted" style="margin:0;font-size:13px">Notice version ${esc(n.version)}${st.privacy.accepted_version ? `. You accepted an earlier version on ${new Date(st.privacy.accepted_at).toLocaleDateString()}; it has changed.` : "."}</p>
      <button class="btn primary block" data-act="privacyack" data-v="${esc(n.version)}">I understand. Continue</button></div>`;
    foot.innerHTML = `<button class="btn sm" data-act="logout">Sign out</button>`;
    return;
  }
  if (!st.shift) {
    mm.hidden = true; list.innerHTML = "";
    if (!S.picked && st.vehicles.length) S.picked = (st.vehicles.find((v) => v.mine) || st.vehicles[0]).id;
    body.innerHTML = `<div class="card" style="display:flex;flex-direction:column;gap:12px"><h1>Start your shift</h1>
      <p class="muted" style="margin:0">Choose the vehicle you're driving. Your location is shared with dispatch only while you're on shift.</p>
      ${st.vehicles.length ? `<div class="vpick">${st.vehicles.map((v) => `<button class="vopt" data-act="pick" data-id="${v.id}" aria-pressed="${S.picked === v.id}"><span class="code">${esc(v.code)}</span><span class="muted">${esc(v.type)}${v.plate ? " · " + esc(v.plate) : ""}</span>${v.mine ? `<span class="tag">Your usual</span>` : ""}</button>`).join("")}</div>
      <button class="btn primary block" data-act="startshift" ${S.picked ? "" : "disabled"}>Start shift &amp; share location</button>` : `<div class="warnbox">No vehicles are free right now. Ask dispatch to release one.</div>`}
      ${insecureNote()}</div>`;
    foot.innerHTML = `<button class="btn sm" data-act="logout">Sign out</button>`;
    return;
  }

  const r = st.route;
  if (!typing) {
    if (!r && st.finished) {
      const f = st.finished, n = (k) => f.stops.filter((s) => s.status === k).length;
      body.innerHTML = `<div class="card"><h2>${esc(f.code)} · ${f.status === "cancelled" ? "cancelled by dispatch" : "complete"}</h2><h1 style="margin-top:4px">${f.status === "cancelled" ? "Route cancelled" : "All stops done"}</h1>
        <p class="muted" style="margin:6px 0 0">${n("completed")} delivered${n("skipped") ? `, ${n("skipped")} skipped` : ""}. ${f.depot_name ? `Head back to ${esc(f.depot_name)}. ` : ""}Your next route appears here when dispatch sends it.</p></div>`;
    } else if (!r) body.innerHTML = `<div class="card"><h2>${esc(st.vehicle.code)}</h2><h1 style="margin-top:4px">No route yet</h1><p class="muted" style="margin:6px 0 0">Stay on this screen. Your stops appear here as soon as dispatch sends them.</p></div>`;
    else if (r.status === "dispatched") {
      body.innerHTML = `<div class="card next"><span class="eyebrow">New route · ${esc(r.code)}</span><span class="name">${esc(r.name)}</span>
        <div class="facts"><span><b>${r.stops.length}</b> stops</span>${r.geometry?.meters ? `<span><b>${(r.geometry.meters / 1000).toFixed(1)}</b> km</span>` : ""}<span>First stop <b>${esc(r.stops[0]?.name || "")}</b></span></div>
        <button class="btn primary block" data-act="startroute" data-id="${r.id}">Start route</button></div>`;
    } else {
      const cur = r.stops.find((s) => s.status === "arrived") || r.stops.find((s) => s.status === "pending");
      if (cur) {
        const dist = G.last ? haversine(G.last, cur) : null;
        const lateBy = cur.planned_at ? Math.round((Date.now() - cur.planned_at) / 60e3) : 0;
        body.innerHTML = `<div class="card next"><span class="eyebrow">Stop ${cur.seq} of ${r.stops.length}${cur.status === "arrived" ? " · on site" : ""}</span>
          <span class="name">${esc(cur.name)}</span>
          ${cur.address ? `<span class="muted">${esc(cur.address)}</span>` : ""}
          <div class="facts"><span>Due <b>${hm(cur.planned_at)}</b>${lateBy > 0 && cur.status === "pending" ? ` <span class="late">(${lateBy} min behind)</span>` : ""}</span>${dist != null ? `<span><b>${dist < 1000 ? Math.round(dist) + " m" : (dist / 1000).toFixed(1) + " km"}</b> away</span>` : ""}</div>
          ${cur.status === "pending" ? `<div class="grid2"><a class="btn" href="${navUrl(cur)}" target="_blank" rel="noopener">Navigate</a><button class="btn go" data-act="arrive" data-id="${cur.id}">I've arrived</button></div>
             <span class="muted" style="font-size:13px">Arrival is marked automatically within ${st.config.geofenceM} m of the stop.</span>`
            : `<textarea class="field" id="note" placeholder="Delivery note (optional): who signed, where you left it…">${esc(S.note)}</textarea>
               <button class="btn go block" data-act="complete" data-id="${cur.id}">Delivered</button>`}
          ${S.armed === "skip" + cur.id ? `<select class="field" id="reason" aria-label="Reason for skipping"><option value="">Why are you skipping this stop?</option>${["Customer closed", "No one to receive", "Access blocked", "Wrong address", "Out of time", "Damaged goods"].map((x) => `<option ${S.skipReason === x ? "selected" : ""}>${x}</option>`).join("")}</select>
             <div class="grid2"><button class="btn" data-act="unarm">Keep stop</button><button class="btn danger armed" data-act="skip" data-id="${cur.id}">Skip stop</button></div>`
            : `<button class="btn sm danger" data-act="armskip" data-id="${cur.id}" style="align-self:flex-start">Can't deliver? Skip stop</button>`}
        </div>`;
      } else body.innerHTML = `<div class="card"><h1>All stops done</h1><p class="muted">Head back to ${esc(r.depot_name || "the depot")}.</p></div>`;
    }
  }
  list.innerHTML = r ? `<h2>${esc(r.code)} · ${esc(r.name)}</h2><div class="card" style="padding:4px 16px"><ol class="stops">${r.stops.map((s) => {
    const [c, label] = STOP[s.status];
    return `<li class="${["completed", "skipped"].includes(s.status) ? "done" : ""}" style="--c:${c}"><span class="n">${s.seq}</span><span class="nm">${esc(s.name)}</span><span class="st">${label}</span>
      <span class="tm">${s.arrived_at ? `Arrived ${hm(s.arrived_at)}` : `Due ${hm(s.planned_at)}`}</span></li>`;
  }).join("")}</ol></div>` : "";
  foot.innerHTML = `<button class="btn danger ${S.armed === "end" ? "armed" : ""}" data-act="endshift">${S.armed === "end" ? "Tap again to end shift" : `End shift in ${esc(st.vehicle.code)}`}</button>`;
  mm.hidden = false;
  drawMini();
}

/* ---------- account ---------- */
function renderAccount(open) {
  const el = document.getElementById("account");
  if (!el) return;
  el.innerHTML = !open ? `<button class="btn sm" data-act="pwopen" style="width:100%">Change password</button>`
    : `<form class="card" id="pwform" style="display:flex;flex-direction:column;gap:10px">
        <h2 style="margin:0">Change password</h2>
        <input class="field" type="password" id="pwcur" placeholder="Current password" autocomplete="current-password" aria-label="Current password" required>
        <input class="field" type="password" id="pwnew" placeholder="New password (8+ characters)" autocomplete="new-password" aria-label="New password" minlength="8" required>
        <input class="field" type="password" id="pwrep" placeholder="Repeat new password" autocomplete="new-password" aria-label="Repeat new password" required>
        <div class="err" id="pwerr"></div>
        <div class="grid2"><button class="btn" type="button" data-act="pwclose">Cancel</button><button class="btn primary" type="submit">Save</button></div>
      </form>`;
  const form = document.getElementById("pwform");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("pwerr"), next = document.getElementById("pwnew").value;
    if (next !== document.getElementById("pwrep").value) { err.textContent = "The two new passwords don't match."; return; }
    try {
      const r = await client.post("/api/me/password", { current_password: document.getElementById("pwcur").value, new_password: next });
      client.setToken(r.token);
      if (socket) socket.auth.token = r.token;
      renderAccount(false);
      toast("Password changed. Other devices have been signed out.");
    } catch (ex) { err.textContent = ex.message; }
  });
  document.getElementById("pwcur").focus();
}

/* ---------- mini map ---------- */
let mini, meMarker, routeLayer, lastFitKey = "";
function drawMini() {
  if (!window.L) return;
  if (!mini) {
    mini = L.map("minimap", { zoomControl: false, attributionControl: true });
    new ResizeObserver(() => mini.invalidateSize()).observe(document.getElementById("minimap"));
    fetch("/api/config").then((r) => r.json()).then((c) => tileLayer(c.tileUrl, { attribution: c.tileAttribution, maxZoom: 19 }).addTo(mini));
    routeLayer = L.layerGroup().addTo(mini);
    mini.setView([G.last?.lat ?? 0, G.last?.lng ?? 0], G.last ? 15 : 2);
  }
  setTimeout(() => mini.invalidateSize(), 0);
  routeLayer.clearLayers();
  const r = S.state.route;
  if (r) {
    if (r.geometry?.coords) L.polyline(r.geometry.coords, { color: "#e0601a", weight: 5, opacity: 0.8 }).addTo(routeLayer);
    r.stops.forEach((s) => L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<div class="sb" style="--c:${STOP[s.status][0]}">${s.seq}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(routeLayer));
  }
  const key = r ? `${r.id}:${r.status}` : "none";
  if (key !== lastFitKey) {
    lastFitKey = key;
    const pts = r ? r.stops.filter((s) => ["pending", "arrived"].includes(s.status)).map((s) => [s.lat, s.lng]) : [];
    if (G.last) pts.push([G.last.lat, G.last.lng]);
    if (pts.length > 1) mini.fitBounds(pts, { padding: [24, 24], maxZoom: 16 }); else if (pts.length) mini.setView(pts[0], 15);
  }
  updateMe();
}
function updateMe() {
  if (!mini || !G.last) return;
  const ll = [G.last.lat, G.last.lng];
  if (!meMarker) { meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: `<div class="me"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000 }).addTo(mini); if (lastFitKey === "none") mini.setView(ll, 15); }
  else meMarker.setLatLng(ll);
}

/* ---------- actions ---------- */
async function onClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act, id = Number(b.dataset.id);
  if (act === "pick") { S.picked = id; return render(); }
  if (act === "view") {
    S.view = b.dataset.v; render();
    if (S.view === "stats") { document.getElementById("stats").innerHTML = statsHtml(S.profile); loadProfile(); }
    window.scrollTo(0, 0);
    return;
  }
  if (act === "chk") { S.check.items[b.dataset.k] = b.dataset.v; document.getElementById("check").innerHTML = ""; return renderCheck(); }
  if (act === "chklater") { S.check.later = true; return renderCheck(); }
  if (act === "mydata") {
    try { await client.download("/api/driver/my-data", "fleetline-my-data.json"); toast("Your data was downloaded."); } catch (err) { toast(err.message, true); }
    return;
  }
  if (act === "armskip") { S.armed = "skip" + id; S.skipReason = ""; return render(); }
  if (act === "unarm") { S.armed = null; return render(); }
  if (act === "dismissgap") { G.gapWarn = false; return updateGps(); }
  if (act === "logout") return client.logout();
  if (act === "pwopen") return renderAccount(true);
  if (act === "pwclose") return renderAccount(false);
  if (act === "endshift" && S.armed !== "end") { S.armed = "end"; render(); setTimeout(() => { if (S.armed === "end") { S.armed = null; render(); } }, 4000); return; }
  if (S.loading) return;
  S.loading = true; b.disabled = true;
  try {
    if (act === "startshift") {
      await askLocation();
      S.state = await client.post("/api/driver/shift/start", { vehicle_id: S.picked });
      startGps(); toast(`Shift started in ${S.state.vehicle.code}. Keep this app open while driving.`);
    } else if (act === "privacyack") {
      S.state = await client.post("/api/driver/privacy-ack", { version: b.dataset.v });
    } else if (act === "chksubmit") {
      S.state = await client.post("/api/driver/inspection", { items: S.check.items, notes: S.check.notes });
      const problems = Object.values(S.check.items).filter((x) => x === "issue").length;
      S.check = { items: {}, notes: "", later: false };
      toast(problems ? "Check saved. Dispatch has been told about the problem." : "Check saved. All OK.");
    } else if (act === "startroute") { S.state = await client.post(`/api/driver/route/${id}/start`); toast("Route started. Drive safe."); }
    else if (act === "arrive") { S.state = await client.post(`/api/driver/stops/${id}/arrive`); }
    else if (act === "complete") { S.state = await client.post(`/api/driver/stops/${id}/complete`, { note: S.note }); S.note = ""; toast("Delivery saved"); }
    else if (act === "skip") {
      if (!S.skipReason) { toast("Choose a reason first.", true); return; }
      S.state = await client.post(`/api/driver/stops/${id}/skip`, { reason: S.skipReason }); S.armed = null; toast("Stop skipped. Dispatch has been told.");
    } else if (act === "endshift") {
      await flush();
      S.state = await client.post("/api/driver/shift/end"); stopGps(); S.armed = null; toast("Shift ended. Location sharing is off.");
    }
  } catch (err) { toast(err.message, true); }
  finally { S.loading = false; if (document.activeElement) document.activeElement.blur(); render(); }
}
function askLocation() {
  // Trigger the permission prompt before the shift starts, so the driver sees why it's needed.
  return new Promise((resolve) => {
    if (!("geolocation" in navigator) || !isSecureContext) return resolve();
    navigator.geolocation.getCurrentPosition(() => resolve(), (e) => { if (e.code === 1) toast("Allow location so dispatch can see your vehicle.", true); resolve(); }, { enableHighAccuracy: true, timeout: 15000 });
  });
}
let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.toggle("err", isErr); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 3500);
}
