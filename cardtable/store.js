// Card Table — storage: the host's saves, the deck catalog and every peer's
// image cache in IndexedDB, and the ingestion of uploaded images (decode,
// check, hash). The app (app.js) decides when to save and what to fetch;
// this module only stores, and checks what it stores.
//
// The database `cardtable`, version 1:
//   saves    key room        {room, ts, v, state}: a host's table, decks apart —
//                            or {room, ts, lost} when it could not be saved
//   catalog  key [room, id]  {room, id, kind: 'deck', deck}: a table's decks, in
//            index room      the catalog shape (core.js cleanDeck), and {room, id,
//                            kind: 'box', box, src, by?}: its game boxes (core.js
//                            cleanBox; src and by are host-written, never read
//                            from the box), each written once
//   assets   key h           {h, mime, size, data: ArrayBuffer, used}: images by
//            index used      the SHA-256 of their bytes, shared by every room
//            index size      this browser hosted or joined (GC reads the two
//                            indexes, never the bytes)
// Images are content-addressed: a deck names its images by hash, and a peer
// that holds those bytes needs nothing else. Bytes enter a page only checked
// (checkImage: the type and its magic bytes, the size, and the pixel size the
// header declares, since a few hundred bytes of PNG can declare a picture no
// page could decode): an upload through ingestDeck, which keeps nothing — the
// host holds a deck's images once the deck is on the table, and saves them
// with it — and an image pulled from the host through putAsset, which checks
// its hash too.
// Every function logs a failure (console.error) and rejects with a readable
// message for the app to show. Nothing falls back silently: without
// IndexedDB the app runs unsaved, loudly, and images live in memory only.
import {
  ASSET_MAX_BYTES, IMG_MIMES, STATE_V, MAX_BOX_BYTES, cleanDeck, cleanDeckV1, cleanBox, assetRefs, isImgURL, migrate, num,
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
/** The image type its first bytes announce (PNG 89 50 4E 47, JPEG FF D8 FF,
 *  GIF8, RIFF….WEBP), or null: what an image really is, whatever its name or
 *  data URL says (boxio.js reads an upload's, and its own re-encoding's, so). */
export function imageType(bytes) {
  const b = u8(bytes);
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
  const b = u8(bytes), real = imageType(b);
  if (!IMG_MIMES.includes(mime) || !real) throw new Error('not a PNG/JPEG/WebP/GIF image');
  if (real !== mime) throw new Error(`the image claims to be ${mime} but is ${real}`);
  if (b.length > ASSET_MAX_BYTES) throw new Error(`image is ${(b.length / 1e6).toFixed(1)} MB (max ${ASSET_MAX_BYTES / 1e6} MB)`);
  const { w, h } = imageDims(b, mime);
  if (w > IMG_MAX_SIDE || h > IMG_MAX_SIDE || w * h > IMG_MAX_PX) throw new Error(`image is ${w} × ${h} px (max ${IMG_MAX_SIDE} per side, ${IMG_MAX_PX / 1e6} Mpx)`);
  return { w, h };
}

/** The hex SHA-256 of some bytes: an image's asset id. */
export const sha256hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8(bytes)))]
  .map((x) => x.toString(16).padStart(2, '0')).join('');

/** How long ingestion works before it lets the page run (ms): a big deck never holds anyone's moves up. */
const SLICE_MS = 8;
/** Turns a deck in the transport shape (core.js cleanDeckV1: images as data
 *  URLs; an image-less deck is the same in both shapes) into the catalog
 *  shape, in memory: every image a card shows is decoded, checked
 *  (checkImage) and hashed, and named by its asset id; a card's own `img`
 *  joins `imgs` (with its `g`), the same bytes share one entry, and an image
 *  back becomes `backImg`. Images no card shows are dropped. Resolves {deck
 *  (v2, cleanDeck), cost: the transport size the guests' deck budget counts
 *  (measured when read: the host's own decks never need it), assets:
 *  Map<asset id, {mime, data: ArrayBuffer}>}. Nothing is stored: the caller
 *  keeps the images of a deck that was taken (hold, cache), so a deck refused
 *  later leaves nothing behind. Rejects with a readable message naming the
 *  image ("card 12: not a PNG/JPEG/WebP/GIF image"). The work comes in slices
 *  of about SLICE_MS, between which the page runs (other players' moves go on
 *  meanwhile). (The bytes need no cap of their own: cleanDeckV1's 24 MB of
 *  base64 is under 18 MB decoded.) */
