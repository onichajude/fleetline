// Creates demo data. Usage: npm run seed            (only into an empty database)
//                             npm run seed -- --reset (wipes everything first)
import { db, one, run, localDate } from "./db.js";
import { hashPassword } from "./auth.js";
import * as F from "./fleet.js";
import { haversine } from "./geo.js";

const reset = process.argv.includes("--reset");
if (one("SELECT 1 FROM users LIMIT 1") && !reset) {
  console.log("The database already has data. Run `npm run seed -- --reset` to wipe it and reseed.");
  process.exit(0);
}
if (reset) db.exec("DELETE FROM alerts; DELETE FROM inspections; DELETE FROM services; DELETE FROM positions; DELETE FROM route_stops; DELETE FROM routes; DELETE FROM shifts; DELETE FROM places; DELETE FROM vehicles; DELETE FROM depots; DELETE FROM users;");
const withHistory = !process.argv.includes("--no-history");

// Demo city centre. Set SEED_LAT / SEED_LNG in .env to seed around your own area.
const C = { lat: Number(process.env.SEED_LAT || 29.7604), lng: Number(process.env.SEED_LNG || -95.3698) };
const at = (northKm, eastKm) => ({ lat: C.lat + northKm / 110.574, lng: C.lng + eastKm / (111.32 * Math.cos((C.lat * Math.PI) / 180)) });
const now = Date.now();

const staffPw = process.env.SEED_STAFF_PASSWORD || "dispatch123";
const driverPw = process.env.SEED_DRIVER_PASSWORD || "driver123";
const user = (name, username, role, pw, phone = null) =>
  Number(run("INSERT INTO users (name, username, role, pass_hash, phone, created_at) VALUES (?,?,?,?,?,?)", name, username, role, hashPassword(pw), phone, now).lastInsertRowid);

user("Fleet Admin", "admin", "admin", staffPw);
user("Jordan Hale", "dispatch", "dispatcher", staffPw);
const drivers = [
  ["Dana Okafor", "dana"], ["Luis Ferreira", "luis"], ["Priya Natarajan", "priya"], ["Tom Reyes", "tom"],
  ["Sam Whitlock", "sam"], ["Mei Tanaka", "mei"], ["Andre Boateng", "andre"], ["Kasia Nowak", "kasia"],
].map(([n, u], i) => user(n, u, "driver", driverPw, `+1 555 01${String(i).padStart(2, "0")}`));

const depot = (name, code, p) => Number(run("INSERT INTO depots (name, code, lat, lng) VALUES (?,?,?,?)", name, code, p.lat, p.lng).lastInsertRowid);
const harbor = depot("Harbor Depot", "HD", at(-3.2, 2.6));
const north = depot("North Yard", "NY", at(4.1, -1.8));

// [code, type, plate, depot, driver, speed limit, odometer km, km since last service, service interval km]
const vehicles = [
  ["TRK-101", "Box truck", "TX 4KD-221", harbor, drivers[0], 90, 48210, 3100, 10000], ["TRK-102", "Box truck", "TX 7PL-904", harbor, drivers[1], 90, 61877, 10420, 10000],
  ["TRK-103", "Reefer truck", "TX 2MN-118", harbor, drivers[2], 90, 39502, 7400, 8000], ["TRK-104", "Flatbed", "TX 9QA-650", harbor, drivers[3], 80, 102344, 1200, 10000],
  ["VAN-201", "Cargo van", "TX 5RT-332", north, drivers[4], 100, 28455, 4800, 12000], ["VAN-202", "Cargo van", "TX 3HV-771", north, drivers[5], 100, 33190, 9300, 10000],
  ["VAN-203", "Cargo van", "TX 8WS-045", north, drivers[6], 100, 19870, 2300, 12000], ["VAN-204", "Cargo van", "TX 6BG-519", harbor, drivers[7], 100, 24611, 5600, 12000],
].map(([code, type, plate, d, drv, lim, odo, since, interval]) =>
  Number(run(`INSERT INTO vehicles (code, type, plate, depot_id, default_driver_id, speed_limit_kmh, odometer_km, last_service_km, last_service_at, service_interval_km, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`, code, type, plate, d, drv, lim, odo, odo - since, now - Math.round(since / 90) * 864e5, interval, now).lastInsertRowid));

