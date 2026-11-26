// Card Table — game boxes in and out (spec §4j, §4m). In: a game.json picked
// with its images and rules file, or one .zip of them, read into the
// TransportBox that addBox takes (core.js checkTransportBox, then store.js
// ingestBox on the host) — every image checked by its header before it is
// decoded, then re-encoded (encodeImage, which the + Deck dialog uses too).
// Out: the table as a game box again (exportFile), a .zip with its images or
// a .json. Nothing here trusts an upload: a zip is read within every limit
// below whatever its directory says, a path is only ever a lookup key, and
// an image leaves as what a canvas wrote. JSZip comes from the CDN on first use.
import { ASSET_MAX_BYTES, COLOR_RE, MAX_DECK_CARDS, MAX_RULES_CHARS, RANKS, SUITS } from './core.js?v=1';
import { IMG_MAX_SIDE, IMG_MAX_PX, imageDims, imageType, sha256hex, has } from './store.js?v=1';

/** This file's code version (see core.js MODULE_V). */
export const MODULE_V = 1;
/** Import limits (spec §4j): a .zip file; its entries; the bytes an upload
 *  inflates to, in all and in one file; a rules file (200,000 characters
 *  of UTF-16 are at most 600,000 bytes of UTF-8). */
export const ZIP_MAX_BYTES = 64e6, ZIP_MAX_ENTRIES = 2100, IMPORT_MAX_BYTES = 64e6, FILE_MAX_BYTES = 16e6, RULES_MAX_BYTES = 3 * MAX_RULES_CHARS;
/** Image encoding: the long side of a board's images and of the others; a board image that can't fit ASSET_MAX_BYTES at BOARD_MIN_PX is an error. */
export const BOARD_PX = 2048, PIECE_PX = 560, BOARD_MIN_PX = 1024;
/** The qualities tried, best first, before an image is made smaller (PNG is lossless: its size alone steps down). */
const QUALITY = { 'image/webp': [0.8, 0.7, 0.6], 'image/jpeg': [0.85, 0.7, 0.6], 'image/png': [undefined] };
const EXT = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm'; // (3.10.1 ships no ES module: jsdelivr's +esm wraps it)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const utf8 = (bytes, name) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (err) { throw new Error(`${name} is not UTF-8 text (${err.message})`); }
};
let jszip = null;
/** JSZip's class, imported once (a failed import is tried again next time). */
const loadJSZip = () => (jszip ||= import(JSZIP_URL).then((m) => m.default, (err) => {
  jszip = null;
  throw new Error(`the zip reader couldn't be loaded (${err.message})`);
}));

// --- images ----------------------------------------------------------------
/** Card name from an image filename: "cards/dragon_rider.png" → "dragon rider". */
const nameFromFile = (fn) => fn.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 60);

let canvas = null; // one canvas, reused (iOS caps the memory all canvases hold), sized to each image
/** The image type a data URL's bytes really are (store.js imageType of its first bytes). */
const urlType = (url) => imageType(Uint8Array.from(atob(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 25)), (c) => c.charCodeAt(0)));
/** The bytes a base64 data URL holds. */
const urlBytes = (url) => { const b = url.length - url.indexOf(',') - 1; return (b * 3) / 4 - (url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0); };
/** Whether nothing drawn on `ctx` (w × h) is see-through: alpha 250 and up
 *  counts as opaque (WebKit's smooth downscale leaves 254 on a few pixels of
 *  an opaque photo; JPEG lays them on black, 2% off at most: D307). */
function opaque(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let k = 3; k < d.length; k += 4) if (d[k] < 250) return false;
  return true;
}
/** Bytes as a data URL of type `mime`. */
const asURL = (bytes, mime) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(new Blob([bytes], { type: mime }));
});

