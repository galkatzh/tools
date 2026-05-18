// IndexedDB persistence: a pending-review queue (for offline sync) and a
// deck cache (so decks can be reviewed without connectivity).

const DB_NAME = 'srs-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pendingReviews')) {
        db.createObjectStore('pendingReviews', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('deckCache')) {
        db.createObjectStore('deckCache', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run a transaction; resolve with the value produced by `fn`. */
async function withStore(name, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    let result;
    Promise.resolve(fn(tx.objectStore(name)))
      .then((r) => { result = r; })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

const asPromise = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// ── Pending review queue ────────────────────────────────────────────

export function queueReview(review) {
  return withStore('pendingReviews', 'readwrite', (s) => s.add(review));
}

export function getPendingReviews() {
  return withStore('pendingReviews', 'readonly', (s) => asPromise(s.getAll()));
}

export function deleteReviews(ids) {
  return withStore('pendingReviews', 'readwrite', (s) => ids.forEach((id) => s.delete(id)));
}

// ── Deck cache ──────────────────────────────────────────────────────

export function cacheDeck(gist) {
  return withStore('deckCache', 'readwrite', (s) =>
    s.put({ id: gist.id, gist, cachedAt: Date.now() })
  );
}

export async function getCachedDecks() {
  const rows = await withStore('deckCache', 'readonly', (s) => asPromise(s.getAll()));
  return rows.map((r) => r.gist);
}

export async function getCachedDeck(id) {
  const row = await withStore('deckCache', 'readonly', (s) => asPromise(s.get(id)));
  return row ? row.gist : null;
}
