# ADR-0006: Additive-only changes to an unversioned API

- **Status:** Accepted, 2026-10-06
- **Owner:** onichajude

## Context
The web apps are served by the same server, so they always match it. Native app versions stay on phones for months.

## Decision
- **One `/api` with additive changes only:** new fields and endpoints are fine; existing fields keep their meaning and type.
- **Breaking changes** need a new prefix (`/api/v2`). The old version stays supported for at least 90 days after a native-app release that uses the new one.
- **Error responses** keep the shape `{ error, code? }`.
- **Database schema changes** are also additive (`addColumn`), so rolling back code is safe.

## Consequences
- Small duplication when something must change shape.
- **Revisit** if third parties integrate with the API; at that point, publish an OpenAPI contract.
