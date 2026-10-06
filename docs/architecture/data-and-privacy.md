# Data inventory, privacy register and metric dictionary

Covers template areas 10, 11 and 12. Owner of all data categories: **onichajude** (until the operating company names a data owner).

## Data inventory

Sensitivity levels:
- **High:** location, credentials, or data enabling account takeover.
- **Personal:** identifies a person.
- **Business:** company records with no direct personal data.

| Table | Contents | Source | Purpose | Sensitivity | Access | Retention | Disposal |
|---|---|---|---|---|---|---|---|
| `users` | Name, username, role, phone, licence number, sign-up note, approval state, password hash (scrypt), two-step login secret, privacy acceptance | Admin or driver sign-up | Accounts, sign-in, contact | **High** (hash and secret), Personal | Admin; user sees their own record | Life of account; erased on request | Erasure replaces identifiers and clears the secret ([api.js](../../backend/server/api.js) `/erase`) |
| `positions` | Lat/lng, speed, heading, accuracy, time, per vehicle and driver | Driver phone during shifts only | Live tracking, arrival detection, distance, safety alerts | **High** | Staff (live map, tracks); driver (own export) | **180 days** (`POSITION_RETENTION_DAYS`) | Automatic purge; erased with the driver |
| `shifts` | Driver, vehicle, start and end | Driver app | Who drove what, hours | Personal | Staff; driver (own) | Life of account (pending legal retention decision) | Kept after erasure, linked to an anonymised user |
| `routes`, `route_stops` | Planned and actual stop times, delivery notes, skip reasons, driver ID | Dispatch, driver, geofence | Deliveries, on-time performance | Business, Personal (driver link, notes) | Staff; driver (own current route) | Pending legal decision (default: keep) | Kept after erasure, linked to an anonymised user |
| `inspections` | Pre-trip check results and notes, driver ID | Driver | Vehicle safety | Business, Personal | Staff | Pending (vehicle safety records may have a legal minimum) | Notes replaced with "[removed]" on erasure |
| `services` | Service date, odometer, note, staff member | Staff | Vehicle maintenance | Business | Staff | Life of vehicle | — |
| `vehicles`, `depots`, `places` | Fleet, sites, customer delivery addresses | Staff | Operations | Business (customer addresses may be personal) | Staff | Life of record | Manual delete (places: only if unused) |
| `alerts` | Operational events (may name a driver) | System | Dispatch awareness | Personal | Staff | **365 days** | Purge; names scrubbed on erasure |
| `audit_log` | Actor, action, target, IP address, request ID, time | System | Security accountability | Personal (IP address, actor) | Admin | **730 days** | Purge; kept after erasure as a security record |
| Backups | Copy of all of the above | Server | Recovery | **High** | Server administrator | 14 copies (`BACKUP_KEEP`) | Rotated out; erased data persists until rotation ([runbooks](runbooks.md#restore-from-backup)) |
| On the phone | Session token (keychain or keystore), queued GPS fixes (app storage), last fix | App | Background tracking offline | **High** | The device owner | Until sent or sign-out | Cleared on sign-out (`clearSession`) |
| Browser | Session token (localStorage), offline GPS queue (web app) | Web apps | Sign-in, offline queue | **High** | The browser profile | Until sign-out | Cleared on sign-out |

**Not collected:**
- Location outside shifts
- Contacts, photos, microphone or camera
- Advertising IDs
- Third-party analytics
- Cookies (sessions use storage, not cookies)

## Processing register

The legal basis is a **draft for legal review**; it differs by country (area 18).

| # | Purpose | Data | People | Proposed basis (EU/UK terms) | Recipients |
|---|---|---|---|---|---|
| P1 | Accounts and security | Users, audit log | Staff, drivers | Contract / legitimate interest (security) | Hosting provider |
| P2 | Live tracking and dispatch during shifts | Positions, routes | Drivers | Legitimate interest (operations, safety); **DPIA required** | Hosting; Esri sees the viewer's IP and map area; OSRM receives stop coordinates (not driver identity) |
| P3 | Delivery records | Routes, stops, notes | Drivers, customers (addresses) | Contract with customers / legitimate interest | Hosting |
| P4 | Performance and rankings | Derived from P2 and P3 | Drivers | Legitimate interest. **Needs a balancing test:** rankings may affect employment decisions | Staff of the operating company |
| P5 | Vehicle safety | Inspections, services | Drivers, staff | Legal obligation (road safety, where it applies) / legitimate interest | Hosting |
| P6 | Speeding alerts | Positions | Drivers | Legitimate interest (public safety) | Staff |

**International transfers:** depend on the host region and on Esri, OSRM and Expo locations. Pending area 18.

## Rights workflows

| Right | How | Who | Evidence |
|---|---|---|---|
| Be informed | Notice shown and accepted before the first shift; a changed notice must be accepted again | Driver | `privacy.notice_accepted` in the audit log; `users.privacy_ack_version` |
| Access / portability | Driver: **My stats → Download my data** (JSON). Admin: **Setup → Privacy requests → Export data** | Driver or admin | `privacy.self_export` / `privacy.export` audit entries |
| Rectification | Admin edits name or phone (`PATCH /api/drivers/:id`) | Admin | `user.updated` audit entry |
| Erasure | Admin: **Setup → Privacy requests → Erase personal data** (type the username to confirm; refused during an open shift) | Admin | `privacy.erase` audit entry with the number of positions deleted |
| Restriction / objection | Deactivate the account (stops sign-in and collection); handle case by case with legal advice | Admin | `user.deactivated` audit entry |

**Identity checks:** requests come from the signed-in driver (self-service) or are verified by the employer before an admin acts. **Deadline:** the shortest applicable legal deadline, to be set in area 18 (typically one month under GDPR). **Exceptions:** business records that must be kept are retained without identity.

## Privacy notice (version 2026-10-06)

The notice is shown in the driver web and native apps, served from `GET /api/privacy-notice` and defined in [security.js](../../backend/server/security.js). **The text is a draft and must be reviewed by a legal adviser for each market before launch.** The notice says:
1. Location is sent every few seconds while on shift and stops when the shift ends.
2. It's used for deliveries, arrival detection and safety, including speeding alerts.
3. Trips, deliveries, on-time rate and checks feed the driver's performance page and rankings their employer can see.
4. Location history is deleted after the retention period (180 days by default); alerts and audit records are kept longer.
5. The driver can ask for a copy of their data, or for deletion when they leave; some business records may have to be kept by law.

## Metric dictionary

Source: [stats.js](../../backend/server/stats.js). Owner: onichajude. All metrics are computed on request from primary records, so they are always current.

| Metric | Formula | Population and exclusions | Window |
|---|---|---|---|
| Trips | Count of routes with `status = completed` and `completed_at` in the window, by the driver who started them (`routes.driver_id`) | Excludes cancelled routes | Calendar week, Monday 00:00 to Monday 00:00, server time |
| Deliveries | Stops with `status = completed`, counted by completion time | Skipped stops counted separately | Week / day |
| On-time % | Arrived stops with `arrived_at ≤ planned_at + LATE_GRACE_MIN` ÷ arrived stops | Stops never arrived (skipped) excluded; planned time set at dispatch or route start | Week |
| Distance (km) | Sum of distances between consecutive GPS fixes | Ignores fixes with accuracy above 150 m, or implying more than 250 km/h | Week / day |
| Driving hours | Time between consecutive fixes faster than 1.5 m/s and less than 3 min apart | Same accuracy filter | Week |
| Shift hours | Overlap of shifts with the window | Open shifts counted up to now | Week |
| 4-week average | Mean of the previous 4 weeks that had any shift or trip | Weeks with no activity excluded; null when there are none | 4 weeks before the current week |
| Rank | Order by deliveries, then on-time %, then km, among drivers with a shift that week | — | Week |
| Odometer | Value entered when the vehicle is added, plus GPS distance of saved fixes (duplicates excluded) | Same filter as distance | Running total |
| Vehicle condition | Out of service if marked in maintenance. Needs attention if an open pre-trip problem (reported after the last service) or service overdue. Service soon if under 1,000 km to service | — | Current |

**Known limitations:**
- Distance is measured between GPS fixes (straight lines), so it is slightly less than road distance.
- Rankings favour drivers who worked more days; compare averages before drawing conclusions about individuals ([risk R-10](registers.md#risk-register)).
