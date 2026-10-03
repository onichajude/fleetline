// Team tab: weekly leaderboard, pending sign-ups, vehicle condition, and driver / vehicle performance pages.
import { esc, hm } from "/shared/client.js";

export const CONDITION = {
  good: ["Good", "var(--ok)"], service_soon: ["Service soon", "var(--warn)"],
  attention: ["Needs attention", "var(--crit)"], out_of_service: ["Out of service", "var(--maint)"],
};
const fmt = (n, d = 0) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const dateOf = (t) => (t ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }) : "—");
const pill = ([label, color]) => `<span class="pill" style="--c:${color}">${label}</span>`;

/** "This week vs N-week average" tile. `better` says which direction is good. */
function tile(label, value, avg, unit = "", digits = 0, avgDigits = digits, better = "up") {
  let delta = "";
  if (avg != null && value != null) {
    const diff = value - avg;
    const good = better === "up" ? diff >= 0 : diff <= 0;
    delta = Math.abs(diff) < 10 ** -digits / 2 ? `<span class="muted">same as avg</span>`
      : `<span style="color:${good ? "var(--ok)" : "var(--warn)"}">${diff > 0 ? "▲" : "▼"} ${fmt(Math.abs(diff), avgDigits)}${unit}</span> <span class="muted">vs avg ${fmt(avg, avgDigits)}${unit}</span>`;
  } else delta = `<span class="muted">no earlier weeks yet</span>`;
  return `<div><dt>${label}</dt><dd>${fmt(value, digits)}<small>${unit}</small></dd><div class="delta">${delta}</div></div>`;
}

function bars(daily, key, lateKey, label) {
  const W = 340, H = 120, pl = 26, pr = 4, pt = 6, pb = 18;
  const max = Math.max(4, ...daily.map((d) => d[key]));
  const top = Math.ceil(max / 4) * 4;
  const y = (v) => pt + (H - pt - pb) * (1 - v / top), bw = (W - pl - pr) / daily.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">`;
  for (const g of [0, top / 2, top]) s += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(g)}" y2="${y(g)}"/><text x="${pl - 4}" y="${y(g) + 3}" text-anchor="end">${fmt(g)}</text>`;
  daily.forEach((d, i) => {
    const x = pl + i * bw + bw * 0.18, w = bw * 0.64, v = d[key], late = lateKey ? Math.min(d[lateKey], v) : 0;
    if (v - late > 0) s += `<rect x="${x}" y="${y(v - late)}" width="${w}" height="${y(0) - y(v - late)}" fill="var(--info)" rx="1.5"><title>${day(d.date)}: ${fmt(v, key === "km" ? 1 : 0)}</title></rect>`;
    if (late > 0) s += `<rect x="${x}" y="${y(v)}" width="${w}" height="${y(v - late) - y(v)}" fill="var(--warn)" rx="1.5"/>`;
    if (i % 2 === 1 || daily.length <= 7) s += `<text x="${x + w / 2}" y="${H - 5}" text-anchor="middle">${new Date(`${d.date}T12:00:00`).getDate()}</text>`;
  });
  return s + `</svg>`;
}

function tripsTable(trips, showDriver) {
  if (!trips.length) return `<p class="muted">No finished trips yet.</p>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Route</th>${showDriver ? "<th>Driver</th>" : "<th>Veh.</th>"}<th>Delivered</th><th>On time</th></tr></thead><tbody>${
    trips.map((t) => `<tr><td>${dateOf(t.completed_at)}</td><td>${esc(t.code)}</td><td>${esc(showDriver ? t.driver_name || "—" : t.vehicle_code || "—")}</td>
      <td>${t.delivered}/${t.total}${t.status === "cancelled" ? " ✕" : ""}</td><td>${t.onTimePct == null ? "—" : t.onTimePct + "%"}</td></tr>`).join("")}</tbody></table></div>`;
}

