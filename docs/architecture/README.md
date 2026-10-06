# Fleetline architecture pack

This folder is Fleetline's completed copy of **Full-stack software architecture: reusable template and delivery workflow** (v1.0, 6 October 2026). It records the decisions, controls and evidence for the 22 architecture areas and the 8 delivery gates. It is versioned with the code, so each release has matching evidence.

| Document | Covers |
|---|---|
| [architecture-pack.md](architecture-pack.md) | All 22 areas: status, decisions, evidence, pending items |
| [worksheets.md](worksheets.md) | Worksheet 1 (project setup), feature completion records, gate decisions G1–G8, review rhythm |
| [control-register.md](control-register.md) | Worksheet 2: each control traced to implementation, test and result |
| [threat-model.md](threat-model.md) | Assets, actors, trust boundaries, threats and controls |
| [data-and-privacy.md](data-and-privacy.md) | Data inventory, processing register, rights workflows, privacy notice, metric dictionary |
| [permission-matrix.md](permission-matrix.md) | Who can do what, and where it's enforced and tested |
| [registers.md](registers.md) | Legal applicability, vendors, risks (accepted exceptions with expiry), cost model |
| [runbooks.md](runbooks.md) | Deploy and roll back, restore, incidents, privacy requests, lost phone, onboarding, access reviews, retirement |
| [adr/](adr/) | Architecture decision records 0001–0007 |

## Compliance summary (6 October 2026)

**Status meanings:**
- **Applicable:** met, with tested evidence.
- **Partial:** in place, with listed items pending.
- **Pending:** a decision or control is outstanding, with an owner and due date.
- **N/A:** not applicable, with the reason.

| # | Area | Status | Main pending item (owner onichajude) |
|---|---|---|---|
| 01 | Product purpose and boundaries | Applicable | Markets and business model (2026-10-20) |
| 02 | Measurable quality requirements | Partial | Load test and availability measurement (before G5) |
| 03 | System structure and decisions | Applicable | — |
| 04 | Functionality and integrity | Applicable | — |
| 05 | UX, accessibility, localisation | Partial | WCAG 2.2 AA audit (before G5) |
| 06 | Identity and authentication | Applicable | — |
| 07 | Permissions and access control | Applicable | Second admin before launch |
| 08 | Tenant isolation | N/A | Single organisation per deployment; reopen if hosted for several companies |
| 09 | Security design and verification | Partial | Full ASVS assessment; penetration test (before G6) |
| 10 | Data ownership and lifecycle | Applicable | Retention period for business records (2026-10-31) |
| 11 | Privacy operations | Partial | DPIA and legal basis per country (before G5) |
| 12 | Analytics and measurement | Applicable | More reconciliation tests (before G5) |
| 13 | APIs and background work | Applicable | — |
| 14 | Infrastructure and delivery | Partial | Hosting; secret scanning and branch protection (2026-10-13) |
| 15 | Reliability and disaster recovery | Partial | Off-site encrypted backups; timed restore drill |
| 16 | Observability, audit, incidents | Partial | Uptime alerting; breach notification matrix |
| 17 | Testing and release assurance | Partial | Device tests of the native app; load, a11y, pen tests |
| 18 | Legal and contractual applicability | **Pending** | Legal review once markets are chosen (2026-10-31) |
| 19 | Specialist modules | Applicable | — |
| 20 | Admin, support, vendors, cost | Partial | Production tile and routing licences; support model |
| 21 | Launch, maintenance, retirement | Pending | Not launched; gate G6 |
| 22 | Pack and traceability | Applicable | — |

**Delivery stage:**
- **G1:** returned for work (markets and legal scope undecided).
- **G2–G4:** passed with conditions.
- **G5–G6:** not started.

Fleetline is **not ready for production launch**. The work remaining is mostly decisions and assessments that need the owner or a legal adviser, plus hosting.

## How to keep this pack current

- Update the affected sections in the same pull request as the code change.
- Re-check this summary after any change to markets, data, vendors, authentication or hosting, and at least every 6 months.
- Every requirement must be marked applicable, N/A with a reason, or pending with an owner and date. An empty section is not an approved exclusion.

> This pack records engineering controls and evidence. It is not legal advice or certification of compliance with any law or standard.
