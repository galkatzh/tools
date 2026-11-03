const CACHE_NAME = 'ear-training-v6';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './audio.js',
  './theory.js',
  './stats.js',
  './melody-quiz.js',
  './chord-quiz.js',
  './manifest.json',
  './favicon.svg',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  // Shared with Jam: bump CACHE_NAME when they change too, or the app keeps the cached copies
  '../jam/synth.js',
  '../jam/keyboard.js'
];

self.addEventListener('error', (e) => console.error('SW error:', e.error || e.message));
self.addEventListener('unhandledrejection', (e) => console.error('SW unhandled rejection:', e.reason));

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
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

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((response) => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return response;
      }).catch((err) => {
        console.error('Fetch failed:', err);
      });
    })
  );
});
