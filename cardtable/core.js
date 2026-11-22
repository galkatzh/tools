// Card Table — the state core: the table's state and every operation on it.
//
// No DOM, network, storage or timers here, so the page (app.js), a rules
// Worker and Node tests all run the same state code (TABLETOP.md §5, §7).
// It imports only grid.js (board geometry) and templates.js (the built-in
// game boxes), both pure too, and runs in a page, in a module Worker and in Node 22.
//
// The host owns one table: `const T = createTable(state, env)`.
//  • state is plain JSON, version STATE_V — {v, seq, table, seats, items,
//    players, keys, log, rules, decks, boxes, boxSrc, guestDeckChars, zMax,
//    boardSeq, lastSetup?} — the host's authoritative copy, so it is called
//    `host` below. T mutates it in place; T.state is that same object, which
//    the app saves (T.snapshot(), the catalog apart: decks, boxes and boxSrc).
//    Older saves are lifted on the way in (migrate, MIGRATE).
//  • env injects what isn't pure: {pid (the host's own player id), now()
//    (Date.now), randInt(n) (a uniform integer in [0, n), crypto: every
//    shuffle, roll and pull), random() (a float in [0, 1)), uid() (8 hex
//    digits, crypto: the ids of new items, decks and boxes), hooks (the rules
//    runner, see scriptHooks)}. Seed now, random (or randInt) and uid, and two
//    tables replay alike.
//  • Side effects become data: every call queues effects, in order, and the
//    app takes them with T.drain() after each call:
//      {t:'fx', f}         an action marker {p, id, x, y, roll?: [die ids]} (the name bulbs, the dice tumble)
//      {t:'ann', msg}      a banner for every screen (t.announce)
//      {t:'note', p, msg}  a private notice for player p
//      {t:'peek', p, c}    a peeked card {d, i} or piece {t, f}, for player p's eyes only
//      {t:'toast', msg}    a notice for the host's own screen (script errors)
//      {t:'deck', id}      a new deck, to send to everyone
//      {t:'box', id}       a new game box, to send to everyone (and to save)
//      {t:'rules'}         the script or its on/off state changed: resend the code
//  • apply(), leave(), runTimers() and refreshFor() return true, and join()
//    {changed: true}, when the table changed (it was renumbered, state.seq):
//    the app then broadcasts and saves.
//  • Delta sync (TABLETOP.md §3): every write records what it
//    changed in the dirty sets, and the app's broadcast tick takes them once
//    (T.takeDirty()) to build one patch for everyone (T.patchContent()) or a
//    full snapshot for a newcomer (T.snapContent()). T.pub caches each item's
//    public view, so neither rebuilds the whole table. Guests fold the bodies
//    into their view with viewFromSnap() and applyViewPatch().
import { parseAddr, formatAddr } from './grid.js?v=1';
import { BOXES } from './templates.js?v=1';

// --- versions -----------------------------------------------------------------
/** The code version every cardtable module exports, and every import of one
 *  carries (`./core.js?v=1`): bumped in all of them by every change to any,
 *  so a page never mixes a fresh module with a cached one (app.js checks). */
export const MODULE_V = 1;
/** The wire protocol: actions carry it as `_v`, host bodies as `v`; a peer
 *  on another version is refused loudly rather than misread. */
export const PROTO = 3;
/** The host state's schema version (state.v), the newest MIGRATE target. */
export const STATE_V = 3;

// --- table geometry ---------------------------------------------------------
// The table is round (a circle: rotation-invariant, so every player can turn
// their view to put their own seat at the bottom) or a rectangle (for boards
// and maps). Its shape and size are part of the state (state.table: {shape,
// w, h, felt?}); the host can change them. Items keep their TOP-LEFT corner
// in x, y; sizeOf() tells their size.
export const CARD_W = 100, CARD_H = 140;
export const TABLE_SIZES = { 1300: 'small', 1800: 'medium', 2400: 'large' };
/** A rectangular table's bounds: w in RECT_W, h in RECT_H (inclusive). */
export const RECT_W = [800, 6000], RECT_H = [600, 4000];
/** The felt's colour unless the table says otherwise. */
export const FELT = '#17603a';
const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ecd444', '#ee6352', '#9ac2c9', '#8acb88', '#1be7ff'];
/** Max distance of an item's centre from the centre of a round table `size` units across. */
export const playR = (size) => size / 2 - 110;
/** Where seats sit on a round table: their distance from its centre. */
export const seatR = (size) => size / 2 - 50;
/** A fresh round table, the default. */
export const roundTable = (size = 1300) => ({ shape: 'round', w: size, h: size });

/** Clamps an item of size w × h at top-left (x, y) onto table tb: on a round
 *  table its centre stays within playR of the table's centre, on a rectangle
 *  inside [60, w − 60] × [60, h − 60]. Returns the clamped top-left {x, y}. */
export function clampToTable(tb, x, y, w, h) {
  if (tb.shape === 'rect') return { x: clamp(x + w / 2, 60, tb.w - 60) - w / 2, y: clamp(y + h / 2, 60, tb.h - 60) - h / 2 };
  const r = playR(tb.w), cx = x + w / 2 - tb.w / 2, cy = y + h / 2 - tb.h / 2, d = Math.hypot(cx, cy);
  if (d <= r) return { x, y };
  return { x: tb.w / 2 + (cx * r) / d - w / 2, y: tb.h / 2 + (cy * r) / d - h / 2 };
}

// --- seats: an angle on the table's rim (90° = the bottom) --------------------
const RAD = Math.PI / 180;
/** Degrees in [0, 360) of the direction (dx, dy) (screen axes: y grows downward). */
const angleOf = (dx, dy) => (((Math.atan2(dy, dx) / RAD) % 360) + 360) % 360;
/** The point where a seat at angle `a` sits: on a round table seatR from the
 *  centre; on a rectangle where the ray from the centre meets the table
 *  inset by 50. Also {ux, uy}: the unit vector from the seat toward the table
 *  (radial on a round table, the inward normal of the edge on a rectangle). */
export function seatPoint(tb, a) {
  const c = Math.cos(a * RAD), s = Math.sin(a * RAD), cx = tb.w / 2, cy = tb.h / 2;
  if (tb.shape !== 'rect') return { x: cx + seatR(tb.w) * c, y: cy + seatR(tb.w) * s, ux: -c, uy: -s };
  const tx = Math.abs(c) > 1e-12 ? (cx - 50) / Math.abs(c) : Infinity, ty = Math.abs(s) > 1e-12 ? (cy - 50) / Math.abs(s) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + t * c, y: cy + t * s, ...(tx < ty ? { ux: -Math.sign(c), uy: 0 } : { ux: 0, uy: -Math.sign(s) }) };
}
/** A rectangle's seat perimeter (the table inset by 50) — automatic seating
 *  spreads players along it by arc length, as a round table does by angle:
 *  `perim(tb, a)` is the arc length of the seat at angle a, from the middle
 *  of the bottom edge, in the direction of growing angles; `perimAngle(tb, s)`
 *  the inverse. P is the whole perimeter. */
function perimeter(tb) {
  const ax = tb.w / 2 - 50, ay = tb.h / 2 - 50, cx = tb.w / 2, cy = tb.h / 2, P = 4 * (ax + ay);
  // the five legs, in order: bottom-left half, left, top, right, bottom-right half
  const legs = [[ax, [cx, cy + ay], [-1, 0]], [2 * ay, [cx - ax, cy + ay], [0, -1]], [2 * ax, [cx - ax, cy - ay], [1, 0]],
    [2 * ay, [cx + ax, cy - ay], [0, 1]], [ax, [cx + ax, cy + ay], [-1, 0]]];
  return {
    P,
    at(s) { // the angle at arc length s
      s = ((s % P) + P) % P;
      for (const [len, [x0, y0], [dx, dy]] of legs) {
        if (s <= len) return angleOf(x0 + dx * s - cx, y0 + dy * s - cy);
        s -= len;
      }
      return 90;
    },
    of(a) { // the arc length at angle a
      const p = seatPoint(tb, a);
      let s = 0;
      for (const [len, [x0, y0], [dx, dy]] of legs) {
        const k = dx ? (p.x - x0) * dx : (p.y - y0) * dy, off = dx ? Math.abs(p.y - y0) : Math.abs(p.x - x0);
        if (off < 1e-6 && k >= -1e-6 && k <= len + 1e-6) return (s + clamp(k, 0, len)) % P;
        s += len;
      }
      return 0;
    },
  };
}
const EDGE_ANGLE = { bottom: 90, left: 180, top: 270, right: 0 };
/** The angles of named seats `seats` (SeatDef[]) on table tb: Map<seatId, degrees>.
 *  `at` is an exact point; `angle` itself; the seats on an edge spread out —
 *  on a rectangle at fractions (k+1)/(m+1) along it (bottom and top by
 *  growing x, left and right by growing y), on a round table 30° apart
 *  around the edge's angle (bottom 90°, left 180°, top 270°, right 0°). */
export function seatAngles(tb, seats) {
  const out = new Map(), edges = {}, cx = tb.w / 2, cy = tb.h / 2;
  for (const s of seats) {
    if (s.at) out.set(s.id, angleOf(s.at[0] - cx, s.at[1] - cy));
    else if (s.angle !== undefined) out.set(s.id, normRot(s.angle));
    else (edges[s.edge || 'bottom'] ||= []).push(s);
  }
  for (const [edge, list] of Object.entries(edges)) {
    list.forEach((s, k) => {
      const m = list.length, f = (k + 1) / (m + 1);
      if (tb.shape !== 'rect') { out.set(s.id, normRot(EDGE_ANGLE[edge] + (k - (m - 1) / 2) * 30)); return; }
      const [x, y] = { bottom: [tb.w * f, tb.h - 50], top: [tb.w * f, 50], left: [50, tb.h * f], right: [tb.w - 50, tb.h * f] }[edge];
      out.set(s.id, angleOf(x - cx, y - cy));
    });
  }
  return out;
}

// --- small helpers --------------------------------------------------------
export const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const uid = () => rand(4);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** obj[key] only when it's the object's OWN property — never Object.prototype
 *  via a crafted id like "__proto__" or "constructor". Only a string or a
 *  number is a key: a peer's {"toString": 1} would make Object.hasOwn throw. */
export const own = (obj, key) => ((typeof key === 'string' || typeof key === 'number') && obj && Object.hasOwn(obj, key) ? obj[key] : null);
/** A finite number from untrusted input, else the fallback. */
export const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const normRot = (v) => ((num(v) % 360) + 360) % 360;
/** Player ids: 16 hex digits (app.js mints them; the host refuses others). */
export const PID_RE = /^[0-9a-f]{16}$/;
/** The crypto RNG, from a refilled pool of 32-bit words: one getRandomValues
 *  call per draw would make shuffling a 5000-card pile ~30× slower. */
const pool = new Uint32Array(1024);
let poolLeft = 0;
const word = () => {
  if (!poolLeft) { crypto.getRandomValues(pool); poolLeft = pool.length; }
  return pool[--poolLeft];
};
/** A uniform integer in [0, n) from the crypto RNG (the default env.randInt),
 *  n ≤ 2^32. Rejection sampling: the words at or above the largest multiple
 *  of n are drawn again, so `% n` favours no value (no modulo bias). */
export function randInt(n) {
  if (!(Number.isInteger(n) && n >= 1 && n <= 2 ** 32)) throw new RangeError(`randInt: n must be an integer in [1, 2^32], got ${n}`);
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) { const w = word(); if (w < limit) return w % n; }
}

// --- data hygiene: decks pass one sanitizer (strict image references, strict
// color grammar, size caps) before anything renders them ---------------------
// A deck travels in two shapes. The catalog shape (v2, cleanDeck) is what the
// table holds, saves and sends: its images are asset ids, the SHA-256 of
// their bytes, which store.js keeps and every peer pulls by hash (app.js).
// The transport shape (v1, cleanDeckV1) carries the images as data URLs: an
// upload, a save from before Phase 1. It only ever goes to store.js's
// ingestDeck, which checks every image and turns the deck into the v2 shape.
const IMG_HEAD = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]/;
/** Whether `s` is an image as a data URL, as
 *  /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/ would say,
 *  tested by parts: a deck carries megabytes of them, and searching for a
 *  bad character is many times faster than matching that whole pattern. */
export const isImgURL = (s) => typeof s === 'string' && IMG_HEAD.test(s) && !/[^A-Za-z0-9+/=]|=[^=]/.test(s.slice(s.indexOf(',') + 1));
/** An image's asset id: the hex SHA-256 of its bytes. */
export const ASSET_RE = /^[0-9a-f]{64}$/;
/** The image types a deck may carry (as data URLs, isImgURL, or as assets). */
export const IMG_MIMES = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif']);
/** The largest image a peer stores or accepts, in bytes. */
export const ASSET_MAX_BYTES = 2e6;
export const COLOR_RE = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i;
export const RANKS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'JOKER']);
export const SUITS = new Set(['♠', '♥', '♦', '♣', '🃏']);
export const MAX_DECK_BYTES = 24e6, MAX_DECK_CARDS = 5000;
export const GUEST_DECK_CHARS = 1.5e6; // all decks guests add to one table, together (see apply 'addDeck')
/** Why a guest's deck of `cost` chars doesn't fit a table whose guests used `used` already ('' if it fits). */
export const deckOverBudget = (used, cost) => (used + cost > GUEST_DECK_CHARS
  ? `this table's deck budget for guests is full (${Math.round((GUEST_DECK_CHARS - used) / 1e3)} kB left) — ask the host to add it` : '');
// Control characters (C0, DEL, C1) never reach a page or the terminal bridge:
// a peer's ESC sequences could clear or spoof a bridge user's terminal.
// CTRL_NL spares the newline, for multi-line card texts.
export const CTRL = /[\u0000-\u001f\u007f-\u009f]/g, CTRL_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
export const str = (v, n, strip = CTRL) => (typeof v === 'string' && v ? v.replace(strip, '').slice(0, n) : undefined);

/** A deck's name and cards, cleaned for either shape: `img(s)` tells a
 *  usable image reference (in `imgs`, and on a v1 card as `img`). Keeps only
 *  known fields of the right type, so nothing a peer sends can smuggle
 *  markup, script URLs or CSS into anyone's page. Throws on unusable decks. */
function deckParts(d, img, v1) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.cards) || !d.cards.length) throw new Error('a deck needs at least one card');
  if (d.cards.length > MAX_DECK_CARDS) throw new Error(`decks are limited to ${MAX_DECK_CARDS} cards`);
  const imgs = (Array.isArray(d.imgs) ? d.imgs : []).slice(0, MAX_DECK_CARDS).map((s) => (img(s) ? s : null));
  const cards = d.cards.map((c) => {
    const o = {};
    if (!c || typeof c !== 'object') return o;
    if (RANKS.has(c.r) && SUITS.has(c.s)) Object.assign(o, { r: c.r, s: c.s, c: c.c === 'r' ? 'r' : 'b' });
    if (v1 && img(c.img)) o.img = c.img;
    if (Number.isInteger(c.g) && imgs[c.g]) o.g = c.g;
    for (const [k, n, strip] of [['n', 60], ['txt', 300, CTRL_NL]]) if (str(c[k], n, strip)) o[k] = str(c[k], n, strip);
    for (const k of ['col', 'b']) if (COLOR_RE.test(c[k])) o[k] = c[k];
    if (c.meta !== undefined) {
      const j = JSON.stringify(c.meta);
      if (j && j.length <= 2000) o.meta = JSON.parse(j);
    }
    return o;
  });
  return { name: str(d.name, 24) || 'Deck', imgs, cards };
}
const dataURL = (s) => typeof s === 'string' && s.startsWith('data:');

/** The gate every deck the table holds passes (scripts, saves, the wire, an
 *  upload once ingested): the catalog shape, v2 — {name, back: a color or
 *  null, backImg?: an asset id, imgs: (asset id | null)[], cards}, where a
 *  card's `g` indexes a non-null image. (The 24 MB image cap is store.js's
 *  to check: only ingestion knows the sizes.) A deck that still embeds data
 *  URLs is refused: it must be ingested first, not lose its images here. */
export function cleanDeck(d) {
  const { name, imgs, cards } = deckParts(d, (s) => ASSET_RE.test(s));
  if ([d.back, ...(Array.isArray(d.imgs) ? d.imgs : []), ...d.cards.map((c) => c?.img)].some(dataURL)) {
    throw new Error('this deck still embeds its images (data URLs): it must be ingested first');
  }
  return { name, back: COLOR_RE.test(d.back) ? d.back : null, ...(ASSET_RE.test(d.backImg) && { backImg: d.backImg }), imgs, cards };
}

/** The transport gate (v1): a deck as uploads and pre-Phase 1 saves carry it,
 *  images as data URLs (isImgURL) in `imgs`, a card's `img` or the `back`, at
 *  most 24 MB of them. It runs first on every addDeck, and the guests' deck
 *  budget is measured on its result (JSON length) before anything is decoded;
 *  then store.js's ingestDeck turns it into the v2 shape. Throws on unusable decks. */
export function cleanDeckV1(d) {
  const { name, imgs, cards } = deckParts(d, isImgURL, true);
  const bytes = [...imgs, ...cards.map((c) => c.img)].reduce((n, s) => n + (s?.length || 0), 0);
  if (bytes > MAX_DECK_BYTES) throw new Error('deck images are too large (24 MB max)');
  return { name, back: isImgURL(d.back) || COLOR_RE.test(d.back) ? d.back : null, imgs, cards };
}

/** Every asset id the decks of `decks` (a deck map) and the boxes of `boxes`
 *  (a box map) show: their images and image backs. */
export function assetRefs(decks, boxes = {}) {
  const refs = new Set();
  for (const d of Object.values(decks)) {
    for (const h of d.imgs || []) if (h) refs.add(h);
    if (d.backImg) refs.add(d.backImg);
  }
  for (const b of Object.values(boxes)) for (const h of b.imgs || []) if (h) refs.add(h);
  return refs;
}

/** Text from a peer: a string as is, a number as its digits, anything else
 *  empty (String() of a crafted {"toString": 1} would throw). */
export const peerText = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
/** Player names: plain text, bounded, and never dressed up as the 📜 Rules actor. */
export const cleanName = (s) => peerText(s).replace(CTRL, '').replace(/^[\s📜]+/u, '').trim().slice(0, 24);

export function standardDeck(jokers) {
  const cards = [];
  for (const [s, c] of [['♠', 'b'], ['♥', 'r'], ['♦', 'r'], ['♣', 'b']]) {
    for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) cards.push({ r, s, c });
  }
  if (jokers) cards.push({ r: 'JOKER', s: '🃏', c: 'r' }, { r: 'JOKER', s: '🃏', c: 'b' });
  return { name: 'Standard', back: null, imgs: [], cards }; // the catalog shape (cleanDeck): it is stored as it is
}

/** Human name for card i of deck d (in the deck map `decks`) when it is
 *  public knowledge; never call for hidden cards. */
export function cardName(decks, d, i) {
  const deck = decks[d], c = deck?.cards[i];
  if (!c) return 'a card';
  if (c.n) return c.n; // custom decks carry per-card names (manifest or filename)
  if (c.r === 'JOKER') return 'Joker 🃏';
  if (c.r) return c.r + c.s;
  if (c.txt) return `“${c.txt.length > 40 ? `${c.txt.slice(0, 39)}…` : c.txt}”`; // text-only cards (CAH, t.newDeck)
  return `${deck.name} #${i + 1}`;
}

