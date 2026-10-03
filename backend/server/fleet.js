import { one, all, run, tx, localDate, dayBounds } from "./db.js";
import { haversine, bearing, estDriveMs, optimizeOrder, roadRoute } from "./geo.js";

export const CFG = {
  geofenceM: Number(process.env.GEOFENCE_M || 90),
  lateGraceMin: Number(process.env.LATE_GRACE_MIN || 10),
  offlineMin: Number(process.env.OFFLINE_MIN || 3),
  maxAccuracyM: Number(process.env.MAX_ACCURACY_M || 150),
};

/* ---------- event bus (wired to Socket.IO in index.js) ---------- */
let emit = () => {};
export const setEmitter = (fn) => { emit = fn; };

/* ---------- live state ---------- */
const live = new Map(); // vehicle_id -> { lat, lng, speed, heading, accuracy, t, overSpeed, offlineAlerted, lastSpeedAlert }
export function hydrateLive() {
  for (const p of all(`SELECT p.* FROM positions p JOIN (SELECT vehicle_id, MAX(recorded_at) t FROM positions GROUP BY vehicle_id) m
                       ON m.vehicle_id = p.vehicle_id AND m.t = p.recorded_at`)) {
    live.set(p.vehicle_id, { lat: p.lat, lng: p.lng, speed: p.speed_kmh ?? 0, heading: p.heading ?? 0, accuracy: p.accuracy_m, t: p.recorded_at, overSpeed: 0, offlineAlerted: false, lastSpeedAlert: 0 });
  }
}

export function addAlert({ vehicleId = null, routeId = null, kind, severity, message }) {
  const now = Date.now();
  const r = run("INSERT INTO alerts (vehicle_id, route_id, kind, severity, message, created_at) VALUES (?,?,?,?,?,?)", vehicleId, routeId, kind, severity, message, now);
  const a = one("SELECT a.*, v.code AS vehicle_code FROM alerts a LEFT JOIN vehicles v ON v.id = a.vehicle_id WHERE a.id = ?", r.lastInsertRowid);
  emit("dispatch", "alert", a);
  return a;
}

/* ---------- reads ---------- */
const openShift = (vehicleId) => one("SELECT * FROM shifts WHERE vehicle_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", vehicleId);
export const driverShift = (driverId) => one("SELECT * FROM shifts WHERE driver_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1", driverId);
const currentRoute = (vehicleId) =>
  one("SELECT * FROM routes WHERE vehicle_id = ? AND status IN ('active','dispatched') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, dispatched_at LIMIT 1", vehicleId);

export function routeWithStops(id) {
  const r = one(`SELECT r.*, v.code AS vehicle_code, d.name AS depot_name, d.lat AS depot_lat, d.lng AS depot_lng
                 FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN depots d ON d.id = r.depot_id WHERE r.id = ?`, id);
  if (!r) return null;
  r.geometry = r.geometry ? JSON.parse(r.geometry) : null;
  r.stops = all(`SELECT s.*, p.name, p.address, p.lat, p.lng, p.dwell_min FROM route_stops s JOIN places p ON p.id = s.place_id
                 WHERE s.route_id = ? ORDER BY s.seq`, id);
  return r;
}

function statusOf(v, shift, route, l, now) {
  if (v.maintenance) return "maint";
  if (!shift) return "off";
  if (!l || now - l.t > CFG.offlineMin * 60e3) return "offline";
  if (route?.status === "active") {
    const stops = all("SELECT status, planned_at FROM route_stops WHERE route_id = ? ORDER BY seq", route.id);
    if (stops.some((s) => s.status === "arrived")) return "at_stop";
    const next = stops.find((s) => s.status === "pending");
    if (next && next.planned_at && now > next.planned_at + CFG.lateGraceMin * 60e3) return "delayed";
    return next ? "enroute" : "returning";
  }
  if (route?.status === "dispatched") return "assigned";
  return "idle";
}

