// Shared browser helpers for the dispatch console and the driver app.
export function createClient(storageKey) {
  const read = () => { try { return JSON.parse(localStorage.getItem(storageKey)) || null; } catch { return null; } };
  let session = read();
  const listeners = new Set();

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && session) { logout(); throw new Error("Your session expired. Sign in again."); }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code, data });
    return data;
  }
  function logout() {
    session = null;
    try { localStorage.removeItem(storageKey); } catch {}
    listeners.forEach((fn) => fn(null));
  }
  return {
    get session() { return session; },
    onSession(fn) { listeners.add(fn); },
    async login(username, password, app, code) {
      const s = await request("POST", "/api/auth/login", { username, password, app, ...(code ? { code } : {}) });
      session = s;
      try { localStorage.setItem(storageKey, JSON.stringify(s)); } catch {}
      listeners.forEach((fn) => fn(s));
      return s;
    },
    logout,
    /** Keeps the session after a password change, which invalidates the old token. */
    setToken(token) {
      if (!session) return;
      session = { ...session, token };
      try { localStorage.setItem(storageKey, JSON.stringify(session)); } catch {}
    },
    get: (u) => request("GET", u),
    /** Downloads an authenticated JSON endpoint as a file. */
    async download(url, filename) {
      const data = await request("GET", url);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
    post: (u, b = {}) => request("POST", u, b),
    patch: (u, b = {}) => request("PATCH", u, b),
    del: (u) => request("DELETE", u),
  };
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const hm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
export function ago(t, now = Date.now()) {
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
}
export function haversine(a, b) {
  const r = (d) => (d * Math.PI) / 180, R = 6371e3;
  const s = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export const localDate = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Leaflet tile layer that retries failed tiles (up to 3 times), so a flaky connection doesn't leave blank squares. */
export function tileLayer(url, opts) {
  const layer = window.L.tileLayer(url, opts);
  layer.on("tileerror", ({ tile }) => {
    const n = Number(tile.dataset.retry || 0);
    if (n >= 3) return;
    tile.dataset.retry = String(n + 1);
    const base = tile.src.replace(/[?&]_r=\d+$/, "");
    setTimeout(() => { tile.src = `${base}${base.includes("?") ? "&" : "?"}_r=${n + 1}`; }, 800 * (n + 1));
  });
  return layer;
}
