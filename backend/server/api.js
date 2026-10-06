import crypto from "node:crypto";
import express from "express";
import { one, all, run, tx, localDate } from "./db.js";
import { requireAuth, requireAuthAllowNoMfa, verifyPassword, hashPassword, signToken, loginThrottled, noteLoginFailure, clearLoginFailures, passwordProblem } from "./auth.js";
import { audit, auditEntries, newTotpSecret, verifyTotp, otpauthUri, staffMfaRequired, PRIVACY_NOTICE, privacyStatus } from "./security.js";
import * as F from "./fleet.js";
import * as Stats from "./stats.js";

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
  if (!u || !verifyPassword(password, u.pass_hash)) {
    noteLoginFailure(key);
    audit(req, "auth.login_failed", { type: "user", id: u?.id ?? null, details: { username } });
    return res.status(401).json({ error: "Username or password is incorrect." });
  }
  if (u.approval === "pending") return res.status(403).json({ error: "Your account is waiting for approval. Your dispatcher will let you know when it's ready." });
  if (u.approval === "declined") return res.status(403).json({ error: "Your sign-up wasn't approved. Contact your dispatcher." });
  if (req.body?.app && req.body.app !== (u.role === "driver" ? "driver" : "dispatch")) {
    return res.status(403).json({ error: u.role === "driver" ? "Drivers sign in through the driver app." : "Use the dispatch console to sign in." });
  }
  if (u.mfa_enabled) {
    if (!req.body?.code) return res.status(401).json({ error: "Enter the 6-digit code from your authenticator app.", mfa_required: true });
    const step = verifyTotp(u.mfa_secret, req.body.code);
    if (step == null || (u.mfa_last_step != null && step <= u.mfa_last_step)) {
      noteLoginFailure(key);
      audit(req, "auth.mfa_failed", { type: "user", id: u.id, actor: u });
      return res.status(401).json({ error: "That code didn't work. Wait for a new code and try again.", mfa_required: true });
    }
    run("UPDATE users SET mfa_last_step = ? WHERE id = ?", step, u.id);
  }
  clearLoginFailures(key);
  audit(req, "auth.login", { type: "user", id: u.id, actor: u, details: { mfa: !!u.mfa_enabled } });
  const mfaSetupRequired = u.role !== "driver" && !u.mfa_enabled && staffMfaRequired();
  res.json({ token: signToken(u), user: { id: u.id, name: u.name, username: u.username, role: u.role }, mfa_setup_required: mfaSetupRequired });
}));
api.get("/me", requireAuthAllowNoMfa(), (req, res) => res.json({
  ...req.user,
  mfa_setup_required: req.user.role !== "driver" && !req.user.mfa_enabled && staffMfaRequired(),
}));

/* ---------- two-step sign-in (authenticator app) ---------- */
api.post("/me/mfa/setup", requireAuthAllowNoMfa(), (req, res) => {
  const u = one("SELECT * FROM users WHERE id = ?", req.user.id);
  if (u.mfa_enabled) throw F.httpError(409, "Two-step sign-in is already on.");
  const secret = newTotpSecret();
  run("UPDATE users SET mfa_secret = ? WHERE id = ?", secret, u.id);
  res.json({ secret, otpauth_uri: otpauthUri(secret, u.username) });
});
api.post("/me/mfa/enable", requireAuthAllowNoMfa(), (req, res) => {
  const u = one("SELECT * FROM users WHERE id = ?", req.user.id);
  if (u.mfa_enabled) throw F.httpError(409, "Two-step sign-in is already on.");
  if (!u.mfa_secret) throw bad("Start the setup first.");
  const step = verifyTotp(u.mfa_secret, req.body?.code);
  if (step == null) throw bad("That code didn't match. Check the time on your phone and enter the newest code.");
  // Turning it on signs out every other session, which may have been opened without a code.
  run("UPDATE users SET mfa_enabled = 1, mfa_last_step = ?, token_version = token_version + 1 WHERE id = ?", step, u.id);
  audit(req, "auth.mfa_enabled", { type: "user", id: u.id });
  res.json({ token: signToken(one("SELECT * FROM users WHERE id = ?", u.id)) });
});
api.post("/me/mfa/disable", requireAuth(), (req, res) => {
  if (req.user.role !== "driver" && staffMfaRequired()) throw F.httpError(403, "Two-step sign-in is required for staff accounts. Ask an admin to reset it if you lost your phone.");
  const u = one("SELECT * FROM users WHERE id = ?", req.user.id);
  if (!verifyPassword(String(req.body?.password || ""), u.pass_hash) || verifyTotp(u.mfa_secret, req.body?.code) == null) throw bad("Your password or code is incorrect.");
  run("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_last_step = NULL, token_version = token_version + 1 WHERE id = ?", u.id);
  audit(req, "auth.mfa_disabled", { type: "user", id: u.id });
  res.json({ token: signToken(one("SELECT * FROM users WHERE id = ?", u.id)) });
});