const places = [
  ["Pier 9 Cold Storage", -4.0, 4.4, 15], ["Marlow St Market", -1.2, -2.6, 10], ["Eastgate Clinic", 0.4, 5.2, 6],
  ["Fenwick Mall", 1.1, 2.3, 12], ["Brookside Bakery", 2.6, -0.9, 6], ["Ironworks Supply", -0.6, -4.8, 15],
  ["Cedar Park Pharmacy", 2.1, 1.6, 5], ["Kingsway Hardware", -2.3, 3.9, 8], ["Riverside Hotel", -0.2, 0.6, 10],
  ["Union Square Café", 0.9, -0.4, 5], ["Hillcrest School", 3.6, -3.2, 8], ["Oakline Builders", -2.8, 6.1, 15],
  ["Westfield Pharmacy", 1.8, -5.0, 5], ["Granary Foods", -1.6, 1.8, 10], ["Lantern Brewing", -3.1, -1.1, 12],
  ["Northpoint Offices", 4.4, 1.2, 6], ["Saltmarsh Fish Co.", -4.3, 0.9, 10], ["Midtown Medical Center", -0.9, -1.0, 6],
].map(([name, n, e, dwell]) => { const p = at(n, e); return Number(run("INSERT INTO places (name, lat, lng, dwell_min, created_at) VALUES (?,?,?,?,?)", name, p.lat, p.lng, dwell, now).lastInsertRowid); });

const today = localDate();

/* ---------- 4 weeks of history: shifts, completed trips, GPS tracks and pre-trip checks ---------- */
if (withHistory) {
  let a = 20261003;
  const rng = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const placeRows = places.map((pid) => one("SELECT id, lat, lng, dwell_min FROM places WHERE id = ?", pid));
  const depotRows = { [harbor]: one("SELECT lat, lng FROM depots WHERE id = ?", harbor), [north]: one("SELECT lat, lng FROM depots WHERE id = ?", north) };
  const homeDepot = [harbor, harbor, harbor, harbor, north, north, north, harbor];
  // Each driver has a consistent skill: higher is faster and more punctual. Gives the rankings some spread.
  const skill = [0.9, 0.75, 0.95, 0.7, 0.85, 0.8, 0.6, 0.88];
  const items = ["tires", "brakes", "lights", "fluids", "body", "cargo"];
  const insPos = db.prepare("INSERT INTO positions (vehicle_id, shift_id, driver_id, lat, lng, speed_kmh, heading, accuracy_m, recorded_at, received_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const [ty, tm, td] = today.split("-").map(Number);
  let hseq = 100;
  db.exec("BEGIN");
  for (let back = 28; back >= 1; back--) {
    const day = new Date(ty, tm - 1, td - back);
    if (day.getDay() === 0) continue; // Sundays off
    drivers.forEach((driverId, i) => {
      if (rng() > 0.82) return; // day off
      const vehicleId = vehicles[i], depotPt = depotRows[homeDepot[i]];
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 6 + Math.floor(rng() * 2), Math.floor(rng() * 60)).getTime();
      const shiftId = Number(run("INSERT INTO shifts (driver_id, vehicle_id, started_at, ended_at) VALUES (?,?,?,?)", driverId, vehicleId, start, start).lastInsertRowid);
      const insp = Object.fromEntries(items.map((k) => [k, rng() < 0.02 ? "issue" : "ok"]));
      const nIssues = Object.values(insp).filter((x) => x === "issue").length;
      run("INSERT INTO inspections (vehicle_id, driver_id, shift_id, items, issues, notes, created_at) VALUES (?,?,?,?,?,?,?)",
        vehicleId, driverId, shiftId, JSON.stringify(insp), nIssues, nIssues ? "Reported at start of shift" : null, start + 5 * 60e3);
      let clock = start + 15 * 60e3;
      const trips = rng() < 0.6 ? 2 : 1;
      for (let k = 0; k < trips; k++) {
        const picks = [...placeRows].sort(() => rng() - 0.5).slice(0, 4 + Math.floor(rng() * 4));
        const routeId = Number(run(`INSERT INTO routes (code, name, vehicle_id, driver_id, depot_id, status, service_date, dispatched_at, started_at, completed_at, created_at)
          VALUES (?,?,?,?,?,'completed',?,?,?,?,?)`, `R-${String(hseq++).padStart(4, "0")}`, `Daily run ${k + 1}`, vehicleId, driverId, homeDepot[i],
          localDate(day.getTime()), clock - 10 * 60e3, clock, clock, clock).lastInsertRowid);
        let prev = depotPt, plan = clock;
        // Writes a GPS fix about every 400 m between two points and advances the clock by the drive time.
        const drive = (from, to, kmh) => {
          const dist = haversine(from, to), steps = Math.max(1, Math.ceil(dist / 400)), dur = ((dist * 1.3) / 1000 / kmh) * 3600e3;
          for (let s2 = 1; s2 <= steps; s2++) {
            const f = s2 / steps, ts = Math.round(clock + dur * f);
            insPos.run(vehicleId, shiftId, driverId, from.lat + (to.lat - from.lat) * f, from.lng + (to.lng - from.lng) * f, kmh * (0.8 + rng() * 0.4), null, 8 + rng() * 10, ts, ts);
          }
          clock += dur;
        };
        picks.forEach((p, idx) => {
          plan += ((haversine(prev, p) * 1.35) / 1000 / 32) * 3600e3;
          drive(prev, p, 19 + 13 * skill[i] + rng() * 5);
          clock += (1 - skill[i]) * 14 * 60e3 * rng(); // less punctual drivers drift later
          const skipped = rng() < 0.02, dwell = p.dwell_min * 60e3 * (0.7 + rng() * 0.6);
          run("INSERT INTO route_stops (route_id, seq, place_id, planned_at, arrived_at, completed_at, status, note) VALUES (?,?,?,?,?,?,?,?)",
            routeId, idx + 1, p.id, Math.round(plan), skipped ? null : Math.round(clock), Math.round(clock + (skipped ? 0 : dwell)),
            skipped ? "skipped" : "completed", skipped ? "Customer closed" : null);
          plan += p.dwell_min * 60e3;
          clock += skipped ? 2 * 60e3 : dwell;
          prev = p;
        });
        drive(prev, depotPt, 35);
        run("UPDATE routes SET completed_at = ? WHERE id = ?", Math.round(clock), routeId);
        clock += 30 * 60e3;
      }
      run("UPDATE shifts SET ended_at = ? WHERE id = ?", Math.round(clock), shiftId);
    });
  }
  db.exec("COMMIT");
  // A recent pre-trip problem on VAN-204 that hasn't been fixed yet.
  const vanShift = Number(run("INSERT INTO shifts (driver_id, vehicle_id, started_at, ended_at) VALUES (?,?,?,?)", drivers[7], vehicles[7], now - 26 * 3600e3, now - 18 * 3600e3).lastInsertRowid);
  run("INSERT INTO inspections (vehicle_id, driver_id, shift_id, items, issues, notes, created_at) VALUES (?,?,?,?,?,?,?)", vehicles[7], drivers[7], vanShift,
    JSON.stringify({ tires: "ok", brakes: "issue", lights: "ok", fluids: "ok", body: "ok", cargo: "ok" }), 1, "Grinding noise from front left when braking", now - 26 * 3600e3);
}

