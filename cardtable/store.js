// Card Table — storage: the host's saves, the deck catalog and every peer's
// image cache in IndexedDB, and the ingestion of uploaded images (decode,
// check, hash). The app (app.js) decides when to save and what to fetch;
// this module only stores, and checks what it stores.
//
// The database `cardtable`, version 1:
//   saves    key room        {room, ts, v, state}: a host's table, decks apart —
//                            or {room, ts, lost} when it could not be saved
//   catalog  key [room, id]  {room, id, kind: 'deck', deck}: a table's decks, in
//            index room      the catalog shape (core.js cleanDeck), written once
//   assets   key h           {h, mime, size, data: ArrayBuffer, used}: images by
//            index used      the SHA-256 of their bytes, shared by every room
//            index size      this browser hosted or joined (GC reads the two
//                            indexes, never the bytes)
// Images are content-addressed: a deck names its images by hash, and a peer
// that holds those bytes needs nothing else. Bytes enter only through
// putAsset — an upload being ingested, an image pulled from the host — which
// checks them first (checkImage: the type and its magic bytes, the size, and
// the pixel size the header declares, since a few hundred bytes of PNG can
// declare a picture no page could decode) and, for a pulled image, its hash.
// Every function logs a failure (console.error) and rejects with a readable
// message for the app to show. Nothing falls back silently: without
// IndexedDB the app runs unsaved, loudly, and images live in memory only.
import {
  ASSET_MAX_BYTES, IMG_MIMES, IMG_RE, STATE_V, cleanDeck, cleanDeckV1, assetRefs, migrate, num,
} from './core.js?v=1';

/** This file's code version (see core.js MODULE_V). */
export const MODULE_V = 1;
/** The largest image any peer stores: per side, and in all (16 Mpx = 16,000,000 px). */
export const IMG_MAX_SIDE = 4096, IMG_MAX_PX = 16e6;
const HOUR = 3600e3, DAY = 24 * HOUR;
/** Cached images no table shows go after 14 days unused, or least recently
 *  used first beyond 500 MB in all (a guest's cache) — never within an hour of use. */
const GC_UNUSED_MS = 14 * DAY, CACHE_MAX = 500e6;

// --- images -------------------------------------------------------------------
const u8 = (x) => (x instanceof Uint8Array ? x : ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x));
const unreadable = () => new Error("the image's header can't be read");
/** The image type its first bytes announce (PNG 89 50 4E 47, JPEG FF D8 FF, GIF8, RIFF….WEBP), or null. */
function sniff(b) {
  const is = (o, s) => [...s].every((c, k) => b[o + k] === c.charCodeAt(0));
  return is(0, '\x89PNG') ? 'image/png' : is(0, '\xff\xd8\xff') ? 'image/jpeg' : is(0, 'GIF8') ? 'image/gif'
    : is(0, 'RIFF') && is(8, 'WEBP') ? 'image/webp' : null;
}

/** The pixel size an image's header declares, {w, h}, read without decoding:
 *  PNG's IHDR, JPEG's first SOFn marker (baseline, progressive, any), WebP's
 *  `VP8 `, `VP8L` or `VP8X` chunk, GIF's logical screen — grown to fit every
 *  frame, as browsers grow the canvas for a frame that overhangs it, so a GIF
 *  is walked to its trailer. Throws when the header can't be read:
 *  truncated, malformed, not of type `mime`, or 0 px. */
