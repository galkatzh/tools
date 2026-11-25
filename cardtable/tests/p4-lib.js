// Helpers for the independent Phase 4A game-box suites (t-p4-box-ui.js,
// t-p4-box-files.js, t-p4-box-bench.js) and their fixture maker
// (fixtures/make-lantern.js); not a suite itself. Everything a suite
// uploads is made here or by that maker, never by the app's own code: a zip
// writer that can lie in its directory, a zip reader for the files the app
// exports, PNGs (RGB or RGBA) from a pixel function, and the page side of
// the 📦 dialog (picking files, answering #box-ask, reading what it says).
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const h = require('./h');

// --- zip ---------------------------------------------------------------------------
/** A zip file (Buffer) of `entries`: {name, data (Buffer or string), store?
 *  (no compression), declared? (the uncompressed size its local header and
 *  central directory claim: the truth by default), dir? (a folder entry)}.
 *  Names are written as given ("../x", "/x" included). */
function zip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = e.dir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const store = e.store || e.dir, body = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const crc = zlib.crc32(raw), usize = e.declared ?? raw.length;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x5a21, 12); // (a fixed date: 2025-01-01, so a zip is the same bytes every time)
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(usize, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x5a21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
    c.writeUInt32LE(e.dir ? 0x10 : 0, 38); c.writeUInt32LE(off, 42);
    centrals.push(c, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
/** The entries of zip file `buf` (as any zip tool writes them: the central
 *  directory, then each entry's data): {name: Buffer}. Throws on what it can't read. */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('unzip: no end of central directory');
  const n = buf.readUInt16LE(eocd + 10), out = {};
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`unzip: bad central header ${k}`);
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), body = buf.subarray(start, start + csize);
    if (!name.endsWith('/')) out[name] = method === 0 ? Buffer.from(body) : method === 8 ? zlib.inflateRawSync(body) : (() => { throw new Error(`unzip: method ${method}`); })();
    p += 46 + nl + xl + cl;
  }
  return out;
}

// --- PNG ---------------------------------------------------------------------------
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(td.length + 8);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(td), td.length + 4);
  return out;
}
/** A w × ht PNG, 8-bit RGB (or RGBA with `alpha`): `fill(raw, line, ch)`
 *  writes the scanlines into `raw` (each `line` bytes: a filter byte 0, then
 *  `ch` bytes a pixel). */
function png(w, ht, fill, { alpha = false, level = 6 } = {}) {
  const ch = alpha ? 4 : 3, line = 1 + ch * w, raw = Buffer.alloc(line * ht);
  fill(raw, line, ch);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(ht, 4); ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}
/** A pixel function px(x, y) → [r, g, b(, a)] as png()'s fill. */
const pixels = (w, ht, px) => (raw, line, ch) => { for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * line + 1 + ch * x); };
/** A seeded PRNG in [0, 1) (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A "photograph": opaque, smooth colour fields with a grain in 4 × 4 blocks
 *  (seeded), so a PNG of it is large (4,000 × 3,000: about 5 MB) and a lossy codec shrinks it a lot. */
function photo(w, ht, seed = 1) {
  const r = prng(seed), gw = Math.ceil(w / 4), grain = Int8Array.from({ length: gw * Math.ceil(ht / 4) }, () => Math.round((r() - 0.5) * 24));
  const c = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  return png(w, ht, (raw, line) => {
    for (let y = 0; y < ht; y++) {
      const v = y / ht, sv = 30 * Math.sin(v * 7);
      for (let x = 0, o = y * line + 1; x < w; x++, o += 3) {
        const g = grain[(y >> 2) * gw + (x >> 2)], u = x / w;
        raw[o] = c(60 + 150 * u + sv + g); raw[o + 1] = c(90 + 100 * v + 25 * Math.cos(u * 5) + g); raw[o + 2] = c(140 - 60 * u + 60 * v * u + g);
      }
    }
  });
}
/** Seeded RGB noise (no codec shrinks it): w × ht. */
function noise(w, ht, seed = 1) {
  const r = prng(seed);
  return png(w, ht, (raw, line) => { for (let y = 0; y < ht; y++) for (let o = y * line + 1, e = o + line - 1; o < e; o++) raw[o] = (r() * 256) | 0; }, { level: 1 });
}
/** A PNG whose header declares w × ht px but whose data holds one blank
 *  scanline (a few hundred bytes): a decompression bomb, if anything decoded it. */
