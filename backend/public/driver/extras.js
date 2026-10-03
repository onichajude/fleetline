// Driver app screens: sign-up, "My stats" and the pre-trip vehicle check.
import { esc, hm } from "/shared/client.js";

const fmt = (n, d = 0) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const dayName = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const dateOf = (t) => (t ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }) : "—");
const CONDITION = {
  good: ["Good", "var(--ok)"], service_soon: ["Service soon", "var(--warn)"],
  attention: ["Needs attention", "var(--crit)"], out_of_service: ["Out of service", "var(--idle)"],
};

export function signupHtml() {
  return `<form class="login" id="sf" style="margin-top:4vh">
    <h1>Request an account</h1>
    <p class="muted" style="margin:0">Your dispatcher reviews new drivers and assigns your vehicle. You can sign in once you're approved.</p>
    <label>Full name<input id="su-name" autocomplete="name" required></label>
    <label>Phone<input id="su-phone" type="tel" autocomplete="tel" required></label>
    <label>Driver's licence number (optional)<input id="su-lic" autocapitalize="characters"></label>
    <label>I'll mainly drive<select class="field" id="su-type"><option value="either">A truck or a van</option><option value="truck">A truck</option><option value="van">A van</option></select></label>
    <label>Choose a username<input id="su-user" autocomplete="username" autocapitalize="none" required minlength="3"></label>
    <label>Choose a password (8+ characters)<input id="su-pass" type="password" autocomplete="new-password" required minlength="8"></label>
    <div class="err" id="su-err"></div>
    <button class="btn primary block" type="submit">Send request</button>
    <button class="btn block" type="button" id="su-back">Back to sign in</button>
  </form>`;
}

export function checkHtml(st, check) {
  const items = st.inspection_items;
  const allSet = items.every(([k]) => check.items[k]);
  const anyIssue = items.some(([k]) => check.items[k] === "issue");
  return `<div class="card check" style="display:flex;flex-direction:column;gap:10px">
    <h2 style="margin:0">Pre-trip check · ${esc(st.vehicle.code)}</h2>
    <p class="muted" style="margin:0;font-size:14px">Walk around the vehicle before you drive. Problems go straight to dispatch.</p>
    <div class="chk">${items.map(([k, label]) => `<div class="chk-row"><span>${esc(label)}</span>
      <span class="seg2"><button type="button" data-act="chk" data-k="${k}" data-v="ok" aria-pressed="${check.items[k] === "ok"}">OK</button>
      <button type="button" class="bad" data-act="chk" data-k="${k}" data-v="issue" aria-pressed="${check.items[k] === "issue"}">Problem</button></span></div>`).join("")}</div>
    ${anyIssue ? `<textarea class="field" id="chknotes" placeholder="What's wrong? e.g. front left tyre low">${esc(check.notes)}</textarea>` : ""}
    <div class="grid2"><button class="btn" data-act="chklater">Later</button><button class="btn primary" data-act="chksubmit" ${allSet ? "" : "disabled"}>Submit check</button></div>
  </div>`;
}

function tile(label, value, avg, unit = "", digits = 0) {
  let sub = `<span class="muted">first week</span>`;
  if (avg != null && value != null) {
    const diff = value - avg;
    sub = Math.abs(diff) < 0.05 ? `<span class="muted">same as your average</span>`
      : `<span style="color:${diff >= 0 ? "var(--ok)" : "var(--warn)"}">${diff > 0 ? "▲" : "▼"} ${fmt(Math.abs(diff), digits)}${unit}</span> <span class="muted">vs avg ${fmt(avg, digits)}</span>`;
  }
  return `<div class="tile"><span class="lbl">${label}</span><b>${fmt(value, digits)}<small>${unit}</small></b><span class="sub">${sub}</span></div>`;
}

function bars(daily) {
  const W = 340, H = 110, pl = 22, pt = 6, pb = 18;
  const top = Math.max(4, Math.ceil(Math.max(...daily.map((d) => d.delivered)) / 4) * 4);
  const y = (v) => pt + (H - pt - pb) * (1 - v / top), bw = (W - pl) / daily.length;
  let s = `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Deliveries per day, last 14 days">`;
  for (const g of [0, top]) s += `<line x1="${pl}" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="var(--line)"/><text x="${pl - 4}" y="${y(g) + 3}" text-anchor="end">${g}</text>`;
  daily.forEach((d, i) => {
    const x = pl + i * bw + bw * 0.18, w = bw * 0.64, late = Math.min(d.late, d.delivered);
    if (d.delivered - late > 0) s += `<rect x="${x}" y="${y(d.delivered - late)}" width="${w}" height="${y(0) - y(d.delivered - late)}" fill="var(--info)" rx="1.5"/>`;
    if (late > 0) s += `<rect x="${x}" y="${y(d.delivered)}" width="${w}" height="${y(d.delivered - late) - y(d.delivered)}" fill="var(--warn)" rx="1.5"/>`;
    if (i % 2 === 1) s += `<text x="${x + w / 2}" y="${H - 5}" text-anchor="middle">${new Date(`${d.date}T12:00:00`).getDate()}</text>`;
  });
  return s + `</svg>`;
}

