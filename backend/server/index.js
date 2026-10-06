import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { api } from "./api.js";
import { userFromToken } from "./auth.js";
import { setEmitter, hydrateLive, monitorTick } from "./fleet.js";
import { one } from "./db.js";
import { staffMfaRequired } from "./security.js";
import { purgeExpired, backupNow, RETENTION } from "./maintenance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4000);
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

if (!one("SELECT 1 FROM users LIMIT 1")) {
  console.warn("\n  No users yet. Run `npm run seed` to create demo accounts, vehicles and places.\n");
}

const app = express();
app.set("trust proxy", "loopback, linklocal, uniquelocal");
app.disable("x-powered-by");

// Request id for correlating logs, errors and audit records. Never log bodies, tokens or query strings.
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  res.set("X-Request-Id", req.id);
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    // originalUrl: routers rewrite req.path; the query string is dropped so nothing sensitive is logged.
    const p = req.originalUrl.split("?")[0];
    if (!p.startsWith("/api/")) return;
    // GPS uploads arrive every few seconds per driver; only log them when they fail.
    if (p === "/api/driver/positions" && res.statusCode < 400) return;
    log({ level: res.statusCode >= 500 ? "error" : "info", rid: req.id, method: req.method, path: p, status: res.statusCode,
      ms: Number((process.hrtime.bigint() - start) / 1000000n), user: req.user?.id ?? null });
  });
  next();
});

// Browser security headers. Map tiles may come from any https tile provider set in TILE_URL.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "connect-src 'self' ws: wss:",
  "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY",
    "Content-Security-Policy": CSP, "Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.originalUrl.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "1mb" }));

app.use("/api", api);
app.use("/vendor/leaflet", express.static(path.join(root, "node_modules/leaflet/dist"), { maxAge: "7d" }));
app.use("/driver", express.static(path.join(root, "public/driver"), {
  setHeaders: (res, p) => { if (p.endsWith("sw.js")) res.set({ "Service-Worker-Allowed": "/driver/", "Cache-Control": "no-cache" }); },
}));
app.use("/", express.static(path.join(root, "public/dispatch")));
app.use("/shared", express.static(path.join(root, "public/shared")));
// Errors raised before the API router (e.g. malformed JSON) get a JSON answer, not an HTML page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log({ level: "error", rid: req.id, path: req.path, error: err.message });
  res.status(status).json({ error: status === 400 ? "The request body isn't valid JSON." : status === 413 ? "The request is too large." : `Server error (reference ${req.id}).` });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token || "");
  if (!user) return next(new Error("unauthorized"));
  // Live fleet data is as sensitive as the API: staff need two-step sign-in here too.
  if (user.role !== "driver" && !user.mfa_enabled && staffMfaRequired()) return next(new Error("mfa_setup_required"));
  socket.data.user = user;
  next();
});
io.on("connection", (socket) => {
  const u = socket.data.user;
  socket.join(u.role === "driver" ? `driver:${u.id}` : "dispatch");
});
setEmitter((room, event, payload) => io.to(room).emit(event, payload));

hydrateLive();
setInterval(() => { try { monitorTick(); } catch (e) { log({ level: "error", task: "monitor", error: e.message }); } }, 30e3);

// Retention runs at start-up and twice a day; backups daily when BACKUP_INTERVAL_HOURS > 0 (default 24).
const housekeeping = () => {
  try { const r = purgeExpired(); if (r.positions + r.alerts + r.audit_log) log({ level: "info", task: "retention", ...r }); }
  catch (e) { log({ level: "error", task: "retention", error: e.message }); }
};
housekeeping();
setInterval(housekeeping, 12 * 3600e3);
const backupHours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
if (backupHours > 0) {
  setInterval(() => {
    try { log({ level: "info", task: "backup", file: path.basename(backupNow()) }); }
    catch (e) { log({ level: "error", task: "backup", error: e.message }); }
  }, backupHours * 3600e3);
}

server.listen(PORT, () => {
  console.log(`Fleetline running
  Dispatch console  http://localhost:${PORT}/
  Driver app        http://localhost:${PORT}/driver/
  Staff two-step sign-in: ${staffMfaRequired() ? "required" : "OFF (REQUIRE_STAFF_MFA=false)"} · GPS kept ${RETENTION.positionsDays} days · backups every ${backupHours || "—"} h`);
});