export function imageDims(bytes, mime) {
  const b = u8(bytes), n = b.length;
  const need = (o, len) => { if (o < 0 || o + len > n) throw unreadable(); };
  const be16 = (o) => (need(o, 2), (b[o] << 8) | b[o + 1]);
  const le16 = (o) => (need(o, 2), b[o] | (b[o + 1] << 8));
  const le24 = (o) => le16(o) + ((need(o, 3), b[o + 2]) << 16);
  const is = (o, s) => o + s.length <= n && [...s].every((c, k) => b[o + k] === c.charCodeAt(0));
  let w = 0, h = 0;
  if (mime === 'image/png' && is(0, '\x89PNG\r\n\x1a\n') && is(12, 'IHDR')) [w, h] = [be16(16) * 65536 + be16(18), be16(20) * 65536 + be16(22)];
  else if (mime === 'image/gif' && (is(0, 'GIF87a') || is(0, 'GIF89a'))) [w, h] = gifDims(b, le16);
  else if (mime === 'image/webp' && is(0, 'RIFF') && is(8, 'WEBP')) {
    if (is(12, 'VP8 ') && is(23, '\x9d\x01\x2a')) [w, h] = [le16(26) & 0x3fff, le16(28) & 0x3fff]; // lossy: after the frame tag's start code
    else if (is(12, 'VP8L') && is(20, '\x2f')) { // lossless: 14 bits each of width − 1 and height − 1
      const v = le16(21) + le16(23) * 65536;
      [w, h] = [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1];
    } else if (is(12, 'VP8X')) [w, h] = [le24(24) + 1, le24(27) + 1]; // extended: the canvas, 24 bits each, − 1
  } else if (mime === 'image/jpeg' && is(0, '\xff\xd8')) [w, h] = jpegDims(b, be16);
  if (!(w >= 1 && h >= 1)) throw unreadable();
  return { w, h };
}
/** A JPEG's size from its first frame header (SOF0–SOF15 but DHT C4, JPG C8,
 *  DAC CC): markers are walked by their lengths from the SOI. */
function jpegDims(b, be16) {
  for (let o = 2; ;) {
    if (b[o] !== 0xff) throw unreadable();
    while (b[o] === 0xff) o++; // fill bytes
    const m = b[o++];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [be16(o + 5), be16(o + 3)]; // length, precision, height, width
    if (m === undefined || m === 0xd9 || m === 0xda) throw unreadable(); // the end, or the image data, before a frame header
    if (!(m >= 0xd0 && m <= 0xd7) && m !== 0x01) o += be16(o); // RSTn and TEM stand alone; the others carry a length
  }
}
/** A GIF's size: its logical screen, grown to every frame's rectangle. The
 *  blocks are walked to the trailer: extensions and image data are chains of
 *  sub-blocks (a length byte, then that many bytes; 0 ends the chain). */
function gifDims(b, le16) {
  let w = le16(6), h = le16(8), o = 13;
  if (b[10] & 0x80) o += 3 << ((b[10] & 7) + 1); // the global color table
  for (;;) {
    const t = b[o];
    if (t === 0x3b) return [w, h];
    if (t === 0x21) o += 2; // an extension: its label, then sub-blocks
    else if (t === 0x2c) { // a frame: left, top, width, height, flags, a local color table, the LZW code size
      w = Math.max(w, le16(o + 1) + le16(o + 5));
      h = Math.max(h, le16(o + 3) + le16(o + 7));
      const f = b[o + 9];
      o += 11 + (f & 0x80 ? 3 << ((f & 7) + 1) : 0);
    } else throw unreadable();
    for (let len; (len = b[o]) !== 0; o += len + 1) if (len === undefined) throw unreadable();
    o++;
  }
}

/** The checks every image passes before a peer stores or shows it: a type of
 *  IMG_MIMES whose magic bytes match, at most ASSET_MAX_BYTES, and a header
 *  (imageDims) within IMG_MAX_SIDE per side and IMG_MAX_PX in all. Returns
 *  {w, h}; throws a readable Error ("image is 30000 × 30000 px (…)"). */