export async function ingestDeck(raw) {
  let t0 = performance.now();
  const d = cleanDeckV1(raw);
  const label = new Map(); // data URL → what an error calls it
  d.cards.forEach((c, k) => {
    const url = c.img || d.imgs[c.g];
    if (url && !label.has(url)) label.set(url, `card ${k + 1}`);
  });
  if (isImgURL(d.back)) label.set(d.back, 'the back');
  const ids = new Map(), assets = new Map(); // data URL → asset id; asset id → {mime, data}
  let slice = [];
  /** Ends a slice: its hashes are in, then the page runs a moment. */
  const settle = async () => {
    for (const [url, h, mime, data] of await Promise.all(slice)) { ids.set(url, h); assets.set(h, { mime, data }); }
    slice = [];
    await new Promise((r) => setTimeout(r)); // (a digest may resolve without letting the page run)
    t0 = performance.now();
  };
  for (const [url, what] of label) {
    if (performance.now() - t0 > SLICE_MS) await settle();
    const mime = url.slice(5, url.indexOf(';')); // data:<mime>;base64,<bytes> (isImgURL)
    try {
      const b = unb64(url.slice(url.indexOf(',') + 1));
      checkImage(b, mime);
      slice.push(sha256hex(b).then((h) => [url, h, mime, b.buffer]));
    } catch (err) { throw new Error(`${what}: ${err.message}`); }
  }
  await settle();
  const imgs = [], slot = new Map(); // asset id → its index in imgs
  const index = (url) => { const h = ids.get(url); if (!slot.has(h)) slot.set(h, imgs.push(h) - 1); return slot.get(h); };
  const cards = d.cards.map(({ img, g, ...c }) => (img || g !== undefined ? { ...c, g: index(img || d.imgs[g]) } : c));
  const backImg = ids.get(d.back);
  return { deck: cleanDeck({ name: d.name, back: backImg ? null : d.back, backImg, imgs, cards }), get cost() { return JSON.stringify(d).length; }, assets };
}
/** Turns a game box in the transport shape (spec §4c, TransportBox: the
 *  game.json format, its images as data URLs in `imgs`, its decks in the
 *  upload shape, each with its `id`) into addBox's payload, in memory, as
 *  ingestDeck does a deck: every image decoded, checked (checkImage: its
 *  type, size and header, imageDims, before it is ever decoded as a
 *  picture), hashed and named by its asset id; each deck ingested
 *  (ingestDeck), keeping the id it asks for. The box's images and its decks'
 *  together are at most MAX_BOX_BYTES. Resolves {box, assets: Map<asset id,
 *  {mime, data}>}; nothing is stored. Rejects with a message naming the
 *  image ("image 4: not a PNG/JPEG/WebP/GIF image") or the deck. (The box's
 *  structure is core.js's to check: checkTransportBox, then addBox.) */
export async function ingestBox(raw) {
  let t0 = performance.now(), bytes = 0;
  const assets = new Map(), imgs = [];
  const count = (n) => {
    bytes += n;
    if (bytes > MAX_BOX_BYTES) throw new Error(`the box's images are too large (over ${MAX_BOX_BYTES / 1e6} MB)`);
  };
  for (const [k, url] of (Array.isArray(raw.imgs) ? raw.imgs : []).entries()) {
    if (performance.now() - t0 > SLICE_MS) { await new Promise((r) => setTimeout(r)); t0 = performance.now(); } // (the page runs between slices)
    if (url === null) { imgs.push(null); continue; }
    try {
      if (!isImgURL(url)) throw new Error('not a PNG/JPEG/WebP/GIF image');
      const mime = url.slice(5, url.indexOf(';')), b = unb64(url.slice(url.indexOf(',') + 1));
      checkImage(b, mime);
      count(b.length);
      const h = await sha256hex(b);
      assets.set(h, { mime, data: b.buffer });
      imgs.push(h);
    } catch (err) { throw new Error(`image ${k + 1}: ${err.message}`); }
  }
  const decks = [];
  for (const [k, d] of (Array.isArray(raw.decks) ? raw.decks : []).entries()) {
    let ing;
    try { ing = await ingestDeck(d); } catch (err) { throw new Error(`deck ${k + 1} («${String(d?.name || '').slice(0, 24)}»): ${err.message}`); }
    for (const [h, a] of ing.assets) if (!assets.has(h)) { count(a.data.byteLength); assets.set(h, a); }
    decks.push({ ...ing.deck, ...(d.id !== undefined && { id: d.id }) });
  }
  return { box: { ...raw, imgs, ...(raw.decks !== undefined && { decks }) }, assets };
}
/** Stores images `assets` (ingestBox's) in IndexedDB now, before what shows
 *  them is added — a game box is added only once its images are stored
 *  (spec §4h: all or nothing). When storage is full it makes room once (gc)
 *  and tries again; then it rejects ("storing images: browser storage is
 *  full", name QuotaExceededError). Without IndexedDB (the app said so at
 *  boot) there is nothing to store. */
