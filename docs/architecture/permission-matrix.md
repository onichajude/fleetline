# Permission matrix

Template area 07. Enforced on the server in [api.js](../../backend/server/api.js) (`staff`, `admin`, `driverOnly`, `requireAuthAllowNoMfa`) and [auth.js](../../backend/server/auth.js). Hiding a button in the interface is never the control.

How the rules apply:
- **Staff = admin + dispatcher.** Staff need two-step login turned on before any staff endpoint or the live WebSocket works (`REQUIRE_STAFF_MFA`, default on).
- **Default:** deny. Every endpoint not listed as public requires a valid, unrevoked token for an active, approved account.
- **Audited:** an entry is written to `audit_log`.

| Resource / action | Public | Driver | Dispatcher | Admin | Conditions | Audited |
|---|:-:|:-:|:-:|:-:|---|:-:|
| Sign in | ✓ | | | | Throttled; pending or declined accounts refused | ✓ (success, failure, wrong code) |
| Request a driver account | ✓ | | | | 5 per IP per hour; account stays pending | ✓ |
| Health, config, privacy notice | ✓ | ✓ | ✓ | ✓ | No personal data | |
| Own account: change password | | ✓ | ✓ | ✓ | Current password required; allowed before two-step setup | ✓ |
| Own account: set up two-step login | | ✓ | ✓ | ✓ | Turning it on signs out other sessions | ✓ |
| Own account: turn off two-step login | | ✓ | | | Staff can't while it's required | ✓ |
| Live fleet, tracks, alerts, analytics, team stats | | | ✓ | ✓ | | |
| Driver and vehicle performance pages | | Own only (`/driver/profile`) | ✓ | ✓ | | |
| Places: create, edit, delete | | | ✓ | ✓ | Delete only if unused | ✓ (create, delete) |
| Routes: create, edit, optimise, dispatch, cancel, delete | | | ✓ | ✓ | Edit only before start; delete only drafts | ✓ |
| Vehicles: update, maintenance, record service | | | ✓ | ✓ | | ✓ |
| Vehicles: create | | | | ✓ | | ✓ |
| Drivers: create, edit, deactivate, assign vehicle | | | | ✓ | Deactivate ends sessions | ✓ |
| Approve or decline sign-ups | | | | ✓ | | ✓ |
| Staff accounts: create dispatcher or admin, deactivate | | | | ✓ | Never by self sign-up; can't deactivate yourself; new staff must set up two-step login | ✓ |
| Reset anyone's password | | | | ✓ | Ends that person's sessions | ✓ |
| Reset someone's two-step login | | | | ✓ | Not their own (needs a second admin) | ✓ |
| Export a driver's data | | Own only (`/driver/my-data`) | | ✓ | | ✓ |
| Erase a driver's personal data | | | | ✓ | Type the username; not during an open shift | ✓ |
| View audit log | | | | ✓ | | |
| Driver: shift start and end | | ✓ | | | Privacy notice accepted; vehicle free and not in maintenance | |
| Driver: send GPS | | ✓ | | | Open shift only (409 otherwise) | |
| Driver: start route, arrive, complete, skip | | ✓ | | | Only stops on routes of their open-shift vehicle (404 otherwise) | |
| Driver: pre-trip check | | ✓ | | | Open shift; a problem requires a note | |

**Negative tests:**
- [api.test.js](../../backend/test/api.test.js): a driver calling staff APIs, wrong app, no token.
- [security.test.js](../../backend/test/security.test.js):
  - A driver acting on another vehicle's stops or route
  - A driver exporting someone else's data
  - A dispatcher reading the audit log
  - Staff without two-step login
  - Staff accounts can't be created by sign-up or by a dispatcher
  - Sessions after password change, erasure or two-step change

**Permission changes take effect immediately:** every request reloads the user and checks `token_version`. An open WebSocket keeps receiving dispatch updates until it reconnects ([risk R-09](registers.md#risk-register)).
