import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { api } from "./api.js";
import { userFromToken } from "./auth.js";
import { setEmitter, hydrateLive, monitorTick } from "./fleet.js";
import { one } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4000);

if (!one("SELECT 1 FROM users LIMIT 1")) {
  console.warn("\n  No users yet. Run `npm run seed` to create demo accounts, vehicles and places.\n");
}

const app = express();
app.set("trust proxy", "loopback, linklocal, uniquelocal");
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" });
  next();
});

app.use("/api", api);
app.use("/vendor/leaflet", express.static(path.join(root, "node_modules/leaflet/dist"), { maxAge: "7d" }));
app.use("/driver", express.static(path.join(root, "public/driver"), {
  setHeaders: (res, p) => { if (p.endsWith("sw.js")) res.set({ "Service-Worker-Allowed": "/driver/", "Cache-Control": "no-cache" }); },
}));
app.use("/", express.static(path.join(root, "public/dispatch")));
app.use("/shared", express.static(path.join(root, "public/shared")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token || "");
  if (!user) return next(new Error("unauthorized"));
  socket.data.user = user;
  next();
});
io.on("connection", (socket) => {
  const u = socket.data.user;
  socket.join(u.role === "driver" ? `driver:${u.id}` : "dispatch");
});
setEmitter((room, event, payload) => io.to(room).emit(event, payload));

hydrateLive();
setInterval(() => { try { monitorTick(); } catch (e) { console.error("monitor", e); } }, 30e3);

server.listen(PORT, () => {
  console.log(`Fleetline running
  Dispatch console  http://localhost:${PORT}/
  Driver app        http://localhost:${PORT}/driver/`);
});
