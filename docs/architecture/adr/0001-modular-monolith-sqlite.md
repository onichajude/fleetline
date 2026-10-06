# ADR-0001: One Node.js service with an embedded SQLite database

- **Status:** Accepted, 2026-10-03 (recorded 2026-10-06)
- **Owner:** onichajude

## Context
A small team (one person) is building fleet tracking for fleets of roughly 5–50 vehicles: an API, real-time updates, two web apps and background jobs. The target is 99.5% availability and USD 50/month.

## Options
1. **One Node.js process with SQLite (chosen)**
2. Node.js + PostgreSQL on a managed database
3. Separate services (API, real-time, jobs) with a queue
4. Serverless functions + hosted database + hosted pub/sub

## Decision
Option 1. Express serves the API and static apps, Socket.IO handles push, and in-process timers run jobs. SQLite runs through Node's built-in `node:sqlite` (no native build step).

## Consequences
- **Good:**
  - Simple deployment and backups (one file, `VACUUM INTO`)
  - Writes are serialised, which makes integrity rules simple (area 04)
  - Cheap
  - Fast for this workload
- **Bad:**
  - **Only one server process.** Running several processes or instances would break live state and write ordering.
  - Availability is limited to one host.
  - `node:sqlite` is newer than the mature drivers.
- **Revisit when:**
  - More than ~200 vehicles
  - More than one company per instance (area 08)
  - Availability above 99.5%
  - A second process is needed

  Then the path is PostgreSQL + a shared pub/sub for Socket.IO.