export async function stash(assets) {
  if (!db) return;
  const list = [...assets].map(([h, a]) => [h, { ...a, size: a.data.byteLength }]);
  try { await putImages(list); } catch (err) {
    if (err.name !== 'QuotaExceededError') throw err;
    await gc({ keep: opts.keep(), need: list.reduce((n, [, m]) => n + m.size, 0) });
    await putImages(list);
  }
}
function unb64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

// --- the database ------------------------------------------------------------
let db = null, opening = null;
/** Why IndexedDB can't be used any more although it opened (another tab
 *  upgraded it): reads then fail with this, never pass for "not held". */
let gone = '';
/** Memory only: IndexedDB never opened here (the app said so at boot). */
const noDB = () => !db && !gone;
/** What the app hands open(): notify(msg) shows a notice (a toast); keep()
 *  is the Set of asset ids GC must spare (what this tab's decks show, and
 *  what it is pulling); onVersionChange() runs once another tab upgraded the
 *  database (closed here); onPruned(room) once another tab deleted that
 *  room's save (prune). */
const opts = { notify: (msg) => console.warn(msg), keep: () => new Set(), onVersionChange: () => {}, onPruned: () => {} };
/** This browser's tabs tell each other which room's save prune() deleted: a
 *  tab hosting that room must write its whole catalog again, images
 *  included (the pruning tab's GC may take them). No BroadcastChannel (an
 *  old Safari): a tab is not told, and its next save writes only the state. */
let tabs = null;