let seq = 1041;
async function route(name, stopIdx, depotId, vehicleIdx) {
  const r = Number(run("INSERT INTO routes (code, name, depot_id, service_date, created_at) VALUES (?,?,?,?,?)", `R-${seq++}`, name, depotId, today, now).lastInsertRowid);
  stopIdx.forEach((i, k) => run("INSERT INTO route_stops (route_id, seq, place_id) VALUES (?,?,?)", r, k + 1, places[i]));
  F.optimizeRoute(r);
  if (vehicleIdx != null) await F.dispatchRoute(r, vehicles[vehicleIdx]);
  else await F.attachGeometry(r);
}
await route("Harbor cold chain", [0, 8, 9, 3, 13], harbor, 2);
await route("Westside retail", [1, 5, 12, 10, 4, 14], harbor, 0);
await route("East clinics & trade", [15, 6, 2, 11, 7], north, 4);
await route("Midtown pharmacy", [17, 9, 6, 13], north, 5);
await route("Builders' steel drop", [5, 11, 0], harbor, null);
await route("Afternoon top-up", [3, 2, 15, 10], north, null);

console.log(`Seeded around ${C.lat.toFixed(4)}, ${C.lng.toFixed(4)} for ${today}.

  Dispatch console  username admin or dispatch, password ${staffPw}
  Driver app        usernames ${["dana", "luis", "priya", "tom", "sam", "mei", "andre", "kasia"].join(", ")}, password ${driverPw}

  4 routes are dispatched (TRK-101, TRK-103, VAN-201, VAN-202); 2 are drafts.${withHistory ? "\n  Includes 4 weeks of history (trips, GPS, pre-trip checks). Use --no-history to skip it." : ""}`);
