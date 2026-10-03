// End-to-end API test: seeds a throwaway database, starts the real server and walks a full
// dispatch → driver shift → GPS → geofence arrival → delivery → analytics cycle.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetline-test-"));
const PORT = 4400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), ROUTING_URL: "", JWT_SECRET: "test-secret" };
const nodeArgs = ["--disable-warning=ExperimentalWarning"];
let server;

async function call(method, url, token, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}
const login = async (username, password, app) => (await call("POST", "/api/auth/login", null, { username, password, app })).data.token;

before(async () => {
  const seed = spawnSync(process.execPath, [...nodeArgs, "server/seed.js"], { cwd: root, env, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  server = spawn(process.execPath, [...nodeArgs, "server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 15000);
    server.stdout.on("data", (d) => { if (String(d).includes("Fleetline running")) { clearTimeout(t); resolve(); } });
    server.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
});
after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill();
    await exited;
  }
  // Windows can hold the SQLite file briefly after the process exits.
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("rejects bad credentials and wrong roles", async () => {
  assert.equal((await call("POST", "/api/auth/login", null, { username: "dispatch", password: "nope" })).status, 401);
  const driver = await login("tom", "driver123", "driver");
  assert.equal((await call("GET", "/api/fleet", driver)).status, 403);
  assert.equal((await call("POST", "/api/auth/login", null, { username: "tom", password: "driver123", app: "dispatch" })).status, 403);
  assert.equal((await call("GET", "/api/fleet")).status, 401);
});

test("full delivery cycle with GPS geofencing", async () => {
  const staff = await login("dispatch", "dispatch123", "dispatch");
  const driver = await login("tom", "driver123", "driver");

  const fleet = (await call("GET", "/api/fleet", staff)).data;
  assert.equal(fleet.length, 8);
  const truck = fleet.find((v) => v.code === "TRK-104");
  assert.equal(truck.status, "off");

  // Driver starts a shift in their usual vehicle.
  let st = (await call("GET", "/api/driver/state", driver)).data;
  assert.equal(st.shift, null);
  assert.ok(st.vehicles.find((v) => v.id === truck.id && v.mine));
  st = (await call("POST", "/api/driver/shift/start", driver, { vehicle_id: truck.id })).data;
  assert.equal(st.vehicle.code, "TRK-104");

  // Dispatcher creates and dispatches a two-stop route.
  const places = (await call("GET", "/api/places", staff)).data;
  const [a, b] = places;
  const created = await call("POST", "/api/routes", staff, { name: "Test run", place_ids: [a.id, b.id], vehicle_id: truck.id });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "dispatched");
  assert.ok(created.data.stops.every((s) => s.planned_at > Date.now()));

  // A fix far away: route summary comes back for background clients.
  const t0 = Date.now() - 60e3;
  let pos = await call("POST", "/api/driver/positions", driver, { points: [{ lat: a.lat + 0.05, lng: a.lng, speed: 30, accuracy: 10, t: t0 }] });
  assert.equal(pos.data.accepted, 1);
  assert.equal(pos.data.route.status, "dispatched");
  assert.equal(pos.data.route.stops, 2);

  // Arriving inside the geofence starts the route and marks stop 1 arrived.
  pos = await call("POST", "/api/driver/positions", driver, { points: [{ lat: a.lat + 0.0003, lng: a.lng, speed: 5, accuracy: 8, t: t0 + 30e3 }] });
  assert.equal(pos.data.route.status, "active");
  st = (await call("GET", "/api/driver/state", driver)).data;
  assert.equal(st.route.stops[0].status, "arrived");

  // Deliver stop 1 with a note, skip stop 2: the route completes.
  st = (await call("POST", `/api/driver/stops/${st.route.stops[0].id}/complete`, driver, { note: "Signed by test" })).data;
  assert.equal(st.route.stops[0].status, "completed");
  assert.equal(st.route.stops[0].note, "Signed by test");
  st = (await call("POST", `/api/driver/stops/${st.route.stops[1].id}/skip`, driver, { reason: "Customer closed" })).data;
  assert.equal(st.route, null);
  assert.equal(st.finished.status, "completed");

  // Two fixes over the speed limit raise a speeding alert.
  const now = Date.now();
  await call("POST", "/api/driver/positions", driver, { points: [
    { lat: a.lat + 0.01, lng: a.lng, speed: 130, accuracy: 10, t: now - 4000 },
    { lat: a.lat + 0.012, lng: a.lng, speed: 132, accuracy: 10, t: now - 2000 },
  ] });
  const alerts = (await call("GET", "/api/alerts", staff)).data;
  assert.ok(alerts.some((x) => x.kind === "speeding" && x.vehicle_id === truck.id));
  assert.ok(alerts.some((x) => x.kind === "stop_skipped"));

  const an = (await call("GET", "/api/analytics", staff)).data;
  const row = an.vehicles.find((v) => v.code === "TRK-104");
  assert.equal(row.delivered, 1);
  assert.equal(row.skipped, 1);
  assert.ok(row.km > 1);

  // Ending the shift stops further uploads.
  await call("POST", "/api/driver/shift/end", driver);
  assert.equal((await call("POST", "/api/driver/positions", driver, { points: [{ lat: a.lat, lng: a.lng, t: Date.now() }] })).status, 409);
});

test("password changes sign out other sessions; admins can reset passwords", async () => {
  // A driver changes their own password.
  const oldToken = await login("kasia", "driver123", "driver");
  const otherDevice = await login("kasia", "driver123", "driver");
  assert.equal((await call("POST", "/api/me/password", oldToken, { current_password: "wrong-pass", new_password: "new-pass-123" })).status, 400);
  assert.equal((await call("POST", "/api/me/password", oldToken, { current_password: "driver123", new_password: "short" })).status, 400);
  assert.equal((await call("POST", "/api/me/password", oldToken, { current_password: "driver123", new_password: "driver123" })).status, 400);
  const changed = await call("POST", "/api/me/password", oldToken, { current_password: "driver123", new_password: "new-pass-123" });
  assert.equal(changed.status, 200);
  assert.ok(changed.data.token);

  // Old sessions stop working; the returned token and the new password work.
  assert.equal((await call("GET", "/api/driver/state", otherDevice)).status, 401);
  assert.equal((await call("GET", "/api/driver/state", oldToken)).status, 401);
  assert.equal((await call("GET", "/api/driver/state", changed.data.token)).status, 200);
  assert.equal((await call("POST", "/api/auth/login", null, { username: "kasia", password: "driver123" })).status, 401);
  const fresh = await login("kasia", "new-pass-123", "driver");
  assert.ok(fresh);

  // An admin resets it; the driver's sessions end. Dispatchers can't reset passwords.
  const admin = await login("admin", "dispatch123", "dispatch");
  const dispatcher = await login("dispatch", "dispatch123", "dispatch");
  const users = (await call("GET", "/api/users", admin)).data;
  const kasia = users.find((u) => u.username === "kasia");
  assert.equal((await call("POST", `/api/users/${kasia.id}/password`, dispatcher, { new_password: "reset-pass-1" })).status, 403);
  assert.equal((await call("POST", `/api/users/${kasia.id}/password`, admin, { new_password: "reset-pass-1" })).status, 200);
  assert.equal((await call("GET", "/api/driver/state", fresh)).status, 401);
  assert.ok(await login("kasia", "reset-pass-1", "driver"));
});

test("driver sign-up needs admin approval and gets a vehicle", async () => {
  const signup = { name: "Ola Bello", phone: "+1 555 0199", username: "ola", password: "ola-pass-2026", license_no: "D1234567", vehicle_type: "van" };
  assert.equal((await call("POST", "/api/auth/register", null, { ...signup, password: "short" })).status, 400);
  assert.equal((await call("POST", "/api/auth/register", null, { ...signup, username: "tom" })).status, 400);
  assert.equal((await call("POST", "/api/auth/register", null, signup)).status, 201);
  const pending = await call("POST", "/api/auth/login", null, { username: "ola", password: "ola-pass-2026", app: "driver" });
  assert.equal(pending.status, 403);
  assert.match(pending.data.error, /waiting for approval/);

  const admin = await login("admin", "dispatch123", "dispatch");
  const users = (await call("GET", "/api/users", admin)).data;
  const ola = users.find((u) => u.username === "ola");
  assert.equal(ola.approval, "pending");
  assert.ok((await call("GET", "/api/alerts", admin)).data.some((a) => a.kind === "signup"));
  const van = (await call("GET", "/api/fleet", admin)).data.find((v) => v.code === "VAN-203");
  assert.equal((await call("POST", `/api/users/${ola.id}/approve`, admin, { vehicle_id: van.id })).status, 200);

  const token = await login("ola", "ola-pass-2026", "driver");
  const st = (await call("GET", "/api/driver/state", token)).data;
  assert.ok(st.vehicles.find((v) => v.code === "VAN-203" && v.mine));
});

test("pre-trip checks, driver profile, team leaderboard and vehicle service", async () => {
  const admin = await login("admin", "dispatch123", "dispatch");
  const driver = await login("luis", "driver123", "driver");
  const truck = (await call("GET", "/api/fleet", admin)).data.find((v) => v.code === "TRK-102");
  let st = (await call("POST", "/api/driver/shift/start", driver, { vehicle_id: truck.id })).data;
  assert.equal(st.inspection_done, false);

  const items = Object.fromEntries(st.inspection_items.map(([k]) => [k, "ok"]));
  assert.equal((await call("POST", "/api/driver/inspection", driver, { items: { ...items, lights: "issue" } })).status, 400); // problem needs a note
  st = (await call("POST", "/api/driver/inspection", driver, { items: { ...items, lights: "issue" }, notes: "Left indicator out" })).data;
  assert.equal(st.inspection_done, true);

  const now = Date.now();
  await call("POST", "/api/driver/positions", driver, { points: [
    { lat: 29.70, lng: -95.40, speed: 40, accuracy: 10, t: now - 60e3 },
    { lat: 29.71, lng: -95.40, speed: 40, accuracy: 10, t: now - 30e3 },
  ] });

  const me = (await call("GET", "/api/driver/profile", driver)).data;
  assert.equal(me.driver.username, "luis");
  assert.ok(me.week && me.daily.length === 14);
  assert.ok(me.rank && me.rank.position >= 1 && me.rank.of >= 1);
  assert.equal(me.vehicle.code, "TRK-102");
  assert.equal(me.vehicle.status, "attention");
  assert.ok(me.vehicle.reasons.some((r) => r.includes("Lights")));

  const team = (await call("GET", "/api/team", admin)).data;
  assert.ok(team.drivers.find((d) => d.username === "luis"));
  assert.equal(team.vehicles.length >= 8, true);
  assert.equal((await call("GET", `/api/drivers/${me.driver.id}/profile`, admin)).data.driver.username, "luis");
  assert.equal((await call("GET", `/api/drivers/${me.driver.id}/profile`, driver)).status, 403);

  const odoBefore = (await call("GET", `/api/vehicles/${truck.id}/profile`, admin)).data.vehicle.odometer_km;
  const serviced = (await call("POST", `/api/vehicles/${truck.id}/service`, admin, { note: "Indicator bulb replaced" })).data;
  assert.equal(serviced.vehicle.status, "good");
  assert.equal(serviced.vehicle.next_service_km, serviced.vehicle.service_interval_km);
  assert.ok(serviced.vehicle.odometer_km >= odoBefore);
  assert.equal(serviced.services[0].note, "Indicator bulb replaced");
  await call("POST", "/api/driver/shift/end", driver);
});