// --- pieces: types, backs and their flags ---------------------------------------
// A piece, supply or pile member names its type as "<boxId>/<typeId>" (its
// `t`). A HIDDEN one (up: false) shows only its type's back: everyone reads
// the back's flags (size, shape, rotation step, hand, stack), which every type
// sharing that back has too (cleanBox), so nothing about the type leaks.
// These helpers read a box map ({boxId: Box}) and work on host items and on
// public ones alike (a public hidden piece carries `b`, its back's ref).
export const BAG_W = 90, BAG_H = 100;
/** A piece whose box (or type, or back) isn't here draws as a "?" this size. */
export const PLACEHOLDER = 60;
const PLACEHOLDER_FLAGS = Object.freeze({ w: PLACEHOLDER, h: PLACEHOLDER, shape: 'rect', rotStep: 0, hand: false, stack: 'none', placeholder: true });
const FLAGS = ['w', 'h', 'shape', 'rotStep', 'hand', 'stack'];
/** [box, id] of a "<boxId>/<id>" ref, or null. */
function split(boxes, ref) {
  const k = typeof ref === 'string' ? ref.indexOf('/') : -1;
  const box = k > 0 && own(boxes, ref.slice(0, k));
  return box ? [box, ref.slice(k + 1)] : null;
}
/** The type a "<boxId>/<typeId>" ref names, or null. */
export const typeAt = (boxes, ref) => { const s = split(boxes, ref); return s && own(s[0].types, s[1]); };
/** The back a "<boxId>/<backId>" ref names, or null. */
export const backAt = (boxes, ref) => { const s = split(boxes, ref); return s && own(s[0].backs, s[1]); };
/** The ref of type ref's back ("<boxId>/<backId>"), or null: no such type, or no back. */
export function backRef(boxes, ref) {
  const ty = typeAt(boxes, ref);
  return ty?.back ? `${ref.slice(0, ref.indexOf('/'))}/${ty.back}` : null;
}
/** What draws piece-like `it` (a host piece, supply or pile member {t, f, up},
 *  or a public one: {t, f} shown, {b} hidden): its type when shown, its back
 *  when hidden, null when that isn't here (a placeholder). */
function lookOf(it, boxes) {
  if ('b' in it) return it.b ? backAt(boxes, it.b) : null;
  if (it.up !== false) return typeAt(boxes, it.t);
  const b = backRef(boxes, it.t);
  return b && backAt(boxes, b);
}
/** The flags of piece-like `it` (see lookOf): {w, h, shape, rotStep, hand,
 *  stack}, a placeholder's ({…, placeholder: true}) when its look isn't here. */
export function flagsOf(it, boxes) {
  const L = lookOf(it, boxes);
  return L ? Object.fromEntries(FLAGS.map((k) => [k, L[k]])) : PLACEHOLDER_FLAGS;
}
/** An item's size {w, h}, host or public: cards 100 × 140, bags 90 × 100,
 *  piles their top's, pieces and supplies their type's (the back's when hidden). */
export function sizeOf(it, boxes) {
  if (it.k === 'b') return { w: BAG_W, h: BAG_H };
  const m = it.k === 'p' ? (it.top || it.cards?.at(-1)) : it;
  if (!m || it.k === 'c' || 'd' in m) return { w: CARD_W, h: CARD_H };
  const f = flagsOf(m, boxes);
  return { w: f.w, h: f.h };
}
/** A face's name: its label, else its pips ("5", "3|4"), else its number from 1. */
export function faceLabel(face, f) {
  if (face?.label) return face.label;
  if (face?.pips !== undefined) return Array.isArray(face.pips) ? face.pips.join('|') : String(face.pips);
  return String(num(f) + 1);
}
/** A SHOWN piece's name {t, f}: its face's label if it has one, else its type's name. */
export function pieceName(boxes, t, f) {
  const ty = typeAt(boxes, t);
  return ty ? ty.faces[f]?.label || ty.name : 'an unknown piece';
}
/** What the log calls item `it` (a host item), naming nothing hidden: a card
 *  or a face-down one, a pile, a bag, a supply or "a supply of hidden
 *  pieces", a piece or "a hidden piece", with " ×N" for a stack. */
export function itemLabel(it, decks, boxes = {}) {
  switch (it.k) {
    case 'c': return it.up ? cardName(decks, it.d, it.i) : 'a face-down card';
    case 'p': return `the ${it.name || 'stacked'} pile`;
    case 'b': return it.name ? `the bag ${it.name}` : 'the bag';
    case 's': return it.up === false ? 'a supply of hidden pieces' : `the ${pieceName(boxes, it.t, it.f)} supply`;
    default: return (it.up === false ? 'a hidden piece' : pieceName(boxes, it.t, it.f)) + (it.n > 1 ? ` ×${it.n}` : '');
  }
}

// --- game boxes: the cleanBox gate (spec §2a, §2j) -------------------------------
// A box is a game's components: piece types (tokens, tiles, dice, boards),
// their backs, optionally a table, named seats and a setup. Every box the
// table holds passes cleanBox — the built-in ones, the saved ones, the ones
// from the wire — which whitelists every field, fills in the defaults, checks
// every reference and cap, and throws an Error naming the field
// ("types.man.faces[0]: label is too long (max 8)"). Fields it doesn't know
// (src, by, builtin: the host's display fields) are dropped.
export const MAX_ITEMS = 5000, MAX_N = 999, MAX_BAG = 1000, MAX_ROLL = 20;
export const MAX_TYPES = 500, MAX_BACKS = 50, MAX_FACES = 64, MAX_DIE_FACES = 100, MAX_IMGS = 2000;
export const MAX_CELLS = 4096, MAX_SPACES = 1000, MAX_ZONES = 100, MAX_POLY = 64, MAX_LINKS = 4000, MAX_FILLS = 4096, MAX_MARKS = 64;
export const MAX_SETUP_ENTRIES = 2000, MAX_SETUP_ITEMS = 3000, MAX_SEATS = 12, MAX_META_CHARS = 2000;
/** Boards sit in a z band below every other item: BOARD_Z0 + boardSeq (newer above older). */
export const BOARD_Z0 = -1e6;
/** A setup's `at: 'seat'`: the item's centre this far from the seat toward the table. */
export const SEAT_INSET = 120;
/** Type ids, and the other ids a box declares (backs, seats, spaces, zones). */
export const TYPE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/, ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const isId = (s, re = ID_RE) => typeof s === 'string' && re.test(s) && s !== '__proto__';
/** Board-local and table coordinates in a box are clamped to ±COORD. */
const COORD = 1e4;
/** The defaults of each piece kind (null: required). */
const KINDS = {
  token: { shape: 'disc', w: 60, stack: 'count', rotStep: 0, hand: false, faces: null },
  tile: { shape: 'rect', w: 100, stack: 'pile', rotStep: 90, hand: true, faces: null },
  die: { shape: 'rect', w: 56, stack: 'none', rotStep: 0, hand: false, faces: [1, 2, 3, 4, 5, 6] },
  board: { shape: 'rect', w: null, stack: 'none', rotStep: 90, hand: false, faces: [{ color: '#d6b98c' }] },
};
const SHAPES = ['rect', 'round', 'disc', 'hex', 'meeple', 'pawn'], STEPS = [0, 15, 30, 45, 60, 90], STACKS = ['pile', 'count', 'none'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A reader of object `o` (found at path `at`) whose every failure throws an
 *  Error naming the field: "{at}: {field} {problem}". A field that is
 *  undefined (or absent) takes the default; one of the wrong type throws. */
function reader(o, at) {
  const where = (k) => (at ? `${at}: ${k}` : k);
  if (!isObj(o)) throw new Error(`${at || 'the box'} must be an object`);
  const get = (k) => (Object.hasOwn(o, k) ? o[k] : undefined);
  const R = {
    fail(k, msg) { throw new Error(`${where(k)} ${msg}`); },
    has: (k) => get(k) !== undefined,
    get,
    /** A finite number, clamped to [lo, hi] (rounded first when `int`). */
    num(k, lo, hi, dflt, int) {
      const v = get(k);
      if (v === undefined && dflt !== undefined) return dflt;
      if (typeof v !== 'number' || !Number.isFinite(v)) R.fail(k, v === undefined ? 'is required' : 'must be a number');
      return clamp(int ? Math.round(v) : v, lo, hi);
    },
    int: (k, lo, hi, dflt) => R.num(k, lo, hi, dflt, true),
    /** A count, which may not exceed its cap (it throws, rather than clamp). */
    count(k, lo, hi, dflt) {
      const v = get(k);
      if (v === undefined && dflt !== undefined) return dflt;
      if (!Number.isInteger(v)) R.fail(k, v === undefined ? 'is required' : 'must be a whole number');
      if (v < lo || v > hi) R.fail(k, `must be ${lo}–${hi}`);
      return v;
    },
    one(k, list, dflt) {
      const v = get(k);
      if (v === undefined && dflt !== undefined) return dflt;
      if (!list.includes(v)) R.fail(k, `must be one of ${list.join(', ')}`);
      return v;
    },
    bool(k, dflt) {
      const v = get(k);
      if (v === undefined && dflt !== undefined) return dflt;
      if (typeof v !== 'boolean') R.fail(k, 'must be true or false');
      return v;
    },
    /** A string, its control characters stripped, at most `max` code points (min: at least that many). */
    text(k, max, min = 0, strip = CTRL) {
      const v = get(k);
      if (typeof v !== 'string') R.fail(k, v === undefined ? 'is required' : 'must be a string');
      const s = v.replace(strip, '');
      const n = [...s].length;
      if (n > max) R.fail(k, `is too long (max ${max})`);
      if (n < min) R.fail(k, 'is empty');
      return s;
    },
    color(k) {
      const v = get(k);
      if (typeof v !== 'string' || !COLOR_RE.test(v)) R.fail(k, 'is not a colour');
      return v;
    },
    /** An array of at most `max` entries (an absent one: []). */
    list(k, max, min = 0) {
      const v = get(k) ?? [];
      if (!Array.isArray(v)) R.fail(k, 'must be a list');
      if (v.length > max) R.fail(k, `has too many entries (max ${max})`);
      if (v.length < min) R.fail(k, `needs at least ${min} ${min === 1 ? 'entry' : 'entries'}`);
      return v;
    },
    /** A map of at most `max` entries whose keys match `re`: [[key, value], …]. */
    map(k, max, re = ID_RE, min = 0) {
      const v = get(k) ?? {};
      if (!isObj(v)) R.fail(k, 'must be an object');
      const keys = Object.keys(v);
      if (keys.length > max) R.fail(k, `has too many entries (max ${max})`);
      if (keys.length < min) R.fail(k, `needs at least ${min} ${min === 1 ? 'entry' : 'entries'}`);
      const bad = keys.find((key) => !isId(key, re));
      if (bad !== undefined) R.fail(k, `has a bad id: ${JSON.stringify(bad.slice(0, 40))}`);
      return keys.map((key) => [key, v[key]]);
    },
    /** A point [x, y] of finite numbers, clamped to ±COORD. */
    pair(k) {
      const v = get(k);
      if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) R.fail(k, 'must be [x, y]');
      return v.map((x) => clamp(x, -COORD, COORD));
    },
    /** JSON data of at most `max` chars, copied. */
    json(k, max) {
      let j;
      try { j = JSON.stringify(get(k)); } catch (err) { R.fail(k, `is not JSON data (${err.message})`); }
      if (j === undefined) R.fail(k, 'is not JSON data');
      if (j.length > max) R.fail(k, `is too large (max ${max} chars)`);
      return JSON.parse(j);
    },
  };
  return R;
}
/** A face (expanding the shorthand: a number n is {label: "n"}, on a die 1–6
 *  are {pips: n}; a string s is {label: s}). `imgs`: the box's images. */
function cleanFace(f, at, imgs, die) {
  if (typeof f === 'number' && die && Number.isInteger(f) && f >= 1 && f <= 6) f = { pips: f };
  else if (typeof f === 'number' || typeof f === 'string') f = { label: String(f) };
  const R = reader(f, at), o = {};
  if (R.has('img')) {
    const i = R.get('img');
    if (!Number.isInteger(i) || !imgs[i]) R.fail('img', 'names no image of the box');
    o.img = i;
  }
  if (R.has('color')) o.color = R.color('color');
  if (R.has('text')) o.text = R.text('text', 300, 0, CTRL_NL);
  if (R.has('label')) o.label = R.text('label', 8);
  if (R.has('pips')) {
    const p = R.get('pips'), pip = (x) => (typeof x === 'number' && Number.isFinite(x) ? clamp(Math.round(x), 0, 9) : R.fail('pips', 'must be 0–9, or [a, b]'));
    o.pips = Array.isArray(p) && p.length === 2 ? p.map(pip) : pip(p);
  }
  return o;
}
const FLAG_READ = {
  w: (R) => R.int('w', 8, 6000), h: (R) => R.int('h', 8, 6000), shape: (R) => R.one('shape', SHAPES),
  rotStep: (R) => R.one('rotStep', STEPS), hand: (R) => R.bool('hand'), stack: (R) => R.one('stack', STACKS),
};
/** A piece type (see KINDS for the defaults); `backs`: the box's backs so far. */
function cleanType(t, at, imgs, backs) {
  const R = reader(t, at), kind = R.one('kind', Object.keys(KINDS)), D = KINDS[kind], die = kind === 'die';
  const o = { kind, name: R.text('name', 40, 1) };
  if (D.w === null && !R.has('w')) R.fail('w', 'is required for a board');
  o.w = R.int('w', 8, 6000, D.w);
  o.h = R.int('h', 8, 6000, o.w); // h defaults to w (60 × 60, 100 × 100, 56 × 56, or the board's w)
  o.shape = R.one('shape', SHAPES, D.shape);
  const faces = R.has('faces') ? R.list('faces', die ? MAX_DIE_FACES : MAX_FACES, die ? 2 : 1) : D.faces;
  if (!faces) R.fail('faces', 'are required');
  o.faces = faces.map((f, k) => cleanFace(f, `${at}.faces[${k}]`, imgs, die));
  if (R.has('back')) {
    if (!isId(R.get('back')) || !own(backs, R.get('back'))) R.fail('back', 'names no back of the box');
    o.back = R.get('back');
  }
  o.rotStep = R.one('rotStep', STEPS, D.rotStep);
  o.hand = R.bool('hand', D.hand);
  o.stack = R.one('stack', STACKS, D.stack);
  if (R.has('meta')) o.meta = R.json('meta', MAX_META_CHARS);
  if (R.has('board')) {
    if (kind !== 'board') R.fail('board', 'is only for boards');
    o.board = cleanBoard(R.get('board'), `${at}.board`);
  }
  return o;
}
/** A grid's address list or map keys, parsed and made canonical (formatAddr). */
function addr(g, s, R, k) {
  const c = parseAddr(g, s);
  if (!c) R.fail(k, `has ${JSON.stringify(String(s).slice(0, 20))}, which is no address of this grid`);
  return formatAddr(g, c.c, c.r);
}
function cleanGrid(g, at) {
  const R = reader(g, at), o = { type: R.one('type', ['square', 'hex']) };
  const square = o.type === 'square';
  o.cols = R.count('cols', 1, 64);
  o.rows = R.count('rows', 1, 64); // (so at most 64 × 64 = MAX_CELLS cells)
  o.cell = R.num('cell', 8, 400);
  o.x = R.num('x', -COORD, COORD, 0);
  o.y = R.num('y', -COORD, COORD, 0);
  if (square) o.snap = R.one('snap', ['cell', 'point'], 'cell');
  else o.hex = R.one('hex', ['pointy', 'flat'], 'pointy');
  o.labels = R.one('labels', square ? ['chess', 'go', 'xy'] : ['axial'], square ? 'xy' : 'axial');
  if (o.labels === 'chess' && o.cols > 26) R.fail('labels', '"chess" allows at most 26 columns');
  if (o.labels === 'go' && o.cols > 25) R.fail('labels', '"go" allows at most 25 columns');
  o.draw = R.one('draw', ['checker', 'lines', 'cells', 'none'], square && o.snap === 'point' ? 'lines' : 'cells');
  if (R.has('colors')) {
    const c = R.list('colors', 2, 2);
    o.colors = c.map((x, k) => reader({ [k]: x }, `${at}.colors`).color(String(k)));
  }
  if (R.has('fills')) {
    const fills = R.get('fills');
    if (!isObj(fills)) R.fail('fills', 'must be an object');
    if (Object.keys(fills).length > MAX_FILLS) R.fail('fills', `has too many entries (max ${MAX_FILLS})`);
    o.fills = {};
    for (const [k, v] of Object.entries(fills)) o.fills[addr(o, k, R, 'fills')] = reader({ [k]: v }, `${at}.fills`).color(k);
  }
  if (R.has('marks')) o.marks = R.list('marks', MAX_MARKS).map((s) => addr(o, s, R, 'marks'));
  return o;
}
/** A board's structure: the grid, spaces, zones and links (drawn from Phase
 *  2; their meaning comes in Phase 3). */
function cleanBoard(s, at) {
  const R = reader(s, at), o = {};
  if (R.has('primary')) { if (R.get('primary') !== true) R.fail('primary', 'must be true'); o.primary = true; }
  const grid = R.has('grid') ? (o.grid = cleanGrid(R.get('grid'), `${at}.grid`)) : null;
  const ids = new Set();
  if (R.has('spaces')) {
    o.spaces = R.list('spaces', MAX_SPACES).map((sp, k) => {
      const S = reader(sp, `${at}.spaces[${k}]`), id = S.get('id');
      if (!isId(id)) S.fail('id', 'is not an id ([A-Za-z0-9_-], 1–24)');
      if (ids.has(id)) S.fail('id', `"${id}" is used twice`);
      if (grid && parseAddr(grid, id)) S.fail('id', `"${id}" reads as an address of the board's grid`);
      ids.add(id);
      const x = { id, x: S.num('x', -COORD, COORD), y: S.num('y', -COORD, COORD), r: S.num('r', 4, 400) };
      if (S.has('mark')) x.mark = S.one('mark', ['dot', 'ring', 'tri', 'rect', 'none']);
      if (S.has('w')) x.w = S.num('w', 0, 6000);
      if (S.has('h')) x.h = S.num('h', 0, 6000);
      if (S.has('dir')) x.dir = S.one('dir', ['up', 'down', 'left', 'right']);
      if (S.has('color')) x.color = S.color('color');
      if (S.has('label')) x.label = S.text('label', 12);
      return x;
    });
  }
  if (R.has('zones')) {
    const zids = new Set();
    o.zones = R.list('zones', MAX_ZONES).map((z, k) => {
      const Z = reader(z, `${at}.zones[${k}]`), id = Z.get('id');
      if (!isId(id)) Z.fail('id', 'is not an id ([A-Za-z0-9_-], 1–24)');
      if (zids.has(id)) Z.fail('id', `"${id}" is used twice`);
      zids.add(id);
      const x = { id, poly: Z.list('poly', MAX_POLY, 3).map((p, j) => reader({ p }, `${at}.zones[${k}].poly[${j}]`).pair('p')) };
      if (Z.has('owner')) {
        const ow = Z.get('owner');
        if (ow !== 'board' && !(typeof ow === 'string' && ow.startsWith('seat:') && isId(ow.slice(5)))) Z.fail('owner', 'must be "board" or "seat:<id>"');
        x.owner = ow;
      }
      if (Z.has('private')) x.private = Z.one('private', ['reveal', 'keep']);
      if (Z.has('color')) x.color = Z.color('color');
      if (Z.has('label')) x.label = Z.text('label', 24);
      return x;
    });
  }
  if (R.has('links')) {
    o.links = R.list('links', MAX_LINKS).map((l, k) => {
      if (!Array.isArray(l) || l.length !== 2 || !l.every((id) => typeof id === 'string' && ids.has(id))) R.fail(`links[${k}]`, 'must name two spaces of the board');
      return [l[0], l[1]];
    });
  }
  return o;
}
/** A table definition {shape, w, h, felt?}: round tables are 1300, 1800 or
 *  2400 across; rectangles are clamped to RECT_W × RECT_H. */