export function vehicleSummary(v, now = Date.now()) {
  const shift = openShift(v.id);
  const route = currentRoute(v.id);
  const l = live.get(v.id) || null;
  const driver = shift ? one("SELECT id, name, phone FROM users WHERE id = ?", shift.driver_id) : null;
  let routeInfo = null;
  if (route) {
    const c = one(`SELECT COUNT(*) total, SUM(status IN ('completed','skipped')) done FROM route_stops WHERE route_id = ?`, route.id);
    const next = one(`SELECT s.id, s.seq, s.planned_at, s.status, p.name, p.lat, p.lng FROM route_stops s JOIN places p ON p.id = s.place_id
                      WHERE s.route_id = ? AND s.status IN ('pending','arrived') ORDER BY s.seq LIMIT 1`, route.id);
    let eta = null;
    if (next && l) eta = next.status === "arrived" ? now : now + estDriveMs(l, next);
    routeInfo = { id: route.id, code: route.code, name: route.name, status: route.status, total: c.total, done: c.done || 0, next: next ? { ...next, eta } : null };
  }
  return {
    id: v.id, code: v.code, type: v.type, plate: v.plate, depot_id: v.depot_id, maintenance: !!v.maintenance, speed_limit_kmh: v.speed_limit_kmh,
    default_driver_id: v.default_driver_id,
    status: statusOf(v, shift, route, l, now),
    driver, shift_id: shift?.id ?? null, shift_started_at: shift?.started_at ?? null,
    position: l ? { lat: l.lat, lng: l.lng, speed: l.speed, heading: l.heading, accuracy: l.accuracy, t: l.t } : null,
    route: routeInfo,
  };
}
export const fleetSummary = () => all("SELECT * FROM vehicles ORDER BY code").map((v) => vehicleSummary(v));
const pushVehicle = (vehicleId) => {
  const v = one("SELECT * FROM vehicles WHERE id = ?", vehicleId);
  if (v) emit("dispatch", "vehicle", vehicleSummary(v));
};
export const notifyVehicle = pushVehicle;

function pushRoute(routeId) {
  const r = routeWithStops(routeId);
  if (!r) return;
  emit("dispatch", "route", r);
  const shift = r.vehicle_id ? openShift(r.vehicle_id) : null;
  if (shift) emit(`driver:${shift.driver_id}`, "route", r);
}
export const notifyRoute = pushRoute;

/* ---------- planning ---------- */
/** Recompute planned arrival times from a start time and start point (falls back to straight-line estimates). */
function planStops(route, startAt, from) {
  const stops = all("SELECT s.id, p.lat, p.lng, p.dwell_min FROM route_stops s JOIN places p ON p.id = s.place_id WHERE s.route_id = ? ORDER BY s.seq", route.id);
  const geo = route.geometry ? JSON.parse(route.geometry) : null;
  const useLegs = geo?.legs?.length === stops.length + 1 && !from.fromVehicle;
  let t = startAt, prev = from;
  stops.forEach((s, i) => {
    t += useLegs ? geo.legs[i] * 1000 * 1.15 : estDriveMs(prev, s);
    run("UPDATE route_stops SET planned_at = ? WHERE id = ?", Math.round(t), s.id);
    t += s.dwell_min * 60e3;
    prev = s;
  });
}

export async function attachGeometry(routeId) {
  const r = one("SELECT r.*, d.lat dlat, d.lng dlng FROM routes r LEFT JOIN depots d ON d.id = r.depot_id WHERE r.id = ?", routeId);
  const stops = all("SELECT p.lat, p.lng FROM route_stops s JOIN places p ON p.id = s.place_id WHERE s.route_id = ? ORDER BY s.seq", routeId);
  if (!stops.length) { run("UPDATE routes SET geometry = NULL WHERE id = ?", routeId); return; }
  const depot = r.dlat != null ? { lat: r.dlat, lng: r.dlng } : null;
  const pts = depot ? [depot, ...stops, depot] : stops;
  const geo = await roadRoute(pts);
  run("UPDATE routes SET geometry = ? WHERE id = ?", geo ? JSON.stringify(geo) : null, routeId);
}

