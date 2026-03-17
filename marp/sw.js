const CACHE_NAME = 'marp-renderer-v1';
const STATIC_ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'favicon.svg',
  'icons/icon-192.svg',
  'icons/icon-512.svg',
  'manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(err => console.error('SW install failed:', err))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).catch(err => console.error('SW activate failed:', err))
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Network-first for CDN resources
  if (url.origin !== location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone))
            .catch(err => console.error('SW cache put failed:', err));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for local assets
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request))
      .catch(err => { console.error('SW fetch failed:', err); })
  );
});
