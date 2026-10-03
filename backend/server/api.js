import express from "express";
import { one, all, run, tx, localDate } from "./db.js";
import { requireAuth, verifyPassword, hashPassword, signToken, loginThrottled, noteLoginFailure, clearLoginFailures } from "./auth.js";
import * as F from "./fleet.js";

export const api = express.Router();
const staff = requireAuth("admin", "dispatcher");
const admin = requireAuth("admin");
const driverOnly = requireAuth("driver");

// Wrap async handlers so thrown errors reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg) => F.httpError(400, msg);
const str = (v, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v) => (v === "" || v == null ? null : Number(v));
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad("Invalid id."); return n; };

/* ---------- auth ---------- */
api.post("/auth/login", h(async (req, res) => {
  const username = str(req.body?.username, 60), password = String(req.body?.password || "");
  const key = `${username.toLowerCase()}|${req.ip}`;
  if (loginThrottled(key)) return res.status(429).json({ error: "Too many attempts. Wait 10 minutes and try again." });
  const u = one("SELECT * FROM users WHERE username = ? AND active = 1", username);
  if (!u || !verifyPassword(password, u.pass_hash)) { noteLoginFailure(key); return res.status(401).json({ error: "Username or password is incorrect." }); }
  if (req.body?.app && req.body.app !== (u.role === "driver" ? "driver" : "dispatch")) {
    return res.status(403).json({ error: u.role === "driver" ? "Drivers sign in through the driver app." : "Use the dispatch console to sign in." });
  }
  clearLoginFailures(key);
  res.json({ token: signToken(u), user: { id: u.id, name: u.name, username: u.username, role: u.role } });
}));
api.get("/me", requireAuth(), (req, res) => res.json(req.user));
api.get("/config", (req, res) => res.json({
  tileUrl: process.env.TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  geofenceM: F.CFG.geofenceM, lateGraceMin: F.CFG.lateGraceMin, offlineMin: F.CFG.offlineMin,
}));

/* ---------- fleet (dispatch) ---------- */
api.get("/fleet", staff, (req, res) => res.json(F.fleetSummary()));
api.get("/depots", staff, (req, res) => res.json(all("SELECT * FROM depots ORDER BY name")));
api.get("/vehicles/:id/track", staff, (req, res) => {
  const since = Number(req.query.since) || Date.now() - 3 * 3600e3;
  res.json(all("SELECT lat, lng, speed_kmh, heading, accuracy_m, recorded_at FROM positions WHERE vehicle_id = ? AND recorded_at >= ? ORDER BY recorded_at LIMIT 20000", id(req.params.id), since));
});
api.post("/vehicles", admin, (req, res) => {
  const code = str(req.body.code, 20).toUpperCase(), type = str(req.body.type, 40) || "Van";
  if (!code) throw bad("Enter a vehicle code, e.g. VAN-12.");
  if (one("SELECT 1 FROM vehicles WHERE code = ?", code)) throw bad(`${code} already exists.`);
  const r = run("INSERT INTO vehicles (code, type, plate, depot_id, default_driver_id, speed_limit_kmh, created_at) VALUES (?,?,?,?,?,?,?)",
    code, type, str(req.body.plate, 20) || null, num(req.body.depot_id), num(req.body.default_driver_id), num(req.body.speed_limit_kmh) || 90, Date.now());
  res.status(201).json(one("SELECT * FROM vehicles WHERE id = ?", r.lastInsertRowid));
});
api.patch("/vehicles/:id", staff, (req, res) => {
  const vid = id(req.params.id), b = req.body, v = one("SELECT * FROM vehicles WHERE id = ?", vid);
  if (!v) throw F.httpError(404, "Vehicle not found.");
  run("UPDATE vehicles SET type = ?, plate = ?, depot_id = ?, default_driver_id = ?, maintenance = ?, speed_limit_kmh = ? WHERE id = ?",
    b.type !== undefined ? str(b.type, 40) : v.type, b.plate !== undefined ? str(b.plate, 20) || null : v.plate,
    b.depot_id !== undefined ? num(b.depot_id) : v.depot_id, b.default_driver_id !== undefined ? num(b.default_driver_id) : v.default_driver_id,
    b.maintenance !== undefined ? (b.maintenance ? 1 : 0) : v.maintenance, b.speed_limit_kmh !== undefined ? num(b.speed_limit_kmh) || 90 : v.speed_limit_kmh, vid);
  if (b.maintenance !== undefined && !!b.maintenance !== !!v.maintenance)
    F.addAlert({ vehicleId: vid, kind: "maintenance", severity: "info", message: `${v.code} ${b.maintenance ? "sent to maintenance" : "returned to service"}` });
  F.notifyVehicle(vid);
  res.json(one("SELECT * FROM vehicles WHERE id = ?", vid));
});

