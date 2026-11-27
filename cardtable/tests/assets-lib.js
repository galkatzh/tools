// Shared helpers for the Phase 1B image suites (t-p1-assets.js, t-p1-flood.js,
// and B8 in t-p1-bench.js); not a suite itself. Images are made here, in code (PNG
// written byte by byte), so a test knows every asset id up front: an asset id
// is the hex SHA-256 of the image's bytes (spec §1a). Decks go to the host as
// an `addDeck` with data URLs (the wire shape, §1c), which keeps those bytes:
// the deck dialog re-encodes uploads, so it is used only where a test is about
// the dialog (a guest's own upload).
'use strict';
const zlib = require('zlib');
const h = require('./h');
const L = require('./p1-lib');

// --- images ---------------------------------------------------------------------
/** One PNG chunk: length, type, data, CRC-32 of type + data. */
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(td.length + 8);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(td), td.length + 4);
  return out;
}
/** A w × ht RGB PNG. With `seed`: seeded noise, which no deflate shrinks (about
 *  3 bytes a pixel, so 800 × 800 is ≈ 1.92 MB); else one flat colour `rgb`.
 *  `rows` (default ht) is how many scanlines its IDAT really holds: fewer
 *  makes a short file whose header still declares w × ht (a decompression bomb). */
function png(w, ht, { seed, rgb = [200, 60, 60], rows = ht } = {}) {
  const line = 1 + 3 * w, raw = Buffer.alloc(line * rows);
  if (seed !== undefined) {
    const next = L.prng(seed);
    for (let o = 0; o < raw.length; o += 4) raw.writeUInt32LE((next() * 2 ** 32) >>> 0, Math.min(o, raw.length - 4));
    for (let y = 0; y < rows; y++) raw[y * line] = 0; // filter type 0 (none) on every scanline
  } else {
    for (let y = 0; y < rows; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * line + 1 + 3 * x);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(ht, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, no filter variants, no interlace
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: seed === undefined ? 9 : 0 })), chunk('IEND', Buffer.alloc(0))]);
}
/** n small, distinct, flat-colour PNGs (a few hundred bytes each). */
const tinyPngs = (n, salt = 0) => Array.from({ length: n }, (_, k) => png(24 + (k % 5), 32, { rgb: [(k * 37 + salt) % 256, (k * 91 + 7 * salt) % 256, (k * 13 + 50) % 256] }));
/** n distinct flat-colour PNGs, 24 × 32 (about 90 bytes each: 4,999 fit a guest's deck budget), for up to 65,536 images per salt. */
const distinctPngs = (n, salt = 0) => Array.from({ length: n }, (_, k) => png(24, 32, { rgb: [k & 255, (k >> 8) & 255, salt] }));
/** Two decks of 9 noise PNGs, 800 × 800 (≈ 1.92 MB each, 34.6 MB in all: a
 *  deck in the transport shape holds at most 24 MB of data URLs). {decks:
 *  [bufs, bufs], ids, bytes}; another `salt` makes other images. Twice that
 *  is more than the 64 MB a peer may pull a minute. */
function bigDecks(salt = 0) {
  const decks = [0, 1].map((d) => Array.from({ length: 9 }, (_, k) => png(800, 800, { seed: 100 * (d + 1) + k + salt })));
  return { decks, ids: decks.flat().map(sha256), bytes: decks.flat().reduce((n, b) => n + b.length, 0) };
}
/** Spec §1j case 9: a PNG of a few hundred bytes whose IHDR declares 30,000 × 30,000 px. */
const bomb = () => png(30000, 30000, { rows: 1 });
/** An asset id: the hex SHA-256 of an image's bytes. */
const { sha256, dataURL } = require('./img-lib'); // (one copy of each, there)
/** A deck in the transport shape (data URLs; spec §1a v1): card k shows image
 *  k; `mime` is every image's type, or a list of one per image. */
