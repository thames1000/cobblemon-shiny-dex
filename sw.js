/* Service worker.
 *
 * Strategy:
 *  - App's own files (HTML/JS/CSS/JSON, same-origin): NETWORK-FIRST. Always try
 *    the network so new deploys show up immediately; fall back to cache offline.
 *    (Cache-first here caused stale code to stick on devices between updates.)
 *  - Remote sprites: CACHE-FIRST (immutable, fine to keep forever).
 *
 * Bump CACHE on every release so old caches are purged on activate.
 */
const CACHE = "shinydex-hq-v64";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/app.js",
  "./js/cloud.js",
  "./js/biome-worker.js",
  "./js/firebase-config.js",
  "./js/data/species.json",
  "./js/data/forms.json",
  "./js/data/spawns.json",
  "./js/data/berries.json",
  "./js/data/berry-guide.json",
  "./js/data/moves.json",
  "./js/data/coach.json",
  "./js/data/variants.json",
  "./js/data/legendaries.json",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isSprite = url.pathname.includes("/sprites/pokemon/");

  // Let the browser handle cross-origin requests we don't explicitly cache
  // (e.g. Showdown variant sprites) — don't route them through the SW at all.
  if (url.origin !== location.origin && !isSprite) return;

  if (isSprite) {
    // Cache-first for immutable sprite assets.
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Network-first for everything same-origin (and anything else): freshest wins,
  // cache is the offline fallback and is refreshed on every successful fetch.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