/* ---------- drivers ---------- */
api.get("/drivers", staff, (req, res) => res.json(all(`SELECT u.id, u.name, u.username, u.phone, u.active,
  (SELECT v.code FROM shifts s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.driver_id = u.id AND s.ended_at IS NULL) AS on_shift_vehicle
  FROM users u WHERE u.role = 'driver' ORDER BY u.name`)));
api.post("/drivers", admin, (req, res) => {
  const name = str(req.body.name, 80), username = str(req.body.username, 40).toLowerCase(), password = String(req.body.password || "");
  if (!name || !username) throw bad("Enter the driver's name and a username.");
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad("Usernames use 3–40 letters, numbers, dots, dashes or underscores.");
  if (password.length < 6) throw bad("Passwords need at least 6 characters.");
  if (one("SELECT 1 FROM users WHERE username = ?", username)) throw bad(`The username ${username} is taken.`);
  const r = run("INSERT INTO users (name, username, role, pass_hash, phone, created_at) VALUES (?,?,?,?,?,?)", name, username, "driver", hashPassword(password), str(req.body.phone, 30) || null, Date.now());
  res.status(201).json(one("SELECT id, name, username, phone, active FROM users WHERE id = ?", r.lastInsertRowid));
});
api.patch("/drivers/:id", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ? AND role = 'driver'", uid);
  if (!u) throw F.httpError(404, "Driver not found.");
  if (req.body.password) { if (String(req.body.password).length < 6) throw bad("Passwords need at least 6 characters."); run("UPDATE users SET pass_hash = ? WHERE id = ?", hashPassword(String(req.body.password)), uid); }
  if (req.body.active !== undefined) run("UPDATE users SET active = ? WHERE id = ?", req.body.active ? 1 : 0, uid);
  if (req.body.phone !== undefined) run("UPDATE users SET phone = ? WHERE id = ?", str(req.body.phone, 30) || null, uid);
  if (req.body.name) run("UPDATE users SET name = ? WHERE id = ?", str(req.body.name, 80), uid);
  res.json(one("SELECT id, name, username, phone, active FROM users WHERE id = ?", uid));
});

/* ---------- places ---------- */
api.get("/places", staff, (req, res) => res.json(all("SELECT * FROM places ORDER BY name")));
api.post("/places", staff, (req, res) => {
  const name = str(req.body.name, 80), lat = num(req.body.lat), lng = num(req.body.lng);
  if (!name) throw bad("Give the place a name.");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad("Pick the place's location on the map.");
  const r = run("INSERT INTO places (name, address, lat, lng, dwell_min, created_at) VALUES (?,?,?,?,?,?)", name, str(req.body.address, 160) || null, lat, lng, Math.max(1, num(req.body.dwell_min) || 8), Date.now());
  res.status(201).json(one("SELECT * FROM places WHERE id = ?", r.lastInsertRowid));
});
api.patch("/places/:id", staff, (req, res) => {
  const pid = id(req.params.id), p = one("SELECT * FROM places WHERE id = ?", pid);
  if (!p) throw F.httpError(404, "Place not found.");
  const b = req.body;
  run("UPDATE places SET name = ?, address = ?, lat = ?, lng = ?, dwell_min = ? WHERE id = ?", b.name ? str(b.name, 80) : p.name, b.address !== undefined ? str(b.address, 160) || null : p.address,
    num(b.lat) ?? p.lat, num(b.lng) ?? p.lng, num(b.dwell_min) || p.dwell_min, pid);
  res.json(one("SELECT * FROM places WHERE id = ?", pid));
});
api.delete("/places/:id", staff, (req, res) => {
  const pid = id(req.params.id);
  if (one("SELECT 1 FROM route_stops WHERE place_id = ?", pid)) throw F.httpError(409, "This place is used on a route, so it can't be deleted.");
  run("DELETE FROM places WHERE id = ?", pid);
  res.status(204).end();
});

