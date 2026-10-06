// Security, privacy and resilience controls, with staff two-step sign-in enforced (the production default).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let srv, call, login, driverLogin;
// History older than 14 days is seeded, so the start-up retention purge has something to remove.
before(async () => { srv = await startServer({ POSITION_RETENTION_DAYS: "14" }); ({ call, login, driverLogin } = srv); });
after(async () => { await srv?.stop(); });

// Independent TOTP implementation (RFC 6238) so the test doesn't trust the server's own code.
function totp(secret, step) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", key).update(msg).digest(), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
const step = () => Math.floor(Date.now() / 30e3);
let adminToken, adminSecret;

test("health check, security headers and JSON errors", async () => {
  const h = await call("GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.data.db, "ok");
  assert.match(h.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(h.headers.get("x-content-type-options"), "nosniff");
  assert.ok(h.headers.get("x-request-id"));
  assert.equal(h.headers.get("cache-control"), "no-store");
  const bad = await call("POST", "/api/auth/login", null, "{not json");
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /valid JSON/);
});

test("staff must set up two-step sign-in; codes can't be reused", async () => {
  const first = await call("POST", "/api/auth/login", null, { username: "admin", password: "dispatch123", app: "dispatch" });
  assert.equal(first.status, 200);
  assert.equal(first.data.mfa_setup_required, true);
  const pre = first.data.token;
  const blocked = await call("GET", "/api/fleet", pre);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, "mfa_setup_required");
  assert.equal((await call("GET", "/api/me", pre)).status, 200);

  adminSecret = (await call("POST", "/api/me/mfa/setup", pre)).data.secret;
  assert.equal((await call("POST", "/api/me/mfa/enable", pre, { code: "000000" })).status, 400);
  const enabled = await call("POST", "/api/me/mfa/enable", pre, { code: totp(adminSecret, step()) });
  assert.equal(enabled.status, 200);
  assert.equal((await call("GET", "/api/fleet", pre)).status, 401, "sessions opened before MFA are signed out");
  adminToken = enabled.data.token;
  assert.equal((await call("GET", "/api/fleet", adminToken)).status, 200);

  const noCode = await call("POST", "/api/auth/login", null, { username: "admin", password: "dispatch123" });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.mfa_required, true);
  assert.equal((await call("POST", "/api/auth/login", null, { username: "admin", password: "dispatch123", code: "123456" })).status, 401);
  // The code used to enable MFA can't be replayed; the next one works.
  assert.equal((await call("POST", "/api/auth/login", null, { username: "admin", password: "dispatch123", code: totp(adminSecret, step()) })).status, 401);
  const ok = await call("POST", "/api/auth/login", null, { username: "admin", password: "dispatch123", code: totp(adminSecret, step() + 1) });
  assert.equal(ok.status, 200);
  adminToken = ok.data.token;

  // Staff can't switch MFA off while it's required; only drivers' sockets/APIs work without it.
  assert.equal((await call("POST", "/api/me/mfa/disable", adminToken, { password: "dispatch123", code: "000000" })).status, 403);
  const dispatcher = await login("dispatch", "dispatch123", "dispatch");
  assert.equal((await call("GET", "/api/audit", dispatcher)).status, 403);
});

test("audit log records sign-ins, failures and admin actions", async () => {
  assert.equal((await call("POST", "/api/auth/login", null, { username: "dispatch", password: "wrong-password" })).status, 401);
  const entries = (await call("GET", "/api/audit?limit=200", adminToken)).data;
  const actions = new Set(entries.map((e) => e.action));
  for (const a of ["auth.login", "auth.login_failed", "auth.mfa_enabled", "auth.mfa_failed"]) assert.ok(actions.has(a), `missing ${a}`);
  assert.ok(entries.every((e) => !JSON.stringify(e).includes("dispatch123")), "no passwords in the audit log");
  const dispatchUser = (await call("GET", "/api/users", adminToken)).data.find((u) => u.username === "dispatch");
  assert.equal((await call("POST", `/api/users/${dispatchUser.id}/mfa-reset`, adminToken)).status, 200);
  assert.ok((await call("GET", "/api/audit?action=auth.mfa_reset", adminToken)).data.length >= 1);
});

