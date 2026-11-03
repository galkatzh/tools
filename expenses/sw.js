// Service Worker for Expense Report Manager PWA: offline cache + Web Share Target receiver.
const CACHE_NAME = 'expense-report-v6';
const SHARE_CACHE = 'expense-share'; // shared files handed over to the page; keep in sync with app.js
const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
    './favicon.svg',
    './icons/icon-192.svg',
    './icons/icon-512.svg',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('error', (e) => console.error('[sw] error:', e.message, e.error));
self.addEventListener('unhandledrejection', (e) => console.error('[sw] unhandled rejection:', e.reason));

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME && n !== SHARE_CACHE).map((n) => caches.delete(n))
    )));
    self.clients.claim();
});

/**
 * Web Share Target (manifest.json → share_target): Android/Chrome POSTs the shared files here.
 * Stash them in SHARE_CACHE and redirect to the app, which picks them up on load (receiveShared in app.js).
 */
async function receiveShare(request) {
    try {
        const form = await request.formData();
        const files = form.getAll('files').filter((f) => typeof f !== 'string');
        await caches.delete(SHARE_CACHE);
        const cache = await caches.open(SHARE_CACHE);
        await Promise.all(files.map((f, i) => cache.put(`./shared/${i}`, new Response(f, {
            headers: { 'Content-Type': f.type, 'X-File-Name': encodeURIComponent(f.name) }
        }))));
        const title = form.get('title') || '';
        return Response.redirect(`./?shared=${files.length}&title=${encodeURIComponent(title)}`, 303);
    } catch (error) {
        console.error('[sw] share target failed:', error);
        return Response.redirect(`./?share-error=${encodeURIComponent(error.message)}`, 303);
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/share-target')) {
        event.respondWith(receiveShare(request));
        return;
    }
    if (request.method !== 'GET') return;

    // Everything we need is precached at fixed versions: serve from cache, fall back to the network.
    const cached = request.mode === 'navigate' ? caches.match('./index.html') : caches.match(request);
    event.respondWith(cached.then((response) => response || fetch(request)));
});
