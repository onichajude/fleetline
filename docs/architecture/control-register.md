# Control register (Worksheet 2)

One record per control, so a reviewer can trace each requirement into its implementation and verified result.

| | |
|---|---|
| Owner of every control | onichajude |
| Evidence for a release | The git commit plus its CI run (GitHub Actions); test names are linked below |
| Next review | 2027-04-06, or on a change trigger (new market, vendor, data category, auth change) |

**Abbreviations:**
- **AT:** [backend/test/api.test.js](../../backend/test/api.test.js)
- **ST:** [backend/test/security.test.js](../../backend/test/security.test.js)
- **ASVS:** OWASP ASVS 5.0 chapter reference (V-number)

| ID | Requirement | Reason / source | Applies? | Implementation | Verification | Result |
|---|---|---|---|---|---|---|
| C-01 | Privileged accounts use multifactor sign-in | Template area 06; ASVS V6 | Applies | TOTP, required for staff on API and WebSocket (`auth.js`, `security.js`, `index.js`) | ST "staff must set up two-step sign-in; codes can't be reused" | Pass |
| C-02 | Passwords stored with a slow salted hash; minimum length | ASVS V6 | Applies | scrypt + random salt; 8+ characters (`auth.js`) | AT "password changes…" | Pass |
| C-03 | Sessions revoked on password change, reset, deactivation, erasure, two-step change | Area 06; ASVS V7 | Applies | `token_version` in JWT checked on every request | AT, ST | Pass |
| C-04 | Sign-in and sign-up abuse controls; no account enumeration | Area 06/09; ASVS V6 | Applies | Throttles; same error message (`api.js`) | AT "rejects bad credentials…" | Pass. Exception R-05 (throttle in memory) |
| C-05 | Authorisation on the server; default deny; least privilege | Area 07; ASVS V8 | Applies | Role middleware on every endpoint; ownership checks for drivers | AT, ST "a driver can't act on another vehicle's stops" | Pass |
| C-06 | Driver self sign-up requires approval; staff accounts only created by an admin | Area 06/07 | Applies | `approval` state; login refused while pending; `POST /api/users` admin-only | AT "driver sign-up needs admin approval…"; ST "admins create and deactivate staff accounts…" | Pass |
| C-07 | Security-relevant actions recorded in a protected audit log | Area 16; ASVS V16 | Applies | `audit_log` table, append-only via API, admin viewer | ST "audit log records sign-ins…" | Pass. Exception R-02 (disk access) |
| C-08 | Browser security headers (CSP, framing, nosniff, HSTS on HTTPS) | Area 09; ASVS V3 | Applies | `index.js` | ST "health check, security headers…" | Pass |
| C-09 | Injection-safe data access | Area 09; ASVS V1/V2 | Applies | Parameterised SQL only; escaped HTML | Code review; no string-built SQL with user input | Pass (review 2026-10-06) |
| C-10 | Errors don't leak internals; requests traceable | Area 09/16 | Applies | Generic errors with reference ID; JSON request logs without sensitive data | ST "health check…" (malformed JSON) | Pass |
| C-11 | Location collected only during shifts and after notice | Area 11 | Applies | Server refuses shift and GPS without acceptance and an open shift | ST "drivers must accept the privacy notice…" | Pass |
| C-12 | Data subject access and portability | Area 11 | Applies (pending legal confirmation) | `/api/driver/my-data`, `/api/drivers/:id/export` | ST "drivers get their own data…" | Pass |
| C-13 | Erasure on request, including downstream copies | Area 10/11 | Applies | `/api/drivers/:id/erase` (positions, identifiers, alert text); backups rotate within 14 days | ST "drivers get their own data…"; runbook for restores | Pass. Backups: documented exception |
| C-14 | Retention limits enforced automatically | Area 10/11 | Applies | `purgeExpired` at start-up and every 12 h (`maintenance.js`) | ST "start-up retention removes location history…" | Pass |
| C-15 | Critical operations atomic | Area 04 | Applies | Transactions for route + stops, erasure, GPS batches | ST "creating a route with a bad stop leaves nothing behind" | Pass. Exception R-08 |
| C-16 | Retries safe (idempotent GPS intake) | Area 13 | Applies | Unique (vehicle, time) + insert-or-ignore | ST "re-sent GPS batches don't create duplicates…" | Pass |
| C-17 | State transitions enforced | Area 04 | Applies | Status-guarded updates (`fleet.js`) | AT "full delivery cycle…" | Pass |
| C-18 | Backups verified and restorable | Area 15 | Applies | `VACUUM INTO` + integrity check (`maintenance.js`, `npm run backup`) | ST "backups are consistent and verifiable" | Pass. Pending: off-site copy, timed restore drill |
| C-19 | Health monitoring | Area 16 | Applies | `GET /api/health` | ST "health check…" | Pass. Pending: external uptime alerting |
| C-20 | Dependencies checked for known vulnerabilities in CI | Area 14 | Applies | `npm audit` steps in [ci.yml](../../.github/workflows/ci.yml) | CI run | Pass (backend 0 found). Mobile: exception R-07 |
| C-21 | Secrets never committed | Area 06/14 | Applies | `.gitignore`; env vars; JWT secret generated into `data/` | Repository scan 2026-10-06 (no secrets found) | Pass. Pending: GitHub secret scanning |
| C-22 | Accessible interfaces (WCAG 2.2 AA) | Area 05 | Applies | Labels, roles, focus styles, contrast tokens | Audit | **Pending** (before G5) |
| C-23 | Measured quality targets | Area 02 | Applies | Request-time logging; `received_at` on GPS | Load test | **Pending** (before G5) |
| C-24 | Tenant isolation | Area 08 | **N/A**: single organisation per deployment | — | — | Reopen if hosted for several companies |
| C-25 | Legal applicability validated | Area 18 | Applies | Applicability register | Legal review | **Pending** (2026-10-31) |
| C-26 | Independent security assessment | Area 09/17 | Applies before public launch | — | Penetration test | **Pending** (before G6) |

## Exceptions in force

See the [risk register](registers.md#risk-register): R-01 to R-11, each with an owner, mitigation and expiry.
