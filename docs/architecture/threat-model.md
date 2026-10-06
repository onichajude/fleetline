# Threat model

Template area 09. Owner: onichajude. Last updated 2026-10-06; update after any change to authentication, data, vendors, hosting or features.

## Assets

1. Drivers' location history and live position
2. Staff and driver credentials, sessions and two-step secrets
3. Delivery records and customer addresses
4. Integrity of performance figures (they may affect people's jobs)
5. Vehicle safety status
6. Availability of dispatch during working hours
7. Audit log (accountability)

## Actors

- **Outsiders:** internet attackers, credential stuffers, bots.
- **Insiders:**
  - A driver trying to see others' data or fake their figures.
  - A dispatcher exceeding their role.
  - A former employee.
- **Lost or stolen devices.**
- **Compromised third parties:** a dependency, the tile host, the routing service.

## Entry points and trust boundaries

- **B1:** public HTTPS API and WebSocket (`/api/*`, `/socket.io`).
- **B2:** server to OSRM (outbound).
- **B3:** browser to tile host and Google Fonts.
- **B4:** device storage (browser localStorage, phone keychain and app storage).
- **B5:** build and deploy chain (GitHub, npm, Expo EAS).
- **B6:** server disk and backups.

## Threats and controls

Status: **Mitigated** (control in place and tested) · **Partial** · **Accepted** (in the [risk register](registers.md#risk-register) with expiry) · **Open** (pending, with owner).

| ID | Threat | Boundary | Control | Status |
|---|---|---|---|---|
| T1 | Credential stuffing or guessing on sign-in | B1 | scrypt hashes, 8-character minimum, throttle (8 per 10 min per user + IP), identical errors, staff two-step login | Mitigated (two-step login tested) |
| T2 | Staff account takeover exposes every driver's location | B1 | Mandatory TOTP for staff on API and WebSocket, codes can't be reused, audit of sign-ins and failures | Mitigated |
| T3 | Stolen session token (XSS, shared computer) | B4 | CSP (`script-src 'self'`, no inline scripts), output escaping, 14-day expiry, revocation on password change, sign-out | Partial: browser tokens in localStorage ([R-01](registers.md#risk-register)) |
| T4 | Driver reads or changes another driver's or vehicle's data | B1 | Server-side ownership checks (`ownStop`, `driverShift`); drivers have no staff endpoints | Mitigated (negative tests) |
| T5 | Driver fakes GPS to improve figures | B1 | Speed and accuracy filters; geofence; audit trail; figures traceable to raw fixes | Accepted ([R-06](registers.md#risk-register)): phone GPS can be spoofed on rooted devices |
| T6 | Injection (SQL, HTML) | B1 | Parameterised queries only; HTML output escaped; JSON-only API | Mitigated |
| T7 | Cross-site request forgery | B1 | Bearer tokens in headers (no cookies); CORS off for the WebSocket | Mitigated |
| T8 | Clickjacking | B1 | `X-Frame-Options: DENY`, `frame-ancestors 'none'` | Mitigated |
| T9 | Location collected without notice, or outside shifts | B1 | Server refuses shift and GPS without notice acceptance and an open shift; audit of acceptance | Mitigated (tested) |
| T10 | Duplicate or replayed GPS batches distort distance | B1 | Unique `(vehicle, time)` key, insert-or-ignore, odometer counts only saved fixes | Mitigated (tested) |
| T11 | Denial of service: large bodies, floods | B1 | 1 MB body limit, 2,000 points per batch, sign-in and sign-up throttles | Partial: no general rate limit or WAF ([R-04](registers.md#risk-register)); add at the host or proxy |
| T12 | Costly automation: sign-up spam | B1 | 5 sign-ups per IP per hour; approval required | Mitigated |
| T13 | Lost or stolen phone | B4 | Session in keychain or keystore; admin resets password (ends sessions); queued GPS not encrypted | Accepted ([R-03](registers.md#risk-register)) |
| T14 | Former employee keeps access | B1 | Deactivate or erase ends all sessions immediately; quarterly access review | Mitigated (process in runbooks) |
| T15 | Admin abuses export or erase | B1 | Admin-only, typed confirmation, audit log; second admin required to reset an admin's two-step login | Partial: one admin today ([open, area 07](architecture-pack.md#07-permissions-and-access-control)) |
| T16 | Audit log tampering | B1, B6 | No API to edit or delete entries; retention purge itself audited | Partial: anyone with server disk access could edit the database ([R-02](registers.md#risk-register)) |
| T17 | Secrets leak via the repository | B5 | `.gitignore` for `.env`, `data/` and signing keys; secret scanning pending | Open: enable GitHub secret scanning (onichajude, 2026-10-13) |
| T18 | Malicious or vulnerable dependency | B5 | Lockfiles, `npm audit` in CI; Expo tooling advisories without fixes accepted | Partial ([R-07](registers.md#risk-register)) |
| T19 | Server or backup disk stolen or lost | B6 | Daily verified backups; disk encryption and off-site encrypted copy pending | Open (hosting, before G6) |
| T20 | Tile host or routing provider sees operational data | B2, B3 | Routing gets stop coordinates only (no identities); tiles reveal the viewer's IP and map area | Accepted pending vendor agreements (area 11) |
| T21 | Error messages leak internals | B1 | Generic message with a reference ID; details only in server logs | Mitigated |
| T22 | Logs leak personal data or secrets | B1 | Logs exclude bodies, query strings, tokens and coordinates; successful GPS uploads not logged | Mitigated |
| T23 | Unsafe use while driving | Product | Automatic arrival and completion; no required interaction while moving | Partial (hazard review in area 19) |

## Verification

- **Baseline:** OWASP ASVS 5.0 Level 2 for the API and web apps. Key mappings are in the [control register](control-register.md).
- **Tests:** [backend/test/security.test.js](../../backend/test/security.test.js), [backend/test/api.test.js](../../backend/test/api.test.js).
- **Independent penetration test:** **pending** before a public or paid launch (onichajude, before G6).
