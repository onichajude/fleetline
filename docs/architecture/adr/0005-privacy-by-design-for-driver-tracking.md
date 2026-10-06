# ADR-0005: Privacy by design for driver tracking

- **Status:** Accepted, 2026-10-06
- **Owner:** onichajude (legal validation pending, area 18)

## Context
Fleetline monitors workers: live location, speed, delivery times and rankings. Many jurisdictions require notice, a lawful basis, data minimisation, limited retention and rights handling. Employee consent is often not considered freely given.

## Decision
1. **Shift-only collection:** the server refuses GPS outside an open shift.
2. **Notice before collection:** a shift can't start until the driver accepts the current versioned notice. Acceptance is stored and audited, and a new version requires acceptance again. The basis isn't consent; the notice informs.
3. **Retention by default:** positions are kept 180 days, alerts 365 and the audit log 730, purged automatically.
4. **Rights built in:** drivers download their own data; admins export and erase. Erasure keeps business records without identity.
5. **No third-party trackers or analytics.**
6. **Accountability:** every privacy action is in the audit log.

## Consequences
- A DPIA and per-country legal review are still required before launch.
- Restored backups can bring back erased data; the runbook requires re-applying erasures.
- Rankings need an employer policy before they're used for decisions (risk R-10).