export function checkImage(bytes, mime) {
  const b = u8(bytes), real = sniff(b);
  if (!IMG_MIMES.has(mime) || !real) throw new Error('not a PNG/JPEG/WebP/GIF image');
  if (real !== mime) throw new Error(`the image claims to be ${mime} but is ${real}`);
  if (b.length > ASSET_MAX_BYTES) throw new Error(`image is ${(b.length / 1e6).toFixed(1)} MB (max ${ASSET_MAX_BYTES / 1e6} MB)`);
  const { w, h } = imageDims(b, mime);
  if (w > IMG_MAX_SIDE || h > IMG_MAX_SIDE || w * h > IMG_MAX_PX) throw new Error(`image is ${w} × ${h} px (max ${IMG_MAX_SIDE} per side, ${IMG_MAX_PX / 1e6} Mpx)`);
  return { w, h };
}

/** The hex SHA-256 of some bytes: an image's asset id. */
export const sha256hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8(bytes)))]
  .map((x) => x.toString(16).padStart(2, '0')).join('');

/** Turns a deck in the transport shape (core.js cleanDeckV1: images as data
 *  URLs; an image-less deck is the same in both shapes) into the catalog
 *  shape: every image a card shows is decoded, checked and stored
 *  (putAsset), and named by its asset id; a card's own `img` joins `imgs`
 *  (with its `g`), the same bytes share one entry, and an image back becomes
 *  `backImg`. Images no card shows are dropped. Resolves {deck (v2, cleanDeck),
 *  cost: the transport size the guests' deck budget counts}; rejects with a
 *  readable message naming the image ("card 12: not a PNG/JPEG/WebP/GIF
 *  image"). The deck's images are only ever ones it brought the bytes of.
 *  (Its bytes need no cap of their own: cleanDeckV1's 24 MB of base64 is
 *  under 18 MB decoded.) */
export async function ingestDeck(raw) {
  const d = cleanDeckV1(raw), cost = JSON.stringify(d).length;
  const label = new Map(); // data URL → what an error calls it
  d.cards.forEach((c, k) => {
    const url = c.img || d.imgs[c.g];
    if (url && !label.has(url)) label.set(url, `card ${k + 1}`);
  });
  if (IMG_RE.test(d.back)) label.set(d.back, 'the back');
  const ids = new Map(await Promise.all([...label].map(async ([url, what]) => {
    const [, mime, b64] = /^data:([^;]+);base64,(.*)$/s.exec(url);
    try { return [url, await putAsset(unb64(b64), mime)]; } catch (err) { throw new Error(`${what}: ${err.message}`); }
  })));
  const imgs = [], slot = new Map(); // asset id → its index in imgs
  const index = (url) => { const h = ids.get(url); if (!slot.has(h)) slot.set(h, imgs.push(h) - 1); return slot.get(h); };
  const cards = d.cards.map(({ img, g, ...c }) => (img || g !== undefined ? { ...c, g: index(img || d.imgs[g]) } : c));
  const backImg = ids.get(d.back);
  return { deck: cleanDeck({ name: d.name, back: backImg ? null : d.back, backImg, imgs, cards }), cost };
}
function unb64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

// --- the database ------------------------------------------------------------
let db = null, opening = null;
/** What the app hands open(): notify(msg) shows a notice (a toast);
 *  keep() is the Set of asset ids GC must spare (what this tab's decks show,
 *  and what it is pulling); hosting() says whether this tab is the host;
 *  onVersionChange() runs once another tab upgraded the database (closed
 *  here); onPruned(room) once another tab deleted that room's save (prune). */
const opts = { notify: (msg) => console.warn(msg), keep: () => new Set(), hosting: () => false, onVersionChange: () => {}, onPruned: () => {} };
/** This browser's tabs tell each other which room's save prune() deleted: a
 *  tab hosting that room must write its whole catalog again. */
let tabs = null;

/** Logs a failure and rethrows it as an Error whose message says what
 *  failed and why ("browser storage is full" for a quota error); the name
 *  (QuotaExceededError, …) is kept for callers that tell them apart. */
const fail = (what) => (err) => {
  console.error(`${what} failed`, err);
  const quota = err?.name === 'QuotaExceededError';
  throw Object.assign(new Error(`${what}: ${quota ? 'browser storage is full' : err?.message || err?.name || err}`), { name: err?.name || 'Error' });
};