// Drivers can request an account; it stays pending until an admin approves it and assigns a vehicle.
const signups = new Map(); // ip -> timestamps of recent sign-ups
api.post("/auth/register", (req, res) => {
  const recent = (signups.get(req.ip) || []).filter((t) => Date.now() - t < 3600e3);
  if (recent.length >= 5) return res.status(429).json({ error: "Too many sign-ups from this network. Try again in an hour." });
  const name = str(req.body?.name, 80), username = str(req.body?.username, 40).toLowerCase(), password = String(req.body?.password || "");
  const phone = str(req.body?.phone, 30), license = str(req.body?.license_no, 40);
  const pref = ["truck", "van", "either"].includes(req.body?.vehicle_type) ? req.body.vehicle_type : "either";
  if (!name) throw bad("Enter your full name.");
  if (!phone) throw bad("Enter a phone number your dispatcher can reach you on.");
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad("Usernames use 3–40 letters, numbers, dots, dashes or underscores.");
  const problem = passwordProblem(password, username);
  if (problem) throw bad(problem);
  if (one("SELECT 1 FROM users WHERE username = ?", username)) throw bad(`The username ${username} is taken. Choose another.`);
  run(`INSERT INTO users (name, username, role, pass_hash, phone, license_no, signup_note, approval, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    name, username, "driver", hashPassword(password), phone, license || null, `Prefers: ${pref}`, "pending", Date.now());
  signups.set(req.ip, [...recent, Date.now()]);
  audit(req, "user.signup", { type: "user", id: one("SELECT id FROM users WHERE username = ?", username).id, details: { username } });
  F.addAlert({ kind: "signup", severity: "warn", message: `New driver sign-up: ${name} (@${username}) is waiting for approval` });
  res.status(201).json({ ok: true, message: "Thanks! Your dispatcher will review your sign-up and assign your vehicle." });
});

/** Sets a password and signs the user out everywhere else. Returns a fresh token for the user. */
function setPassword(userId, password) {
  run("UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?", hashPassword(password), userId);
  return signToken(one("SELECT * FROM users WHERE id = ?", userId));
}
api.post("/me/password", requireAuthAllowNoMfa(), (req, res) => {
  const current = String(req.body?.current_password || ""), next = String(req.body?.new_password || "");
  const key = `pw|${req.user.id}|${req.ip}`;
  if (loginThrottled(key)) return res.status(429).json({ error: "Too many attempts. Wait 10 minutes and try again." });
  const u = one("SELECT * FROM users WHERE id = ?", req.user.id);
  if (!verifyPassword(current, u.pass_hash)) { noteLoginFailure(key); throw bad("Your current password is incorrect."); }
  clearLoginFailures(key);
  const problem = passwordProblem(next, u.username);
  if (problem) throw bad(problem);
  if (verifyPassword(next, u.pass_hash)) throw bad("Choose a new password that's different from your current one.");
  const token = setPassword(u.id, next);
  audit(req, "auth.password_changed", { type: "user", id: u.id });
  res.json({ token });
});
api.get("/config", (req, res) => res.json({
  // Esri World Street Map works without an API key for testing. OpenStreetMap's own tile servers
  // block app traffic and CARTO now requires a key. Use a keyed provider in production.
  tileUrl: process.env.TILE_URL || "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  tileAttribution: process.env.TILE_ATTRIBUTION ||
    'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS User Community',
  geofenceM: F.CFG.geofenceM, lateGraceMin: F.CFG.lateGraceMin, offlineMin: F.CFG.offlineMin,
}));

api.get("/health", (req, res) => {
  let dbOk = false;
  try { dbOk = one("SELECT 1 AS ok").ok === 1; } catch {}
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? "ok" : "degraded", db: dbOk ? "ok" : "error", uptime_s: Math.round(process.uptime()), time: new Date().toISOString() });
});
api.get("/privacy-notice", (req, res) => res.json(PRIVACY_NOTICE));

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
  const odo = Math.max(0, num(req.body.odometer_km) || 0);
  const r = run(`INSERT INTO vehicles (code, type, plate, depot_id, default_driver_id, speed_limit_kmh, odometer_km, last_service_km, service_interval_km, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
    code, type, str(req.body.plate, 20) || null, num(req.body.depot_id), num(req.body.default_driver_id), num(req.body.speed_limit_kmh) || 90,
    odo, Math.max(0, num(req.body.last_service_km) ?? odo), num(req.body.service_interval_km) || 10000, Date.now());
  audit(req, "vehicle.created", { type: "vehicle", id: Number(r.lastInsertRowid), details: { code } });
  res.status(201).json(one("SELECT * FROM vehicles WHERE id = ?", r.lastInsertRowid));
});
api.patch("/vehicles/:id", staff, (req, res) => {
  const vid = id(req.params.id), b = req.body, v = one("SELECT * FROM vehicles WHERE id = ?", vid);
  if (!v) throw F.httpError(404, "Vehicle not found.");
  run("UPDATE vehicles SET type = ?, plate = ?, depot_id = ?, default_driver_id = ?, maintenance = ?, speed_limit_kmh = ? WHERE id = ?",
    b.type !== undefined ? str(b.type, 40) : v.type, b.plate !== undefined ? str(b.plate, 20) || null : v.plate,
    b.depot_id !== undefined ? num(b.depot_id) : v.depot_id, b.default_driver_id !== undefined ? num(b.default_driver_id) : v.default_driver_id,
    b.maintenance !== undefined ? (b.maintenance ? 1 : 0) : v.maintenance, b.speed_limit_kmh !== undefined ? num(b.speed_limit_kmh) || 90 : v.speed_limit_kmh, vid);
  if (b.odometer_km !== undefined && Number.isFinite(num(b.odometer_km))) run("UPDATE vehicles SET odometer_km = ? WHERE id = ?", Math.max(0, num(b.odometer_km)), vid);
  if (b.service_interval_km !== undefined && num(b.service_interval_km) > 0) run("UPDATE vehicles SET service_interval_km = ? WHERE id = ?", num(b.service_interval_km), vid);
  if (b.maintenance !== undefined && !!b.maintenance !== !!v.maintenance)
    F.addAlert({ vehicleId: vid, kind: "maintenance", severity: "info", message: `${v.code} ${b.maintenance ? "sent to maintenance" : "returned to service"}` });
  const changed = Object.keys(b).filter((k) => ["type", "plate", "depot_id", "default_driver_id", "maintenance", "speed_limit_kmh", "odometer_km", "service_interval_km"].includes(k));
  if (changed.length) audit(req, "vehicle.updated", { type: "vehicle", id: vid, details: { code: v.code, fields: changed, maintenance: b.maintenance } });
  F.notifyVehicle(vid);
  res.json(one("SELECT * FROM vehicles WHERE id = ?", vid));
});

api.post("/vehicles/:id/service", staff, (req, res) => {
  const vid = id(req.params.id), v = one("SELECT * FROM vehicles WHERE id = ?", vid);
  if (!v) throw F.httpError(404, "Vehicle not found.");
  const now = Date.now(), note = str(req.body?.note, 300) || null;
  run("INSERT INTO services (vehicle_id, user_id, odometer_km, note, created_at) VALUES (?,?,?,?,?)", vid, req.user.id, v.odometer_km, note, now);
  run("UPDATE vehicles SET last_service_at = ?, last_service_km = odometer_km WHERE id = ?", now, vid);
  audit(req, "vehicle.serviced", { type: "vehicle", id: vid, details: { code: v.code, odometer_km: Math.round(v.odometer_km) } });
  F.addAlert({ vehicleId: vid, kind: "service", severity: "info", message: `${v.code} serviced at ${Math.round(v.odometer_km).toLocaleString("en-US")} km${note ? `: ${note}` : ""}` });
  F.notifyVehicle(vid);
  res.json(Stats.vehicleProfile(vid));
});

/* ---------- performance ---------- */
const dateParam = (q) => (/^\d{4}-\d{2}-\d{2}$/.test(q || "") ? q : localDate());
api.get("/team", staff, (req, res) => {
  const date = dateParam(req.query.date);
  res.json({ ...Stats.leaderboard(date), vehicles: Stats.allVehicleConditions() });
});
api.get("/drivers/:id/profile", staff, (req, res) => {
  const p = Stats.driverProfile(id(req.params.id), dateParam(req.query.date));
  if (!p) throw F.httpError(404, "Driver not found.");
  res.json(p);
});
api.get("/vehicles/:id/profile", staff, (req, res) => {
  const p = Stats.vehicleProfile(id(req.params.id), dateParam(req.query.date));
  if (!p) throw F.httpError(404, "Vehicle not found.");
  res.json(p);
});

/* ---------- drivers ---------- */
api.get("/drivers", staff, (req, res) => res.json(all(`SELECT u.id, u.name, u.username, u.phone, u.active,
  (SELECT v.code FROM shifts s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.driver_id = u.id AND s.ended_at IS NULL) AS on_shift_vehicle,
  (SELECT v.code FROM vehicles v WHERE v.default_driver_id = u.id ORDER BY v.id LIMIT 1) AS usual_vehicle
  FROM users u WHERE u.role = 'driver' AND u.approval = 'approved' ORDER BY u.name`)));
/** Makes `vehicleId` the driver's usual vehicle (shown first when they start a shift). */
function assignVehicle(driverId, vehicleId) {
  if (!vehicleId) return;
  if (!one("SELECT 1 FROM vehicles WHERE id = ?", vehicleId)) throw bad("That vehicle doesn't exist.");
  run("UPDATE vehicles SET default_driver_id = ? WHERE id = ?", driverId, vehicleId);
}
api.post("/drivers", admin, (req, res) => {
  const name = str(req.body.name, 80), username = str(req.body.username, 40).toLowerCase(), password = String(req.body.password || "");
  if (!name || !username) throw bad("Enter the driver's name and a username.");
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad("Usernames use 3–40 letters, numbers, dots, dashes or underscores.");
  const problem = passwordProblem(password, username);
  if (problem) throw bad(problem);
  if (one("SELECT 1 FROM users WHERE username = ?", username)) throw bad(`The username ${username} is taken.`);
  const r = run("INSERT INTO users (name, username, role, pass_hash, phone, license_no, created_at) VALUES (?,?,?,?,?,?,?)", name, username, "driver", hashPassword(password), str(req.body.phone, 30) || null, str(req.body.license_no, 40) || null, Date.now());
  assignVehicle(Number(r.lastInsertRowid), num(req.body.vehicle_id));
  audit(req, "user.created", { type: "user", id: Number(r.lastInsertRowid), details: { username, role: "driver" } });
  res.status(201).json(one("SELECT id, name, username, phone, active FROM users WHERE id = ?", r.lastInsertRowid));
});
api.patch("/drivers/:id", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ? AND role = 'driver'", uid);
  if (!u) throw F.httpError(404, "Driver not found.");
  if (req.body.password) {
    const problem = passwordProblem(String(req.body.password), u.username);
    if (problem) throw bad(problem);
    setPassword(uid, String(req.body.password));
    audit(req, "auth.password_reset", { type: "user", id: uid });
  }
  if (req.body.active !== undefined) {
    // Deactivating also ends every session.
    run("UPDATE users SET active = ?, token_version = token_version + ? WHERE id = ?", req.body.active ? 1 : 0, req.body.active ? 0 : 1, uid);
    audit(req, req.body.active ? "user.reactivated" : "user.deactivated", { type: "user", id: uid });
  }
  if (req.body.phone !== undefined) run("UPDATE users SET phone = ? WHERE id = ?", str(req.body.phone, 30) || null, uid);
  if (req.body.name) run("UPDATE users SET name = ? WHERE id = ?", str(req.body.name, 80), uid);
  if (req.body.vehicle_id !== undefined) assignVehicle(uid, num(req.body.vehicle_id));
  if (req.body.name || req.body.phone !== undefined || req.body.vehicle_id !== undefined)
    audit(req, "user.updated", { type: "user", id: uid, details: { fields: ["name", "phone", "vehicle_id"].filter((k) => req.body[k] !== undefined) } });
  res.json(one("SELECT id, name, username, phone, active FROM users WHERE id = ?", uid));
});