export function optimizeRoute(routeId) {
  const r = one("SELECT r.*, d.lat dlat, d.lng dlng FROM routes r LEFT JOIN depots d ON d.id = r.depot_id WHERE r.id = ?", routeId);
  const stops = all("SELECT s.id, p.lat, p.lng FROM route_stops s JOIN places p ON p.id = s.place_id WHERE s.route_id = ? AND s.status = 'pending' ORDER BY s.seq", routeId);
  const done = one("SELECT COUNT(*) n FROM route_stops WHERE route_id = ? AND status != 'pending'", routeId).n;
  const l = r.vehicle_id ? live.get(r.vehicle_id) : null;
  const start = r.status === "active" && l ? l : r.dlat != null ? { lat: r.dlat, lng: r.dlng } : stops[0];
  const end = r.dlat != null ? { lat: r.dlat, lng: r.dlng } : null;
  const order = optimizeOrder(start, stops, end);
  tx(() => order.forEach((idx, k) => run("UPDATE route_stops SET seq = ? WHERE id = ?", done + k + 1, stops[idx].id)));
}

export async function dispatchRoute(routeId, vehicleId) {
  const v = one("SELECT * FROM vehicles WHERE id = ?", vehicleId);
  if (!v) throw httpError(400, "Choose a vehicle that exists.");
  if (v.maintenance) throw httpError(409, `${v.code} is in maintenance.`);
  const busy = one("SELECT code FROM routes WHERE vehicle_id = ? AND status IN ('dispatched','active') AND id != ?", vehicleId, routeId);
  if (busy) throw httpError(409, `${v.code} already has route ${busy.code}. Finish or cancel it first.`);
  const n = one("SELECT COUNT(*) n FROM route_stops WHERE route_id = ?", routeId).n;
  if (!n) throw httpError(400, "Add at least one stop before dispatching.");
  run("UPDATE routes SET vehicle_id = ?, depot_id = COALESCE(depot_id, ?), status = 'dispatched', dispatched_at = ? WHERE id = ?", vehicleId, v.depot_id, Date.now(), routeId);
  await attachGeometry(routeId);
  const r = one("SELECT r.*, d.lat dlat, d.lng dlng FROM routes r LEFT JOIN depots d ON d.id = r.depot_id WHERE r.id = ?", routeId);
  planStops(r, Date.now() + 10 * 60e3, r.dlat != null ? { lat: r.dlat, lng: r.dlng } : live.get(vehicleId) || { lat: 0, lng: 0 });
  addAlert({ vehicleId, routeId, kind: "dispatch", severity: "info", message: `Route ${r.code} sent to ${v.code} (${n} stops)` });
  pushRoute(routeId);
  pushVehicle(vehicleId);
}

export function startRoute(routeId, by = "driver") {
  const r = one("SELECT r.*, d.lat dlat, d.lng dlng FROM routes r LEFT JOIN depots d ON d.id = r.depot_id WHERE r.id = ?", routeId);
  if (!r || r.status !== "dispatched") return;
  const now = Date.now();
  run("UPDATE routes SET status = 'active', started_at = ? WHERE id = ?", now, routeId);
  const l = live.get(r.vehicle_id);
  const from = l ? { lat: l.lat, lng: l.lng, fromVehicle: haversine(l, { lat: r.dlat ?? l.lat, lng: r.dlng ?? l.lng }) > 300 } : { lat: r.dlat, lng: r.dlng };
  planStops(r, now, from);
  addAlert({ vehicleId: r.vehicle_id, routeId, kind: "route_start", severity: "info", message: `Route ${r.code} started${by === "auto" ? " (first stop reached)" : ""}` });
  pushRoute(routeId);
  pushVehicle(r.vehicle_id);
}

export function cancelRoute(routeId) {
  const r = one("SELECT * FROM routes WHERE id = ?", routeId);
  if (!r || ["completed", "cancelled"].includes(r.status)) return;
  run("UPDATE routes SET status = 'cancelled', completed_at = ? WHERE id = ?", Date.now(), routeId);
  run("UPDATE route_stops SET status = 'skipped', note = COALESCE(note, 'Route cancelled') WHERE route_id = ? AND status IN ('pending','arrived')", routeId);
  if (r.vehicle_id) addAlert({ vehicleId: r.vehicle_id, routeId, kind: "route_cancel", severity: "warn", message: `Route ${r.code} cancelled by dispatch` });
  pushRoute(routeId);
  if (r.vehicle_id) pushVehicle(r.vehicle_id);
}

