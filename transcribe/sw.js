const CACHE_NAME = 'transcribe-v2';
const SHELL = [
  '/transcribe/',
  '/transcribe/app.js',
  '/transcribe/style.css',
  '/transcribe/favicon.svg',
  '/transcribe/manifest.json',
];

const DB_NAME = 'transcribe-share';
const STORE_NAME = 'shared-audio';

// ── Install: cache app shell ────────────────────────────────────────

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

// ── Activate: clean old caches ──────────────────────────────────────

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: handle share target POSTs + cache-first for shell ────────

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Web Share Target: intercept the POST, stash files, redirect to app
  if (e.request.method === 'POST' && url.pathname === '/transcribe/') {
    e.respondWith(handleShareTarget(e.request));
    return;
  }

  // Standard cache-first for GET requests
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
  }
});

/** Store shared audio files in IndexedDB so the app can pick them up. */
async function handleShareTarget(request) {
  const formData = await request.formData();
  const files = formData.getAll('audio');

  if (files.length) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const file of files) store.put(file);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // Redirect to the app so it picks up the stashed files
  return Response.redirect('/transcribe/', 303);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
