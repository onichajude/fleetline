// Starts a real server on a throwaway database for a test file.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeArgs = ["--disable-warning=ExperimentalWarning"];

export async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetline-test-"));
  const port = 4400 + Math.floor(Math.random() * 1500);
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), ROUTING_URL: "", JWT_SECRET: "test-secret", BACKUP_INTERVAL_HOURS: "0", ...extraEnv };
  const seed = spawnSync(process.execPath, [...nodeArgs, "server/seed.js"], { cwd: root, env, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const proc = spawn(process.execPath, [...nodeArgs, "server/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 15000);
    proc.stdout.on("data", (d) => { if (String(d).includes("Fleetline running")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });

  async function call(method, url, token, body) {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  const login = async (username, password, app, code) =>
    (await call("POST", "/api/auth/login", null, { username, password, app, code })).data.token;
  /** Signs a driver in and accepts the current privacy notice, as the app does on first use. */
  async function driverLogin(username, password = "driver123") {
    const token = await login(username, password, "driver");
    const st = (await call("GET", "/api/driver/state", token)).data;
    if (st.privacy.required) await call("POST", "/api/driver/privacy-ack", token, { version: st.privacy.notice.version });
    return token;
  }
  async function stop() {
    if (proc.exitCode === null) { const exited = new Promise((r) => proc.once("exit", r)); proc.kill(); await exited; }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return { base, dataDir, env, call, login, driverLogin, stop };
}
