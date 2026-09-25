// sw.js — minimal offline shell. Caches the static app; every /api/* call
// (rooms, the WebSocket) always goes to the network — a stale cache should
// never serve game traffic.
const CACHE = "match-it-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // never cache game traffic
  if (event.request.method !== "GET") return;

  // Network first, cache as the offline fallback: a cache-first shell would
  // pin players to whatever version they first loaded, forever. Invite links
  // (/?room=123456) fall back to the cached "/" via ignoreSearch.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          const key = event.request.mode === "navigate" ? "/" : event.request;
          caches.open(CACHE).then((cache) => cache.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match("/")))
  );
});