const imgDeck = (name, bufs, mime = 'image/png') => ({
  name, back: null, imgs: bufs.map((b, k) => dataURL(b, Array.isArray(mime) ? mime[k] : mime)), cards: bufs.map((_, g) => ({ g, n: `${name} ${g + 1}` })),
});

// --- init scripts (page.addInitScript: they run before the app) -------------------
// Trystero 0.25 frames (see p1-lib rtcHook): a data-channel message is byte 0 = 1
// (room data), bytes 1–2 the room token's length, the token, then the action
// frame: bytes 0–31 the action name, 32–33 a per-message nonce, 34 flags (bit 0
// the last chunk, bit 1 the metadata chunk, which an `asset` message sends
// first), 35 progress, 36… the payload (16,348 bytes a chunk at most).

/** Host side: window.__wire controls the host's outgoing `asset` frames —
 *    hold      while true, every asset frame is held back (in order), until
 *    release() sends them all; returns how many there were;
 *    tamper    > 0: the next n image chunks get their last byte flipped
 *              (an image under 16 KB: the file's last byte, which only the
 *              hash notices); `tampered` lists the ids hit;
 *    swap      a Uint8Array: the next image chunk's payload is replaced by it
 *              (the metadata still names the real image); `swapped` lists ids. */
function hostWire() {
  const W = (window.__wire = { hold: false, held: [], tamper: 0, tampered: [], swap: null, swapped: [] });
  const dec = new TextDecoder(), meta = new Map(); // nonce → {h, mime} of the image being sent
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (d) {
    const u = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
    const off = u && u[0] === 1 && u.length > 3 ? 3 + ((u[1] << 8) | u[2]) : 0;
    if (u && u.length >= off + 36 && dec.decode(u.subarray(off, off + 32)).replace(/\0+$/, '') === 'asset') {
      const nonce = (u[off + 32] << 8) | u[off + 33], flags = u[off + 34];
      if (flags & 2) {
        try { meta.set(nonce, JSON.parse(dec.decode(u.subarray(off + 36)))); } catch (err) { console.error('hostWire: unreadable asset metadata', err); }
      } else if (W.swap) {
        const c = new Uint8Array(off + 36 + W.swap.length);
        c.set(u.subarray(0, off + 36));
        c.set(W.swap, off + 36);
        d = c;
        W.swap = null;
        W.swapped.push(meta.get(nonce)?.h);
      } else if (W.tamper > 0) {
        W.tamper--;
        const c = u.slice();
        c[c.length - 1] ^= 0xff;
        d = c;
        W.tampered.push(meta.get(nonce)?.h);
      }
      if (W.hold) { W.held.push([this, d]); return undefined; }
    }
    return send.call(this, d);
  };
  W.release = () => {
    W.hold = false;
    const q = W.held.splice(0);
    for (const [ch, d] of q) {
      try { send.call(ch, d); } catch (err) { console.error('hostWire: a held asset frame could not be sent', err); }
    }
    return q.length;
  };
}

/** Guest side: window.__needs records every `need` this page sends the host,
 *  as {at: Date.now(), a: [ids]}. */
function needLog() {
  const N = (window.__needs = []), seen = new Set(), dec = new TextDecoder();
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (d) {
    const u = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
    const off = u && u[0] === 1 && u.length > 3 ? 3 + ((u[1] << 8) | u[2]) : 0;
    if (u && u.length >= off + 36 && dec.decode(u.subarray(off, off + 32)).replace(/\0+$/, '') === 'act') {
      const key = `${(u[off + 32] << 8) | u[off + 33]}`;
      try {
        const a = JSON.parse(dec.decode(u.subarray(off + 36))); // a need is one chunk (64 ids ≈ 4.3 KB); other chunks don't parse
        if (a?.t === 'need' && !seen.has(key)) { seen.add(key); N.push({ at: Date.now(), a: a.a }); }
      } catch (err) { if (!(err instanceof SyntaxError)) console.error('needLog', err); } // (a SyntaxError: not a whole JSON action, a chunk of a bigger one — a deck)
    }
    return send.call(this, d);
  };
}

