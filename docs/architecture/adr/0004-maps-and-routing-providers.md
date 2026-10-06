# ADR-0004: Configurable map tiles and routing; free public services for testing only

- **Status:** Accepted, 2026-10-03; tile default changed the same day
- **Owner:** onichajude

## Context
The console needs a street map, and route planning needs road distances and times.

**History:**
- OpenStreetMap's volunteer tile servers blocked the app (their usage policy forbids this kind of app traffic).
- CARTO basemaps now require an API key.
- Esri's World Street Map works without a key for development.

## Decision
- **Tiles:** Leaflet with `TILE_URL` and `TILE_ATTRIBUTION` from config. The default is Esri World Street Map, **for testing only**.
- **Routing:** OSRM via `ROUTING_URL`. The default is the public demo server, **for testing only**. If it's unset or fails, Fleetline falls back to straight-line estimates.
- **Failure behaviour:** both are optional to core function. Tiles retry three times; routing has a 12 s timeout.

## Consequences
- **Before launch:**
  - Choose a licensed tile provider (or self-host) and self-host OSRM, or use a paid routing API.
  - Record both in the vendor register with data-processing terms. The tile host sees viewers' IP addresses; the routing provider receives stop coordinates.
- **Privacy:** no driver identities are sent to either provider.