test("drivers must accept the privacy notice before any location is collected", async () => {
  const t = await login("andre", "driver123", "driver");
  const st = (await call("GET", "/api/driver/state", t)).data;
  assert.equal(st.privacy.required, true);
  assert.ok(st.privacy.notice.points.length >= 3);
  const van = st.vehicles.find((v) => v.mine);
  const refused = await call("POST", "/api/driver/shift/start", t, { vehicle_id: van.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, "privacy_ack_required");
  assert.equal((await call("POST", "/api/driver/positions", t, { points: [{ lat: 29.7, lng: -95.3, t: Date.now() }] })).status, 409);
  assert.equal((await call("POST", "/api/driver/privacy-ack", t, { version: "old" })).status, 409);
  assert.equal((await call("POST", "/api/driver/privacy-ack", t, { version: st.privacy.notice.version })).status, 200);
  assert.equal((await call("POST", "/api/driver/shift/start", t, { vehicle_id: van.id })).status, 200);
  await call("POST", "/api/driver/shift/end", t);
});

test("re-sent GPS batches don't create duplicates or extra distance", async () => {
  const t = await driverLogin("tom");
  const truck = (await call("GET", "/api/driver/state", t)).data.vehicles.find((v) => v.mine);
  await call("POST", "/api/driver/shift/start", t, { vehicle_id: truck.id });
  const now = Date.now();
  const batch = { points: [{ lat: 29.70, lng: -95.40, accuracy: 10, t: now - 20e3 }, { lat: 29.71, lng: -95.40, accuracy: 10, t: now - 10e3 }] };
  assert.equal((await call("POST", "/api/driver/positions", t, batch)).data.accepted, 2);
  const odo1 = (await call("GET", `/api/vehicles/${truck.id}/profile`, adminToken)).data.vehicle.odometer_km;
  assert.equal((await call("POST", "/api/driver/positions", t, batch)).data.accepted, 0);
  const odo2 = (await call("GET", `/api/vehicles/${truck.id}/profile`, adminToken)).data.vehicle.odometer_km;
  assert.equal(odo2, odo1);
});

test("a driver can't act on another vehicle's stops", async () => {
  const t = await driverLogin("tom");
  const routes = (await call("GET", "/api/routes", adminToken)).data;
  const other = routes.find((r) => r.vehicle_code === "TRK-101");
  for (const action of ["arrive", "complete", "skip"]) {
    assert.equal((await call("POST", `/api/driver/stops/${other.stops[0].id}/${action}`, t, {})).status, 404);
  }
  assert.equal((await call("POST", `/api/driver/route/${other.id}/start`, t)).status, 404);
  assert.equal((await call("GET", "/api/drivers/1/export", t)).status, 403);
});

test("creating a route with a bad stop leaves nothing behind", async () => {
  const before = (await call("GET", "/api/routes", adminToken)).data.length;
  assert.equal((await call("POST", "/api/routes", adminToken, { name: "Bad", place_ids: [1, 999999] })).status, 400);
  assert.equal((await call("GET", "/api/routes", adminToken)).data.length, before);
});

test("start-up retention removes location history past its retention period", async () => {
  const purge = (await call("GET", "/api/audit?action=system.retention_purge", adminToken)).data;
  assert.ok(purge.length >= 1 && purge[0].details.positions > 0);
  const dana = (await call("GET", "/api/drivers", adminToken)).data.find((d) => d.username === "dana");
  const data = (await call("GET", `/api/drivers/${dana.id}/export`, adminToken)).data;
  assert.ok(data.positions.length > 0);
  assert.ok(data.positions.every((p) => p.recorded_at >= Date.now() - 14.1 * 864e5));
});

test("drivers get their own data; admins can export and erase a driver", async () => {
  const t = await driverLogin("tom");
  const mine = await call("GET", "/api/driver/my-data", t);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.user.username, "tom");
  assert.ok(mine.data.positions.length >= 2);
  assert.ok(!("pass_hash" in mine.data.user));

  const tom = (await call("GET", "/api/drivers", adminToken)).data.find((d) => d.username === "tom");
  assert.equal((await call("POST", `/api/drivers/${tom.id}/erase`, adminToken, { confirm_username: "tom" })).status, 409, "on shift");
  await call("POST", "/api/driver/shift/end", t);
  assert.equal((await call("POST", `/api/drivers/${tom.id}/erase`, adminToken, { confirm_username: "wrong" })).status, 400);
  const erased = await call("POST", `/api/drivers/${tom.id}/erase`, adminToken, { confirm_username: "tom" });
  assert.equal(erased.status, 200);
  assert.ok(erased.data.positions_deleted > 0);
  assert.equal((await call("GET", "/api/driver/state", t)).status, 401, "sessions end");
  assert.equal((await call("POST", "/api/auth/login", null, { username: "tom", password: "driver123" })).status, 401);
  const after = (await call("GET", `/api/drivers/${tom.id}/export`, adminToken)).data;
  assert.equal(after.user.username, `deleted-${tom.id}`);
  assert.equal(after.user.phone, null);
  assert.equal(after.positions.length, 0);
  const alerts = (await call("GET", "/api/alerts", adminToken)).data;
  assert.ok(alerts.every((a) => !a.message.includes("Tom Reyes")));
  assert.ok((await call("GET", "/api/audit?action=privacy.", adminToken)).data.some((e) => e.action === "privacy.erase"));
});

test("backups are consistent and verifiable", async () => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/backup.js"], { cwd: root, env: srv.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK - this backup can be restored/);
  const dir = path.join(srv.dataDir, "backups");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
  assert.equal(files.length, 1);
  const check = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/backup.js", "--verify", path.join(dir, files[0])], { cwd: root, env: srv.env, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("admins create and deactivate staff accounts; staff can't self-register", async () => {
  const created = await call("POST", "/api/users", adminToken, { name: "Second Admin", username: "admin2", password: "admin2-pass-2026", role: "admin" });
  assert.equal(created.status, 201);
  assert.equal((await call("POST", "/api/users", adminToken, { name: "X", username: "x-driver", password: "xdriver-pass", role: "driver" })).status, 400);
  const fresh = await call("POST", "/api/auth/login", null, { username: "admin2", password: "admin2-pass-2026", app: "dispatch" });
  assert.equal(fresh.data.mfa_setup_required, true, "new staff must set up two-step sign-in");
  assert.equal((await call("PATCH", `/api/users/${created.data.id}`, adminToken, { active: false })).status, 200);
  assert.equal((await call("GET", "/api/me", fresh.data.token)).status, 401, "deactivation ends sessions");
  const me = (await call("GET", "/api/me", adminToken)).data;
  assert.equal((await call("PATCH", `/api/users/${me.id}`, adminToken, { active: false })).status, 400);
  const dispatcher = await login("dispatch", "dispatch123", "dispatch");
  assert.equal((await call("POST", "/api/users", dispatcher, { name: "Y", username: "y", password: "ypass-12345", role: "admin" })).status, 403);
});
