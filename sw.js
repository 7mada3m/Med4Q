"use strict";

// Increment VERSION whenever the HTML, CSS, JS, manifest, or icons change.
const VERSION = "v1";
const BASE = new URL(self.registration.scope);
const PREFIX = `mid4q-shell:${BASE.pathname}:`;
const CACHE = PREFIX + VERSION;
const INDEX = new URL("index.html", BASE).href;
const ASSETS = ["index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png"].map((path) => new URL(path, BASE).href);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) =>
    cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" })))));
  // Normal lifecycle: an update waits until existing app tabs have closed.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== BASE.origin) return;
  const canonical = `${url.origin}${url.pathname}`;
  const home = request.mode === "navigate" &&
    (url.pathname === BASE.pathname || canonical === INDEX);
  if (!home && !ASSETS.includes(canonical)) return;
  // Drive requests are untouched. app.js owns network-first catalog caching.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Keep the shell on one version until the waiting worker can activate.
    return (await cache.match(home ? INDEX : canonical)) || fetch(request);
  })());
});
