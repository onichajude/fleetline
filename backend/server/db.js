import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.DATA_DIR || path.join(root, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "fleetline.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','dispatcher','driver')),
  pass_hash TEXT NOT NULL,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS depots (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  plate TEXT,
  depot_id INTEGER REFERENCES depots(id),
  default_driver_id INTEGER REFERENCES users(id),
  maintenance INTEGER NOT NULL DEFAULT 0,
  speed_limit_kmh INTEGER NOT NULL DEFAULT 90,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  dwell_min INTEGER NOT NULL DEFAULT 8,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  vehicle_id INTEGER REFERENCES vehicles(id),
  depot_id INTEGER REFERENCES depots(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','dispatched','active','completed','cancelled')),
  service_date TEXT NOT NULL,
  dispatched_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  geometry TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS route_stops (
  id INTEGER PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  place_id INTEGER NOT NULL REFERENCES places(id),
  planned_at INTEGER,
  arrived_at INTEGER,
  completed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','arrived','completed','skipped')),
  note TEXT,
  late_alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  shift_id INTEGER REFERENCES shifts(id),
  driver_id INTEGER REFERENCES users(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  speed_kmh REAL,
  heading REAL,
  accuracy_m REAL,
  recorded_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_vehicle_time ON positions(vehicle_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id, seq);
CREATE INDEX IF NOT EXISTS idx_routes_date ON routes(service_date);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER REFERENCES vehicles(id),
  route_id INTEGER REFERENCES routes(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','crit')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  acked_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(created_at);
`);

// Migrations for databases created by earlier versions.
const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const addColumn = (table, name, def) => { if (!cols(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`); };
// Bumped on every password change so tokens issued before it stop working.
addColumn("users", "token_version", "INTEGER NOT NULL DEFAULT 0");
// Self sign-ups start as 'pending' until an admin approves them.
addColumn("users", "approval", "TEXT NOT NULL DEFAULT 'approved'");
addColumn("users", "license_no", "TEXT");
addColumn("users", "signup_note", "TEXT");
// Odometer grows with GPS distance; service due = last_service_km + service_interval_km.
addColumn("vehicles", "odometer_km", "REAL NOT NULL DEFAULT 0");
addColumn("vehicles", "last_service_km", "REAL NOT NULL DEFAULT 0");
addColumn("vehicles", "last_service_at", "INTEGER");
addColumn("vehicles", "service_interval_km", "INTEGER NOT NULL DEFAULT 10000");
// The driver who ran a route (set when it starts), for per-driver stats.
addColumn("routes", "driver_id", "INTEGER REFERENCES users(id)");
db.exec(`
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  driver_id INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  items TEXT NOT NULL,
  issues INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inspections_vehicle ON inspections(vehicle_id, created_at);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  user_id INTEGER REFERENCES users(id),
  odometer_km REAL NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routes_driver ON routes(driver_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_positions_driver_time ON positions(driver_id, recorded_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id INTEGER,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  ip TEXT,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`);
// Authenticator-app sign-in for staff; mfa_last_step blocks reuse of a code.
addColumn("users", "mfa_secret", "TEXT");
addColumn("users", "mfa_enabled", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "mfa_last_step", "INTEGER");
// Which version of the driver privacy notice was accepted, and when.
addColumn("users", "privacy_ack_version", "TEXT");
addColumn("users", "privacy_ack_at", "INTEGER");
// Set when a driver's personal data has been erased.
addColumn("users", "erased_at", "INTEGER");
// A re-sent GPS batch (e.g. after a lost response) must not create duplicate fixes.
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'uq_positions_vehicle_time'").get()) {
  db.exec(`DELETE FROM positions WHERE id NOT IN (SELECT MIN(id) FROM positions GROUP BY vehicle_id, recorded_at);
           CREATE UNIQUE INDEX uq_positions_vehicle_time ON positions(vehicle_id, recorded_at);`);
}

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Local calendar date (server time zone) as YYYY-MM-DD. */
export function localDate(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dayBounds(date) {
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return [start, new Date(y, m - 1, d + 1).getTime()];
}