/** Logs a failure and rethrows it as an Error whose message says what
 *  failed and why ("browser storage is full" for a quota error); the name
 *  (QuotaExceededError, DataCloneError, …) is kept for callers that tell them apart. */
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
      // A newer Card Table in another tab wants to upgrade: let it, and stop here.
      db.onversionchange = () => { db.close(); db = null; gone = 'the database was upgraded in another tab'; opts.onVersionChange(); };
      if (typeof BroadcastChannel === 'function') {
        tabs = new BroadcastChannel('cardtable-store');
        tabs.onmessage = (e) => {
          for (const m of mem.values()) m.stored = false; // the pruned room's images may be gone with it: the next save that names one writes it again
          opts.onPruned(e.data?.pruned);
        };
      }
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
    if (!db) throw new Error(gone || 'the database is not open');
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
 *  put(), synchronously: later moves can't leak into it), the catalog
 *  records of `catalog` (the decks and boxes not saved yet: {id, kind:
 *  'deck', deck} or {id, kind: 'box', box, src, by?}) and the images they
 *  show that IndexedDB doesn't hold yet (hold()): a catalog record never
 *  names an image the store lacks. `fresh`: the room's catalog goes first
 *  (a save that replaces the room's whole table). */
function writeSave(room, state, catalog = [], fresh = false) {
  const imgs = unstored(catalog);
  return tx(imgs.length ? ['saves', 'catalog', 'assets'] : ['saves', 'catalog'], 'readwrite', (saves, cat, assets) => {
    if (fresh) cat.delete(IDBKeyRange.bound([room], [room, []]));
    saves.put({ room, ts: Date.now(), v: state.v, state });
    for (const c of catalog) cat.put({ room, ...c });
    for (const [h, m] of imgs) assets.put(record(h, m));
  }).then(() => { for (const [, m] of imgs) m.stored = true; }, fail('saving the table'));
}
/** Every image the catalog records `recs` show (decks and boxes alike). */
const recordRefs = (recs) => assetRefs(recs.filter((c) => c.deck).map((c) => c.deck), recs.filter((c) => c.box).map((c) => c.box));
/** The images (asset id, memo entry) the decks and boxes of `catalog` show
 *  that this page holds but IndexedDB doesn't (yet). */
const unstored = (catalog) => [...recordRefs(catalog)].map((h) => [h, mem.get(h)]).filter(([, m]) => m && !m.stored);
const record = (h, m) => ({ h, mime: m.mime, size: m.size, data: m.data, used: Date.now() });
/** Stores images `list` (unstored's) a few hundred, or 8 MB, at a time: the
 *  thousands of puts of a big deck in one go would hold the page up. */
async function putImages(list) {
  for (let k = 0; k < list.length;) {
    const batch = [];
    for (let bytes = 0; k < list.length && batch.length < 256 && bytes < 8e6; k++) { batch.push(list[k]); bytes += list[k][1].size; }
    await tx(['assets'], 'readwrite', (a) => { for (const [h, m] of batch) a.put(record(h, m)); }).catch(fail('storing images'));
    for (const [, m] of batch) m.stored = true;
  }
}
/** Replaces a room's save with a lost marker {room, ts, lost: why}, and drops
 *  its catalog (the next save that fits writes every deck again): a reload
 *  then resets the table loudly, with none of the old decks, instead of
 *  resuming a stale one. */
const markLost = (room, why, ts = Date.now()) => tx(['saves', 'catalog'], 'readwrite', (s, c) => {
  s.put({ room, ts, lost: why });
  c.delete(IDBKeyRange.bound([room], [room, []]));
}).catch(fail('marking the save as lost'));

/** Saves a host's table: what `snap()` returns ({state, catalog}), taken
 *  again before each try, and after the wait for its new decks' images
 *  (stored first, in batches: putImages), so the state written is never
 *  torn between two moments; then writeSave. When storage is full it makes
 *  room: first the image cache (gc: images no table needs, least recently
 *  used first — they download again), then other rooms' saves, oldest first
 *  (prune), each followed by a sweep of the images no table shows any more,
 *  until it fits. Resolves {state, catalog (what it wrote), pruned (how many
 *  saves it deleted), syncMs (the main-thread time of writeSave: the state's
 *  structured clone, B6)}. When it still can't save, the room's save becomes
 *  a lost marker, and it rejects with the reason ("browser storage is full")
 *  — but not for a state that can't be stored at all (DataCloneError: a
 *  rules script put a function in t.data): the last save stands, and the
 *  caller fixes the state. */
export async function saveTable(room, snap) {
  let pruned = 0, swept = false;
  /** After a failed write: true to try again (room was made), else the save becomes a lost marker and this throws. */
  const failed = async (err, s) => {
    if (err.name === 'DataCloneError') throw err;
    if (err.name === 'QuotaExceededError') {
      try {
        const need = JSON.stringify(s).length + unstored(s.catalog).reduce((n, [, m]) => n + m.size, 0);
        if (!swept) {
          swept = true;
          if ((await gc({ keep: opts.keep(), need })).deleted) return true;
        }
        if (await prune(room, need)) { pruned++; await gc({ keep: opts.keep(), need: Infinity }); return true; }
      } catch (e) { console.error('making room in browser storage failed', e); }
    }
    const why = err.name === 'QuotaExceededError' ? 'browser storage is full' : `auto-save failed: ${err.message}`;
    await markLost(room, why).catch((e) => console.error('could not even mark the save as lost', e));
    throw Object.assign(new Error(why), { name: err.name });
  };
  for (;;) {
    let s = snap();
    const imgs = unstored(s.catalog);
    if (imgs.length) {
      try { await putImages(imgs); } catch (err) { if (await failed(err, s)) continue; }
      s = snap(); // the table as it is now
    }
    const t0 = performance.now(), write = writeSave(room, s.state, s.catalog), syncMs = performance.now() - t0;
    try {
      await write;
      return { ...s, pruned, syncMs };
    } catch (err) { if (await failed(err, s)) continue; }
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
  tabs?.postMessage({ pruned: room });
  return 1;
}

/** This room's save: {state, decks, boxes, boxSrc, stored, behind?, fromOld?} — `stored`: IndexedDB
 *  holds exactly this (false: a migrated save that couldn't be written),
 *  `behind`: why the room's latest save can't be resumed, when this is an
 *  older copy of it (below) — {lost: why} when it can't be resumed at all,
 *  {newer: v} when a newer Card Table wrote it (never to be resumed or
 *  overwritten here), or null if this browser never hosted the room.
 *  Rejects when the save can't be READ (the caller must not write over what
 *  it couldn't read). A save from before Phase 1 (localStorage ct-save-<room>
 *  and ct-decks-<room>) is migrated: its state lifted (core.js migrate), its
 *  decks ingested (a deck that fails is dropped, and said so), and the result
 *  — images included — written in one transaction; only once that commits do
 *  the old keys go, or once IndexedDB holds a later table of the room. One
 *  saved after the room's IndexedDB save (a tab of the previous Card Table
 *  played on) replaces it the same way, and is resumed (`fromOld`). A lost
 *  marker never stands for one: when the migration couldn't be written and
 *  the saves since failed too, the old keys hold the table's last good copy,
 *  and it is resumed, `behind`. A record that holds no table becomes a lost
 *  marker, its catalog dropped (the fresh table's decks must not join the
 *  old ones). Every catalog deck passes cleanDeck, and every box cleanBox
 *  (one that fails is dropped from the table, loudly, and kept in storage:
 *  its pieces show as "?"); a box's src and by come from its record. */
export async function loadSave(room) {
  const { rec, cat } = await tx(['saves', 'catalog'], 'readonly', (s, c) => ({ rec: s.get(room), cat: c.index('room').getAll(room) }))
    .catch(fail('reading the save'));
  const s = rec.result;
  if (!s) return migrateLegacy(room);
  let lost = typeof s.lost === 'string' ? s.lost : '';
  if (!lost) {
    const v = Math.max(num(s.v, 1), num(s.state?.v, 1));
    if (v > STATE_V) return { newer: v };
    if (s.state?.items && s.state.players) {
      if (legacyNewer(room, s.ts)) return migrateLegacy(room, undefined, true);
      const decks = {}, boxes = {}, boxSrc = {};
      for (const c of cat.result) {
        try {
          if (c.kind === 'box') {
            boxes[c.id] = cleanBox(c.box);
            boxSrc[c.id] = { src: ['host', 'upload', 'script'].includes(c.src) ? c.src : 'host', ...(typeof c.by === 'string' && { by: c.by }) };
          } else decks[c.id] = cleanDeck(c.deck);
        } catch (err) { console.error(`saved ${c.kind === 'box' ? 'game box' : 'deck'} ${c.id} dropped`, err); }
      }
      return { state: s.state, decks, boxes, boxSrc, stored: true };
    }
    lost = 'the save is unreadable: it holds no table';
    console.error(`the save of ${room} holds no table: marked lost`, s);
    await markLost(room, lost);
  }
  return (await migrateLegacy(room, lost)) ?? { lost };
}
/** Whether room's pre-Phase 1 save (localStorage) was made after its
 *  IndexedDB save (at `ts`): a tab of the previous Card Table, still open
 *  when this one moved the save over, went on playing and saving there
 *  (D303). One that isn't — left behind when its migration couldn't be
 *  written, or unreadable — is superseded, and removed here. */
function legacyNewer(room, ts) {
  const raw = localStorage.getItem(`ct-save-${room}`);
  if (raw === null) return false;
  let at = 0;
  try { at = num(JSON.parse(raw)?.ts); } catch (err) { console.error('an unreadable pre-Phase 1 save, superseded', err); }
  if (at > num(ts)) return true;
  localStorage.removeItem(`ct-save-${room}`);
  localStorage.removeItem(`ct-decks-${room}`);
  return false;
}
/** The pre-Phase 1 save of `room` (localStorage), migrated: see loadSave.
 *  `behind`: why the room's later save can't be resumed (the migrated table
 *  says so), when IndexedDB holds a lost marker for it. `newer`: it replaces
 *  an older IndexedDB save of the room, catalog and all (legacyNewer), and
 *  the result says so (`fromOld`). */
async function migrateLegacy(room, behind, newer = false) {
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
        try {
          const ing = await ingestDeck(deck);
          hold(ing.assets); // drawn from memory, and written with the save below
          decks[id] = ing.deck;
        } catch (err) {
          console.error(`saved deck ${id} dropped`, err);
          opts.notify(`The deck "${String(deck?.name || id).slice(0, 24)}" of this table's save was dropped: ${err.message}`);
        }
      }
      out = { state: migrate(s.state), decks, ...(behind && { behind }) };
    }
  } catch (err) {
    console.error('corrupt save discarded', err);
    out = { lost: `the save is unreadable: ${err.message}` };
  }
  try {
    if (out.lost) await markLost(room, out.lost, out.ts);
    else await writeSave(room, out.state, Object.entries(out.decks).map(([id, deck]) => ({ id, kind: 'deck', deck })), newer);
    localStorage.removeItem(key);
    localStorage.removeItem(`ct-decks-${room}`);
  } catch (err) {
    opts.notify(`Couldn't move this table's save to the new storage: ${err.message}`);
    return out.lost ? { lost: out.lost } : { ...out, stored: false, ...(newer && { fromOld: true }) };
  }
  return out.lost ? { lost: out.lost } : { ...out, stored: true, ...(newer && { fromOld: true }) };
}