/** window.__toasts: every message the toast shows, as {at: Date.now(), msg}
 *  — a notice each: the boot's notices are shown together, a line each
 *  (app.js toast()), so each line is recorded on its own, and a check for
 *  one notice holds however many others were up with it (D321). */
function toastLog() {
  const T = (window.__toasts = []);
  document.addEventListener('readystatechange', () => {
    const el = document.getElementById('toast');
    if (document.readyState !== 'interactive' || !el) return;
    new MutationObserver(() => { const at = Date.now(); for (const msg of el.textContent.split('\n')) T.push({ at, msg }); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
}

/** window.__decode: what this page could decode as an image — every Blob made
 *  into an object URL or an ImageBitmap (`blobs`), and how many <img> it
 *  inserted with a data: URL (`dataImgs`; images are drawn from blob: URLs). */
function decodeWatch() {
  const W = (window.__decode = { blobs: [], dataImgs: 0 });
  const { createObjectURL } = URL, bitmap = window.createImageBitmap;
  URL.createObjectURL = function (b) { if (b instanceof Blob) W.blobs.push(b); return createObjectURL.call(this, b); };
  window.createImageBitmap = function (b, ...rest) { if (b instanceof Blob) W.blobs.push(b); return bitmap.call(this, b, ...rest); };
  const scan = (n) => {
    if (n.nodeType !== 1) return;
    for (const img of n.tagName === 'IMG' ? [n] : n.querySelectorAll('img')) if (img.getAttribute('src')?.startsWith('data:')) W.dataImgs++;
  };
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'attributes') scan(r.target);
      else r.addedNodes.forEach(scan);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
}

/** Guest side: incoming `note` messages that carry `missing` are dropped
 *  before the app sees them (window.__droppedMissing counts them). */
function dropMissingNotes() {
  window.__droppedMissing = 0;
  const dec = new TextDecoder();
  const on = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    enumerable: on.enumerable,
    get() { return on.get.call(this); },
    set(fn) {
      on.set.call(this, typeof fn !== 'function' ? fn : function (e) {
        const d = e.data, u = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
        const off = u && u[0] === 1 && u.length > 3 ? 3 + ((u[1] << 8) | u[2]) : 0;
        if (u && u.length >= off + 36 && dec.decode(u.subarray(off, off + 32)).replace(/\0+$/, '') === 'note' && /missing/.test(dec.decode(u.subarray(off + 36)))) {
          window.__droppedMissing++;
          return undefined;
        }
        return fn.call(this, e);
      });
    },
  });
}

/** Init script (or page.evaluate): every 10 ms, window.__pace gets
 *  [Date.now(), image bytes received, the x this page shows card `id` at (-1:
 *  not at all)] — what stopMoves() reads. */
function paceMonitor(id) {
  window.__pace = [];
  setInterval(() => window.__pace.push([Date.now(), window.__rtc?.recv.asset || 0, window.__ct?.view().items[id]?.x ?? -1]), 10);
}

/** window.__longTasks: main-thread long tasks, as {start, ms} (performance.now() clock). */
function longTasks() {
  const lt = (window.__longTasks = []);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push({ start: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
}

// --- page helpers ---------------------------------------------------------------------
/** A seated player on its own context, with p1-lib's RTC hook and `scripts`
 *  (init scripts, in order); `logs` collects its console warnings and errors.
 *  Resolves once its view holds its own player: a guest's first pile may be
 *  the public snapshot that answers its anonymous knock, drawn before the
 *  host registers its hello (and logs its join). */
async function seat(env, name, url, scripts = [], o = {}) {
  const p = await env.page(name, o);
  for (const s of [L.rtcHook, ...scripts]) await p.addInitScript(s);
  p.logs = [];
  p.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') p.logs.push({ type: m.type(), text: m.text(), at: Date.now() }); });
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
  await p.waitForFunction(() => !!window.__ct.view().players[localStorage.getItem('ct-pid')], null, { timeout: 30000 });
  return p;
}
/** The id of the pile named `name` in page's view (null if none). */
const pileOf = (page, name) => page.evaluate((n) => Object.entries(window.__ct.view().items).find(([, it]) => it.k === 'p' && it.name === n)?.[0] ?? null, name);
/** Host: adds `deck` (transport shape) as its own action; resolves {ok,
 *  error?, pile} once its pile is on the host's screen (the next tick). */
async function addDeck(host, deck, x = 560, y = 560) {
  const r = await L.act(host, { t: 'addDeck', deck, x, y });
  let pile = null;
  if (r.ok) await L.until(async () => (pile = await pileOf(host, deck.name)), 10000, 50);
  return { ...r, pile };
}
/** Image bytes this page received on the `asset` channel (framing included). */
const assetBytes = (page) => page.evaluate(() => window.__rtc.recv.asset || 0);
/** Every id this page asked the host for (`need`), in order, with repeats. */
const asked = (page) => page.evaluate(() => window.__needs.flatMap((n) => n.a));
/** This page's IndexedDB image records for `ids`: {id: {mime, size, ok: its bytes hash to id} | null}. */
const stored = (page, ids) => page.evaluate(async (ids) => {
  if (!(await indexedDB.databases()).some((d) => d.name === 'cardtable')) return Object.fromEntries(ids.map((id) => [id, null]));
  const db = await new Promise((res, rej) => { const r = indexedDB.open('cardtable'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    const out = {};
    for (const id of ids) {
      const rec = await new Promise((res, rej) => { const r = db.transaction('assets').objectStore('assets').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const hex = rec && [...new Uint8Array(await crypto.subtle.digest('SHA-256', rec.data))].map((x) => x.toString(16).padStart(2, '0')).join('');
      out[id] = rec ? { mime: rec.mime, size: rec.data.byteLength, ok: hex === id } : null;
    }
    return out;
  } finally { db.close(); }
}, ids);
/** Whether page ever turned an image declaring more than 4,096 px a side into
 *  something it could decode (a blob URL or an ImageBitmap), or inserted an
 *  <img> with a data: URL (decodeWatch). */
const decodedBomb = (page) => page.evaluate(async () => {
  for (const b of window.__decode.blobs) {
    const u = new Uint8Array(await b.slice(0, 24).arrayBuffer()), be = (o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
    if (u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47 && (be(16) > 4096 || be(20) > 4096)) return true;
  }
  return window.__decode.dataImgs > 0;
});
/** The host starts moving card `id` every 100 ms, one unit further right each
 *  time (so a guest's x tells which moves reached it). */
const startMoves = (host, id) => host.evaluate((id) => {
  const P = (window.__moves = []);
  let x = Math.round(window.__ct.view().items[id].x);
  window.__moveT = setInterval(() => { P.push([Date.now(), ++x]); window.__ct.act({ t: 'move', id, x, y: 650 }); }, 100);
}, id);
/** Stops the host's moves; then, from guest's samples (paceMonitor, taken
 *  and cleared), each move's latency there: {at, x, ms} (ms Infinity: it
 *  never showed). Resolves {moves, samples}. */
async function stopMoves(host, guest) {
  const moves = await host.evaluate(() => { clearInterval(window.__moveT); return window.__moves; });
  await h.sleep(1500); // the last ones arrive
  const samples = await guest.evaluate(() => window.__pace.splice(0));
  return { samples, moves: moves.map(([at, x]) => ({ at, x, ms: (samples.find(([t, , sx]) => t >= at && sx >= x)?.[0] ?? Infinity) - at })) };
}
/** The toasts page showed since `since` (Date.now()). */
const toastsSince = (page, since = 0) => page.evaluate((t) => window.__toasts.filter((x) => x.at >= t).map((x) => x.msg), since);

module.exports = {
  png, tinyPngs, distinctPngs, bigDecks, bomb, sha256, dataURL, imgDeck,
  hostWire, needLog, toastLog, decodeWatch, dropMissingNotes, paceMonitor, longTasks,
  seat, pileOf, addDeck, assetBytes, asked, stored, decodedBomb, startMoves, stopMoves, toastsSince,
};
