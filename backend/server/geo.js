const R = 6371e3;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Without a routing engine, road distance ≈ straight line × 1.35 at an urban average speed.
export const ROAD_FACTOR = 1.35;
export const AVG_KMH = Number(process.env.AVG_SPEED_KMH || 32);
export const estDriveMs = (a, b) => ((haversine(a, b) * ROAD_FACTOR) / 1000 / AVG_KMH) * 3600e3;

/**
 * Order stops to minimise estimated drive time from `start` and back to `end`
 * (nearest neighbour, then 2-opt). Returns indices into `stops`.
 */
export function optimizeOrder(start, stops, end = start) {
  const n = stops.length;
  if (n < 3) return stops.map((_, i) => i);
  const left = stops.map((_, i) => i);
  const order = [];
  let cur = start;
  while (left.length) {
    let bi = 0;
    for (let j = 1; j < left.length; j++) if (haversine(cur, stops[left[j]]) < haversine(cur, stops[left[bi]])) bi = j;
    cur = stops[left[bi]];
    order.push(left.splice(bi, 1)[0]);
  }
  const cost = (o) => {
    let c = 0, p = start;
    for (const i of o) { c += haversine(p, stops[i]); p = stops[i]; }
    return c + (end ? haversine(p, end) : 0);
  };
  let best = order, bestCost = cost(order), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const o = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
      const c = cost(o);
      if (c < bestCost - 1e-6) { best = o; bestCost = c; improved = true; }
    }
  }
  return best;
}

/**
 * Road geometry and per-leg durations from an OSRM server.
 * Returns { coords: [[lat,lng],...], legs: [seconds,...], meters } or null when unavailable.
 */
export async function roadRoute(points) {
  const base = process.env.ROUTING_URL ?? "https://router.project-osrm.org";
  if (!base || points.length < 2) return null;
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  try {
    const res = await fetch(`${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(Number(process.env.ROUTING_TIMEOUT_MS || 12000)) });
    if (!res.ok) return null;
    const j = await res.json();
    const r = j.routes?.[0];
    if (!r) return null;
    return { coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), legs: r.legs.map((l) => l.duration), meters: r.distance };
  } catch { return null; }
}