/** An uploaded image (a File, a Blob or bytes) as the data URL a deck or a box
 *  carries (spec §4j). Its header is read first (store.js imageDims: its
 *  real type by its magic bytes — an SVG or HTML file named .png is no image
 *  — and at most IMG_MAX_SIDE a side, IMG_MAX_PX in all), before anything
 *  decodes it; then it is drawn on a canvas at most `max` px on its long side
 *  (BOARD_PX for a board's images) and re-encoded: as WebP 0.8 when the
 *  canvas really writes WebP (Safari may write a PNG when asked for one),
 *  else as JPEG 0.85 when it is opaque, or PNG — and over ASSET_MAX_BYTES,
 *  at a lower quality (0.7, 0.6), then smaller (× 0.85 a step), an error
 *  below BOARD_MIN_PX (or its own size, when smaller). Its type is read off
 *  the bytes the canvas wrote. An image this browser already holds (by its
 *  hash) that is within `max` and the size cap is kept byte for byte: it
 *  passed these very checks (an exported box's own images), so a box
 *  exported and imported again is the same box. Errors name the file (`name`). */
export async function encodeImage(src, { max = PIECE_PX, name = 'the image' } = {}) {
  const bytes = src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer());
  const mime = imageType(bytes);
  if (!mime) throw new Error(`${name}: not a PNG, JPEG, WebP or GIF image`);
  let w, h;
  try { ({ w, h } = imageDims(bytes, mime)); } catch (err) { throw new Error(`${name}: ${err.message}`); }
  if (w > IMG_MAX_SIDE || h > IMG_MAX_SIDE || w * h > IMG_MAX_PX) throw new Error(`${name}: the image is ${w} × ${h} px (max ${IMG_MAX_SIDE} px a side, ${IMG_MAX_PX / 1e6} Mpx)`);
  if (mime !== 'image/gif' && Math.max(w, h) <= max && bytes.length <= ASSET_MAX_BYTES && await has(await sha256hex(bytes))) return asURL(bytes, mime);
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type: mime })); } catch (err) {
    throw new Error(`${name}: the image can't be decoded (${err.message || err.name})`);
  }
  canvas ||= document.createElement('canvas');
  try {
    const long = Math.max(bmp.width, bmp.height);
    let side = Math.min(max, long), type = null, qs;
    const floor = Math.min(BOARD_MIN_PX, side);
    for (;;) {
      canvas.width = Math.max(1, Math.round((bmp.width * side) / long));
      canvas.height = Math.max(1, Math.round((bmp.height * side) / long));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (!type) { // the format, once: WebP if this browser writes it, else by transparency
        type = urlType(canvas.toDataURL('image/webp', QUALITY['image/webp'][0])) === 'image/webp' ? 'image/webp'
          : opaque(ctx, canvas.width, canvas.height) ? 'image/jpeg' : 'image/png';
        qs = QUALITY[type];
      }
      for (const q of qs) {
        const url = canvas.toDataURL(type, q), real = urlType(url);
        if (!real) throw new Error(`${name}: this browser's canvas wrote no image (${url.slice(0, 30)}…)`);
        if (urlBytes(url) <= ASSET_MAX_BYTES) return `data:${real};base64,${url.slice(url.indexOf(',') + 1)}`;
      }
      qs = qs.slice(-1); // (smaller now, at the lowest quality)
      side = Math.floor(side * 0.85);
      if (side < floor) throw new Error(`${name}: too detailed to fit ${mb(ASSET_MAX_BYTES)} even at ${floor} px`);
    }
  } finally {
    bmp.close();
    canvas.width = canvas.height = 1; // (its memory goes back at once)
  }
}

// --- decks -------------------------------------------------------------------
/** A deck.json manifest `m` — the + Deck dialog's, and each deck of a
 *  game.json — as a deck in the upload shape (core.js cleanDeckV1): `name`,
 *  `back` (a colour — "#…", or a name like "navy" that no file of the
 *  upload has, `has(fileName)` — or an image's file name) and `cards`: [{file?,
 *  name?, text?, color?, bg?, meta?, r?, s?, c?, count?}]. A card shows the
 *  image `file` (named after it unless it has a name), else its text: no art
 *  needed; `r` and `s` make it a standard card (rank, suit; `c` its colour,
 *  "r" or "b": an export writes a standard deck so); `count` copies, at
 *  most 500 a card and MAX_DECK_CARDS in all (said as soon as it is past,
 *  before a list that size is made). `img(fileName)` turns a file name into
 *  a data URL; an image several cards show is stored once; `isFile(name)`
 *  tells a back that names an uploaded file from a colour name. Resolves
 *  {deck, used: the file names it read}. */
