# ADR-0002: Two driver apps: a web app (PWA) and a native Expo app

- **Status:** Accepted, 2026-10-03
- **Owner:** onichajude

## Context
Dispatch needs drivers' locations during shifts, including when the phone is locked. Phone browsers stop GPS in the background.

## Options
1. Web app only
2. Native app only
3. **Both, on the same API (chosen)**
4. A web app wrapped in Capacitor with a background-location plugin

## Decision
Keep the PWA, which needs no install and suits trials and occasional drivers. Add an Expo (React Native) app that uses `expo-location` background updates and `expo-task-manager`, with an offline queue. Both use the same `/api/driver/*` contract.

## Consequences
- Two clients to keep in step: types are in `mobile/src/types.ts` and must match `backend/server/api.js`.
- Background tracking needs "Always" location permission, app store review and device testing.
- The API stays backward-compatible ([ADR-0006](0006-api-versioning.md)).