// --- assets ---------------------------------------------------------------------
/** This page's images, by asset id: {mime, size, data (ArrayBuffer), url (an
 *  object URL, what faces show: made on first use), stored (IndexedDB holds
 *  it)}. Never evicted: a page shows its decks for its lifetime. */
const mem = new Map();
const memo = (h, mime, data, stored) => {
  const m = mem.get(h) || mem.set(h, { mime, size: data.byteLength, data, url: '', stored }).get(h);
  m.stored ||= stored;
  return m;
};
let cacheWarned = false;

/** This page now holds images `assets` (ingestDeck's or ingestBox's: already
 *  checked), to draw and serve; IndexedDB gets them with the save that first
 *  writes a deck or box naming them (writeSave) — unless `stored`: stash put
 *  them there already. The host's way to keep a deck's or a box's images —
 *  only once it is on the table. */
export function hold(assets, stored = false) {
  for (const [h, a] of assets) memo(h, a.mime, a.data, stored);
}
/** A guest's own upload: holds images `assets` (ingestDeck's) and caches
 *  them in IndexedDB, as if pulled (putAsset). */
export const cache = (assets) => Promise.all([...assets].map(([h, a]) => keep(h, a.mime, a.data)));

/** Checks an image (checkImage), hashes it and keeps it: in memory at once
 *  (getAssetURL), then in IndexedDB (keep). Resolves its asset id. With
 *  `expect` (an image pulled from the host) the hash must be that id.
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
  await keep(h, mime, b.byteOffset || b.byteLength !== b.buffer.byteLength ? b.slice().buffer : b.buffer);
  return h;
}
/** Holds a checked image in memory, and caches it in IndexedDB. When storage
 *  is full it makes room once (gc, least recently used first) and retries;
 *  failing that, the image lives in memory only, for this page, said once.
 *  (With no IndexedDB at all the app said so at boot, or when another tab
 *  upgraded it.) */
