// Service worker: precaches the app shell so the PWA opens instantly (and
// mostly works offline) once installed, and keeps page fetches (/api/*)
// live by trying the network first.

const CACHE_VERSION = 'wsr-v1';

const APP_SHELL = [
  '/',
  '/css/style.css',
  '/js/main.js',
  '/js/speech.js',
  '/js/navigator.js',
  '/js/ocr.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API calls should stay live; only fall back to a cached copy if offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Everything else: cache-first, populating the cache from the network on
  // first fetch (and refreshing it on subsequent successful fetches).
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
