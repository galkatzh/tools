const CACHE_NAME = 'spaced-repetition-v3';

// Local app shell — must be cached for the app to start offline.
const SHELL = [
  '/spaced-repetition/',
  '/spaced-repetition/index.html',
  '/spaced-repetition/app.js',
  '/spaced-repetition/style.css',
  '/spaced-repetition/manifest.json',
  '/spaced-repetition/favicon.svg',
  '/spaced-repetition/js/config.js',
  '/spaced-repetition/js/auth.js',
  '/spaced-repetition/js/github.js',
  '/spaced-repetition/js/parser.js',
  '/spaced-repetition/js/srcomment.js',
  '/spaced-repetition/js/scheduler.js',
  '/spaced-repetition/js/render.js',
  '/spaced-repetition/js/store.js',
  '/spaced-repetition/js/sync.js',
];

// Requests to these hosts carry auth/data and must never be cached.
const NO_CACHE_HOSTS = ['api.github.com', 'github.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first with runtime caching: CDN libraries fetched at runtime get
// cached on first use, so the app works fully offline thereafter.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (NO_CACHE_HOSTS.includes(new URL(e.request.url).hostname)) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch((err) => {
          if (cached) return cached;
          throw err;
        });
      return cached || network;
    })
  );
});
