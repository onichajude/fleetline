// Driver and vehicle performance: weekly figures, multi-week averages, rankings and vehicle condition.
import { one, all, localDate } from "./db.js";
import { haversine } from "./geo.js";
import { CFG } from "./fleet.js";

const DAY = 864e5;
export const INSPECTION_ITEMS = [
  ["tires", "Tyres"], ["brakes", "Brakes"], ["lights", "Lights & signals"],
  ["fluids", "Fluids & leaks"], ["body", "Body & mirrors"], ["cargo", "Cargo area & doors"],
];
const AVG_WEEKS = 4;

/** Monday 00:00 to next Monday 00:00 (server local time) for the week containing `date`. */
export function weekBounds(date = localDate()) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return [new Date(y, m - 1, d - dow).getTime(), new Date(y, m - 1, d - dow + 7).getTime()];
}

/** Distance and moving time from ordered GPS rows, ignoring inaccurate fixes and jumps. */
function track(rows) {
  let meters = 0, movingMs = 0, prev = null;
  for (const p of rows) {
    if (p.accuracy_m != null && p.accuracy_m > CFG.maxAccuracyM) continue;
    if (prev) {
      const d = haversine(prev, p), dt = p.t - prev.t;
      if (dt > 0 && d / (dt / 1000) < 70) {
        meters += d;
        if (dt < 180e3 && d / (dt / 1000) > 1.5) movingMs += dt;
      }
    }
    prev = p;
  }
  return { km: meters / 1000, drivingMin: movingMs / 60e3 };
}

/** Figures for one driver or one vehicle between two timestamps. `who` is "driver" or "vehicle". */
function period(who, id, from, to) {
  const col = who === "driver" ? "driver_id" : "vehicle_id";
  const grace = CFG.lateGraceMin * 60e3;
  const trips = one(`SELECT COUNT(*) n FROM routes WHERE ${col} = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?`, id, from, to).n;
  const s = one(`SELECT SUM(s.status = 'completed') delivered, SUM(s.status = 'skipped') skipped,
      SUM(s.arrived_at IS NOT NULL) arrived, SUM(s.arrived_at IS NOT NULL AND s.arrived_at <= s.planned_at + ?) ontime
    FROM route_stops s JOIN routes r ON r.id = s.route_id
    WHERE r.${col} = ? AND COALESCE(s.completed_at, s.arrived_at) >= ? AND COALESCE(s.completed_at, s.arrived_at) < ?`, grace, id, from, to);
  const t = track(all(`SELECT lat, lng, accuracy_m, recorded_at t FROM positions WHERE ${col} = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at`, id, from, to));
  let shiftMin = 0;
  for (const sh of all(`SELECT started_at, ended_at FROM shifts WHERE ${col} = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`, id, to, from)) {
    shiftMin += Math.max(0, Math.min(sh.ended_at ?? Date.now(), to) - Math.max(sh.started_at, from)) / 60e3;
  }
  const arrived = s.arrived || 0;
  return {
    trips, delivered: s.delivered || 0, skipped: s.skipped || 0, arrived, ontime: s.ontime || 0,
    onTimePct: arrived ? Math.round(((s.ontime || 0) / arrived) * 1000) / 10 : null,
    km: Math.round(t.km * 10) / 10, drivingHours: Math.round((t.drivingMin / 60) * 10) / 10, shiftHours: Math.round((shiftMin / 60) * 10) / 10,
  };
}

/** Average of the previous `AVG_WEEKS` weeks, counting only weeks with any shift time. */
function weeklyAverage(who, id, weekStart) {
  const weeks = [];
  for (let k = 1; k <= AVG_WEEKS; k++) {
    const p = period(who, id, weekStart - k * 7 * DAY, weekStart - (k - 1) * 7 * DAY);
    if (p.shiftHours > 0 || p.trips > 0) weeks.push(p);
  }
  if (!weeks.length) return null;
  const avg = (k) => Math.round((weeks.reduce((s, w) => s + w[k], 0) / weeks.length) * 10) / 10;
  const arrived = weeks.reduce((s, w) => s + w.arrived, 0), ontime = weeks.reduce((s, w) => s + w.ontime, 0);
  return { weeks: weeks.length, trips: avg("trips"), delivered: avg("delivered"), km: avg("km"), shiftHours: avg("shiftHours"), drivingHours: avg("drivingHours"),
    onTimePct: arrived ? Math.round((ontime / arrived) * 1000) / 10 : null };
}