async function deckOf(m, img, isFile = () => false) {
  if (!Array.isArray(m?.cards) || !m.cards.length) throw new Error('a deck needs a non-empty "cards" list');
  const imgs = [], gOf = new Map(); // file name → its index in imgs
  const idx = async (fn) => {
    if (!gOf.has(fn)) { gOf.set(fn, imgs.length); imgs.push(await img(fn)); }
    return gOf.get(fn);
  };
  const cards = [];
  for (const [k, e] of m.cards.entries()) {
    const std = isObj(e) && RANKS.includes(e.r) && SUITS.includes(e.s);
    if (!isObj(e) || !(e.file || e.name != null || e.text || std)) throw new Error(`cards[${k}] needs a "file", a "name" or a "text"`);
    const card = { // (cleanDeckV1 checks every field)
      ...(std && { r: e.r, s: e.s, c: ['r', 'b'].includes(e.c) ? e.c : '♥♦'.includes(e.s) ? 'r' : 'b' }),
      ...((e.name != null || e.file) && { n: String(e.name ?? nameFromFile(String(e.file))).slice(0, 60) }),
      ...(e.file && { g: await idx(String(e.file)) }),
      ...(e.text && { txt: String(e.text).slice(0, 300) }),
      ...(e.color && { col: String(e.color).slice(0, 24) }),
      ...(e.bg && { b: String(e.bg).slice(0, 24) }),
      ...(e.meta !== undefined && { meta: e.meta }),
    };
    const copies = Math.min(Math.max(1, e.count | 0 || 1), 500);
    if (cards.length + copies > MAX_DECK_CARDS) throw new Error(`a deck holds at most ${MAX_DECK_CARDS.toLocaleString('en-US')} cards (cards[${k}] goes past it)`);
    for (let j = copies; j > 0; j--) cards.push(card); // (copies share the object: never mutated)
  }
  const deck = { name: String(m.name || 'Deck').slice(0, 24), back: null, imgs, cards }, back = m.back == null ? null : String(m.back);
  if (back !== null) deck.back = back.startsWith('#') || (COLOR_RE.test(back) && !isFile(back)) ? back.slice(0, 24) : imgs[await idx(back)];
  return { deck, used: new Set(gOf.keys()) };
}
/** The + Deck dialog's deck from a deck.json manifest `m` and the images
 *  picked with it (deckOf); images the manifest doesn't name still join,
 *  each a card named after its file. */
export async function manifestDeck(m, images) {
  const byName = new Map(images.map((f) => [f.name, f]));
  const img = (fn) => {
    if (!byName.has(fn)) throw new Error(`deck.json references "${fn}" but no such image was uploaded`);
    return encodeImage(byName.get(fn), { name: fn });
  };
  const { deck, used } = await deckOf(m, img, (fn) => byName.has(fn));
  for (const f of images) {
    if (used.has(f.name)) continue;
    deck.cards.push({ g: deck.imgs.length, n: nameFromFile(f.name) });
    deck.imgs.push(await encodeImage(f, { name: f.name }));
  }
  return deck;
}
/** The + Deck dialog's deck without a manifest: one card per image, named after its file. */
export async function filenameDeck(images) {
  const imgs = [], cards = [];
  for (const f of images) {
    cards.push({ g: imgs.length, n: nameFromFile(f.name) });
    imgs.push(await encodeImage(f, { name: f.name }));
  }
  return { name: 'Deck', back: null, imgs, cards };
}

