# Registers: applicability, vendors, risks, cost

Template areas 18, 20, 09 and 17. Owner: onichajude.

## Applicability register

**Status: pending.** Fleetline has no chosen market yet; the demo data is in Houston, Texas, USA. Nothing below is a legal conclusion. Each row must be assessed by a qualified legal or compliance adviser for the chosen countries, with the decision, source, effective date and review date recorded. **Owner:** onichajude with a legal adviser. **Due:** 2026-10-31 (and before gate G1 passes).

| Area | Candidate obligations to assess | Why it may apply | Current control | Status |
|---|---|---|---|---|
| Data protection (Nigeria) | Nigeria Data Protection Act 2023 and the NDPC GAID 2025 [S6] | If operated in Nigeria or with Nigerian drivers | Notice, retention, rights workflows, audit | Pending |
| Data protection (EU / UK) | GDPR / UK GDPR, especially lawful basis for monitoring employees, DPIA, transfers [S3] | If drivers are in the EU or UK | Same; DPIA not done | Pending |
| Data protection (US) | State privacy laws. California CCPA/CPRA covers employee data [S7]; others vary | If drivers or customers are in those states | Same | Pending |
| Employee monitoring | Some places require notice or consent for electronic monitoring of workers (for example several US states, EU works-council rules) | Live location and performance rankings of workers | In-app notice before collection; shift-only | Pending |
| Online tracking / cookies | ePrivacy / PECR [S4] | Web apps store a session token on the device | Strictly necessary storage only; no analytics or ads | Likely satisfied; confirm |
| Accessibility | ADA (US), European Accessibility Act, local laws [S1] | Customer or public-sector contracts, EU market | WCAG 2.2 AA target; audit pending | Pending |
| Road transport and vehicle safety | Driver hours rules, vehicle inspection record-keeping | Commercial vehicles | Shift hours and pre-trip checks recorded; not a compliance tool | Pending |
| Distracted driving | Laws on phone use while driving | Drivers use the app in vehicles | No interaction needed while moving; mount and hands-free guidance in driver training | Pending |
| Payments (PCI DSS) [S8] | — | **N/A**: no payments | — | N/A |
| Health data (HIPAA) [S9] | — | **N/A**: no health data | — | N/A |
| Children (COPPA) [S10] | — | **N/A**: adult workers only | — | N/A |
| AI (EU AI Act) [S11] | — | **N/A**: no AI systems. Note: AI used for worker evaluation would be high-risk | — | N/A; reassess if AI is added |
| Security certification | ISO/IEC 27001 [S12], SOC 2 [S13] | Only if customers require it; neither proves legal compliance | Not pursued | N/A for now |
| App stores | Google Play background-location policy and declaration; Apple location usage review | Native app uses background location | Permission texts in `mobile/app.config.ts` | Pending before store submission |

Source references [S1]–[S13] are the official sources listed on page 21 of the template.

## Vendor register