function hugePNG(w, ht) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(ht, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(1 + 3 * w))), chunk('IEND', Buffer.alloc(0))]);
}
/** The first bytes of an image as the type they are (magic numbers), or null. */
function magic(b) {
  const u = Buffer.from(b);
  if (u.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
  if (u.toString('latin1', 0, 4) === 'RIFF' && u.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (u.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** A file to pick in a file input: {name, mimeType, buffer}. */
const file = (name, data, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.isBuffer(data) ? data : Buffer.from(data) });

// --- the page: the 📦 dialog -----------------------------------------------------------
/** Init script: window.__toasts (every text #toast shows, {at, msg}) and
 *  window.__boxSays (every text #box-progress, #box-err and #box-msg show,
 *  {at, el, msg}): a later message replaces an earlier one on the screen. */
function watchers() {
  const T = (window.__toasts = []), S = (window.__boxSays = []);
  /** Each text written into an element (textContent = …), from its mutation records: two written in one task are both seen. */
  const texts = (recs) => recs.flatMap((r) => (r.type === 'characterData' ? [r.target.data] : [...r.addedNodes].map((n) => n.textContent))).filter(Boolean);
  document.addEventListener('readystatechange', () => {
    if (document.readyState !== 'interactive') return;
    const el = document.getElementById('toast');
    if (el) new MutationObserver((recs) => { for (const msg of texts(recs)) T.push({ at: Date.now(), msg }); }).observe(el, { childList: true, characterData: true, subtree: true });
    for (const id of ['box-progress', 'box-err', 'box-msg', 'box-x-msg']) {
      const e = document.getElementById(id);
      if (e) new MutationObserver((recs) => { for (const msg of texts(recs)) S.push({ at: Date.now(), el: id, msg }); }).observe(e, { childList: true, characterData: true, subtree: true });
    }
  });
}
/** Init script: wraps JSZip as the app gets it (the +esm URL is served by
 *  zipSpy below as a module importing the real build under `?real`), so a
 *  test sees what it is asked to do: window.__zip = {loads: [file sizes],
 *  calls: [[method, entry]] (async, nodeStream, internalStream on any
 *  entry), bytes: {entry: bytes its streams delivered}}. */
const SPY_MODULE = `import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm?real';
const W = (window.__zip ||= { loads: [], calls: [], bytes: {} });
const load = JSZip.prototype.loadAsync;
JSZip.prototype.loadAsync = async function (data, ...rest) {
  W.loads.push(data?.size ?? data?.byteLength ?? -1);
  const z = await load.call(this, data, ...rest);
  for (const f of Object.values(z.files)) {
    const n = f.unsafeOriginalName ?? f.name;
    for (const m of ['async', 'nodeStream']) { const o = f[m]; f[m] = function (...a) { W.calls.push([m, n]); return o.apply(this, a); }; }
    const is = f.internalStream;
    f.internalStream = function (...a) {
      W.calls.push(['internalStream', n]);
      const s = is.apply(this, a);
      s.on('data', (c) => { W.bytes[n] = (W.bytes[n] || 0) + c.length; });
      return s;
    };
  }
  return z;
};
export default JSZip;`;
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
/** Serves page p's JSZip through SPY_MODULE (the real build behind it:
 *  h.js's CDN route serves `?real` from the local copy) and records every
 *  request the page makes for that URL in `p.jszipAt` (Date.now() of each). */
async function zipSpy(p) {
  p.jszipAt = [];
  p.on('request', (r) => { if (r.url() === JSZIP_URL) p.jszipAt.push(Date.now()); });
  await p.route((u) => u.href === JSZIP_URL, (route) => route.fulfill({ body: SPY_MODULE, contentType: 'text/javascript' }));
}

/** A press on `sel` (its first match): a tap on a touch page (p.touch), else a click. */
const press = (p, sel) => (p.touch ? p.locator(sel).first().tap() : p.locator(sel).first().click());
/** Opens page p's 📦 dialog (unless it is open). */
async function openBoxes(p) {
  if (await p.$('#box-dialog[open]')) return;
  await press(p, '#box-btn');
  await p.waitForSelector('#box-dialog[open]');
}
/** Closes page p's 📦 dialog with its own close control (whichever shows: the footer's Close or the header's ✕). */
async function closeBoxes(p) {
  if (!(await p.$('#box-dialog[open]'))) return;
  const sel = (await p.isVisible('#box-dialog > form menu button')) ? '#box-dialog > form menu button' : '#box-dialog .box-head button';
  await press(p, sel);
  await p.waitForSelector('#box-dialog:not([open])', { state: 'attached' });
}
/** What page p's 📦 dialog shows now: {progress, err, msg, xmsg, ask: the open #box-ask's data-kind or null, open}. */
const says = (p) => p.evaluate(() => {
  const t = (id) => document.getElementById(id).textContent;
  return { progress: t('box-progress'), err: t('box-err'), msg: t('box-msg'), xmsg: t('box-x-msg'), ask: document.querySelector('#box-ask[open]')?.dataset.kind || null, open: !!document.querySelector('#box-dialog[open]') };
});
/** Page p picks `files` (paths, or file()s) in its 📦 dialog's upload, "Set
 *  up now" set to `now` where the page shows it (the host's), and waits
 *  until the upload has an outcome: #box-ask opens, an error shows, the
 *  dialog closes, or the progress line says how it ended (`done`, a regex:
 *  the host's "Added…" / "That box…", a guest's answer). Returns says(). */
async function upload(p, files, { now = false, done = /^(Added|That box|«)/u, timeout = 60000 } = {}) {
  await openBoxes(p);
  if (await p.isVisible('#box-now')) await p.setChecked('#box-now', now);
  await p.evaluate(() => { for (const id of ['box-progress', 'box-err', 'box-msg']) document.getElementById(id).textContent = ''; });
  await p.setInputFiles('#box-files', files);
  await p.waitForFunction((src) => {
    const $ = (id) => document.getElementById(id);
    return !!document.querySelector('#box-ask[open]') || !document.querySelector('#box-dialog[open]') || !!$('box-err').textContent
      || (!$('box-up').disabled && new RegExp(src, 'u').test($('box-progress').textContent));
  }, done.source, { timeout });
  return says(p);
}
/** Page p's #box-ask once it is open with data-kind `kind` (within 15 s):
 *  {kind, title, lines (the body's texts), checks ({id: ticked}), buttons ([{v, label}])}; null when it doesn't open. */
const asked = (p, kind) => p.waitForSelector(`#box-ask[open][data-kind="${kind}"]`, { timeout: 15000 }).then(() => p.evaluate(() => {
  const d = document.getElementById('box-ask');
  return {
    kind: d.dataset.kind, title: document.getElementById('box-ask-title').textContent,
    lines: [...d.querySelectorAll('#box-ask-body p')].map((e) => e.textContent),
    checks: Object.fromEntries([...d.querySelectorAll('#box-ask-body input[type=checkbox]')].map((c) => [c.dataset.c, c.checked])),
    labels: [...d.querySelectorAll('#box-ask-body label')].map((l) => l.textContent.trim()),
    buttons: [...d.querySelectorAll('#box-ask-btns button')].map((b) => ({ v: b.value, label: b.textContent })),
  };
}), () => null);
/** Page p answers the open #box-ask: ticks/unticks the checkboxes labelled
 *  as in `checks` ({label text: on}), then presses the button labelled `label`. */
async function reply(p, label, checks = {}) {
  for (const [text, on] of Object.entries(checks)) {
    const box = p.locator('#box-ask-body label', { hasText: text }).locator('input[type=checkbox]');
    if (p.touch ? (await box.isChecked()) !== on : true) {
      if (p.touch) await box.tap(); else await box.setChecked(on);
    }
  }
  await press(p, `#box-ask-btns button:text-is("${label}")`);
  await p.waitForSelector('#box-ask:not([open])', { state: 'attached' });
}
/** Waits until host page p's queue has been idle for 300 ms on end (a
 *  dialog's button reaches act() a task after the press). */
const settle = (p, ms = 300) => p.waitForFunction((ms) => {
  if (window.__ct.jobs()) window.__idleAt = null;
  else window.__idleAt ??= performance.now();
  return window.__idleAt != null && performance.now() - window.__idleAt >= ms;
}, ms, { timeout: 30000, polling: 50 }).finally(() => p.evaluate(() => { window.__idleAt = null; }));
/** The host's state (its seat keys left out). */
const S = (p) => p.evaluate(() => window.__ct.hostState());
/** The row of box `id` in page p's open 📦 dialog: {name, text, buttons: [data-act]} or null. */
const row = (p, id) => p.evaluate((id) => {
  const r = document.querySelector(`#box-list .box-row[data-box="${id}"]`);
  return r && { text: r.textContent.replace(/\s+/g, ' ').trim(), buttons: [...r.querySelectorAll('button[data-act]')].map((b) => b.dataset.act) };
}, id);
/** The toasts page p showed since `at` (Date.now()). */
const toasts = (p, at = 0) => p.evaluate((at) => window.__toasts.filter((x) => x.at >= at).map((x) => x.msg), at);
/** What page p's 📦 dialog said since `at`: [{el, msg}]. */
const boxSaid = (p, at = 0) => p.evaluate((at) => window.__boxSays.filter((x) => x.at >= at).map(({ el, msg }) => ({ el, msg })), at);
/** Whether every element matching `sel` on page p lies inside the viewport (and there is one). */
const inView = (p, sel) => p.evaluate((s) => {
  const els = [...document.querySelectorAll(s)].filter((el) => el.getClientRects().length);
  return els.length > 0 && els.every((el) => { const r = el.getBoundingClientRect(); return r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; });
}, sel);
/** Page p's image asset `id` as this browser stores it (IndexedDB `assets`):
 *  {mime, size, magic: the type its bytes are, w, h (decoded)} or null. */
const asset = (p, id) => p.evaluate(async (id) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('cardtable'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    const rec = await new Promise((res, rej) => { const r = db.transaction('assets').objectStore('assets').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (!rec) return null;
    const u = new Uint8Array(rec.data), s = (a, b) => String.fromCharCode(...u.subarray(a, b));
    const magic = u[0] === 0x89 && s(1, 4) === 'PNG' ? 'image/png' : u[0] === 0xff && u[1] === 0xd8 ? 'image/jpeg' : s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP' ? 'image/webp' : s(0, 4) === 'GIF8' ? 'image/gif' : null;
    const bmp = await createImageBitmap(new Blob([rec.data]));
    const out = { mime: rec.mime, size: rec.data.byteLength, magic, w: bmp.width, h: bmp.height };
    bmp.close();
    return out;
  } finally { db.close(); }
}, id);
/** Whether item `id` is drawn on page p with every image in it loaded (a decoded picture). */
const drawnWithImages = (p, id) => p.evaluate((id) => {
  const el = document.querySelector(`.item[data-id="${id}"]`);
  if (!el) return { drawn: false, imgs: 0, loaded: 0 };
  const imgs = [...el.querySelectorAll('img')];
  return { drawn: true, imgs: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length };
}, id);
/** The seated players of a host state in "#k" order (spec §4a: clockwise from the bottom, (seat − 90 + 360) % 360, from 1). */
const ranked = (st) => Object.entries(st.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360)).map(([q]) => q);

module.exports = {
  zip, unzip, png, pixels, prng, photo, noise, hugePNG, magic, sha256, file, watchers, zipSpy, JSZIP_URL,
  press, openBoxes, closeBoxes, says, upload, asked, reply, settle, S, row, toasts, boxSaid, inView, asset, drawnWithImages, ranked,
};