function maybeCompleteRoute(routeId) {
  const left = one("SELECT COUNT(*) n FROM route_stops WHERE route_id = ? AND status IN ('pending','arrived')", routeId).n;
  if (left) return;
  const r = one("SELECT * FROM routes WHERE id = ?", routeId);
  if (r.status !== "active") return;
  run("UPDATE routes SET status = 'completed', completed_at = ? WHERE id = ?", Date.now(), routeId);
  const s = one(`SELECT SUM(status='completed') done, SUM(status='completed' AND arrived_at <= planned_at + ?) ontime, COUNT(*) total FROM route_stops WHERE route_id = ?`, CFG.lateGraceMin * 60e3, routeId);
  const v = one("SELECT code FROM vehicles WHERE id = ?", r.vehicle_id);
  addAlert({ vehicleId: r.vehicle_id, routeId, kind: "route_done", severity: "info", message: `${v.code} finished ${r.code}: ${s.done}/${s.total} delivered, ${s.ontime || 0} on time` });
}

/* ---------- stop events ---------- */
export function arriveStop(stopId, how = "driver", at = Date.now()) {
  const s = one("SELECT s.*, r.vehicle_id, r.code, r.status rstatus, p.name FROM route_stops s JOIN routes r ON r.id = s.route_id JOIN places p ON p.id = s.place_id WHERE s.id = ?", stopId);
  if (!s || s.status !== "pending") return s;
  if (s.rstatus === "dispatched") startRoute(s.route_id, "auto");
  run("UPDATE route_stops SET status = 'arrived', arrived_at = ? WHERE id = ?", at, stopId);
  const lateMin = s.planned_at ? Math.round((at - s.planned_at) / 60e3) : 0;
  if (lateMin > CFG.lateGraceMin) {
    const v = one("SELECT code FROM vehicles WHERE id = ?", s.vehicle_id);
    addAlert({ vehicleId: s.vehicle_id, routeId: s.route_id, kind: "late_arrival", severity: "warn", message: `${v.code} arrived ${lateMin} min late at ${s.name}` });
  }
  pushRoute(s.route_id);
  pushVehicle(s.vehicle_id);
  return s;
}

export function completeStop(stopId, note = null, how = "driver") {
  const s = one("SELECT s.*, r.vehicle_id FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE s.id = ?", stopId);
  if (!s || !["pending", "arrived"].includes(s.status)) return s;
  const now = Date.now();
  run("UPDATE route_stops SET status = 'completed', arrived_at = COALESCE(arrived_at, ?), completed_at = ?, note = ? WHERE id = ?",
    now, now, note || (how === "auto" ? "Auto-completed when vehicle left the stop" : null), stopId);
  maybeCompleteRoute(s.route_id);
  pushRoute(s.route_id);
  pushVehicle(s.vehicle_id);
  return s;
}

export function skipStop(stopId, reason) {
  const s = one("SELECT s.*, r.vehicle_id, p.name FROM route_stops s JOIN routes r ON r.id = s.route_id JOIN places p ON p.id = s.place_id WHERE s.id = ?", stopId);
  if (!s || !["pending", "arrived"].includes(s.status)) return s;
  run("UPDATE route_stops SET status = 'skipped', completed_at = ?, note = ? WHERE id = ?", Date.now(), reason || "Skipped by driver", stopId);
  const v = one("SELECT code FROM vehicles WHERE id = ?", s.vehicle_id);
  addAlert({ vehicleId: s.vehicle_id, routeId: s.route_id, kind: "stop_skipped", severity: "warn", message: `${v.code} skipped ${s.name}: ${reason || "no reason given"}` });
  maybeCompleteRoute(s.route_id);
  pushRoute(s.route_id);
  pushVehicle(s.vehicle_id);
  return s;
}