/* ---------- routes ---------- */
api.get("/routes", staff, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : localDate();
  const ids = all("SELECT id FROM routes WHERE service_date = ? OR status IN ('draft','dispatched','active') ORDER BY code", date);
  res.json(ids.map((r) => F.routeWithStops(r.id)));
});
api.get("/routes/:id", staff, (req, res) => {
  const r = F.routeWithStops(id(req.params.id));
  if (!r) throw F.httpError(404, "Route not found.");
  res.json(r);
});
function setStops(routeId, placeIds) {
  if (!Array.isArray(placeIds)) throw bad("Stops must be a list of places.");
  const ids = placeIds.map(Number);
  if (new Set(ids).size !== ids.length) throw bad("A place can only appear once on a route.");
  for (const p of ids) if (!one("SELECT 1 FROM places WHERE id = ?", p)) throw bad("One of the stops no longer exists.");
  tx(() => {
    run("DELETE FROM route_stops WHERE route_id = ?", routeId);
    ids.forEach((p, i) => run("INSERT INTO route_stops (route_id, seq, place_id) VALUES (?,?,?)", routeId, i + 1, p));
  });
}
api.post("/routes", staff, h(async (req, res) => {
  const name = str(req.body.name, 80) || "Ad-hoc route";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.service_date || "") ? req.body.service_date : localDate();
  const last = one("SELECT MAX(CAST(SUBSTR(code, 3) AS INTEGER)) n FROM routes").n || 1000;
  const r = run("INSERT INTO routes (code, name, depot_id, service_date, created_by, created_at) VALUES (?,?,?,?,?,?)",
    `R-${last + 1}`, name, num(req.body.depot_id), date, req.user.id, Date.now());
  const rid = Number(r.lastInsertRowid);
  setStops(rid, req.body.place_ids || []);
  if (req.body.optimize) F.optimizeRoute(rid);
  if (req.body.vehicle_id) await F.dispatchRoute(rid, Number(req.body.vehicle_id));
  else { await F.attachGeometry(rid); F.notifyRoute(rid); }
  res.status(201).json(F.routeWithStops(rid));
}));
api.patch("/routes/:id", staff, h(async (req, res) => {
  const rid = id(req.params.id), r = one("SELECT * FROM routes WHERE id = ?", rid);
  if (!r) throw F.httpError(404, "Route not found.");
  if (!["draft", "dispatched"].includes(r.status)) throw F.httpError(409, "Only routes that haven't started can be edited.");
  if (req.body.name) run("UPDATE routes SET name = ? WHERE id = ?", str(req.body.name, 80), rid);
  if (req.body.depot_id !== undefined) run("UPDATE routes SET depot_id = ? WHERE id = ?", num(req.body.depot_id), rid);
  if (req.body.place_ids) { setStops(rid, req.body.place_ids); await F.attachGeometry(rid); }
  F.notifyRoute(rid);
  res.json(F.routeWithStops(rid));
}));
api.post("/routes/:id/optimize", staff, h(async (req, res) => {
  const rid = id(req.params.id), r = one("SELECT * FROM routes WHERE id = ?", rid);
  if (!r || ["completed", "cancelled"].includes(r.status)) throw F.httpError(409, "This route is finished.");
  F.optimizeRoute(rid);
  await F.attachGeometry(rid);
  F.notifyRoute(rid);
  res.json(F.routeWithStops(rid));
}));
api.post("/routes/:id/dispatch", staff, h(async (req, res) => {
  const rid = id(req.params.id), r = one("SELECT * FROM routes WHERE id = ?", rid);
  if (!r) throw F.httpError(404, "Route not found.");
  if (!["draft", "dispatched"].includes(r.status)) throw F.httpError(409, "This route has already started.");
  const vid = Number(req.body.vehicle_id || r.vehicle_id);
  if (!vid) throw bad("Choose a vehicle.");
  if (r.status === "dispatched" && r.vehicle_id && r.vehicle_id !== vid) {
    const old = r.vehicle_id; run("UPDATE routes SET status = 'draft', vehicle_id = NULL WHERE id = ?", rid); F.notifyVehicle(old);
  }
  await F.dispatchRoute(rid, vid);
  res.json(F.routeWithStops(rid));
}));
api.post("/routes/:id/cancel", staff, (req, res) => { F.cancelRoute(id(req.params.id)); res.json(F.routeWithStops(id(req.params.id))); });
api.delete("/routes/:id", staff, (req, res) => {
  const rid = id(req.params.id), r = one("SELECT status FROM routes WHERE id = ?", rid);
  if (r?.status !== "draft") throw F.httpError(409, "Only draft routes can be deleted. Cancel dispatched routes instead.");
  run("DELETE FROM routes WHERE id = ?", rid);
  res.status(204).end();
});