// --- reading an upload ------------------------------------------------------------
/** The files of an upload of plain files (no zip), by name: {size, read(limit, spent)}. A picker gives names without folders: two alike can't be told apart. */
function plainFiles(list) {
  const twice = list.find((f, k) => list.findIndex((g) => g.name === f.name) !== k);
  if (twice) throw new Error(`two files are named "${twice.name}": pick one of them, or upload the game as a .zip`);
  return new Map(list.map((f) => [f.name, {
    size: f.size,
    async read(limit, spent) {
      if (f.size > limit) throw new Error(`${f.name} is ${mb(f.size)} (max ${mb(limit)})`);
      if ((spent.n += f.size) > IMPORT_MAX_BYTES) throw new Error(`the upload is over ${mb(IMPORT_MAX_BYTES)}`);
      return new Uint8Array(await f.arrayBuffer());
    },
  }]));
}
/** The files of zip `file`, by path (spec §4j): its size checked before
 *  JSZip reads it, then its central directory read (nothing inflated yet):
 *  at most ZIP_MAX_ENTRIES entries, none of them pointing outside it (".."
 *  or a leading "/": the zip is refused), each declaring at most
 *  FILE_MAX_BYTES and all together IMPORT_MAX_BYTES — a quick pre-check
 *  only, since a directory can lie: each entry's `read` inflates it as a
 *  stream within what it declared (inflate). A leading "./" is dropped;
 *  folders and macOS Finder's "__MACOSX/" copies are skipped. */
async function zipFiles(file) {
  if (file.size > ZIP_MAX_BYTES) throw new Error(`${file.name} is ${mb(file.size)} (max ${mb(ZIP_MAX_BYTES)})`);
  const JSZip = await loadJSZip();
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch (err) { throw new Error(`${file.name} can't be read as a zip (${err.message})`); }
  const all = Object.values(zip.files), files = new Map();
  if (all.length > ZIP_MAX_ENTRIES) throw new Error(`${file.name} holds ${all.length} files (max ${ZIP_MAX_ENTRIES})`);
  let declared = 0;
  for (const f of all) {
    const raw = f.unsafeOriginalName ?? f.name, path = raw.replace(/^(\.\/)+/, ''); // (JSZip resolves "..": its original name is the one to judge)
    if (raw.startsWith('/') || raw.split(/[\\/]/).includes('..')) throw new Error(`${file.name}: "${raw.slice(0, 80)}" points outside the zip — refused`);
    if (f.dir || path.startsWith('__MACOSX/')) continue;
    // (an entry that declares 0 bytes JSZip keeps as '' — a promise of it, never inflated: its size is 0)
    const size = typeof f._data?.then === 'function' ? 0 : f._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${file.name}: the zip reader can't tell how large "${path.slice(0, 80)}" is`);
    if (size > FILE_MAX_BYTES) throw new Error(`${path} is ${mb(size)} unzipped (max ${mb(FILE_MAX_BYTES)} a file)`);
    if ((declared += size) > IMPORT_MAX_BYTES) throw new Error(`${file.name} unzips to over ${mb(IMPORT_MAX_BYTES)}`);
    files.set(path, { size, read: (limit, spent) => inflate(f, path, size, limit, spent) });
  }
  return files;
}
/** Zip entry `f`'s bytes, inflated as a stream (JSZip's async() would
 *  inflate it whole before its own size check): the stream stops as soon as
 *  they pass what its directory declared (`declared`), this kind of file's
 *  `limit`, or the import's IMPORT_MAX_BYTES in all (`spent`: what was read
 *  before). A compressed block's output comes at once (16 KB of input, at
 *  most ~16 MB out): what arrives after the stop is dropped, never kept. */
function inflate(f, path, declared, limit, spent) {
  return new Promise((resolve, reject) => {
    const chunks = [], max = Math.min(declared, limit), s = f.internalStream('uint8array');
    let n = 0, over = false;
    const stop = (why) => { if (!over) { over = true; s.pause(); reject(new Error(why)); } };
    s.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > declared) stop(`${path} unzips to more than the ${declared.toLocaleString('en-US')} bytes its zip entry declares — refused`);
      else if (n > max) stop(`${path} is over ${mb(limit)} — refused`);
      else if (spent.n + n > IMPORT_MAX_BYTES) stop(`the zip unzips to over ${mb(IMPORT_MAX_BYTES)} — refused`);
      else chunks.push(c);
    });
    s.on('error', (err) => stop(`${path} can't be unzipped (${err.message})`));
    s.on('end', () => {
      if (over) return;
      over = true;
      spent.n += n;
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      resolve(out);
    });
    s.resume();
  });
}

