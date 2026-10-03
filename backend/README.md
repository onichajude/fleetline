# Fleetline backend

Node.js server for Fleetline: REST API, live updates over Socket.IO, SQLite storage, the dispatch console and the
driver web app. The native driver app lives in [`../mobile`](../mobile).

| Part | URL | Who uses it |
|---|---|---|
| Dispatch console | `http://localhost:4000/` | Dispatchers and admins |
| Driver app | `http://localhost:4000/driver/` | Drivers, on their phones |
| REST API + WebSocket | `/api/*`, `/socket.io` | Both apps |

## Quick start

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite).

```bash
npm install
npm run seed
npm start
```

Sign in to the console as `dispatch` / `dispatch123` (or `admin` / `dispatch123` to add drivers and vehicles).
Driver usernames are `dana`, `luis`, `priya`, `tom`, `sam`, `mei`, `andre` and `kasia`, password `driver123`.
**Change these before real use.**

To watch vehicles move without phones, run the simulator in a second terminal. It signs in as the drivers
who have dispatched routes and drives them along real roads:

```bash
npm run simulate -- --speed 6
```

Demo data is seeded around Houston. Set `SEED_LAT` / `SEED_LNG` in `.env` and run `npm run seed -- --reset`
to seed around your own area.

## Using it with real phones

Phones only share GPS with web pages served over **HTTPS**, so `http://192.168.x.x:4000` won't work.

**Quickest test (no deployment):** a Cloudflare quick tunnel gives you a temporary public https address.

```bash
winget install Cloudflare.cloudflared
```

```bash
cloudflared tunnel --url http://localhost:4000
```

Open the printed `https://….trycloudflare.com/driver/` address on the phone, sign in, then use the browser's
**Add to Home Screen** so it opens like an app.

**Production:** deploy the server to any host that runs a long-lived Node process with WebSockets and a
persistent disk (a small VPS, Railway, Render, Fly.io), behind HTTPS. Keep `data/` on the persistent disk and back it up.

### How driver tracking works

1. The driver signs in and starts a shift in a vehicle. Location is shared only while on shift.
2. The app records a GPS fix every 10 m of movement (or every 15 s when stopped) and uploads in batches every 5 s.
   With no signal, fixes queue on the phone and upload when it reconnects.
3. Dispatching a route pushes it to the driver's phone instantly.
4. Arriving within `GEOFENCE_M` (90 m) of the next stop marks it **arrived** automatically. Driving away without tapping
   **Delivered** completes it automatically with a note. Drivers can also add a delivery note or skip a stop with a reason.
5. The server raises alerts for speeding (over the vehicle's limit on two fixes in a row), late arrivals, routes running
   behind schedule, skipped stops and phones that stop reporting.

### Web app vs native app

The web driver app (`/driver/`) needs no install, but phone browsers pause GPS when the screen locks or the driver
switches apps. It keeps the screen awake and warns the driver when tracking was paused. For tracking with the phone
locked, use the native app in [`../mobile`](../mobile), which uses the same API.

## Configuration

See [.env.example](.env.example). Before production:

- Set `JWT_SECRET` and change all seeded passwords (or start from an empty database and create accounts).
- Switch `TILE_URL` to a commercial tile provider. The OpenStreetMap servers don't allow heavy production use.
- Run your own OSRM server (or another routing API) instead of the public demo at `router.project-osrm.org`.
- Tell drivers what is tracked and when (shift-only), and follow your local employee-monitoring rules.

## Project layout

```
server/
  index.js     HTTP server, static files, Socket.IO
  api.js       REST endpoints (auth, fleet, routes, places, drivers, driver app, analytics)
  fleet.js     Live vehicle state, GPS intake, geofencing, alerts, route lifecycle, analytics
  db.js        SQLite schema (node:sqlite)
  auth.js      Password hashing (scrypt), JWT sessions, login throttling
  geo.js       Distance, stop-order optimisation, OSRM road routing
  seed.js      Demo data
public/
  dispatch/    Dispatch console (Leaflet map, live updates)
  driver/      Driver PWA (GPS, offline queue, stops)
  shared/      Shared browser helpers
scripts/
  simulate.js  Simulated drivers for testing
```

## API overview

All endpoints take and return JSON. Send `Authorization: Bearer <token>` from `POST /api/auth/login`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | any | `{username, password}` → `{token, user}` |
| GET | `/api/fleet` | staff | Every vehicle with live position, status, driver and route progress |
| GET | `/api/vehicles/:id/track?since=` | staff | GPS breadcrumbs |
| GET/POST/PATCH | `/api/routes`, `/api/routes/:id` | staff | Plan routes (`place_ids`, `depot_id`, optional `vehicle_id` to dispatch) |
| POST | `/api/routes/:id/dispatch` · `/optimize` · `/cancel` | staff | Route lifecycle |
| GET/POST/PATCH/DELETE | `/api/places` | staff | Delivery locations |
| GET/POST/PATCH | `/api/drivers`, `/api/vehicles` | staff (create: admin) | Fleet setup |
| GET | `/api/alerts`, POST `/api/alerts/:id/ack` | staff | Alert feed |
| GET | `/api/analytics?date=YYYY-MM-DD` | staff | Distance, driving time, on-time rate, deliveries by hour, routes |
| GET | `/api/driver/state` | driver | Shift, vehicle and current route |
| POST | `/api/driver/shift/start` · `/shift/end` | driver | Shift control |
| POST | `/api/driver/positions` | driver | `{points: [{lat, lng, speed, heading, accuracy, t}]}` |
| POST | `/api/driver/stops/:id/arrive` · `/complete` · `/skip` | driver | Stop updates |

WebSocket events (Socket.IO, authenticate with `auth: {token}`): staff receive `vehicle`, `route` and `alert`;
drivers receive `route` when their assignment changes.
