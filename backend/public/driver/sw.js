// App-shell cache so the driver app opens without signal. API calls always go to the network.
const CACHE = "fleetline-driver-v4";
const SHELL = ["/driver/", "/driver/app.js", "/driver/extras.js", "/driver/style.css", "/driver/icon.svg", "/driver/manifest.webmanifest",
  "/shared/client.js", "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;
  // Network first, cached copy when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("/driver/"))));
});