export function statsHtml(p) {
  if (!p) return `<div class="card"><p class="muted">Loading your stats…</p></div>`;
  const w = p.week, a = p.average, c = p.vehicle;
  let h = `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
    <div><h2 style="margin:0">Week of ${dayName(p.weekStart)}</h2><p class="muted" style="margin:4px 0 0;font-size:14px">${
      p.rank ? (p.rank.position === 1 ? "You're the top driver this week. Keep it up!" : `${p.rank.behindBy} deliver${p.rank.behindBy === 1 ? "y" : "ies"} behind #${p.rank.position - 1}.`) : "Start a shift to get ranked this week."}</p></div>
    ${p.rank ? `<div class="rankbig"><b>#${p.rank.position}</b><span>of ${p.rank.of} drivers</span></div>` : ""}</div>`;
  h += `<div class="tiles">${tile("Trips", w.trips, a?.trips, "", 0)}${tile("Deliveries", w.delivered, a?.delivered, "", 0)}${tile("On time", w.onTimePct, a?.onTimePct, "%", 0)}
    ${tile("Distance", w.km, a?.km, " km", 0)}${tile("Hours on shift", w.shiftHours, a?.shiftHours, " h", 1)}${tile("Driving", w.drivingHours, a?.drivingHours, " h", 1)}</div>`;
  if (a) h += `<p class="muted" style="margin:-4px 2px 0;font-size:13px">Averages are from your previous ${a.weeks} week${a.weeks > 1 ? "s" : ""}.</p>`;
  h += `<h2>Deliveries, last 14 days</h2><div class="card">${bars(p.daily)}<div class="legend2"><span><i style="--c:var(--info)"></i>On time</span><span><i style="--c:var(--warn)"></i>Late</span></div></div>`;
  h += `<h2>Your route</h2>`;
  if (p.current) {
    const r = p.current;
    h += `<div class="card"><b>${esc(r.code)} · ${esc(r.name)}</b><p class="muted" style="margin:4px 0 8px">${r.delivered}/${r.total} delivered</p>
      <ol class="stops">${r.stops.map((s) => `<li style="--c:${s.status === "completed" ? "var(--ok)" : s.status === "skipped" ? "var(--idle)" : s.status === "arrived" ? "var(--accent)" : "var(--info)"}"><span class="n">${s.seq}</span><span class="nm">${esc(s.name)}</span><span class="st">${s.status === "pending" ? "" : esc(s.status)}</span><span class="tm">Due ${hm(s.planned_at)}</span></li>`).join("")}</ol></div>`;
  } else h += `<div class="card"><p class="muted" style="margin:0">No route assigned right now.</p></div>`;
  h += `<h2>Your vehicle</h2>`;
  if (c) {
    const [label, color] = CONDITION[c.status];
    h += `<div class="card" style="border-left:5px solid ${color}"><div style="display:flex;justify-content:space-between;align-items:center"><b class="mono" style="font-size:18px">${esc(c.code)}</b><span style="color:${color};font-weight:600">${label}</span></div>
      <div class="kv"><span>Odometer</span><b>${fmt(c.odometer_km)} km</b><span>Next service</span><b>${c.next_service_km <= 0 ? `overdue by ${fmt(-c.next_service_km)} km` : `in ${fmt(c.next_service_km)} km`}</b>
      <span>Last check</span><b>${c.last_inspection ? `${dateOf(c.last_inspection.created_at)}${c.last_inspection.issues.length ? (c.last_inspection.issues_open ? " · problems reported" : " · problem since fixed") : " · all OK"}` : "none yet"}</b></div>
      ${c.reasons.length ? `<ul class="reasons">${c.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`;
  } else h += `<div class="card"><p class="muted" style="margin:0">No vehicle assigned yet.</p></div>`;
  h += `<h2>Recent trips · ${fmt(p.totals.trips)} total</h2><div class="card" style="padding:4px 16px">${p.recentTrips.length ? `<ol class="stops">${p.recentTrips.map((t) => `<li style="--c:${t.status === "cancelled" ? "var(--idle)" : "var(--ok)"}"><span class="n">✓</span><span class="nm">${esc(t.code)} · ${dateOf(t.completed_at)}</span><span class="st">${t.onTimePct == null ? "" : t.onTimePct + "% on time"}</span><span class="tm">${t.delivered}/${t.total} delivered${t.vehicle_code ? " · " + esc(t.vehicle_code) : ""}</span></li>`).join("")}</ol>` : `<p class="muted">Your finished trips appear here.</p>`}</div>`;
  return h;
}
