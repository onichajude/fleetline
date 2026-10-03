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