/* ---------- GPS ingestion ---------- */
export function ingestPositions(driver, shift, points) {
  const v = one("SELECT * FROM vehicles WHERE id = ?", shift.vehicle_id);
  const now = Date.now();
  const clean = points
    .map((p) => ({ lat: +p.lat, lng: +p.lng, speed: p.speed == null ? null : +p.speed, heading: p.heading == null ? null : +p.heading, accuracy: p.accuracy == null ? null : +p.accuracy, t: Math.round(+p.t || now) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && p.t > now - 7 * 864e5 && p.t < now + 120e3)
    .sort((a, b) => a.t - b.t);
  if (!clean.length) return 0;

  let l = live.get(v.id);
  const insert = "INSERT INTO positions (vehicle_id, shift_id, driver_id, lat, lng, speed_kmh, heading, accuracy_m, recorded_at, received_at) VALUES (?,?,?,?,?,?,?,?,?,?)";
  let accepted = 0;
  tx(() => {
    for (const p of clean) {
      if (p.accuracy != null && p.accuracy > 500) continue;
      // Fill speed/heading from the previous fix when the device doesn't report them.
      if (l && p.t > l.t) {
        const d = haversine(l, p), dt = (p.t - l.t) / 1000;
        if (p.speed == null && dt > 0) p.speed = (d / dt) * 3.6;
        if ((p.heading == null || Number.isNaN(p.heading)) && d > 8) p.heading = bearing(l, p);
      }
      run(insert, v.id, shift.id, driver.id, p.lat, p.lng, p.speed, p.heading, p.accuracy, p.t, now);
      accepted++;
      if (!l || p.t >= l.t) {
        l = { ...(l || { overSpeed: 0, lastSpeedAlert: 0 }), lat: p.lat, lng: p.lng, speed: p.speed ?? 0, heading: p.heading ?? l?.heading ?? 0, accuracy: p.accuracy, t: p.t, offlineAlerted: false };
        live.set(v.id, l);
        checkPoint(v, l, p);
      }
    }
  });
  pushVehicle(v.id);
  return accepted;
}

function checkPoint(v, l, p) {
  // Speeding: two consecutive fixes over the vehicle's limit, at most one alert per 10 minutes.
  if (p.speed != null && p.speed > v.speed_limit_kmh + 5 && (p.accuracy ?? 0) <= CFG.maxAccuracyM) {
    l.overSpeed++;
    if (l.overSpeed >= 2 && p.t - l.lastSpeedAlert > 10 * 60e3) {
      l.lastSpeedAlert = p.t;
      addAlert({ vehicleId: v.id, kind: "speeding", severity: "crit", message: `${v.code} at ${Math.round(p.speed)} km/h (limit ${v.speed_limit_kmh})` });
    }
  } else l.overSpeed = 0;

  if (p.accuracy != null && p.accuracy > CFG.maxAccuracyM) return;
  const route = currentRoute(v.id);
  if (!route) return;
  // Geofence: auto-arrive at the next stop; auto-complete a stop the driver drove away from.
  const arrived = one("SELECT s.id, p.lat, p.lng FROM route_stops s JOIN places p ON p.id = s.place_id WHERE s.route_id = ? AND s.status = 'arrived' ORDER BY s.seq LIMIT 1", route.id);
  if (arrived && haversine(p, arrived) > CFG.geofenceM * 2.5) completeStop(arrived.id, null, "auto");
  const next = one("SELECT s.id, p.lat, p.lng FROM route_stops s JOIN places p ON p.id = s.place_id WHERE s.route_id = ? AND s.status = 'pending' ORDER BY s.seq LIMIT 1", route.id);
  if (next && haversine(p, next) <= CFG.geofenceM && !one("SELECT 1 FROM route_stops WHERE route_id = ? AND status = 'arrived'", route.id)) arriveStop(next.id, "auto", p.t);
}

/* ---------- periodic monitor ---------- */
export function monitorTick() {
  const now = Date.now();
  for (const v of all("SELECT * FROM vehicles")) {
    const shift = openShift(v.id);
    const l = live.get(v.id);
    if (shift && l && now - l.t > CFG.offlineMin * 60e3 && !l.offlineAlerted) {
      l.offlineAlerted = true;
      addAlert({ vehicleId: v.id, kind: "offline", severity: "warn", message: `${v.code} stopped sending GPS (last fix ${Math.round((now - l.t) / 60e3)} min ago)` });
      pushVehicle(v.id);
    }
  }
  const late = all(`SELECT s.id, s.route_id, s.planned_at, r.vehicle_id, v.code, p.name FROM route_stops s
    JOIN routes r ON r.id = s.route_id JOIN vehicles v ON v.id = r.vehicle_id JOIN places p ON p.id = s.place_id
    WHERE r.status = 'active' AND s.status = 'pending' AND s.late_alerted = 0 AND s.planned_at < ?`, now - CFG.lateGraceMin * 60e3);
  const seenRoutes = new Set();
  for (const s of late) {
    run("UPDATE route_stops SET late_alerted = 1 WHERE id = ?", s.id);
    if (seenRoutes.has(s.route_id)) continue; // one alert per route per tick
    seenRoutes.add(s.route_id);
    addAlert({ vehicleId: s.vehicle_id, routeId: s.route_id, kind: "running_late", severity: "warn", message: `${s.code} is running behind for ${s.name} (due ${new Date(s.planned_at).toTimeString().slice(0, 5)})` });
    pushVehicle(s.vehicle_id);
  }
}

/* ---------- analytics ---------- */
export function analytics(date = localDate()) {
  const [from, to] = dayBounds(date);
  const graceMs = CFG.lateGraceMin * 60e3;
  const vehicles = all("SELECT id, code, type FROM vehicles ORDER BY code");
  const perVehicle = vehicles.map((v) => {
    const pts = all("SELECT lat, lng, speed_kmh, accuracy_m, recorded_at t FROM positions WHERE vehicle_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at", v.id, from, to);
    let meters = 0, drivingMs = 0, maxSpeed = 0, prev = null;
    for (const p of pts) {
      if (p.accuracy_m != null && p.accuracy_m > CFG.maxAccuracyM) continue;
      if (prev) {
        const d = haversine(prev, p), dt = p.t - prev.t;
        if (dt > 0 && d / (dt / 1000) < 70) { // ignore teleports (>250 km/h)
          meters += d;
          if (dt < 180e3 && d / (dt / 1000) > 1.5) drivingMs += dt;
        }
      }
      maxSpeed = Math.max(maxSpeed, p.speed_kmh || 0);
      prev = p;
    }
    let shiftMs = 0;
    for (const s of all("SELECT started_at, ended_at FROM shifts WHERE vehicle_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)", v.id, to, from)) {
      shiftMs += Math.max(0, Math.min(s.ended_at ?? Date.now(), to) - Math.max(s.started_at, from));
    }
    const st = one(`SELECT SUM(s.status='completed') delivered, SUM(s.status='skipped') skipped,
                    SUM(s.arrived_at IS NOT NULL AND s.arrived_at <= s.planned_at + ?) ontime, SUM(s.arrived_at IS NOT NULL AND s.arrived_at > s.planned_at + ?) late
                    FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE r.vehicle_id = ? AND r.service_date = ?`, graceMs, graceMs, v.id, date);
    return { id: v.id, code: v.code, type: v.type, km: meters / 1000, drivingMin: drivingMs / 60e3, shiftMin: shiftMs / 60e3, maxSpeed, fixes: pts.length,
      delivered: st.delivered || 0, skipped: st.skipped || 0, ontime: st.ontime || 0, late: st.late || 0 };
  });
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, ontime: 0, late: 0 }));
  for (const s of all(`SELECT s.arrived_at, s.planned_at FROM route_stops s JOIN routes r ON r.id = s.route_id
                       WHERE r.service_date = ? AND s.status = 'completed' AND s.arrived_at IS NOT NULL`, date)) {
    const h = new Date(s.arrived_at).getHours();
    if (s.planned_at && s.arrived_at > s.planned_at + graceMs) hours[h].late++; else hours[h].ontime++;
  }
  const routes = all("SELECT id FROM routes WHERE service_date = ? AND status != 'draft' ORDER BY code", date).map(({ id }) => {
    const r = routeWithStops(id);
    const arrivedStops = r.stops.filter((s) => s.arrived_at);
    return { id: r.id, code: r.code, name: r.name, vehicle_code: r.vehicle_code, status: r.status, total: r.stops.length,
      delivered: r.stops.filter((s) => s.status === "completed").length, skipped: r.stops.filter((s) => s.status === "skipped").length,
      ontime: arrivedStops.filter((s) => s.arrived_at <= s.planned_at + graceMs).length, arrived: arrivedStops.length,
      plannedKm: r.geometry?.meters ? r.geometry.meters / 1000 : null, started_at: r.started_at, completed_at: r.completed_at };
  });
  const alertCounts = all("SELECT kind, COUNT(*) n FROM alerts WHERE created_at >= ? AND created_at < ? GROUP BY kind", from, to);
  return { date, graceMin: CFG.lateGraceMin, vehicles: perVehicle, hours, routes, alertCounts };
}

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
