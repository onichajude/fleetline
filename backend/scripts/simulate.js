// Simulated drivers for testing without phones. Each one signs in through the real driver API,
// starts a shift, drives its dispatched route along the road geometry and reports GPS every few seconds.
//
//   npm run simulate                       drivers whose vehicles have dispatched routes
//   npm run simulate -- --drivers dana,sam --speed 4 --base http://localhost:4000
//
// --speed scales how fast simulated time passes (movement and stop dwell); reported speeds stay realistic.
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg("base", `http://localhost:${process.env.PORT || 4000}`);
const SPEEDUP = Number(arg("speed", 3));
const PASSWORD = arg("password", process.env.SEED_DRIVER_PASSWORD || "driver123");
const TICK_MS = 3000;

const R = 6371e3, rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => { const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(s))); };
const brg = (a, b) => { const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat)); const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng)); return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360; };
const jitter = (m) => (Math.random() - 0.5) * 2 * m;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error || res.status}`);
  return data;
}

async function pickDrivers() {
  const list = arg("drivers");
  if (list) return list.split(",").map((s) => s.trim()).filter(Boolean);
  // The demo seed dispatches routes to these drivers' vehicles (TRK-101, TRK-103, VAN-201, VAN-202).
  // (Staff sign-in needs an authenticator code, so the simulator doesn't look them up.)
  return ["dana", "priya", "sam", "mei"];
}

async function runDriver(username, idx) {
  const log = (...m) => console.log(`[${username}]`, ...m);
  const { token } = await call(null, "POST", "/api/auth/login", { username, password: PASSWORD, app: "driver" });
  let st = await call(token, "GET", "/api/driver/state");
  // Simulated test drivers accept the location notice; real drivers do this themselves in the app.
  if (st.privacy?.required) st = await call(token, "POST", "/api/driver/privacy-ack", { version: st.privacy.notice.version });
  if (!st.shift) {
    const v = st.vehicles.find((x) => x.mine) || st.vehicles[0];
    if (!v) return log("no free vehicle");
    st = await call(token, "POST", "/api/driver/shift/start", { vehicle_id: v.id });
  }
  log(`on shift in ${st.vehicle.code}`);
  await sleep(idx * 1500);

  let pos = null, heading = 0;
  const send = (speedKmh) => call(token, "POST", "/api/driver/positions", {
    points: [{ lat: pos.lat + jitter(0.00002), lng: pos.lng + jitter(0.00002), speed: speedKmh, heading, accuracy: Math.round(5 + Math.random() * 10), t: Date.now() }],
  }).catch((e) => log(e.message));

  for (;;) {
    st = await call(token, "GET", "/api/driver/state");
    const r = st.route;
    if (!r) {
      if (pos) await send(0);
      await sleep(15000);
      continue;
    }
    if (r.status === "dispatched") st = await call(token, "POST", `/api/driver/route/${r.id}/start`);
    const route = st.route;
    const depot = route.depot_lat != null ? { lat: route.depot_lat, lng: route.depot_lng } : null;
    const path = (route.geometry?.coords?.map(([lat, lng]) => ({ lat, lng })) ||
      [...(depot ? [depot] : []), ...route.stops.map((s) => ({ lat: s.lat, lng: s.lng })), ...(depot ? [depot] : [])]);
    if (!pos) pos = { ...path[0] };
    // Resume from the closest point on the path to where we are.
    let i = path.reduce((best, p, k) => (dist(pos, p) < dist(pos, path[best]) ? k : best), 0);
    log(`driving ${route.code} (${route.stops.length} stops, ${path.length} path points)`);
    let cruise = 30 + Math.random() * 18, burst = 0;

    while (i < path.length - 1) {
      const live = await call(token, "GET", "/api/driver/state").catch(() => null);
      if (!live?.route || live.route.id !== route.id) { log(`${route.code} ended or was cancelled`); break; }
      const next = live.route.stops.find((s) => s.status === "arrived") || live.route.stops.find((s) => s.status === "pending");
      if (next && (next.status === "arrived" || dist(pos, next) < 40)) {
        await send(0);
        const dwell = ((next.dwell_min || 8) * 60e3 * (0.7 + Math.random() * 0.6)) / SPEEDUP;
        log(`at ${next.name}, unloading ~${Math.round(dwell / 1000)}s`);
        const until = Date.now() + dwell;
        while (Date.now() < until) { await sleep(Math.min(10000, until - Date.now())); await send(0); }
        const note = ["Signed by front desk", "Left at loading bay", "Handed to manager", null][Math.floor(Math.random() * 4)];
        await call(token, "POST", `/api/driver/stops/${next.id}/complete`, { note }).catch((e) => log(e.message));
        // Move past the stop so it isn't re-detected.
        while (i < path.length - 1 && dist(pos, next) < 60) { pos = { ...path[++i] }; }
        continue;
      }
      if (!burst && Math.random() < 0.01) burst = 6; // occasional speeding burst for alert testing
      const kmh = burst ? 112 + Math.random() * 8 : Math.max(8, cruise + jitter(8));
      if (burst) burst--;
      if (Math.random() < 0.05) cruise = 26 + Math.random() * 22;
      let move = (kmh / 3.6) * (TICK_MS / 1000) * SPEEDUP;
      while (move > 0 && i < path.length - 1) {
        const target = path[i + 1], d = dist(pos, target);
        if (d < 0.5) { i++; continue; }
        heading = brg(pos, target);
        if (move >= d) { pos = { ...target }; i++; move -= d; }
        else { const f = move / d; pos = { lat: pos.lat + (target.lat - pos.lat) * f, lng: pos.lng + (target.lng - pos.lng) * f }; move = 0; }
      }
      await send(+kmh.toFixed(1));
      await sleep(TICK_MS);
    }
    log("back at base, waiting for the next route");
    await send(0);
    await sleep(10000);
  }
}

const usernames = await pickDrivers();
if (!usernames.length) { console.log("No drivers with dispatched routes. Dispatch a route first, or pass --drivers name1,name2."); process.exit(0); }
console.log(`Simulating ${usernames.join(", ")} against ${BASE} at ${SPEEDUP}× time. Ctrl+C to stop.`);
usernames.forEach((u, k) => runDriver(u, k).catch((e) => console.error(`[${u}]`, e.message)));