| Vendor | What it does | Data shared | Security evidence | Exit option | Status |
|---|---|---|---|---|---|
| GitHub | Code hosting, CI | Source code (no personal data) | Vendor's SOC 2 | Any git host | In use |
| npm registry | Packages | None | Lockfiles; `npm audit` | Mirror or vendored packages | In use |
| Esri (World Street Map tiles) | Map background | Viewer IP address, map area requested | Terms to review | `TILE_URL`: MapTiler, Stadia, Mapbox, self-hosted | **Testing only. Production licence or replacement pending** |
| OSRM public demo (router.project-osrm.org) | Road routes and travel times | Stop coordinates (no identities) | None; demo service, no SLA | Self-host OSRM; `ROUTING_URL=` (empty) for straight lines | **Testing only. Replace before launch** |
| Google Fonts | Web fonts | Viewer IP address | — | Self-host fonts | In use; consider self-hosting (privacy) |
| Expo / EAS | Builds and signs the native app | Source code, signing credentials | Vendor documentation | Local builds with Android Studio / Xcode | When building the app |
| Google Maps / Apple Maps | Turn-by-turn navigation | Destination of the next stop (from the driver's phone) | Phone OS vendors | Any navigation app | In use |
| Cloudflare (quick tunnel) | Temporary https link for phone tests | All traffic passes through | Vendor's SOC 2; account-less tunnels have no SLA | Proper hosting | **Testing only** |
| Hosting provider | Runs the server | Everything | To assess | — | **Pending** ([ADR-0007](adr/0007-hosting.md)) |

Before a vendor receives personal data in production, record: data processing agreement, sub-processors, region, incident contact, and data return or deletion at exit.

## Risk register

Accepted risks need a mitigation, an owner (onichajude unless stated) and an expiry date, after which they must be reassessed.

| ID | Risk | Likelihood / impact | Mitigation | Decision | Expires |
|---|---|---|---|---|---|
| R-01 | Web session tokens in localStorage can be stolen by XSS | Low / High | Strict CSP without inline scripts; escaping everywhere; 14-day expiry; revocation | Accepted | 2027-04-06 (consider httpOnly cookies + CSRF tokens) |
| R-02 | Someone with server disk access could change the audit log | Low / Medium | Restrict server access; ship logs and backups off-host (pending) | Accepted | 2027-01-06 |
| R-03 | Queued GPS fixes on a lost phone aren't encrypted | Low / Medium | Queue empties within seconds when online; OS-level device encryption; sign-out clears it | Accepted | 2027-04-06 |
| R-04 | No general rate limiting or WAF | Medium / Medium | Body and batch limits; sign-in and sign-up throttles; add proxy rate limiting at hosting | Accepted until hosting | 2026-12-31 |
| R-05 | Sign-in throttle resets when the server restarts | Low / Low | Two-step login for staff; strong passwords | Accepted | 2027-04-06 |
| R-06 | GPS can be spoofed on rooted or jailbroken phones | Low / Medium | Accuracy and speed filters; audit; figures traceable | Accepted | 2027-04-06 |
| R-07 | Expo build tooling has 15 high advisories (`braces`, `node-forge`) with no published fix; they are in development tooling, not in the shipped app | Low / Low | CI fails on critical; `uuid` pinned to the fixed version; recheck monthly | Accepted | 2026-11-06 |
| R-08 | Creating a route isn't idempotent if the client retries after a timeout | Low / Low | Button disabled while saving; duplicates are visible drafts | Accepted | 2027-04-06 |
| R-09 | An open WebSocket keeps receiving updates after that user's password is reset, until it reconnects | Low / Medium | Reconnects use the new check; sessions on the API end immediately | Accepted | 2027-01-06 (add server-side socket disconnect on revocation) |
| R-10 | Rankings may be unfair (part-time drivers, hard routes) and affect jobs | Medium / High | Show averages and context; don't use rankings alone for decisions; employer policy needed | **Open**: employer policy pending (area 11) | 2026-10-31 |
| R-11 | One person holds every role (no independent approval) | High / Medium | Name a second admin and an independent reviewer before launch | **Open** | Before G6 |

## Cost model

Estimated monthly cost for up to 50 vehicles (owner: onichajude; check against real invoices monthly):

| Item | Estimate | Notes |
|---|---|---|
| Hosting (1 small server + disk) | USD 5–15 | Railway, Render or a VPS ([ADR-0007](adr/0007-hosting.md)) |
| Off-site backup storage | < USD 1 | A few GB |
| Map tiles (production licence) | USD 0–50 | Depends on provider and map views |
| Routing | USD 0–20 | Self-hosted OSRM on the same server, or a paid API |
| Apple Developer / Google Play | USD 99/year + USD 25 once | Only for store distribution |
| **Budget ceiling** | **USD 50 / month** | Area 02 |

**Unit cost to track:** cost per active vehicle per month.
**Expensive-abuse controls:** sign-up throttle, GPS batch limits, routing calls only when routes change.