/* ---------- alerts & analytics ---------- */
api.get("/alerts", staff, (req, res) => res.json(all(`SELECT a.*, v.code AS vehicle_code FROM alerts a LEFT JOIN vehicles v ON v.id = a.vehicle_id
  WHERE a.created_at > ? ORDER BY a.id DESC LIMIT 300`, Date.now() - 36 * 3600e3)));
api.post("/alerts/:id/ack", staff, (req, res) => { run("UPDATE alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL", Date.now(), req.user.id, id(req.params.id)); res.json({ ok: true }); });
api.post("/alerts/ack-all", staff, (req, res) => { run("UPDATE alerts SET acked_at = ?, acked_by = ? WHERE acked_at IS NULL", Date.now(), req.user.id); res.json({ ok: true }); });
api.get("/analytics", staff, (req, res) => res.json(F.analytics(/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : localDate())));

/* ---------- driver app ---------- */
function driverState(user) {
  const shift = F.driverShift(user.id);
  const vehicle = shift ? one("SELECT id, code, type, plate FROM vehicles WHERE id = ?", shift.vehicle_id) : null;
  const route = vehicle ? one("SELECT id FROM routes WHERE vehicle_id = ? AND status IN ('active','dispatched') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1", vehicle.id) : null;
  const vehicles = shift ? [] : all(`SELECT v.id, v.code, v.type, v.plate, v.default_driver_id = ? AS mine FROM vehicles v
    WHERE v.maintenance = 0 AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.vehicle_id = v.id AND s.ended_at IS NULL) ORDER BY mine DESC, v.code`, user.id);
  const finished = vehicle && !route && shift
    ? one("SELECT id FROM routes WHERE vehicle_id = ? AND status IN ('completed','cancelled') AND completed_at > ? ORDER BY completed_at DESC LIMIT 1", vehicle.id, shift.started_at)
    : null;
  return { user, shift: shift ?? null, vehicle, vehicles, route: route ? F.routeWithStops(route.id) : null, finished: finished ? F.routeWithStops(finished.id) : null, config: { geofenceM: F.CFG.geofenceM } };
}
api.get("/driver/state", driverOnly, (req, res) => res.json(driverState(req.user)));
api.post("/driver/shift/start", driverOnly, (req, res) => {
  if (F.driverShift(req.user.id)) return res.json(driverState(req.user));
  const vid = id(req.body.vehicle_id), v = one("SELECT * FROM vehicles WHERE id = ?", vid);
  if (!v) throw bad("Choose your vehicle.");
  if (v.maintenance) throw F.httpError(409, `${v.code} is in maintenance. Choose another vehicle.`);
  if (one("SELECT 1 FROM shifts WHERE vehicle_id = ? AND ended_at IS NULL", vid)) throw F.httpError(409, `${v.code} is already in use by another driver.`);
  run("INSERT INTO shifts (driver_id, vehicle_id, started_at) VALUES (?,?,?)", req.user.id, vid, Date.now());
  F.addAlert({ vehicleId: vid, kind: "shift_start", severity: "info", message: `${req.user.name} started a shift in ${v.code}` });
  F.notifyVehicle(vid);
  res.json(driverState(req.user));
});
api.post("/driver/shift/end", driverOnly, (req, res) => {
  const s = F.driverShift(req.user.id);
  if (s) {
    run("UPDATE shifts SET ended_at = ? WHERE id = ?", Date.now(), s.id);
    const v = one("SELECT code FROM vehicles WHERE id = ?", s.vehicle_id);
    F.addAlert({ vehicleId: s.vehicle_id, kind: "shift_end", severity: "info", message: `${req.user.name} ended their shift in ${v.code}` });
    F.notifyVehicle(s.vehicle_id);
  }
  res.json(driverState(req.user));
});
api.post("/driver/positions", driverOnly, (req, res) => {
  const s = F.driverShift(req.user.id);
  if (!s) throw F.httpError(409, "Start a shift before sending location.");
  const pts = Array.isArray(req.body.points) ? req.body.points.slice(0, 2000) : [];
  const accepted = F.ingestPositions(req.user, s, pts);
  // A compact route summary lets background clients notice new or changed assignments without a socket.
  const r = one(`SELECT r.id, r.code, r.name, r.status, COUNT(st.id) AS stops, SUM(st.status IN ('completed','skipped')) AS done
                 FROM routes r JOIN route_stops st ON st.route_id = r.id
                 WHERE r.vehicle_id = ? AND r.status IN ('active','dispatched') GROUP BY r.id
                 ORDER BY CASE r.status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1`, s.vehicle_id);
  res.json({ accepted, route: r ? { ...r, done: r.done || 0 } : null });
});
function ownStop(user, stopId) {
  const s = F.driverShift(user.id);
  const st = s && one("SELECT s.id FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE s.id = ? AND r.vehicle_id = ? AND r.status IN ('dispatched','active')", stopId, s.vehicle_id);
  if (!st) throw F.httpError(404, "That stop isn't on your current route.");
}
api.post("/driver/route/:id/start", driverOnly, (req, res) => {
  const s = F.driverShift(req.user.id), rid = id(req.params.id);
  if (!s || !one("SELECT 1 FROM routes WHERE id = ? AND vehicle_id = ?", rid, s.vehicle_id)) throw F.httpError(404, "That route isn't assigned to your vehicle.");
  F.startRoute(rid);
  res.json(driverState(req.user));
});
api.post("/driver/stops/:id/arrive", driverOnly, (req, res) => { const sid = id(req.params.id); ownStop(req.user, sid); F.arriveStop(sid); res.json(driverState(req.user)); });
api.post("/driver/stops/:id/complete", driverOnly, (req, res) => { const sid = id(req.params.id); ownStop(req.user, sid); F.completeStop(sid, str(req.body?.note, 300) || null); res.json(driverState(req.user)); });
api.post("/driver/stops/:id/skip", driverOnly, (req, res) => { const sid = id(req.params.id); ownStop(req.user, sid); F.skipStop(sid, str(req.body?.reason, 200)); res.json(driverState(req.user)); });

api.use((req, res) => res.status(404).json({ error: "Not found." }));
// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong on the server. Try again." });
});