/** Reads an upload (spec §4g, §4j) — one .zip, or a game.json picked with its
 *  images and rules file — into the TransportBox addBox takes: the game.json
 *  authoring format (spec §4a) with every image a data URL in `imgs` (each
 *  file once, numbered in the order the box names them — backs first, then
 *  pieces — and encoded for its largest use: a board's at BOARD_PX), each
 *  deck in the upload shape (deckOf) with the `id` it asks for, and `rules`
 *  the script's text (a file the upload holds, or the code itself). In a
 *  zip, game.json lies at its root or in its one top-level folder, and every
 *  file it names is relative to it. `progress(text)` hears of each file read
 *  ("Reading map.jpg (3/41)…"). Rejects with a message naming the file or
 *  the field; core.js checks the box itself (checkTransportBox). */
export async function readBox(picked, progress = () => {}) {
  const zips = picked.filter((f) => /\.zip$/i.test(f.name));
  if (zips.length && picked.length > 1) throw new Error('pick the .zip on its own');
  const files = zips.length ? await zipFiles(zips[0]) : plainFiles(picked), spent = { n: 0 };
  const jsons = [...files.keys()].filter((p) => (zips.length ? /^([^/]+\/)?game\.json$/i : /\.json$/i).test(p)), roots = jsons.filter((p) => !p.includes('/'));
  if (zips.length && roots.length > 1) throw new Error(`${zips[0].name} has more than one game.json at its root (${roots.join(', ')})`);
  const main = zips.length ? roots[0] ?? (jsons.length === 1 ? jsons[0] : null) : jsons.length === 1 ? jsons[0] : null;
  if (!main) {
    throw new Error(zips.length ? `${zips[0].name} has ${jsons.length ? 'a game.json in more than one folder' : 'no game.json (at its root, or in its one folder)'}`
      : jsons.length ? `pick one .json file, the game's (got ${jsons.join(', ')})` : 'pick a game.json with its images, or a .zip');
  }
  const dir = main.slice(0, main.lastIndexOf('/') + 1), read = (p, limit) => files.get(p).read(limit, spent);
  progress(`Reading ${main}…`);
  const text = utf8(await read(main, FILE_MAX_BYTES), main);
  let def;
  try { def = JSON.parse(text); } catch (err) { throw new Error(`${main} is not valid JSON: ${err.message}`); }
  if (!isObj(def)) throw new Error(`${main} must hold one object: {"name": …, "pieces": […], …}`);
  if (typeof def.name !== 'string' || !def.name.trim()) throw new Error(`${main}: "name" is required — the game's name, at most 40 characters`);
  if (def.cards !== undefined && def.pieces === undefined && def.decks === undefined) throw new Error(`${main} is a deck (it has "cards"): add it with + Deck`);
  if (def.types !== undefined && def.pieces === undefined) throw new Error(`${main}: list the piece types as "pieces": [{"id": …}, …], not "types"`);
  /** The key of the file `v` names (relative to game.json), or null: its
   *  path; among plain files (a picker gives no folders) its own name when
   *  no file has that path — an export's "images/0.webp", picked unzipped. */
  const keyOf = (v) => {
    const p = dir + v.replace(/^(\.\/)+/, ''), base = p.replace(/^.*\//, '');
    return files.has(p) ? p : !zips.length && files.has(base) ? base : null;
  };
  /** keyOf(v) for the field at `at`, checked: it must be in the upload. */
  const file = (v, at) => {
    if (typeof v !== 'string' || !v) throw new Error(`${main}: ${at} must name a file of the upload`);
    const p = keyOf(v);
    if (!p) throw new Error(`${main}: ${at} names "${v.slice(0, 80)}", which isn't in the upload`);
    return p;
  };
  const list = (v) => (Array.isArray(v) ? v : []); // (any other shape is core's to refuse)
  const pieces = list(def.pieces), backs = list(def.backs), decks = list(def.decks);
  // Every image the box names, with the largest side it is drawn at; then each deck's
  const boardBacks = new Set(pieces.filter((p) => p?.kind === 'board').map((p) => p.back));
  const boxImgs = new Map(), deckImgs = new Set(); // path → max side; paths
  const want = (v, at, board) => { const p = file(v, at); boxImgs.set(p, Math.max(boxImgs.get(p) || 0, board ? BOARD_PX : PIECE_PX)); };
  const faceOf = (b) => (isObj(b?.face) ? b.face : b); // (a back's face, or the shorthand on the back itself)
  backs.forEach((b, k) => { if (isObj(b) && faceOf(b).img !== undefined) want(faceOf(b).img, `backs[${k}]${b.face ? '.face' : ''}.img`, boardBacks.has(b.id)); });
  pieces.forEach((p, k) => {
    if (!isObj(p)) return;
    if (p.img !== undefined) want(p.img, `pieces[${k}].img`, p.kind === 'board');
    list(p.faces).forEach((f, j) => { if (isObj(f) && f.img !== undefined) want(f.img, `pieces[${k}].faces[${j}].img`, p.kind === 'board'); });
  });
  decks.forEach((d, k) => {
    for (const [j, c] of list(d?.cards).entries()) if (isObj(c) && c.file) deckImgs.add(file(c.file, `decks[${k}].cards[${j}].file`));
    if (typeof d?.back === 'string' && !d.back.startsWith('#') && (keyOf(d.back) || !COLOR_RE.test(d.back))) deckImgs.add(file(d.back, `decks[${k}].back`)); // (else a colour: "navy")
  });
  // Each image read and encoded once per size (in a box's order, then the decks')
  const urls = new Map(), total = boxImgs.size + [...deckImgs].filter((p) => boxImgs.get(p) !== PIECE_PX).length;
  const encode = async (p, max) => {
    const key = `${max} ${p}`, name = p.slice(dir.length);
    if (!urls.has(key)) {
      progress(`Reading ${name} (${urls.size + 1}/${total})…`);
      urls.set(key, await encodeImage(await read(p, FILE_MAX_BYTES), { max, name }));
    }
    return urls.get(key);
  };
  const imgs = [], index = new Map(); // path → its index in imgs
  for (const [p, max] of boxImgs) { index.set(p, imgs.length); imgs.push(await encode(p, max)); }
  const img = (f) => (isObj(f) && f.img !== undefined ? { ...f, img: index.get(file(f.img, 'img')) } : f);
  const tb = { ...def, imgs };
  if (Array.isArray(def.backs)) tb.backs = backs.map((b) => (isObj(b?.face) ? { ...b, face: img(b.face) } : img(b)));
  if (Array.isArray(def.pieces)) tb.pieces = pieces.map((p) => (isObj(p) ? { ...img(p), ...(Array.isArray(p.faces) && { faces: p.faces.map(img) }) } : p));
  if (Array.isArray(def.decks)) {
    tb.decks = [];
    for (const [k, d] of decks.entries()) {
      try {
        const { deck } = await deckOf(d, (fn) => encode(file(fn, 'file'), PIECE_PX), (fn) => !!keyOf(fn));
        tb.decks.push({ ...deck, ...(d.id !== undefined && { id: d.id }) });
      } catch (err) { throw new Error(`${main}: decks[${k}]${d?.name ? ` («${String(d.name).slice(0, 24)}»)` : ''}: ${err.message.replace(`${main}: `, '')}`); }
    }
  }
  // The rules: a file of the upload, else the code itself
  const rf = typeof def.rules === 'string' && def.rules.trim();
  if (rf && (keyOf(rf) || /^[^\n(){};]{1,200}\.js$/i.test(rf))) {
    const p = file(rf, 'rules');
    progress(`Reading ${rf}…`);
    tb.rules = utf8(await read(p, RULES_MAX_BYTES), p.slice(dir.length));
  }
  return tb;
}

// --- export -----------------------------------------------------------------
/** The table as a game box file (spec §4g, §4m): `box` is core's export
 *  (T.exportBox: images as asset ids, decks as catalog decks, ids, "#k"
 *  owners and hands, "@#k" in its rules state) written in the game.json
 *  format readBox reads — each image a file named by its place
 *  ("images/3.webp", "images/deck1-7.png"; one file per image), each deck's
 *  cards deck.json entries (consecutive equal cards as one with a `count`)
 *  — in a .zip with its images, and its rules as rules.js, when any image is
 *  involved, else as one .json. `image(id)` gives an image's bytes ({mime,
 *  data}, store.js getAsset; null when this browser lacks it). Resolves
 *  {name, blob}; rejects when an image is missing, or the file would be over
 *  the limits an import reads within (it must import again). */
export async function exportFile(box, image) {
  const files = new Map(), names = new Map(); // path → bytes; asset id → path
  const fileOf = async (h, base) => {
    if (!names.has(h)) {
      const a = await image(h);
      if (!a) throw new Error(`image ${String(h).slice(0, 12)}… is missing from this browser`);
      const p = `images/${base}.${EXT[a.mime] || 'img'}`;
      names.set(h, p);
      files.set(p, new Uint8Array(a.data));
    }
    return names.get(h);
  };
  const { imgs = [], decks, rules, ...game } = box;
  const img = async (f) => (f?.img === undefined ? f : { ...f, img: await fileOf(imgs[f.img], f.img) });
  /** f over list l, one at a time (fileOf names an image where it first appears). */
  const seq = async (l, f) => { const out = []; for (const x of l) out.push(await f(x)); return out; };
  if (game.backs) game.backs = await seq(game.backs, async (b) => ({ ...b, face: await img(b.face) }));
  if (game.pieces) game.pieces = await seq(game.pieces, async (p) => ({ ...p, faces: await seq(p.faces, img) }));
  if (decks) {
    game.decks = [];
    for (const [k, d] of decks.entries()) {
      const cards = [];
      for (const c of d.cards) {
        const e = {
          ...(c.g !== undefined && { file: await fileOf(d.imgs[c.g], `deck${k + 1}-${c.g}`) }),
          ...(c.n !== undefined ? { name: c.n } : c.g !== undefined && { name: '' }), // (else it'd be named after its file)
          ...(c.txt && { text: c.txt }), ...(c.col && { color: c.col }), ...(c.b && { bg: c.b }), ...(c.meta !== undefined && { meta: c.meta }),
          ...(c.r && { r: c.r, s: c.s, c: c.c }),
        };
        const last = cards.at(-1), same = last && JSON.stringify({ ...last, count: undefined }) === JSON.stringify(e);
        if (same && (last.count || 1) < 500) last.count = (last.count || 1) + 1;
        else cards.push(e);
      }
      game.decks.push({ name: d.name, ...(d.id && { id: d.id }), ...(d.backImg ? { back: await fileOf(d.backImg, `deck${k + 1}-back`) } : d.back && { back: d.back }), cards });
    }
  }
  const zipped = files.size > 0;
  if (rules !== undefined) game.rules = zipped ? 'rules.js' : rules;
  const json = new TextEncoder().encode(JSON.stringify(game, null, 1)), base = String(game.name || 'game').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'game';
  if (json.length > FILE_MAX_BYTES) throw new Error(`its game.json would be ${mb(json.length)}, over the ${mb(FILE_MAX_BYTES)} an import reads`);
  if (!zipped) return { name: `${base}.json`, blob: new Blob([json], { type: 'application/json' }) };
  const zip = new (await loadJSZip())();
  zip.file('game.json', json);
  if (rules !== undefined) zip.file('rules.js', rules);
  let bytes = json.length + new TextEncoder().encode(rules || '').length;
  for (const [p, b] of files) { zip.file(p, b, { compression: 'STORE' }); bytes += b.length; } // (images are compressed already)
  if (bytes > IMPORT_MAX_BYTES || files.size + 3 > ZIP_MAX_ENTRIES) throw new Error(`it would unzip to ${mb(bytes)} in ${files.size + 3} files, over what an import reads (${mb(IMPORT_MAX_BYTES)}, ${ZIP_MAX_ENTRIES} files)`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/zip' });
  if (blob.size > ZIP_MAX_BYTES) throw new Error(`the zip would be ${mb(blob.size)} (an import reads at most ${mb(ZIP_MAX_BYTES)})`);
  return { name: `${base}.zip`, blob };
}