/** Everything Fleetline stores about one driver (right of access / portability). */
function driverExport(uid) {
  const user = one(`SELECT id, name, username, role, phone, license_no, signup_note, approval, active, created_at, privacy_ack_version, privacy_ack_at, erased_at
                    FROM users WHERE id = ? AND role = 'driver'`, uid);
  if (!user) return null;
  return {
    exported_at: new Date().toISOString(),
    user,
    shifts: all("SELECT id, vehicle_id, started_at, ended_at FROM shifts WHERE driver_id = ? ORDER BY started_at", uid),
    positions: all("SELECT vehicle_id, lat, lng, speed_kmh, heading, accuracy_m, recorded_at FROM positions WHERE driver_id = ? ORDER BY recorded_at", uid),
    inspections: all("SELECT vehicle_id, items, notes, created_at FROM inspections WHERE driver_id = ? ORDER BY created_at", uid),
    routes: all(`SELECT r.code, r.name, r.status, r.service_date, r.started_at, r.completed_at, v.code AS vehicle_code FROM routes r
                 LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.driver_id = ? ORDER BY r.started_at`, uid),
  };
}
api.get("/drivers/:id/export", admin, (req, res) => {
  const uid = id(req.params.id), data = driverExport(uid);
  if (!data) throw F.httpError(404, "Driver not found.");
  audit(req, "privacy.export", { type: "user", id: uid });
  res.set("Content-Disposition", `attachment; filename="fleetline-driver-${uid}.json"`).json(data);
});
api.post("/drivers/:id/erase", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ? AND role = 'driver'", uid);
  if (!u) throw F.httpError(404, "Driver not found.");
  if (u.erased_at) throw F.httpError(409, "This driver's personal data was already erased.");
  if (str(req.body?.confirm_username, 40).toLowerCase() !== u.username) throw bad(`Type the username ${u.username} to confirm.`);
  if (F.driverShift(uid)) throw F.httpError(409, "End this driver's shift before erasing their data.");
  const label = `Deleted driver #${uid}`;
  const removed = tx(() => {
    const pos = run("DELETE FROM positions WHERE driver_id = ?", uid).changes;
    run("UPDATE vehicles SET default_driver_id = NULL WHERE default_driver_id = ?", uid);
    run("UPDATE inspections SET notes = CASE WHEN notes IS NULL THEN NULL ELSE '[removed]' END WHERE driver_id = ?", uid);
    // Alert text can mention the driver by name or username.
    run("UPDATE alerts SET message = REPLACE(REPLACE(message, ?, ?), ?, ?) WHERE message LIKE ? OR message LIKE ?", u.name, label, `@${u.username}`, label, `%${u.name}%`, `%@${u.username}%`);
    // Business records (routes, deliveries, shifts) are kept but no longer identify the person.
    run(`UPDATE users SET name = ?, username = ?, phone = NULL, license_no = NULL, signup_note = NULL, pass_hash = ?, active = 0,
         mfa_secret = NULL, mfa_enabled = 0, token_version = token_version + 1, erased_at = ? WHERE id = ?`,
      label, `deleted-${uid}`, hashPassword(crypto.randomUUID()), Date.now(), uid);
    return pos;
  });
  audit(req, "privacy.erase", { type: "user", id: uid, details: { positions_deleted: removed } });
  res.json({ ok: true, positions_deleted: removed });
});