/** Opens the database (idempotent: every call shares the first one's
 *  outcome), creating its stores on first use; `o` sets the hooks above.
 *  Rejects when IndexedDB is unavailable or refuses to open. */
export function open(o = {}) {
  Object.assign(opts, o);
  opening ||= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable');
    const r = indexedDB.open('cardtable', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('saves', { keyPath: 'room' });
      d.createObjectStore('catalog', { keyPath: ['room', 'id'] }).createIndex('room', 'room');
      const a = d.createObjectStore('assets', { keyPath: 'h' });
      a.createIndex('used', 'used');
      a.createIndex('size', 'size');
    };
    r.onsuccess = () => {
      db = r.result;
      tabs = new BroadcastChannel('cardtable-store');
      tabs.onmessage = (e) => opts.onPruned(e.data?.pruned);
      // A newer Card Table in another tab wants to upgrade: let it, and stop here.
      db.onversionchange = () => { db.close(); db = null; opts.onVersionChange(); };
      resolve();
    };
    r.onerror = () => reject(r.error || new Error('it failed to open'));
    r.onblocked = () => console.warn('IndexedDB: waiting for another tab to close the database');
  }).catch((err) => {
    console.error('IndexedDB failed to open', err);
    throw new Error(err?.message || err?.name || String(err)); // the bare reason: the app says "IndexedDB: …"
  });
  return opening;
}

/** Runs `fn(...stores)` in one transaction over the stores named in
 *  `names`; resolves what fn returned (IDB requests, read once it commits).
 *  fn runs synchronously, so its puts clone their values before this
 *  returns, and a write is committed at once (commit()), not when the task
 *  ends: a page that is going away (pagehide) may never finish its task. */