export function cleanTable(t, at = 'table') {
  const R = reader(t, at), shape = R.one('shape', ['round', 'rect']);
  let w, h;
  if (shape === 'round') {
    w = R.get('w');
    if (!own(TABLE_SIZES, w) || typeof w !== 'number') R.fail('w', 'must be 1300, 1800 or 2400 for a round table');
    h = w;
  } else {
    w = R.int('w', ...RECT_W);
    h = R.int('h', ...RECT_H);
  }
  return { shape, w, h, ...(R.has('felt') && { felt: R.color('felt') }) };
}
/** Named seats (SeatDef[]): ≤ 12, unique ids, each with at most one placement (default edge 'bottom'). */
export function cleanSeats(list, at = 'seats') {
  const ids = new Set();
  return reader({ seats: list }, '').list('seats', MAX_SEATS).map((s, k) => {
    const R = reader(s, `${at}[${k}]`), id = R.get('id');
    if (!isId(id)) R.fail('id', 'is not an id ([A-Za-z0-9_-], 1–24)');
    if (ids.has(id)) R.fail('id', `"${id}" is used twice`);
    ids.add(id);
    const o = { id, name: R.text('name', 24, 1) };
    if (R.has('color')) o.color = R.color('color');
    const keys = ['edge', 'at', 'angle'].filter((x) => R.has(x));
    if (keys.length > 1) R.fail(keys[1], `can't go with ${keys[0]} (one placement per seat)`);
    if (R.has('at')) o.at = R.pair('at');
    else if (R.has('angle')) o.angle = normRot(R.num('angle', -COORD, COORD));
    else o.edge = R.one('edge', ['bottom', 'top', 'left', 'right'], 'bottom');
    return o;
  });
}
const SETUP_KINDS = ['piece', 'supply', 'bag', 'forEachSeat', 'group'];
/** A setup (SetupEntry[], the Phase 2 grammar): its entries checked against
 *  the box's types and seats. Returns [entries, the items it spawns with
 *  `perSeat` seats]. */
function cleanSetup(list, types, seats, perSeat) {
  let entries = 0;
  const seatIds = new Set((seats || []).map((s) => s.id));
  function where(R, at, inSeat) {
    const v = R.get('at');
    if (v === 'center') return v;
    if (v === 'seat' || (isObj(v) && Object.hasOwn(v, 'seat'))) {
      if (!inSeat) R.fail('at', 'can only be a seat inside forEachSeat');
      return v === 'seat' ? v : { seat: reader(v, `${at}.at`).pair('seat') };
    }
    if (Array.isArray(v)) return R.pair('at');
    return R.fail('at', 'must be [x, y], "center", "seat" or {seat: [dx, dy]}');
  }
  function owner(R, inSeat) {
    const v = R.get('owner');
    if (v === 'seat' && inSeat) return v;
    if (typeof v === 'string' && v.startsWith('seat:') && seatIds.has(v.slice(5))) return v;
    return R.fail('owner', inSeat ? 'must be "seat" or "seat:<a seat of the box>"' : 'must be "seat:<a seat of the box>" ("seat" only inside forEachSeat)');
  }
  /** A type ref of this box, with a face f and up as the type allows. */
  function piece(R, k) {
    const id = R.get(k), ty = isId(id, TYPE_ID_RE) && own(types, id);
    if (!ty) R.fail(k, `names no type of the box (${JSON.stringify(String(id).slice(0, 40))})`);
    const o = { [k]: id };
    if (R.has('f')) { o.f = R.count('f', 0, ty.faces.length - 1); }
    if (R.has('up')) {
      o.up = R.bool('up');
      if (!o.up && !ty.back) R.fail('up', `can't be false: "${id}" has no back`);
    }
    return [o, ty];
  }
  function entry(e, at, inSeat) {
    if (++entries > MAX_SETUP_ENTRIES) throw new Error(`setup has too many entries (max ${MAX_SETUP_ENTRIES})`);
    const R = reader(e, at), kinds = SETUP_KINDS.filter((k) => R.has(k));
    if (kinds.length !== 1) throw new Error(`${at} needs exactly one of ${SETUP_KINDS.join(', ')}`);
    const [kind] = kinds;
    if (kind === 'forEachSeat' || kind === 'group') {
      if (kind === 'forEachSeat' && inSeat) R.fail(kind, "can't be inside another forEachSeat");
      let n = 0;
      const o = { [kind]: R.list(kind, MAX_SETUP_ENTRIES).map((x, k) => { const [y, m] = entry(x, `${at}.${kind}[${k}]`, inSeat || kind === 'forEachSeat'); n += m; return y; }) };
      if (kind === 'group' && R.has('shuffle')) { if (R.get('shuffle') !== true) R.fail('shuffle', 'must be true'); o.shuffle = true; }
      return [o, kind === 'forEachSeat' ? n * perSeat : n];
    }
    let o, n = 1;
    if (kind === 'bag') {
      o = { bag: [] };
      let size = 0;
      for (const [k, m] of R.list('bag', MAX_BAG).entries()) {
        const M = reader(typeof m === 'string' ? { t: m } : m, `${at}.bag[${k}]`), [x] = piece(M, 't');
        if (M.has('n')) x.n = M.count('n', 1, MAX_N);
        size += x.n ?? 1;
        o.bag.push(typeof m === 'string' ? m : x);
      }
      if (size > MAX_BAG) R.fail('bag', `holds too many pieces (max ${MAX_BAG})`);
      if (R.has('name')) o.name = R.text('name', 24);
      if (R.has('hand')) o.hand = R.bool('hand');
    } else {
      let ty;
      [o, ty] = piece(R, kind);
      if (kind === 'piece') {
        if (R.has('n')) {
          if (ty.stack !== 'count') R.fail('n', `needs a type that stacks by count ("${o.piece}" doesn't)`);
          o.n = R.count('n', 2, MAX_N);
        }
        if (R.has('count')) n = o.count = R.count('count', 1, 200);
        if (R.has('spread')) o.spread = R.pair('spread');
        if (R.has('rot')) o.rot = normRot(R.num('rot', -COORD, COORD));
      }
      if (R.has('lock')) o.lock = R.bool('lock');
    }
    o.at = where(R, at, inSeat);
    if (R.has('owner')) o.owner = owner(R, inSeat);
    return [o, n];
  }
  let total = 0;
  const out = list.map((e, k) => { const [o, n] = entry(e, `setup[${k}]`, false); total += n; return o; });
  return [out, total];
}

/** The gate every game box passes (built in, saved, from the wire, and in
 *  later phases from scripts and uploads): the Box of spec §2a, cleaned —
 *  every field whitelisted and checked, the defaults and the faces
 *  shorthand filled in, each back given its users' flags (every type that
 *  names a back must match its w, h, shape, rotStep, hand and stack). Throws
 *  an Error naming the field. cleanBox(cleanBox(b)) equals cleanBox(b). */
export function cleanBox(b) {
  const R = reader(b, '');
  const o = { name: R.text('name', 40, 1) };
  o.imgs = R.list('imgs', MAX_IMGS).map((h, k) => (h === null || ASSET_RE.test(h) ? h : R.fail(`imgs[${k}]`, 'is not an image id')));
  // Backs: what each declares (its face, any flags), the rest from its first user.
  const backs = {};
  for (const [id, raw] of R.map('backs', MAX_BACKS)) {
    const B = reader(raw, `backs.${id}`), back = {};
    for (const f of FLAGS) if (B.has(f)) back[f] = FLAG_READ[f](B);
    if (back.w !== undefined && back.h === undefined) back.h = back.w;
    back.face = B.has('face') ? cleanFace(B.get('face'), `backs.${id}.face`, o.imgs, false) : {};
    backs[id] = back;
  }
  o.types = {};
  for (const [id, raw] of R.map('types', MAX_TYPES, TYPE_ID_RE, 1)) {
    const ty = o.types[id] = cleanType(raw, `types.${id}`, o.imgs, backs);
    if (!ty.back) continue;
    const back = backs[ty.back];
    for (const f of FLAGS) {
      if (back[f] === undefined) back[f] = ty[f];
      else if (back[f] !== ty[f]) throw new Error(`types.${id}: back "${ty.back}" has ${f} ${back[f]}, this type ${ty[f]} (a back and its types must match)`);
    }
  }
  for (const [id, back] of Object.entries(backs)) {
    for (const f of FLAGS) if (back[f] === undefined) back[f] = f === 'h' ? back.w : KINDS.token[f]; // a back no type uses
    backs[id] = { ...Object.fromEntries(FLAGS.map((f) => [f, back[f]])), face: back.face };
  }
  o.backs = backs;
  if (R.has('table')) o.table = cleanTable(R.get('table'));
  if (R.has('seats')) o.seats = cleanSeats(R.get('seats'));
  if (R.has('players')) {
    const p = R.list('players', 2, 2).map((x, k) => reader({ [k]: x }, 'players').int(String(k), 1, 99));
    if (p[0] > p[1]) R.fail('players', 'must be [min, max]');
    o.players = p;
  }
  if (R.has('lockable')) o.lockable = R.one('lockable', ['anyone']);
  if (R.has('setup')) {
    // (forEachSeat is counted once per named seat here; loadBox counts again with the real seats)
    const [setup, n] = cleanSetup(R.list('setup', MAX_SETUP_ENTRIES), o.types, o.seats, o.seats?.length || 1);
    if (n > MAX_SETUP_ITEMS) R.fail('setup', `places too many items (${n}, max ${MAX_SETUP_ITEMS})`);
    o.setup = setup;
  }
  return o;
}
/** A cleaned box as one string: JSON with every object's keys sorted, so two
 *  boxes with the same content give the same string whatever their key order. */