/* ---------- user accounts (admin) ---------- */
api.get("/users", admin, (req, res) => res.json(all(`SELECT id, name, username, role, active, approval, phone, license_no, signup_note, created_at
  FROM users ORDER BY role, name`)));
// Staff accounts (dispatchers and admins) are created by an admin, never by self sign-up.
api.post("/users", admin, (req, res) => {
  const name = str(req.body?.name, 80), username = str(req.body?.username, 40).toLowerCase(), password = String(req.body?.password || "");
  const role = req.body?.role;
  if (!["dispatcher", "admin"].includes(role)) throw bad("Choose dispatcher or admin. Drivers are added under Drivers.");
  if (!name) throw bad("Enter the person's name.");
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad("Usernames use 3–40 letters, numbers, dots, dashes or underscores.");
  const problem = passwordProblem(password, username);
  if (problem) throw bad(problem);
  if (one("SELECT 1 FROM users WHERE username = ?", username)) throw bad(`The username ${username} is taken.`);
  const r = run("INSERT INTO users (name, username, role, pass_hash, created_at) VALUES (?,?,?,?,?)", name, username, role, hashPassword(password), Date.now());
  audit(req, "user.created", { type: "user", id: Number(r.lastInsertRowid), details: { username, role } });
  res.status(201).json(one("SELECT id, name, username, role, active, approval FROM users WHERE id = ?", r.lastInsertRowid));
});
api.patch("/users/:id", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ? AND role != 'driver'", uid);
  if (!u) throw F.httpError(404, "Staff account not found. Drivers are managed under Drivers.");
  if (uid === req.user.id && req.body?.active === false) throw bad("You can't deactivate your own account.");
  if (req.body?.active !== undefined) {
    run("UPDATE users SET active = ?, token_version = token_version + ? WHERE id = ?", req.body.active ? 1 : 0, req.body.active ? 0 : 1, uid);
    audit(req, req.body.active ? "user.reactivated" : "user.deactivated", { type: "user", id: uid });
  }
  res.json(one("SELECT id, name, username, role, active FROM users WHERE id = ?", uid));
});
api.post("/users/:id/approve", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ? AND approval != 'approved'", uid);
  if (!u) throw F.httpError(404, "That sign-up was already handled.");
  assignVehicle(uid, num(req.body?.vehicle_id));
  run("UPDATE users SET approval = 'approved' WHERE id = ?", uid);
  audit(req, "user.approved", { type: "user", id: uid, details: { vehicle_id: num(req.body?.vehicle_id) } });
  const v = one("SELECT code FROM vehicles WHERE default_driver_id = ? ORDER BY id LIMIT 1", uid);
  F.addAlert({ kind: "signup", severity: "info", message: `${u.name} (@${u.username}) approved${v ? ` and assigned ${v.code}` : ""}` });
  res.json({ ok: true });
});
api.post("/users/:id/decline", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ? AND approval = 'pending'", uid);
  if (!u) throw F.httpError(404, "That sign-up was already handled.");
  run("UPDATE users SET approval = 'declined', token_version = token_version + 1 WHERE id = ?", uid);
  audit(req, "user.declined", { type: "user", id: uid });
  res.json({ ok: true });
});
api.post("/users/:id/password", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ?", uid);
  if (!u) throw F.httpError(404, "User not found.");
  const password = String(req.body?.new_password || "");
  const problem = passwordProblem(password, u.username);
  if (problem) throw bad(problem);
  const token = setPassword(uid, password);
  audit(req, "auth.password_reset", { type: "user", id: uid });
  // Admins resetting their own password stay signed in on this device.
  res.json(uid === req.user.id ? { ok: true, token } : { ok: true });
});