function tx(names, mode, fn) {
  return new Promise((resolve, reject) => {
    if (!db) throw new Error('the database is not open');
    const t = db.transaction(names, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onabort = () => reject(t.error || new Error('the transaction was aborted'));
    try {
      out = fn(...names.map((s) => t.objectStore(s)));
      if (mode === 'readwrite') t.commit?.();
    } catch (err) {
      reject(err); // (a put that threw synchronously: a quota error, data that can't be cloned)
      try { t.abort(); } catch (e) { console.error('aborting a failed transaction failed', e); }
    }
  });
}
/** Every [index key, primary key] of an index, in index order: keys only, no
 *  record (no image bytes) is read. Filled once the transaction commits. */
function keysOf(index) {
  const out = [], r = index.openKeyCursor();
  r.onsuccess = () => {
    const c = r.result;
    if (c) { out.push([c.key, c.primaryKey]); c.continue(); }
  };
  return out;
}

// --- saves and the catalog -------------------------------------------------------
/** A host's table: ONE transaction writes the state (structured-cloned by
 *  put(), synchronously: later moves can't leak into it) and the catalog
 *  records of `catalog` ({id, kind: 'deck', deck}: the decks not saved yet). */
export function writeSave(room, state, catalog = []) {
  return tx(['saves', 'catalog'], 'readwrite', (saves, cat) => {
    saves.put({ room, ts: Date.now(), v: state.v, state });
    for (const c of catalog) cat.put({ room, id: c.id, kind: c.kind, deck: c.deck });
  }).catch(fail('saving the table'));
}
/** Replaces a room's save with a lost marker {room, ts, lost: why}: a reload
 *  then resets the table loudly instead of resuming a stale one. */
const markLost = (room, why, ts = Date.now()) => tx(['saves'], 'readwrite', (s) => { s.put({ room, ts, lost: why }); })
  .catch(fail('marking the save as lost'));

/** Saves a host's table (writeSave), making room when storage is full:
 *  other rooms' saves go, oldest first (prune), each followed by a sweep of
 *  the images no table shows any more (gc), until it fits. Resolves how many
 *  saves it deleted. When it still can't save, the room's save becomes a
 *  lost marker, and it rejects with the reason ("browser storage is full").
 *  Its synchronous part is the first write's structured clone (B6). */
export async function saveTable(room, state, catalog) {
  let pruned = 0, need = 0;
  for (;;) {
    try {
      await writeSave(room, state, catalog);
      return pruned;
    } catch (err) {
      const full = err.name === 'QuotaExceededError';
      if (full && await prune(room, need ||= JSON.stringify({ state, catalog }).length)) {
        pruned++;
        await gc({ keep: opts.keep(), need: Infinity });
        continue;
      }
      const why = full ? 'browser storage is full' : `auto-save failed: ${err.message}`;
      await markLost(room, why).catch((e) => console.error('could not even mark the save as lost', e));
      throw Object.assign(new Error(why), { name: err.name });
    }
  }
}

/** Deletes the oldest other room's save, with its catalog, to make room for
 *  `need` more bytes. Spared: saves written in the last 30 s (another tab is
 *  hosting that room right now: the two would evict each other forever),
 *  and all of them when even all together are smaller than `need`
 *  (unrelated tables would be lost for nothing). Host keys (localStorage)
 *  are never touched. Resolves how many it deleted: 0 or 1. */
export async function prune(exceptRoom, need) {
  const { saves, cat } = await tx(['saves', 'catalog'], 'readonly', (s, c) => ({ saves: s.getAll(), cat: c.getAll() }))
    .catch(fail('reading the saves'));
  const size = new Map(); // room → its catalog's size
  for (const c of cat.result) size.set(c.room, (size.get(c.room) || 0) + JSON.stringify(c).length);
  const old = saves.result.filter((s) => s.room !== exceptRoom && !(num(s.ts) > Date.now() - 30000))
    .map((s) => ({ room: s.room, ts: num(s.ts), bytes: JSON.stringify(s).length + (size.get(s.room) || 0) }));
  const bytes = old.reduce((sum, x) => sum + x.bytes, 0);
  if (!old.length || bytes < need) { console.warn(`not pruning other saves: this table (${need} B) is bigger than all of them (${bytes} B)`); return 0; }
  const { room } = old.sort((a, b) => a.ts - b.ts)[0];
  console.warn('browser storage full — deleting the save of an older room', room);
  await tx(['saves', 'catalog'], 'readwrite', (s, c) => { s.delete(room); c.delete(IDBKeyRange.bound([room], [room, []])); })
    .catch(fail('deleting an old save'));
  tabs.postMessage({ pruned: room });
  return 1;
}

/** This room's save: {state, decks, stored} — `stored`: IndexedDB holds
 *  exactly this (false: a migrated save that couldn't be written), {lost:
 *  why} when it can't be resumed, {newer: v} when a newer Card Table wrote
 *  it (never to be resumed or overwritten here), or null if this browser
 *  never hosted the room. A save from before Phase 1 (localStorage
 *  ct-save-<room> and ct-decks-<room>) is migrated: its state lifted
 *  (core.js migrate), its decks ingested (a deck that fails is dropped, and
 *  said so), and the result written in one transaction; only once that
 *  commits do the old keys go. Every catalog deck passes cleanDeck. */
export async function loadSave(room) {
  const { rec, cat } = await tx(['saves', 'catalog'], 'readonly', (s, c) => ({ rec: s.get(room), cat: c.index('room').getAll(room) }))
    .catch(fail('reading the save'));
  const s = rec.result;
  if (!s) return migrateLegacy(room);
  if (typeof s.lost === 'string') return { lost: s.lost };
  const v = Math.max(num(s.v, 1), num(s.state?.v, 1));
  if (v > STATE_V) return { newer: v };
  if (!s.state?.items || !s.state.players) return { lost: 'the save is unreadable: it holds no table' };
  const decks = {};
  for (const c of cat.result) {
    try { decks[c.id] = cleanDeck(c.deck); } catch (err) { console.error(`saved deck ${c.id} dropped`, err); }
  }
  return { state: s.state, decks, stored: true };
}
/** The pre-Phase 1 save of `room` (localStorage), migrated: see loadSave. */
async function migrateLegacy(room) {
  const key = `ct-save-${room}`, raw = localStorage.getItem(key);
  if (raw === null) return null;
  let out;
  try {
    const s = JSON.parse(raw);
    if (typeof s?.lost === 'string') out = { lost: s.lost, ts: num(s.ts) };
    else {
      if (!s?.state?.items || !s.state.players) throw new Error('the save holds no table');
      const v = num(s.state.v, 1);
      if (v > STATE_V) return { newer: v };
      const old = s.decks ?? JSON.parse(localStorage.getItem(`ct-decks-${room}`) || 'null'); // older saves embed their decks
      if (!old || typeof old !== 'object') throw new Error('the saved decks are missing');
      const decks = {};
      for (const [id, deck] of Object.entries(old)) {
        try { decks[id] = (await ingestDeck(deck)).deck; } catch (err) {
          console.error(`saved deck ${id} dropped`, err);
          opts.notify(`The deck "${String(deck?.name || id).slice(0, 24)}" of this table's save was dropped: ${err.message}`);
        }
      }
      out = { state: migrate(s.state), decks };
    }
  } catch (err) {
    console.error('corrupt save discarded', err);
    out = { lost: `the save is unreadable: ${err.message}` };
  }
  try {
    if (out.lost) await markLost(room, out.lost, out.ts);
    else await writeSave(room, out.state, Object.entries(out.decks).map(([id, deck]) => ({ id, kind: 'deck', deck })));
    localStorage.removeItem(key);
    localStorage.removeItem(`ct-decks-${room}`);
  } catch (err) {
    opts.notify(`Couldn't move this table's save to the new storage: ${err.message}`);
    return out.lost ? { lost: out.lost } : { ...out, stored: false };
  }
  return out.lost ? { lost: out.lost } : { ...out, stored: true };
}

// --- assets ---------------------------------------------------------------------
/** This tab's images, by asset id: {mime, size, blob, url (an object URL,
 *  what faces show), stored (IndexedDB holds it)}. Never evicted: a page
 *  shows its decks for its lifetime. */
const mem = new Map();
const memo = (h, mime, data, stored) => {
  if (!mem.has(h)) { const blob = new Blob([data], { type: mime }); mem.set(h, { mime, size: blob.size, blob, url: URL.createObjectURL(blob), stored }); }
  return mem.get(h);
};
let cacheWarned = false;

/** Checks an image (checkImage), hashes it and stores it: in memory at once
 *  (getAssetURL), then in IndexedDB. Resolves its asset id. With `expect`
 *  (an image pulled from the host) the hash must be that id. When storage
 *  is full it makes room once (gc, least recently used first) and retries;
 *  failing that, the image lives in memory only, for this page, said once.
 *  Rejects, readably, for an image that fails a check. */
export async function putAsset(data, mime, expect) {
  const b = u8(data);
  let h;
  try {
    checkImage(b, mime);
    h = await sha256hex(b);
    if (expect !== undefined && h !== expect) throw new Error(`the image's bytes don't match its id (${String(expect).slice(0, 12)}…)`);
  } catch (err) {
    console.error('an image was refused', err);
    throw err;
  }
  const m = memo(h, mime, b, false);
  if (m.stored || !db) return h;
  const rec = { h, mime, size: b.length, data: b.byteOffset || b.byteLength !== b.buffer.byteLength ? b.slice().buffer : b.buffer, used: Date.now() };
  const write = () => tx(['assets'], 'readwrite', (a) => { a.put(rec); }).catch(fail('storing an image'));
  try {
    await write().catch(async (err) => {
      if (err.name !== 'QuotaExceededError') throw err;
      await gc({ keep: opts.keep(), need: rec.size });
      return write();
    });
    m.stored = true;
  } catch (err) {
    if (!cacheWarned) {
      cacheWarned = true;
      const why = err.name === 'QuotaExceededError' ? 'storage full' : err.message;
      opts.notify(opts.hosting() ? `Couldn't store card images in this browser (${why}) — reloading the host tab would lose them`
        : `Couldn't cache card images on this device (${why}) — they'll download again next time`);
    }
  }
  return h;
}
/** The object URL of image `h` if this page holds it (a synchronous memo lookup), else null. */
export const getAssetURL = (h) => mem.get(h)?.url ?? null;
/** The object URL of image `h`: from memory, else read from IndexedDB; null when neither holds it. */
export async function loadAsset(h) {
  if (mem.has(h) || !db) return getAssetURL(h);
  const r = (await tx(['assets'], 'readonly', (a) => a.get(h)).catch(fail('reading an image'))).result;
  if (!r) return null;
  memo(h, r.mime, r.data, true);
  touch(r);
  return getAssetURL(h);
}
/** Image `h` to send to a peer, {mime, data: ArrayBuffer}, or null when this browser doesn't hold it. */
export async function getAsset(h) {
  await loadAsset(h);
  const m = mem.get(h);
  return m ? { mime: m.mime, data: await m.blob.arrayBuffer() } : null;
}
/** Whether this page or IndexedDB holds image `h`. */
export async function has(h) {
  if (mem.has(h) || !db) return mem.has(h);
  return (await tx(['assets'], 'readonly', (a) => a.count(h)).catch(fail('looking up an image'))).result > 0;
}

// `used` is bumped at most once a day per image, in one batched write: a
// record holds its bytes too, so every bump rewrites them.
const stale = new Map();
let touchT = 0;
function touch(rec) {
  if (rec.used > Date.now() - DAY) return;
  stale.set(rec.h, rec);
  touchT ||= setTimeout(() => {
    touchT = 0;
    const now = Date.now(), recs = [...stale.values()];
    stale.clear();
    tx(['assets'], 'readwrite', (a) => { for (const r of recs) a.put({ ...r, used: now }); })
      .catch((err) => console.error('marking images as used failed', err));
  }, 5000);
}

/** Deletes cached images that no table needs: images no catalog record (of
 *  any room) shows and that went unused for 14 days; then, least recently
 *  used first, more of them while those unreferenced images take over
 *  500 MB in all, or until `need` bytes are freed (storage is full; Infinity:
 *  all of them). Never one in `keep`, nor one used in the last hour.
 *  Resolves {deleted, bytes}. */
export async function gc({ keep = new Set(), need = 0 } = {}) {
  if (!db) return { deleted: 0, bytes: 0 };
  const { cat, byUse, bySize } = await tx(['catalog', 'assets'], 'readonly', (c, a) => ({
    cat: c.getAll(), byUse: keysOf(a.index('used')), bySize: keysOf(a.index('size')),
  })).catch(fail('reading the image cache'));
  const refs = new Set(keep);
  for (const r of cat.result) if (r.deck) for (const h of assetRefs({ d: r.deck })) refs.add(h);
  const size = new Map(bySize.map(([s, h]) => [h, s])), now = Date.now();
  const free = byUse.filter(([, h]) => !refs.has(h)); // least recently used first
  let total = free.reduce((n, [, h]) => n + size.get(h), 0), freed = 0;
  const drop = [];
  for (const [used, h] of free) {
    if (used > now - HOUR) break; // the rest were used even later
    if (used < now - GC_UNUSED_MS || total > CACHE_MAX || freed < need) {
      drop.push(h);
      total -= size.get(h);
      freed += size.get(h);
    }
  }
  if (drop.length) await tx(['assets'], 'readwrite', (a) => { for (const h of drop) a.delete(h); }).catch(fail('deleting unused images'));
  return { deleted: drop.length, bytes: freed };
}
