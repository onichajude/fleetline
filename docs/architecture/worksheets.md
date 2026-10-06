# Worksheets: project setup, feature completion, gate decisions

## Worksheet 1: project setup and working records

| Project field | Value |
|---|---|
| Product and accountable owner | Fleetline. Owner: onichajude (sole team member). Review date: 2027-04-06 |
| Users, platforms and markets | Admins, dispatchers, drivers. Web console, driver PWA, Android/iOS app. **Markets pending** (onichajude, 2026-10-20) |
| Scope and critical journeys | [Area 01](architecture-pack.md#01-product-purpose-and-boundaries-applicable): J1–J7; exclusions listed there |
| Data and specialist modules | [Data inventory](data-and-privacy.md#data-inventory); high-sensitivity data is location and credentials. Modules: mobile/offline, worker monitoring, driving safety ([area 19](architecture-pack.md#19-specialist-product-modules-applicable)) |
| Quality and recovery targets | 99.5% monthly availability; GPS p95 ≤ 10 s; API p95 ≤ 300 ms; RPO 24 h; RTO 4 h ([area 02](architecture-pack.md#02-measurable-quality-requirements-partial)) |
| Architecture and environments | [Area 03](architecture-pack.md#03-system-structure-and-architecture-decisions-applicable); [ADRs](adr/). Environments: local and test. Staging and production pending ([ADR-0007](adr/0007-hosting.md)) |
| Legal and vendor scope | [Applicability register](registers.md#applicability-register) (pending); [vendor register](registers.md#vendor-register) |
| Delivery and operations | Gates below. Approver for all gates: onichajude; independent reviewer pending (R-11). Support and escalation pending |
| Cost and support lifetime | ≤ USD 50/month for 50 vehicles; support 2 years from launch ([cost model](registers.md#cost-model)) |

## Feature completion records

The feature rule: a feature is complete when its journey, outcome, permission boundaries, failure behaviour, measurement and operating needs are verified together.

**Columns:**
- **Permission tests / Failure tests:** test files AT / ST (see [control register](control-register.md)).
- **A11y:** accessibility.
- **Acceptance:** onichajude for every feature.

| Feature | Requirement | Design / API | Permission tests | Failure tests | A11y | Analytics | Privacy / security review | Runbook | Acceptance |
|---|---|---|---|---|---|---|---|---|---|
| F1 Live tracking | J2 | `/api/driver/positions`, Socket.IO | ST cross-driver, notice gate | Offline queue; duplicate batches (ST) | Pending audit | Distance, driving hours ([dictionary](data-and-privacy.md#metric-dictionary)) | [Threat model](threat-model.md) T9, T10 | [Incident](runbooks.md#incident-response) | Code accepted 2026-10-06; on-device test pending |
| F2 Route planning and dispatch | J3 | `/api/routes*` | AT role checks | Bad stops leave nothing (ST); busy vehicle refused | Pending | On-time % | T4 | — | Accepted 2026-10-06 |
| F3 Deliveries and geofence | J4 | `/api/driver/stops/*` | ST other vehicle's stops | Auto-complete when driving away (AT) | Pending | Deliveries, on-time % | T4 | — | Accepted 2026-10-06 |
| F4 Driver sign-up and approval | J1 | `/api/auth/register`, `/api/users/:id/approve` | AT pending login refused | Duplicate username, weak password (AT) | Pending | — | T12 | [Onboarding](runbooks.md#staff-onboarding-and-offboarding) | Accepted 2026-10-06 |
| F5 Performance and rankings | J5 | `/api/team`, `/api/*/profile` | AT driver can't read others | No history → "first week" | Pending | Metric dictionary | R-10 (fairness), open | — | Accepted 2026-10-06; policy pending |
| F6 Vehicle condition and checks | — | `/api/driver/inspection`, `/api/vehicles/:id/service` | AT | Problem requires a note (AT) | Pending | Condition rules | — | — | Accepted 2026-10-06 |
| F7 Passwords and two-step login | J6 | `/api/me/password`, `/api/me/mfa/*`, `/api/users/:id/*` | AT, ST | Wrong code, replay, revocation (ST) | Pending | — | T1, T2 | [Lost phone](runbooks.md#lost-phone-or-locked-out-staff) | Accepted 2026-10-06 |
| F8 Privacy notice, export and erasure | J7 | `/api/driver/privacy-ack`, `/my-data`, `/api/drivers/:id/export`, `/erase` | ST | Erase during shift refused; wrong confirmation (ST) | Pending | — | Area 11, DPIA pending | [Privacy requests](runbooks.md#privacy-requests) | Code accepted 2026-10-06; legal review pending |
| F9 Audit, health, retention, backups | — | `/api/audit`, `/api/health`, `maintenance.js` | ST dispatcher denied audit | Backup verification (ST) | — | — | T16, T19 | [Backup and restore](runbooks.md#restore-from-backup) | Accepted 2026-10-06; drill pending |

## Gate decision records

Delivery stage today: **between 4 (feature slices) and 5 (validation).**

| Gate | Evidence | Findings | Decision | Conditions / follow-up | Approver |
|---|---|---|---|---|---|
| **G1** Scope and risk accepted | Area 01, data classification, applicability register | Markets, business model and legal scope undecided | **Return for work** | Decide markets and business model (2026-10-20); legal applicability (2026-10-31) | onichajude + legal adviser |
| **G2** Design ready | Architecture pack, ADRs, threat model, permission matrix, data inventory | Major risks have planned controls; DPIA outstanding | **Pass with conditions** (design-level) | DPIA before G5 | onichajude (independent review pending, R-11) |
| **G3** Foundation verified | CI pipeline; 16 end-to-end tests; auth, permissions, audit, migrations, backups | Staging environment missing; secret scanning off | **Pass with conditions** | Enable secret scanning and branch protection (2026-10-13); staging with hosting | onichajude |
| **G4** Features accepted | Feature records F1–F9; tests for success, forbidden and failure paths | Accessibility not audited; native app not tested on devices | **Pass with conditions** | Accessibility audit and device tests before G5 | onichajude |
| **G5** Release candidate qualified | — | Load test, a11y audit, restore drill, DPIA, legal review outstanding | **Not started** | — | Quality, security, legal owners (to be named) |
| **G6** Production release | — | No hosting, monitoring, support plan or penetration test | **Not started** | — | Release authority: onichajude; independent reviewer required |
| **G7** Continued operation | — | — | Not applicable yet | — | — |
| **G8** Closure | [Retirement plan](runbooks.md#retirement) | — | Not applicable | — | — |

## Review rhythm

- **Every release:**
  - Affected risks, tests, permission changes, data changes and evidence (CI run)
  - Run `npm run backup` before deploying
- **Monthly:**
  - `npm audit` results and dependency updates
  - Risk R-07 recheck
  - Costs against budget
- **Quarterly:**
  - Access review: staff accounts and audit log
  - Vendor review
- **Every 6 months:**
  - Restore drill
  - Architecture pack review
  - Legal reassessment