export const canon = (box) => JSON.stringify(box, (_, v) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
/** cyrb53: a fast 53-bit string hash (not cryptographic). */
function cyrb53(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
/** A cleaned box's catalog key: cyrb53 of canon(box). Equal content, equal
 *  key; two keys that match are confirmed by comparing canon strings (a
 *  collision never merges two different boxes). */
export const boxKey = (box) => cyrb53(canon(box));
let builtins = null; // canon strings of the cleaned BOXES (made on first use)
/** Whether box `b` is one of the built-in BOXES, by content alone (never a
 *  stored or sent flag: nobody can claim it). */
export function isBuiltin(b) {
  builtins ||= new Set(Object.values(BOXES).map((x) => canon(cleanBox(x))));
  try { return builtins.has(canon(cleanBox(b))); } catch (err) {
    console.error('isBuiltin: not a box at all', err);
    return false;
  }
}

// --- rules engine (see ENGINE.md) ------------------------------------------
// Host-only execution of a host-written script that can veto actions
// (validate) and drive automations (setup/onAction/onButton/onJoin/onLeave/
// onTimer) through the same audited ops as human actions. The engine knows
// no game concepts — all game semantics live in the script.
export const RULES = 'RULES'; // synthetic actor id for script-performed ops
export const RULED_ACTIONS = new Set(['move', 'rot', 'flip', 'shuffle', 'draw', 'deal', 'play', 'handPile', 'toHand', 'toPile', 'stack', 'merge', 'del', 'addDeck', 'peek',
  'roll', 'face', 'split', 'join', 'take', 'pull', 'toBag', 'lock', 'owner', 'seat']);
/** Every action type a guest may send: the host refuses anything else at the
 *  network boundary. The host's own actions (HOST_ACTIONS) and its internal
 *  jobs (types starting with "_") never come from the wire. */
export const PUBLIC_ACTIONS = new Set([...RULED_ACTIONS, 'hello', 'snap', 'need', 'name', 'chat', 'rulesBtn']);
/** Actions only the host may take: a guest's is refused with "🚫 Only the host can do that". */
export const HOST_ACTIONS = new Set(['size', 'setRules', 'table', 'loadBox', 'clear']);
/** Actions that take from or give to the actor's hand: a refusal re-sends it. */
const HAND_ACTIONS = new Set(['play', 'handPile', 'toHand', 'draw']);
/** How many of an action's `ids` a refusal re-sends. A small cap keeps a
 *  vetoed action from making the host re-send many items to everyone (a
 *  roll's dice need none: nothing changes them before the host does). */
const NAMED_IDS = 8;
/** The most t.data may hold, as JSON (checked after validate() and once per job that ran hooks: dataOver). */
export const DATA_MAX_CHARS = 4e6;

/** The rules runner a table drives its hooks through (env.hooks): a
 *  SYNCHRONOUS, same-thread interface (tests inject their own to reach the
 *  script). It is not where a Worker goes — the table needs validate's
 *  answer inline, and the facade it hands over is closures over the state.
 *  A rules Worker (TABLETOP.md §5) runs a whole createTable() on a mirror of
 *  the state, with this runner inside; the page talks to that table.
 *    load(code)       evaluates and installs a script, returns its name; throws
 *                     (the running script stays) if it doesn't evaluate to an object
 *    has(hook)        whether the installed script defines that hook
 *    call(hook, ...)  runs it (as a method: `this` is the script) and returns
 *                     its result; throws whatever the script throws */
export function scriptHooks() {
  let script = null;
  return {
    load(code) {
      // The code sits on its own lines so a trailing // comment can't swallow the ")".
      const s = new Function(`"use strict"; return (\n${code}\n);`)();
      if (!s || typeof s !== 'object') throw new Error('script must evaluate to an ({...}) object');
      const name = String(s.name || 'Rules').slice(0, 40);
      script = s;
      return name;
    },
    has: (hook) => typeof script?.[hook] === 'function',
    call: (hook, ...args) => script[hook](...args),
  };
}

// --- the public view: what guests may know -----------------------------------
/** A pile member as everyone sees a pile's top: a face-up card {d, i, up}, a
 *  face-down one {d, up: false} (its deck, for the back); a shown piece {t, f,
 *  up: true}, a hidden one {b, up: false} (its back's ref, or null). */
function pubTop(m, boxes) {
  if ('d' in m) return m.up ? { d: m.d, i: m.i, up: true } : { d: m.d, up: false };
  return m.up ? { t: m.t, f: m.f, up: true } : { b: backRef(boxes, m.t), up: false };
}
/** An item as players see it — hidden identities stay on the host (spec
 *  §2d). A pile becomes {…, n: count, top}; a face-down loose card loses its
 *  index `i`; a hidden piece or supply shows its back's ref `b` (null when
 *  its box is missing — never its `t` or `f`, whatever fails); a bag shows
 *  how many it holds, never what. Everyone renders this one shape, the host
 *  included; only host LOGIC reads host.items. `boxes`: the box map. */
export function pubItem(it, boxes) {
  if (it.k === 'p') {
    const { cards, ...rest } = it, top = cards.at(-1);
    return { ...rest, n: cards.length, top: top && pubTop(top, boxes) };
  }
  if (it.k === 'b') { const { of, ...rest } = it; return { ...rest, n: of.length }; }
  if (it.k === 'g' || it.k === 's') {
    const o = it.up === false ? { k: it.k, b: backRef(boxes, it.t) } : { k: it.k, t: it.t, f: it.f };
    Object.assign(o, { x: it.x, y: it.y, rot: it.rot, z: it.z });
    if (it.n > 1) o.n = it.n;
    if (it.owner) o.owner = it.owner;
    if (it.lock) o.lock = true;
    return o;
  }
  const { i, ...rest } = it;
  return it.up ? { ...rest, i } : rest;
}
/** A player as everyone sees them: a hand COUNT, never the hand (nor the seat
 *  key, kept in state.keys); `seat` null for a watcher; `seatId` in a named seat. */
const pubPlayer = (pl) => ({ name: pl.name, color: pl.color, online: pl.online, handCount: pl.hand.length, seat: pl.seat ?? null, ...(pl.seatId && { seatId: pl.seatId }) });

// --- the log ------------------------------------------------------------------
/** The log's three buckets and their caps: talk (chat and renames, the
 *  entries carrying `c` or `n`), on-the-record entries (`k`: peeks) and every
 *  other action — so neither chatter nor a flood of cheap moves can push the
 *  record of a peek out of the log. */
export const LOG_CAPS = { talk: 100, loud: 50, act: 200 };
const logKind = (e) => (e.c || 'n' in e ? 'talk' : e.k ? 'loud' : 'act');
/** The log trimmed to the newest LOG_CAPS entries of each bucket (the same
 *  array when it fits). The result does not depend on how the entries were
 *  batched: the host trims after every entry, a guest once per patch, and
 *  both keep the same entries. */
export function trimLog(log) {
  const over = { talk: -LOG_CAPS.talk, loud: -LOG_CAPS.loud, act: -LOG_CAPS.act };
  for (const e of log) over[logKind(e)]++;
  // oldest first: an entry goes while its bucket still holds too many
  return over.talk > 0 || over.loud > 0 || over.act > 0 ? log.filter((e) => over[logKind(e)]-- <= 0) : log;
}

// --- saves from older versions -------------------------------------------------
/** MIGRATE[v] lifts a host state from version v to v + 1, in place (the
 *  synchronous part: the decks' images are store.js's, loadSave). */
export const MIGRATE = {
  /** v1 (every save before Phase 1, no `v`) → v2: the seat keys leave the
   *  players for state.keys (players are copied into patches; keys never
   *  travel), and z gets a running max (state.zMax). */
  1(s) {
    s.keys = {};
    for (const [p, pl] of Object.entries(s.players || {})) {
      if (!pl || typeof pl !== 'object' || !('key' in pl)) continue;
      if (typeof pl.key === 'string') s.keys[p] = pl.key;
      delete pl.key;
    }
    s.zMax = Object.values(s.items || {}).reduce((m, it) => Math.max(m, num(it?.z)), 0);
    s.v = 2;
    return s;
  },
  /** v2 → v3 (Phase 2): the round table's `size` becomes `table` (1300 when
   *  it had none: saves from before the table could grow), automatic seating
   *  (no named seats), no boards yet. Players keep their seat angles; cards
   *  and piles need nothing new. */
  2(s) {
    s.table = roundTable(own(TABLE_SIZES, s.size) ? +s.size : 1300);
    delete s.size;
    s.seats = null;
    s.boardSeq = 0;
    s.v = 3;
    return s;
  },
};
/** Lifts state `s` to STATE_V through MIGRATE (in place); a state from a
 *  newer Card Table is refused, never downgraded. */
export function migrate(s) {
  const v = num(s.v, 1);
  if (v > STATE_V) throw new Error(`this table was saved by a newer Card Table (state v${v}) — reload this page`);
  for (let k = v; k < STATE_V; k++) MIGRATE[k](s);
  return s;
}

// --- host → guest bodies --------------------------------------------------------
// A body is a snapshot {v, kind:'snap', boot, seq, host, table, seats, handy,
// rules, items, players, log, fx, ann} or a patch {v, kind:'patch', boot,
// seq, host, table?, seats?, handy?, rules?, items?, del?, players?, log?,
// fx?, ann?}, plus the recipient's own fields {to, tp, base (patches),
// hand?}. The shared part is serialized once per broadcast tick and each
// recipient's body is spliced from it as text.
/** The fields a body carries for its recipient alone (spliceBody's `mine`). */
const OWN_FIELDS = ['to', 'tp', 'base', 'hand'];
/** A tick's shared part as JSON text. It never holds a recipient's own field:
 *  JSON.parse keeps the last of two equal keys, so a shared `to` or `tp` would
 *  silently override the binding spliceBody puts first. */
export function sharedText(o) {
  const bad = OWN_FIELDS.find((k) => k in o);
  if (bad) throw new Error(`a shared body part may not carry "${bad}"`);
  return JSON.stringify(o);
}
/** One recipient's body as JSON text: its own fields `mine` (never empty:
 *  `to` at least), then the shared JSON text (sharedText). */
export function spliceBody(mine, shared) {
  const head = JSON.stringify(mine);
  return head.slice(0, -1) + (shared === '{}' ? '}' : `,${shared.slice(1)}`);
}
/** The host's signature: ECDSA P-256 over SHA-256 (the room id is the key's fingerprint). */
export const SIG = { name: 'ECDSA', hash: 'SHA-256' };
/** Seals a body already serialized as `text`: {b: text, s: its signature
 *  (base64), k: the host's base64 raw public key `pub`}. */
export async function sealText(text, key, pub) {
  const s = new Uint8Array(await crypto.subtle.sign(SIG, key, new TextEncoder().encode(text)));
  return { b: text, s: btoa(String.fromCharCode(...s)), k: pub };
}

// A guest's view: {seq, boot, host, table, seats, handy, rules, items,
// players, log, hand}. items and players are null-prototype maps: an id from
// the wire is only ever a key, never Object.prototype (a legacy unsigned room
// can send anything).
const dict = (o) => Object.assign(Object.create(null), o && typeof o === 'object' && !Array.isArray(o) ? o : {});
const entries = (l) => (Array.isArray(l) ? l.filter((e) => e && typeof e === 'object') : []);
/** A table definition from the wire, checked (cleanTable); a bad one is
 *  logged and shown as the default round table. */
function viewTable(t) {
  try { return cleanTable(t); } catch (err) {
    console.error('the host sent a bad table', err);
    return roundTable();
  }
}
/** Named seats from the wire, checked (cleanSeats); bad ones are logged and dropped. */
function viewSeats(s) {
  if (s == null) return null;
  try { return cleanSeats(s); } catch (err) {
    console.error('the host sent bad seats', err);
    return null;
  }
}
/** A guest's whole view from a snapshot body. */
export function viewFromSnap(d) {
  return {
    seq: d.seq, boot: d.boot, host: d.host, table: d.table ? viewTable(d.table) : roundTable(), seats: viewSeats(d.seats), handy: !!d.handy,
    rules: d.rules ?? null, items: dict(d.items), players: dict(d.players), log: trimLog(entries(d.log)), hand: Array.isArray(d.hand) ? d.hand : [],
  };
}
/** Folds a patch body into view V, in place: items and players are replaced
 *  whole, `del` removed, log entries appended (then trimmed), the hand, the
 *  table, the seats and `handy` replaced when present. Returns what it
 *  replaced, for the renderer: {items: Map<id, old public item | undefined
 *  (new)>, players: Map<pid, old | undefined>}. */
export function applyViewPatch(V, d) {
  const items = new Map(), players = new Map();
  for (const [id, it] of Object.entries(dict(d.items))) { items.set(id, V.items[id]); V.items[id] = it; }
  for (const id of Array.isArray(d.del) ? d.del : []) {
    if (!items.has(id)) items.set(id, V.items[id]);
    delete V.items[id];
  }
  for (const [p, pl] of Object.entries(dict(d.players))) { players.set(p, V.players[p]); V.players[p] = pl; }
  if ('rules' in d) V.rules = d.rules;
  if ('table' in d) V.table = viewTable(d.table);
  if ('seats' in d) V.seats = viewSeats(d.seats);
  if ('handy' in d) V.handy = !!d.handy;
  if (Array.isArray(d.log)) V.log = trimLog(V.log.concat(entries(d.log)));
  if (Array.isArray(d.hand)) V.hand = d.hand;
  V.seq = d.seq;
  return { items, players };
}

/** Whether item `it` is hidden from player p: in Phase 2, a piece or supply
 *  face down (up: false), hidden from everyone alike (Phase 5 adds `vis`). */
export const hiddenFrom = (p, it) => (it.k === 'g' || it.k === 's') && it.up === false;
/** A pile member, an item or a hand entry: a card (else a piece)? */
const isCard = (m) => m.k === 'c' || 'd' in m;
/** How far clockwise from the bottom a player sits (watchers last). */
const clockwise = (pl) => (pl.seat == null ? 1e9 : (pl.seat - 90 + 360) % 360);
/** How many items setup `list` spawns with `perSeat` seats for each forEachSeat. */
const countSetup = (list, perSeat) => list.reduce((n, e) => n + (e.forEachSeat ? perSeat * countSetup(e.forEachSeat, perSeat)
  : e.group ? countSetup(e.group, perSeat) : e.count ?? 1), 0);

// --- the table ---------------------------------------------------------------
// decks:  {deckId: Deck v2 (cleanDeck): {name, back, backImg?, imgs: [asset id], cards: [{r,s,c} | {g?, n?, txt?, …}]}}
// boxes:  {boxId: Box (cleanBox)}; boxSrc: {boxId: {src: 'host' | 'upload' | 'script', by?: pid}} (host-written, never read from a box)
// items:  {itemId: card {k:'c',x,y,rot,z,d,i,up} | pile {k:'p',…,name,cards:[{d,i,up} | {t,f,up}]}
//          | piece {k:'g',…,t,f,up?:false,n?} | supply {k:'s',…,t,f,up?:false} | bag {k:'b',…,of:[{t,f,up?}],name,color?,hand?}},
//          every kind with owner? (a pid or 'seat:<id>') and lock?
// players: {pid: {name, color, online, seat (an angle; null: watching), seatId?, hand:[{d,i} | {t,f,up?}]}}; keys: {pid: seat key}
/** A table over `host` (its state, mutated in place) — see the top of this file. */
export function createTable(host, env = {}) {
  const pid = env.pid;
  // Host-only powers (setRules, table, loadBox, clear, no deck budget) go to
  // `p === pid`: an unset pid would hand them to any caller that passes no player id.
  if (!pid || typeof pid !== 'string' || pid === RULES) throw new Error(`createTable: env.pid must be the host's player id, got ${pid}`);
  const now = env.now || Date.now, hooks = env.hooks || scriptHooks();
  // One RNG for every draw (shuffles, rolls, pulls, t.random): env.randInt,
  // else one over a seeded env.random (tests), else the crypto one.
  const rint = env.randInt || (env.random ? (n) => Math.floor(env.random() * n) : randInt);
  const random = env.random || (() => rint(2 ** 32) / 2 ** 32);
  const newId = env.uid || uid;
  host.seq ??= 1;
  host.items ??= {};
  host.players ??= {};
  host.log ||= []; // saves from before the log existed
  // Core reads host.decks and host.boxes afresh at every use (never a
  // captured copy), so a resync or a rollback may replace them.
  host.decks ??= {};
  host.boxes ??= {};
  host.boxSrc ??= {};
  migrate(host);
  host.keys ??= {};
  try { host.table = cleanTable(host.table); } catch (err) {
    console.error('the saved table is unreadable: a small round one instead', err);
    host.table = roundTable();
  }
  try { host.seats = host.seats == null ? null : cleanSeats(host.seats); } catch (err) {
    console.error('the saved named seats are unreadable: automatic seating instead', err);
    host.seats = null;
  }
  host.zMax = Object.values(host.items).reduce((m, it) => Math.max(m, num(it.z)), num(host.zMax));
  // Boards' z: BOARD_Z0 + boardSeq, so the newest board's tells the count.
  host.boardSeq = Object.values(host.items).reduce((m, it) => (num(it.z) < 0 ? Math.max(m, it.z - BOARD_Z0) : m), num(host.boardSeq));
  let effects = []; // queued for the app (T.drain)
  let marks = 0;    // action markers so far: apply()'s "it really happened" signal
  let draws = 0;    // t.random() calls in this job (logged once: noteDraws)
  let lastRulesError = ''; // shown in the rules dialog
  const emit = (e) => { effects.push(e); };

  // --- what changed since the last broadcast tick: the dirty sets ------------
  // Not persisted; T.takeDirty() hands them over and starts afresh.
  const newDirty = () => ({
    items: new Set(),   // put/touch: an item created or changed
    removed: new Set(), // remove: an item deleted
    players: new Set(), // anything publicPlayers shows changed (name, colour, online, handCount, seat, seatId)
    hands: new Set(),   // that player's private hand changed
    rules: false,       // rules meta or public changed (found by comparison, in takeDirty)
    table: false,       // the table's shape, size or felt
    seats: false,       // the named seats (set or cleared)
    handy: false,       // whether anything on the table can be held in a hand (found by comparison)
    log: [],            // entries appended
  });
  let dirty = newDirty();
  const pub = new Map();   // T.pub: id → public item, refreshed lazily for the ids in `stale`
  const stale = new Set(Object.keys(host.items));
  const handy = new Set(); // the ids of items one could hold in a hand (T.handy), kept with T.pub
  let handySent;           // what the last takeDirty() saw of `handy.size > 0`
  /** T.byKind: 'c' (cards), 'p' (piles), 'g' (pieces), 's' (supplies), 'b' (bags) → their ids;
   *  T.byType: a type ref → the pieces and supplies of that type; T.byOwner: an owner → its items. */
  const byKind = new Map(['c', 'p', 'g', 's', 'b'].map((k) => [k, new Set()]));
  const byType = new Map(), byOwner = new Map();
  /** Adds item `id` to the indexes (on) or takes it out. */
  function index(id, it, on) {
    byKind.get(it.k)?.[on ? 'add' : 'delete'](id);
    for (const [map, key] of [[byType, (it.k === 'g' || it.k === 's') && it.t], [byOwner, it.owner]]) {
      if (!key) continue;
      const set = map.get(key) || (on ? map.set(key, new Set()).get(key) : null);
      set?.[on ? 'add' : 'delete'](id);
      if (set && !set.size) map.delete(key);
    }
  }
  for (const [id, it] of Object.entries(host.items)) index(id, it, true);
  const itemCount = () => { let n = 0; for (const s of byKind.values()) n += s.size; return n; };

  // --- what an item is: its type, flags, size and label (see the helpers above) ---
  const typeOf = (t) => typeAt(host.boxes, t);
  const flags = (it) => flagsOf(it, host.boxes);
  const size = (it) => sizeOf(it, host.boxes);
  const label = (it) => itemLabel(it, host.decks, host.boxes);
  /** What the log calls ONE piece {t, f, up} (no " ×N"). */
  const oneLabel = (m) => (m.up === false ? 'a hidden piece' : pieceName(host.boxes, m.t, m.f));
  /** A pile's members are cards or pieces: what to count them in. */
  const unit = (pile) => (pile.cards.length && !isCard(pile.cards[0]) ? 'pieces' : 'cards');
  /** Could one hold item `it` in a hand (T.handy)? Cards, piles of cards, bags
   *  made for hands, pieces whose type (or back, when hidden) says so. */
  const holdable = (it) => (it.k === 'c' ? true : it.k === 'b' ? !!it.hand : it.k === 'p' ? !it.cards.length || isCard(it.cards.at(-1)) || flags(it.cards.at(-1)).hand : flags(it).hand);
  /** A hand entry for pile member, piece or supply `m`: {d, i}, or {t, f, up?: false}. */
  const entryOf = (m) => (isCard(m) ? { d: m.d, i: m.i } : { t: m.t, f: m.f, ...(m.up === false && { up: false }) });
  /** Whether two pile members (or items, or hand entries) may share a pile:
   *  two cards, or two pieces that stack as a pile ('pile'), of one size. */
  function fits(a, b) {
    if (!a || !b) return false;
    if (isCard(a) || isCard(b)) return isCard(a) && isCard(b);
    const fa = flags(a), fb = flags(b);
    return fa.stack === 'pile' && fb.stack === 'pile' && fa.w === fb.w && fa.h === fb.h && !fa.placeholder;
  }
  /** Whether pile member, item or hand entry `m` may go onto pile `pile`:
   *  as its top would allow (fits), or onto an empty pile a card, or a piece
   *  that stacks as a pile. */
  const goesOn = (m, pile) => (pile.cards.length ? fits(m, pile.cards.at(-1)) : isCard(m) || flags(m).stack === 'pile');
  /** Whether piece `a` (adding `add` pieces) and piece `b` make one ×N stack:
   *  the same type, face, side and owner, of a type that stacks by count, ≤ MAX_N. */
  const stackable = (a, b, add) => a !== b && a.k === 'g' && b.k === 'g' && a.t === b.t && a.f === b.f && (a.up === false) === (b.up === false)
    && a.owner === b.owner && flags(b).stack === 'count' && (b.n || 1) + add <= MAX_N;

  // --- item writes ---------------------------------------------------------
  // Every change to host.items goes through put / remove / touch, and every
  // change to a player through touchPlayer: what delta sync sends is exactly
  // what was recorded here.
  /** Places item `it` under `id` (new, or replacing one); returns the id. */
  const put = (id, it) => {
    const old = own(host.items, id);
    if (old) index(id, old, false);
    host.items[id] = it;
    index(id, it, true);
    if (it.z > host.zMax) host.zMax = it.z;
    dirty.items.add(id);
    dirty.removed.delete(id);
    stale.add(id);
    return id;
  };
  /** Takes item `id` off the table. */
  const remove = (id) => {
    const it = own(host.items, id);
    if (!it) return;
    index(id, it, false);
    delete host.items[id];
    dirty.items.delete(id);
    dirty.removed.add(id);
    stale.add(id);
  };
  /** Item `id` is about to change in place (moved, turned, flipped, its pile
   *  changed) — or is re-sent unchanged (a refusal). Ids not on the table are
   *  ignored; true when it is on the table. */
  const touch = (id) => {
    if (!own(host.items, id)) return false;
    dirty.items.add(id);
    stale.add(id);
    return true;
  };
  /** Player p changed (anything publicPlayers shows); `hand`: their hand too. */
  const touchPlayer = (p, o = {}) => {
    dirty.players.add(p);
    if (o.hand) dirty.hands.add(p);
  };
  /** A new id for `map` (host.items, or the catalog: decks and boxes share
   *  its key space): host-minted, never one in use. */
  const mint = (map) => {
    const maps = map === host.items ? [map] : [host.decks, host.boxes];
    let id = newId();
    while (maps.some((m) => own(m, id))) id = newId();
    return id;
  };
  /** The next z on top of everything: a running max, never a scan of the table. */
  const zTop = () => ++host.zMax;
  /** Puts item `it` at top-left (x, y), clamped onto the table for its size
   *  (clampToTable), with a z: on top of everything (zTop), or for a new board
   *  the next one in the boards' band (BOARD_Z0 + boardSeq); a board keeps
   *  its z when moved. Every op that places an item comes through here. */
  function place(it, x, y) {
    const { w, h } = size(it);
    ({ x: it.x, y: it.y } = clampToTable(host.table, x, y, w, h));
    if (!(it.z < 0)) it.z = it.k === 'g' && typeOf(it.t)?.kind === 'board' ? BOARD_Z0 + ++host.boardSeq : zTop();
  }
  /** Brings the cached public items (T.pub) and `handy` up to date. */
  function refresh() {
    for (const id of stale) {
      const it = own(host.items, id);
      if (it) pub.set(id, pubItem(it, host.boxes));
      else pub.delete(id);
      if (it && holdable(it)) handy.add(id);
      else handy.delete(id);
    }
    stale.clear();
  }

  // --- seats ------------------------------------------------------------------
  /** The named seat `id` (state.seats), or null. */
  const seatDef = (id) => (host.seats || []).find((s) => s.id === id) || null;
  /** Who sits in named seat `id` (online or not: an offline player's seat is held), or null. */
  const holder = (id) => Object.keys(host.players).find((p) => host.players[p].seatId === id) || null;
  /** The angle of named seat `id` on the table as it is. */
  const namedAngle = (id) => seatAngles(host.table, host.seats).get(id);
  /** Picks a seat angle for a new player (automatic seating): bottom first,
   *  then always the middle of the largest empty arc — 2 players sit
   *  opposite, a 3rd between them, etc. A round table measures arcs in
   *  degrees, a rectangle along its perimeter (from the middle of the bottom
   *  edge). Angles are table-space degrees; 90° = the table's "south" rim. */
  function assignSeat() {
    const rect = host.table.shape === 'rect', per = rect && perimeter(host.table);
    const P = rect ? per.P : 360, pos = (a) => (rect ? per.of(a) : a), back = (s) => (rect ? per.at(s) : s % 360);
    const seats = Object.values(host.players).map((pl) => pl.seat).filter((s) => s != null).map(pos).sort((a, b) => a - b);
    if (!seats.length) return 90;
    if (seats.length === 1) return back(seats[0] + P / 2);
    let best = 0, bestGap = -1;
    for (let i = 0; i < seats.length; i++) {
      const a = seats[i], b = i + 1 < seats.length ? seats[i + 1] : seats[0] + P;
      if (b - a > bestGap) { bestGap = b - a; best = a + (b - a) / 2; }
    }
    return back(best);
  }
  /** Seats player p, who is joining (new, or back online): in their named
   *  seat if it still exists, else the first free one (in the seats' order),
   *  else they watch; with automatic seating a new player gets assignSeat(),
   *  and a returning one keeps their seat (or keeps watching). */
  function seatOnJoin(p, pl) {
    if (!host.seats) {
      if (pl.seat === undefined) pl.seat = assignSeat();
      return;
    }
    if (pl.seatId && seatDef(pl.seatId)) { pl.seat = namedAngle(pl.seatId); return; }
    delete pl.seatId;
    const free = host.seats.find((s) => !holder(s.id));
    if (free) { pl.seatId = free.id; pl.seat = namedAngle(free.id); } else pl.seat = null;
  }
  /** Sets the named seats (`seats`: SeatDef[], or null for automatic
   *  seating), logged as `actor`. Seating: the online players, then the
   *  offline ones, each clockwise from the bottom, take the seats in order;
   *  the rest watch. Clearing: every watcher gets a seat; the others keep
   *  their angles. */
  function setSeats(actor, seats) {
    const was = host.seats;
    if (!seats && !was) return;
    host.seats = seats;
    dirty.seats = true;
    const players = Object.entries(host.players);
    if (!seats) {
      for (const [q, pl] of players) {
        delete pl.seatId;
        if (pl.seat == null) pl.seat = assignSeat();
        touchPlayer(q);
      }
      logEvent(actor, 'removed the named seats: everyone sits where they like');
      return;
    }
    const angles = seatAngles(host.table, seats), order = players.sort(([, a], [, b]) => b.online - a.online || clockwise(a) - clockwise(b));
    order.forEach(([q, pl], k) => {
      const s = seats[k];
      if (s) { pl.seatId = s.id; pl.seat = angles.get(s.id); } else { delete pl.seatId; pl.seat = null; }
      touchPlayer(q);
    });
    const name = (k) => order[k]?.[1].name || (order[k] ? 'a player' : 'empty');
    const watching = order.slice(seats.length).map(([, pl]) => pl.name || 'a player');
    logEvent(actor, `Seats: ${seats.map((s, k) => `${s.name} — ${name(k)}`).join(', ')}${watching.length ? ` · watching: ${watching.join(', ')}` : ''}`);
  }
  /** The table becomes `tb` (cleanTable's): items shift to keep their place
   *  relative to the centre, then are clamped onto it; seat angles stay, and
   *  named seats are placed anew. False when nothing changed. */
  function setTable(actor, tb) {
    const old = host.table;
    if (canon(old) === canon(tb)) return false;
    const dx = (tb.w - old.w) / 2, dy = (tb.h - old.h) / 2;
    host.table = tb;
    dirty.table = true;
    for (const [id, it] of Object.entries(host.items)) {
      const { w, h } = size(it);
      ({ x: it.x, y: it.y } = clampToTable(tb, it.x + dx, it.y + dy, w, h));
      touch(id);
    }
    if (host.seats) {
      for (const [q, pl] of Object.entries(host.players)) if (pl.seatId) { pl.seat = namedAngle(pl.seatId); touchPlayer(q); }
    }
    logEvent(actor, tb.shape === 'round' ? `set the table to round (${TABLE_SIZES[tb.w]})` : `set the table to a ${tb.w} × ${tb.h} rectangle`);
    return true;
  }

  /** Seats player p (new, or back online), filling an empty name. True when
   *  that changed anything: the app registers the sender of every action
   *  here, and an unchanged player must not travel with each of them. */
  function ensurePlayer(p, name) {
    const known = own(host.players, p), pl = known || (host.players[p] = { name: '', color: freeColor(), online: true, hand: [] });
    const was = known && `${pl.seat}|${pl.seatId}|${pl.online}|${pl.name}`;
    if (!known?.online) seatOnJoin(p, pl);
    pl.online = true;
    // Only fill an empty name here — explicit renames go through the 'name'
    // action so they land in the log.
    if (name && !pl.name) pl.name = cleanName(name);
    if (was === `${pl.seat}|${pl.seatId}|${pl.online}|${pl.name}`) return false;
    touchPlayer(p);
    return true;
  }
  /** A color no ONLINE player wears (offline seats don't hold one hostage); cycles once all are taken. */
  function freeColor() {
    const used = new Set(Object.values(host.players).filter((x) => x.online).map((x) => x.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[Object.keys(host.players).length % COLORS.length];
  }

  // --- activity log (host-authored, broadcast to everyone) -------------------
  /** Tags an applied action with actor + item for the transient name bulbs every
   *  other player sees (`extra`: {roll: 1} for a die's tumble). Call BEFORE
   *  deleting an item so the position survives. */
  function mark(p, id, extra) {
    const it = host.items[id];
    marks++;
    emit({ t: 'fx', f: { p, id, x: it?.x ?? 0, y: it?.y ?? 0, ...extra } });
  }
  /** An action that happened with no item to mark (a seat change): counts for onAction. */
  const took = () => { marks++; };

  /** Appends to the shared log. Consecutive duplicates (drag/rotate spam) collapse.
   *  Entries render the actor's CURRENT name, unless `as` freezes one (renames).
   *  `chat` marks a chat line (talk), `loud` an on-the-record one (a peek); the
   *  buckets are capped separately (LOG_CAPS, trimLog). */
  function logEvent(p, txt, chat, as, loud) {
    const last = host.log.at(-1);
    if (!chat && last && last.p === p && last.txt === txt) return;
    const e = { p, txt, ts: now(), ...(chat ? { c: 1 } : {}), ...(as ? { n: as } : {}), ...(loud ? { k: 1 } : {}) };
    host.log.push(e);
    host.log = trimLog(host.log);
    dirty.log.push(e);
  }
  function dropIfEmpty(pileId) {
    if (host.items[pileId]?.cards.length === 0) remove(pileId);
  }
  /** Whether hand entry c is what payload a names: a card by {d, i}, a piece
   *  by {type, f} (its type ref travels as `type`: an action's `t` is its name). */
  const sameEntry = (c, a) => ('t' in c ? c.t === a.type && c.f === a.f : c.d === a.d && c.i === a.i);
  // Resolve a hand index robustly: guests send both the index and the card
  // (or piece) they see there; if the hand changed in flight, fall back to
  // the first match. An empty slot never matches, so an index past the hand
  // finds nothing: -1.
  function handIdx(pl, a) {
    const c = Number.isInteger(a.idx) && pl.hand[a.idx];
    if (c && sameEntry(c, a)) return a.idx;
    return pl.hand.findIndex((x) => sameEntry(x, a));
  }

  /** State changed: renumber it. Returns true (the caller's "changed"). */
  function bump() {
    host.seq++;
    return true;
  }

  // --- the shared checks (spec §2c): a failing one refuses the action -------
  // A player's refused action gets a notice; act() then re-sends what it
  // named (the refusal touch) and runs no hook. Script ops (RULES) skip the
  // owner and lock checks (scripts own the rules); their other refusals return
  // false with a console.warn.
  /** Refuses actor p's action with notice `msg`; false. */
  function no(p, msg) {
    if (p === RULES) console.warn(`a rules op was refused: ${msg}`);
    else notify(p, msg);
    return false;
  }
  /** Who owner `o` is now: a pid, or whoever sits in the seat a 'seat:<id>' names (null: nobody). */
  const resolveOwner = (o) => (o.startsWith('seat:') ? holder(o.slice(5)) : o);
  /** How a refusal names owner `o`: a seat's name ("White"), else the player's. */
  const ownerName = (o) => (o.startsWith('seat:') ? seatDef(o.slice(5))?.name || o.slice(5) : own(host.players, o)?.name || 'another player');
  /** p may handle `it`: a script, or nobody owns it, or p does — the host is not exempt. */
  const mayHandle = (p, it) => p === RULES || !it.owner || resolveOwner(it.owner) === p || no(p, `🚫 That belongs to ${ownerName(it.owner)}`);
  const notLocked = (p, it) => p === RULES || !it.lock || no(p, '🔒 That is locked in place');
  /** mayHandle and notLocked: what moving, turning or taking an item whole needs. */
  const may = (p, it) => mayHandle(p, it) && notLocked(p, it);
  /** None of `its` is hidden from p — else one uniform refusal, the same for
   *  every hidden type, before any other check (no oracle on hidden types). */
  const shown = (p, ...its) => p === RULES || !its.some((it) => hiddenFrom(p, it)) || no(p, '🚫 That piece is hidden');
  /** Room for k more items (MAX_ITEMS); a save above it still loads. */
  const cap = (p, k = 1) => itemCount() + k <= MAX_ITEMS || no(p, `🚫 The table is full (${MAX_ITEMS.toLocaleString('en-US')} items)`);
  /** An op on an item that isn't there (it went in flight): false, and said. */
  const gone = (what, id) => { console.warn(`${what}: no such item`, id); return false; };
  /** Only the host: else refused, loudly (a guest's table, loadBox or clear). */
  function hostOnly(p, a) {
    if (p === pid) return true;
    console.warn(`refused a host-only ${a.t} from`, p);
    return no(p, '🚫 Only the host can do that');
  }
  /** Where a new item lands next to `it` when no spot is given (a deal, a take, a pull). */
  const nextTo = (it) => ({ x: it.x + size(it).w + 18, y: it.y });

  // --- core table ops ---------------------------------------------------------
  // Shared between apply() and the rules-script facade, so scripted automations
  // mutate state through exactly the same audited path as human actions.
  // `actor` is a player id or RULES; every op logs and marks as that actor.

  /** Deals the top card (or piece) of a pile — to a player's hand ({to}) or onto the table. */
  function opDealTop(actor, pileId, o = {}) {
    const pile = own(host.items, pileId), c = pile?.k === 'p' && pile.cards.at(-1);
    if (!c) { console.warn('opDealTop: no card to deal', pileId); return false; }
    if (!mayHandle(actor, pile)) return false;
    const piece = !isCard(c);
    let nid = null;
    if (o.to) {
      const pl = own(host.players, o.to);
      if (!pl) { console.warn('opDealTop: unknown player', o.to); return false; }
      if (piece && !flags(c).hand) return no(actor, "🚫 Those pieces can't be held in a hand");
      pile.cards.pop();
      pl.hand.push(entryOf(c));
      touchPlayer(o.to, { hand: true });
      logEvent(actor, `dealt a ${piece ? 'piece' : 'card'} from ${label(pile)} to ${pl.name || 'a player'}`);
    } else {
      if (!cap(actor)) return false;
      const at = nextTo(pile);
      pile.cards.pop();
      const up = !!o.up || (piece && !typeOf(c.t)?.back);
      const it = piece ? { k: 'g', t: c.t, f: c.f, rot: normRot(o.rot), ...(!up && { up: false }) } : { k: 'c', rot: normRot(o.rot), d: c.d, i: c.i, up };
      place(it, num(o.x, at.x), num(o.y, at.y));
      nid = put(mint(host.items), it);
      logEvent(actor, `dealt ${!up ? `a ${piece ? 'piece' : 'card'} face down` : piece ? oneLabel(it) : cardName(host.decks, c.d, c.i)} from ${label(pile)}`);
      mark(actor, nid);
    }
    touch(pileId);
    mark(actor, pileId);
    dropIfEmpty(pileId);
    // the dealt card's (or piece's) identity, so scripts can track what they dealt
    const who = piece ? { t: c.t, f: c.f } : { d: c.d, i: c.i };
    return o.to ? who : { id: nid, ...who };
  }

  function opShuffle(actor, pileId) {
    const pile = own(host.items, pileId);
    if (pile?.k !== 'p' || !mayHandle(actor, pile)) return false;
    for (let i = pile.cards.length - 1; i > 0; i--) {
      const j = rint(i + 1);
      [pile.cards[i], pile.cards[j]] = [pile.cards[j], pile.cards[i]];
    }
    touch(pileId);
    logEvent(actor, `shuffled ${label(pile)} (${pile.cards.length} ${unit(pile)})`);
    mark(actor, pileId);
    return true;
  }

  /** Flips item `id`: a card or a pile as ever (a pile of pieces needs every
   *  member to have a hidden side); a piece or supply (1) with a back turns
   *  face down or up, (2) with 2 faces turns to the other, (3) with more
   *  turns to the next — but a die is rolled, never turned (pieces only). */
  function opFlip(actor, id) {
    const it = own(host.items, id);
    if (!it) return gone('flip', id);
    if (it.k === 'b') { console.warn('flip: a bag has no sides', id); return false; }
    if (!may(actor, it)) return false;
    if (it.k === 'c') {
      touch(id);
      it.up = !it.up;
      logEvent(actor, `flipped ${cardName(host.decks, it.d, it.i)} face ${it.up ? 'up' : 'down'}`);
    } else if (it.k === 'p') {
      if (it.cards.some((m) => !isCard(m) && !typeOf(m.t)?.back)) return no(actor, '🚫 Some of those pieces have no hidden side');
      touch(id);
      it.cards.reverse();
      for (const c of it.cards) c.up = !c.up;
      logEvent(actor, `flipped ${label(it)}`);
    } else {
      const ty = typeOf(it.t), before = label(it), n = ty?.faces.length;
      if (!ty) return no(actor, "🚫 That piece's game box is missing");
      if (!ty.back && ty.kind === 'die' && it.k === 'g') return no(actor, '🚫 Dice are rolled, not turned');
      if (!ty.back && n < 2) return no(actor, '🚫 That has only one side');
      touch(id);
      if (ty.back && it.up === false) { delete it.up; logEvent(actor, `turned over ${label(it)}`); } // the face is public now…
      else if (ty.back) { it.up = false; logEvent(actor, `turned ${before} face down`); }            // …and was a moment ago
      else if (n === 2) { it.f = 1 - it.f; logEvent(actor, `flipped ${before}`); }
      else { it.f = (it.f + 1) % n; logEvent(actor, `turned ${before} to ${faceLabel(ty.faces[it.f], it.f)}`); }
    }
    mark(actor, id);
    return true;
  }

  /** Puts card (or pile-stacking piece) `id` on top of pile `pileId`. */
  function opToPile(actor, id, pileId) {
    const it = own(host.items, id), pile = own(host.items, pileId);
    if (!it || pile?.k !== 'p' || (it.k !== 'c' && it.k !== 'g')) return false;
    if (!goesOn(it, pile)) return no(actor, "🚫 Those don't stack together");
    if (!may(actor, it) || !mayHandle(actor, pile)) return false;
    logEvent(actor, `put ${label(it)} onto ${label(pile)}`);
    mark(actor, pileId);
    pile.cards.push(isCard(it) ? { d: it.d, i: it.i, up: it.up } : { t: it.t, f: it.f, up: it.up !== false });
    touch(pileId);
    remove(id);
    return true;
  }

  /** A new pile of `cards` ({d, i, up} cards, or {t, f, up} pieces that
   *  stack as a pile, of one size) — scripts only (t.newPile). */
  function opNewPile(actor, cards, o = {}) {
    if (!Array.isArray(cards) || cards.some((c) => !c || typeof c !== 'object')) throw new TypeError('t.newPile: give it a list of cards ({d, i, up}) or pieces ({t, f, up})');
    const members = cards.map((c) => {
      if (isCard(c)) return { d: c.d, i: c.i, up: !!c.up };
      const ty = typeOf(c.t);
      if (!ty) throw new TypeError(`t.newPile: unknown piece type ${JSON.stringify(c.t)}`);
      if (!Number.isInteger(c.f ?? 0) || (c.f ?? 0) < 0 || (c.f ?? 0) >= ty.faces.length) throw new TypeError(`t.newPile: ${c.t} has no face ${c.f}`);
      return { t: c.t, f: c.f ?? 0, up: !!c.up || !ty.back };
    });
    if (members.some((m) => !fits(m, members[0]))) throw new TypeError("t.newPile: those don't stack together (cards with pieces, or pieces of other sizes, or that don't stack as a pile)");
    if (!cap(actor)) return false;
    const it = { k: 'p', rot: 0, name: String(o.name || '').slice(0, 24), cards: members }, { w, h } = size(it);
    place(it, num(o.x, host.table.w / 2 - w / 2), num(o.y, host.table.h / 2 - h / 2));
    const nid = put(mint(host.items), it);
    logEvent(actor, `made a pile of ${members.length} ${unit(it)}`);
    mark(actor, nid);
    return nid;
  }

  /** Stacks card (or pile-stacking piece) `id` onto `ontoId`: both become a new pile where `ontoId` lay. Returns its id. */
  function opStack(actor, id, ontoId) {
    const it = own(host.items, id), b = own(host.items, ontoId);
    if (!it || !b || it === b) return false;
    if (!['c', 'g'].includes(it.k) || !['c', 'g'].includes(b.k) || !fits(it, b)) return no(actor, "🚫 Those don't stack together");
    if (!may(actor, it) || !mayHandle(actor, b)) return false;
    logEvent(actor, `stacked ${label(it)} onto ${label(b)}`);
    const m = (x) => (isCard(x) ? { d: x.d, i: x.i, up: x.up } : { t: x.t, f: x.f, up: x.up !== false });
    const nid = put(mint(host.items), { k: 'p', x: b.x, y: b.y, rot: b.rot, z: zTop(), name: '', cards: [m(b), m(it)] });
    remove(id);
    remove(ontoId);
    mark(actor, nid);
    return nid;
  }

  /** Puts pile `id` on top of pile `pileId`. */
  function opMerge(actor, id, pileId) {
    const it = own(host.items, id), to = own(host.items, pileId);
    if (it?.k !== 'p' || to?.k !== 'p' || it === to) return false;
    if (it.cards.length && !goesOn(it.cards.at(-1), to)) return no(actor, "🚫 Those don't stack together");
    if (!may(actor, it) || !mayHandle(actor, to)) return false;
    logEvent(actor, `merged ${label(it)} (${it.cards.length} ${unit(it)}) into ${label(to)}`);
    mark(actor, pileId);
    to.cards.push(...it.cards);
    touch(pileId);
    remove(id);
    return true;
  }

  function opMove(actor, id, x, y) {
    const it = own(host.items, id);
    if (!it) return gone('move', id);
    if (!may(actor, it)) return false;
    touch(id);
    place(it, num(x, it.x), num(y, it.y));
    logEvent(actor, `moved ${label(it)}`);
    mark(actor, id);
    return true;
  }

  /** Turns item `id` to `rot` degrees — a piece, supply or pile of pieces
   *  in steps of its rotStep (its back's when hidden). */
  function opRot(actor, id, rot) {
    const it = own(host.items, id);
    if (!it) return gone('rot', id);
    if (!may(actor, it)) return false;
    const m = it.k === 'p' ? it.cards.at(-1) : it, step = (it.k === 'g' || it.k === 's' || (it.k === 'p' && m && !isCard(m))) ? flags(m).rotStep : 0;
    touch(id);
    it.rot = normRot(step ? Math.round(normRot(rot) / step) * step : rot);
    logEvent(actor, `rotated ${label(it)}`);
    mark(actor, id);
    return true;
  }

  function opRemove(actor, id) {
    const it = own(host.items, id);
    if (!it) return gone('remove', id);
    if (!may(actor, it)) return false;
    const extra = it.k === 'p' ? ` (${it.cards.length} ${unit(it)})` : it.k === 'b' ? ` (${it.of.length} pieces)` : '';
    logEvent(actor, `removed ${label(it)}${extra}`);
    mark(actor, id);
    remove(id);
    return true;
  }

  /** Card or piece `id` into player q's hand (one from a ×N stack): the
   *  player's own act (actor q), or a script's gift (actor RULES). */
  function opToHand(actor, id, q) {
    const it = own(host.items, id), pl = own(host.players, q);
    if (!it || !pl || (it.k !== 'c' && it.k !== 'g')) return false;
    if (!may(actor, it)) return false;
    if (it.k === 'g' && !flags(it).hand) return no(actor, "🚫 That can't be held in a hand");
    const what = it.k === 'c' ? label(it) : oneLabel(it);
    logEvent(actor, actor === RULES ? `gave ${what} to ${pl.name || 'a player'}` : it.up === false ? 'took a hidden piece into hand' : `took ${what} from the table into hand`);
    mark(actor, id);
    pl.hand.push(entryOf(it));
    touchPlayer(q, { hand: true });
    if (it.n > 1) { touch(id); if (--it.n < 2) delete it.n; } else remove(id);
    return true;
  }

  /** Plays player q's hand entry `idx` onto the table at o.x, o.y (face up
   *  iff `up`; a piece face down only if its type has a back). */
  function opPlay(actor, q, idx, o, up) {
    const pl = own(host.players, q), c = pl.hand[idx];
    if (!cap(actor)) return false;
    pl.hand.splice(idx, 1);
    touchPlayer(q, { hand: true });
    const piece = !isCard(c);
    if (piece && !typeOf(c.t)?.back) up = true;
    const it = piece ? { k: 'g', t: c.t, f: c.f, rot: 0, ...(!up && { up: false }) } : { k: 'c', rot: 0, d: c.d, i: c.i, up };
    const { w, h } = size(it), step = piece ? flags(it).rotStep : 0;
    it.rot = normRot(step ? Math.round(normRot(o.rot) / step) * step : o.rot);
    place(it, num(o.x, host.table.w / 2 - w / 2), num(o.y, host.table.h / 2 - h / 2));
    const nid = put(mint(host.items), it);
    const what = !up ? `a ${piece ? 'piece' : 'card'} face down` : piece ? oneLabel(it) : cardName(host.decks, c.d, c.i);
    logEvent(actor, `played ${what} from ${actor === RULES ? `${pl.name || 'a player'}'s hand` : 'hand'}`);
    mark(actor, nid);
    return nid;
  }

  /** Rolls dice `ids` (1 to MAX_ROLL, all different): each gets a random
   *  face (the crypto RNG — never one from the payload). One action marker
   *  goes out for the roll, at its first die: {p, id, x, y, roll: [every
   *  die's id]} (every screen tumbles those; one marker, not one per die,
   *  keeps a 20-dice patch within B9's 3 KB). Returns their new faces in id
   *  order, or false. */
  function opRoll(actor, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ROLL || new Set(ids).size !== ids.length) return no(actor, `🚫 Roll 1 to ${MAX_ROLL} different dice`);
    const dice = [];
    for (const id of ids) {
      const it = own(host.items, id);
      if (!it) return gone('roll', id);
      if (!shown(actor, it)) return false;
      const ty = it.k === 'g' && typeOf(it.t);
      if (ty?.kind !== 'die') return no(actor, '🚫 Only dice can be rolled');
      if (!mayHandle(actor, it)) return false;
      dice.push([id, it, ty]);
    }
    dice.sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [id, it, ty] of dice) {
      touch(id);
      it.f = rint(ty.faces.length);
    }
    mark(actor, dice[0][0], { roll: dice.map(([id]) => id) });
    logEvent(actor, `rolled ${dice.map(([, it, ty]) => (it.up === false ? 'a hidden die' : faceLabel(ty.faces[it.f], it.f))).join(' · ')}`);
    return dice.map(([, it]) => it.f);
  }

  /** Turns piece or supply `id` to face `f` (never a die: dice are rolled). */
  function opFace(actor, id, f) {
    const it = own(host.items, id);
    if (!it) return gone('face', id);
    if (!shown(actor, it)) return false;
    if (it.k !== 'g' && it.k !== 's') return no(actor, '🚫 Only pieces turn to a face');
    const ty = typeOf(it.t);
    if (!ty) return no(actor, "🚫 That piece's game box is missing");
    if (ty.kind === 'die' && it.k === 'g') return no(actor, '🚫 Dice are rolled, not turned');
    if (!Number.isInteger(f) || f < 0 || f >= ty.faces.length) return no(actor, `🚫 That piece has faces 0 to ${ty.faces.length - 1}`);
    if (!may(actor, it)) return false;
    const before = label(it);
    touch(id);
    it.f = f;
    logEvent(actor, `turned ${before} to ${faceLabel(ty.faces[f], f)}`);
    mark(actor, id);
    return true;
  }

  /** Takes k (default 1) pieces off ×N stack `id`: a new stack at (x, y), or
   *  onto stack `onto` — atomically: refused whole when that join would be. */
  function opSplit(actor, id, n, x, y, onto) {
    const it = own(host.items, id);
    if (!it) return gone('split', id);
    if (it.k !== 'g' || !(it.n >= 2)) return no(actor, '🚫 Only a stack (×2 or more) can be split');
    const k = n ?? 1;
    if (!Number.isInteger(k) || k < 1 || k >= it.n) return no(actor, `🚫 Take 1 to ${it.n - 1} from that stack`);
    if (!may(actor, it)) return false;
    const to = onto !== undefined ? own(host.items, onto) : null, before = label(it);
    if (onto !== undefined) {
      if (!to) return gone('split', onto);
      if (!shown(actor, it, to)) return false;
      if (!stackable(it, to, k)) return no(actor, "🚫 Those don't stack together");
      if (!mayHandle(actor, to)) return false;
    } else if (!cap(actor)) return false;
    touch(id);
    it.n -= k;
    if (it.n < 2) delete it.n;
    if (to) {
      const into = label(to);
      touch(onto);
      to.n = (to.n || 1) + k;
      logEvent(actor, `moved ${k} from ${before} onto ${into}`);
      mark(actor, onto);
      return true;
    }
    const nu = { k: 'g', t: it.t, f: it.f, rot: it.rot, ...(it.up === false && { up: false }), ...(k > 1 && { n: k }), ...(it.owner && { owner: it.owner }) };
    const at = nextTo(it);
    place(nu, num(x, at.x), num(y, at.y));
    const nid = put(mint(host.items), nu);
    logEvent(actor, `took ${k} from ${before}`);
    mark(actor, nid);
    return nid;
  }

  /** Piece `id` joins `onto`: (a) a ×N stack of the same type, face, side and
   *  owner, or (b) a supply of its type (it goes back). */
  function opJoin(actor, id, onto) {
    const it = own(host.items, id), to = own(host.items, onto);
    if (!it || !to) return gone('join', it ? onto : id);
    if (!shown(actor, it, to)) return false;
    const back = it.k === 'g' && to.k === 's' && to.t === it.t;
    if (!back && !stackable(it, to, it.n || 1)) return no(actor, "🚫 Those don't stack together");
    if (!may(actor, it) || !mayHandle(actor, to)) return false;
    touch(onto);
    if (back) logEvent(actor, `returned ${label(it)} to ${label(to)}`);
    else {
      to.n = (to.n || 1) + (it.n || 1);
      logEvent(actor, `stacked ${oneLabel(it)} (×${to.n})`);
    }
    mark(actor, onto);
    remove(id);
    return true;
  }

  /** A new piece from supply `id` — onto the table at (x, y), or into the
   *  actor's hand (`hand`) — owned by the supply's owner, if it has one. */
  function opTake(actor, id, x, y, hand) {
    const s = own(host.items, id), pl = own(host.players, actor);
    if (!s) return gone('take', id);
    if (s.k !== 's') return no(actor, '🚫 That is not a supply');
    if (!mayHandle(actor, s)) return false;
    const nu = { k: 'g', t: s.t, f: s.f, rot: 0, ...(s.up === false && { up: false }), ...(s.owner && { owner: s.owner }) };
    if (hand) {
      if (!pl) return false;
      if (!flags(s).hand) return no(actor, "🚫 That can't be held in a hand");
      pl.hand.push(entryOf(nu));
      touchPlayer(actor, { hand: true });
      logEvent(actor, `took ${oneLabel(nu)} into hand`);
      mark(actor, id);
      return true;
    }
    if (!cap(actor)) return false;
    const at = nextTo(s);
    place(nu, num(x, at.x), num(y, at.y));
    const nid = put(mint(host.items), nu);
    logEvent(actor, `took ${oneLabel(nu)} from ${label(s)}`);
    mark(actor, nid);
    return nid;
  }

  /** A random piece out of bag `id` (randInt) — onto the table at (x, y), as
   *  it was put in (face up or down), or into the actor's hand (`hand`, for
   *  a bag made for hands). */
  function opPull(actor, id, x, y, hand) {
    const bag = own(host.items, id), pl = own(host.players, actor);
    if (!bag) return gone('pull', id);
    if (bag.k !== 'b') return no(actor, '🚫 That is not a bag');
    if (!bag.of.length) return no(actor, '🚫 That bag is empty');
    if (!mayHandle(actor, bag)) return false;
    if (hand && (!pl || !bag.hand)) return no(actor, "🚫 That bag's pieces can't be held in a hand");
    if (!hand && !cap(actor)) return false;
    const at = nextTo(bag), m = bag.of.splice(rint(bag.of.length), 1)[0];
    touch(id);
    if (hand) {
      pl.hand.push(entryOf(m));
      touchPlayer(actor, { hand: true });
      logEvent(actor, `drew a piece from ${label(bag)}`);
      mark(actor, id);
      return true;
    }
    const nu = { k: 'g', t: m.t, f: m.f, rot: 0, ...(m.up === false && { up: false }) };
    place(nu, num(x, at.x), num(y, at.y));
    const nid = put(mint(host.items), nu);
    logEvent(actor, `drew ${m.up === false ? 'a piece' : oneLabel(nu)} from ${label(bag)}`);
    mark(actor, nid);
    return nid;
  }

  /** Piece `id` (every one of a ×N stack) into bag `bagId`. */
  function opToBag(actor, id, bagId) {
    const it = own(host.items, id), bag = own(host.items, bagId);
    if (!it || !bag) return gone('toBag', it ? bagId : id);
    if (it.k !== 'g' || bag.k !== 'b') return no(actor, '🚫 Only pieces go into a bag');
    if (!may(actor, it) || !mayHandle(actor, bag)) return false;
    const n = it.n || 1;
    if (bag.of.length + n > MAX_BAG) return no(actor, `🚫 That bag is full (${MAX_BAG.toLocaleString('en-US')} pieces)`);
    if (bag.hand && !flags(it).hand) return no(actor, '🚫 That bag only holds pieces that can be held in a hand');
    logEvent(actor, `put ${label(it)} into ${label(bag)}`);
    touch(bagId);
    for (let k = 0; k < n; k++) bag.of.push({ t: it.t, f: it.f, ...(it.up === false && { up: false }) });
    mark(actor, bagId);
    remove(id);
    return true;
  }

  /** The box whose `lockable` decides who may lock `it`: a piece's or
   *  supply's, a bag's when all it holds comes from one box; cards and piles: none. */
  function boxOfItem(it) {
    const box = (t) => own(host.boxes, String(t).split('/')[0]);
    if (it.k === 'g' || it.k === 's') return box(it.t);
    const ids = it.k === 'b' && new Set(it.of.map((m) => m.t.split('/')[0]));
    return ids?.size === 1 ? box([...ids][0]) : null;
  }
  /** Locks item `id` in place (on) or frees it: the host; or anyone who may
   *  handle it when its box is `lockable: 'anyone'`. */
  function opLock(actor, id, on) {
    const it = own(host.items, id);
    if (!it) return gone('lock', id);
    if (actor !== pid && actor !== RULES) {
      if (boxOfItem(it)?.lockable !== 'anyone') return no(actor, '🚫 Only the host can lock or unlock that');
      if (!mayHandle(actor, it)) return false;
    }
    if (!!it.lock === on) return false;
    touch(id);
    if (on) it.lock = true;
    else delete it.lock;
    logEvent(actor, `${on ? 'locked' : 'unlocked'} ${label(it)}`);
    mark(actor, id);
    return true;
  }

  /** Sets item `id`'s owner to `to` (a pid, 'seat:<id>', or null). Who may:
   *  the host (anything); its current owner (to a player, or nobody); anyone
   *  claiming for themselves an item nobody owns that isn't locked or a board. */
  function opOwner(actor, id, to) {
    const it = own(host.items, id);
    if (!it) return gone('owner', id);
    const seat = typeof to === 'string' && to.startsWith('seat:');
    if (to !== null && !(seat ? seatDef(to.slice(5)) : own(host.players, to))) return no(actor, '🚫 No such player or seat');
    const board = it.k === 'g' && it.up !== false && typeOf(it.t)?.kind === 'board';
    if (actor !== pid && actor !== RULES) {
      const mine = it.owner && resolveOwner(it.owner) === actor;
      if (mine ? seat : to !== actor) return no(actor, it.owner && !mine ? `🚫 That belongs to ${ownerName(it.owner)}` : '🚫 Only the host can give that away');
      if (!mine && (it.owner || board)) return no(actor, it.owner ? `🚫 That belongs to ${ownerName(it.owner)}` : "🚫 Boards can't be claimed");
      if (!mine && !notLocked(actor, it)) return false;
    }
    if ((it.owner ?? null) === to) return false;
    const what = label(it);
    touch(id);
    index(id, it, false);
    if (to) it.owner = to;
    else delete it.owner;
    index(id, it, true);
    logEvent(actor, to === null ? `released ${what}` : to === actor ? `claimed ${what}` : `gave ${what} to ${ownerName(to)}`);
    mark(actor, id);
    return true;
  }

  /** Seat changes (action `seat`): player q (the actor, or for the host
   *  anyone) sits in named seat `a.id`, stands up to watch (`a.watch`), or
   *  under automatic seating sits down again (`a.sit`). */
  function opSeat(actor, a) {
    const other = a.p !== undefined && a.p !== actor;
    if (other && actor !== pid) return no(actor, '🚫 Only the host can seat other players');
    const q = other ? a.p : actor, pl = own(host.players, q);
    if (!pl) return no(actor, '🚫 No such player');
    const modes = ['id', 'watch', 'sit'].filter((k) => a[k] !== undefined);
    if (modes.length !== 1 || (a.watch !== undefined && a.watch !== true) || (a.sit !== undefined && a.sit !== true)) return no(actor, '🚫 Say which seat (id), or watch, or sit');
    const who = pl.name || 'a player';
    if (a.id !== undefined) {
      const s = typeof a.id === 'string' && seatDef(a.id);
      if (!s) return no(actor, '🚫 No such seat');
      const h = holder(s.id);
      if (h === q) return false;
      if (h) return no(actor, '🚫 That seat is taken');
      pl.seatId = s.id;
      pl.seat = namedAngle(s.id);
      logEvent(actor, other ? `moved ${who} to ${s.name}` : `sat down as ${s.name}`);
    } else if (a.watch) {
      if (pl.seat == null) return false;
      pl.seat = null;
      delete pl.seatId;
      logEvent(actor, other ? `moved ${who} to the watchers` : 'stood up to watch');
    } else {
      if (host.seats) return no(actor, '🚫 Pick a free seat');
      if (pl.seat != null) return false;
      pl.seat = assignSeat();
      logEvent(actor, other ? `seated ${who}` : 'sat down');
    }
    touchPlayer(q);
    took();
    return true;
  }

  /** Removes every item and empties every hand (`clear`). */
  function clearTable(actor) {
    const n = itemCount();
    let m = 0;
    for (const id of Object.keys(host.items)) remove(id);
    for (const [q, pl] of Object.entries(host.players)) {
      if (!pl.hand.length) continue;
      m += pl.hand.length;
      pl.hand = [];
      touchPlayer(q, { hand: true });
    }
    logEvent(actor, `cleared the table (${n} items, ${m} cards from hands)`);
  }

  let boxKeys = null; // boxKey → the ids of the catalog's boxes with that key (made on first use)
  /** Box `box` (cleaned) into the catalog — or the id of the box with the same
   *  content already there (boxKey, confirmed by canon). A new one is minted
   *  an id, recorded with its source (`src`, `by`: host-written, never read
   *  from a box) and sent to everyone (the 'box' effect). */
  function registerBox(box, src, by) {
    if (!boxKeys) {
      boxKeys = new Map();
      for (const [id, b] of Object.entries(host.boxes)) { const k = boxKey(b); boxKeys.set(k, [...(boxKeys.get(k) || []), id]); }
    }
    const c = canon(box), key = boxKey(box), same = (boxKeys.get(key) || []).find((id) => canon(host.boxes[id]) === c);
    if (same) return same;
    const id = mint(host.boxes);
    host.boxes[id] = box;
    host.boxSrc[id] = { src, ...(by && by !== RULES && { by }) };
    boxKeys.set(key, [...(boxKeys.get(key) || []), id]);
    emit({ t: 'box', id });
    return id;
  }

  /** Lays out the setup of box `boxId` (cleaned; spec §2c, the Phase 2
   *  grammar): every item through place(), ids minted at random. Hidden
   *  pieces carry no declaration order: one entry's are given their z in a
   *  random order, and a `group` with `shuffle` permutes the places (x, y,
   *  z) of its hidden pieces that share a back. Returns how many it spawned
   *  (loadBox checked the total first). */
  function layout(boxId, box) {
    const tb = host.table, angles = host.seats && seatAngles(tb, host.seats);
    const seats = host.seats ? host.seats.map((s) => ({ a: angles.get(s.id), owner: `seat:${s.id}` }))
      : Object.entries(host.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => clockwise(a) - clockwise(b)).map(([q, pl]) => ({ a: pl.seat, owner: q }));
    const shuffle = (list) => { for (let i = list.length - 1; i > 0; i--) { const j = rint(i + 1); [list[i], list[j]] = [list[j], list[i]]; } return list; };
    const ref = (tid) => `${boxId}/${tid}`;
    let n = 0;
    const run = (list, seat) => list.flatMap((e) => spawn(e, seat));
    /** The top-left of the k-th item of entry `e`, w × h: 'center', [x, y], or
     *  in the seat's frame (dx to its right, dy toward the table); `spread`
     *  steps along the same axes. */
    function spot(e, w, h, seat, k) {
      const [sx, sy] = e.spread || [0, 0];
      if (e.at === 'center') return [tb.w / 2 - w / 2 + k * sx, tb.h / 2 - h / 2 + k * sy];
      if (Array.isArray(e.at)) return [e.at[0] + k * sx, e.at[1] + k * sy];
      const [dx, dy] = e.at === 'seat' ? [0, SEAT_INSET] : e.at.seat, S = seatPoint(tb, seat.a), rx = dx + k * sx, ry = dy + k * sy;
      return [S.x - S.uy * rx + S.ux * ry - w / 2, S.y + S.ux * rx + S.uy * ry - h / 2];
    }
    function spawn(e, seat) {
      if (e.forEachSeat) return seats.flatMap((s) => run(e.forEachSeat, s));
      if (e.group) {
        const ids = run(e.group, seat);
        if (e.shuffle) {
          const byBack = new Map();
          for (const id of ids) {
            const it = host.items[id];
            if (it.up === false) byBack.set(backRef(host.boxes, it.t), [...(byBack.get(backRef(host.boxes, it.t)) || []), it]);
          }
          for (const list of byBack.values()) {
            const spots = shuffle(list.map((it) => [it.x, it.y, it.z]));
            list.forEach((it, k) => { [it.x, it.y, it.z] = spots[k]; });
          }
        }
        return ids;
      }
      const owner = e.owner === 'seat' ? seat.owner : e.owner;
      let made;
      if (e.bag) {
        const of = e.bag.flatMap((m) => {
          const x = typeof m === 'string' ? { t: m } : m;
          return Array.from({ length: x.n ?? 1 }, () => ({ t: ref(x.t), f: x.f ?? 0, ...(x.up === false && { up: false }) }));
        });
        const hand = e.hand ?? (of.length > 0 && of.every((m) => typeOf(m.t).hand));
        made = [{ k: 'b', of, name: e.name || '', ...(hand && { hand: true }), rot: 0 }];
      } else {
        const tid = e.piece ?? e.supply, lock = e.lock ?? box.types[tid].kind === 'board';
        made = Array.from({ length: e.count ?? 1 }, () => ({
          k: e.piece ? 'g' : 's', t: ref(tid), f: e.f ?? 0, rot: e.rot ?? 0, ...(e.up === false && { up: false }), ...(e.n && { n: e.n }), ...(lock && { lock: true }),
        }));
      }
      made.forEach((it, k) => {
        if (owner) it.owner = owner;
        if (e.bag && e.lock) it.lock = true;
        const { w, h } = size(it), [x, y] = spot(e, w, h, seat, k);
        place(it, x, y);
      });
      // One entry's hidden pieces: their z values in a random order, and
      // their ids minted in a random order too (an env may mint ids in sequence).
      const hid = made.filter((it) => it.up === false), zs = shuffle(hid.map((it) => it.z));
      hid.forEach((it, k) => { it.z = zs[k]; });
      n += made.length;
      return (hid.length ? shuffle([...made]) : made).map((it) => put(mint(host.items), it));
    }
    run(box.setup, null);
    return n;
  }

  /** The host's loadBox: box `raw` (cleanBox, failing loudly) into the
   *  catalog (deduplicated), then with `o.clear` the table cleared, the box's
   *  table and named seats set, and with `o.setup` its setup laid out (the
   *  item total checked first: at most MAX_SETUP_ITEMS, and room on the
   *  table). Returns the box's id, or false. */
  function loadBox(actor, raw, o) {
    let box;
    try { box = cleanBox(raw); } catch (err) {
      console.error('loadBox: the box was refused', err);
      return no(actor, `🚫 Box rejected: ${err.message}`);
    }
    if (o.setup && box.setup) {
      const seated = Object.values(host.players).filter((pl) => pl.seat != null).length;
      const n = countSetup(box.setup, box.seats ? box.seats.length : host.seats ? Object.keys(host.players).length : seated);
      if (n > MAX_SETUP_ITEMS) {
        console.error(`loadBox: the setup of «${box.name}» places ${n} items (max ${MAX_SETUP_ITEMS})`);
        return no(actor, `🚫 Box rejected: setup places too many items (${n.toLocaleString('en-US')}, max ${MAX_SETUP_ITEMS.toLocaleString('en-US')})`);
      }
      if ((o.clear ? 0 : itemCount()) + n > MAX_ITEMS) return no(actor, `🚫 The table is full (${MAX_ITEMS.toLocaleString('en-US')} items)`);
    }
    const id = registerBox(box, 'host', actor);
    if (o.clear) clearTable(actor);
    if (box.table) setTable(actor, box.table);
    setSeats(actor, box.seats ?? null);
    if (o.setup && box.setup) {
      const n = layout(id, box);
      host.lastSetup = id;
      logEvent(actor, `set up «${box.name}» (${n} pieces)`);
    } else logEvent(actor, `added the box «${box.name}»`);
    took();
    return id;
  }

  /** Applies one action from player `p` to the authoritative state, as one
   *  job (act, then the t.data cap). True when the table changed (render,
   *  broadcast, save); false when nothing did: a hello, a snapshot or image
   *  request (registration is join()'s, the answer the app's), a chat over
   *  flood control, a refused rules button. */
  function apply(p, a) {
    const changed = act(p, a);
    return dataOver() && !changed ? bump() : changed;
  }
  /** The action itself (see apply). */
  function act(p, a) {
    if (a.t === 'hello' || a.t === 'snap' || a.t === 'need') return false;
    const items = host.items, pl = own(host.players, p);
    const it = own(items, a.id);
    // Rules veto: an enabled script may block gameplay actions with a reason.
    if (RULED_ACTIONS.has(a.t) && host.rules?.enabled) {
      const reason = runHook('validate', { ...a, p });
      dataOver(); // the cap, now: a validate() that outgrew t.data fails like one that threw
      // Fail closed: a validate() that throws has just disabled the rules, and
      // the action that crashed it must not slip through unvalidated.
      const why = host.rules.enabled ? typeof reason === 'string' && reason : 'rules script error';
      if (why) {
        touchNamed(p, a); // the next patch re-sends them: the actor's optimistic UI reverts
        logEvent(RULES, `blocked ${pl?.name || 'a player'}: ${why}`);
        notify(p, `🚫 ${why}`);
        return bump();
      }
    }
    if ((a.t === 'chat' || a.t === 'name') && !mayTalk(p)) {
      console.warn(`flood control: dropped a ${a.t} from`, p);
      notify(p, '🚫 Slow down — at most 5 messages or renames per 5 seconds');
      return false;
    }
    // Every op that takes effect mark()s it, so the mark count growing during
    // the switch is the "it really happened" signal for onAction below: a no-op
    // (a card not in hand, a vanished item) or a refusal never reaches the
    // script, and for the ones that did happen the payload's ids were matched host-side.
    const fx0 = marks;
    switch (a.t) {
      case 'name': {
        const name = cleanName(a.name);
        if (pl && name && name !== pl.name) {
          const old = pl.name;
          pl.name = name;
          touchPlayer(p);
          logEvent(p, `is now known as "${name}"`, false, old); // shown under the OLD name
        }
        break;
      }
      case 'addDeck': {
        let deck;
        try { deck = cleanDeck(a.deck); } catch (err) {
          console.error('rejected a deck', err);
          notify(p, `🚫 Deck rejected: ${err.message}`);
          break;
        }
        if (!cap(p)) break;
        // Decks are kept (and saved in the host's browser) forever: guests share
        // one budget for the table, so nobody can fill the host's storage.
        // (host.guestDeckChars is saved with the table: a reload can't reset it.)
        // A deck costs its transport size (`cost`: ingestion measured it, app.js),
        // never less than the deck as stored; the budget was checked before
        // ingestion too, but another guest's deck may have committed since.
        if (p !== pid) {
          const cost = Math.max(num(a.cost), JSON.stringify(deck).length), used = host.guestDeckChars || 0, over = deckOverBudget(used, cost);
          if (over) {
            console.warn('guest deck over budget', p, cost, used);
            notify(p, `🚫 Deck rejected: ${over}`);
            break;
          }
          host.guestDeckChars = used + cost;
        }
        const deckId = mint(host.decks); // host-minted: a peer must not choose (or overwrite) deck ids
        host.decks[deckId] = deck;
        emit({ t: 'deck', id: deckId });
        const pile = { k: 'p', rot: 0, name: deck.name, cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })) };
        place(pile, num(a.x, host.table.w / 2 - CARD_W / 2), num(a.y, host.table.h / 2 - CARD_H / 2));
        const nid = put(mint(items), pile);
        logEvent(p, `added deck "${deck.name}" (${deck.cards.length} cards)`);
        mark(p, nid);
        break;
      }
      case 'move': opMove(p, a.id, a.x, a.y); break;
      case 'rot': opRot(p, a.id, a.rot); break;
      case 'flip': opFlip(p, a.id); break;
      case 'shuffle': if (it?.k === 'p') opShuffle(p, a.id); break;
      case 'draw': {
        if (it?.k !== 'p' || !pl || !mayHandle(p, it)) break; // a player with no seat takes nothing
        if (!it.cards.every((m) => isCard(m) || flags(m).hand)) { no(p, "🚫 Those pieces can't be held in a hand"); break; }
        const c = it.cards.pop();
        if (!c) break;
        pl.hand.push(entryOf(c));
        touchPlayer(p, { hand: true });
        touch(a.id);
        logEvent(p, `drew a ${isCard(c) ? 'card' : 'piece'} from ${label(it)}`);
        mark(p, a.id);
        dropIfEmpty(a.id);
        break;
      }
      case 'deal': if (it?.k === 'p') opDealTop(p, a.id, { x: a.x, y: a.y, up: !!a.up, rot: a.rot }); break;
      case 'play': {
        const idx = pl ? handIdx(pl, a) : -1;
        if (idx >= 0) opPlay(p, p, idx, a, isCard(pl.hand[idx]) ? !!a.up : a.up !== false);
        break;
      }
      case 'handPile': {
        const idx = pl ? handIdx(pl, a) : -1, pile = own(items, a.pile);
        if (idx < 0 || pile?.k !== 'p' || !mayHandle(p, pile)) break;
        const c = pl.hand[idx], top = pile.cards.at(-1);
        if (!goesOn(c, pile)) { no(p, "🚫 Those don't stack together"); break; }
        if (!isCard(c) && ![c, ...pile.cards].every((m) => flags(m).hand)) { no(p, "🚫 Those pieces can't be held in a hand"); break; }
        pl.hand.splice(idx, 1);
        touchPlayer(p, { hand: true });
        // A card discarded onto a pile matches the pile's exposed face
        // (face up onto a face-up pile, face down onto a deck).
        const up = (top?.up ?? false) || (!isCard(c) && !typeOf(c.t)?.back);
        pile.cards.push(isCard(c) ? { d: c.d, i: c.i, up } : { t: c.t, f: c.f, up });
        touch(a.pile);
        logEvent(p, `put ${up ? (isCard(c) ? cardName(host.decks, c.d, c.i) : pieceName(host.boxes, c.t, c.f)) : `a ${isCard(c) ? 'card' : 'piece'} face down`} from hand onto ${label(pile)}`);
        mark(p, a.pile);
        break;
      }
      case 'toHand': if (pl) opToHand(p, a.id, p); break;
      case 'toPile': opToPile(p, a.id, a.pile); break;
      case 'stack': opStack(p, a.id, a.onto); break;
      case 'merge': opMerge(p, a.id, a.pile); break;
      case 'del': opRemove(p, a.id); break;
      // Peek is deliberately "loud": the reveal happens on the peeker's screen
      // only, but the fact of peeking goes on the record for everyone. Guests
      // never hold hidden identities (see publicItems), so the host answers
      // the peeker alone (the 'peek' effect: a card {d, i} or a piece {t, f}).
      case 'peek': {
        const c = it?.k === 'c' ? !it.up && it : it?.k === 'p' && it.cards.at(-1);
        if (!c || !mayHandle(p, it)) break;
        const card = isCard(c);
        logEvent(p, it.k === 'c' ? 'peeked at a face-down card' : `peeked at the top ${card ? 'card' : 'piece'} of ${label(it)}`, false, undefined, true);
        mark(p, a.id);
        emit({ t: 'peek', p, c: card ? { d: c.d, i: c.i } : { t: c.t, f: c.f } });
        break;
      }
      case 'roll': opRoll(p, a.ids); break; // (any other field — a forged `f` — is ignored)
      case 'face': opFace(p, a.id, a.f); break;
      case 'split': opSplit(p, a.id, a.n, a.x, a.y, a.onto); break;
      case 'join': opJoin(p, a.id, a.onto); break;
      case 'take': opTake(p, a.id, a.x, a.y, a.hand === true); break;
      case 'pull': opPull(p, a.id, a.x, a.y, a.hand === true); break;
      case 'toBag': opToBag(p, a.id, a.bag); break;
      case 'lock': opLock(p, a.id, a.on === true); break;
      case 'owner': opOwner(p, a.id, a.to ?? null); break;
      case 'seat': opSeat(p, a); break;
      case 'size': {
        // Host-only (as today, quietly): the size selector is only shown to
        // the host, and the host applies its own actions. It becomes `table`.
        const size = own(TABLE_SIZES, a.size) && +a.size;
        if (p === pid && size) setTable(p, roundTable(size));
        break;
      }
      case 'table': {
        if (!hostOnly(p, a)) break;
        let tb;
        try { tb = cleanTable({ shape: a.shape, w: a.w, h: a.h, ...(a.felt !== undefined && { felt: a.felt }) }); } catch (err) {
          console.warn('refused a table', err);
          notify(p, `🚫 ${err.message}`);
          break;
        }
        setTable(p, tb);
        break;
      }
      case 'loadBox': if (hostOnly(p, a)) loadBox(p, a.box, { setup: a.setup === true, clear: a.clear === true }); break;
      case 'clear': if (hostOnly(p, a)) clearTable(p); break;
      case 'chat': {
        const msg = peerText(a.msg).replace(CTRL, ' ').trim().slice(0, 300);
        if (pl && msg) logEvent(p, msg, true);
        break;
      }
      case 'setRules': {
        if (p !== pid) break; // only the host configures rules
        if (a.enabled) {
          try {
            const name = hooks.load(a.code);
            // Re-enabling the same game (after a fix, a Disable or a script
            // error) keeps its state — chips, scores, timers — unless the host
            // ticked "Reset game state"; setup() runs again either way.
            const prev = host.rules?.name === name ? host.rules : null, keep = prev && !a.reset;
            // Another game's state (chips, scores, a hand in progress) is lost: say so.
            const lost = keep ? ' (game state kept)' : prev ? ' (game state reset)' : host.rules ? ` («${host.rules.name}» game state discarded)` : '';
            host.rules = { code: a.code, name, enabled: true, data: keep ? prev.data : {}, public: keep ? prev.public : {} };
            emit({ t: 'rules' });
            lastRulesError = '';
            logEvent(RULES, `«${name}» enabled by ${pl?.name || 'the host'}${lost}`);
            runHook('setup');
            refreshButtons();
          } catch (err) {
            // load() installs a script only once it evaluated: whatever rules were running keep running.
            console.error('rules script failed to load', err);
            lastRulesError = err.message;
            emit({ t: 'toast', msg: `Rules error: ${err.message}${host.rules?.enabled ? ' — the running rules are unchanged' : ''}` });
          }
        } else if (host.rules?.enabled) {
          host.rules.enabled = false;
          emit({ t: 'rules' });
          logEvent(RULES, `rules disabled by ${pl?.name || 'the host'}`);
        }
        break;
      }
      case 'rulesBtn': {
        // The engine enforces what the script offered: a button the player
        // can't see (another player's, or one that just went away) is refused.
        const b = (host.rules?.enabled && host.rules.public.buttons || []).find((x) => x.id === peerText(a.id));
        if (!b || (b.pid && b.pid !== p)) { // nothing happened: no hooks, no new state
          console.warn('refused rules button', a.id, 'from', p);
          notify(p, '🚫 That button is not available to you right now');
          return false;
        }
        runHook('onButton', b.id, p);
        break;
      }
      default: console.warn('unknown action', a);
    }
    // A ruled action that did nothing (refused, or its target had just gone: a
    // pile merged away under a drop) re-sends what it named: the actor's
    // screen still shows its optimistic move, and deltas carry only what is marked.
    if (RULED_ACTIONS.has(a.t) && marks === fx0) touchNamed(p, a);
    if (host.rules?.enabled && (a.t === 'chat' || a.t === 'rulesBtn' || (RULED_ACTIONS.has(a.t) && marks > fx0))) {
      if (a.t === 'chat') runHook('onChat', peerText(a.msg), p);
      runHook('onAction', { ...a, p });
      refreshButtons();
    }
    return bump();
  }

  // --- players come and go ---------------------------------------------------
  /** Registers player p, who just sent an action with this name and seat key:
   *  a new player gets a seat, and the first contact binds the key to it
   *  (checking it is the app's job, in the same synchronous step: two claims
   *  of one seat must not both pass). Returns the player as it was before
   *  (null if new), whether they're back (new, or were offline) and whether
   *  the table changed (it was renumbered: broadcast and save). An id that
   *  isn't a player id (PID_RE: never "__proto__") is refused. */
  function join(p, name, key) {
    if (typeof p !== 'string' || !PID_RE.test(p)) { console.error('join: refused an invalid player id', p); return { known: null, back: false, changed: false }; }
    const known = own(host.players, p);
    const back = !known?.online; // read BEFORE ensurePlayer flips the same object online
    let changed = ensurePlayer(p, name);
    if (key && !own(host.keys, p)) { host.keys[p] = key; changed = true; } // first contact binds the seat (older saves adopt their first claimant)
    if (back) {
      logEvent(p, known ? 'is back at the table' : 'joined the table');
      if (host.rules?.enabled) { runHook('onJoin', p); refreshButtons(); }
    }
    changed = dataOver() || changed || back;
    if (changed) bump();
    return { known, back, changed };
  }
  /** Player p's last connection closed. True if they had a seat (now offline). */
  function leave(p) {
    const pl = own(host.players, p);
    if (!pl) return false;
    pl.online = false;
    touchPlayer(p);
    logEvent(p, 'left the table');
    if (host.rules?.enabled) { runHook('onLeave', p); refreshButtons(); }
    dataOver();
    return bump();
  }

  /** Opens a fresh table: the host seated as `name`, one standard deck in the middle. */
  function open(name) {
    ensurePlayer(pid, name);
    const deck = standardDeck(false);
    const deckId = mint(host.decks);
    host.decks[deckId] = deck;
    const pile = { k: 'p', rot: 0, name: deck.name, cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })) };
    place(pile, host.table.w / 2 - CARD_W / 2, host.table.h / 2 - CARD_H / 2);
    put(mint(host.items), pile);
    logEvent(pid, 'opened the table');
  }

  /** Resumes a saved table in the host's browser, the host seated as `name`.
   *  Saves may predate the sanitizers (and could hold a deck or a box a guest
   *  crafted), so their decks and boxes pass them again — the boxes first,
   *  then the items (spec §2h): a piece whose box didn't survive stays, drawn
   *  as a "?", and is said. A saved rules script that no longer loads
   *  disables the rules loudly rather than wedging the resume. */
  function resume(name) {
    const decks = {}, boxes = {}; // fresh maps: a corrupt save may hold a string or an array here
    for (const [id, d] of Object.entries(host.decks)) {
      try { decks[id] = cleanDeck(d); } catch (err) { console.error(`saved deck ${id} dropped`, err); }
    }
    for (const [id, b] of Object.entries(host.boxes)) {
      try { boxes[id] = cleanBox(b); } catch (err) { console.error(`saved box ${id} dropped`, err); }
    }
    host.decks = decks;
    host.boxes = boxes;
    boxKeys = null;
    const lost = Object.values(host.items).filter((it) => (it.k === 'g' || it.k === 's') && !typeOf(it.t)).length;
    if (lost) console.error(`${lost} pieces of this table belong to a game box that is missing: they show as "?"`);
    if (host.rules?.code) {
      try {
        hooks.load(host.rules.code);
        emit({ t: 'rules' });
      } catch (err) {
        console.error('saved rules script failed to load', err);
        lastRulesError = err.message;
        host.rules.enabled = false;
        emit({ t: 'toast', msg: `Saved rules failed to load: ${err.message}` });
      }
    }
    // Everyone else waits offline (a watcher keeps watching); seats didn't
    // exist in the oldest saves, and the table used to be a larger
    // rectangle — pull stranded items back onto the felt.
    for (const [p, pl] of Object.entries(host.players)) {
      pl.online = false;
      if (pl.seat === undefined) pl.seat = assignSeat();
      touchPlayer(p);
    }
    for (const [id, it] of Object.entries(host.items)) {
      const { w, h } = size(it);
      ({ x: it.x, y: it.y } = clampToTable(host.table, it.x, it.y, w, h));
      touch(id);
    }
    ensurePlayer(pid, name);
    logEvent(pid, 'resumed the table');
    bump();
  }

  // --- the engine around the script ------------------------------------------
  const FIND_KEYS = ['kind', 'name', 'up', 'type', 'owner'];
  /** t.find's kinds: item kinds, and the piece kinds (pieces of that type kind). */
  const FIND_KINDS = { card: 'c', pile: 'p', piece: 'g', supply: 's', bag: 'b', token: 'g', tile: 'g', die: 'g', board: 'g' };
  /** The [id, item] pairs of kind k, from the index. Items change only
   *  through put and remove, so the index holds exactly the table's items: an
   *  id it holds that the table doesn't was deleted behind its back (a bug). */
  function* ofKind(k) {
    for (const id of byKind.get(k)) {
      const it = own(host.items, id);
      if (it?.k === k) yield [id, it];
      else console.error(`the ${k} index holds ${id}, which the table doesn't: was state.items changed directly?`);
    }
  }
  /** A script's own copy of item `id`: changing it never changes the table. */
  const copyItem = (id, it) => ({ id, ...it, ...(it.cards && { cards: it.cards.map((c) => ({ ...c })) }), ...(it.of && { of: it.of.map((m) => ({ ...m })) }) });
  /** Runs one script hook; any throw disables the rules loudly. */
  function runHook(name, ...args) {
    if (!host.rules?.enabled || !hooks.has(name)) return undefined;
    try {
      return callHook(name, ...args);
    } catch (err) {
      hookFailed(`${name}()`, err);
      return undefined;
    }
  }
  /** Calls a hook with the facade. Hooks are synchronous: a Promise (an
   *  async hook, or a runner that answers later) would let validate's veto
   *  pass unread, so it throws — a script error, which fails closed. */
  function callHook(name, ...args) {
    jobHooks.add(name);
    const r = hooks.call(name, tApi, ...args);
    if (typeof r?.then === 'function') throw new Error('hooks must be synchronous (it returned a Promise)');
    return r;
  }
  const jobHooks = new Set(); // the hooks the current job ran (dataOver)
  /** Ends a job (an action, a join or leave, the timers) — and validate(),
   *  whose veto must not stand on an oversized t.data: if it ran hooks,
   *  t.data must still fit DATA_MAX_CHARS (it is saved, and copied to a
   *  Worker), or the rules disable loudly, naming those hooks. One stringify
   *  per job (plus one after validate), not one per hook. The job's
   *  t.random() draws go on the record, in one line. True when the rules
   *  were disabled (a change: the caller renumbers). */
  function dataOver() {
    if (draws) { logEvent(RULES, `used randomness (${draws} draw${draws > 1 ? 's' : ''})`); draws = 0; }
    const names = [...jobHooks].map((h) => `${h}()`).join(', ');
    jobHooks.clear();
    const n = names && host.rules?.enabled ? JSON.stringify(host.rules.data)?.length || 0 : 0;
    if (n <= DATA_MAX_CHARS) return false;
    hookFailed(names, new Error(`t.data is too large (${n.toLocaleString('en-US')} chars, max ${DATA_MAX_CHARS.toLocaleString('en-US')})`));
    return true;
  }
  /** A script error (`where`: the hooks, as "validate()", or the state at
   *  fault): disable the rules, loudly and on the record. */
  function hookFailed(where, err) {
    console.error(`rules: ${where} failed`, err);
    lastRulesError = `${where}: ${err.message}`;
    host.rules.enabled = false;
    emit({ t: 'rules' });
    logEvent(RULES, `rules disabled — script error in ${where}`);
    emit({ t: 'toast', msg: `Rules disabled — error in ${where}: ${err.message}` });
  }
  /** The save couldn't copy the rules' state: t.data or t.public hold
   *  something that isn't data (a function, a DOM node — they must stay
   *  JSON). The rules disable loudly, and both keep their JSON part, which
   *  is all a save ever kept of them. True: a change (renumbered). */
  function unsaveable(why) {
    if (!host.rules) return false;
    for (const k of ['data', 'public']) {
      try { host.rules[k] = JSON.parse(JSON.stringify(host.rules[k] ?? {})); } catch (err) {
        console.error(`t.${k} has no JSON form: emptied`, err);
        host.rules[k] = {};
      }
    }
    if (host.rules.enabled) hookFailed('t.data / t.public', new Error(`they hold a value that can't be saved (${why}) — keep them JSON`));
    return bump();
  }

  /** Sends a private text notice to a player (toast on their screen). Each
   *  costs a signature: a guest gets at most a burst of 10, then 5 per second. */
  function notify(p, msg) {
    if (p !== pid && !flood(notes, p, 10, 5)) { console.warn('notice dropped (flood control)', p, msg); return; }
    emit({ t: 'note', p, msg: String(msg) });
  }

  // --- flood control (host) -----------------------------------------------------
  const acts = new Map(), notes = new Map(); // player id → token bucket (see flood)
  const talk = new Map(); // player id → timestamps of recent chats/renames
  /** Token bucket: true while `key` may act — a burst of `burst`, refilling
   *  at `perSec`. `map` keeps each key's {n, at}. */
  function flood(map, key, burst, perSec) {
    const ts = now(), b = map.get(key) || { n: burst, at: ts };
    b.n = Math.min(burst, b.n + ((ts - b.at) / 1000) * perSec);
    b.at = ts;
    map.set(key, b);
    if (b.n < 1) return false;
    b.n--;
    return true;
  }
  /** Every action re-renders the host (the one authority): a guest may send
   *  bursts of 40 (a drag, a reconnect's queue), then 20 per second. */
  const mayAct = (p) => flood(acts, p, 40, 20);
  /** A guest may chat or rename at most 5 times per 5 s. The host itself is
   *  exempt — it is the authority over the log anyway. */
  function mayTalk(p) {
    if (p === pid) return true;
    const ts = now(), recent = (talk.get(p) || []).filter((x) => x > ts - 5000);
    talk.set(p, recent);
    if (recent.length >= 5) return false;
    recent.push(ts);
    return true;
  }

  /** Refreshes the script-declared button row into the broadcast public data. */
  function refreshButtons() {
    if (!host.rules?.enabled || !hooks.has('buttons')) return;
    try {
      const btns = callHook('buttons') || [];
      host.rules.public.buttons = btns.map((b) => ({ id: String(b.id), label: String(b.label).slice(0, 30), ...(b.pid ? { pid: b.pid } : {}) }));
    } catch (err) {
      hookFailed('buttons()', err);
    }
  }

  /** Fires due script timers (t.schedule); true if any ran. They live in
   *  rules.data, so they survive a host reload along with everything else. */
  function runTimers() {
    if (!host.rules?.enabled) return false;
    const timers = host.rules.data._timers;
    if (!timers?.length) return false;
    const ts = now(); // one clock reading, so no timer falls between the two filters
    const due = timers.filter((x) => x.at <= ts);
    if (!due.length) return false;
    host.rules.data._timers = timers.filter((x) => x.at > ts);
    for (const x of due) runHook('onTimer', x.tag);
    refreshButtons();
    dataOver();
    return bump();
  }

  /** Whether item `it` matches t.find's query `q` (its keys checked already). */
  function found(it, q, name, owners) {
    if (name !== null && ((it.k !== 'p' && it.k !== 'b') || String(it.name || '').toLowerCase() !== name)) return false;
    if (q.up !== undefined) {
      const up = it.k === 'c' ? it.up : it.k === 'p' ? it.cards.at(-1)?.up : it.k === 'b' ? undefined : it.up !== false;
      if (up === undefined || !!up !== !!q.up) return false;
    }
    if (q.type !== undefined && !((it.k === 'g' || it.k === 's') && (it.t === q.type || it.t.endsWith(`/${q.type}`)))) return false;
    if (owners && !owners.includes(it.owner)) return false;
    const pk = own(FIND_KINDS, q.kind) === 'g' && q.kind !== 'piece' ? q.kind : null; // a piece kind: token, tile, die, board
    return !pk || typeOf(it.t)?.kind === pk;
  }

  // The script's window onto the table: full read access, the complete op set
  // (audited as the "📜 Rules" actor), scratch state, and player interaction.
  // Script ops skip the owner and lock checks (scripts own the rules), not the
  // others: a die is still rolled, not flipped; the table still holds MAX_ITEMS.
  const tApi = {
    get data() { return host.rules.data; },
    get public() { return host.rules.public; },
    set public(v) { host.rules.public = v || {}; },
    /** The players at the table, by seat: watchers only with {all: true} (seat null, last). */
    players: (o = {}) => Object.entries(host.players)
      .filter(([, pl]) => o.all || pl.seat != null)
      .map(([id, pl]) => ({ id, name: pl.name, seat: pl.seat ?? null, ...(pl.seatId && { seatId: pl.seatId }), online: pl.online, handCount: pl.hand.length, host: id === pid }))
      .sort((a, b) => (a.seat ?? 1e9) - (b.seat ?? 1e9)),
    hand: (p) => (own(host.players, p)?.hand || []).map((c) => ({ ...c })),
    /** Every item, copied: O(n) — t.item(id) and t.find(q) are the cheap reads. */
    items: () => Object.entries(host.items).map(([id, it]) => copyItem(id, it)),
    /** One item, copied ({id, ...item}), or null. */
    item: (id) => { const it = own(host.items, id); return it ? copyItem(id, it) : null; },
    /** The items matching q, copied: {kind?: 'card' | 'pile' | 'piece' |
     *  'supply' | 'bag' | 'token' | 'tile' | 'die' | 'board', name? (a pile's
     *  or a bag's, any case), up?, type? ('box/type', or a bare type id in
     *  any box), owner? (a pid also matches 'seat:<their seat>')}. */
    find(q = {}) {
      for (const k of Object.keys(q)) if (!FIND_KEYS.includes(k)) throw new TypeError(`t.find: unknown filter '${k}' — known: ${FIND_KEYS.join(', ')}`);
      const kinds = q.kind === undefined ? [...byKind.keys()] : [own(FIND_KINDS, q.kind)];
      if (!kinds[0]) throw new TypeError(`t.find: unknown kind '${q.kind}' — known: ${Object.keys(FIND_KINDS).join(', ')}`);
      const name = q.name === undefined ? null : String(q.name).toLowerCase();
      const seatId = q.owner !== undefined && own(host.players, q.owner)?.seatId;
      const owners = q.owner === undefined ? null : [q.owner, ...(seatId ? [`seat:${seatId}`] : [])];
      const out = [];
      for (const k of kinds) for (const [id, it] of ofKind(k)) if (found(it, q, name, owners)) out.push(copyItem(id, it));
      return out;
    },
    piles: () => [...ofKind('p')].map(([id, it]) => copyItem(id, it)),
    deal: (pileId, o) => opDealTop(RULES, pileId, o),
    dealToAll(pileId, n = 1, o = {}) {
      for (let i = 0; i < n; i++) {
        for (const p of this.players()) {
          if (o.onlineOnly !== false && !own(host.players, p.id).online) continue;
          opDealTop(RULES, pileId, { ...o, to: p.id });
        }
      }
    },
    draw(p, pileId, n = 1) { for (let i = 0; i < n; i++) opDealTop(RULES, pileId, { to: p }); },
    takeHand: (p, pileId, only) => opTakeHand(RULES, p, pileId, only),
    playFromHand(p, idx, o = {}) {
      const pl = own(host.players, p);
      // splice() would read -1 (a failed findIndex) as "the last card": refuse it
      if (!Number.isInteger(idx) || !pl?.hand[idx]) { console.error('t.playFromHand: bad hand index', p, idx); return false; }
      return opPlay(RULES, p, idx, o, o.up !== false);
    },
    toHand: (p, id) => opToHand(RULES, id, p),
    shuffle: (id) => opShuffle(RULES, id),
    /** Flips a card, a pile or a piece (a die returns false: dice are rolled). */
    flip: (id) => opFlip(RULES, id),
    toPile: (id, pileId) => opToPile(RULES, id, pileId),
    stack: (id, ontoId) => opStack(RULES, id, ontoId),
    newPile: (cards, o) => opNewPile(RULES, cards, o),
    merge: (fromId, toId) => opMerge(RULES, fromId, toId),
    move: (id, x, y) => opMove(RULES, id, x, y),
    rot: (id, deg) => opRot(RULES, id, deg),
    remove: (id) => opRemove(RULES, id),
    /** Rolls die `id` (the crypto RNG): its new face index, or false (not a die, or gone). */
    roll(id) {
      const r = opRoll(RULES, [id]);
      return r ? r[0] : false;
    },
    /** A uniform float in [0, 1) from the table's RNG (the draws of an action are logged once). */
    random() { draws++; return random(); },
    /** Piece type `ref` ('box/type', or an item's {t}), copied — its kind,
     *  name, size, shape, faces, back, flags, meta (public data) and box's
     *  name — or null. */
    type(ref) {
      const t = typeof ref === 'string' ? ref : ref?.t, ty = typeAt(host.boxes, t);
      if (!ty) return null;
      const { board, ...rest } = ty;
      return structuredClone({ ...rest, meta: ty.meta, box: host.boxes[t.slice(0, t.indexOf('/'))].name });
    },
    /** Registers a script-defined deck of image-less cards ({name, text, color,
     *  bg, meta} each) and returns its deckId — it creates NO pile, so scripts
     *  can keep big decks off the table (small piles via t.newPile([{d,i,up}])
     *  keep the broadcast state light). `back` may be a solid color ("#111"),
     *  and nothing else: a script deck has no images (a TypeError says so). */
    newDeck(def) {
      if (def.back != null && !COLOR_RE.test(def.back)) throw new TypeError('t.newDeck: back must be a color like "#111"');
      const deckId = mint(host.decks);
      host.decks[deckId] = cleanDeck({
        name: def.name, back: def.back,
        cards: (def.cards || []).map((c) => ({ n: c.name, txt: c.text, col: c.color, b: c.bg, meta: c.meta })),
      });
      emit({ t: 'deck', id: deckId });
      logEvent(RULES, `defined deck "${host.decks[deckId].name}" (${host.decks[deckId].cards.length} cards)`);
      return deckId;
    },
    addStandardDeck(o = {}) {
      const deck = standardDeck(!!o.jokers);
      const deckId = mint(host.decks);
      host.decks[deckId] = deck;
      emit({ t: 'deck', id: deckId });
      const nid = opNewPile(RULES, deck.cards.map((_, i) => ({ d: deckId, i, up: false })), { x: o.x, y: o.y, name: deck.name });
      if (nid) { own(host.items, nid).name = deck.name; touch(nid); }
      return nid;
    },
    /** The table: {shape, w, h, size (= w), cx, cy, r: how far from the centre items reach}. */
    geom: () => ({ shape: host.table.shape, w: host.table.w, h: host.table.h, size: host.table.w, cx: host.table.w / 2, cy: host.table.h / 2, r: Math.min(host.table.w, host.table.h) / 2 - 110 }),
    hostId: pid, // the host's own player id: for host-only buttons ({pid: t.hostId}) and commands
    say: (msg) => logEvent(RULES, String(msg).slice(0, 300)),
    /** Big banner on every screen (also logged). For "Flop!", "You win", ... */
    announce(msg) {
      const text = String(msg).slice(0, 200);
      logEvent(RULES, `📣 ${text}`);
      emit({ t: 'ann', msg: text });
    },
    /** Declares winner(s): 🏆 on their seats (public.winners) + an announcement.
     *  winSeq counts the calls, so each win celebrates, even by the same winners. */
    win(winners, msg) {
      host.rules.public.winners = (Array.isArray(winners) ? winners : [winners]).filter(Boolean);
      host.rules.public.winSeq = (host.rules.public.winSeq || 0) + 1;
      this.announce(msg || 'Game over!');
    },
    tell: (p, msg) => notify(p, String(msg)),
    schedule(sec, tag) {
      if (!Number.isFinite(sec) || sec < 0) throw new Error(`t.schedule: seconds must be a number ≥ 0, got ${sec}`);
      (host.rules.data._timers ||= []).push({ at: now() + sec * 1000, tag: String(tag) });
    },
    nextSeat(p) {
      const ps = this.players().filter((x) => x.online || x.id === p);
      const i = ps.findIndex((x) => x.id === p);
      return ps.length ? ps[(i + 1) % ps.length].id : p;
    },
    cardName: (ref) => cardName(host.decks, ref.d, ref.i),
    /** Full card identity for game logic: {name, rank, suit, text, meta, deck}.
     *  `meta` is the free-form JSON from a custom deck's manifest. */
    card(ref) {
      const deck = host.decks[ref.d], c = deck?.cards[ref.i];
      if (!c) return null;
      return structuredClone({
        name: cardName(host.decks, ref.d, ref.i), rank: c.r, suit: c.s, text: c.txt,
        meta: c.meta, deck: deck.name,
      });
    },
  };

  /** Moves a player's hand onto a pile, face down: every card, or only those
   *  `only({d, i})` picks (scripts: "my game's deck", leaving others' cards). */
  function opTakeHand(actor, p, pileId, only) {
    const pl = own(host.players, p), pile = own(host.items, pileId);
    if (!pl || pile?.k !== 'p') return false;
    const out = typeof only === 'function' ? pl.hand.filter((c) => only({ ...c })) : pl.hand.slice();
    if (out.length) {
      const whose = out.length === pl.hand.length ? `${pl.name || 'a player'}'s hand` : `cards from ${pl.name || 'a player'}'s hand`;
      logEvent(actor, `returned ${whose} (${out.length}) to ${label(pile)}`);
      mark(actor, pileId);
      pl.hand = pl.hand.filter((c) => !out.includes(c));
      touchPlayer(p, { hand: true });
      for (const c of out) pile.cards.push(isCard(c) ? { d: c.d, i: c.i, up: false } : { t: c.t, f: c.f, up: !typeOf(c.t)?.back });
      touch(pileId);
    }
    return true;
  }

  // --- the public view: what guests may know (full recomputes) -------------------
  function publicPlayers() {
    return Object.fromEntries(Object.entries(host.players).map(([p, pl]) => [p, pubPlayer(pl)]));
  }
  /** The table as players see it (see pubItem); T.pub holds the same, kept up to date incrementally. */
  function publicItems() {
    return Object.fromEntries(Object.entries(host.items).map(([id, it]) => [id, pubItem(it, host.boxes)]));
  }
  const rulesView = () => (host.rules ? { name: host.rules.name, enabled: host.rules.enabled, public: host.rules.public } : null);
  let rulesSig = JSON.stringify(rulesView()); // what the last takeDirty() saw

  // --- delta sync: the dirty sets, patches and snapshots ------------------------
  /** Hands over what changed since the last call (the dirty sets) and starts
   *  afresh. The app calls it once per broadcast tick. Scripts change
   *  t.public in place, so the rules are found dirty by comparison here, as
   *  is `handy` (from the items). */
  function takeDirty() {
    refresh();
    const d = dirty, sig = JSON.stringify(rulesView()), h = handy.size > 0;
    dirty = newDirty();
    if (sig !== rulesSig) { rulesSig = sig; d.rules = true; }
    if (h !== handySent) { d.handy = handySent !== undefined; handySent = h; }
    return d;
  }
  /** The part of a patch every recipient shares, from a takeDirty() result:
   *  only what changed — whole public items and players, removed ids, new log
   *  entries, the table, seats and `handy` — item ids in sorted order (creation order never shows). */
  function patchContent(d) {
    refresh();
    const c = {};
    if (d.table) c.table = host.table;
    if (d.seats) c.seats = host.seats;
    if (d.handy) c.handy = handy.size > 0;
    if (d.rules) c.rules = rulesView();
    if (d.items.size) c.items = Object.fromEntries([...d.items].sort().map((id) => [id, pub.get(id)]));
    if (d.removed.size) c.del = [...d.removed].sort();
    const ps = [...d.players].filter((p) => own(host.players, p)).sort();
    if (ps.length) c.players = Object.fromEntries(ps.map((p) => [p, pubPlayer(host.players[p])]));
    if (d.log.length) c.log = trimLog(d.log); // entries this tick both appends and trims need not travel
    return c;
  }
  /** The shared part of a snapshot: the whole public table. Build it in the
   *  same tick as the takeDirty() it follows, so the next patch continues it. */
  function snapContent() {
    refresh();
    const items = Object.fromEntries(Object.keys(host.items).sort().map((id) => [id, pub.get(id)]));
    return { table: host.table, seats: host.seats, handy: handy.size > 0, rules: rulesView(), items, players: publicPlayers(), log: host.log };
  }
  /** Marks the items action `a` names (id, pile, onto, bag, and the first
   *  NAMED_IDS of ids), and for a hand action p's hand, to be re-sent
   *  unchanged: after a refusal the actor's optimistic UI (a drag, a card
   *  taken from the hand) must snap back, and deltas only carry what is
   *  marked. True when anything was marked. */
  function touchNamed(p, a) {
    let any = false;
    for (const id of [a.id, a.pile, a.onto, a.bag, ...(Array.isArray(a.ids) ? a.ids.slice(0, NAMED_IDS) : [])]) any = touch(id) || any;
    if (HAND_ACTIONS.has(a.t) && own(host.players, p)) { touchPlayer(p, { hand: true }); any = true; }
    return any;
  }
  const refusals = new Map(); // player id → token bucket (refreshFor)
  /** An action of p's was refused before it reached the table (flood
   *  control): re-send what it names (touchNamed). A refused action costs no
   *  flood token, so these re-sends have their own bucket (a burst of 10,
   *  then 5 per second): a flood can't make the host re-send the table to
   *  everyone. True when something was re-sent (renumbered). */
  function refreshFor(p, a) {
    return flood(refusals, p, 10, 5) && touchNamed(p, a) ? bump() : false;
  }
  /** Applies a host-state patch (from a rules Worker running a mirror of this
   *  table, TABLETOP.md §5): items whole (null = removed), players whole (keys
   *  stay here), new decks and boxes (sanitized again), rules fields, the
   *  table and seats, log entries to append, counters, and refresh touches.
   *  Everything lands in the dirty sets; the caller renumbers (state.seq) and broadcasts. */
  function applyStatePatch(s) {
    for (const [id, it] of Object.entries(s.items || {})) {
      if (id === '__proto__') continue;
      if (it === null) remove(id);
      else put(id, it);
    }
    for (const [p, pl] of Object.entries(s.players || {})) {
      if (p === '__proto__') continue;
      const old = own(host.players, p);
      host.players[p] = pl;
      touchPlayer(p, { hand: JSON.stringify(old?.hand) !== JSON.stringify(pl.hand) });
    }
    for (const [id, deck] of Object.entries(s.decks || {})) {
      if (id === '__proto__') continue;
      try {
        host.decks[id] = cleanDeck(deck);
        emit({ t: 'deck', id });
      } catch (err) { console.error(`patched deck ${id} rejected`, err); }
    }
    for (const [id, rec] of Object.entries(s.boxes || {})) {
      if (id === '__proto__') continue;
      try {
        host.boxes[id] = cleanBox(rec.box);
        host.boxSrc[id] = { src: rec.src, ...(rec.by && { by: rec.by }) };
        boxKeys = null;
        emit({ t: 'box', id });
      } catch (err) { console.error(`patched box ${id} rejected`, err); }
    }
    if (s.rules) {
      const was = host.rules;
      host.rules = { ...was, ...s.rules };
      if (host.rules.code !== was?.code || host.rules.enabled !== was?.enabled) emit({ t: 'rules' });
    }
    if (s.table) { host.table = cleanTable(s.table); dirty.table = true; }
    if ('seats' in s) { host.seats = s.seats && cleanSeats(s.seats); dirty.seats = true; }
    if (Array.isArray(s.log)) {
      host.log = trimLog(host.log.concat(s.log));
      dirty.log = dirty.log.concat(s.log);
    }
    for (const k of ['zMax', 'guestDeckChars', 'boardSeq']) if (Number.isFinite(s[k])) host[k] = s[k];
    if (typeof s.lastSetup === 'string') host.lastSetup = s.lastSetup;
    for (const id of s.refresh || []) touch(id);
    for (const p of s.refreshHands || []) if (own(host.players, p)) touchPlayer(p, { hand: true });
  }

  return {
    state: host,
    api: tApi, // the rules facade `t`
    byKind, byType, byOwner,
    /** The game boxes of the catalog: {boxId: Box} (where each came from: state.boxSrc). */
    get boxes() { return host.boxes; },
    /** id → public item for every item on the table: publicItems(), kept incrementally. */
    get pub() { refresh(); return pub; },
    /** How many items on the table one could hold in a hand (the view's `handy` is T.handy > 0). */
    get handy() { refresh(); return handy.size; },
    /** The last rules-script error, for the rules dialog ('' after a successful enable). */
    get rulesError() { return lastRulesError; },
    apply, join, leave, open, resume, runTimers, mayAct, publicItems, publicPlayers, unsaveable,
    /** Every asset id the table's decks and boxes show: the only images the host serves (app.js). */
    assetRefs: () => assetRefs(host.decks, host.boxes),
    takeDirty, patchContent, snapContent, refreshFor, applyStatePatch,
    /** The state as saved: all of it but the catalog (decks, boxes and where
     *  each box came from), which store.js keeps apart, each written once. */
    snapshot() { const s = { ...host }; delete s.decks; delete s.boxes; delete s.boxSrc; return s; },
    /** The effects queued since the last drain, oldest first (see the top of this file). */
    drain() { const out = effects; effects = []; return out; },
  };
}