/** Daily deliveries and km for the last `days` days ending on `date`. */
function daily(who, id, date, days = 14) {
  const [y, m, d] = date.split("-").map(Number);
  const out = [];
  for (let k = days - 1; k >= 0; k--) {
    const from = new Date(y, m - 1, d - k).getTime(), to = new Date(y, m - 1, d - k + 1).getTime();
    const p = period(who, id, from, to);
    out.push({ date: localDate(from), delivered: p.delivered, late: p.arrived - p.ontime, km: p.km });
  }
  return out;
}

/** Weekly leaderboard of drivers who worked that week, ranked by deliveries, then on-time rate, then km. */
export function leaderboard(date = localDate()) {
  const [from, to] = weekBounds(date);
  const rows = all(`SELECT DISTINCT u.id, u.name, u.username FROM users u JOIN shifts s ON s.driver_id = u.id
                    WHERE u.role = 'driver' AND s.started_at < ? AND (s.ended_at IS NULL OR s.ended_at > ?)`, to, from)
    .map((u) => {
      const v = one(`SELECT v.id, v.code, v.type FROM shifts s JOIN vehicles v ON v.id = s.vehicle_id
                     WHERE s.driver_id = ? AND s.started_at < ? ORDER BY s.started_at DESC LIMIT 1`, u.id, to);
      return { ...u, vehicle: v || null, ...period("driver", u.id, from, to) };
    })
    .sort((a, b) => b.delivered - a.delivered || (b.onTimePct ?? -1) - (a.onTimePct ?? -1) || b.km - a.km);
  rows.forEach((r, i) => (r.rank = i + 1));
  return { weekStart: localDate(from), weekEnd: localDate(to - DAY), drivers: rows };
}

/** Condition summary for a vehicle: odometer, service due and the latest pre-trip check. */
export function vehicleCondition(vehicleId) {
  const v = one("SELECT * FROM vehicles WHERE id = ?", vehicleId);
  if (!v) return null;
  const insp = one(`SELECT i.*, u.name AS driver_name FROM inspections i LEFT JOIN users u ON u.id = i.driver_id
                    WHERE i.vehicle_id = ? ORDER BY i.created_at DESC LIMIT 1`, vehicleId);
  const items = insp ? JSON.parse(insp.items) : null;
  const issues = items ? INSPECTION_ITEMS.filter(([k]) => items[k] === "issue").map(([, label]) => label) : [];
  const issuesOpen = issues.length > 0 && (!v.last_service_at || insp.created_at > v.last_service_at);
  const nextServiceKm = Math.round(v.last_service_km + v.service_interval_km - v.odometer_km);
  const reasons = [];
  let status = "good";
  if (v.maintenance) { status = "out_of_service"; reasons.push("Marked in maintenance"); }
  if (issuesOpen) { if (status === "good") status = "attention"; reasons.push(`Pre-trip check found: ${issues.join(", ")}`); }
  if (nextServiceKm <= 0) { if (status === "good") status = "attention"; reasons.push(`Service overdue by ${Math.abs(nextServiceKm).toLocaleString("en-US")} km`); }
  else if (nextServiceKm < 1000) { if (status === "good") status = "service_soon"; reasons.push(`Service due in ${nextServiceKm.toLocaleString("en-US")} km`); }
  if (!insp || Date.now() - insp.created_at > 7 * DAY) reasons.push("No pre-trip check in the last 7 days");
  return {
    id: v.id, code: v.code, type: v.type, plate: v.plate, status, reasons,
    odometer_km: Math.round(v.odometer_km), service_interval_km: v.service_interval_km, last_service_at: v.last_service_at,
    last_service_km: Math.round(v.last_service_km), next_service_km: nextServiceKm,
    last_inspection: insp ? { id: insp.id, created_at: insp.created_at, driver_name: insp.driver_name, items, issues, issues_open: issuesOpen, notes: insp.notes } : null,
  };
}

function routeSummary(r) {
  const s = one(`SELECT COUNT(*) total, SUM(status = 'completed') delivered, SUM(status = 'skipped') skipped,
                 SUM(arrived_at IS NOT NULL AND arrived_at <= planned_at + ?) ontime, SUM(arrived_at IS NOT NULL) arrived
                 FROM route_stops WHERE route_id = ?`, CFG.lateGraceMin * 60e3, r.id);
  return { id: r.id, code: r.code, name: r.name, status: r.status, service_date: r.service_date, started_at: r.started_at, completed_at: r.completed_at,
    vehicle_code: r.vehicle_code, driver_name: r.driver_name, total: s.total, delivered: s.delivered || 0, skipped: s.skipped || 0,
    onTimePct: s.arrived ? Math.round(((s.ontime || 0) / s.arrived) * 100) : null };
}