// Lost phone: an admin clears a staff member's authenticator so they can set it up again at next sign-in.
api.post("/users/:id/mfa-reset", admin, (req, res) => {
  const uid = id(req.params.id), u = one("SELECT * FROM users WHERE id = ?", uid);
  if (!u) throw F.httpError(404, "User not found.");
  if (uid === req.user.id) throw bad("Another admin has to reset your two-step sign-in.");
  run("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_last_step = NULL, token_version = token_version + 1 WHERE id = ?", uid);
  audit(req, "auth.mfa_reset", { type: "user", id: uid });
  res.json({ ok: true });
});
api.get("/audit", admin, (req, res) => res.json(auditEntries({ limit: Number(req.query.limit) || 100, before: Number(req.query.before) || null, action: str(req.query.action, 40) || null })));

/* ---------- places ---------- */
api.get("/places", staff, (req, res) => res.json(all("SELECT * FROM places ORDER BY name")));
api.post("/places", staff, (req, res) => {
  const name = str(req.body.name, 80), lat = num(req.body.lat), lng = num(req.body.lng);
  if (!name) throw bad("Give the place a name.");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad("Pick the place's location on the map.");
  const r = run("INSERT INTO places (name, address, lat, lng, dwell_min, created_at) VALUES (?,?,?,?,?,?)", name, str(req.body.address, 160) || null, lat, lng, Math.max(1, num(req.body.dwell_min) || 8), Date.now());
  audit(req, "place.created", { type: "place", id: Number(r.lastInsertRowid), details: { name } });
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
  audit(req, "place.deleted", { type: "place", id: pid });
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
function checkStops(placeIds) {
  if (!Array.isArray(placeIds)) throw bad("Stops must be a list of places.");
  const ids = placeIds.map(Number);
  if (new Set(ids).size !== ids.length) throw bad("A place can only appear once on a route.");
  for (const p of ids) if (!one("SELECT 1 FROM places WHERE id = ?", p)) throw bad("One of the stops no longer exists.");
  return ids;
}
/** Replaces a route's stops. Call inside a transaction. */
function writeStops(routeId, ids) {
  run("DELETE FROM route_stops WHERE route_id = ?", routeId);
  ids.forEach((p, i) => run("INSERT INTO route_stops (route_id, seq, place_id) VALUES (?,?,?)", routeId, i + 1, p));
}
const setStops = (routeId, placeIds) => { const ids = checkStops(placeIds); tx(() => writeStops(routeId, ids)); };
api.post("/routes", staff, h(async (req, res) => {
  const name = str(req.body.name, 80) || "Ad-hoc route";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.service_date || "") ? req.body.service_date : localDate();
  // Validate first, then create the route and its stops together so a bad request leaves nothing behind.
  const stopIds = checkStops(req.body.place_ids || []);
  const rid = tx(() => {
    const last = one("SELECT MAX(CAST(SUBSTR(code, 3) AS INTEGER)) n FROM routes").n || 1000;
    const r = run("INSERT INTO routes (code, name, depot_id, service_date, created_by, created_at) VALUES (?,?,?,?,?,?)",
      `R-${last + 1}`, name, num(req.body.depot_id), date, req.user.id, Date.now());
    writeStops(Number(r.lastInsertRowid), stopIds);
    return Number(r.lastInsertRowid);
  });
  audit(req, "route.created", { type: "route", id: rid, details: { stops: stopIds.length, dispatch_to: num(req.body.vehicle_id) } });
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
  audit(req, "route.dispatched", { type: "route", id: rid, details: { code: r.code, vehicle_id: vid } });
  res.json(F.routeWithStops(rid));
}));
api.post("/routes/:id/cancel", staff, (req, res) => {
  const rid = id(req.params.id);
  F.cancelRoute(rid);
  audit(req, "route.cancelled", { type: "route", id: rid });
  res.json(F.routeWithStops(rid));
});
api.delete("/routes/:id", staff, (req, res) => {
  const rid = id(req.params.id), r = one("SELECT status FROM routes WHERE id = ?", rid);
  if (r?.status !== "draft") throw F.httpError(409, "Only draft routes can be deleted. Cancel dispatched routes instead.");
  run("DELETE FROM routes WHERE id = ?", rid);
  audit(req, "route.deleted", { type: "route", id: rid });
  res.status(204).end();
});

/* ---------- alerts & analytics ---------- */
api.get("/alerts", staff, (req, res) => res.json(all(`SELECT a.*, v.code AS vehicle_code FROM alerts a LEFT JOIN vehicles v ON v.id = a.vehicle_id
  WHERE a.created_at > ? ORDER BY a.id DESC LIMIT 300`, Date.now() - 36 * 3600e3)));
api.post("/alerts/:id/ack", staff, (req, res) => { run("UPDATE alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL", Date.now(), req.user.id, id(req.params.id)); res.json({ ok: true }); });
api.post("/alerts/ack-all", staff, (req, res) => {
  const n = run("UPDATE alerts SET acked_at = ?, acked_by = ? WHERE acked_at IS NULL", Date.now(), req.user.id).changes;
  audit(req, "alerts.ack_all", { details: { count: n } });
  res.json({ ok: true });
});
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
  const inspected = shift ? !!one("SELECT 1 FROM inspections WHERE shift_id = ?", shift.id) : false;
  return { user, privacy: { ...privacyStatus(user.id), notice: PRIVACY_NOTICE }, shift: shift ?? null, vehicle, vehicles, inspection_done: inspected, inspection_items: Stats.INSPECTION_ITEMS, route: route ? F.routeWithStops(route.id) : null, finished: finished ? F.routeWithStops(finished.id) : null, config: { geofenceM: F.CFG.geofenceM } };
}
api.get("/driver/state", driverOnly, (req, res) => res.json(driverState(req.user)));
api.post("/driver/privacy-ack", driverOnly, (req, res) => {
  if (req.body?.version !== PRIVACY_NOTICE.version) throw F.httpError(409, "The notice has changed. Read the latest version and accept it.");
  run("UPDATE users SET privacy_ack_version = ?, privacy_ack_at = ? WHERE id = ?", PRIVACY_NOTICE.version, Date.now(), req.user.id);
  audit(req, "privacy.notice_accepted", { type: "user", id: req.user.id, details: { version: PRIVACY_NOTICE.version } });
  res.json(driverState(req.user));
});
// A driver's own copy of their data (right of access).
api.get("/driver/my-data", driverOnly, (req, res) => {
  audit(req, "privacy.self_export", { type: "user", id: req.user.id });
  res.set("Content-Disposition", `attachment; filename="fleetline-my-data.json"`).json(driverExport(req.user.id));
});
api.get("/driver/profile", driverOnly, (req, res) => res.json(Stats.driverProfile(req.user.id, dateParam(req.query.date))));
api.post("/driver/inspection", driverOnly, (req, res) => {
  const s = F.driverShift(req.user.id);
  if (!s) throw F.httpError(409, "Start a shift before doing the pre-trip check.");
  const items = {};
  for (const [k] of Stats.INSPECTION_ITEMS) {
    const val = req.body?.items?.[k];
    if (!["ok", "issue"].includes(val)) throw bad("Mark every item as OK or Problem.");
    items[k] = val;
  }
  const issues = Stats.INSPECTION_ITEMS.filter(([k]) => items[k] === "issue").map(([, l]) => l);
  const notes = str(req.body?.notes, 500) || null;
  if (issues.length && !notes) throw bad("Describe the problem so the workshop knows what to fix.");
  run("INSERT INTO inspections (vehicle_id, driver_id, shift_id, items, issues, notes, created_at) VALUES (?,?,?,?,?,?,?)",
    s.vehicle_id, req.user.id, s.id, JSON.stringify(items), issues.length, notes, Date.now());
  const v = one("SELECT code FROM vehicles WHERE id = ?", s.vehicle_id);
  if (issues.length) F.addAlert({ vehicleId: s.vehicle_id, kind: "inspection", severity: "warn", message: `${v.code} pre-trip check: problem with ${issues.join(", ")}. "${notes}"` });
  F.notifyVehicle(s.vehicle_id);
  res.json(driverState(req.user));
});
api.post("/driver/shift/start", driverOnly, (req, res) => {
  if (F.driverShift(req.user.id)) return res.json(driverState(req.user));
  // Location is only collected after the driver has seen and accepted the current notice.
  if (privacyStatus(req.user.id).required) throw Object.assign(F.httpError(409, "Read and accept the location notice before starting a shift."), { code: "privacy_ack_required" });
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
  // Malformed JSON bodies come from express.json() with a 400 status.
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request body isn't valid JSON." });
  if (!err.status) console.error(JSON.stringify({ level: "error", rid: req.id, method: req.method, path: req.path, error: err.message, stack: err.stack }));
  res.status(err.status || 500).json({
    error: err.status ? err.message : `Something went wrong on the server. Try again. (Reference: ${req.id})`,
    ...(err.code && err.status ? { code: err.code } : {}),
  });
});