export function conditionCard(c, { link = false } = {}) {
  if (!c) return `<p class="muted">No vehicle assigned.</p>`;
  const insp = c.last_inspection;
  return `<div class="cond" style="--c:${CONDITION[c.status][1]}">
    <div class="row" style="justify-content:space-between"><b class="mono">${esc(c.code)}</b>${pill(CONDITION[c.status])}</div>
    <div class="muted" style="font-size:12px">${esc(c.type)}${c.plate ? " · " + esc(c.plate) : ""}</div>
    <dl class="stats" style="margin-top:8px">
      <div><dt>Odometer</dt><dd>${fmt(c.odometer_km)} km</dd></div>
      <div><dt>Next service</dt><dd>${c.next_service_km <= 0 ? `<span style="color:var(--crit)">overdue ${fmt(-c.next_service_km)} km</span>` : `in ${fmt(c.next_service_km)} km`}</dd></div>
      <div><dt>Last service</dt><dd>${c.last_service_at ? dateOf(c.last_service_at) : "—"}</dd></div>
      <div><dt>Last pre-trip check</dt><dd>${insp ? `${dateOf(insp.created_at)}${insp.issues.length ? (insp.issues_open ? ` <span style="color:var(--crit)">· ${insp.issues.length} problem${insp.issues.length > 1 ? "s" : ""}</span>` : " · problem fixed since") : " · all OK"}` : "never"}</dd></div>
    </dl>
    ${c.reasons.length ? `<ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    ${insp?.notes && insp.issues_open ? `<p class="muted" style="margin:6px 0 0;font-size:12px">Driver's note: “${esc(insp.notes)}”</p>` : ""}
    ${link ? `<button class="btn sm" data-act="teamveh" data-id="${c.id}" style="margin-top:8px">Vehicle details</button>` : ""}
  </div>`;
}

export function driverProfileHtml(p, { admin = true } = {}) {
  const w = p.week, a = p.average, d = p.driver;
  let h = admin ? `<button class="btn link" data-act="teamback">← Team</button>` : "";
  h += `<div class="vh-top" style="margin-top:8px"><div><div class="eyebrow">Driver · week of ${day(p.weekStart)}</div><h2 style="font-family:var(--f-body)">${esc(d.name)}</h2>
    <div class="muted mono" style="font-size:12px">@${esc(d.username)}${d.phone ? " · " + esc(d.phone) : ""}${d.license_no ? " · licence " + esc(d.license_no) : ""}</div></div>
    ${p.rank ? `<span class="rank" title="Ranked by deliveries, then on-time rate">#${p.rank.position}<small> of ${p.rank.of}</small></span>` : ""}</div>`;
  if (p.rank) h += `<p class="muted" style="margin:6px 0 0">${p.rank.position === 1 ? "Top driver this week by deliveries." : `${p.rank.behindBy} deliver${p.rank.behindBy === 1 ? "y" : "ies"} behind #${p.rank.position - 1} this week.`} ${p.rank.of} drivers worked this week.</p>`;
  else h += `<p class="muted" style="margin:6px 0 0">No shifts this week yet, so no ranking.</p>`;
  h += `<h3>This week${a ? ` vs ${a.weeks}-week average` : ""}</h3><dl class="mini kgrid">
    ${tile("Trips", w.trips, a?.trips, "", 0, 1)}${tile("Deliveries", w.delivered, a?.delivered, "", 0, 1)}
    ${tile("On time", w.onTimePct, a?.onTimePct, "%", 1)}${tile("Distance", w.km, a?.km, " km", 1)}
    ${tile("Shift hours", w.shiftHours, a?.shiftHours, " h", 1)}${tile("Driving hours", w.drivingHours, a?.drivingHours, " h", 1)}</dl>`;
  h += `<h3>Deliveries, last 14 days</h3>${bars(p.daily, "delivered", "late", "Deliveries per day")}
    <div class="lg"><span><i style="--c:var(--info)"></i>On time</span><span><i style="--c:var(--warn)"></i>Late</span></div>`;
  h += `<h3>Expected route</h3>`;
  if (p.current) {
    const c = p.current;
    h += `<div class="rcard" style="cursor:default"><div class="r1"><span><span class="rid">${esc(c.code)}</span> ${esc(c.name)}</span>${pill(c.status === "active" ? ["On the road", "var(--info)"] : ["Sent to driver", "var(--assigned)"])}</div>
      <div class="meta">${esc(c.vehicle_code || "")} · ${c.delivered}/${c.total} delivered</div>
      <ol class="tl" style="margin-top:4px">${c.stops.map((s) => `<li style="--c:${s.status === "completed" ? "var(--ok)" : s.status === "skipped" ? "var(--idle)" : s.status === "arrived" ? "var(--accent)" : "var(--info)"}"><span class="n">${s.seq}</span><span class="nm">${esc(s.name)}</span><span class="tag">${s.status === "pending" ? "" : esc(s.status)}</span><span class="tm">Plan ${hm(s.planned_at)}${s.arrived_at ? " · arrived " + hm(s.arrived_at) : ""}</span></li>`).join("")}</ol></div>`;
  } else h += `<p class="muted">No route assigned right now.</p>`;
  h += `<h3>Vehicle condition</h3>${conditionCard(p.vehicle, { link: admin })}`;
  h += `<h3>Recent trips <span class="muted" style="text-transform:none;letter-spacing:0">· ${fmt(p.totals.trips)} trips, ${fmt(p.totals.delivered)} deliveries all-time</span></h3>${tripsTable(p.recentTrips, false)}`;
  return h;
}

export function vehicleProfileHtml(p, S) {
  const c = p.vehicle, w = p.week, a = p.average;
  let h = `<button class="btn link" data-act="teamback">← Team</button>
    <div class="vh-top" style="margin-top:8px"><div><div class="eyebrow">${esc(c.type)}${c.plate ? " · " + esc(c.plate) : ""}</div><h2>${esc(c.code)}</h2></div>${pill(CONDITION[c.status])}</div>`;
  h += `<h3>Condition</h3>${conditionCard(c)}
    <div class="form" style="margin-top:10px"><input class="inp" data-f="svc.note" value="${esc(S.forms["svc.note"] ?? "")}" placeholder="Service note, e.g. brake pads replaced" aria-label="Service note">
    <div><button class="btn sm primary" data-act="service" data-id="${c.id}">Record service at ${fmt(c.odometer_km)} km</button></div>
    <span class="muted" style="font-size:12px">Recording a service resets the service countdown and clears pre-trip problems reported before it.</span></div>`;
  h += `<h3>This week${a ? ` vs ${a.weeks}-week average` : ""}</h3><dl class="mini kgrid">
    ${tile("Trips", w.trips, a?.trips, "", 0, 1)}${tile("Deliveries", w.delivered, a?.delivered, "", 0, 1)}
    ${tile("Distance", w.km, a?.km, " km", 1)}${tile("Hours in use", w.shiftHours, a?.shiftHours, " h", 1)}</dl>`;
  h += `<h3>Distance, last 14 days (km)</h3>${bars(p.daily, "km", null, "Kilometres per day")}`;
  h += `<h3>Drivers this week</h3>${p.drivers.length ? `<ul class="list">${p.drivers.map((d) => `<li><button class="btn link" data-act="teamdrv" data-id="${d.id}">${esc(d.name)}</button><span class="muted">${d.shifts} shift${d.shifts > 1 ? "s" : ""}</span></li>`).join("")}</ul>` : `<p class="muted">Not driven this week.</p>`}`;
  h += `<h3>Pre-trip checks</h3>${p.inspections.length ? `<ul class="list">${p.inspections.map((i) => `<li><span>${dateOf(i.created_at)} · ${esc(i.driver_name || "—")}${i.notes && i.issueLabels.length ? ` <span class="muted">“${esc(i.notes)}”</span>` : ""}</span>${i.issueLabels.length ? `<span style="color:var(--crit)">${esc(i.issueLabels.join(", "))}</span>` : `<span class="muted">All OK</span>`}</li>`).join("")}</ul>` : `<p class="muted">No checks recorded.</p>`}`;
  h += `<h3>Service history</h3>${p.services.length ? `<ul class="list">${p.services.map((s) => `<li><span>${dateOf(s.created_at)} · ${fmt(s.odometer_km)} km${s.note ? ` · ${esc(s.note)}` : ""}</span><span class="muted">${esc(s.by_name || "")}</span></li>`).join("")}</ul>` : `<p class="muted">No services recorded in Fleetline yet.</p>`}`;
  h += `<h3>Recent trips</h3>${tripsTable(p.recentTrips, true)}`;
  return h;
}

export function teamPanel(S) {
  if (S.profile?.data) return S.profile.type === "driver" ? driverProfileHtml(S.profile.data) : vehicleProfileHtml(S.profile.data, S);
  if (S.profile) return `<div class="empty">Loading…</div>`;
  const T = S.team;
  let h = `<div class="row" style="justify-content:space-between;margin-bottom:10px"><label class="muted" for="teamDate">Week of</label><input class="inp" type="date" id="teamDate" value="${S.teamDate}"></div>`;
  const pending = S.users.filter((u) => u.approval === "pending");
  if (S.me.role === "admin" && pending.length) {
    h += `<h3>Waiting for approval (${pending.length})</h3>`;
    for (const u of pending) {
      h += `<div class="rcard signup" style="cursor:default"><div class="r1"><b>${esc(u.name)}</b><span class="muted mono">@${esc(u.username)}</span></div>
        <div class="meta">${esc(u.phone || "no phone")}${u.license_no ? " · licence " + esc(u.license_no) : ""} · ${esc(u.signup_note || "")} · signed up ${dateOf(u.created_at)}</div>
        <div class="row"><select data-approve="${u.id}" aria-label="Vehicle for ${esc(u.name)}"><option value="">Assign vehicle (optional)…</option>${[...S.fleet.values()].map((v) => `<option value="${v.id}">${esc(v.code)} · ${esc(v.type)}${v.default_driver_id ? "" : " · unassigned"}</option>`).join("")}</select>
        <button class="btn sm primary" data-act="approve" data-id="${u.id}">Approve</button>
        <button class="btn sm danger ${S.armed === "decline" + u.id ? "armed" : ""}" data-act="decline" data-id="${u.id}">${S.armed === "decline" + u.id ? "Confirm decline" : "Decline"}</button></div></div>`;
    }
  }
  if (!T) return h + `<div class="empty">Loading team…</div>`;
  h += `<h3>Drivers ranked · ${day(T.weekStart)} – ${day(T.weekEnd)}</h3>`;
  if (!T.drivers.length) h += `<p class="muted">Nobody has worked a shift this week yet.</p>`;
  else h += `<ol class="board">${T.drivers.map((d) => `<li><button data-act="teamdrv" data-id="${d.id}">
      <span class="pos">${d.rank}</span><span class="who"><b>${esc(d.name)}</b><span class="muted">${esc(d.vehicle?.code || "")}</span></span>
      <span class="num"><b>${d.delivered}</b><small>deliveries</small></span><span class="num"><b>${d.onTimePct == null ? "—" : Math.round(d.onTimePct) + "%"}</b><small>on time</small></span><span class="num"><b>${fmt(d.km)}</b><small>km</small></span></button></li>`).join("")}</ol>
      <p class="muted" style="font-size:12px">Ranked by deliveries, then on-time rate, then distance. Click a driver for their full profile.</p>`;
  h += `<h3>Vehicles</h3><ul class="vcond">${T.vehicles.map((c) => `<li><button data-act="teamveh" data-id="${c.id}"><span class="mono"><b>${esc(c.code)}</b></span>${pill(CONDITION[c.status])}
      <span class="muted">${fmt(c.odometer_km)} km · ${c.next_service_km <= 0 ? "service overdue" : `service in ${fmt(c.next_service_km)} km`}</span></button></li>`).join("")}</ul>`;
  return h;
}