async function keep(h, mime, data) {
  const m = memo(h, mime, data, false);
  if (m.stored || !db) return;
  const rec = { h, mime, size: m.size, data, used: Date.now() };
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
      opts.notify(`Couldn't cache card images on this device (${err.name === 'QuotaExceededError' ? 'storage full' : err.message}) — they'll download again next time`);
    }
  }
}
/** The object URL of image `h` if this page holds it (made on first use), else null. */
export function getAssetURL(h) {
  const m = mem.get(h);
  return m ? (m.url ||= URL.createObjectURL(new Blob([m.data], { type: m.mime }))) : null;
}
/** Whether this page holds image `h` (a synchronous memo lookup). */
export const holds = (h) => mem.has(h);
/** The object URL of image `h`: from memory, else read from IndexedDB; null
 *  when neither holds it. Rejects when IndexedDB can't be read. */
export async function loadAsset(h) {
  if (mem.has(h) || noDB()) return getAssetURL(h);
  const r = (await tx(['assets'], 'readonly', (a) => a.get(h)).catch(fail('reading an image'))).result;
  if (!r) return null;
  memo(h, r.mime, r.data, true);
  touch(r);
  return getAssetURL(h);
}
/** Image `h` to send to a peer, {mime, data: ArrayBuffer}, or null when this
 *  browser doesn't hold it. Read straight from IndexedDB when this page
 *  doesn't hold it: serving an image doesn't make the host keep a copy. */
export async function getAsset(h) {
  const m = mem.get(h);
  if (m || noDB()) return m ? { mime: m.mime, data: m.data } : null;
  const r = (await tx(['assets'], 'readonly', (a) => a.get(h)).catch(fail('reading an image'))).result;
  if (r) touch(r);
  return r ? { mime: r.mime, data: r.data } : null;
}
/** Which of images `ids` neither this page nor IndexedDB holds, read in one
 *  transaction. Rejects when IndexedDB can't be read: an image this browser
 *  can't read is not reported as missing. */
export async function lacking(ids) {
  const out = ids.filter((h) => !mem.has(h));
  if (!out.length || noDB()) return out;
  const n = await tx(['assets'], 'readonly', (a) => out.map((h) => a.count(h))).catch(fail('looking up images'));
  return out.filter((_, k) => !n[k].result);
}
/** Whether this page or IndexedDB holds image `h`. */
export const has = async (h) => !(await lacking([h])).length;

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
  for (const h of recordRefs(cat.result)) refs.add(h);
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
