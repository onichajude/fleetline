// Creates demo data. Usage: npm run seed            (only into an empty database)
//                             npm run seed -- --reset (wipes everything first)
import { db, one, run, localDate } from "./db.js";
import { hashPassword } from "./auth.js";
import * as F from "./fleet.js";

const reset = process.argv.includes("--reset");
if (one("SELECT 1 FROM users LIMIT 1") && !reset) {
  console.log("The database already has data. Run `npm run seed -- --reset` to wipe it and reseed.");
  process.exit(0);
}
if (reset) db.exec("DELETE FROM alerts; DELETE FROM positions; DELETE FROM route_stops; DELETE FROM routes; DELETE FROM shifts; DELETE FROM places; DELETE FROM vehicles; DELETE FROM depots; DELETE FROM users;");

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

const vehicles = [
  ["TRK-101", "Box truck", "TX 4KD-221", harbor, drivers[0], 90], ["TRK-102", "Box truck", "TX 7PL-904", harbor, drivers[1], 90],
  ["TRK-103", "Reefer truck", "TX 2MN-118", harbor, drivers[2], 90], ["TRK-104", "Flatbed", "TX 9QA-650", harbor, drivers[3], 80],
  ["VAN-201", "Cargo van", "TX 5RT-332", north, drivers[4], 100], ["VAN-202", "Cargo van", "TX 3HV-771", north, drivers[5], 100],
  ["VAN-203", "Cargo van", "TX 8WS-045", north, drivers[6], 100], ["VAN-204", "Cargo van", "TX 6BG-519", harbor, drivers[7], 100],
].map(([code, type, plate, d, drv, lim]) =>
  Number(run("INSERT INTO vehicles (code, type, plate, depot_id, default_driver_id, speed_limit_kmh, created_at) VALUES (?,?,?,?,?,?,?)", code, type, plate, d, drv, lim, now).lastInsertRowid));

const places = [
  ["Pier 9 Cold Storage", -4.0, 4.4, 15], ["Marlow St Market", -1.2, -2.6, 10], ["Eastgate Clinic", 0.4, 5.2, 6],
  ["Fenwick Mall", 1.1, 2.3, 12], ["Brookside Bakery", 2.6, -0.9, 6], ["Ironworks Supply", -0.6, -4.8, 15],
  ["Cedar Park Pharmacy", 2.1, 1.6, 5], ["Kingsway Hardware", -2.3, 3.9, 8], ["Riverside Hotel", -0.2, 0.6, 10],
  ["Union Square Café", 0.9, -0.4, 5], ["Hillcrest School", 3.6, -3.2, 8], ["Oakline Builders", -2.8, 6.1, 15],
  ["Westfield Pharmacy", 1.8, -5.0, 5], ["Granary Foods", -1.6, 1.8, 10], ["Lantern Brewing", -3.1, -1.1, 12],
  ["Northpoint Offices", 4.4, 1.2, 6], ["Saltmarsh Fish Co.", -4.3, 0.9, 10], ["Midtown Medical Center", -0.9, -1.0, 6],
].map(([name, n, e, dwell]) => { const p = at(n, e); return Number(run("INSERT INTO places (name, lat, lng, dwell_min, created_at) VALUES (?,?,?,?,?)", name, p.lat, p.lng, dwell, now).lastInsertRowid); });

const today = localDate();
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

  4 routes are dispatched (TRK-101, TRK-103, VAN-201, VAN-202); 2 are drafts.`);
