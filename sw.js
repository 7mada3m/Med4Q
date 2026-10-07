/*!
 * mid4Q service worker.
 *
 * Online, every same-origin GET goes to the network first, so the app always
 * gets the newest index.html, app.js, style.css and catalog.json. The cache is
 * only a fallback:
 *  - Pages: if the network fails or gives no answer within 4 s, the cached
 *    page is used, and that page's CSS/JS then come from the cache as well,
 *    so a page never runs with a mix of old and new files.
 *  - catalog.json: the cached copy is used only when the network fails, and it
 *    is labelled (X-Mid4Q-Fallback header) so the app can say it is showing a
 *    saved list and refetch once the connection is back.
 *
 * Google Drive requests (thumbnails, the player iframe, downloads) are never
 * intercepted: they are cross-origin, and caching opaque responses would waste
 * storage quota.
 *
 * Bump CACHE_VERSION whenever you change the PRECACHE lists below.
 */
const CACHE_VERSION = 'v1';
const SCOPE_URL = new URL(self.registration.scope);
// Scoped by path: all of a user's GitHub Pages project sites share one origin and one CacheStorage.
const CACHE_PREFIX = `mid4q:${SCOPE_URL.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const SHELL_URL = new URL('index.html', SCOPE_URL).href;
const PAGE_TIMEOUT_MS = 4000;
const FALLBACK_HEADER = 'X-Mid4Q-Fallback';

// Paths are relative to this file, so the app works from https://<user>.github.io/<repo>/.
const PRECACHE_REQUIRED = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest'];
const PRECACHE_OPTIONAL = [
  'catalog.json',
  'icons/icon.svg',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

// Pages that were answered from the cache. Their CSS/JS are served from the same cached generation.
const cachedPageClients = new Set();

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // `cache: 'reload'` skips the HTTP cache so a new version never precaches stale files.
    await cache.addAll(PRECACHE_REQUIRED.map((path) => new Request(path, { cache: 'reload' })));
    // Optional files must never break installation (e.g. a missing icon).
    await Promise.all(PRECACHE_OPTIONAL.map((path) =>
      cache.add(new Request(path, { cache: 'reload' })).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;        // Google Drive & other hosts: untouched
  if (!url.pathname.startsWith(SCOPE_URL.pathname)) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return; // DevTools quirk

  const isNavigation = request.mode === 'navigate';
  const isShell = isNavigation &&
    (url.pathname === SCOPE_URL.pathname || url.pathname === `${SCOPE_URL.pathname}index.html`);
  const cacheKey = isShell ? SHELL_URL : request;
  const network = fetch(request);

  // Refresh the cache in the background. The copy is cloned synchronously,
  // before the page starts reading the response body.
  event.waitUntil(network.then((response) => {
    if (!isCacheable(response)) return undefined;
    const copy = response.clone();
    return caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
  }).catch(() => undefined));

  if (isNavigation) event.respondWith(pageResponse(event, network, cacheKey));
  else if (url.pathname.endsWith('/catalog.json')) event.respondWith(catalogResponse(network, cacheKey));
  else event.respondWith(assetResponse(event, network, cacheKey));
});

function isCacheable(response) {
  return Boolean(response) && response.ok && response.type === 'basic' && !response.redirected;
}

async function cachedCopy(cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(cacheKey, { ignoreSearch: true });
}

/** Pages: network first; the cached page after a failure or PAGE_TIMEOUT_MS without an answer. */
async function pageResponse(event, network, cacheKey) {
  const cached = (await cachedCopy(cacheKey)) || (await cachedCopy(SHELL_URL));
  if (!cached) return network; // nothing saved yet: surface the network result or error

  const useCached = () => {
    if (event.resultingClientId) cachedPageClients.add(event.resultingClientId);
    return cached;
  };
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (pick) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pick());
    };
    timer = setTimeout(() => finish(useCached), PAGE_TIMEOUT_MS);
    network.then(
      // A redirect (e.g. after moving to a custom domain) must reach the browser so it can follow it.
      (response) => finish(() => (response.ok || response.type === 'opaqueredirect' ? response : useCached())),
      () => finish(useCached),
    );
  });
}

/** CSS, JS, icons: same generation as their page; otherwise network first with a cache fallback. */
async function assetResponse(event, network, cacheKey) {
  if (cachedPageClients.has(event.clientId)) {
    const cached = await cachedCopy(cacheKey);
    if (cached) return cached;
  }
  try {
    const response = await network;
    if (response.ok) return response;
    return (await cachedCopy(cacheKey)) || response;
  } catch (error) {
    const cached = await cachedCopy(cacheKey);
    if (cached) return cached;
    throw error;
  }
}

/** catalog.json: network first; a cached copy only on failure, labelled so the app knows. */
async function catalogResponse(network, cacheKey) {
  let reason = 'offline';
  try {
    const response = await network;
    if (response.ok) return response;
    reason = String(response.status);
  } catch {
    /* network failure: fall back below */
  }
  const cached = await cachedCopy(cacheKey);
  if (!cached) return network; // no saved copy: surface the real response or error
  const headers = new Headers(cached.headers);
  headers.set(FALLBACK_HEADER, reason);
  return new Response(cached.body, { status: 200, statusText: 'OK', headers });
}
