const CACHE_NAME = 'shelter-v16';

const STATIC_ASSETS = [
  '/shelter/',
  '/shelter/index.html',
  '/shelter/app.js',
  '/shelter/style.css',
  '/shelter/shelters.json',
  '/shelter/favicon.svg',
  '/shelter/manifest.json',
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all([
        cache.addAll(STATIC_ASSETS),
        ...EXTERNAL_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('Failed to cache external:', url, err))
        ),
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // Network-first for map tiles (too many to cache, change often)
  if (e.request.url.includes('basemaps.cartocdn.com')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // CDN assets: cache-first, but fetch-and-store on cache miss so they're
  // available offline after the first successful load even if install caching failed.
  if (e.request.url.includes('unpkg.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // Cache-first for all own assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