/** Everything a driver (or an admin looking at them) sees on the driver's performance page. */
export function driverProfile(driverId, date = localDate()) {
  const d = one(`SELECT id, name, username, phone, license_no, created_at, approval FROM users WHERE id = ? AND role = 'driver'`, driverId);
  if (!d) return null;
  const [from, to] = weekBounds(date);
  const week = period("driver", driverId, from, to);
  const board = leaderboard(date);
  const me = board.drivers.find((r) => r.id === driverId);
  const ahead = me && me.rank > 1 ? board.drivers[me.rank - 2] : null;
  const shift = one("SELECT * FROM shifts WHERE driver_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", driverId);
  const usual = one("SELECT id, code, type FROM vehicles WHERE default_driver_id = ? ORDER BY id LIMIT 1", driverId);
  const vehicleId = shift?.vehicle_id ?? usual?.id ?? null;
  const cur = vehicleId ? one(`SELECT id FROM routes WHERE vehicle_id = ? AND status IN ('active','dispatched')
                               ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1`, vehicleId) : null;
  const current = cur ? one(`SELECT r.*, v.code AS vehicle_code FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = ?`, cur.id) : null;
  const currentStops = current ? all(`SELECT s.seq, s.status, s.planned_at, s.arrived_at, p.name FROM route_stops s JOIN places p ON p.id = s.place_id
                                      WHERE s.route_id = ? ORDER BY s.seq`, current.id) : [];
  const recent = all(`SELECT r.*, v.code AS vehicle_code FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id
                      WHERE r.driver_id = ? AND r.status IN ('completed','cancelled') ORDER BY r.completed_at DESC LIMIT 10`, driverId).map(routeSummary);
  const totals = one(`SELECT COUNT(*) trips FROM routes WHERE driver_id = ? AND status = 'completed'`, driverId);
  const delivered = one(`SELECT COUNT(*) n FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE r.driver_id = ? AND s.status = 'completed'`, driverId).n;
  return {
    driver: { ...d, usual_vehicle: usual || null, on_shift: !!shift },
    weekStart: localDate(from), weekEnd: localDate(to - DAY),
    week, average: weeklyAverage("driver", driverId, from),
    rank: me ? { position: me.rank, of: board.drivers.length, behindBy: ahead ? ahead.delivered - me.delivered : 0 } : null,
    daily: daily("driver", driverId, date),
    current: current ? { ...routeSummary(current), stops: currentStops } : null,
    recentTrips: recent,
    totals: { trips: totals.trips, delivered },
    vehicle: vehicleId ? vehicleCondition(vehicleId) : null,
  };
}

/** Vehicle performance page: condition, this week vs average, drivers, checks and services. */
export function vehicleProfile(vehicleId, date = localDate()) {
  const condition = vehicleCondition(vehicleId);
  if (!condition) return null;
  const [from, to] = weekBounds(date);
  const drivers = all(`SELECT u.id, u.name, COUNT(*) shifts FROM shifts s JOIN users u ON u.id = s.driver_id
                       WHERE s.vehicle_id = ? AND s.started_at < ? AND (s.ended_at IS NULL OR s.ended_at > ?) GROUP BY u.id ORDER BY shifts DESC`, vehicleId, to, from);
  const inspections = all(`SELECT i.id, i.created_at, i.items, i.issues, i.notes, u.name AS driver_name FROM inspections i LEFT JOIN users u ON u.id = i.driver_id
                           WHERE i.vehicle_id = ? ORDER BY i.created_at DESC LIMIT 10`, vehicleId)
    .map((i) => { const items = JSON.parse(i.items); return { ...i, items, issueLabels: INSPECTION_ITEMS.filter(([k]) => items[k] === "issue").map(([, l]) => l) }; });
  const services = all(`SELECT s.*, u.name AS by_name FROM services s LEFT JOIN users u ON u.id = s.user_id WHERE s.vehicle_id = ? ORDER BY s.created_at DESC LIMIT 10`, vehicleId);
  const recent = all(`SELECT r.*, v.code AS vehicle_code, u.name AS driver_name FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN users u ON u.id = r.driver_id
                      WHERE r.vehicle_id = ? AND r.status IN ('completed','cancelled') ORDER BY r.completed_at DESC LIMIT 10`, vehicleId).map(routeSummary);
  return {
    vehicle: condition, weekStart: localDate(from), weekEnd: localDate(to - DAY),
    week: period("vehicle", vehicleId, from, to), average: weeklyAverage("vehicle", vehicleId, from),
    daily: daily("vehicle", vehicleId, date), drivers, inspections, services, recentTrips: recent,
  };
}

export const allVehicleConditions = () => all("SELECT id FROM vehicles ORDER BY code").map((v) => vehicleCondition(v.id));
