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
//    runner, see scriptHooks)}. Seed now, random (or randInt) and uid, and
//    two tables replay alike.
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
//  • apply() runs one job — an action, or one of the host's internal jobs
//    (_join, _leave, _tick, _rulesOff, _name) — through the ruled-action
//    pipeline (spec §3f.4: handle, strict, validate, the default effect, the
//    hooks after it), inside a journal that rolls back what a vetoed or failed
//    hook did. apply(), leave(), runTimers() and refreshFor() return true, and
//    join() {changed: true}, when the table changed (it was renumbered,
//    state.seq): the app then broadcasts and saves.
//  • A rules Worker (spec §3f) runs a whole table on a mirror of the state:
//    T.job(p, a) runs one job there and returns its StatePatch (what it
//    changed) and effects, which the host's table takes with
//    T.applyStatePatch(patch, out, job) — checking them again, in its own
//    realm, against who acted; T.digest() tells that both agree.
//  • Delta sync (TABLETOP.md §3): every write records what it
//    changed in the dirty sets, and the app's broadcast tick takes them once
//    (T.takeDirty()) to build one patch for everyone (T.patchContent()) or a
//    full snapshot for a newcomer (T.snapContent()), plus each recipient's
//    own part (T.mine(): their hand, asks, hint and t.secret entry). T.pub
//    caches each item's public view, so neither rebuilds the whole table.
//    Guests fold the bodies into their view with viewFromSnap() and applyViewPatch().
import {
  parseAddr, formatAddr, onBoard, toLocal, fromLocal, spotAt, canonLocal, spotOf, zonesAt,
  neighbors as gridNeighbors, distance as gridDistance, line as gridLine, linked as linkedSpaces,
} from './grid.js?v=1';
import { BOXES } from './templates.js?v=1';

// --- versions -----------------------------------------------------------------
/** The code version every cardtable module exports, and every import of one
 *  carries (`./core.js?v=1`): bumped in all of them by every change to any,
 *  so a page never mixes a fresh module with a cached one (app.js checks). */
export const MODULE_V = 1;
/** The wire protocol: actions carry it as `_v`, host bodies as `v`; a peer
 *  on another version is refused loudly rather than misread. */
export const PROTO = 5;
/** The host state's schema version (state.v), the newest MIGRATE target. */
export const STATE_V = 5;

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
// Lists the engine reads are frozen arrays, never Sets: a rules Worker
// freezes every export of the modules it loads before a script runs (a
// script can import() them), and a frozen Set still takes
// Set.prototype.add.call (D148).
/** The image types a deck may carry (as data URLs, isImgURL, or as assets). */
export const IMG_MIMES = Object.freeze(['image/webp', 'image/png', 'image/jpeg', 'image/gif']);
/** The largest image a peer stores or accepts, in bytes. */
export const ASSET_MAX_BYTES = 2e6;
export const COLOR_RE = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i;
export const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'JOKER']);
export const SUITS = Object.freeze(['♠', '♥', '♦', '♣', '🃏']);
export const MAX_DECK_BYTES = 24e6, MAX_DECK_CARDS = 5000;
export const GUEST_DECK_CHARS = 1.5e6; // all decks guests add to one table, together (see apply 'addDeck')
/** Why a guest's deck of `cost` chars doesn't fit a table whose guests used `used` already ('' if it fits). */
export const deckOverBudget = (used, cost) => (used + cost > GUEST_DECK_CHARS
  ? `this table's deck budget for guests is full (${Math.round((GUEST_DECK_CHARS - used) / 1e3)} kB left) — ask the host to add it` : '');
/** The same for a guest's game box, which shares that budget (spec §4c: "🚫 Box rejected: …"). */
export const boxOverBudget = (used, cost) => (used + cost > GUEST_DECK_CHARS
  ? `this table's budget for guests is full (${Math.round((GUEST_DECK_CHARS - used) / 1e3)} kB left) — ask the host to add it` : '');
// Control characters (C0, DEL, C1) never reach a page or the terminal bridge:
// a peer's ESC sequences could clear or spoof a bridge user's terminal.
// CTRL_NL spares the newline, for multi-line card texts.
export const CTRL = /[\u0000-\u001f\u007f-\u009f]/g, CTRL_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
export const str = (v, n, strip = CTRL) => (typeof v === 'string' && v ? v.replace(strip, '').slice(0, n) : undefined);
/** A chat message `msg` (a peer's) as its log line reads ('' for none). */
const chatLine = (msg) => peerText(msg).replace(CTRL, ' ').trim().slice(0, 300);

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
    if (RANKS.includes(c.r) && SUITS.includes(c.s)) Object.assign(o, { r: c.r, s: c.s, c: c.c === 'r' ? 'r' : 'b' });
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
/** The name a joining player's empty name takes ('' for none: `0` too, unlike
 *  a rename's cleanName) — ensurePlayer's, and what checkPatch holds a
 *  Worker's _join to: one expression, so the two can't drift apart (D152). */
const joinName = (s) => (s ? cleanName(s) : '');

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
/** A card's flags: it turns freely, goes into a hand and piles up. */
const CARD_FLAGS = Object.freeze({ w: CARD_W, h: CARD_H, shape: 'rect', rotStep: 0, hand: true, stack: 'pile' });
/** The flags {w, h, shape, rotStep, hand, stack} of any item, host or public
 *  (spec §2b: what a renderer needs): a piece-like one's (see lookOf), a
 *  placeholder's ({…, placeholder: true}) when its look isn't here; a
 *  card's (CARD_FLAGS); a pile's top's (an empty pile is card-like); a bag's
 *  (BAG_W × BAG_H, held in a hand iff its fixed `hand` flag says so). */
export function flagsOf(it, boxes) {
  if (it.k === 'b') return { w: BAG_W, h: BAG_H, shape: 'rect', rotStep: 0, hand: !!it.hand, stack: 'none' };
  if (it.k === 'p') { const m = it.top || it.cards?.at(-1); return m ? flagsOf(m, boxes) : CARD_FLAGS; }
  if (it.k === 'c' || 'd' in it) return CARD_FLAGS;
  const L = lookOf(it, boxes);
  return L ? Object.fromEntries(FLAGS.map((k) => [k, L[k]])) : PLACEHOLDER_FLAGS;
}
/** An item's size {w, h}, host or public: cards 100 × 140, bags 90 × 100,
 *  piles their top's, pieces and supplies their type's (the back's when hidden). */
export const sizeOf = (it, boxes) => { const { w, h } = flagsOf(it, boxes); return { w, h }; };
/** Angle `rot` snapped to rotation step `step` (0: free), in [0, 360). */
export const snapRot = (rot, step) => normRot(step ? Math.round(normRot(rot) / step) * step : rot);
/** Where named seat `def` (a SeatDef, or none) at angle `a` sits on table tb
 *  (spec §2a): a seat placed with `at` at that exact point, facing the
 *  table's centre ({x, y, ux, uy} as seatPoint gives them); any other on the
 *  rim at its angle (seatPoint). */
export function seatAt(tb, a, def) {
  if (!def?.at) return seatPoint(tb, a);
  const [x, y] = def.at, dx = tb.w / 2 - x, dy = tb.h / 2 - y, d = Math.hypot(dx, dy) || 1;
  return { x, y, ux: dx / d, uy: dy / d };
}
/** A face's name: its label, else its `name` (never drawn: a reversi disc's
 *  "Light disc"), else its pips ("5", "3|4"), else its number from 1. */
export function faceLabel(face, f) {
  if (face?.label || face?.name) return face.label || face.name;
  if (face?.pips !== undefined) return Array.isArray(face.pips) ? face.pips.join('|') : String(face.pips);
  return String(num(f) + 1);
}
/** A SHOWN piece's name {t, f}: its face's label or name if it has one, else its type's name. */
export function pieceName(boxes, t, f) {
  const ty = typeAt(boxes, t);
  return ty ? ty.faces[f]?.label || ty.faces[f]?.name || ty.name : 'an unknown piece';
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
/** A hand holds at most MAX_HAND entries, a pile MAX_PILE members (as a deck
 *  holds MAX_DECK_CARDS): a supply never runs out, and pieces taken from one
 *  into a hand or onto a pile would otherwise grow the state (and the hand
 *  re-sent whole on every change) without bound. Checked only on growth. */
export const MAX_HAND = 1000, MAX_PILE = 5000;
export const MAX_TYPES = 500, MAX_BACKS = 50, MAX_FACES = 64, MAX_DIE_FACES = 100, MAX_IMGS = 2000;
export const MAX_CELLS = 4096, MAX_SPACES = 1000, MAX_ZONES = 100, MAX_POLY = 64, MAX_LINKS = 4000, MAX_FILLS = 4096, MAX_MARKS = 64;
export const MAX_SETUP_ENTRIES = 2000, MAX_SETUP_ITEMS = 3000, MAX_SEATS = 12, MAX_META_CHARS = 2000, MAX_BOX_DECKS = 50;
/** A box's own caps (spec §4a, §4j): its rules script, its exported rules
 *  state (JSON), its `meta` (JSON, public); the transport form of an upload
 *  (MAX_BOX_CHARS, as JSON, images inline) and the bytes of its images. */
export const MAX_RULES_CHARS = 2e5, MAX_RULES_STATE = 4e6, MAX_BOX_META = 8192, MAX_BOX_CHARS = 64e6, MAX_BOX_BYTES = 48e6;
/** A catalog id (a deck's, a box's) or an item id a box asks for: host-minted (uid), 8 hex digits — guests ignore any other. */
export const CATALOG_ID_RE = /^[0-9a-f]{8}$/;
/** Boards sit in a z band below every other item: BOARD_Z0 + boardSeq (newer above older). */
export const BOARD_Z0 = -1e6;
/** The highest z an item takes, and the counter (state.zMax) that tops
 *  them: a Worker's patch stays within it (checkPatch), and a load past it
 *  renumbers the items in their order (createTable) — so zTop() never
 *  leaves the integers a number keeps exactly, whatever a lie left (D150). */
export const Z_MAX = 2 ** 52;
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
/** Map m's list under key k, made empty on first use. */
const listAt = (m, k) => m.get(k) ?? m.set(k, []).get(k);

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
  if (R.has('name')) o.name = R.text('name', 40, 1); // (what the log calls it, when it has no label: never drawn)
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
  // A piece whose label must read upright on every screen (a chess piece's
  // glyph, for the player across the board too), as a board's coordinates
  // do: pieces.js draws it so (D160). Only `true` is kept, so a box without it is unchanged.
  if (R.bool('upright', false)) o.upright = true;
  if (R.has('meta')) o.meta = R.json('meta', MAX_META_CHARS);
  if (R.has('board')) {
    if (kind !== 'board') R.fail('board', 'is only for boards');
    o.board = cleanBoard(R.get('board'), `${at}.board`);
    o.rotStep = 90; // (spec §3a: a structured board turns by quarter turns only, so its spots stay on the grid of the table's own turns)
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
const SETUP_KINDS = ['piece', 'supply', 'bag', 'deck', 'pile', 'card', 'hands', 'forEachSeat', 'group'];
/** A setup's `#k`: the k-th seated player, clockwise from the bottom of the table (spec §4a). */
const SEAT_K_RE = /^#[1-9]\d?$/;
/** A setup (SetupEntry[], spec §4a: the Phase 2 grammar, then Phase 4's
 *  `deck`, `pile`, `card` and `hands` entries, owners `#k`, entry `id`s and
 *  the `{board, at}` and address forms of `at`): its entries checked
 *  against the box's types, seats and decks (`deckNames`: the names its
 *  `decks` maps; a deck's cards are known only once it is in a table's
 *  catalog, so the card indices are the setup's to check: setupProblem). */
function cleanSetup(list, types, seats, deckNames = []) {
  let entries = 0;
  const seatIds = new Set((seats || []).map((s) => s.id)), ids = new Set(), boardRefs = [], boardsPlaced = new Set();
  function where(R, at, inSeat) {
    const v = R.get('at');
    if (v === 'center') return v;
    if (v === 'seat' || (isObj(v) && Object.hasOwn(v, 'seat'))) {
      if (!inSeat) R.fail('at', 'can only be a seat inside forEachSeat');
      return v === 'seat' ? v : { seat: reader(v, `${at}.at`).pair('seat') };
    }
    if (Array.isArray(v)) return R.pair('at');
    if (isObj(v) && Object.hasOwn(v, 'board')) { // an address on the first board of that type this setup places
      const B = reader(v, `${at}.at`), b = B.get('board'), ty = isId(b, TYPE_ID_RE) && own(types, b), local = B.get('at');
      if (!ty?.board) B.fail('board', `names no board of the box with spots (${JSON.stringify(String(b).slice(0, 40))})`);
      const g = ty.board.grid, c = typeof local === 'string' && g && parseAddr(g, local);
      if (!c && !(ty.board.spaces || []).some((sp) => sp.id === local)) B.fail('at', `is no address of the board "${b}" (${JSON.stringify(String(local).slice(0, 20))})`);
      boardRefs.push([b, `${at}.at`]);
      return { board: b, at: c ? formatAddr(g, c.c, c.r) : local };
    }
    if (typeof v === 'string' && v.length <= 100 && onBoards(v)) return v; // (read on the table when the entry is laid out)
    return R.fail('at', 'must be [x, y], "center", "seat", {seat: [dx, dy]}, an address on a board of the box or {board, at}');
  }
  /** Whether address `s` (spec §3a: "<local>", or "<board type>[#n]:<local>") is a spot of some board type of the box. */
  function onBoards(s) {
    const k = s.lastIndexOf(':'), tid = k < 0 ? null : s.slice(0, k).replace(/#[1-9]\d*$/, ''), local = s.slice(k + 1);
    const on = (ty) => !!ty?.board && (!!(ty.board.grid && parseAddr(ty.board.grid, local)) || (ty.board.spaces || []).some((sp) => sp.id === local));
    return tid === null ? Object.values(types).some(on) : isId(tid, TYPE_ID_RE) && on(own(types, tid));
  }
  function owner(R, inSeat) {
    const v = R.get('owner');
    if ((v === 'seat' && inSeat) || (typeof v === 'string' && SEAT_K_RE.test(v))) return v;
    if (typeof v === 'string' && v.startsWith('seat:') && seatIds.has(v.slice(5))) return v;
    return R.fail('owner', `must be "seat:<a seat of the box>", "#k" (the k-th seated player)${inSeat ? ' or "seat"' : ' ("seat" only inside forEachSeat)'}`);
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
  /** A deck of the box, by name. */
  function deck(R) {
    const d = R.get('deck');
    if (typeof d !== 'string' || !deckNames.includes(d)) R.fail('deck', `names no deck of the box (${JSON.stringify(String(d).slice(0, 40))})`);
    return d;
  }
  /** A card {deck, i, up?} or a piece {piece, f?, up?} of a pile or a hand (at path `at`). */
  function member(m, at, hand) {
    const M = reader(m, at);
    if (M.has('deck') === M.has('piece')) throw new Error(`${at} must be a card {deck, i} or a piece {piece, f?}`);
    if (M.has('piece')) {
      const [o, ty] = piece(M, 'piece');
      if (hand && !ty.hand) M.fail('piece', `"${o.piece}" can't be held in a hand`);
      return o;
    }
    const o = { deck: deck(M), i: M.count('i', 0, MAX_DECK_CARDS - 1) };
    if (!hand && M.has('up')) o.up = M.bool('up');
    return o;
  }
  /** The hidden piece entries under `list` (at path `at`), nested ones too: [entry, path]. */
  const hiddenIn = (list, at) => list.flatMap((e, k) => {
    const sub = e.group ? 'group' : e.forEachSeat ? 'forEachSeat' : null;
    return sub ? hiddenIn(e[sub], `${at}[${k}].${sub}`) : e.piece !== undefined && e.up === false ? [[e, `${at}[${k}]`]] : [];
  });
  /** A shuffled group permutes the places of its hidden pieces that share a
   *  back (spec §2c): everything else of theirs that shows (rot, lock, n,
   *  owner) must agree, or it would tell them apart after the shuffle. */
  function sameLooks(group, at) {
    const first = new Map(); // back id → [path, looks] of its first hidden piece
    for (const [e, path] of hiddenIn(group, `${at}.group`)) {
      const ty = types[e.piece], looks = [snapRot(e.rot, ty.rotStep), e.lock ?? ty.kind === 'board', e.n ?? 1, e.owner ?? null];
      const [path0, looks0] = first.get(ty.back) ?? first.set(ty.back, [path, looks]).get(ty.back), k = looks.findIndex((v, j) => v !== looks0[j]);
      if (k >= 0) throw new Error(`${path}: ${['rot', 'lock', 'n', 'owner'][k]} differs from ${path0}, which shares its back — the shuffle would show which is which`);
    }
  }
  function entry(e, at, inSeat) {
    if (++entries > MAX_SETUP_ENTRIES) throw new Error(`setup has too many entries (max ${MAX_SETUP_ENTRIES})`);
    const R = reader(e, at), kinds = SETUP_KINDS.filter((k) => R.has(k));
    if (kinds.length !== 1) throw new Error(`${at} needs exactly one of ${SETUP_KINDS.join(', ')}`);
    const [kind] = kinds;
    if (kind === 'forEachSeat' || kind === 'group') {
      if (kind === 'forEachSeat' && inSeat) R.fail(kind, "can't be inside another forEachSeat");
      const o = { [kind]: R.list(kind, MAX_SETUP_ENTRIES).map((x, k) => entry(x, `${at}.${kind}[${k}]`, inSeat || kind === 'forEachSeat')) };
      if (kind === 'group' && R.has('shuffle')) {
        if (R.get('shuffle') !== true) R.fail('shuffle', 'must be true');
        o.shuffle = true;
        sameLooks(o.group, at);
      }
      return o;
    }
    if (kind === 'hands') { // cards and pieces dealt into hands: "<a named seat>" or "#k" → its entries
      if (inSeat) R.fail(kind, "can't be inside forEachSeat (name the seats: a seat id, or #k)");
      const H = R.get('hands');
      if (!isObj(H)) R.fail('hands', 'must map seats ("<seat id>" or "#k") to lists of cards and pieces');
      const o = { hands: {} };
      for (const [k, l] of Object.entries(H)) {
        if (!SEAT_K_RE.test(k) && !seatIds.has(k)) R.fail('hands', `names no seat: ${JSON.stringify(k.slice(0, 30))} (a seat of the box, or #k)`);
        o.hands[k] = reader({ [k]: l }, `${at}.hands`).list(k, MAX_HAND, 1).map((m, j) => member(m, `${at}.hands.${k}[${j}]`, true));
      }
      return o;
    }
    let o;
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
    } else if (kind === 'deck') { // a pile of the whole deck, face down unless `up`
      o = { deck: deck(R) };
      for (const k of ['shuffle', 'up']) if (R.has(k)) o[k] = R.bool(k);
      if (R.has('name')) o.name = R.text('name', 24);
    } else if (kind === 'pile') {
      o = { pile: R.list('pile', MAX_PILE, 1).map((m, k) => member(m, `${at}.pile[${k}]`, false)) };
      const pcs = o.pile.filter((m) => m.piece !== undefined);
      if (pcs.length && pcs.length < o.pile.length) R.fail('pile', 'mixes cards and pieces');
      const tys = pcs.map((m) => types[m.piece]), bad = tys.find((ty) => ty.stack !== 'pile' || ty.w !== tys[0].w || ty.h !== tys[0].h);
      if (bad) R.fail('pile', `holds pieces that don't stack together ("${bad.name}": a pile takes types that stack as a pile, of one size)`);
      if (R.has('name')) o.name = R.text('name', 24);
    } else if (kind === 'card') {
      if (!isObj(R.get('card')) || Object.hasOwn(R.get('card'), 'piece')) R.fail('card', 'must be {deck, i}');
      o = { card: member(R.get('card'), `${at}.card`, true) };
      if (R.has('up')) o.up = R.bool('up');
    } else {
      let ty;
      [o, ty] = piece(R, kind);
      if (kind === 'piece') {
        if (R.has('n')) {
          if (ty.stack !== 'count') R.fail('n', `needs a type that stacks by count ("${o.piece}" doesn't)`);
          o.n = R.count('n', 2, MAX_N);
        }
        if (R.has('count')) o.count = R.count('count', 1, 200);
        if (R.has('spread')) o.spread = R.pair('spread');
        if (ty.kind === 'board') boardsPlaced.add(o.piece);
      }
    }
    if (R.has('rot')) o.rot = normRot(R.num('rot', -COORD, COORD));
    if (R.has('lock')) o.lock = R.bool('lock');
    o.at = where(R, at, inSeat);
    if (R.has('free')) { // (no snapping: a piece set down at [x, y] exactly, as an export writes one that lies off its spot)
      if (R.get('free') !== true || !Array.isArray(o.at)) R.fail('free', 'must be true, with "at" as [x, y]');
      o.free = true;
    }
    if (R.has('owner')) o.owner = owner(R, inSeat);
    if (R.has('id')) { // (kept when no item holds it: an exported game's ids, which its script may store — spec §4c)
      const id = R.get('id');
      if (typeof id !== 'string' || !CATALOG_ID_RE.test(id)) R.fail('id', 'must be an item id (8 hex digits)');
      if (inSeat || (o.count ?? 1) > 1) R.fail('id', 'is only for an entry that places one item');
      if (ids.has(id)) R.fail('id', `"${id}" is used twice`);
      ids.add(id);
      o.id = id;
    }
    return o;
  }
  const out = list.map((e, k) => entry(e, `setup[${k}]`, false));
  const lost = boardRefs.find(([b]) => !boardsPlaced.has(b));
  if (lost) throw new Error(`${lost[1]}: board "${lost[0]}" is never placed by this setup`);
  return out;
}
/** The item ids setup `list` (cleaned) asks for (its entries' `id`s). */
const setupIds = (list) => list.flatMap((e) => (e.group ? setupIds(e.group) : e.id ? [e.id] : []));
/** How many items setup `list` (cleaned) spawns, with `perSeat` seats for each forEachSeat. */
export const countSetup = (list, perSeat) => list.reduce((n, e) => n + (e.forEachSeat ? perSeat * countSetup(e.forEachSeat, perSeat)
  : e.group ? countSetup(e.group, perSeat) : e.hands ? 0 : e.count ?? 1), 0);

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
  const firstUser = {}; // back id → the first type naming it
  for (const [id, raw] of R.map('types', MAX_TYPES, TYPE_ID_RE)) {
    const ty = o.types[id] = cleanType(raw, `types.${id}`, o.imgs, backs);
    if (!ty.back) continue;
    const back = backs[ty.back], first = firstUser[ty.back] ??= id;
    // Boards live in their own z band and spawn locked: a back hiding a board
    // and another piece would tell them apart (spec §2c: a hidden piece shows only its back).
    if ((o.types[first].kind === 'board') !== (ty.kind === 'board')) {
      throw new Error(`types.${id}: back "${ty.back}" also hides types.${first}, and a board can't share a back with other pieces (hidden, they must look alike)`);
    }
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
  if (R.has('decks')) { // its decks, registered as ordinary decks (t.newBox; uploads in Phase 4): name → deck id
    const d = R.get('decks');
    if (!isObj(d) || Object.keys(d).length > MAX_BOX_DECKS) R.fail('decks', `must map at most ${MAX_BOX_DECKS} deck names to deck ids`);
    o.decks = {};
    for (const [name, id] of Object.entries(d)) {
      if (!str(name, 24) || str(name, 24) !== name || name === '__proto__' || !isId(id)) R.fail('decks', `has a bad entry: ${JSON.stringify(name).slice(0, 40)}`);
      o.decks[name] = id;
    }
  }
  if (!Object.keys(o.types).length && !o.decks) R.fail('types', 'needs at least 1 entry (or the box a deck)'); // (a card game's export: decks, no pieces)
  if (R.has('setup')) {
    const setup = cleanSetup(R.list('setup', MAX_SETUP_ENTRIES), o.types, o.seats, Object.keys(o.decks || {}));
    // (forEachSeat is counted once per named seat here; loadBox counts again with the real seats)
    const n = countSetup(setup, o.seats?.length || 1);
    if (n > MAX_SETUP_ITEMS) R.fail('setup', `places too many items (${n}, max ${MAX_SETUP_ITEMS})`);
    o.setup = setup;
  }
  if (R.has('rules')) { // a script, shown as it is (a textarea's value): never markup
    const v = R.get('rules');
    if (typeof v !== 'string' || !v || v.length > MAX_RULES_CHARS) R.fail('rules', `must be the rules script's text (at most ${MAX_RULES_CHARS.toLocaleString('en-US')} characters)`);
    o.rules = v;
  }
  // The rules' state an export carried (spec §4c): its shape and size here;
  // its entries pass the engine's gates (§3a) when they are seeded (setRules
  // with `state`), where a bad one is dropped and the host told.
  if (R.has('rulesState')) {
    const st = R.json('rulesState', MAX_RULES_STATE), bad = isObj(st) && Object.keys(st).find((k) => !['data', 'public', 'asks', 'secret'].includes(k) || !isObj(st[k]));
    if (!isObj(st) || bad !== undefined) R.fail('rulesState', `must be {data, public, asks, secret}, each an object${bad ? ` (not ${JSON.stringify(bad.slice(0, 20))})` : ''}`);
    o.rulesState = st;
  }
  if (R.has('meta')) o.meta = R.json('meta', MAX_BOX_META); // (public: guests and scripts read it)
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

/** A box in the game.json authoring format (spec §4a) as cleanBox reads it:
 *  `pieces` a list of types, each with its `id`, a board's structure
 *  (primary, grid, spaces, zones, links) on the piece itself, `img` the
 *  one-face shorthand ({img: k} = faces [{img: k}]) and its name defaulting
 *  to its id; `backs` a list, each with its `id`, its face given as color /
 *  label / text / img (or `face`), and any flags. The other fields (table,
 *  seats, players, lockable, setup, rules, rulesState, meta, imgs) go on as
 *  they are; `id` and `decks` are the caller's (boxOfDef, t.newBox). Only
 *  reshapes: cleanBox checks everything. Throws a TypeError on what isn't
 *  that shape. */
export function boxFromDef(def) {
  const list = (v, what, re) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => !isObj(x) || typeof x.id !== 'string')) throw new TypeError(`${what} must be a list of {id, …}`);
    // (checked here, not only by cleanBox: an id "__proto__" would set the
    // object's prototype below, and the entry would vanish without a word)
    const bad = v.find((x) => !isId(x.id, re));
    if (bad) throw new TypeError(`${what}: ${JSON.stringify(bad.id.slice(0, 40))} is not an id ([A-Za-z0-9_-], 1–${re === TYPE_ID_RE ? 32 : 24})`);
    if (new Set(v.map((x) => x.id)).size < v.length) throw new TypeError(`${what}: two entries share an id`);
    return v;
  };
  const STRUCT = ['primary', 'grid', 'spaces', 'zones', 'links'], types = {}, backs = {};
  for (const { id, img, ...p } of list(def.pieces, 'pieces', TYPE_ID_RE)) {
    if (img !== undefined && p.faces !== undefined) throw new TypeError(`pieces: "${id}" has both img (one face) and faces — give one`);
    if (img !== undefined) p.faces = [{ img }];
    const board = Object.fromEntries(STRUCT.filter((k) => k in p).map((k) => [k, p[k]]));
    for (const k of STRUCT) delete p[k];
    types[id] = { name: id, ...p, ...(Object.keys(board).length && { board }) };
  }
  for (const { id, color, label, text, img, face, ...flags } of list(def.backs, 'backs', ID_RE)) {
    backs[id] = { ...flags, face: face ?? Object.fromEntries(Object.entries({ color, label, text, img }).filter(([, v]) => v !== undefined)) };
  }
  const { id, pieces, backs: b, decks, types: t, ...rest } = def;
  return { ...rest, name: def.name ?? 'Box', imgs: def.imgs ?? [], types, backs };
}
/** addBox's payload (spec §4c: the game.json authoring format, its images
 *  and decks ingested already — `imgs`: asset ids; `decks`: [{name, id?,
 *  ...a catalog deck}], each through `gate`, cleanDeck by default — and the
 *  ids an export wrote: `id`, each deck's), checked whole (boxFromDef,
 *  cleanBox): {box (cleanBox's; its `decks` name each deck by the id it asks
 *  for, else "new0", "new1"…), decks: [[name, deck, wanted id?]], id: the box
 *  id it asks for, or undefined}. A deck's name is the one it is known by
 *  (setup entries name it). Throws an Error naming the field. */
export function boxOfDef(def, gate = cleanDeck) {
  if (!isObj(def)) throw new Error('the box must be an object');
  const want = (v, at) => {
    if (v !== undefined && !(typeof v === 'string' && CATALOG_ID_RE.test(v))) throw new Error(`${at} must be an id of 8 hex digits (an export writes it), or absent`);
    return v;
  };
  if (def.decks !== undefined && (!Array.isArray(def.decks) || def.decks.length > MAX_BOX_DECKS)) throw new Error(`decks must be a list of at most ${MAX_BOX_DECKS} decks`);
  const decks = (def.decks || []).map((d, k) => {
    let deck;
    try { deck = gate(d); } catch (err) { throw new Error(`decks[${k}]: ${err.message}`); }
    return [deck.name, deck, want(d.id, `decks[${k}].id`)];
  });
  const dup = decks.find(([n], k) => decks.findIndex(([m]) => m === n) !== k);
  if (dup) throw new Error(`decks: two decks are named «${dup[0]}»`);
  let raw;
  try { raw = boxFromDef(def); } catch (err) { throw new Error(err.message); }
  const box = cleanBox({ ...raw, ...(decks.length && { decks: Object.fromEntries(decks.map(([n, , w], k) => [n, w ?? `new${k}`])) }) });
  return { box, decks, id: want(def.id, 'id') };
}
/** A stand-in asset id: a TransportBox's images are checked as images later (store.js ingestBox). */
const NO_IMG = '0'.repeat(64);
/** A TransportBox as it arrives (spec §4c: addBox's payload before
 *  ingestion — images as data URLs in `imgs`, decks in the upload shape,
 *  cleanDeckV1), checked before anything is decoded: at most MAX_BOX_CHARS
 *  of JSON, every image a data URL (isImgURL), and the whole box as
 *  boxOfDef would take it once ingested. Returns its cost (its JSON length:
 *  the guests' budget counts it, as for decks); throws an Error naming what
 *  is wrong. */
export function checkTransportBox(tb) {
  const cost = isObj(tb) ? JSON.stringify(tb).length : 0;
  if (!cost) throw new Error('the box must be an object');
  if (cost > MAX_BOX_CHARS) throw new Error(`the box is too large (${(cost / 1e6).toFixed(1)} M characters, max ${MAX_BOX_CHARS / 1e6} M)`);
  if (tb.imgs !== undefined && !Array.isArray(tb.imgs)) throw new Error('imgs must be a list of images');
  const bad = (tb.imgs || []).findIndex((s) => s !== null && !isImgURL(s));
  if (bad >= 0) throw new Error(`imgs[${bad}] is not an image (a PNG, JPEG, WebP or GIF data URL)`);
  boxOfDef({ ...tb, imgs: (tb.imgs || []).map((s) => s && NO_IMG) }, cleanDeckV1);
  return cost;
}
/** PublicBox (spec §4b, D21): box `box` as guests may see it — without its
 *  setup, rules and rulesState (an exported position's hidden information,
 *  and the host's to run) — plus what the host says of it, for display:
 *  where it came from (`info`: {src, by?}), whether it is built in (by
 *  content: isBuiltin) and whether it comes with rules (`hasRules`). */
export function publicBox(box, info = { src: 'host' }) {
  const { setup, rules, rulesState, ...pub } = box;
  return { ...pub, src: info.src, ...(info.by && { by: info.by }), builtin: isBuiltin(box), ...(rules && { hasRules: true }) };
}
/** A copy of JSON `v` with every object key and string value s replaced by
 *  f(s) (f returns s itself to keep it): ids remapped on import, players as
 *  "@#k" and back (spec §4c). Exact matches only: ids are random 8-hex
 *  strings, so an accidental match is negligible. */
function mapIds(v, f) {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapIds(x, f));
  return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapIds(x, f)])) : v;
}
/** Where `key` first appears as an object's key inside `v` (a path, e.g.
 *  "[0].faces[1].img"), or ''. */
function findKey(v, key, at = '') {
  if (Array.isArray(v)) { for (let k = 0; k < v.length; k++) { const f = findKey(v[k], key, `${at}[${k}]`); if (f) return f; } return ''; }
  if (!isObj(v)) return '';
  for (const [k, x] of Object.entries(v)) { if (k === key) return `${at}.${k}`; const f = findKey(x, key, `${at}.${k}`); if (f) return f; }
  return '';
}

// --- boards: addresses, the primary board and snapping (spec §3a) ----------------
// A piece placed on a structured board snaps to its spots (grid.js) and
// records where, as a QUALIFIED address "<board item id>:<local>" (its
// `at`). Everything a person or a script reads shows the DISPLAY form: bare
// on the primary board, "<typeId>:<local>" on another, "<typeId>#<n>:<local>"
// when several boards of that type id lie on the table (n counts them oldest
// first). These pure functions read an item map, host or public (a hidden
// board shows only its back: it has no spots), so the host (core), the page
// (the snap preview, the fan, the CLI) and Node agree.
/** The table's structured boards: every shown board whose type has a
 *  structure (a grid, spaces or zones), from `entries` ([id, item] pairs).
 *  {list (oldest first: by z, the boards' band), byId, primary (the id of
 *  the oldest `primary: true` board with a grid or spaces, else the oldest
 *  with a grid, else with spaces: zones-only boards never count), prefix
 *  (id → "typeId" or "typeId#n")}. A board in the list is {id, x, y, w, h,
 *  rot, z, typeId, B (its structure)}. */
export function tableBoards(entries, boxes) {
  const list = [];
  for (const [id, it] of entries) {
    if (it.k !== 'g' || !(it.z < 0) || it.up === false || 'b' in it) continue;
    const ty = typeAt(boxes, it.t), B = ty?.kind === 'board' && ty.board;
    if (B && (B.grid || B.spaces?.length || B.zones?.length)) list.push({ id, x: num(it.x), y: num(it.y), w: ty.w, h: ty.h, rot: num(it.rot), z: it.z, typeId: it.t.slice(it.t.indexOf('/') + 1), B });
  }
  list.sort((a, b) => a.z - b.z);
  const spots = list.filter((b) => b.B.grid || b.B.spaces?.length);
  const primary = (spots.find((b) => b.B.primary) || spots.find((b) => b.B.grid) || spots[0])?.id ?? null;
  const count = new Map(), seen = new Map(), prefix = new Map();
  for (const b of list) count.set(b.typeId, (count.get(b.typeId) || 0) + 1);
  for (const b of list) {
    const n = (seen.get(b.typeId) || 0) + 1;
    seen.set(b.typeId, n);
    prefix.set(b.id, count.get(b.typeId) > 1 ? `${b.typeId}#${n}` : b.typeId);
  }
  return { list, byId: new Map(list.map((b) => [b.id, b])), primary, prefix };
}
/** The display form of qualified address (or zone) `q` on boards TB (tableBoards). */
export function displayAddr(TB, q) {
  const k = q.indexOf(':'), id = q.slice(0, k);
  return id === TB.primary ? q.slice(k + 1) : TB.prefix.has(id) ? `${TB.prefix.get(id)}:${q.slice(k + 1)}` : q;
}
/** The boards a board reference names: an item id, "typeId" or "typeId#n". */
function boardsNamed(TB, ref) {
  const b = TB.byId.get(ref);
  if (b) return [b];
  const exact = TB.list.filter((x) => TB.prefix.get(x.id) === ref);
  return exact.length ? exact : TB.list.filter((x) => x.typeId === ref);
}
/** Where address `s` is on boards TB — any form: qualified, display, or bare
 *  (the primary board first, then the one other board that has it):
 *  {b (the board), local (canonical), at (qualified), x, y (its centre on
 *  the table)}; {ambiguous: [display forms]} when several boards could be
 *  meant; null when no board has it. */
export function resolveAddr(TB, s) {
  if (typeof s !== 'string' || !s) return null;
  const k = s.indexOf(':'), local = k < 0 ? s : s.slice(k + 1);
  let cands;
  if (k >= 0) cands = boardsNamed(TB, s.slice(0, k));
  else {
    const P = TB.byId.get(TB.primary);
    cands = P && canonLocal(P.B, local) !== null ? [P] : TB.list.filter((b) => b.id !== TB.primary);
  }
  cands = cands.filter((b) => canonLocal(b.B, local) !== null);
  if (cands.length > 1) return { ambiguous: cands.map((b) => displayAddr(TB, `${b.id}:${canonLocal(b.B, local)}`)) };
  if (!cands.length) return null;
  const b = cands[0], loc = canonLocal(b.B, local), l = spotOf(b.B, loc), p = fromLocal(b, l.x, l.y);
  return { b, local: loc, at: `${b.id}:${loc}`, x: p.x, y: p.y };
}
/** The topmost board of TB under table point (x, y) (or the board `id`, when given), or undefined. */
const boardUnder = (TB, x, y, id) => (id ? TB.byId.get(id) : TB.list.findLast((b) => onBoard(b, x, y)));
/** Snapping (spec §3a): the spot within reach of table point (cx, cy) — a
 *  piece's centre — on the topmost board under it (whichever is primary):
 *  {b, local, at (qualified), x, y (the spot's centre on the table)}, or null
 *  (no board there, or no spot of that board in reach). */
export function snapAt(TB, cx, cy) {
  const b = boardUnder(TB, cx, cy);
  if (!b) return null;
  const l = toLocal(b, cx, cy), s = spotAt(b.B, l.x, l.y);
  if (!s) return null;
  const p = fromLocal(b, s.x, s.y);
  return { b, local: s.local, at: `${b.id}:${s.local}`, x: p.x, y: p.y };
}
/** The zones holding table point (cx, cy), qualified ("<board id>:<zone
 *  id>"): those of the board `onId` (the board a piece's address is on), else
 *  of the topmost board under the point. */
export function zonesUnder(TB, cx, cy, onId) {
  const b = boardUnder(TB, cx, cy, onId);
  if (!b?.B.zones) return [];
  const l = toLocal(b, cx, cy);
  return zonesAt(b.B, l.x, l.y).map((z) => `${b.id}:${z}`);
}
/** The piece kinds that never snap (D112): a board (D22) — and a die, which
 *  dropped on a backgammon point would join the checkers' fan, count in
 *  their ×k and, on top, take every press there. */
const NO_SNAP = new Set(['board', 'die']);
/** Whether item `it` (host or public: a hidden one's type is read from its
 *  `t` when it has one) snaps to the boards' spots and gets an address
 *  (spec §3a): a piece that is neither a board nor a die. `boxes`: the box map. */
export const snaps = (it, boxes) => it.k === 'g' && !(it.z < 0) && !NO_SNAP.has(typeAt(boxes, it.t)?.kind);
/** Where a piece w × h put at top-left (x, y) lands on table `tb` with
 *  boards TB (spec §3a, Snapping) — what the host does (place), the page
 *  previews (the snap preview, __ct.snap) and the CLI's `place` sends, one
 *  rule for all (D112): {x, y, at (qualified) | null}. Its top-left is
 *  clamped onto the table first; then, centred on the spot in reach of its
 *  centre (snapAt, which containment reads too) — even where that puts it
 *  past the playing area's margin, as a board's edge spot may: the spot lies
 *  on the board, in reach of a point inside the area — else where it was
 *  put. `o.free`: no snapping; `o.at`: an address (any form) to centre it on. */
export function snapTo(TB, tb, w, h, x, y, o = {}) {
  const p = clampToTable(tb, x, y, w, h), s = o.free ? null : o.at ? resolveAddr(TB, o.at) : snapAt(TB, p.x + w / 2, p.y + h / 2);
  return s?.b ? { x: s.x - w / 2, y: s.y - h / 2, at: s.at } : { ...p, at: null };
}
/** A group's shift (dx, dy) cut so that every member — `cs`, their centres
 *  [[x, y], …] — stays on table `tb`'s playing area (clampToTable's): on a
 *  rectangle each axis to the range all of them allow (the group slides
 *  along the edge, keeping its shape); on a round table the shift is
 *  shortened until every centre stays within playR. */
export function clampShift(tb, cs, dx, dy) {
  if (tb.shape === 'rect') {
    const [x0, x1, y0, y1] = cs.reduce(([a, b, c, d], [x, y]) => [Math.max(a, 60 - x), Math.min(b, tb.w - 60 - x), Math.max(c, 60 - y), Math.min(d, tb.h - 60 - y)], [-Infinity, Infinity, -Infinity, Infinity]);
    // (the 0s: a member already off the edge holds the group no further back than where it is)
    return { dx: clamp(dx, Math.min(x0, 0), Math.max(x1, 0)), dy: clamp(dy, Math.min(y0, 0), Math.max(y1, 0)) };
  }
  // |p + t·d| ≤ r for each centre p (from the table's centre): the largest t in [0, 1] that holds for all
  const r = playR(tb.w), dd = dx * dx + dy * dy;
  let t = 1;
  if (dd) {
    for (const [x, y] of cs) {
      const px = x - tb.w / 2, py = y - tb.h / 2, b = px * dx + py * dy, c = px * px + py * py - r * r;
      t = Math.min(t, Math.max(0, (-b + Math.sqrt(Math.max(0, b * b - dd * c))) / dd));
    }
  }
  return { dx: dx * t, dy: dy * t };
}

// --- rules engine (see ENGINE.md) ------------------------------------------
// Host-only execution of a host-written script that can veto actions
// (validate) and drive automations (setup/onAction/onButton/onJoin/onLeave/
// onTimer) through the same audited ops as human actions. The engine knows
// no game concepts — all game semantics live in the script.
export const RULES = 'RULES'; // synthetic actor id for script-performed ops
export const RULED_ACTIONS = Object.freeze(['move', 'rot', 'flip', 'shuffle', 'draw', 'deal', 'play', 'handPile', 'toHand', 'toPile', 'stack', 'merge', 'del', 'addDeck', 'peek',
  'roll', 'face', 'split', 'join', 'take', 'pull', 'toBag', 'lock', 'owner', 'seat', 'addBox']);
/** The ruled actions a `strict` script refuses unless handle() returns true
 *  or its `allow` lists them (spec §3c): all but `seat` — players must
 *  always be able to sit down. */
export const STRICT_ACTIONS = Object.freeze(RULED_ACTIONS.filter((t) => t !== 'seat'));
/** Every action type a guest may send: the host refuses anything else at the
 *  network boundary. The host's own actions (HOST_ACTIONS) and its internal
 *  jobs (_join, _leave, _tick, _rulesOff, _name: spec §3c) never come from the wire. */
export const PUBLIC_ACTIONS = Object.freeze([...RULED_ACTIONS, 'hello', 'snap', 'need', 'name', 'chat', 'rulesBtn', 'drag', 'answer', 'select']);
/** The most items one action names at once: a group's live drag (Phase 4's group too). */
export const MAX_GROUP = 200;
/** Actions only the host may take: a guest's is refused with "🚫 Only the host can do that". */
export const HOST_ACTIONS = Object.freeze(['size', 'setRules', 'table', 'loadBox', 'clear', 'setup', 'reset']);
/** Actions that take from or give to the actor's hand: a refusal re-sends it. */
const HAND_ACTIONS = new Set(['play', 'handPile', 'toHand', 'draw']);
/** How many of an action's `ids` a refusal re-sends. A small cap keeps a
 *  vetoed action from making the host re-send many items to everyone (a
 *  roll's dice need none: nothing changes them before the host does). */
const NAMED_IDS = 8;
/** Action `a` with the items it names (id, pile, onto, bag, ids) as text: a
 *  peer may name item "12" as the number 12, which the item map reads alike
 *  but the indexes and dirty sets (Sets) hold apart from "12" — and then
 *  lose track of the item (a later board move throws on every action). A
 *  script's facade calls take the ids the facade hands it, which are text:
 *  one that passes a number confuses only its own Worker's mirror. */
function textIds(a) {
  const num = (v) => typeof v === 'number';
  if (!['id', 'pile', 'onto', 'bag'].some((k) => num(a[k])) && !(Array.isArray(a.ids) && a.ids.some(num))) return a;
  const o = { ...a };
  for (const k of ['id', 'pile', 'onto', 'bag']) if (num(o[k])) o[k] = String(o[k]);
  if (Array.isArray(o.ids)) o.ids = o.ids.map((v) => (num(v) ? String(v) : v));
  return o;
}
/** Rules log aggregation (spec §3e): a run of AGG_MIN or more consecutive
 *  Rules lines of one op in an action becomes one line naming the first
 *  AGG_NAMES addresses or labels; AGG_VERB says what each op did. */
export const AGG_MIN = 4, AGG_NAMES = 8;
const AGG_VERB = { placed: 'placed', removed: 'removed', turned: 'turned', counted: 'counted', locked: 'locked', unlocked: 'unlocked', owner: 'set the owner of' };
/** The most t.data may hold, as JSON (checked as a job's hooks end: spec §3f.4). */
export const DATA_MAX_CHARS = 4e6;
/** select (spec §3c): at most this many per second per player reach onSelect. */
export const SELECT_PER_SEC = 5;
/** t.hint: at most this many items and spaces in all. */
export const HINT_MAX = 500;
/** t.secret: each player's entry is JSON of at most SECRET_MAX_CHARS; the UI shows its `text`, cut at SECRET_TEXT_MAX. */
export const SECRET_MAX_CHARS = 8000, SECRET_TEXT_MAX = 1000;
/** t.ask's caps (spec §10.4): pending asks per player, options, `among`
 *  entries, prompt and label lengths, a hand pick's `count`, a number pick's range. */
export const ASK_MAX = 8, ASK_OPTIONS = 20, ASK_AMONG = 200, ASK_PROMPT = 200, ASK_LABEL = 30, ASK_COUNT = 20, ASK_RANGE = 1e6;
const ASK_KEYS = ['id', 'prompt', 'options', 'pick', 'among', 'count', 'min', 'max'], ASK_PICKS = ['item', 'space', 'hand', 'number'];
/** The rules' engine-owned state, journaled as JSON (spec §3f.4) — `hints` is never saved. */
const RULES_STATE = ['data', 'public', 'asks', 'secret', 'hints'];

/** The engine-state gate on one ask (spec §3a): `spec` is {id, prompt,
 *  options} — each option a label string, or {label, value} (value: JSON,
 *  the label by default) — or {id, prompt, pick, …}: 'item' and 'space' with
 *  `among` (ids, addresses), 'hand' with an optional `count` (1 by default),
 *  'number' with whole numbers `min` ≤ `max`. Returns it normalized (options
 *  as {label, value}, copies only), or throws a TypeError saying what is wrong. */
export function cleanAsk(spec) {
  const bad = (msg) => { throw new TypeError(msg); };
  if (!isObj(spec)) bad('an ask is {id, prompt, options} or {id, prompt, pick, …}');
  const extra = Object.keys(spec).find((k) => !ASK_KEYS.includes(k));
  if (extra !== undefined) bad(`unknown field '${extra.slice(0, 20)}' — known: ${ASK_KEYS.join(', ')}`);
  const { id, prompt, options, pick, among, count, min, max } = spec;
  if (!isId(id)) bad(`id must be 1–24 of [A-Za-z0-9_-], got ${String(JSON.stringify(id)).slice(0, 30)}`);
  if (typeof prompt !== 'string' || [...prompt].length > ASK_PROMPT) bad(`prompt must be text of at most ${ASK_PROMPT} characters`);
  const o = { id, prompt: prompt.replace(CTRL, '') };
  if ((options === undefined) === (pick === undefined)) bad('give options or a pick (one of them)');
  if (options !== undefined) {
    if (!Array.isArray(options) || !options.length || options.length > ASK_OPTIONS) bad(`options must be a list of 1 to ${ASK_OPTIONS}`);
    const stray = ['among', 'count', 'min', 'max'].find((k) => spec[k] !== undefined);
    if (stray) bad(`${stray} goes with a pick, not with options`);
    o.options = options.map((x, k) => {
      const { label, value = label } = typeof x === 'string' ? { label: x } : isObj(x) ? x : bad(`options[${k}] must be a label or {label, value}`);
      if (typeof label !== 'string' || !label || [...label].length > ASK_LABEL) bad(`options[${k}]: a label is 1 to ${ASK_LABEL} characters`);
      let j;
      try { j = JSON.stringify(value); } catch (err) { bad(`options[${k}].value is not JSON (${err.message})`); }
      if (j === undefined || j.length > MAX_META_CHARS) bad(`options[${k}].value must be JSON of at most ${MAX_META_CHARS} chars`);
      return { label: label.replace(CTRL, ''), value: JSON.parse(j) };
    });
    return o;
  }
  if (!ASK_PICKS.includes(pick)) bad(`pick must be one of ${ASK_PICKS.join(', ')}`);
  o.pick = pick;
  const named = pick === 'item' || pick === 'space';
  if (named !== (among !== undefined)) bad(named ? `pick '${pick}' needs among (what may be picked)` : `among goes with pick 'item' or 'space'`);
  if (named) {
    if (!Array.isArray(among) || among.length > ASK_AMONG || among.some((s) => typeof s !== 'string' || !s || s.length > 100)) bad(`among must be a list of at most ${ASK_AMONG} ids or addresses`);
    o.among = [...among];
  }
  if (count !== undefined) {
    if (pick !== 'hand') bad("count goes with pick 'hand'");
    if (!Number.isInteger(count) || count < 1 || count > ASK_COUNT) bad(`count must be 1 to ${ASK_COUNT}`);
    o.count = count;
  }
  if (pick === 'number') {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max || max - min > ASK_RANGE) bad(`pick 'number' needs whole numbers min ≤ max, at most ${ASK_RANGE.toLocaleString('en-US')} apart`);
    Object.assign(o, { min, max });
  } else if (min !== undefined || max !== undefined) bad("min and max go with pick 'number'");
  return o;
}
/** Why `v` (named `path`) is not plain JSON data, or '': a value JSON
 *  would drop or change on its way through a save, a rollback or a patch —
 *  a function, a symbol, a BigInt, a non-finite number, an object that is
 *  not a plain object or array (a Map, a Set, a typed array, an ArrayBuffer,
 *  a Date: a class instance), an array with a hole or `undefined` in it (JSON
 *  writes null), and an object's property JSON doesn't see (non-enumerable,
 *  or keyed by a symbol: a structured clone drops it too). `undefined` as an
 *  object's value passes (JSON leaves the key out, as an absent one), and so
 *  does a property hung on an array (`moves.turn = …`: JSON leaves it out
 *  too, and finding it took a list of every index: 4 to 24 times the cost
 *  of the JSON itself, on every job, D153); functions and symbols pass
 *  with `uncloned` (t.data and t.public, when a Worker posts them: one it
 *  can't post at all fails as D129 says, keeping the JSON part). A getter is
 *  read as its value, as JSON and a clone read it (one whose value moves
 *  outside a hook is guard()'s). Run on a value JSON.stringify took, so it
 *  has no cycle. The gates run it on every job (valueProblem), so the walk
 *  names the bad value's path only once it found one; it costs about one
 *  JSON.stringify of the value or less (in Node: 1.1–1.2 for arrays of
 *  numbers, 0.8 for records, 0.4 for a list of strings). */
export function notJSON(v, path, uncloned = false) {
  const trail = []; // the keys down to the value looked at (a number: an array index)
  const walk = (v, inArray) => {
    switch (typeof v) {
      case 'string': case 'boolean': return '';
      case 'undefined': return inArray ? 'is undefined, not JSON (JSON writes null)' : '';
      case 'number': return Number.isFinite(v) ? '' : `is ${v}, not JSON`;
      case 'function': case 'symbol': return uncloned ? '' : `is a ${typeof v}, not JSON`;
      case 'object': break;
      default: return `is a ${typeof v}, not JSON`;
    }
    if (v === null) return '';
    const arr = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (arr ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      return `is a ${String(proto?.constructor?.name || 'class instance').slice(0, 30)}, not JSON — keep it to plain objects, arrays, strings, numbers, true, false and null`;
    }
    if (arr) {
      for (let k = 0; k < v.length; k++) {
        trail.push(k);
        const why = k in v ? walk(v[k], true) : 'is a hole, not JSON (JSON writes null) — fill the array';
        if (why) return why;
        trail.pop();
      }
      return '';
    }
    const keys = Object.keys(v);
    if (Object.getOwnPropertyNames(v).length !== keys.length || Object.getOwnPropertySymbols(v).length) return "has a property JSON doesn't see (non-enumerable, or keyed by a symbol)";
    for (const k of keys) {
      trail.push(k);
      const why = walk(v[k], false);
      if (why) return why;
      trail.pop();
    }
    return '';
  };
  const why = walk(v, false);
  return why && `${path}${trail.map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k.slice(0, 30))}]`)).join('')} ${why}`;
}
/** Why `v` can't be player p's t.secret entry ('' when it can): p must be a
 *  player id (PID_RE: never "__proto__"), v plain JSON (notJSON) of at most
 *  SECRET_MAX_CHARS. */
function secretProblem(p, v) {
  if (!PID_RE.test(p)) return `t.secret: ${JSON.stringify(p.slice(0, 30))} is not a player id`;
  let j;
  try { j = JSON.stringify(v); } catch (err) { return `t.secret[${p}] is not JSON (${err.message})`; }
  if (j === undefined) return notJSON(v, `t.secret[${p}]`) || `t.secret[${p}] is not JSON`;
  if (j.length > SECRET_MAX_CHARS) return `t.secret[${p}] is too large (${j.length.toLocaleString('en-US')} chars, max ${SECRET_MAX_CHARS.toLocaleString('en-US')})`;
  return notJSON(v, `t.secret[${p}]`);
}
/** Why hints `h` (rules.hints: {pid: {items, spaces}}) are not the engine's
 *  shape (t.hint's: those two lists of short strings, nothing else — a hint
 *  is sent whole to its player), or '' — a rules Worker's patch is checked with it. */
function hintsProblem(h) {
  if (!isObj(h)) return 'the hints are not a map';
  const strs = (l) => Array.isArray(l) && l.every((s) => typeof s === 'string' && s.length <= 100);
  for (const [p, x] of Object.entries(h)) {
    if (!PID_RE.test(p) || !isObj(x) || Object.keys(x).some((k) => k !== 'items' && k !== 'spaces') || !strs(x.items ?? []) || !strs(x.spaces ?? [])
      || (x.items?.length || 0) + (x.spaces?.length || 0) > HINT_MAX) return `the hint of ${JSON.stringify(p.slice(0, 30))} is malformed`;
  }
  return '';
}
/** Asks `asks` (rules.asks: {pid: Ask[]}) as the engine's gate leaves them:
 *  player ids as keys, at most ASK_MAX each, one id once, each through
 *  cleanAsk (normalized: copies, options as {label, value}) — or a
 *  TypeError saying what is wrong. */
function cleanAsks(asks) {
  if (!isObj(asks)) throw new TypeError('the asks are not a map');
  const out = {};
  for (const [p, list] of Object.entries(asks)) {
    if (!PID_RE.test(p) || !Array.isArray(list) || list.length > ASK_MAX) throw new TypeError(`the asks of ${JSON.stringify(p.slice(0, 20))}: a list of at most ${ASK_MAX}`);
    out[p] = list.map(cleanAsk);
    if (new Set(out[p].map((x) => x.id)).size < list.length) throw new TypeError(`the asks of ${p}: an id twice`);
  }
  return out;
}
/** Why asks `asks` fail the engine's gate (cleanAsks), or ''. */
function asksProblem(asks) {
  try { cleanAsks(asks); } catch (err) { return err.message; }
  return '';
}
/** An object with no prototype holding o's own entries: t.secret is one, so
 *  `t.secret['__proto__'] = …` makes a key the gate refuses instead of
 *  quietly changing what the object inherits. */
const nullProto = (o) => Object.assign(Object.create(null), isObj(o) ? o : {});
/** The engine-state gates on a loaded rules state `r` (a save, an import:
 *  spec §3a, §3h), in place: the hints go (never kept) — unless `live`: a
 *  rules Worker's mirror of the host's running state, which must start equal
 *  to it, hints and all (§3f.3) — every ask passes cleanAsk (≤ ASK_MAX per
 *  player, one id once), every t.secret entry secretProblem, and
 *  data._timers gateTimers. A bad entry is dropped with console.error: a
 *  hand-edited or corrupted save can't plant engine state. */
export function gateRules(r, live = false) {
  if (!isObj(r)) return;
  if (!live) delete r.hints;
  gateTimers(r);
  const sec = nullProto(null);
  for (const [p, v] of Object.entries(isObj(r.secret) ? r.secret : {})) {
    const why = secretProblem(p, v);
    if (why) console.error(`saved rules: ${why} — dropped`);
    else sec[p] = v;
  }
  r.secret = sec;
  const asks = {};
  for (const [p, list] of Object.entries(isObj(r.asks) ? r.asks : {})) {
    if (!PID_RE.test(p) || !Array.isArray(list)) { console.error(`saved rules: the asks of ${JSON.stringify(p.slice(0, 30))} are not a player's list — dropped`); continue; }
    const kept = [];
    for (const x of list) {
      try {
        const a = cleanAsk(x);
        if (kept.length >= ASK_MAX || kept.some((y) => y.id === a.id)) throw new TypeError(kept.length >= ASK_MAX ? `more than ${ASK_MAX} asks` : `id ${a.id} twice`);
        kept.push(a);
      } catch (err) { console.error(`saved rules: an ask for ${p} dropped`, err); }
    }
    if (kept.length) asks[p] = kept;
  }
  r.asks = asks;
}
/** A deep copy of `a` (an action: JSON), frozen all the way down — what
 *  hooks get, so a script can never change the action core goes on to apply. */
function frozen(a) {
  const freeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const x of Object.values(o)) freeze(x); } return o; };
  return freeze(JSON.parse(JSON.stringify(a)));
}

/** The rules runner a table drives its hooks through (env.hooks): a
 *  SYNCHRONOUS, same-thread interface (tests inject their own to reach the
 *  script). A rules Worker (spec §3f) runs a whole createTable() on a mirror
 *  of the state with this runner inside, evaluating the script there; the
 *  host's own table then gets a runner that only answers has() and flag()
 *  for the rules view (`wants`, `strict`).
 *    load(code)       evaluates and installs a script, returns its name; throws
 *                     (the running script stays) if it doesn't evaluate to an object
 *    has(hook)        whether the installed script defines that hook
 *    flag(name)       one of the script's own properties (`strict`, `allow`), as it is
 *    call(hook, t, ...) runs it (as a method: `this` is the script) with the
 *                     facade t and returns its result; throws whatever the script throws
 *    stray()          (optional) the facade call made outside a hook since the
 *                     last asking, as a message, then '' — see below
 *  This one hands the script a LIVE facade: `t`'s methods work only while
 *  one of its hooks runs. A call from anywhere else — an `async` hook's
 *  continuation, a promise callback — throws "t.say was called outside a
 *  hook — rules hooks must be synchronous", and is remembered for stray():
 *  the table then disables the rules (spec §3f.7). `globals`: what the code
 *  sees as setTimeout and friends (a Worker passes throwing stubs). */
export function scriptHooks(globals = {}) {
  let script = null, depth = 0, stray = '', live = null, of = null;
  /** t's live copy: its methods guarded, its getters (data, public, secret) as they are. */
  function guarded(t) {
    if (of === t) return live;
    const g = {};
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(t))) {
      if (typeof d.value !== 'function') { Object.defineProperty(g, k, d); continue; }
      g[k] = function (...args) {
        if (!depth) { stray ||= `t.${k} was called outside a hook — rules hooks must be synchronous`; throw new Error(stray); }
        return d.value.apply(g, args);
      };
    }
    [of, live] = [t, g];
    return g;
  }
  return {
    load(code) {
      // The code sits on its own lines so a trailing // comment can't swallow the ")".
      const names = Object.keys(globals);
      const s = new Function(...names, `"use strict"; return (\n${code}\n);`)(...names.map((k) => globals[k]));
      if (!s || typeof s !== 'object') throw new Error('script must evaluate to an ({...}) object');
      const name = String(s.name || 'Rules').slice(0, 40);
      script = s;
      return name;
    },
    has: (hook) => typeof script?.[hook] === 'function',
    flag: (k) => script?.[k],
    call(hook, t, ...args) {
      depth++;
      try { return script[hook](guarded(t), ...args); } finally { depth--; }
    },
    stray() { const s = stray; stray = ''; return s; },
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
 *  how many it holds, never what; a piece on a board shows its address `at`
 *  (a position is public, a hidden piece's too: spec §3d), in the display
 *  form `disp(at)` gives (displayAddr). Everyone renders this one shape, the
 *  host included; only host LOGIC reads host.items. `boxes`: the box map. */
export function pubItem(it, boxes, disp = (q) => q) {
  if (it.k === 'p') {
    const { cards, ...rest } = it, top = cards.at(-1);
    return { ...rest, n: cards.length, top: top && pubTop(top, boxes) };
  }
  if (it.k === 'b') { const { of, ...rest } = it; return { ...rest, n: of.length }; } // (its `box` is public: it names the box whose setup made it, never what it holds)
  if (it.k === 'g' || it.k === 's') {
    const o = it.up === false ? { k: it.k, b: backRef(boxes, it.t) } : { k: it.k, t: it.t, f: it.f };
    Object.assign(o, { x: it.x, y: it.y, rot: it.rot, z: it.z });
    if (it.n > 1) o.n = it.n;
    if (it.owner) o.owner = it.owner;
    if (it.lock) o.lock = true;
    if (it.k === 'g' && typeof it.at === 'string') o.at = disp(it.at);
    return o;
  }
  const { i, ...rest } = it;
  return it.up ? { ...rest, i } : rest;
}
/** Why `m` isn't a pile member, a bag member or a hand entry — a card {d,
 *  i} or a piece {t, f?} — or ''. */
const memberProblem = (m) => (!isObj(m) ? 'not a card or a piece'
  : typeof m.d === 'string' ? (Number.isInteger(m.i) ? '' : 'a card without its index')
    : typeof m.t === 'string' && (m.f === undefined || Number.isInteger(m.f)) ? '' : 'neither a card nor a piece');
/** Why `it` isn't shaped like a host item, or '': what the indexes, the
 *  public view (pubItem) and a reload read of it — a known kind; x, y, rot
 *  and z finite (how high is the load's and the patch's: Z_MAX); a pile's
 *  cards (≤ MAX_PILE) and a bag's members (≤ MAX_BAG) cards or pieces
 *  (memberProblem); a card's deck and index; a piece's or a supply's type;
 *  owner and name text (an address is the load's at gate's — it drops a bad
 *  one, keeping the item — and the patch's: checkPatch). A rules Worker's
 *  patch is checked with it (applyStatePatch), and so is every saved item
 *  on load (createTable). */
function itemProblem(it) {
  if (!isObj(it) || !['c', 'p', 'g', 's', 'b'].includes(it.k)) return 'not an item';
  if (!['x', 'y', 'rot', 'z'].every((k) => Number.isFinite(it[k]))) return 'x, y, rot and z must be numbers';
  const list = it.k === 'p' ? it.cards : it.k === 'b' ? it.of : null;
  if (list !== null) {
    if (!Array.isArray(list) || list.length > (it.k === 'p' ? MAX_PILE : MAX_BAG)) return it.k === 'p' ? 'a pile without its cards' : 'a bag without its pieces';
    const why = list.map(memberProblem).find(Boolean);
    if (why) return `${it.k === 'p' ? 'a card of the pile' : 'a member of the bag'}: ${why}`;
  } else if (it.k === 'c' ? typeof it.d !== 'string' || !Number.isInteger(it.i) : typeof it.t !== 'string') return it.k === 'c' ? 'a card without its deck and index' : 'a piece without its type';
  const text = ['owner', 'name'].find((k) => it[k] !== undefined && typeof it[k] !== 'string');
  return text ? `its ${text} is not text` : '';
}
/** Why `pl` isn't shaped like a player record, or '': what the public view
 *  (pubPlayer), the log and a reload read of it — a name, a colour (COLOR_RE:
 *  it goes into the page's styles), online true or false, a hand of at most
 *  MAX_HAND cards or pieces, a seat angle (or null: a watcher) and a named
 *  seat's id. A rules Worker's patch is checked with it, and so is every
 *  saved player on load (an old save's player may lack a colour, or online:
 *  a resume sets that). */
function playerProblem(pl) {
  if (!isObj(pl)) return 'not a player';
  if (typeof pl.name !== 'string') return 'its name is not text';
  if (pl.color !== undefined && !(typeof pl.color === 'string' && COLOR_RE.test(pl.color))) return 'its colour is not one';
  if (pl.online !== undefined && typeof pl.online !== 'boolean') return 'online is not true or false';
  if (!Array.isArray(pl.hand) || pl.hand.length > MAX_HAND) return 'a player without a hand';
  const why = pl.hand.map(memberProblem).find(Boolean);
  if (why) return `a card of the hand: ${why}`;
  if (!(pl.seat == null || Number.isFinite(pl.seat)) || !(pl.seatId === undefined || isId(pl.seatId))) return 'a seat that is not one';
  return '';
}
/** The longest log line, notice or banner the engine writes (logEvent, notify, announce: longer is cut). */
export const LOG_TXT_MAX = 1000;
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
  /** v3 → v4 (Phase 3): the rules' per-player state (asks and secrets:
   *  empty; hints are never saved), their timers through the engine gate
   *  (gateTimers), and each piece's address read off the boards it lies on,
   *  by containment alone (nothing moves). */
  3(s) {
    if (isObj(s.rules)) {
      s.rules.secret ||= {};
      s.rules.asks ||= {};
      delete s.rules.hints;
      gateTimers(s.rules);
    }
    try {
      const items = isObj(s.items) ? s.items : {}, boxes = isObj(s.boxes) ? s.boxes : {}, TB = tableBoards(Object.entries(items), boxes);
      for (const [id, it] of Object.entries(items)) {
        if (!isObj(it)) continue;
        if (!snaps(it, boxes)) { dropAt(id, it); continue; }
        const { w, h } = sizeOf(it, boxes), spot = snapAt(TB, num(it.x) + w / 2, num(it.y) + h / 2);
        if (spot) it.at = spot.at;
        else delete it.at;
      }
    } catch (err) { console.error('MIGRATE[3]: the pieces\' addresses could not be read off their boards', err); }
    s.v = 4;
    return s;
  },
  /** v4 → v5 (Phase 4): nothing to rewrite. `lastSetup` stays, and
   *  `rules.box` stays absent (a Reset after the upgrade sets the box up
   *  without re-enabling rules); every box record carries its `src` since
   *  Phase 2, and "built in" is read from content, never stored. */
  4(s) {
    s.v = 5;
    return s;
  },
};
/** Takes the address off item `id` (`it`), which never snaps (a card, a
 *  supply, a board, a die…: snaps), loudly — a hand-edited or corrupted save
 *  can't plant one (spec §3h). */
function dropAt(id, it) {
  if (!('at' in it)) return;
  console.error(`item ${id}: an address on an item that never snaps (${String(JSON.stringify(it.at)).slice(0, 40)}) — dropped`);
  delete it.at;
}
/** The most timers t.schedule keeps (rules.data._timers), and the longest tag. */
export const MAX_TIMERS = 1000, TIMER_TAG_MAX = 100;
/** The engine-state gate on rules.data._timers (spec §3a), run on every save
 *  load and by t.schedule: a list of at most MAX_TIMERS {at: a finite
 *  number, tag: a string of at most TIMER_TAG_MAX chars}; anything else is
 *  dropped with console.error (a list that isn't one, whole). In place, on
 *  rules `r`. */
export function gateTimers(r) {
  const t = isObj(r?.data) ? r.data._timers : undefined;
  if (t === undefined) return;
  if (!Array.isArray(t)) {
    console.error('rules.data._timers is not a list: dropped', t);
    delete r.data._timers;
    return;
  }
  const kept = t.filter((x) => isObj(x) && Number.isFinite(x.at) && typeof x.tag === 'string' && x.tag.length <= TIMER_TAG_MAX).map(({ at, tag }) => ({ at, tag }));
  if (kept.length < t.length) console.error(`rules.data._timers: dropped ${t.length - kept.length} malformed ${t.length - kept.length === 1 ? 'timer' : 'timers'}`);
  if (kept.length > MAX_TIMERS) console.error(`rules.data._timers: dropped ${kept.length - MAX_TIMERS} timers past ${MAX_TIMERS}`);
  r.data._timers = kept.slice(0, MAX_TIMERS);
}
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
// hand?, ask?, hint?, sec?} (T.mine). The shared part is serialized once per
// broadcast tick and each recipient's body is spliced from it as text.
/** The fields a body carries for its recipient alone (spliceBody's `mine`). */
const OWN_FIELDS = ['to', 'tp', 'base', 'hand', 'ask', 'hint', 'sec'];
/** A tick's shared part as JSON text. It never holds a recipient's own field:
 *  JSON.parse keeps the last of two equal keys, so a shared `to` or `tp` would
 *  silently override the binding spliceBody puts first. */
export function sharedText(o) {
  const bad = OWN_FIELDS.find((k) => k in o);
  if (bad) throw new Error(`a shared body part may not carry "${bad}"`);
  return JSON.stringify(o);
}
/** A broadcast tick's action markers `fx`, less the live drags (spec §3c)
 *  that a commit in the same tick overtook — an item the tick's patch
 *  carries (dirty `d`: changed or removed) shows where it now is, never a
 *  stale glide — and, of one item's live drags, all but the last. */
export function liveFx(fx, d) {
  const gone = (id) => d.items.has(id) || d.removed.has(id), last = new Map();
  fx.forEach((f, k) => { if (f.live && f.id) last.set(f.id, k); });
  return fx.flatMap((f, k) => {
    if (!f.live) return [f];
    if (f.id) return gone(f.id) || last.get(f.id) !== k ? [] : [f];
    const ids = f.ids.filter((id) => !gone(id));
    return ids.length ? [{ ...f, ids }] : [];
  });
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
// players, log, hand, ask, hint, sec}. items and players are null-prototype
// maps: an id from the wire is only ever a key, never Object.prototype (a
// legacy unsigned room can send anything). ask, hint and sec are this
// player's own (spec §3b): its pending asks ([] for none), its hint
// ({items, spaces} or null) and its t.secret entry (JSON, or null).
const dict = (o) => Object.assign(Object.create(null), o && typeof o === 'object' && !Array.isArray(o) ? o : {});
const entries = (l) => (Array.isArray(l) ? l.filter((e) => e && typeof e === 'object') : []);
const texts = (l) => (Array.isArray(l) ? l.filter((s) => typeof s === 'string') : []);
/** A hint from the wire: {items, spaces} (strings only), or null. */
const viewHint = (h) => (isObj(h) ? { items: texts(h.items), spaces: texts(h.spaces) } : null);
/** An ask from the wire, shaped as the host sends one (cleanAsk's, its
 *  options as their labels): {id, prompt, options} or {id, prompt, pick,
 *  among?, count?, min?, max?} — else null, dropped loudly: the ask panel
 *  and the terminal show only what passes. */
function viewAsk(q) {
  const strs = (l, max) => Array.isArray(l) && l.length <= max && l.every((s) => typeof s === 'string');
  const { id, prompt, options, pick, among, count, min, max } = isObj(q) ? q : {};
  const named = pick === 'item' || pick === 'space';
  const ok = isId(id) && typeof prompt === 'string' && (options !== undefined
    ? pick === undefined && strs(options, ASK_OPTIONS) && options.length > 0
    : ASK_PICKS.includes(pick) && (named ? strs(among, ASK_AMONG) : among === undefined)
      && (count === undefined || (pick === 'hand' && Number.isInteger(count) && count >= 1))
      && (pick === 'number' ? Number.isInteger(min) && Number.isInteger(max) && min <= max : min === undefined && max === undefined));
  if (!ok) { console.error('dropped a malformed ask from the host', q); return null; }
  return options ? { id, prompt, options: [...options] } : { id, prompt, pick, ...(named && { among: [...among] }), ...(count !== undefined && { count }), ...(pick === 'number' && { min, max }) };
}
/** This player's asks from the wire (viewAsk's, the malformed dropped). */
const viewAsks = (l) => entries(l).map(viewAsk).filter(Boolean);
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
    ask: viewAsks(d.ask), hint: viewHint(d.hint), sec: d.sec ?? null,
  };
}
/** Folds a patch body into view V, in place: items and players are replaced
 *  whole, `del` removed, log entries appended (then trimmed), the hand, the
 *  asks, the hint, the secret, the table, the seats and `handy` replaced when
 *  present. Returns what it replaced, for the renderer: {items: Map<id, old
 *  public item | undefined (new)>, players: Map<pid, old | undefined>}. */
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
  if ('ask' in d) V.ask = viewAsks(d.ask);
  if ('hint' in d) V.hint = viewHint(d.hint);
  if ('sec' in d) V.sec = d.sec ?? null;
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

// --- the table ---------------------------------------------------------------
// decks:  {deckId: Deck v2 (cleanDeck): {name, back, backImg?, imgs: [asset id], cards: [{r,s,c} | {g?, n?, txt?, …}]}}
// boxes:  {boxId: Box (cleanBox)}; boxSrc: {boxId: {src: 'host' | 'upload' | 'script', by?: pid}} (host-written, never read from a box)
// items:  {itemId: card {k:'c',x,y,rot,z,d,i,up} | pile {k:'p',…,name,cards:[{d,i,up} | {t,f,up}]}
//          | piece {k:'g',…,t,f,up?:false,n?} | supply {k:'s',…,t,f,up?:false}
//          | bag {k:'b',…,of:[{t,f,up?}],name,color?,hand?,box? (the box whose setup made it: who may lock it; public, D88)}},
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
  gateRules(host.rules, env.mirror); // (every load: a hand-edited save can't plant an ask, a secret or a timer)
  // Every load: an item or a player the table can't show or save again is
  // dropped, loudly — one bad record must never keep the table from
  // starting; resume() tells the host how many (D151).
  const unread = { item: 0, player: 0 };
  for (const [what, map, problem] of [['item', host.items, itemProblem], ['player', host.players, playerProblem]]) {
    for (const [id, v] of Object.entries(map)) {
      const why = problem(v);
      if (why) { console.error(`the saved ${what} ${id.slice(0, 30)} is unreadable (${why}): dropped`); delete map[id]; unread[what]++; }
    }
  }
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
  const cut = (s) => String(s).slice(0, LOG_TXT_MAX); // (a line, a notice or a toast: never longer)

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
    asks: new Set(),    // the players whose own parts changed (spec §3b): their asks,
    hints: new Set(),   // their hint,
    secret: new Set(),  // their t.secret entry (all three found by comparison, in takeDirty)
  });
  let dirty = newDirty();
  let J = null;          // the open journal (see begin)
  let restoring = false; // a rollback is putting things back: its writes record nothing
  let lastJSON = null;   // the rules' state as the last commit left it (rulesJSON), for guard()
  let carried = null;    // the rules' fields the last commit's patch carries (guard(), once: see there)
  let guardJSON = null;  // …as guard() just found it unchanged: the next begin() starts from it
  let partsVer = 0;      // bumped by whatever may change a player's own parts (asks, hints, secret): see takeDirty
  let wantPatch = false, lastPatch = null, jobError = null; // T.job: build the StatePatch; the job's patch; its hook failure
  const pub = new Map();   // T.pub: id → public item, refreshed lazily for the ids in `stale`
  const stale = new Set(Object.keys(host.items));
  const handy = new Set(); // the ids of items one could hold in a hand (T.handy), kept with T.pub (refresh)
  let handySent;           // what the last takeDirty() saw of `handy.size > 0`
  /** T.byKind: 'c' (cards), 'p' (piles), 'g' (pieces), 's' (supplies), 'b' (bags) → their ids;
   *  T.byType: a type ref → the pieces and supplies of that type; T.byOwner: an owner → its items;
   *  T.byAt: a qualified address → the pieces there; T.byZone: '<board id>:<zone id>' → the
   *  pieces in that zone (a piece's zones: zonesOf). boardIds: every board (the z band below 0). */
  const byKind = new Map(['c', 'p', 'g', 's', 'b'].map((k) => [k, new Set()]));
  const byType = new Map(), byOwner = new Map(), byAt = new Map(), byZone = new Map(), zonesOf = new Map(), boardIds = new Set();
  let tbVer = 0; // bumped by whatever may change a board (see tb())
  let boardsMoving = false; // a board was touched this tick: it may still change after a read (see tb())
  let spotsReady = false; // (while the saved items are first indexed, zones wait for every board: see below)
  /** Puts `id` in (on) or out of map's set under `key`, which goes when empty. */
  function inSet(map, key, id, on) {
    const set = map.get(key) || (on ? map.set(key, new Set()).get(key) : null);
    set?.[on ? 'add' : 'delete'](id);
    if (set && !set.size) map.delete(key);
  }
  /** Adds item `id` to the indexes (on) or takes it out. A piece's zones are
   *  read where it lies when it goes in (zonesUnder), and kept until it goes
   *  out: an item moved in place goes out first (place's `o.id`, or a
   *  recount by syncSpots). */
  function index(id, it, on) {
    byKind.get(it.k)?.[on ? 'add' : 'delete'](id);
    if ((it.k === 'g' || it.k === 's') && it.t) inSet(byType, it.t, id, on);
    if (it.owner) inSet(byOwner, it.owner, id, on);
    if (it.k !== 'g') return;
    if (it.z < 0) { boardIds[on ? 'add' : 'delete'](id); tbVer++; return; }
    if (it.at) inSet(byAt, it.at, id, on);
    if (!on) {
      for (const z of zonesOf.get(id) || []) inSet(byZone, z, id, false);
      zonesOf.delete(id);
    } else if (spotsReady) {
      const { w, h } = size(it), zs = zonesUnder(tb(), it.x + w / 2, it.y + h / 2, it.at?.slice(0, it.at.indexOf(':')));
      zonesOf.set(id, zs);
      for (const z of zs) inSet(byZone, z, id, true);
    }
  }
  for (const [id, it] of Object.entries(host.items)) index(id, it, true);
  const itemCount = () => { let n = 0; for (const s of byKind.values()) n += s.size; return n; };

  // --- what an item is: its type, flags, size and label (see the helpers above) ---
  const typeOf = (t) => typeAt(host.boxes, t);
  /** Whether item `it` is a board — read from its type even when it is
   *  hidden, which tells nothing: a back never hides both a board and
   *  another piece (cleanBox), so its users are all boards or none. */
  const isBoard = (it) => it.k === 'g' && typeOf(it.t)?.kind === 'board';
  const flags = (it) => flagsOf(it, host.boxes);
  const size = (it) => sizeOf(it, host.boxes);
  const label = (it) => itemLabel(it, host.decks, host.boxes);
  /** What the log calls ONE piece {t, f, up} (no " ×N"). */
  const oneLabel = (m) => (m.up === false ? 'a hidden piece' : pieceName(host.boxes, m.t, m.f));
  /** A pile's members are cards or pieces: what to count them in. */
  const unit = (pile) => (pile.cards.length && !isCard(pile.cards[0]) ? 'pieces' : 'cards');
  /** Item `it`'s rotation `rot`, snapped to its rotation step (flagsOf: a
   *  piece's, a supply's, a piece pile's top's — the back's when hidden;
   *  cards and bags turn freely). */
  const turned = (it, rot) => snapRot(rot, flags(it).rotStep);
  /** Whether a piece of type `t` must lie face up: its type is known and has
   *  no back. A piece whose box is missing keeps the side it had — a failure
   *  never turns a hidden piece face up (spec §2d). */
  const mustShow = (t) => { const ty = typeOf(t); return !!ty && !ty.back; };
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
  // change to a player through touchPlayer — each BEFORE the change, so the
  // journal records what was there (jot): what delta sync sends, and what a
  // rollback puts back, is exactly what was recorded here.
  /** Places item `it` under `id` (new, or replacing one); returns the id. */
  const put = (id, it) => {
    const old = own(host.items, id);
    jot(`i:${id}`, old);
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
    jot(`i:${id}`, it);
    index(id, it, false);
    delete host.items[id];
    dirty.items.delete(id);
    dirty.removed.add(id);
    stale.add(id);
  };
  /** Item `id` (`it`) now belongs to `to` (an owner; null: nobody), indexed. */
  function setOwner(id, it, to) {
    touch(id);
    index(id, it, false);
    if (to) it.owner = to;
    else delete it.owner;
    index(id, it, true);
  }
  /** Item `id` is about to change in place (moved, turned, flipped, its pile
   *  changed) — or is re-sent unchanged (a refusal). Ids not on the table are
   *  ignored; true when it is on the table. */
  const touch = (id) => {
    const it = own(host.items, id);
    if (!it) return false;
    jot(`i:${id}`, it);
    if (boardIds.has(id)) { tbVer++; boardsMoving = true; } // (a board about to change: tb() reads the boards again)
    dirty.items.add(id);
    stale.add(id);
    return true;
  };
  /** Item `id` is re-sent unchanged (a refusal's touch: spec §1c), or false
   *  when it isn't on the table. */
  const refreshItem = (id) => {
    if (!own(host.items, id)) return false;
    dirty.items.add(id);
    stale.add(id);
    J?.refresh.add(id);
    return true;
  };
  /** Player p is about to change (anything publicPlayers shows); `hand`: their hand too. */
  const touchPlayer = (p, o = {}) => {
    jot(`p:${p}`, own(host.players, p));
    dirty.players.add(p);
    if (o.hand) dirty.hands.add(p);
  };
  /** Player p's hand is re-sent unchanged (a refusal's touch). */
  const refreshHand = (p) => {
    dirty.players.add(p);
    dirty.hands.add(p);
    J?.refreshHands.add(p);
  };
  /** A deck (`d:`) or box (`b:`) is about to join the catalog (catalog entries never change). */
  const toCatalog = (k) => jot(k, undefined);
  /** Deck `deck` joins the catalog as `id`. */
  const addDeckTo = (id, deck) => { toCatalog(`d:${id}`); host.decks[id] = deck; };

  // --- the journal (spec §3f.4): what a job changed, to undo it or to ship it ---
  // A job (an action, internal ones included) that may run rules hooks runs
  // inside a journal. begin() opens it; every write records, the first time
  // it touches an item, a player, a deck or a box, its PRE-IMAGE (jot); and
  // each savepoint keeps the rules' state (data, public, asks, secret, hints)
  // as JSON, with the table, the seats, the counters, the log and the
  // effects queued so far. rollbackTo(token) puts back everything written
  // since that savepoint (0: since begin), so a vetoed or failed hook leaves
  // nothing behind; commit() closes the journal and returns the StatePatch of
  // what the job changed (spec §3f.2) — what a rules Worker sends the host.
  // The cost is O(touched + |rules' state|) per job. Not journaled: the
  // script object's own properties (`this`). A pull's pending draws
  // (drawFrom) are half journaled: a rollback puts back the ones a pull
  // took since, and keeps the ones drawn since (D114, D135: a veto never
  // redraws, even of a pull a script's handle() made itself).
  const ABSENT = Symbol('absent'); // the pre-image of something that wasn't there
  const clone = (v) => JSON.parse(JSON.stringify(v));
  /** Records under key k ('i:<id>', 'p:<pid>', 'd:<deck id>', 'b:<box id>')
   *  the pre-image of `cur` (undefined or null: not there yet), the first
   *  time the journal's current frame touches it. */
  function jot(k, cur) {
    if (!J || restoring) return;
    const f = J.frames.at(-1);
    if (f.pre.has(k)) return;
    f.pre.set(k, cur == null ? ABSENT : clone(cur));
    if (!J.first.has(k)) J.first.set(k, J.frames.length - 1);
  }
  /** The rules' state as JSON, by field (RULES_STATE), or null (no rules).
   *  Throws when a field isn't JSON (a cycle, a BigInt). */
  const rulesJSON = () => (host.rules ? Object.fromEntries(RULES_STATE.map((k) => [k, JSON.stringify(host.rules[k] ?? {}) ?? '{}'])) : null);
  /** A journal frame: what a savepoint restores (`json`: rulesJSON() taken already). */
  function frame(json = rulesJSON()) {
    return {
      pre: new Map(), json, rules: host.rules && { ...host.rules },
      table: host.table, seats: host.seats, zMax: host.zMax, boardSeq: host.boardSeq, guestDeckChars: host.guestDeckChars, lastSetup: host.lastSetup,
      log: null, dirtyLog: dirty.log.length, effects: effects.length, runs: runs.slice(), marks, draws, hooks: jobHooks.length,
      spots: [spotTB, spotSig, respot], taken: [],
    };
  }
  /** Opens the journal (`json`: the rules' state as JSON, when just taken). */
  function begin(json) {
    if (J) throw new Error('begin: a journal is open already');
    const f = frame(json ?? undefined); // (first: a state that isn't JSON throws here, and no journal is open)
    J = { frames: [f], first: new Map(), refresh: new Set(), refreshHands: new Set(), log0: dirty.log.length, cp: 0 };
  }
  /** A savepoint in the open journal: its token, for rollbackTo. */
  function savepoint() {
    J.frames.push(frame());
    return J.frames.length - 1;
  }
  /** Undoes every write since savepoint `token` (0: since begin), newest
   *  first; the journal stays open, at that savepoint. */
  function rollbackTo(token) {
    restoring = true;
    try {
      for (let k = J.frames.length - 1; k >= token; k--) restore(J.frames[k]);
    } finally { restoring = false; }
    J.frames.length = token + 1;
    Object.assign(J.frames[token], { pre: new Map(), log: null, taken: [] });
    for (const [k, at] of J.first) if (at >= token) J.first.delete(k);
    partsVer++;
  }
  /** Puts back what frame f recorded: the catalog first, then the boards
   *  (the pieces' zones are read against them as they go back), the other
   *  items, the players, then the rules, the table, the counters, the log,
   *  the effects, and the boards every piece's address was read against. */
  function restore(f) {
    const board = ([k, v]) => k[0] === 'i' && ((v !== ABSENT && v.z < 0) || own(host.items, k.slice(2))?.z < 0);
    const all = [...f.pre].reverse(), items = all.filter(([k]) => k[0] === 'i');
    for (const [k, v] of [...all.filter(([k]) => k[0] === 'd' || k[0] === 'b'), ...items.filter(board), ...items.filter((e) => !board(e)), ...all.filter(([k]) => k[0] === 'p')]) {
      const id = k.slice(2);
      if (k[0] === 'i') { if (v === ABSENT) remove(id); else put(id, v); } else if (k[0] === 'p') {
        if (v === ABSENT) delete host.players[id];
        else host.players[id] = v;
        touchPlayer(id, { hand: true });
      } else if (k[0] === 'd') delete host.decks[id];
      else { delete host.boxes[id]; delete host.boxSrc[id]; boxIndex = null; tbVer++; }
    }
    if (host.table !== f.table) dirty.table = true;
    if (host.seats !== f.seats) dirty.seats = true;
    for (const k of ['table', 'seats', 'zMax', 'boardSeq', 'guestDeckChars', 'lastSetup']) {
      if (f[k] === undefined) delete host[k];
      else host[k] = f[k];
    }
    if (!f.rules) delete host.rules;
    else host.rules = { ...f.rules, ...Object.fromEntries(RULES_STATE.map((k) => [k, JSON.parse(f.json[k])])), secret: nullProto(JSON.parse(f.json.secret)) };
    if (f.log) host.log = f.log;
    dirty.log.length = f.dirtyLog;
    effects.length = f.effects;
    runs = f.runs.slice();
    [marks, draws] = [f.marks, f.draws];
    [spotTB, spotSig, respot] = f.spots;
    for (const [id, d] of f.taken.reverse()) drawn.set(id, d); // (a pull undone leaves the member it took pending — the first, if several: D135)
    tbSig = null; // (the boards are read again)
    tbVer++;
  }
  /** Closes the journal; `json`: the rules' state as JSON now, when just
   *  taken. With `build`, returns the job's StatePatch (spec §3f.2): every
   *  item, player, deck and box it wrote, as they now are (an item null:
   *  removed; items in sorted-id order), the rules' fields that changed, the
   *  table and the seats if set, the counters that moved, the log lines it
   *  appended (at most LOG_CAPS of each bucket: the newest), and what it
   *  re-sent unchanged (refresh, refreshHands). The
   *  patch holds the table's own objects: post it (a structured clone) or
   *  copy it before applying it to another table. */
  function commit(build = true, json = rulesJSON()) {
    const j = J, f0 = j.frames[0];
    J = null;
    lastJSON = json;
    const r = host.rules;
    if (!r !== !f0.rules || (r && (r.enabled !== f0.rules.enabled || ['asks', 'secret', 'hints'].some((k) => json[k] !== f0.json[k])))) partsVer++;
    carried = null;
    if (!build) return null;
    const P = {};
    for (const k of [...j.first.keys()].sort()) {
      const id = k.slice(2), into = (f, v) => { (P[f] ||= {})[id] = v; };
      if (k[0] === 'i') into('items', own(host.items, id) || null);
      else if (k[0] === 'p') { if (own(host.players, id)) into('players', host.players[id]); } else if (k[0] === 'd') { if (own(host.decks, id)) into('decks', host.decks[id]); } else if (own(host.boxes, id)) into('boxes', { box: host.boxes[id], ...host.boxSrc[id] });
    }
    if (r) {
      const rp = {};
      for (const k of Object.keys(r)) if (RULES_STATE.includes(k) ? !f0.json || json[k] !== f0.json[k] : r[k] !== f0.rules?.[k]) rp[k] = r[k];
      if (f0.rules?.box !== undefined && r.box === undefined) rp.box = null; // (the box's rules replaced by others: rules.box goes)
      if (Object.keys(rp).length) P.rules = rp;
      carried = new Set(Object.keys(rp));
    }
    if (host.table !== f0.table) P.table = host.table;
    if (host.seats !== f0.seats) P.seats = host.seats;
    for (const k of ['zMax', 'boardSeq', 'guestDeckChars', 'lastSetup']) if (host[k] !== f0[k] && host[k] !== undefined) P[k] = host[k];
    if (dirty.log.length > j.log0) P.log = trimLog(dirty.log.slice(j.log0)); // (what the host would trim away need not travel)
    const refresh = [...j.refresh].filter((id) => !j.first.has(`i:${id}`) && own(host.items, id)).sort();
    const hands = [...j.refreshHands].filter((p) => !j.first.has(`p:${p}`) && own(host.players, p)).sort();
    if (refresh.length) P.refresh = refresh;
    if (hands.length) P.refreshHands = hands;
    return P;
  }
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
   *  its z when moved. Every op that places an item comes through here (spec
   *  §0.2), and a piece snaps (snapPiece): it is centred on the spot in reach
   *  and records its address (`at`), or loses it. `o.free`: no snapping;
   *  `o.at`: centred on that qualified address (already resolved), whatever
   *  lies on top of it; `o.id`: the item is on the table (moved in place), so
   *  its index entries follow it. */
  function place(it, x, y, o = {}) {
    if (o.id) index(o.id, it, false);
    let p;
    if (isPiece(it)) {
      p = snapPiece(it, x, y, o);
      if (p.at) it.at = p.at;
      else delete it.at;
    } else { const { w, h } = size(it); p = clampToTable(host.table, x, y, w, h); }
    ({ x: it.x, y: it.y } = p);
    if (!(it.z < 0)) it.z = isBoard(it) ? BOARD_Z0 + ++host.boardSeq : zTop();
    if (o.id) index(o.id, it, true);
  }
  /** Whether item `it` (host or new) is a piece that snaps (snaps: never a board or a die, D22, D112). */
  const isPiece = (it) => snaps(it, host.boxes);
  /** Where piece `it` (on the table or not: nothing changes) lands when put
   *  at top-left (x, y) (spec §3a, Snapping; snapTo): its centre, in its
   *  size (its back's when hidden), on the spot in reach of the topmost board
   *  under it — {x, y (the top-left that centres it there), at (the spot's
   *  qualified address)} — or, with no spot in reach, {x, y, at: null}, x and
   *  y clamped onto the table. `o` as for place: free, or a qualified `at`. */
  function snapPiece(it, x, y, o = {}) {
    const { w, h } = size(it);
    return snapTo(tb(), host.table, w, h, x, y, o);
  }
  /** Brings the cached public items (T.pub) and `handy` up to date: `handy`
   *  holds the items one could hold in a hand (spec §2a: cards, piles of
   *  cards, bags made for hands, pieces whose type — or back, when hidden —
   *  says so: flagsOf's `hand`). */
  function refresh() {
    syncSpots(); // (the addresses first: what they show is public)
    for (const id of stale) {
      const it = own(host.items, id);
      if (it) pub.set(id, pubItem(it, host.boxes, display));
      else pub.delete(id);
      if (it && flags(it).hand) handy.add(id);
      else handy.delete(id);
    }
    stale.clear();
  }

  // --- boards and addresses (spec §3a; the pure part is tableBoards & co. above) ---
  let tbSig = null, tbNow = null, tbAt = -1;
  /** The table's structured boards (tableBoards), read again whenever a
   *  board changed — its place, turn, side, type, or the set of boards: tbVer
   *  counts what may have changed one (a board indexed or touched, a box
   *  added), and the boards' signature tells whether it did. A board is
   *  touched BEFORE it changes, so in a tick that touched one the signature
   *  is taken at every read (a read between the touch and the change must
   *  not stand for the boards after it); takeDirty ends that. */
  function tb() {
    if (tbAt === tbVer && !boardsMoving) return tbNow;
    tbAt = tbVer;
    let sig = '';
    for (const id of boardIds) { const b = host.items[id]; sig += `${id} ${b.t} ${b.x} ${b.y} ${b.rot} ${b.z} ${b.up === false} ${!!typeOf(b.t)};`; }
    if (sig !== tbSig) { tbSig = sig; tbNow = tableBoards([...boardIds].map((id) => [id, host.items[id]]), host.boxes); }
    return tbNow;
  }
  let spotTB = null, spotSig = null; // the boards every piece's address and zones were last read against (and tb()'s signature then)
  let respot = false;  // pieces moved under the boards (a table resize): read them all again
  /** When a board changed (moved, turned, flipped, added or removed: anything
   *  tb() sees) or the pieces were shifted under them, reads the address and
   *  zones of every piece the change concerns again by containment — a piece
   *  whose centre lies on a spot in reach (snapAt, as snapping finds it) gets
   *  that address, any other loses its own — and MOVES
   *  NOTHING (spec §3a: a board move is a deliberate rearrangement, never a
   *  mass move). The pieces it concerns (D106, D113): those on a board that
   *  changed, where it was or where it is, or addressed on one; after a
   *  table resize, all. Any other keeps its address — an explicit one under
   *  a newer board too (D105), which a board turned across the table must
   *  not take away. A piece whose address changed, or only its display form
   *  (the primary board or a "#n" did), is re-sent. Run before anything
   *  reads an address or an index (addrNow, act, the reads of the facade,
   *  refresh). */
  function syncSpots() {
    const T = tb();
    if (tbSig === spotSig && !respot) return;
    const was = spotTB, all = respot, same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.rot === b.rot && a.z === b.z && a.B === b.B;
    const moved = [...was.list.filter((b) => !same(b, T.byId.get(b.id))), ...T.list.filter((b) => !same(b, was.byId.get(b.id)))];
    const movedIds = new Set(moved.map((b) => b.id));
    [spotTB, spotSig, respot] = [T, tbSig, false];
    for (const id of [...byKind.get('g')]) {
      const it = host.items[id];
      if (!isPiece(it)) continue;
      const before = it.at ? displayAddr(was, it.at) : null, { w, h } = size(it), cx = it.x + w / 2, cy = it.y + h / 2;
      if (all || (it.at && movedIds.has(it.at.slice(0, it.at.indexOf(':')))) || moved.some((b) => onBoard(b, cx, cy))) {
        const s = snapAt(T, cx, cy);
        jot(`i:${id}`, it); // (its address and zones change: a rollback puts them back)
        index(id, it, false);
        if (s) it.at = s.at;
        else delete it.at;
        index(id, it, true);
      }
      if (before !== (it.at ? displayAddr(T, it.at) : null)) touch(id);
    }
  }
  /** The display form of a qualified address or zone (displayAddr). */
  const display = (q) => displayAddr(tb(), q);
  /** Piece `it`'s address as anyone reads it — in its display form, the
   *  boards' changes caught up first (syncSpots) — or null. */
  const addrNow = (it) => { syncSpots(); return it.at ? display(it.at) : null; };
  /** Resolves address `s` (any form) for a script call `call`: {at, x, y,
   *  b, local}, or a TypeError naming the call — no such address, or one
   *  several boards could mean ("use 'tray#1:bar' or 'tray#2:bar'"). */
  function addrOf(call, s) {
    if (typeof s !== 'string') throw new TypeError(`${call}: an address must be a string, got ${JSON.stringify(s)}`);
    const r = resolveAddr(tb(), s);
    if (r?.ambiguous) throw new TypeError(`${call}: address '${s}' is ambiguous — use ${r.ambiguous.map((a) => `'${a}'`).join(r.ambiguous.length > 2 ? ', ' : ' or ').replace(/, ('[^']*')$/, ' or $1')}`);
    if (!r) throw new TypeError(`${call}: no such address '${s}' on the table's boards`);
    return r;
  }
  // The saved items' addresses (a v4 save's, or MIGRATE[3]'s by containment)
  // stand; one that names no spot on the table, or on an item that never
  // snaps, is dropped, loudly. Then the zones.
  spotsReady = true;
  spotTB = tb();
  spotSig = tbSig;
  for (const [id, it] of Object.entries(host.items)) {
    if (it.k === 'g') index(id, it, false);
    if (!isPiece(it)) dropAt(id, it);
    else if (it.at !== undefined && resolveAddr(spotTB, it.at)?.at !== it.at) { console.error(`item ${id}: its saved address ${String(JSON.stringify(it.at)).slice(0, 60)} names no spot on the table — dropped`); delete it.at; }
    if (it.k === 'g') index(id, it, true);
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
   *  their angles. What a seat that is gone owned belongs to nobody now
   *  (otherwise nobody, the host included, could ever handle it again). */
  function setSeats(actor, seats) {
    const was = host.seats;
    if (!seats && !was) return;
    host.seats = seats;
    dirty.seats = true;
    const players = Object.entries(host.players);
    if (!seats) {
      for (const [q, pl] of players) {
        touchPlayer(q);
        delete pl.seatId;
        if (pl.seat == null) pl.seat = assignSeat();
      }
      logEvent(actor, 'removed the named seats: everyone sits where they like');
    } else {
      const angles = seatAngles(host.table, seats), order = players.sort(([, a], [, b]) => b.online - a.online || clockwise(a) - clockwise(b));
      order.forEach(([q, pl], k) => {
        const s = seats[k];
        touchPlayer(q);
        if (s) { pl.seatId = s.id; pl.seat = angles.get(s.id); } else { delete pl.seatId; pl.seat = null; }
      });
      const name = (k) => order[k]?.[1].name || (order[k] ? 'a player' : 'empty');
      const watching = order.slice(seats.length).map(([, pl]) => pl.name || 'a player');
      logEvent(actor, `${actor === RULES ? 'set the seats: ' : 'Seats: '}${seats.map((s, k) => `${s.name} — ${name(k)}`).join(', ')}${watching.length ? ` · watching: ${watching.join(', ')}` : ''}`);
    }
    const kept = new Set((seats || []).map((s) => s.id));
    for (const s of was || []) {
      const ids = kept.has(s.id) ? [] : [...(byOwner.get(`seat:${s.id}`) || [])];
      for (const id of ids) setOwner(id, host.items[id], null);
      if (ids.length) logEvent(actor, `released ${ids.length} ${ids.length === 1 ? 'item' : 'items'} of ${s.name}: that seat is gone`);
    }
  }
  /** Shifts every item by (dx, dy) and pulls it back onto the table as it
   *  now is (setTable, resume): the boards first, then the rest, each clamped
   *  (clampToTable) — but a piece that would then sit centred on its own
   *  spot stays there, as snapping put it (snapTo, even past the playing
   *  area's margin: D112, D119). Nothing moves more than that: a piece whose
   *  board was pulled in harder is only clamped, and every address is read
   *  again by containment (syncSpots). Each item that moved is re-sent. */
  function pullOn(dx, dy) {
    for (const id of [...boardIds, ...Object.keys(host.items).filter((id) => !boardIds.has(id))]) {
      const it = host.items[id], { w, h } = size(it), x = it.x + dx, y = it.y + dy;
      let p = clampToTable(host.table, x, y, w, h);
      if (it.at && (p.x !== x || p.y !== y)) {
        const s = snapTo(tb(), host.table, w, h, x, y, { at: it.at }); // (where its spot is now: the boards are in place)
        if (Math.abs(s.x - x) < 1e-6 && Math.abs(s.y - y) < 1e-6) p = s; // (1e-6: a turned board's spot centre carries float crumbs)
      }
      if (p.x === it.x && p.y === it.y) continue;
      touch(id);
      [it.x, it.y] = [p.x, p.y];
      respot = true; // (the addresses are read again, syncSpots)
    }
  }
  /** The table becomes `tb` (cleanTable's): items shift to keep their place
   *  relative to the centre, then are pulled back onto it (pullOn) — a new
   *  felt alone moves nothing; seat angles stay, and named seats are placed
   *  anew. False when nothing changed. */
  function setTable(actor, tb) {
    const old = host.table;
    if (canon(old) === canon(tb)) return false;
    host.table = tb;
    dirty.table = true;
    if (tb.shape !== old.shape || tb.w !== old.w || tb.h !== old.h) pullOn((tb.w - old.w) / 2, (tb.h - old.h) / 2);
    if (host.seats) {
      for (const [q, pl] of Object.entries(host.players)) if (pl.seatId) { touchPlayer(q); pl.seat = namedAngle(pl.seatId); }
    }
    logEvent(actor, tb.shape === 'round' ? `set the table to round (${TABLE_SIZES[tb.w]})` : `set the table to a ${tb.w} × ${tb.h} rectangle`);
    return true;
  }

  /** Seats player p (new, or back online), filling an empty name. True when
   *  that changed anything: the app registers the sender of every action
   *  here, and an unchanged player must not travel with each of them. */
  function ensurePlayer(p, name) {
    jot(`p:${p}`, own(host.players, p)); // (it may change below: touchPlayer when it did)
    const known = own(host.players, p), pl = known || (host.players[p] = { name: '', color: freeColor(), online: true, hand: [] });
    const was = known && `${pl.seat}|${pl.seatId}|${pl.online}|${pl.name}`;
    if (!known?.online) seatOnJoin(p, pl);
    pl.online = true;
    // Only fill an empty name here — explicit renames go through the 'name'
    // action so they land in the log.
    if (!pl.name) pl.name = joinName(name);
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
   *  other player sees (`roll`: the die ids, for the dice tumble). Call BEFORE
   *  deleting an item so the position survives. Ids as text (an action may
   *  name item "12" as 12): the host takes a Worker's marker in exactly this
   *  shape, and no other (checkPatch, D149). */
  function mark(p, id, roll) {
    const it = host.items[id];
    marks++;
    emit({ t: 'fx', f: { p, id: String(id), x: it?.x ?? 0, y: it?.y ?? 0, ...(roll && { roll: roll.map(String) }) } });
  }
  /** An action that happened with no item to mark (a seat change): counts for onAction. */
  const took = () => { marks++; };

  /** Appends to the shared log. Consecutive duplicates (drag/rotate spam) collapse,
   *  but a chat line or a `keep` one (a deck added: the host checks it is there, D168).
   *  Entries render the actor's CURRENT name, unless `as` freezes one (renames).
   *  `chat` marks a chat line (talk), `loud` an on-the-record one (a peek); the
   *  buckets are capped separately (LOG_CAPS, trimLog), and a line at LOG_TXT_MAX. */
  function logEvent(p, txt, { chat, as, loud, keep } = {}) {
    if (runs.length) flushRuns(); // (an aggregating run ends at any other line)
    txt = cut(txt);
    const last = host.log.at(-1);
    if (!chat && !keep && last && last.p === p && last.txt === txt) return;
    const e = { p, txt, ts: now(), ...(chat ? { c: 1 } : {}), ...(as ? { n: as } : {}), ...(loud ? { k: 1 } : {}) };
    if (J && !restoring) J.frames.at(-1).log ??= host.log.slice(); // (the journal keeps the log as this frame found it)
    host.log.push(e);
    host.log = trimLog(host.log);
    dirty.log.push(e);
  }
  // Aggregation (spec §3e): in one action, a run of AGG_MIN or more
  // consecutive Rules lines of the same op — placed, removed, turned,
  // counted, locked, unlocked, owner, used randomness — becomes one line
  // ("📜 Rules removed 30 pieces: D4, E4, D5, …"): a go capture or a setup
  // would otherwise flush the action log. The lines wait in `runs` until
  // another line is written, or the action commits (flushRuns). One call
  // given a list (t.remove(ids), t.setFace(ids, f): a go capture, a reversi
  // move's flips) is one line from two items on (`whole`, D167).
  let runs = [];
  /** Logs `txt` for an op of the kind `op` on item `it` (for 'random': the
   *  number of draws; for 'turned', `turn`: {from, to}, the labels it went
   *  between): a person's at once, a script's into the run. */
  function logOp(actor, op, txt, it, turn) {
    if (actor !== RULES) return logEvent(actor, txt);
    runs.push({ op, txt, it: op === 'random' ? it : { at: addrNow(it), name: label(it), kind: isCard(it) ? 'cards' : it.k === 'g' ? 'pieces' : 'items', ...turn } });
  }
  /** The one line for `run` (entries of op `op`): "removed 3 pieces: B1, A1,
   *  C2", naming the first AGG_NAMES addresses (or labels) — and, where every
   *  piece turned between the same two faces, which ("turned 4 pieces from
   *  Light disc to Dark disc: d4, …"). */
  function aggLine(op, run) {
    const kinds = new Set(run.map((r) => r.it.kind)), names = run.slice(0, AGG_NAMES).map((r) => r.it.at || r.it.name), [{ it }] = run;
    const how = it.to && run.every((r) => r.it.from === it.from && r.it.to === it.to) ? ` from ${it.from} to ${it.to}` : '';
    return `${AGG_VERB[op]} ${run.length} ${kinds.size === 1 ? [...kinds][0] : 'items'}${how}: ${names.join(', ')}${run.length > AGG_NAMES ? ', …' : ''}`;
  }
  /** Writes the waiting Rules lines: each run of AGG_MIN or more of one op
   *  as one line (aggLine), a `whole` entry (a list's line) as it is, the
   *  rest line by line. */
  function flushRuns() {
    const all = runs;
    runs = [];
    for (let k = 0, j; k < all.length; k = j) {
      for (j = k + 1; j < all.length && all[j].op === all[k].op && !all[j].whole && !all[k].whole;) j++;
      const run = all.slice(k, j), op = run[0].op;
      if (run.length < AGG_MIN) { for (const r of run) logEvent(RULES, r.txt); continue; }
      if (op === 'random') { const n = run.reduce((m, r) => m + r.it, 0); logEvent(RULES, `used randomness (${n} draws)`); continue; }
      logEvent(RULES, aggLine(op, run));
    }
  }
  /** A facade call on one id, or on a list of them as ONE log line (D167):
   *  `op(id)` for each; the lines the list's ops queued (logOp only: these
   *  ops write no other line) become one `whole` entry from two on. True
   *  when every op did; false when one found its item gone (said, as ever). */
  function eachOf(name, ids, op) {
    if (!Array.isArray(ids)) return op(ids);
    if (ids.length > MAX_ITEMS) throw new TypeError(`${name}: at most ${MAX_ITEMS} ids at once`);
    const k = runs.length, done = ids.map((id) => op(id) !== false).every(Boolean), mine = runs.slice(k);
    if (mine.length >= 2 && mine.every((r) => r.op === mine[0].op)) runs.splice(k, mine.length, { op: mine[0].op, whole: true, txt: aggLine(mine[0].op, mine) });
    return done;
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
  /** Room for k more entries in player q's hand (MAX_HAND), for actor p. */
  const handRoom = (p, q, k = 1) => host.players[q].hand.length + k <= MAX_HAND
    || no(p, `🚫 ${p === q ? 'Your' : 'That'} hand is full (${MAX_HAND.toLocaleString('en-US')})`);
  /** Room for k more members on pile `pile` (MAX_PILE), for actor p. */
  const pileRoom = (p, pile, k = 1) => pile.cards.length + k <= MAX_PILE || no(p, `🚫 That pile is full (${MAX_PILE.toLocaleString('en-US')})`);
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
      if (!handRoom(actor, o.to)) return false;
      touch(pileId);
      touchPlayer(o.to, { hand: true });
      pile.cards.pop();
      pl.hand.push(entryOf(c));
      logEvent(actor, `dealt a ${piece ? 'piece' : 'card'} from ${label(pile)} to ${pl.name || 'a player'}`);
    } else {
      if (!cap(actor)) return false;
      const at = nextTo(pile);
      touch(pileId);
      pile.cards.pop();
      const up = !!o.up || (piece && mustShow(c.t));
      const it = piece ? { k: 'g', t: c.t, f: c.f, rot: 0, ...(!up && { up: false }) } : { k: 'c', rot: 0, d: c.d, i: c.i, up };
      it.rot = turned(it, o.rot);
      place(it, num(o.x, at.x), num(o.y, at.y));
      nid = put(mint(host.items), it);
      logEvent(actor, `dealt ${!up ? `a ${piece ? 'piece' : 'card'} face down` : piece ? oneLabel(it) : cardName(host.decks, c.d, c.i)} from ${label(pile)}${toAt(it)}`);
      mark(actor, nid);
    }
    mark(actor, pileId);
    dropIfEmpty(pileId);
    // the dealt card's (or piece's) identity, so scripts can track what they dealt
    const who = piece ? { t: c.t, f: c.f } : { d: c.d, i: c.i };
    return o.to ? who : { id: nid, ...who };
  }

  function opShuffle(actor, pileId) {
    const pile = own(host.items, pileId);
    if (pile?.k !== 'p' || !mayHandle(actor, pile)) return false;
    touch(pileId);
    for (let i = pile.cards.length - 1; i > 0; i--) {
      const j = rint(i + 1);
      [pile.cards[i], pile.cards[j]] = [pile.cards[j], pile.cards[i]];
    }
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
    if (!may(actor, it) || !mayHandle(actor, pile) || !pileRoom(actor, pile)) return false;
    logEvent(actor, `put ${label(it)} onto ${label(pile)}`);
    mark(actor, pileId);
    touch(pileId);
    pile.cards.push(isCard(it) ? { d: it.d, i: it.i, up: it.up } : { t: it.t, f: it.f, up: it.up !== false });
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
    if (!may(actor, it) || !mayHandle(actor, to) || !pileRoom(actor, to, it.cards.length)) return false;
    logEvent(actor, `merged ${label(it)} (${it.cards.length} ${unit(it)}) into ${label(to)}`);
    mark(actor, pileId);
    touch(pileId);
    to.cards.push(...it.cards);
    remove(id);
    return true;
  }

  /** Moves item `id` to top-left (x, y) — a piece snaps, or takes `o`'s
   *  place (see place: free, or a qualified `at`) — logged with its
   *  addresses: "moved {label} {from} → {to}", "… to {to}", "… from {from}". */
  function opMove(actor, id, x, y, o = {}) {
    const it = own(host.items, id);
    if (!it) return gone('move', id);
    if (!may(actor, it)) return false;
    const from = addrNow(it);
    touch(id);
    place(it, num(x, it.x), num(y, it.y), { ...o, id });
    const to = addrNow(it);
    logEvent(actor, `moved ${label(it)}${from && to ? ` ${from} → ${to}` : to ? ` to ${to}` : from ? ` from ${from}` : ''}`);
    mark(actor, id);
    return true;
  }
  /** " to {address}" (toAt) or " on {address}" (onAt) for a piece on a spot (the log), else ''. */
  const toAt = (it) => { const a = addrNow(it); return a ? ` to ${a}` : ''; };
  const onAt = (it) => { const a = addrNow(it); return a ? ` on ${a}` : ''; };

  /** Turns item `id` to `rot` degrees — a piece, supply or pile of pieces
   *  in steps of its rotStep (its back's when hidden). */
  function opRot(actor, id, rot) {
    const it = own(host.items, id);
    if (!it) return gone('rot', id);
    if (!may(actor, it)) return false;
    touch(id);
    it.rot = turned(it, rot);
    logEvent(actor, `rotated ${label(it)}`);
    mark(actor, id);
    return true;
  }

  function opRemove(actor, id) {
    const it = own(host.items, id);
    if (!it) return gone('remove', id);
    if (!may(actor, it)) return false;
    const extra = it.k === 'p' ? ` (${it.cards.length} ${unit(it)})` : it.k === 'b' ? ` (${it.of.length} pieces)` : '';
    const at = addrNow(it);
    logOp(actor, 'removed', `removed ${label(it)}${extra}${at ? ` from ${at}` : ''}`, it);
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
    if (!handRoom(actor, q)) return false;
    const what = it.k === 'c' ? label(it) : oneLabel(it);
    logEvent(actor, actor === RULES ? `gave ${what} to ${pl.name || 'a player'}` : it.up === false ? 'took a hidden piece into hand' : `took ${what} from the table into hand`);
    mark(actor, id);
    touchPlayer(q, { hand: true });
    pl.hand.push(entryOf(it));
    if (it.n > 1) { touch(id); if (--it.n < 2) delete it.n; } else remove(id);
    return true;
  }

  /** Plays player q's hand entry `idx` onto the table at o.x, o.y (face up
   *  iff `up`; a piece face down only if its type has a back). */
  function opPlay(actor, q, idx, o, up) {
    const pl = own(host.players, q), c = pl.hand[idx];
    if (!cap(actor)) return false;
    touchPlayer(q, { hand: true });
    pl.hand.splice(idx, 1);
    const piece = !isCard(c);
    if (piece && mustShow(c.t)) up = true;
    const it = piece ? { k: 'g', t: c.t, f: c.f, rot: 0, ...(!up && { up: false }) } : { k: 'c', rot: 0, d: c.d, i: c.i, up };
    const { w, h } = size(it);
    it.rot = turned(it, o.rot);
    place(it, num(o.x, host.table.w / 2 - w / 2), num(o.y, host.table.h / 2 - h / 2));
    const nid = put(mint(host.items), it);
    const what = !up ? `a ${piece ? 'piece' : 'card'} face down` : piece ? oneLabel(it) : cardName(host.decks, c.d, c.i);
    logEvent(actor, `played ${what} from ${actor === RULES ? `${pl.name || 'a player'}'s hand` : 'hand'}${toAt(it)}`);
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
    mark(actor, dice[0][0], dice.map(([id]) => id));
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
   *  onto `onto` — another stack (join a), the stack's supply (join b: they
   *  go back) or a bag (toBag: they go in) — atomically: refused whole when
   *  that join or toBag would be, and no piece is ever left on the table. */
  function opSplit(actor, id, n, x, y, onto) {
    const it = own(host.items, id);
    if (!it) return gone('split', id);
    if (it.k !== 'g' || !(it.n >= 2)) return no(actor, '🚫 Only a stack (×2 or more) can be split');
    const k = n ?? 1;
    if (!Number.isInteger(k) || k < 1 || k >= it.n) return no(actor, `🚫 Take 1 to ${it.n - 1} from that stack`);
    if (!may(actor, it)) return false;
    const to = onto !== undefined ? own(host.items, onto) : null, before = label(it);
    const part = { ...it, n: k > 1 ? k : undefined }; // the k pieces, for the log
    if (onto !== undefined) {
      if (!to) return gone('split', onto);
      if (to.k === 'b') { // the toBag checks (a bag takes hidden pieces: no hidden-item rule)
        if (to.of.length + k > MAX_BAG) return no(actor, `🚫 That bag is full (${MAX_BAG.toLocaleString('en-US')} pieces)`);
        if (to.hand && !flags(it).hand) return no(actor, '🚫 That bag only holds pieces that can be held in a hand');
      } else {
        if (!shown(actor, it, to)) return false;
        if (to.k === 's' ? to.t !== it.t : !stackable(it, to, k)) return no(actor, "🚫 Those don't stack together");
      }
      if (!mayHandle(actor, to)) return false;
    } else if (!cap(actor)) return false;
    touch(id);
    it.n -= k;
    if (it.n < 2) delete it.n;
    if (to) {
      const into = label(to);
      touch(onto);
      if (to.k === 'b') {
        for (let j = 0; j < k; j++) to.of.push({ t: it.t, f: it.f, ...(it.up === false && { up: false }) });
        logEvent(actor, `put ${label(part)} into ${into}`);
      } else if (to.k === 's') logEvent(actor, `returned ${label(part)} to ${into}`);
      else {
        to.n = (to.n || 1) + k;
        logEvent(actor, `moved ${k} from ${before} onto ${into}`);
      }
      mark(actor, onto);
      return true;
    }
    const nu = { k: 'g', t: it.t, f: it.f, rot: it.rot, ...(it.up === false && { up: false }), ...(k > 1 && { n: k }), ...(it.owner && { owner: it.owner }) };
    const at = nextTo(it);
    place(nu, num(x, at.x), num(y, at.y));
    const nid = put(mint(host.items), nu);
    logEvent(actor, `took ${k} from ${before}${toAt(nu)}`);
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
   *  hand (`hand`) of player `to` (the actor's own; a script names one) —
   *  owned by the supply's owner, if it has one. `po`: how it is placed
   *  (place's o). Returns its id, or for a hand its entry {hand: true, t, f,
   *  up?}, or false. */
  function opTake(actor, id, x, y, hand, to = actor, po = {}) {
    const s = own(host.items, id), pl = own(host.players, to);
    if (!s) return gone('take', id);
    if (s.k !== 's') return no(actor, '🚫 That is not a supply');
    if (!mayHandle(actor, s)) return false;
    const nu = { k: 'g', t: s.t, f: s.f, rot: 0, ...(s.up === false && { up: false }), ...(s.owner && { owner: s.owner }) };
    if (hand) {
      if (!pl) return false;
      if (!flags(s).hand) return no(actor, "🚫 That can't be held in a hand");
      if (!handRoom(actor, to)) return false;
      touchPlayer(to, { hand: true });
      pl.hand.push(entryOf(nu));
      logEvent(actor, actor === RULES ? `took ${oneLabel(nu)} from ${label(s)} into ${pl.name || 'a player'}'s hand` : `took ${oneLabel(nu)} into hand`);
      mark(actor, id);
      return { hand: true, ...entryOf(nu) };
    }
    if (!cap(actor)) return false;
    const at = nextTo(s);
    place(nu, num(x, at.x), num(y, at.y), po);
    const nid = put(mint(host.items), nu);
    logEvent(actor, `took ${oneLabel(nu)} from ${label(s)}${toAt(nu)}`);
    mark(actor, nid);
    return nid;
  }

  /** A random piece out of bag `id` — the member drawFrom drew (the
   *  action's a.pick, when prepare drew it already) — onto the table at (x,
   *  y), as it was put in (face up or down), or into the hand (`hand`, for a
   *  bag made for hands) of player `to` (the actor's own; a script names
   *  one). `po`: how it is placed (place's o). Returns its id, or for a hand
   *  its entry {hand: true, t, f, up?}, or false. */
  function opPull(actor, id, x, y, hand, to = actor, po = {}) {
    const bag = own(host.items, id), pl = own(host.players, to);
    if (!bag) return gone('pull', id);
    if (bag.k !== 'b') return no(actor, '🚫 That is not a bag');
    if (!bag.of.length) return no(actor, '🚫 That bag is empty');
    if (!mayHandle(actor, bag)) return false;
    if (hand && (!pl || !bag.hand)) return no(actor, "🚫 That bag's pieces can't be held in a hand");
    if (hand ? !handRoom(actor, to) : !cap(actor)) return false;
    touch(id);
    const at = nextTo(bag), m = bag.of.splice(drawFrom(id, bag), 1)[0];
    J?.frames.at(-1).taken.push([id, drawn.get(id)]); // (a rollback of this pull puts its draw back: see restore)
    drawn.delete(id);
    if (hand) {
      touchPlayer(to, { hand: true });
      pl.hand.push(entryOf(m));
      logEvent(actor, actor === RULES ? `drew a piece from ${label(bag)} into ${pl.name || 'a player'}'s hand` : `drew a piece from ${label(bag)}`);
      mark(actor, id);
      return { hand: true, ...entryOf(m) };
    }
    const nu = { k: 'g', t: m.t, f: m.f, rot: 0, ...(m.up === false && { up: false }) };
    place(nu, num(x, at.x), num(y, at.y), po);
    const nid = put(mint(host.items), nu);
    logEvent(actor, `drew ${m.up === false ? 'a piece' : oneLabel(nu)} from ${label(bag)}${toAt(nu)}`);
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
   *  supply's; a bag's, fixed when the bag was made (`box`: the box whose
   *  setup made it) — never read from what it holds, which is hidden; cards
   *  and piles: none. */
  const boxOfItem = (it) => own(host.boxes, it.k === 'b' ? it.box : (it.k === 'g' || it.k === 's') && it.t.slice(0, it.t.indexOf('/')));
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
    logOp(actor, on ? 'locked' : 'unlocked', `${on ? 'locked' : 'unlocked'} ${label(it)}`, it);
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
    if (actor !== pid && actor !== RULES) {
      // The current owner passes it on (to a player) or releases it; anyone
      // else may only claim, for themselves, what nobody owns — not locked,
      // not a board (hidden boards are boards too: a back never hides both).
      if (it.owner && resolveOwner(it.owner) === actor) {
        if (seat) return no(actor, '🚫 Only the host can give that away');
      } else if (it.owner) return no(actor, `🚫 That belongs to ${ownerName(it.owner)}`);
      else if (to !== actor) return no(actor, '🚫 Only the host can give that away');
      else if (isBoard(it)) return no(actor, "🚫 Boards can't be claimed");
      else if (!notLocked(actor, it)) return false;
    }
    if ((it.owner ?? null) === to) return false;
    const what = label(it);
    setOwner(id, it, to);
    logOp(actor, 'owner', to === null ? `released ${what}` : to === actor ? `claimed ${what}` : `gave ${what} to ${ownerName(to)}`, it);
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
    jot(`p:${q}`, pl); // (it may change below: touchPlayer when it did)
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
      touchPlayer(q, { hand: true });
      pl.hand = [];
    }
    logEvent(actor, `cleared the table (${n} items, ${m} cards from hands)`);
  }

  let boxIndex = null; // a box's content key (cyrb53 of boxText) → the ids of the catalog's boxes with it (made on first use)
  /** Box `box`'s content as text (canon): its fields, and its decks by name
   *  with their CONTENT, never their ids (`decks`: {name: deck}) — so a
   *  script's box defined again, with decks that are not minted yet, finds
   *  the box already there (t.newBox, D111). */
  const boxText = (box, decks) => canon(Object.keys(decks).length ? { ...box, decks } : box);
  /** boxText of a box of the catalog: its decks looked up by id. */
  const storedText = ({ decks = {}, ...rest }) => boxText(rest, Object.fromEntries(Object.entries(decks).map(([n, id]) => [n, own(host.decks, id) || null])));
  /** The id of the catalog's box whose content is `text` (boxText), or undefined. */
  function boxWith(text) {
    if (!boxIndex) {
      boxIndex = new Map();
      for (const [id, b] of Object.entries(host.boxes)) listAt(boxIndex, cyrb53(storedText(b))).push(id);
    }
    return (boxIndex.get(cyrb53(text)) || []).find((id) => storedText(host.boxes[id]) === text);
  }
  /** Box `box` (cleaned; its decks, if any, in the catalog already) into the
   *  catalog — or the id of the box with the same content already there
   *  (boxWith). A new one gets id `want` when it is free, else a minted one, recorded with its source (`src`,
   *  `by`: host-written, never read from a box) and sent to everyone (the
   *  'box' effect). */
  function registerBox(box, src, by, want) {
    const text = storedText(box), same = boxWith(text);
    if (same) return same;
    const id = want && freeId(want) ? want : mint(host.boxes);
    toCatalog(`b:${id}`);
    host.boxes[id] = box;
    host.boxSrc[id] = { src, ...(by && by !== RULES && { by }) };
    listAt(boxIndex, cyrb53(text)).push(id);
    tbVer++; // (a board waiting for its box has one now)
    emit({ t: 'box', id });
    return id;
  }

  /** The seated players' ids, clockwise from the bottom of the table (spec
   *  §4a): a setup's "#k" is the k-th of them, from 1. */
  const seated = () => Object.entries(host.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => clockwise(a) - clockwise(b)).map(([q]) => q);
  /** Why setup `list` of box `box` (cleaned) can't be laid out on the table
   *  as it now is — its seats set already — or '' (spec §4c: every check
   *  before the first op): a deck it names missing from the catalog, or a
   *  card index past its end; a "#k" past the seated players; a named seat it
   *  deals a hand to that nobody holds; a hand it would overfill; more items
   *  than a setup lays out (MAX_SETUP_ITEMS) or the table holds (MAX_ITEMS). */
  function setupProblem(box, list) {
    const ranked = seated(), hands = new Map();
    let need = 0, why = '';
    const deck = (name, i) => {
      const d = own(host.decks, own(box.decks || {}, name));
      why ||= !d ? `its deck «${name}» is missing from this table` : i !== undefined && i >= d.cards.length ? `its deck «${name}» has no card ${i} (it has ${d.cards.length})` : '';
    };
    const seatK = (k) => { need = Math.max(need, +k.slice(1)); return ranked[+k.slice(1) - 1]; };
    const visit = (e) => {
      if (e.forEachSeat || e.group) { (e.forEachSeat || e.group).forEach(visit); return; }
      if (typeof e.owner === 'string' && e.owner[0] === '#') seatK(e.owner);
      for (const m of e.deck !== undefined ? [{ deck: e.deck }] : e.card ? [e.card] : e.pile || []) if (m.deck !== undefined) deck(m.deck, m.i);
      for (const [k, l] of Object.entries(e.hands || {})) {
        const q = k[0] === '#' ? seatK(k) : holder(k);
        if (!q && k[0] !== '#') why ||= `nobody sits in the seat «${seatDef(k)?.name || k}» it deals a hand to`;
        for (const m of l) if (m.deck !== undefined) deck(m.deck, m.i);
        if (q) hands.set(q, (hands.get(q) || 0) + l.length);
      }
    };
    list.forEach(visit);
    if (need > ranked.length) return `this game needs ${need} seated players (${ranked.length} ${ranked.length === 1 ? 'is' : 'are'} seated)`;
    if (why) return why;
    const n = countSetup(list, host.seats ? host.seats.length : ranked.length);
    if (n > MAX_SETUP_ITEMS) return `it places too many items (${n.toLocaleString('en-US')}, max ${MAX_SETUP_ITEMS.toLocaleString('en-US')})`;
    if (itemCount() + n > MAX_ITEMS) return `the table would hold more than ${MAX_ITEMS.toLocaleString('en-US')} items`;
    for (const [q, k] of hands) if (host.players[q].hand.length + k > MAX_HAND) return `${host.players[q].name || 'a player'}'s hand would hold more than ${MAX_HAND.toLocaleString('en-US')}`;
    return '';
  }
  /** Lays out setup `list` of box `boxId` (cleaned: spec §2c, §4a), checked
   *  first (setupProblem: run it before) — every item through place(), as
   *  `o.actor` (logged by the caller) — and returns {n: the items placed,
   *  remap: {an id the setup asked for: the one it got} (it was taken),
   *  shuffled: whether o.shuffle shuffled a face-down deck or pile entry}.
   *  An entry's `id` is used when no item holds it, else a new one is minted
   *  (remap); minted ids avoid every id the setup asks for. Hidden pieces
   *  carry no declaration order: one entry's are given their z in a random
   *  order, and a `group` with `shuffle` permutes the places (x, y, z) of its
   *  hidden pieces that share a back. "#k" is the k-th seated player
   *  (seated); `hands` go to a named seat's holder or to "#k". An address
   *  `at` is read on the table as it then stands, `{board, at}` on the first
   *  board of that type this layout placed: one the table doesn't have
   *  throws (the caller's journal undoes what was laid out). The addresses
   *  are read again as each board lands (syncSpots), so a piece an earlier
   *  entry put there gets its spot by containment, and one a later entry
   *  sets down `free` keeps none. With
   *  `o.shuffle`, a face-down `deck` entry is shuffled, and a `pile`'s
   *  face-down members among their places (spec §4c: the box's author knew
   *  their order). */
  function lay(boxId, box, list, o = {}) {
    const table = host.table, angles = host.seats && seatAngles(table, host.seats), ranked = seated();
    const seats = host.seats ? host.seats.map((s) => ({ at: seatAt(table, angles.get(s.id), s), owner: `seat:${s.id}` }))
      : ranked.map((q) => ({ at: seatPoint(table, host.players[q].seat), owner: q }));
    const shuffle = (l) => { for (let i = l.length - 1; i > 0; i--) { const j = rint(i + 1); [l[i], l[j]] = [l[j], l[i]]; } return l; };
    const ref = (tid) => `${boxId}/${tid}`, deckId = (name) => box.decks[name];
    const asked = new Set(setupIds(list)), remap = {}, boards = new Map(); // boards: board type id → the first one placed
    let n = 0, shuffled = false;
    const fresh = () => { let id = mint(host.items); while (asked.has(id)) id = mint(host.items); return id; };
    /** The id of the item entry `e` places: its own when free. */
    function idFor(e) {
      if (!e.id) return fresh();
      if (!own(host.items, e.id)) return e.id;
      return (remap[e.id] = fresh());
    }
    const run = (l, seat) => l.flatMap((e) => spawn(e, seat));
    /** Where the k-th item of entry `e` (w × h) goes: place()'s [x, y, o] —
     *  'center', [x, y] (a top-left; `free`: no snapping), in the seat's
     *  frame (dx to its right, dy toward the table), or centred on an
     *  address; `spread` steps along the same axes. */
    function spot(e, it, seat, k) {
      const { w, h } = size(it), [sx, sy] = e.spread || [0, 0];
      if (e.at === 'center') return [table.w / 2 - w / 2 + k * sx, table.h / 2 - h / 2 + k * sy];
      if (Array.isArray(e.at)) return [e.at[0] + k * sx, e.at[1] + k * sy, e.free ? { free: true } : {}];
      if (e.at === 'seat' || e.at.seat) {
        const [dx, dy] = e.at === 'seat' ? [0, SEAT_INSET] : e.at.seat, S = seat.at, rx = dx + k * sx, ry = dy + k * sy;
        return [S.x - S.uy * rx + S.ux * ry - w / 2, S.y + S.ux * rx + S.uy * ry - h / 2];
      }
      const a = typeof e.at === 'string' ? e.at : boards.has(e.at.board) ? `${boards.get(e.at.board)}:${e.at.at}` : null;
      const r = a && resolveAddr(tb(), a);
      if (!r || r.ambiguous) throw new Error(a ? `${r ? 'the ambiguous' : 'no such'} address '${typeof e.at === 'string' ? a : e.at.at}'${r ? ` (${r.ambiguous.join(' or ')})` : ''} on the table's boards` : `no board "${e.at.board}" is placed before an entry set on it`);
      return [r.x - w / 2 + k * sx, r.y - h / 2 + k * sy, isPiece(it) ? { at: r.at } : {}];
    }
    /** A pile's (or a hand's) member: a card {d, i, up} or a piece {t, f, up}. */
    const member = (m) => (m.deck !== undefined ? { d: deckId(m.deck), i: m.i, up: !!m.up } : { t: ref(m.piece), f: m.f ?? 0, up: m.up ?? !box.types[m.piece].back });
    function spawn(e, seat) {
      if (e.forEachSeat) return seats.flatMap((s) => run(e.forEachSeat, s));
      if (e.group) {
        const ids = run(e.group, seat);
        if (e.shuffle) {
          // (cleanBox saw to it that these agree on everything else that shows: rot, lock, n, owner)
          // (a place carries its address: they lie on the same spots, re-indexed)
          const byBack = new Map();
          for (const id of ids) {
            const it = host.items[id];
            if (it.k === 'g' && it.up === false) listAt(byBack, backRef(host.boxes, it.t)).push([id, it]);
          }
          for (const l of byBack.values()) {
            const spots = shuffle(l.map(([, it]) => [it.x, it.y, it.z, it.at]));
            l.forEach(([id, it], k) => {
              index(id, it, false);
              [it.x, it.y, it.z, it.at] = spots[k];
              if (it.at === undefined) delete it.at;
              index(id, it, true);
            });
          }
        }
        return ids;
      }
      if (e.hands) {
        for (const [k, l] of Object.entries(e.hands)) {
          const q = k[0] === '#' ? ranked[+k.slice(1) - 1] : holder(k);
          touchPlayer(q, { hand: true });
          host.players[q].hand.push(...l.map((m) => entryOf({ ...member(m), ...(m.deck === undefined && m.up !== false && { up: true }) })));
        }
        return [];
      }
      const owner = e.owner === 'seat' ? seat.owner : e.owner?.[0] === '#' ? ranked[+e.owner.slice(1) - 1] : e.owner;
      const tid = e.piece ?? e.supply, lock = e.lock ?? (tid !== undefined && box.types[tid].kind === 'board');
      let made;
      if (e.bag) {
        const of = e.bag.flatMap((m) => {
          const x = typeof m === 'string' ? { t: m } : m;
          return Array.from({ length: x.n ?? 1 }, () => ({ t: ref(x.t), f: x.f ?? 0, ...(x.up === false && { up: false }) }));
        });
        const hand = e.hand ?? (of.length > 0 && of.every((m) => typeOf(m.t).hand));
        // its box is fixed too: whether anyone may lock it (lockable) never depends on what it holds
        made = [{ k: 'b', of, name: e.name || '', box: boxId, ...(hand && { hand: true }), rot: 0 }];
      } else if (e.deck !== undefined || e.pile) {
        const cards = e.pile ? e.pile.map(member) : host.decks[deckId(e.deck)].cards.map((_, i) => ({ d: deckId(e.deck), i, up: !!e.up }));
        if (e.shuffle) shuffle(cards);
        const down = cards.flatMap((m, k) => (m.up ? [] : [k]));
        if (o.shuffle && down.length > 1) { // (the face-down ones, among their own places)
          const ms = shuffle(down.map((k) => cards[k]));
          down.forEach((k, j) => { cards[k] = ms[j]; });
          shuffled = true;
        }
        made = [{ k: 'p', rot: 0, name: e.name ?? e.deck ?? '', cards }];
      } else if (e.card) made = [{ k: 'c', d: deckId(e.card.deck), i: e.card.i, up: !!e.up, rot: 0 }];
      else {
        made = Array.from({ length: e.count ?? 1 }, () => ({
          k: e.piece ? 'g' : 's', t: ref(tid), f: e.f ?? 0, rot: 0, ...(e.up === false && { up: false }), ...(e.n && { n: e.n }),
        }));
      }
      made.forEach((it, k) => {
        if (owner) it.owner = owner;
        if (lock) it.lock = true;
        it.rot = turned(it, e.rot);
        place(it, ...spot(e, it, seat, k));
      });
      // One entry's hidden pieces: their z values in a random order, and
      // their ids minted in a random order too (an env may mint ids in sequence).
      const hid = made.filter((it) => it.up === false), zs = shuffle(hid.map((it) => it.z));
      hid.forEach((it, k) => { it.z = zs[k]; });
      n += made.length;
      const ids = (hid.length ? shuffle([...made]) : made).map((it) => put(idFor(e), it));
      if (e.piece && box.types[e.piece].kind === 'board') {
        if (!boards.has(e.piece)) boards.set(e.piece, ids[0]);
        syncSpots(); // (a new board: what lies on it is read now, D106 — so what the entries after it place stands as they place it: free, or on an address)
      }
      return ids;
    }
    run(list, null);
    return { n, remap, shuffled };
  }
  /** Says once that ids a box or a setup asked for had to change (`remap`:
   *  old → new): a running script that stored them may misbehave (spec §4c). */
  function remapped(remap) {
    const k = Object.keys(remap).length;
    if (!k) return;
    console.warn(`${k} ids had to change (they were taken)`, remap);
    emit({ t: 'toast', msg: `${k} ${k === 1 ? 'id' : 'ids'} had to change; a running script that stored ${k === 1 ? 'it' : 'them'} may misbehave` });
  }
  /** Runs fn — a box's setup or registration — whole or not at all: a throw
   *  (a check that failed, an address the table doesn't have) undoes what it
   *  did (the journal, opened for every such job: see apply) and refuses
   *  actor's action with `what`: the error's message. fn's value, or false. */
  function atomic(actor, what, fn) {
    const sp = savepoint();
    try { return fn(); } catch (err) {
      rollbackTo(sp);
      console.error(`${what} failed`, err);
      return no(actor, `🚫 ${what}: ${err.message}`);
    }
  }

  /** The host's loadBox: box `raw` (cleanBox, failing loudly) into the
   *  catalog (deduplicated), then with `o.clear` the table cleared, the box's
   *  table and named seats set, and with `o.setup` its setup laid out (the
   *  item total checked first: at most MAX_SETUP_ITEMS, and room on the
   *  table; then setupProblem), all or nothing (atomic). Returns the box's id, or false. */
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
    return atomic(actor, `Couldn't set up «${box.name}»`, () => {
      const id = registerBox(box, 'host', actor);
      if (o.clear) clearTable(actor);
      if (box.table) setTable(actor, box.table);
      setSeats(actor, box.seats ?? null);
      if (o.setup && box.setup) {
        const why = setupProblem(box, box.setup);
        if (why) throw new Error(why);
        const { n } = lay(id, box, box.setup);
        host.lastSetup = id;
        logEvent(actor, `set up «${box.name}» (${n} pieces)`);
      } else logEvent(actor, `added the box «${box.name}»`);
      took();
      return id;
    });
  }
  /** The host's `setup` of a box of the catalog, or `reset` of the last one
   *  set up (spec §4c), as one atomic job: every check first, then clear (a
   *  reset always clears), the box's table and seats, its setup laid out
   *  (lay: with `shuffle` — a guest's box by default — its face-down decks
   *  and piles shuffled), lastSetup. With `rules` (setup) — for a reset, when
   *  the rules running are this box's — the `enable` effect asks the app to
   *  queue, right after this job commits, the setRules that starts the box's
   *  rules on its exported state, with the ids that had to change (remap).
   *  True when it did; false, refused, when it didn't. */
  function setupBox(p, a) {
    const reset = a.t === 'reset', id = reset ? host.lastSetup : a.box, box = typeof id === 'string' ? own(host.boxes, id) : null;
    if (reset && !box) return no(p, host.lastSetup ? '🚫 The box last set up is gone' : '🚫 Nothing to reset: no game box was set up');
    if (reset && a.box !== undefined && a.box !== id) return no(p, '🚫 Reset only resets the box last set up');
    if (!box) return no(p, '🚫 No such game box on this table');
    const rules = reset ? !!host.rules?.enabled && host.rules.box === id : a.rules === true;
    if (rules && !box.rules) return no(p, `🚫 «${box.name}» has no rules`);
    const shuffle = !reset && typeof a.shuffle === 'boolean' ? a.shuffle : host.boxSrc[id]?.src === 'upload'; // (D83: a guest's box knows its layout)
    return atomic(p, `Couldn't set up «${box.name}»`, () => {
      if (reset || a.clear !== false) clearTable(p);
      if (box.table) setTable(p, box.table);
      setSeats(p, box.seats ?? null);
      const list = box.setup || [], why = setupProblem(box, list);
      if (why) throw new Error(why);
      const { n, remap, shuffled } = lay(id, box, list, { shuffle });
      host.lastSetup = id;
      logEvent(p, reset ? `reset «${box.name}»` : `set up «${box.name}» (${n} ${n === 1 ? 'item' : 'items'})${shuffled ? ', face-down piles shuffled' : ''}`);
      remapped(remap);
      if (rules) emit({ t: 'enable', box: id, remap });
      took();
      return true;
    });
  }
  /** What addBox logs: "added the box «X» (N piece types)". */
  const addedLine = (box) => { const n = Object.keys(box.types).length; return `added the box «${box.name}» (${n} piece ${n === 1 ? 'type' : 'types'})`; };
  /** Whether catalog id `id` is free (decks and boxes share the key space). */
  const freeId = (id) => !own(host.decks, id) && !own(host.boxes, id);
  /** The table as a game box, to export (spec §4c, §4d: the host's alone —
   *  it holds every hidden identity): addBox's payload (boxOfDef's shape;
   *  its images asset ids, its decks catalog decks), so a table set up from
   *  it lays out this very position. Its types and backs are those of the
   *  boxes the position uses (the last one set up first; a type or back id
   *  an earlier box took gets "-2", "-3"…), its decks the ones it shows and
   *  those boxes' own (a name taken gets " 2"…), and its setup every item —
   *  the boards first, then the rest, bottom to top — with its own `id`, at
   *  its top-left (`free` where it lies off the spot snapping would give
   *  it, or its address when it is centred on one under another board),
   *  owners by seat ("seat:<id>") or seated player ("#k"), then the seated
   *  players' hands ("#k"). The table and named seats go with it; with
   *  `o.rules` the running script, with `o.state` its state (data, public,
   *  asks, secret), each seated player's id as "@#k". The box, the decks
   *  and the setup ids are the catalog's and the table's own, so a fresh
   *  room keeps them (a script that stored one finds it). What can't go — a
   *  piece whose box is missing, a watcher's hand or item — is left out and
   *  said in `warnings`. Returns {box, warnings}; throws when the result
   *  can't be imported (boxOfDef: too many items for one setup). */
  function exportBox(o = {}) {
    flushRuns();
    syncSpots();
    const ranked = seated(), K = new Map(ranked.map((q, k) => [q, `#${k + 1}`])), warnings = [], B = tb();
    const items = Object.entries(host.items).sort(([, a], [, b]) => a.z - b.z);
    const used = own(host.boxes, host.lastSetup) ? [host.lastSetup] : [], use = (t) => {
      const b = typeof t === 'string' ? t.slice(0, t.indexOf('/')) : '';
      if (own(host.boxes, b) && !used.includes(b)) used.push(b);
    };
    for (const [, it] of items) for (const m of [it, ...(it.cards || it.of || [])]) use(m.t);
    for (const q of ranked) for (const m of host.players[q].hand) use(m.t);
    /** An id like `id` that `taken` doesn't hold, within `max` characters. */
    const uniq = (id, taken, max, sep = '-') => { let x = id; for (let n = 2; taken(x); n++) x = `${id.slice(0, max - String(n).length - sep.length)}${sep}${n}`; return x; };
    const types = {}, backs = {}, imgs = [], typeRef = new Map(); // typeRef: "<box>/<type>" → its id in the export
    for (const bid of used) {
      const box = host.boxes[bid], off = imgs.length, backId = {}, img = (f) => (f.img === undefined ? f : { ...f, img: f.img + off });
      imgs.push(...box.imgs);
      for (const [id, b] of Object.entries(box.backs)) backs[backId[id] = uniq(id, (x) => own(backs, x), 24)] = { ...b, face: img(b.face) };
      for (const [id, ty] of Object.entries(box.types)) {
        const nid = uniq(id, (x) => own(types, x), 32);
        typeRef.set(`${bid}/${id}`, nid);
        types[nid] = { ...ty, faces: ty.faces.map(img), ...(ty.back && { back: backId[ty.back] }) };
      }
    }
    const decks = [], deckName = new Map(); // deck id → its name in the export
    const useDeck = (d) => {
      if (deckName.has(d) || !own(host.decks, d)) return;
      const deck = host.decks[d], name = uniq(deck.name, (x) => decks.some((e) => e.name === x), 24, ' ');
      deckName.set(d, name);
      decks.push({ ...deck, name, ...(CATALOG_ID_RE.test(d) && { id: d }) });
    };
    for (const bid of used) for (const d of Object.values(host.boxes[bid].decks || {})) useDeck(d);
    for (const [, it] of items) for (const m of [it, ...(it.cards || [])]) if (typeof m.d === 'string') useDeck(m.d);
    for (const q of ranked) for (const m of host.players[q].hand) if (typeof m.d === 'string') useDeck(m.d);
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    /** A card or piece of a pile or a hand, as the setup names it — or null (its deck or box is missing). */
    const member = (m, hand) => (isCard(m) ? (deckName.has(m.d) ? { deck: deckName.get(m.d), i: m.i, ...(!hand && m.up && { up: true }) } : null)
      : typeRef.has(m.t) ? { piece: typeRef.get(m.t), ...(m.f && { f: m.f }), ...(hand ? m.up === false && { up: false } : { up: m.up !== false }) } : null);
    const setup = [];
    for (const [id, it] of [...items.filter(([, x]) => x.z < 0), ...items.filter(([, x]) => !(x.z < 0))]) {
      const t = it.t !== undefined && typeRef.get(it.t), pile = it.k === 'p' && it.cards.map((m) => member(m, false));
      const e = it.k === 'c' ? deckName.has(it.d) && { card: { deck: deckName.get(it.d), i: it.i }, ...(it.up && { up: true }) }
        : it.k === 'p' ? !pile.includes(null) && { pile, ...(it.name && { name: it.name }) }
          : it.k === 'b' ? it.of.every((m) => typeRef.has(m.t)) && { bag: it.of.map((m) => ({ t: typeRef.get(m.t), ...(m.f && { f: m.f }), ...(m.up === false && { up: false }) })), ...(it.name && { name: it.name }), hand: !!it.hand }
            : t && { [it.k === 's' ? 'supply' : 'piece']: t, ...(it.f && { f: it.f }), ...(it.up === false && { up: false }), ...(it.n > 1 && { n: it.n }) };
      if (!e) { warnings.push(`${label(it)}: its ${it.k === 'c' || it.k === 'p' ? 'deck or game box' : 'game box'} is missing`); continue; }
      const { w, h } = size(it);
      e.at = [it.x, it.y];
      if (isPiece(it)) { // where snapping puts it, as it lies? else its own address (D105), or just where it lies (free)
        const s = snapTo(B, host.table, w, h, it.x, it.y), r = it.at && resolveAddr(B, it.at);
        if (!(near(s.x, it.x) && near(s.y, it.y) && s.at === (it.at ?? null))) {
          if (r && near(r.x - w / 2, it.x) && near(r.y - h / 2, it.y)) e.at = display(it.at);
          else e.free = true;
        }
      }
      if (it.rot) e.rot = it.rot;
      const board = !!t && types[t].kind === 'board' && it.k !== 'b';
      if (!!it.lock !== board) e.lock = !!it.lock;
      if (it.owner) {
        if (it.owner.startsWith('seat:')) e.owner = it.owner;
        else if (K.has(it.owner)) e.owner = K.get(it.owner);
        else warnings.push(`${label(it)}: its owner isn't seated, so it goes ownerless`);
      }
      if (CATALOG_ID_RE.test(id)) e.id = id;
      setup.push(e);
    }
    const hands = {};
    for (const [q, pl] of Object.entries(host.players)) {
      const l = pl.hand.map((m) => member(m, true));
      if (!K.has(q)) { if (l.length) warnings.push(`${pl.name || 'a player'}'s hand: they aren't seated`); continue; }
      if (l.includes(null)) warnings.push(`${pl.name || 'a player'}'s hand: ${l.filter((m) => !m).length} of its cards or pieces have a missing deck or box`);
      if (l.some(Boolean)) hands[K.get(q)] = l.filter(Boolean);
    }
    if (Object.keys(hands).length) setup.push({ hands });
    for (const w of warnings) console.warn(`export: left out — ${w}`);
    const main = used[0] && host.boxes[used[0]], r = host.rules;
    // the rules' state: seated players as "@#k"; the other boxes merged into this one are this one now
    const as = (x) => (K.has(x) ? `@${K.get(x)}` : used.includes(x) && CATALOG_ID_RE.test(used[0]) ? used[0] : x);
    const box = {
      name: main?.name || 'Table', ...(main && CATALOG_ID_RE.test(used[0]) && { id: used[0] }),
      ...(main?.players && { players: main.players }), ...(main?.lockable && { lockable: main.lockable }), ...(main?.meta !== undefined && { meta: main.meta }),
      table: host.table, ...(host.seats && { seats: host.seats }), imgs,
      backs: Object.entries(backs).map(([id, b]) => ({ id, ...b })),
      pieces: Object.entries(types).map(([id, { board, ...ty }]) => ({ id, ...ty, ...board })),
      ...(decks.length && { decks }), setup,
      ...(o.rules && r?.code && { rules: r.code }),
      ...(o.state && r && { rulesState: mapIds({ data: r.data ?? {}, public: r.public ?? {}, asks: r.asks ?? {}, secret: r.secret ?? {} }, as) }),
    };
    const out = clone(box);
    boxOfDef(clone(out)); // (it must import: one setup holds at most MAX_SETUP_ENTRIES entries and MAX_SETUP_ITEMS items)
    return { box: out, warnings };
  }
  /** Player p's `addBox` (spec §4c): the box `a.box` (boxOfDef: the
   *  authoring format, ingested — app.js measured its transport `cost`),
   *  registered with its decks unless the catalog holds it already (by
   *  content: "That box is already on this table"); a guest's within the
   *  guests' budget, shared with decks (checked again here, at commit). The
   *  ids it asks for — the box's, each deck's — are kept when free, else
   *  minted, and the old ones replaced by the new in its rulesState (said
   *  once: remapped). Nothing is laid out. The `added` effect names the box
   *  (new or found) for the app. False when it was refused. */
  function addBox(p, a) {
    let made;
    try { made = boxOfDef(a.box); } catch (err) {
      console.error('rejected a box', err);
      return no(p, `🚫 Box rejected: ${err.message}`);
    }
    const { box, decks, id: want } = made, same = boxWith(boxText(box, Object.fromEntries(decks.map(([n, d]) => [n, d]))));
    if (same) {
      notify(p, 'That box is already on this table');
      emit({ t: 'added', id: same });
      return false;
    }
    if (p !== pid) {
      const cost = Math.max(num(a.cost), JSON.stringify(a.box).length), used = host.guestDeckChars || 0, over = boxOverBudget(used, cost);
      if (over) {
        console.warn('guest box over budget', p, cost, used);
        return no(p, `🚫 Box rejected: ${over}`);
      }
      host.guestDeckChars = used + cost;
    }
    const remap = {}, pick = (w) => { const id = w && freeId(w) ? w : mint(host.decks); if (w && id !== w) remap[w] = id; return id; };
    for (const [n, d, w] of decks) {
      const deckId = pick(w);
      addDeckTo(deckId, d);
      emit({ t: 'deck', id: deckId });
      box.decks[n] = deckId;
    }
    const id = pick(want);
    if (box.rulesState && Object.keys(remap).length) box.rulesState = mapIds(box.rulesState, (s) => own(remap, s) ?? s);
    registerBox(box, p === pid ? 'host' : 'upload', p, id);
    logEvent(p, addedLine(box), { keep: true });
    remapped(remap);
    emit({ t: 'added', id });
    took();
    return true;
  }

  /** Applies one action from player `p` — or one of the host's internal
   *  jobs: _join, _leave, _tick, _rulesOff, _name (spec §3c) — to the
   *  authoritative state, as one job: the ruled-action pipeline (act), then
   *  the rules' final gates (settle), the aggregated Rules log, and — when
   *  the job may run hooks, or a patch is wanted (T.job) — all of it inside
   *  the journal, so a vetoed or failed hook leaves nothing behind (spec
   *  §3f.4). Inside a journal opened already (T.begin), the job is a
   *  savepoint of it. True when the table changed (render, broadcast, save);
   *  false when nothing did: a hello, a snapshot or image request, a chat
   *  over flood control, a refused rules button, answer or select. An
   *  engine error rolls the job back whole, then throws. */
  function apply(p, a) {
    a = textIds(a);
    if (a.t === 'hello' || a.t === 'snap' || a.t === 'need') return false;
    if (a.t === 'drag') { drag(p, a); return false; } // (no state: the app relays it outside the queue, T.drag)
    const stray = hooks.stray?.(); // (a facade call from outside a hook, in-page: guard() takes it in a Worker)
    if (stray && host.rules?.enabled) rulesOff(stray);
    const opens = !J && (wantPatch || !!host.rules?.enabled || a.t === 'setRules' || BOX_JOBS.includes(a.t));
    jobHooks.length = 0;
    jobError = null;
    if (opens) {
      try { begin(guardJSON); } catch (err) { // (t.data or t.public was left unserializable between jobs, in-page: the rules go, their JSON part stays)
        console.error('rules: the state is not JSON', err);
        unsaveable(err.message);
        begin();
      }
    }
    guardJSON = null;
    const base = !J ? -1 : opens ? 0 : savepoint();
    let changed, json;
    try {
      changed = act(p, a, base);
      if (J && host.rules?.enabled) json = settle();
      if (json === null) changed = bump();
      syncSpots(); // (the addresses a board's change moved, read now: a Worker's patch carries them)
      noteDraws();
      flushRuns();
    } catch (err) {
      if (J) rollbackTo(Math.max(base, 0)); // (an engine bug: the job leaves nothing behind)
      if (opens) J = null;
      throw err;
    }
    if (opens) lastPatch = commit(wantPatch, json ?? undefined);
    return changed;
  }
  /** The jobs that touch the catalog or lay a box out: always in a journal,
   *  so a check that fails halfway undoes it all (atomic). */
  const BOX_JOBS = ['setup', 'reset', 'loadBox', 'addBox'];
  /** The fields of an action only the host sets (spec §3c, §3e, D117):
   *  whatever a payload says of them is dropped before anything reads it —
   *  `to` too, except on `owner`, whose `to` names the new owner (§2c). */
  const HOST_SET = ['from', 'pick', 'handled'];
  /** Action `a` of player p as the hooks and the default effect see it (spec
   *  §3c): a copy whose `to` is the display address the piece it places
   *  would snap to — the moved piece, or for take, split, play and a deal
   *  from a piece pile the PROSPECTIVE new one, in its type's size (its
   *  back's when hidden) — or absent (act dropped the payload's: it is
   *  advisory); whose `from` is where the moved piece (or the stack split)
   *  was; and for a pull, `pick`: the member it draws (drawFrom), drawn now,
   *  which the default effect then takes. Pure but for that draw. */
  function prepare(p, a) {
    const o = { ...a }, it = own(host.items, a.id), pl = own(host.players, p), top = it?.k === 'p' && it.cards.at(-1);
    let piece = null, at = it && nextTo(it);
    if (a.t === 'move' && it && isPiece(it)) [piece, at] = [it, it];
    else if (a.t === 'take' && it?.k === 's' && a.hand !== true) piece = { k: 'g', t: it.t, f: it.f, ...(it.up === false && { up: false }) };
    else if (a.t === 'pull' && it?.k === 'b' && it.of.length) {
      o.pick = drawFrom(a.id, it);
      const m = it.of[o.pick];
      if (a.hand !== true) piece = { k: 'g', t: m.t, f: m.f, ...(m.up === false && { up: false }) };
    } else if (a.t === 'split' && it?.k === 'g' && it.n >= 2 && a.onto === undefined) piece = it;
    else if (a.t === 'deal' && top && !isCard(top)) piece = { k: 'g', t: top.t, f: top.f, ...(!a.up && !mustShow(top.t) && { up: false }) }; // (as opDealTop deals it)
    else if (a.t === 'play') {
      const c = pl && pl.hand[handIdx(pl, a)];
      if (c && !isCard(c)) {
        piece = { k: 'g', t: c.t, f: c.f, ...(a.up === false && !mustShow(c.t) && { up: false }) };
        at = { x: host.table.w / 2 - size(piece).w / 2, y: host.table.h / 2 - size(piece).h / 2 };
      }
    }
    if ((a.t === 'move' || a.t === 'split') && it?.at) o.from = display(it.at);
    if (piece && isPiece(piece)) {
      const s = snapPiece(piece, num(a.x, at.x), num(a.y, at.y));
      if (s.at) o.to = display(s.at);
    }
    return o;
  }
  const drawn = new Map(); // bag id → the member its next pull takes, {k: its index, m: its "t|f|up"} (drawFrom)
  const memberKey = (m) => `${m.t}|${m.f}|${m.up === false}`;
  /** The index of the member of bag `id` (`bag`) its next pull takes: the
   *  one drawn for a pull that did not happen (a veto, a refusal) while it is
   *  still in the bag, else a fresh draw (randInt), kept until a pull takes
   *  it (opPull). A pull's a.to is where THAT member lands (by its own size),
   *  so a veto that redrew would let a guest aim her pulls where only the
   *  size she wants snaps, and fish the bag for it (D114). The member is
   *  kept by what it is, not by reference: a rollback puts back a copy of
   *  the bag (and two members alike are one and the same draw). */
  function drawFrom(id, bag) {
    const d = drawn.get(id);
    if (d) {
      const k = memberKey(bag.of[d.k] ?? {}) === d.m ? d.k : bag.of.findIndex((m) => memberKey(m) === d.m);
      if (k >= 0) return k;
    }
    const k = rint(bag.of.length);
    drawn.set(id, { k, m: memberKey(bag.of[k]) });
    return k;
  }
  /** A live drag (spec §3c, `drag`): player p's piece, or group, on its way —
   *  {id, x, y} or {ids (the first MAX_GROUP), dx, dy} — for the other
   *  screens to show. It changes nothing, and runs no hook: what p may move
   *  (mayHandle and notLocked, checked quietly — a refusal of live traffic
   *  is a console.warn, never a notice) goes out as one fx {p, id, x, y,
   *  live: 1} or {p, ids, dx, dy, live: 1}, finite, every member landing on
   *  the table (clampShift, D118). True when one was queued. */
  function drag(p, a) {
    const ok = (id) => {
      const it = typeof id === 'string' && own(host.items, id);
      if (it && (!it.owner || resolveOwner(it.owner) === p) && !it.lock) return it;
      console.warn('drag: not relayed', id, 'from', p);
      return null;
    };
    if (Array.isArray(a.ids)) {
      const ids = [...new Set(a.ids.slice(0, MAX_GROUP))].filter(ok);
      if (!ids.length) return false;
      // (the group's shift, cut so that every member lands on the table: clampShift)
      const cs = ids.map((id) => { const it = host.items[id], { w, h } = size(it); return [it.x + w / 2, it.y + h / 2]; });
      emit({ t: 'fx', f: { p, ids, ...clampShift(host.table, cs, num(a.dx), num(a.dy)), live: 1 } });
      return true;
    }
    const it = ok(a.id);
    if (!it) return false;
    const { w, h } = size(it), q = clampToTable(host.table, num(a.x, it.x), num(a.y, it.y), w, h);
    emit({ t: 'fx', f: { p, id: a.id, x: q.x, y: q.y, live: 1 } });
    return true;
  }
  /** What player p's `answer` ({id, v}) answers (spec §3c): {ask, value}
   *  when the rules are on, an ask with that id is pending for p, and v is
   *  something it offered — an option's index (the value: that option's
   *  value), an item of `among` still on the table (its id), an address of
   *  `among` in any form (its display form), exactly `count` distinct
   *  entries of p's hand as {idx, d, i} or {idx, t, f} (the cards, which stay
   *  in the hand: [{d, i} | {t, f}]), a whole number in [min, max] — else null. */
  function answerOf(p, a) {
    const list = host.rules?.enabled && own(host.rules.asks, p), ask = Array.isArray(list) && typeof a.id === 'string' && list.find((x) => x.id === a.id);
    if (!ask) return null;
    const v = a.v, pl = own(host.players, p);
    if (ask.options) return Number.isInteger(v) && v >= 0 && v < ask.options.length ? { ask, value: ask.options[v].value } : null;
    switch (ask.pick) {
      case 'item': return typeof v === 'string' && ask.among.includes(v) && own(host.items, v) ? { ask, value: v } : null;
      case 'space': {
        const B = tb(), at = typeof v === 'string' && resolveAddr(B, v)?.at;
        return at && ask.among.some((s) => resolveAddr(B, s)?.at === at) ? { ask, value: display(at) } : null;
      }
      case 'hand': {
        if (!pl || !Array.isArray(v) || v.length !== (ask.count ?? 1)) return null;
        const picked = new Set();
        for (const e of v) {
          const k = isObj(e) ? handIdx(pl, 't' in e ? { idx: e.idx, type: e.t, f: e.f } : e) : -1;
          if (k < 0 || picked.has(k)) return null;
          picked.add(k);
        }
        return { ask, value: [...picked].map((k) => { const c = pl.hand[k]; return isCard(c) ? { d: c.d, i: c.i } : { t: c.t, f: c.f }; }) };
      }
      default: return Number.isInteger(v) && v >= ask.min && v <= ask.max ? { ask, value: v } : null; // ('number')
    }
  }
  /** The actions prepare() fills in. */
  const PREPARED = new Set(['move', 'take', 'pull', 'split', 'play', 'deal']);
  /** The ruled-action pipeline (spec §3f.4) for player p's action `a`, in a
   *  job whose journal reaches back to savepoint `base` (-1: no journal: the
   *  rules are off). A ruled action, with the rules on: p's hint is cleared,
   *  then handle(t, A) — a string vetoes (its ops are rolled back), true
   *  handles it (its ops kept, no default effect), anything else goes on —
   *  then the `strict` refusal, validate(t, A), and the default effect. A
   *  handled action re-sends what it names, as a refusal does (the actor's
   *  optimistic drop shows where the script left the piece). Any other
   *  action: its default effect. Then a checkpoint, and the hooks the action
   *  implies (onJoin, onLeave, onTimer, onChat, onButton, onAnswer, onSelect,
   *  setup), onAction (after a ruled action that took effect or was
   *  handled — A.handled — and after chat, rulesBtn and answer), and
   *  buttons(). A hook that throws or returns a thenable disables the rules:
   *  handle or validate fail CLOSED (nothing of the action applies), any
   *  later one is undone back to the checkpoint (the action's own effect is
   *  kept). A is `a` as the hooks see it: a frozen copy, with p, to, from,
   *  pick (and handled). True when the table changed. */
  function act(p, a, base) {
    a = { ...a };
    for (const k of a.t === 'owner' ? HOST_SET : [...HOST_SET, 'to']) delete a[k];
    syncSpots(); // (an address read from here on is where each piece now lies: D106)
    if (J) J.cp = base;
    let A0; // (built once, when a hook first needs it: `a` is prepared by then)
    const pl = own(host.players, p), ruled = RULED_ACTIONS.includes(a.t), A = () => (A0 ??= frozen({ ...a, p }));
    let handled = false;
    if (ruled && host.rules?.enabled) {
      const h = host.rules.hints;
      if (h && own(h, p)) delete h[p]; // (journaled: a veto puts it back)
      if (PREPARED.has(a.t)) a = prepare(p, a);
      const failClosed = (hook, err) => { rollbackTo(base); hookFailed(hook, err); return veto(p, a, 'rules script error'); };
      const vetoed = (why) => { rollbackTo(base); return veto(p, a, why); };
      let r = tryHook('handle', A());
      if (r.err) return failClosed('handle()', r.err);
      if (typeof r.v === 'string' && r.v) return vetoed(r.v);
      handled = r.v === true;
      if (!handled) {
        const allow = hooks.flag?.('allow');
        if (hooks.flag?.('strict') === true && STRICT_ACTIONS.includes(a.t) && !(Array.isArray(allow) && allow.includes(a.t))) return vetoed('Not a move in this game');
        r = tryHook('validate', A());
        if (r.err) return failClosed('validate()', r.err);
        if (typeof r.v === 'string' && r.v) return vetoed(r.v);
      }
    } else if (PREPARED.has(a.t)) a = prepare(p, a);
    if ((a.t === 'chat' || a.t === 'name' || a.t === '_name') && !mayTalk(p)) {
      console.warn(`flood control: dropped a ${a.t} from`, p);
      notify(p, '🚫 Slow down — at most 5 messages or renames per 5 seconds');
      return false;
    }
    // Every op that takes effect mark()s it, so the mark count growing during
    // the default effect is the "it really happened" signal for onAction: a
    // no-op (a card not in hand, a vanished item) or a refusal never reaches
    // the script, and for the ones that did happen the payload's ids were matched host-side.
    const fx0 = marks, then = handled ? [] : effect(p, a, pl, A);
    if (!then) return false; // (refused before anything happened: no hook, no new state)
    const took = marks > fx0;
    // A ruled action that did nothing (refused, or its target had just gone: a
    // pile merged away under a drop), or that the script handled, re-sends what
    // it named: the actor's screen still shows its optimistic move, and deltas
    // carry only what is marked.
    if (ruled && (handled || !took)) touchNamed(p, a);
    if (!host.rules?.enabled) return bump();
    // The checkpoint: what is kept even if a later hook fails. Its gates
    // (data's size, secret, asks) already hold unless handle or validate broke them.
    let bad;
    try {
      J.cp = savepoint();
      bad = jobHooks.length && gateProblem(J.frames[J.cp].json, J.frames[base].json);
    } catch (err) { bad = `the rules' state is not JSON (${err.message})`; }
    if (bad) { rollbackTo(base); hookFailed(hooksSince(base), new Error(bad)); return ruled ? veto(p, a, 'rules script error') : bump(); }
    if (ruled && (took || handled)) then.push(['onAction', handled ? frozen({ ...a, p, handled: true }) : A()]);
    for (const [hook, ...args] of [...then, ['buttons']]) afterHook(hook, ...args);
    return bump();
  }
  /** The default effect of action `a` of player p (the op switch, shared by
   *  every path: no hook runs here): the hooks it implies, to run after the
   *  checkpoint ([[hook, ...args]]), or null when it was refused before
   *  anything happened (no hook, no new state). `A()` builds the frozen
   *  action the hooks see. */
  function effect(p, a, pl, A) {
    const items = host.items, it = own(items, a.id);
    const then = [];
    switch (a.t) {
      case 'name': case '_name': { // (_name: the rename a new connection brings, spec §3c)
        const name = cleanName(a.name);
        if (pl && name && name !== pl.name) {
          const old = pl.name;
          touchPlayer(p);
          pl.name = name;
          logEvent(p, `is now known as "${name}"`, { as: old }); // shown under the OLD name
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
        addDeckTo(deckId, deck);
        emit({ t: 'deck', id: deckId });
        const pile = { k: 'p', rot: 0, name: deck.name, cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })) };
        place(pile, num(a.x, host.table.w / 2 - CARD_W / 2), num(a.y, host.table.h / 2 - CARD_H / 2));
        const nid = put(mint(items), pile);
        logEvent(p, `added deck "${deck.name}" (${deck.cards.length} cards)`, { keep: true });
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
        if (!it.cards.length || !handRoom(p, p)) break;
        touchPlayer(p, { hand: true });
        touch(a.id);
        const c = it.cards.pop();
        pl.hand.push(entryOf(c));
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
        if (!pileRoom(p, pile)) break;
        touchPlayer(p, { hand: true });
        touch(a.pile);
        pl.hand.splice(idx, 1);
        // A card discarded onto a pile matches the pile's exposed face
        // (face up onto a face-up pile, face down onto a deck).
        const up = (top?.up ?? false) || (!isCard(c) && mustShow(c.t));
        pile.cards.push(isCard(c) ? { d: c.d, i: c.i, up } : { t: c.t, f: c.f, up });
        logEvent(p, `put ${up ? (isCard(c) ? cardName(host.decks, c.d, c.i) : oneLabel({ t: c.t, f: c.f })) : `a ${isCard(c) ? 'card' : 'piece'} face down`} from hand onto ${label(pile)}`);
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
        logEvent(p, it.k === 'c' ? 'peeked at a face-down card' : `peeked at the top ${card ? 'card' : 'piece'} of ${label(it)}`, { loud: true });
        mark(p, a.id);
        emit({ t: 'peek', p, c: card ? { d: c.d, i: c.i } : { t: c.t, f: c.f } });
        break;
      }
      case 'roll': opRoll(p, a.ids); break; // (any other field — a forged `f` — is ignored)
      case 'face': opFace(p, a.id, a.f); break;
      case 'split': opSplit(p, a.id, a.n, a.x, a.y, a.onto); break;
      case 'join': opJoin(p, a.id, a.onto); break;
      case 'take': opTake(p, a.id, a.x, a.y, a.hand === true); break;
      case 'pull': opPull(p, a.id, a.x, a.y, a.hand === true); break; // (the member prepare drew: drawFrom)
      case 'toBag': opToBag(p, a.id, a.bag); break;
      case 'lock': if (typeof a.on === 'boolean') opLock(p, a.id, a.on); else no(p, '🚫 Say lock or unlock (on: true or false)'); break;
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
      case 'setup': case 'reset': if (!hostOnly(p, a) || !setupBox(p, a)) return null; break;
      case 'addBox': addBox(p, a); break;
      case 'clear': if (hostOnly(p, a)) clearTable(p); break;
      case 'chat': {
        const msg = chatLine(a.msg);
        if (pl && msg) logEvent(p, msg, { chat: true });
        then.push(['onChat', peerText(a.msg), p], ['onAction', A()]);
        break;
      }
      case 'setRules': {
        if (p !== pid) return null; // only the host configures rules
        if (!a.enabled) {
          if (!host.rules?.enabled) return null;
          host.rules.enabled = false;
          emit({ t: 'rules' });
          logEvent(RULES, `rules disabled by ${pl?.name || 'the host'}`);
          break;
        }
        let name;
        try { name = hooks.load(a.code); } catch (err) {
          // load() installs a script only once it evaluated: whatever rules were running keep running.
          console.error('rules script failed to load', err);
          lastRulesError = err.message;
          emit({ t: 'toast', msg: cut(`Rules error: ${err.message}${host.rules?.enabled ? ' — the running rules are unchanged' : ''}`) });
          return null;
        }
        // Re-enabling the same game (after a fix, a Disable or a script
        // error) keeps its state — chips, scores, timers, each player's asks
        // and secret — unless the host ticked "Reset game state"; setup()
        // runs again either way. Hints start afresh. A fresh state may be
        // seeded from `a.state` (an exported game's: seedState), and the
        // rules may be a box's (`a.box`, whose rules are this code: a Reset
        // of that box restarts them, rules.box).
        const prev = host.rules?.name === name ? host.rules : null, keep = prev && !a.reset;
        // Another game's state (chips, scores, a hand in progress) is lost: say so.
        const lost = keep ? ' (game state kept)' : prev ? ' (game state reset)' : host.rules ? ` («${host.rules.name}» game state discarded)` : '';
        const st = keep ? prev : isObj(a.state) ? seedState(a.state, a.remap) : {}, box = typeof a.box === 'string' && own(host.boxes, a.box)?.rules === a.code ? a.box : null;
        host.rules = { code: a.code, name, enabled: true, data: st.data ?? {}, public: st.public ?? {}, asks: st.asks ?? {}, secret: nullProto(st.secret ?? null), hints: {}, ...(box && { box }) };
        emit({ t: 'rules' });
        lastRulesError = '';
        logEvent(RULES, `«${name}» enabled by ${pl?.name || 'the host'}${lost}`);
        then.push(['setup']);
        break;
      }
      case 'rulesBtn': {
        // The engine enforces what the script offered: a button the player
        // can't see (another player's, or one that just went away) is refused.
        const b = (host.rules?.enabled && host.rules.public.buttons || []).find((x) => x.id === peerText(a.id));
        if (!b || (b.pid && b.pid !== p)) { // nothing happened: no hooks, no new state
          console.warn('refused rules button', a.id, 'from', p);
          notify(p, '🚫 That button is not available to you right now');
          return null;
        }
        then.push(['onButton', b.id, p], ['onAction', A()]);
        break;
      }
      case 'answer': { // (spec §3c: only the asked player, a pending id, an offered value — else no hook, and the ask stays)
        const got = answerOf(p, a);
        if (!got) {
          console.warn('refused an answer', a.id, 'from', p);
          notify(p, "🚫 That answer wasn't offered");
          return null;
        }
        const r = host.rules, rest = r.asks[p].filter((x) => x !== got.ask);
        if (rest.length) r.asks[p] = rest;
        else delete r.asks[p];
        logEvent(p, 'answered'); // (never the value: the ask was private)
        then.push(['onAnswer', p, got.ask.id, got.value], ['onAction', A()]);
        break;
      }
      case 'select': { // (spec §3c: no state of its own; at most SELECT_PER_SEC a second; never a piece hidden from p)
        const why = !host.rules?.enabled || !hooks.has('onSelect') ? 'the rules want no selections'
          : !pl ? 'not a player' : !it ? 'no such item' : hiddenFrom(p, it) ? 'hidden from them'
            : !flood(selects, p, SELECT_PER_SEC, SELECT_PER_SEC) ? `more than ${SELECT_PER_SEC} a second` : '';
        if (why) { console.warn(`dropped a select (${why})`, a.id, 'from', p); return null; }
        then.push(['onSelect', p, a.id]);
        break;
      }
      case '_join': { // player p's first keyed action while not online (spec §3c): seated, named, logged, onJoin
        if (typeof p !== 'string' || !PID_RE.test(p)) { console.error('_join: refused an invalid player id', p); return null; }
        const back = !pl?.online, changed = ensurePlayer(p, a.name);
        if (!back) return changed ? then : null;
        logEvent(p, pl ? 'is back at the table' : 'joined the table');
        then.push(['onJoin', p]);
        break;
      }
      case '_leave': { // player p's last connection closed
        if (!pl) return null;
        touchPlayer(p);
        pl.online = false;
        logEvent(p, 'left the table');
        then.push(['onLeave', p]);
        break;
      }
      case '_tick': { // the timers that are due (t.schedule, by the table's clock): out of the list, then onTimer for each
        const timers = host.rules?.enabled && host.rules.data._timers;
        if (!timers?.length) return null;
        const ts = now(); // one clock reading, so no timer falls between the two filters
        const due = timers.filter((x) => x.at <= ts);
        if (!due.length) return null;
        host.rules.data._timers = timers.filter((x) => x.at > ts);
        then.push(...due.map((x) => ['onTimer', x.tag]));
        break;
      }
      case '_rulesOff': { // the watchdog, a crash (spec §3f.5)
        if (!host.rules?.enabled) return null;
        host.rules.enabled = false;
        emit({ t: 'rules' });
        logEvent(RULES, `rules disabled — ${peerText(a.reason).slice(0, 200)}`);
        break;
      }
      default: console.warn('unknown action', a); return null;
    }
    return then;
  }

  // --- players come and go ---------------------------------------------------
  /** Binds seat key `key` to player p (a valid player id) on first contact —
   *  older saves adopt their first claimant: true when it did (the save must
   *  keep it). Host-side and synchronous: the app checks a key and binds it
   *  in the same step, so two claims of one seat can't both pass; keys never
   *  leave the host (nor reach a rules Worker). */
  const bindKey = (p, key) => !!key && !own(host.keys, p) && !!(host.keys[p] = key);
  /** Registers player p, who just sent an action with this name and seat
   *  key: binds the key (bindKey), and — when p is new, was offline or has no
   *  name yet — runs the `_join` job (seated, named, "joined the table",
   *  onJoin). Returns the player as it was before (null if new), whether
   *  they're back (new, or were offline) and whether the table changed (it
   *  was renumbered: broadcast and save). An id that isn't a player id
   *  (PID_RE: never "__proto__") is refused. */
  function join(p, name, key) {
    if (typeof p !== 'string' || !PID_RE.test(p)) { console.error('join: refused an invalid player id', p); return { known: null, back: false, changed: false }; }
    const known = own(host.players, p), back = !known?.online, keyed = bindKey(p, key);
    const ran = (back || !known.name) && apply(p, { t: '_join', name });
    if (keyed && !ran) bump();
    return { known, back, changed: keyed || ran };
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
   *  as a "?", and is said, as is an item or a player createTable couldn't
   *  read (dropped). A z order past Z_MAX starts again from 1, in its order.
   *  A saved rules script that no longer loads disables the rules loudly
   *  rather than wedging the resume. */
  function resume(name) {
    const decks = {}, boxes = {}; // fresh maps: a corrupt save may hold a string or an array here
    for (const [id, d] of Object.entries(host.decks)) {
      try { decks[id] = cleanDeck(d); } catch (err) { console.error(`saved deck ${id} dropped`, err); }
    }
    let dropped = 0;
    for (const [id, b] of Object.entries(host.boxes)) {
      try { boxes[id] = cleanBox(b); } catch (err) { dropped++; console.error(`saved box ${id} dropped`, err); }
    }
    host.decks = decks;
    host.boxes = boxes;
    boxIndex = null;
    // (store.js drops a box record it can't read before this: its pieces are counted here)
    const lost = Object.values(host.items).filter((it) => (it.k === 'g' || it.k === 's') && !typeOf(it.t)).length;
    const n = (k, one, many) => (k === 1 ? one : `${k} ${many}`);
    const msgs = [
      lost ? `${n(lost, 'A piece', 'pieces')} of this table belong${lost === 1 ? 's' : ''} to a game box that is missing or unreadable: shown as "?"`
        : dropped && `${n(dropped, 'A saved game box', 'saved game boxes')} couldn't be read: dropped`,
      (unread.item || unread.player) && `${[unread.item && n(unread.item, 'A saved item', 'saved items'), unread.player && n(unread.player, 'a saved player', 'saved players')].filter(Boolean).join(' and ')} couldn't be read: dropped`,
    ].filter(Boolean);
    if (msgs.length) {
      const msg = msgs.map((m) => m[0].toUpperCase() + m.slice(1)).join(' — ');
      console.error(msg);
      emit({ t: 'toast', msg });
    }
    if (host.zMax > Z_MAX) { // (a lie's leftover, or a hand-edited save: the order stays, the numbers start again)
      const tops = Object.values(host.items).filter((it) => it.z >= 0).sort((a, b) => a.z - b.z);
      console.error(`the saved z order reached ${host.zMax}: ${tops.length} items renumbered from 1, in their order`);
      tops.forEach((it, k) => { it.z = k + 1; });
      host.zMax = tops.length;
    }
    if (host.rules?.code) {
      try {
        hooks.load(host.rules.code);
        emit({ t: 'rules' });
      } catch (err) {
        console.error('saved rules script failed to load', err);
        lastRulesError = err.message;
        host.rules.enabled = false;
        emit({ t: 'toast', msg: cut(`Saved rules failed to load: ${err.message}`) });
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
    for (const id of Object.keys(host.items)) touch(id); // (all re-read: the boxes are fresh copies — the boards' structures too)
    tbSig = null;
    tbVer++;
    pullOn(0, 0);
    ensurePlayer(pid, name);
    logEvent(pid, 'resumed the table');
    bump();
  }

  // --- the engine around the script ------------------------------------------
  const FIND_KEYS = ['kind', 'name', 'up', 'type', 'owner', 'zone', 'at'];
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
  /** A script's own copy of item `id`: changing it never changes the table (its address in the display form). */
  function copyItem(id, it) {
    const at = addrNow(it);
    return { id, ...it, ...(it.cards && { cards: it.cards.map((c) => ({ ...c })) }), ...(it.of && { of: it.of.map((m) => ({ ...m })) }), ...(at && { at }) };
  }
  /** Calls hook `name` with the facade (when the rules are on and the script
   *  has it): {v: what it returned}, or {err} when it threw — or returned a
   *  thenable (an async hook, a Promise): hooks are synchronous, and a veto
   *  that comes later would let the action pass unread (spec §3e). {} when
   *  no such hook runs. */
  function tryHook(name, ...args) {
    if (!host.rules?.enabled || !hooks.has(name)) return {};
    jobHooks.push(name);
    inHook++;
    try {
      const v = hooks.call(name, tApi, ...args);
      if (typeof v?.then === 'function') throw new Error('hooks must be synchronous (it returned a thenable: an async hook, or a Promise)');
      return { v };
    } catch (err) { return { err }; } finally { inHook--; }
  }
  const jobHooks = []; // the hooks the current job ran, in order (the names a failure gives)
  let inHook = 0; // a hook is running (T.inHook)
  /** The hooks run since savepoint `token`, as a failure names them: "onButton(), onAction()". */
  const hooksSince = (token) => [...new Set(jobHooks.slice(J.frames[token]?.hooks ?? 0))].map((h) => `${h}()`).join(', ') || 'the rules';
  /** A hook after the checkpoint (spec §3f.4): it runs, and buttons() fills
   *  the button row (t.public.buttons); a throw or a thenable undoes
   *  everything since the checkpoint and disables the rules (FAIL): the
   *  action's own effect stays. */
  function afterHook(name, ...args) {
    const r = tryHook(name, ...args);
    try {
      if (r.err) throw r.err;
      if (name === 'buttons' && 'v' in r) host.rules.public.buttons = (r.v || []).map((b) => ({ id: String(b.id), label: String(b.label).slice(0, 30), ...(b.pid ? { pid: b.pid } : {}) }));
    } catch (err) {
      rollbackTo(J.cp);
      hookFailed(`${name}()`, err);
    }
  }
  /** A ruled action refused by the rules (a veto, `strict`, a failed hook),
   *  after its rollback: on the record ("blocked Bob: …"), said to the actor,
   *  and what it named re-sent, so their optimistic move snaps back. */
  function veto(p, a, why) {
    why = String(why).slice(0, 300); // (a script's words: as long as t.say's)
    touchNamed(p, a);
    logEvent(RULES, `blocked ${own(host.players, p)?.name || 'a player'}: ${why}`);
    notify(p, `🚫 ${why}`);
    return bump();
  }
  /** Why the rules' state `json` (rulesJSON) fails the engine's gates (spec
   *  §3a), or '': t.data at most DATA_MAX_CHARS; the values in t.data,
   *  t.public and t.secret (VALUE_FIELDS, valueProblem) — a function too in
   *  a field whose JSON is as it was at `was` (the patch won't carry that
   *  field, so the Worker's failed post, D129, can't say it); the asks (only
   *  written by t.ask) through cleanAsk again when they changed since `was`. */
  function gateProblem(json, was) {
    const n = json.data.length;
    if (n > DATA_MAX_CHARS) return `t.data is too large (${n.toLocaleString('en-US')} chars, max ${DATA_MAX_CHARS.toLocaleString('en-US')})`;
    for (const k of VALUE_FIELDS) { const why = valueProblem(k, json[k] === was?.[k]); if (why) return why; }
    if (json.asks !== was?.asks) { const why = asksProblem(host.rules.asks); if (why) return `t.ask: ${why}`; }
    return '';
  }
  /** The rules' fields a script writes to directly, as objects. */
  const VALUE_FIELDS = ['data', 'public', 'secret'];
  /** Why rules field `k` (VALUE_FIELDS) holds what JSON would not keep as
   *  it is, or '' — checked on every job, every entry (D133, D144): a JSON
   *  comparison can't see a Date over its own ISO string, a Map over {}, NaN
   *  over null, or a function JSON skips, yet a rollback, a save or a patch
   *  would turn each into something else. t.data and t.public: plain JSON
   *  (notJSON; a function there is D129's — a Worker can't post it, and the
   *  rules go off keeping the JSON part — unless `fns`: it is refused here);
   *  t.secret: no prototype of its own, keyed by player ids, each entry
   *  plain JSON of at most SECRET_MAX_CHARS. */
  function valueProblem(k, fns = false) {
    const v = host.rules[k];
    if (k !== 'secret') return notJSON(v, `t.${k}`, !fns);
    if (!isObj(v) || Object.getPrototypeOf(v) !== null) return 't.secret was replaced or given a prototype — set and delete its entries instead';
    for (const p of Object.keys(v)) { const why = secretProblem(p, v[p]); if (why) return why; }
    return '';
  }
  /** A job's final gates while the rules are on (spec §3f.4): the timers
   *  (gateTimers), then gateProblem. Returns the rules' state as JSON, ready
   *  to commit — or, when a gate fails, null, having undone every hook since
   *  the checkpoint and disabled the rules, naming those hooks. */
  function settle() {
    gateTimers(host.rules);
    let json, bad;
    try {
      json = rulesJSON();
      bad = gateProblem(json, J.frames[0].json);
    } catch (err) { bad = `the rules' state is not JSON (${err.message})`; }
    if (!bad) return json;
    const names = hooksSince(J.cp);
    rollbackTo(J.cp);
    hookFailed(names, new Error(bad));
    return null;
  }
  /** A script error (`where`: the hooks, as "validate()", or the state at
   *  fault): disable the rules, loudly and on the record. */
  function hookFailed(where, err) {
    const msg = String(err instanceof Error ? err.message : err); // (a script's error class may make its message anything)
    console.error(`rules: ${where} failed`, err);
    lastRulesError = `${where}: ${msg}`;
    jobError = { hook: where, message: msg };
    host.rules.enabled = false;
    emit({ t: 'rules' });
    logEvent(RULES, `rules disabled — script error in ${where}`);
    emit({ t: 'toast', msg: cut(`Rules disabled — error in ${where}: ${msg}`) });
  }
  /** The script broke the rules of running from outside a hook (`why`: a
   *  facade call, or t.data changed between jobs: spec §3f.7) — the rules
   *  disable loudly, as a job of their own (_rulesOff). */
  function rulesOff(why) {
    console.error(`rules: ${why}`);
    lastRulesError = why;
    emit({ t: 'toast', msg: cut(`Rules disabled — ${why}`) });
    apply(RULES, { t: '_rulesOff', reason: why });
  }
  /** The job's t.random() draws, on the record in one line. */
  function noteDraws() {
    if (draws) logOp(RULES, 'random', `used randomness (${draws} draw${draws > 1 ? 's' : ''})`, draws);
    draws = 0;
  }
  /** The save (or a Worker's post) couldn't copy the rules' state: t.data or
   *  t.public hold something that isn't data (a function, a DOM node — they
   *  must stay JSON). The rules disable loudly, and both keep their JSON
   *  part (t.secret too, though its gate keeps it JSON already), which
   *  is all a save ever kept of them. True: a change (renumbered). */
  function unsaveable(why) {
    if (!host.rules) return false;
    for (const k of ['data', 'public', 'secret']) {
      try { host.rules[k] = JSON.parse(JSON.stringify(host.rules[k] ?? {})); } catch (err) {
        console.error(`t.${k} has no JSON form: emptied`, err);
        host.rules[k] = {};
      }
    }
    host.rules.secret = nullProto(host.rules.secret);
    lastJSON = null;
    if (host.rules.enabled) hookFailed('t.data / t.public', new Error(`they hold a value that can't be saved (${why}) — keep them JSON`));
    return bump();
  }

  /** The rules' state `st` an exported game carried ({data, public, asks,
   *  secret}), made this table's (spec §4c): the ids that had to change
   *  (`remap`: old → new) and "@#k" (the k-th seated player, seated()) put
   *  in, then the engine's gates (§3a) — t.data and t.public plain JSON,
   *  t.data within DATA_MAX_CHARS and its _timers (gateTimers), t.secret's
   *  keys and values (secretProblem), the asks (cleanAsk, ASK_MAX, one id
   *  once). An entry that fails a gate, or keyed by someone who isn't at the
   *  table (a pid an export couldn't name, an "@#k" past the seated players),
   *  is dropped with console.error, and the host told once for each kind. */
  function seedState(st, remap) {
    const ranked = seated(), here = (q) => !!own(host.players, q);
    const s = mapIds(st, (x) => { const r = isObj(remap) && own(remap, x); return typeof r === 'string' ? r : /^@#[1-9]\d*$/.test(x) ? ranked[+x.slice(2) - 1] ?? x : x; });
    let bad = 0, away = 0;
    const drop = (why, err) => console.error(`saved game state: ${why} — dropped`, ...(err ? [err] : []));
    const out = { asks: {}, secret: nullProto(null) };
    for (const k of ['data', 'public']) {
      const v = s[k] ?? {}, why = !isObj(v) ? `t.${k} is not an object` : notJSON(v, `t.${k}`) || (k === 'data' && JSON.stringify(v).length > DATA_MAX_CHARS ? 't.data is too large' : '');
      if (why) { bad++; drop(why); }
      out[k] = why ? {} : v;
    }
    const timers = out.data._timers;
    gateTimers(out);
    if (timers !== undefined && JSON.stringify(timers) !== JSON.stringify(out.data._timers)) bad++;
    for (const [q, v] of Object.entries(isObj(s.secret) ? s.secret : {})) {
      const why = !here(q) ? `a secret for ${JSON.stringify(q.slice(0, 30))}, who isn't at this table` : secretProblem(q, v);
      if (why) { if (here(q)) bad++; else away++; drop(why); } else out.secret[q] = v;
    }
    for (const [q, list] of Object.entries(isObj(s.asks) ? s.asks : {})) {
      if (!here(q) || !Array.isArray(list)) { if (here(q)) bad++; else away++; drop(`the asks of ${JSON.stringify(q.slice(0, 30))}${here(q) ? ' are not a list' : ", who isn't at this table"}`); continue; }
      const kept = [];
      for (const x of list) {
        try {
          const ask = cleanAsk(x);
          if (kept.length >= ASK_MAX || kept.some((y) => y.id === ask.id)) throw new TypeError(kept.length >= ASK_MAX ? `more than ${ASK_MAX} asks` : `id ${ask.id} twice`);
          kept.push(ask);
        } catch (err) { bad++; drop(`an ask for ${q}`, err); }
      }
      if (kept.length) out.asks[q] = kept;
    }
    if (bad) emit({ t: 'toast', msg: 'Some saved game state was invalid and was dropped' });
    if (away) emit({ t: 'toast', msg: "Some saved state referred to players who weren't seated; it was dropped" });
    return out;
  }

  /** Sends a private text notice to a player (toast on their screen). Each
   *  costs a signature: a guest gets at most a burst of 10, then 5 per second. */
  function notify(p, msg) {
    if (p !== pid && !flood(notes, p, 10, 5)) { console.warn('notice dropped (flood control)', p, msg); return; }
    emit({ t: 'note', p, msg: cut(msg) });
  }

  // --- flood control (host) -----------------------------------------------------
  const acts = new Map(), notes = new Map(), selects = new Map(); // player id → token bucket (see flood)
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

  /** The [id, item] pairs t.find(q) looks at, from the indexes: the pieces
   *  at an address (byAt) or in zones (byZone) when q names them, else the
   *  items of one type (byType) when it names a 'box/type', else those of
   *  q's `owners` (byOwner) when it names one, else those of its item kinds (byKind). */
  function* candidates(q, kinds, owners, at, zones) {
    const sets = at ? [byAt.get(at)] : zones ? zones.map((z) => byZone.get(z))
      : typeof q.type === 'string' && q.type.includes('/') ? [byType.get(q.type)] : owners && owners.map((o) => byOwner.get(o));
    if (!sets) { for (const k of kinds) yield* ofKind(k); return; }
    for (const set of sets) {
      for (const id of set || []) {
        const it = own(host.items, id);
        if (!it) console.error(`an index holds ${id}, which the table doesn't: was state.items changed directly?`);
        else if (kinds.includes(it.k)) yield [id, it];
      }
    }
  }
  /** The qualified zones t.find's `zone` names: "<zone id>" on any board,
   *  or "<board>:<zone id>" ("<typeId>[#n]" or a board's item id); a
   *  TypeError when no board has it. */
  function zonesNamed(z) {
    if (typeof z !== 'string' || !z) throw new TypeError(`t.find: zone must be a zone id, got ${JSON.stringify(z)}`);
    const k = z.indexOf(':'), T = tb(), id = k < 0 ? z : z.slice(k + 1);
    const out = (k < 0 ? T.list : boardsNamed(T, z.slice(0, k))).filter((b) => b.B.zones?.some((x) => x.id === id)).map((b) => `${b.id}:${id}`);
    if (!out.length) throw new TypeError(`t.find: no zone '${z}' on the table's boards`);
    return out;
  }
  /** Whether item `it` (id `id`) matches t.find's query `q` (its keys checked already). */
  function found(id, it, q, name, owners, at, zones) {
    if (at && it.at !== at) return false;
    if (zones && !zones.some((z) => byZone.get(z)?.has(id))) return false;
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

  // --- the facade's arguments (spec §3e: a malformed one throws a TypeError
  // naming the call; an item that vanished is false, with a console.warn) ---
  /** Script item `id` for call `call`: the item, or false when it vanished. */
  function scriptItem(call, id) {
    if (typeof id !== 'string') throw new TypeError(`${call}: an item id must be a string, got ${JSON.stringify(id)}`);
    return own(host.items, id) || gone(call, id);
  }
  /** An owner for a script call: undefined, null (nobody), a player, or "seat:<a named seat>". */
  function scriptOwner(call, o) {
    if (o == null || (typeof o === 'string' && (o.startsWith('seat:') ? seatDef(o.slice(5)) : own(host.players, o)))) return o ?? null;
    throw new TypeError(`${call}: owner must be a player id or 'seat:<a named seat>', got ${JSON.stringify(o)}`);
  }
  /** Where a script puts new item `it`: `at` an address (any form: centred
   *  on its spot), 'center' or undefined (the table's centre, snapping as
   *  any placement does), or {x, y, free?} (a top-left; free: no snapping).
   *  Returns place()'s arguments [x, y, o]. */
  function scriptSpot(call, it, at) {
    const { w, h } = size(it);
    if (at === undefined || at === 'center') return [host.table.w / 2 - w / 2, host.table.h / 2 - h / 2, {}];
    if (typeof at === 'string') { const r = addrOf(call, at); return [r.x - w / 2, r.y - h / 2, isPiece(it) ? { at: r.at } : {}]; }
    if (isObj(at) && Number.isFinite(at.x) && Number.isFinite(at.y)) return [at.x, at.y, { free: at.free === true }];
    throw new TypeError(`${call}: at must be an address, 'center' or {x, y, free?}, got ${JSON.stringify(at)}`);
  }
  /** Piece type `ref` ('box/type') for call `call`, or a TypeError. */
  function scriptType(call, ref) {
    const ty = typeof ref === 'string' && typeOf(ref);
    if (!ty) throw new TypeError(`${call}: unknown piece type ${JSON.stringify(ref)} — name it 'box/type'`);
    return ty;
  }
  /** Face `f` of type `ty` for call `call` (default 0), or a TypeError. */
  function scriptFace(call, ty, f = 0) {
    if (!Number.isInteger(f) || f < 0 || f >= ty.faces.length) throw new TypeError(`${call}: ${ty.name} has faces 0 to ${ty.faces.length - 1}, got ${JSON.stringify(f)}`);
    return f;
  }
  /** The display addresses of local addresses `locals` on board `b`. */
  const displayOn = (b, locals) => locals && locals.map((l) => display(`${b.id}:${l}`));
  /** The deck.json-style decks of a script's box (spec §3e: no images),
   *  checked: [[name, deck (cleanDeck)]]. Each entry {name, text, color, bg,
   *  meta, count} is a card (count: copies, ≤ 500), as an upload's manifest says. */
  function scriptDecks(list) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new TypeError('t.newBox: decks must be a list of {name, back?, cards}');
    if (list.length > MAX_BOX_DECKS) throw new TypeError(`t.newBox: at most ${MAX_BOX_DECKS} decks, got ${list.length}`);
    const names = new Set();
    return list.map((d, k) => {
      if (!isObj(d) || !Array.isArray(d.cards)) throw new TypeError(`t.newBox: decks[${k}] must be {name, back?, cards: [{name, text, color, bg, meta, count}]}`);
      if (d.back != null && !COLOR_RE.test(d.back)) throw new TypeError(`t.newBox: decks[${k}].back must be a colour like "#111" (a script's box has no images)`);
      const name = str(d.name, 24) || 'Deck';
      if (name === '__proto__') throw new TypeError(`t.newBox: decks[${k}] may not be named «__proto__»`);
      if (names.has(name)) throw new TypeError(`t.newBox: two decks are named «${name}»`);
      names.add(name);
      const cards = d.cards.flatMap((c, j) => {
        if (!isObj(c) || c.file !== undefined || c.img !== undefined) throw new TypeError(`t.newBox: decks[${k}].cards[${j}] must be {name, text, color, bg, meta, count} (a script's box has no images)`);
        return Array(clamp(Math.trunc(num(c.count, 1)), 1, 500)).fill({ n: c.name, txt: c.text, col: c.color, b: c.bg, meta: c.meta });
      });
      try { return [name, cleanDeck({ name, back: d.back ?? null, cards })]; } catch (err) { throw new TypeError(`t.newBox: decks[${k}]: ${err.message}`); }
    });
  }

  // The script's window onto the table: full read access, the complete op set
  // (audited as the "📜 Rules" actor), scratch state, and player interaction.
  // Script ops skip the owner and lock checks (scripts own the rules), not the
  // others: a die is still rolled, not flipped; the table still holds MAX_ITEMS.
  const tApi = {
    get data() { return host.rules.data; },
    get public() { return host.rules.public; },
    set public(v) { host.rules.public = v || {}; },
    /** Each player's private script data: `t.secret[pid] = {text, …}` (JSON,
     *  at most SECRET_MAX_CHARS; `text` is what their screen shows), `delete`
     *  to clear it — sent to that player only (spec §3e). Checked as the job
     *  ends: a key that isn't a player id, or an entry too large, fails the hook. */
    get secret() {
      const r = host.rules;
      partsVer++;
      if (Object.getPrototypeOf(r.secret ?? {}) !== null) r.secret = nullProto(r.secret); // (no prototype: see nullProto)
      return r.secret;
    },
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
     *  any box), owner? (a pid also matches 'seat:<their seat>'), at? (an
     *  address, any form), zone? (a zone id, or "<board>:<zone id>")}. */
    find(q = {}) {
      for (const k of Object.keys(q)) if (!FIND_KEYS.includes(k)) throw new TypeError(`t.find: unknown filter '${k}' — known: ${FIND_KEYS.join(', ')}`);
      const kinds = q.kind === undefined ? [...byKind.keys()] : [own(FIND_KINDS, q.kind)];
      if (!kinds[0]) throw new TypeError(`t.find: unknown kind '${q.kind}' — known: ${Object.keys(FIND_KINDS).join(', ')}`);
      const name = q.name === undefined ? null : String(q.name).toLowerCase();
      const seatId = q.owner !== undefined && own(host.players, q.owner)?.seatId;
      const owners = q.owner === undefined ? null : [q.owner, ...(seatId ? [`seat:${seatId}`] : [])];
      syncSpots();
      const at = q.at === undefined ? null : addrOf('t.find', q.at).at, zones = q.zone === undefined ? null : zonesNamed(q.zone), out = [], seen = new Set();
      for (const [id, it] of candidates(q, kinds, owners, at, zones)) if (!seen.has(id) && found(id, it, q, name, owners, at, zones)) { seen.add(id); out.push(copyItem(id, it)); }
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
    /** Moves item `id`: to an address (any form: centred on its spot), to
     *  {x, y, free?} (a top-left; free: no snapping), or as ever to (x, y). */
    move(id, a, b) {
      if (typeof a === 'string' || isObj(a)) {
        const it = scriptItem('t.move', id);
        if (!it) return false;
        const [x, y, o] = scriptSpot('t.move', it, a);
        return opMove(RULES, id, x, y, o);
      }
      return opMove(RULES, id, a, b);
    },
    rot: (id, deg) => opRot(RULES, id, deg),
    /** Removes item `id` — or each of a list of ids, as one log line (a go capture: D167). */
    remove: (id) => eachOf('t.remove', id, (x) => opRemove(RULES, x)),
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
      addDeckTo(deckId, cleanDeck({
        name: def.name, back: def.back,
        cards: (def.cards || []).map((c) => ({ n: c.name, txt: c.text, col: c.color, b: c.bg, meta: c.meta })),
      }));
      emit({ t: 'deck', id: deckId });
      logEvent(RULES, `defined deck "${host.decks[deckId].name}" (${host.decks[deckId].cards.length} cards)`);
      return deckId;
    },
    addStandardDeck(o = {}) {
      if (!cap(RULES)) return false; // before the deck is minted: no orphan deck in the catalog
      const deck = standardDeck(!!o.jokers);
      const deckId = mint(host.decks);
      addDeckTo(deckId, deck);
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
    /** A private notice for player p (a toast on their screen alone). p must
     *  be a player at the table: a notice to nobody (`t.tell(t.data.dealer, …)`
     *  before there is one) is the script's bug, said where it happens (D152). */
    tell(p, msg) {
      if (!own(host.players, p)) throw new TypeError(`t.tell: no player ${String(JSON.stringify(p)).slice(0, 30)}`);
      notify(p, String(msg));
    },
    schedule(sec, tag) {
      if (!Number.isFinite(sec) || sec < 0) throw new Error(`t.schedule: seconds must be a number ≥ 0, got ${sec}`);
      const t = String(tag), list = (host.rules.data._timers ||= []);
      if (t.length > TIMER_TAG_MAX) throw new TypeError(`t.schedule: a tag is at most ${TIMER_TAG_MAX} chars`);
      if (list.length >= MAX_TIMERS) throw new TypeError(`t.schedule: at most ${MAX_TIMERS} timers wait at once`);
      list.push({ at: now() + sec * 1000, tag: t });
    },

    // --- asking players, and their private hints (spec §3e) ----------------------
    /** Asks player `p` a question, answered through onAnswer(t, p, id, value):
     *  `spec` = {id, prompt, options: [label | {label, value}]} or {id, prompt,
     *  pick: 'item' | 'space' (with `among`: ids, addresses) | 'hand' (with
     *  `count`) | 'number' (with min, max)} — see cleanAsk. It replaces p's
     *  pending ask with that id; at most ASK_MAX wait for a player. Persisted
     *  (a host reload asks again); seen by p alone; the log says only that p answered. */
    ask(p, spec) {
      if (!own(host.players, p)) throw new TypeError(`t.ask: no player ${JSON.stringify(p)}`);
      let a;
      try { a = cleanAsk(spec); } catch (err) { throw new TypeError(`t.ask: ${err.message}`); }
      if (a.pick === 'space') a.among = a.among.map((x) => display(addrOf('t.ask', x).at));
      const asks = (host.rules.asks ||= {}), list = own(asks, p) || [], k = list.findIndex((x) => x.id === a.id);
      if (k < 0 && list.length >= ASK_MAX) throw new TypeError(`t.ask: at most ${ASK_MAX} asks wait for a player`);
      partsVer++;
      asks[p] = k < 0 ? [...list, a] : list.map((x, j) => (j === k ? a : x));
    },
    /** Withdraws player p's ask `id`, or with no id all of p's: whether there was any. */
    cancelAsk(p, id) {
      const asks = host.rules.asks || {}, list = own(asks, p), rest = list && (id === undefined ? [] : list.filter((x) => x.id !== id));
      if (!list || rest.length === list.length) return false;
      partsVer++;
      if (rest.length) asks[p] = rest;
      else delete asks[p];
      return true;
    },
    /** Player p's pending asks, copied. */
    asks: (p) => clone(own(host.rules.asks || {}, p) || []),
    /** Highlights for player p alone: {items?: ids, spaces?: addresses (any
     *  form)}, at most HINT_MAX in all — or null to clear. Typically from
     *  onSelect; cleared when p's next ruled action starts (a vetoed one
     *  brings it back). Never saved. */
    hint(p, h) {
      if (!own(host.players, p)) throw new TypeError(`t.hint: no player ${JSON.stringify(p)}`);
      const hints = (host.rules.hints ||= {});
      partsVer++;
      if (h === null) { delete hints[p]; return; }
      if (!isObj(h) || Object.keys(h).some((k) => k !== 'items' && k !== 'spaces')) throw new TypeError('t.hint: give it {items?, spaces?}, or null');
      const { items = [], spaces = [] } = h;
      if (!Array.isArray(items) || !Array.isArray(spaces) || items.some((id) => typeof id !== 'string')) throw new TypeError('t.hint: items is a list of item ids, spaces a list of addresses');
      if (items.length + spaces.length > HINT_MAX) throw new TypeError(`t.hint: at most ${HINT_MAX} items and spaces in all`);
      hints[p] = { items: items.filter((id) => own(host.items, id) || gone('t.hint', id)), spaces: spaces.map((x) => display(addrOf('t.hint', x).at)) };
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

    // --- components from code (spec §3e) ---------------------------------------
    /** Registers a box from `def` = {name?, pieces, backs?, decks?} in the
     *  game.json format (§4a: pieces a list, a board's structure on its
     *  piece; the faces shorthand) — with no images — and returns its id.
     *  Its `decks` (deck.json-style: text cards) are registered as ordinary
     *  decks, named in the box's `decks` ({name: deckId}). The same box again
     *  (a reset re-running setup) is the box already there, decks and all:
     *  nothing new is registered or logged. */
    newBox(def) {
      if (!isObj(def)) throw new TypeError('t.newBox: give it {name?, pieces, backs?, decks?}');
      const extra = Object.keys(def).find((k) => !['name', 'pieces', 'backs', 'decks'].includes(k));
      if (extra) throw new TypeError(`t.newBox: unknown field '${extra}' — known: name, pieces, backs, decks`);
      const img = findKey([def.pieces, def.backs], 'img');
      if (img) throw new TypeError(`t.newBox: a script's box has no images (${img})`);
      let box;
      try { box = cleanBox(boxFromDef(def)); } catch (err) { throw new TypeError(`t.newBox: ${err.message}`); }
      const decks = scriptDecks(def.decks), same = boxWith(boxText(box, Object.fromEntries(decks)));
      if (same) return same;
      // Its decks go into the catalog, and the whole box — decks too — passes
      // cleanBox once more, as a guest's copy and a resume will; only then is
      // anything sent (a refusal takes the decks out again).
      for (const [name, d] of decks) { const deckId = mint(host.decks); addDeckTo(deckId, d); (box.decks ||= {})[name] = deckId; }
      try { box = cleanBox(box); } catch (err) {
        for (const deckId of Object.values(box.decks)) delete host.decks[deckId];
        throw new TypeError(`t.newBox: ${err.message}`);
      }
      for (const deckId of Object.values(box.decks || {})) emit({ t: 'deck', id: deckId });
      const id = registerBox(box, 'script', RULES), n = Object.keys(box.types).length;
      logEvent(RULES, `defined the box «${box.name}» (${n} piece ${n === 1 ? 'type' : 'types'})`);
      return id;
    },
    /** The game boxes of the catalog: [{id, name, src, builtin, types: how many piece types}] (spec §4e). */
    boxes: () => Object.entries(host.boxes).map(([id, b]) => ({ id, name: b.name, src: host.boxSrc[id]?.src || 'host', builtin: isBuiltin(b), types: Object.keys(b.types).length })),
    /** Box `id` as everyone sees it (publicBox: no setup, rules or rulesState),
     *  copied — its types, backs, decks ({name: deck id}) and meta — or null. */
    box: (id) => { const b = own(host.boxes, id); return b ? structuredClone(publicBox(b, host.boxSrc[id])) : null; },
    /** Lays out `entries` (setup entries of box `boxId`'s grammar: spec §4a),
     *  or the box's own setup, as the rules — the same interpreter as a
     *  `setup`, nothing cleared, every check first (a TypeError naming what
     *  fails). An `id` that is taken is minted anew. Logged as one line;
     *  returns how many items it placed. */
    layout(boxId, entries) {
      const box = typeof boxId === 'string' && own(host.boxes, boxId);
      if (!box) throw new TypeError(`t.layout: no game box ${JSON.stringify(boxId)}`);
      let list = box.setup || [];
      if (entries !== undefined) {
        try { list = cleanBox({ ...box, setup: entries }).setup; } catch (err) { throw new TypeError(`t.layout: ${err.message}`); }
      }
      const why = setupProblem(box, list);
      if (why) throw new TypeError(`t.layout: ${why}`);
      const { n, remap } = lay(boxId, box, list);
      if (Object.keys(remap).length) console.warn('t.layout: ids that were taken got new ones', remap);
      if (n) logEvent(RULES, `placed ${n} ${n === 1 ? 'item' : 'items'} of «${box.name}»`);
      return n;
    },
    /** Places a new piece (or supply) of type `type` ('box/type'): o = {at?
     *  (an address, 'center', or {x, y, free?}), f?, n?, owner?, up?, rot?,
     *  lock? (boards: locked by default), as?: 'piece' | 'supply'}. Its id, or
     *  false at the item cap. */
    spawn(type, o = {}) {
      const ty = scriptType('t.spawn', type);
      if (!isObj(o)) throw new TypeError('t.spawn: o must be {at?, f?, n?, owner?, up?, rot?, lock?, as?}');
      const as = o.as ?? 'piece', f = scriptFace('t.spawn', ty, o.f), owner = scriptOwner('t.spawn', o.owner);
      if (as !== 'piece' && as !== 'supply') throw new TypeError(`t.spawn: as must be 'piece' or 'supply', got ${JSON.stringify(as)}`);
      if (o.n !== undefined && (as !== 'piece' || !Number.isInteger(o.n) || o.n < 1 || o.n > MAX_N || (o.n > 1 && ty.stack !== 'count'))) {
        throw new TypeError(`t.spawn: n must be 1 to ${MAX_N}, on a piece whose type stacks by count (${type} ${ty.stack === 'count' ? 'does' : "doesn't"})`);
      }
      if (o.up !== undefined && typeof o.up !== 'boolean') throw new TypeError('t.spawn: up must be true or false');
      if (o.up === false && !ty.back) throw new TypeError(`t.spawn: ${type} has no back, so it can't lie face down`);
      if (o.lock !== undefined && typeof o.lock !== 'boolean') throw new TypeError('t.spawn: lock must be true or false');
      if (o.rot !== undefined && !Number.isFinite(o.rot)) throw new TypeError('t.spawn: rot must be a number');
      if (!cap(RULES)) return false;
      const it = { k: as === 'supply' ? 's' : 'g', t: type, f, rot: 0, ...(o.up === false && { up: false }), ...(o.n > 1 && { n: o.n }), ...(owner && { owner }), ...((o.lock ?? ty.kind === 'board') && { lock: true }) };
      it.rot = turned(it, o.rot);
      place(it, ...scriptSpot('t.spawn', it, o.at));
      const id = put(mint(host.items), it);
      logOp(RULES, 'placed', `placed ${label(it)}${onAt(it)}`, it);
      mark(RULES, id);
      return id;
    },
    /** A new bag of `contents` ([{t, f?, up?, n?}], ≤ MAX_BAG pieces in all):
     *  o = {at?, name?, owner?, hand?} (hand: whether it may go into hands —
     *  by default when every piece may, fixed from then on). Its id, or false
     *  at the item cap. */
    newBag(contents, o = {}) {
      if (!Array.isArray(contents)) throw new TypeError('t.newBag: contents must be a list of {t, f?, up?, n?}');
      if (!isObj(o)) throw new TypeError('t.newBag: o must be {at?, name?, owner?, hand?}');
      const of = [];
      for (const m of contents) {
        if (!isObj(m)) throw new TypeError('t.newBag: each entry is {t, f?, up?, n?}');
        const ty = scriptType('t.newBag', m.t), f = scriptFace('t.newBag', ty, m.f), n = m.n ?? 1;
        if (m.up === false && !ty.back) throw new TypeError(`t.newBag: ${m.t} has no back, so it can't go in face down`);
        if (!Number.isInteger(n) || n < 1 || of.length + n > MAX_BAG) throw new TypeError(`t.newBag: a bag holds 1 to ${MAX_BAG} pieces in all`);
        for (let k = 0; k < n; k++) of.push({ t: m.t, f, ...(m.up === false && { up: false }) });
      }
      if (o.name !== undefined && typeof o.name !== 'string') throw new TypeError('t.newBag: name must be a string');
      if (o.hand !== undefined && typeof o.hand !== 'boolean') throw new TypeError('t.newBag: hand must be true or false');
      const owner = scriptOwner('t.newBag', o.owner), hand = o.hand ?? (of.length > 0 && of.every((m) => typeOf(m.t).hand));
      // its box (who may lock it: D88) is its pieces' when they all come from one box
      const boxIds = new Set(of.map((m) => m.t.slice(0, m.t.indexOf('/')))), box = boxIds.size === 1 ? [...boxIds][0] : null;
      if (!cap(RULES)) return false;
      const bag = { k: 'b', of, name: str(o.name, 24) || '', ...(box && { box }), ...(hand && { hand: true }), rot: 0, ...(owner && { owner }) };
      place(bag, ...scriptSpot('t.newBag', bag, o.at));
      const id = put(mint(host.items), bag);
      logEvent(RULES, `made the bag ${bag.name || 'Bag'} (${of.length} pieces)`);
      mark(RULES, id);
      return id;
    },
    /** A new piece from supply `id` (o = {at?, to?: pid}: onto the table —
     *  next to it, or `at` — or into that player's hand): its id, or {hand:
     *  true, t, f, up?}, or false. */
    take(id, o = {}) { return scriptDraw('t.take', 's', id, o); },
    /** A random piece out of bag `id` (o = {at?, to?: pid}), as t.take. */
    pull(id, o = {}) { return scriptDraw('t.pull', 'b', id, o); },
    /** Turns piece or supply `id` — or each of a list of ids, as one log
     *  line (a reversi move's flips: D167) — to face `f` (a die too: no roll). */
    setFace(ids, f) {
      return eachOf('t.setFace', ids, (id) => {
        const it = scriptItem('t.setFace', id);
        if (!it) return false;
        if (it.k !== 'g' && it.k !== 's') throw new TypeError('t.setFace: only pieces and supplies have faces');
        const ty = typeOf(it.t);
        if (!ty) return no(RULES, "🚫 That piece's game box is missing");
        scriptFace('t.setFace', ty, f);
        if (it.f === f) return true;
        const from = label(it), to = it.up === false ? undefined : faceLabel(ty.faces[f], f);
        touch(id);
        it.f = f;
        logOp(RULES, 'turned', `turned ${from}${to ? ` to ${to}` : ''}${onAt(it)}`, it, to && { from, to });
        mark(RULES, id);
        return true;
      });
    },
    /** Sets piece `id`'s count to n (0 to MAX_N: 0 removes it; 2 or more on a type that stacks by count). */
    setCount(id, n) {
      const it = scriptItem('t.setCount', id);
      if (!it) return false;
      if (it.k !== 'g') throw new TypeError('t.setCount: only pieces have a count');
      if (!Number.isInteger(n) || n < 0 || n > MAX_N) throw new TypeError(`t.setCount: n must be 0 to ${MAX_N}, got ${JSON.stringify(n)}`);
      if (n === 0) return opRemove(RULES, id);
      if (n > 1 && flags(it).stack !== 'count') throw new TypeError(`t.setCount: ${it.t} doesn't stack by count`);
      if ((it.n || 1) === n) return true;
      touch(id);
      if (n > 1) it.n = n;
      else delete it.n;
      logOp(RULES, 'counted', `counted ${label(it)}${onAt(it)}`, it);
      mark(RULES, id);
      return true;
    },
    /** Locks item `id` in place (on) or frees it; false when it already was so. */
    lock(id, on) {
      if (typeof on !== 'boolean') throw new TypeError('t.lock: on must be true or false');
      return !!scriptItem('t.lock', id) && opLock(RULES, id, on);
    },
    /** Gives item `id` to `owner` (a player id, 'seat:<id>', or null: nobody); false when it already was. */
    setOwner(id, owner) {
      const to = scriptOwner('t.setOwner', owner);
      return !!scriptItem('t.setOwner', id) && opOwner(RULES, id, to);
    },
    /** Sets the named seats (SeatDef[], spec §2a) or, with null, automatic seating; re-seats everyone. */
    setSeats(defs) {
      let seats = null;
      if (defs !== null) { try { seats = cleanSeats(defs); } catch (err) { throw new TypeError(`t.setSeats: ${err.message}`); } }
      setSeats(RULES, seats);
    },
    /** Sets the table: {shape, w, h, felt?} (spec §2a). */
    setTable(def) {
      let tb;
      try { tb = cleanTable(def); } catch (err) { throw new TypeError(`t.setTable: ${err.message}`); }
      setTable(RULES, tb);
    },

    // --- spatial reads (spec §3e): addresses in any form in, display forms out ---
    /** Piece `id`'s address (display form), or null; false when it vanished. */
    where(id) {
      const it = scriptItem('t.where', id);
      return it && addrNow(it);
    },
    /** The pieces at address `a`, copied, bottom to top (by z). */
    at(a) {
      const r = addrOf('t.at', a);
      syncSpots();
      return [...(byAt.get(r.at) || [])].map((id) => copyItem(id, host.items[id])).sort((x, y) => x.z - y.z);
    },
    /** The zones piece `id` lies in (display forms: "<zone>" on the primary board, else "<board>:<zone>"); false when it vanished. */
    zones(id) {
      if (!scriptItem('t.zones', id)) return false;
      syncSpots();
      return (zonesOf.get(id) || []).map(display);
    },
    /** The centre of address `a` on the table: {x, y}. */
    spot(a) { const r = addrOf('t.spot', a); return { x: r.x, y: r.y }; },
    /** The addresses next to `a`, in bounds: a square grid's 4 ({diag: true}: 8), a hex's 6, a space's links. */
    neighbors(a, o = {}) {
      if (!isObj(o)) throw new TypeError('t.neighbors: o must be {diag?}');
      const r = addrOf('t.neighbors', a);
      return displayOn(r.b, gridNeighbors(r.b.B, r.local, { diag: o.diag === true }));
    },
    /** Steps from `a` to `b` on one board's grid (o.metric: 'chebyshev', the default, or 'manhattan'; hexes: cube distance); null across boards or for spaces. */
    distance(a, b, o = {}) {
      if (!isObj(o) || (o.metric !== undefined && o.metric !== 'chebyshev' && o.metric !== 'manhattan')) throw new TypeError("t.distance: o.metric must be 'chebyshev' or 'manhattan'");
      const p = addrOf('t.distance', a), q = addrOf('t.distance', b);
      return p.b === q.b ? gridDistance(p.b.B, p.local, q.local, o) : null;
    },
    /** The addresses strictly between `a` and `b` on one board's grid (squares: along a rank, file or diagonal; hexes: a straight line), or null. */
    line(a, b) {
      const p = addrOf('t.line', a), q = addrOf('t.line', b);
      return p.b === q.b ? displayOn(p.b, gridLine(p.b.B, p.local, q.local)) : null;
    },
    /** The spaces linked to space `a` (links are undirected), as addresses. */
    linked(a) {
      const r = addrOf('t.linked', a);
      return displayOn(r.b, linkedSpaces(r.b.B, r.local));
    },
  };
  /** t.take and t.pull (`kind` 's' or 'b'): onto the table (next to it, or o.at) or into o.to's hand. */
  function scriptDraw(call, kind, id, o) {
    if (!isObj(o)) throw new TypeError(`${call}: o must be {at?, to?}`);
    if (o.to !== undefined && !own(host.players, o.to)) throw new TypeError(`${call}: no player ${JSON.stringify(o.to)}`);
    if (o.to !== undefined && o.at !== undefined) throw new TypeError(`${call}: at or to, not both`);
    const it = scriptItem(call, id);
    if (!it) return false;
    if (it.k !== kind) throw new TypeError(`${call}: ${id} is not a ${kind === 's' ? 'supply' : 'bag'}`);
    if (o.to !== undefined) return kind === 's' ? opTake(RULES, id, 0, 0, true, o.to) : opPull(RULES, id, 0, 0, true, o.to);
    // (a pull draws its piece first — drawFrom, which opPull then takes: an address centres it by its own size)
    const m = kind === 's' ? it : it.of.length ? it.of[drawFrom(id, it)] : null;
    const at = nextTo(it), [x, y, po] = o.at === undefined || !m ? [at.x, at.y, {}] : scriptSpot(call, { k: 'g', t: m.t, f: m.f, ...(m.up === false && { up: false }) }, o.at);
    return kind === 's' ? opTake(RULES, id, x, y, false, RULES, po) : opPull(RULES, id, x, y, false, RULES, po);
  }

  /** Moves a player's hand onto a pile, face down (a piece without a back
   *  face up): every entry, or only those `only({d, i} | {t, f, up?})`
   *  picks (scripts: "my game's deck", leaving others' cards). An entry that
   *  doesn't go onto the pile (goesOn, checked as it grows: cards with
   *  pieces, other sizes; or the pile is full) stays in the hand, said with
   *  a console.warn — a card deck never takes in a piece. An empty pile
   *  takes cards when any are picked, whatever the hand's order: a card
   *  game's fresh "Set aside" or muck never becomes a pile of pieces. */
  function opTakeHand(actor, p, pileId, only) {
    const pl = own(host.players, p), pile = own(host.items, pileId);
    if (!pl || pile?.k !== 'p') return false;
    const picked = new Set(typeof only === 'function' ? pl.hand.filter((c) => only({ ...c })) : pl.hand), n0 = pl.hand.length;
    const cardsOnly = !pile.cards.length && [...picked].some(isCard);
    jot(`p:${p}`, pl); // (both may change below: touched when they did)
    jot(`i:${pileId}`, pile);
    let stayed = 0;
    pl.hand = pl.hand.filter((c) => {
      if (!picked.has(c)) return true;
      const m = isCard(c) ? { d: c.d, i: c.i, up: false } : { t: c.t, f: c.f, up: mustShow(c.t) };
      if ((cardsOnly && !isCard(m)) || !goesOn(m, pile) || pile.cards.length >= MAX_PILE) { stayed++; return true; }
      pile.cards.push(m);
      return false;
    });
    const n = n0 - pl.hand.length;
    if (stayed) console.warn(`t.takeHand: ${stayed} of ${pl.name || p}'s hand stayed there: they don't go onto ${label(pile)}`);
    if (n) {
      const whose = n === n0 ? `${pl.name || 'a player'}'s hand` : `cards from ${pl.name || 'a player'}'s hand`;
      logEvent(actor, `returned ${whose} (${n}) to ${label(pile)}`);
      mark(actor, pileId);
      touchPlayer(p, { hand: true });
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
    syncSpots();
    return Object.fromEntries(Object.entries(host.items).map(([id, it]) => [id, pubItem(it, host.boxes, display)]));
  }
  /** The rules as everyone sees them (spec §3b): {name, enabled, public},
   *  and while they are on, `wants: ['select']` when the script has onSelect
   *  (clients send `select` only then) and `strict: true`. */
  function rulesView() {
    const r = host.rules, on = !!r?.enabled;
    return r ? { name: r.name, enabled: r.enabled, public: r.public, ...(on && hooks.has('onSelect') && { wants: ['select'] }), ...(on && hooks.flag?.('strict') === true && { strict: true }) } : null;
  }
  let rulesSig = JSON.stringify(rulesView()); // what the last takeDirty() saw
  /** Player p's own parts of the rules (spec §3b, §3d), each null when
   *  there is none: their pending asks as the wire shows them (options as
   *  their labels only) and their hint, while the rules are on; their
   *  t.secret entry, even while they are off (it is theirs, like a hand). */
  function partsOf(p) {
    const r = host.rules, on = !!r?.enabled, asks = on && own(r.asks || {}, p), hint = on && own(r.hints || {}, p), sec = r && own(r.secret || {}, p);
    return { ask: asks?.length ? asks.map(({ options, ...x }) => (options ? { ...x, options: options.map((o) => o.label) } : x)) : null, hint: hint || null, sec: sec ?? null };
  }
  const PARTS = [['ask', 'asks'], ['hint', 'hints'], ['sec', 'secret']]; // a part → its dirty set
  const sentParts = new Map(); // pid → the JSON of each part (PARTS order) as the last takeDirty() saw it
  let partsSeen = -1; // partsVer then
  /** What a body carries for recipient `to` alone, beside `to`, `tp` and
   *  `base` (spec §1b.3, §3b): in a snapshot (no `d`) their hand, and each of
   *  ask, hint and sec that isn't empty; in a patch, from a takeDirty()
   *  result `d`, those that changed since (null: cleared). A peer that isn't
   *  a registered player (`to` null, or not yet in state.players) gets none. */
  function mine(to, d) {
    const pl = typeof to === 'string' && own(host.players, to), o = {};
    if (!pl) return o;
    if (!d || d.hands.has(to)) o.hand = pl.hand;
    const P = partsOf(to);
    for (const [k, set] of PARTS) if (d ? d[set].has(to) : P[k] !== null) o[k] = P[k];
    return o;
  }

  // --- delta sync: the dirty sets, patches and snapshots ------------------------
  /** Hands over what changed since the last call (the dirty sets) and starts
   *  afresh. The app calls it once per broadcast tick. Scripts change
   *  t.public in place, so the rules are found dirty by comparison here, as
   *  is `handy` (from the items). */
  function takeDirty() {
    flushRuns();
    refresh();
    boardsMoving = false; // (the boards as they now are: tb() may keep them until one is touched again)
    const d = dirty, sig = JSON.stringify(rulesView()), h = handy.size > 0;
    dirty = newDirty();
    if (sig !== rulesSig) { rulesSig = sig; d.rules = true; }
    if (h !== handySent) { d.handy = handySent !== undefined; handySent = h; }
    if (partsSeen !== partsVer) { // (each player's own parts, compared only when something may have changed them)
      partsSeen = partsVer;
      const r = host.rules, pids = new Set([...sentParts.keys(), ...Object.keys(r?.asks || {}), ...Object.keys(r?.hints || {}), ...Object.keys(r?.secret || {})]);
      for (const p of pids) {
        const P = partsOf(p), now = PARTS.map(([k]) => JSON.stringify(P[k])), was = sentParts.get(p) || ['null', 'null', 'null'];
        PARTS.forEach(([, set], k) => { if (now[k] !== was[k]) d[set].add(p); });
        if (now.every((j) => j === 'null')) sentParts.delete(p);
        else sentParts.set(p, now);
      }
    }
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
    for (const id of [a.id, a.pile, a.onto, a.bag, ...(Array.isArray(a.ids) ? a.ids.slice(0, NAMED_IDS) : [])]) any = refreshItem(id) || any;
    if (HAND_ACTIONS.has(a.t) && own(host.players, p)) { refreshHand(p); any = true; }
    return any;
  }
  const refusals = new Map(); // player id → token bucket (refreshFor)
  /** An action of p's was refused before it reached the table (flood
   *  control): re-send what it names (touchNamed). A refused action costs no
   *  flood token, so these re-sends have their own bucket (a burst of 10,
   *  then 5 per second): a flood can't make the host re-send the table to
   *  everyone. True when something was re-sent (renumbered). */
  function refreshFor(p, a) {
    return flood(refusals, p, 10, 5) && touchNamed(p, textIds(a)) ? bump() : false;
  }
  /** Why the rules' fields of a Worker's patch `r` fail the engine's gates
   *  (spec §3a: they run on every write), checked again here, in the host's
   *  realm — or '' (the asks are checkPatch's: it keeps them cleaned). */
  function patchRulesProblem(r) {
    if ('secret' in r) {
      if (!isObj(r.secret)) return 't.secret is not a map';
      for (const [p, v] of Object.entries(r.secret)) { const why = secretProblem(p, v); if (why) return why; }
    }
    if ('hints' in r) { const why = hintsProblem(r.hints); if (why) return `t.hint: ${why}`; }
    if ('data' in r) {
      if (!isObj(r.data)) return 't.data is not an object';
      const t = r.data._timers;
      if (t !== undefined && (!Array.isArray(t) || t.length > MAX_TIMERS || !t.every((x) => isObj(x) && Number.isFinite(x.at) && typeof x.tag === 'string' && x.tag.length <= TIMER_TAG_MAX))) return 't.data._timers is malformed';
    }
    for (const k of ['data', 'public']) {
      if (!(k in r)) continue;
      let n; // (a structured clone keeps a Map, a Date — and a cycle, which JSON can't write)
      try { n = JSON.stringify(r[k])?.length; } catch (err) { return `t.${k} is not JSON (${String(err.message).split('\n')[0]})`; }
      if (k === 'data' && n > DATA_MAX_CHARS) return 't.data is too large';
      const why = notJSON(r[k], `t.${k}`);
      if (why) return why;
    }
    return '';
  }
  /** Why a rules Worker's job — player p's action `a` — speaks for someone
   *  it shouldn't in its log lines `log` and effects `effects`, or '' (D144):
   *  every log line and every name bulb (fx) is p's or the rules'; a chat
   *  line is p's own message, once, in p's chat; a frozen name (`n`) only on
   *  p's rename, once, the name p had; a line on the record (`k`) and a
   *  peek's answer only in p's own peek. What the job's other lines say is
   *  the engine's: the Worker's built-ins are frozen before any script runs
   *  (D145), and a script may announce anything as the rules. */
  function speakerProblem(log, effects, p, a) {
    const whose = (q) => (q === RULES ? "the rules'" : `${own(host.players, q)?.name || 'an unknown player'}'s`);
    let chats = 0, names = 0, peeks = 0;
    for (const e of log) {
      if (e.p !== p && e.p !== RULES) return `the script put a line in ${whose(e.p)} name into ${whose(p)} ${a.t}`;
      if (e.c && (a.t !== 'chat' || e.p !== p || chats++ || e.txt !== chatLine(a.msg))) return `the script put words in ${whose(e.p)} chat`;
      if ('n' in e && ((a.t !== 'name' && a.t !== '_name') || e.p !== p || names++ || e.n !== own(host.players, p)?.name)) return `the script renamed a line of ${whose(e.p)} to "${String(e.n).slice(0, 30)}"`;
      if (e.k && (a.t !== 'peek' || e.p !== p || peeks++)) return `the script put a peek on the record in ${whose(e.p)} name`;
    }
    for (const e of effects) {
      if (e.t === 'fx' && e.f.p !== p && e.f.p !== RULES) return `the script put ${whose(e.f.p)} name bulb into ${whose(p)} ${a.t}`;
      if (e.t === 'peek' && (a.t !== 'peek' || e.p !== p)) return `the script showed ${whose(e.p)} eyes a card in ${whose(p)} ${a.t}`;
    }
    return '';
  }
  /** The fields a Worker's patch may carry (commit's, and its D129 fallback's). */
  const PATCH_KEYS = ['items', 'players', 'decks', 'boxes', 'rules', 'table', 'seats', 'zMax', 'boardSeq', 'guestDeckChars', 'lastSetup', 'log', 'refresh', 'refreshHands'];
  /** What a rules Worker's patch may set of the rules beyond their state (RULES_STATE): the host's setRules does. */
  const RULES_META = ['code', 'name', 'enabled', 'box'];
  const texty = (s) => typeof s === 'string' && s.length <= LOG_TXT_MAX;
  /** Each effect a job may queue (see the top of this file), rebuilt from
   *  the fields the engine writes, each as it writes it — or null. The host
   *  carries out only these copies, so nothing a Worker adds to one (a live
   *  drag's `ids`, which the broadcast tick reads) reaches it (D149). */
  const EFFECTS = {
    fx: ({ f }) => (isObj(f) && typeof f.p === 'string' && typeof f.id === 'string' && Number.isFinite(f.x) && Number.isFinite(f.y)
      && (f.roll === undefined || (Array.isArray(f.roll) && f.roll.length <= MAX_ROLL && f.roll.every((id) => typeof id === 'string')))
      ? { t: 'fx', f: { p: f.p, id: f.id, x: f.x, y: f.y, ...(f.roll && { roll: [...f.roll] }) } } : null),
    ann: ({ msg }) => (texty(msg) ? { t: 'ann', msg } : null),
    toast: ({ msg }) => (texty(msg) ? { t: 'toast', msg } : null),
    note: ({ p, msg }) => (typeof p === 'string' && texty(msg) ? { t: 'note', p, msg } : null),
    peek: ({ p, c }) => (typeof p === 'string' && memberProblem(c) === '' ? { t: 'peek', p, c: typeof c.d === 'string' ? { d: c.d, i: c.i } : { t: c.t, f: c.f } } : null),
    deck: ({ id }) => (typeof id === 'string' ? { t: 'deck', id } : null),
    box: ({ id }) => (typeof id === 'string' ? { t: 'box', id } : null),
    rules: () => ({ t: 'rules' }),
    // (to the app: the box an addBox registered or found; a setup's rules to start, after it: spec §4c)
    added: ({ id }) => (typeof id === 'string' ? { t: 'added', id } : null),
    enable: ({ box, remap }) => (typeof box === 'string' && isObj(remap) && Object.values(remap).every((v) => typeof v === 'string') ? { t: 'enable', box, remap: { ...remap } } : null),
  };
  /** Step 0 of applyStatePatch (spec §3f.6; D142, D144, D145): a rules
   *  Worker's patch `s` and effects `out` for `job` ({p, a}), checked in the
   *  host's realm against what the engine writes — a script shares the
   *  Worker's realm, so the Worker's own gates are only as sound as the
   *  built-ins there; the lockdown keeps those, and this keeps the host
   *  whatever happens there. Each field as the engine shapes it: the
   *  catalog only grows (new ids, cleanDeck, cleanBox, where each box came
   *  from); items (itemProblem, MAX_ITEMS in all, a new one a fresh id) and
   *  players (playerProblem); the rules' fields (RULES_STATE and RULES_META
   *  only; patchRulesProblem); the table and the seats (cleanTable,
   *  cleanSeats); log lines (logEvent's fields, LOG_TXT_MAX, no bucket over
   *  its cap); the counters only grow, within bounds; the effects. And, with
   *  `job` (the app always gives it), against who acted: a player appears
   *  only in their own _join; a name changes only by its player's rename
   *  (or their _join filling an empty one), to that rename's name; a colour
   *  never; online only by its player's _join or _leave; the rules' code and
   *  name only in the host's Enable, that code; the rules turn on only there,
   *  and off only with a hook's failure, a Disable or _rulesOff; the guests'
   *  deck budget only grows, by a guest's addDeck; and who each line and
   *  bulb speaks for (speakerProblem); a player's added deck as they sent
   *  it, said once in their name.
   *  Returns what the apply step takes, cleaned — or throws, saying why,
   *  with nothing changed. */
  function checkPatch(s, out, job) {
    const no = (why) => { throw new Error(why); };
    if (!isObj(s) || (out != null && !isObj(out))) no('the patch is not one');
    const stray = Object.keys(s).find((k) => !PATCH_KEYS.includes(k));
    if (stray !== undefined) no(`the patch has an unknown field '${stray.slice(0, 20)}'`);
    const { p, a = {} } = job || {};
    const entries = (k) => (s[k] === undefined ? [] : isObj(s[k]) ? Object.entries(s[k]) : no(`the patch's ${k} are not a map`));
    const who = (q) => (own(host.players, q)?.name || 'a player');
    const named = a.t === '_join' ? joinName(a.name) : cleanName(a.name); // (the very name the engine gives: ensurePlayer's, effect 'name''s)
    // the catalog only grows: a deck or a box under an id it doesn't hold yet, gated again
    const fresh = (id) => isId(id) && !own(host.decks, id) && !own(host.boxes, id);
    const decks = entries('decks').map(([id, d]) => {
      if (!fresh(id)) no(`the patch rewrites the catalog's ${id.slice(0, 24)}`);
      try { return [id, cleanDeck(d)]; } catch (err) { return no(`a patched deck: ${err.message}`); }
    });
    const boxes = entries('boxes').map(([id, r]) => {
      if (!fresh(id)) no(`the patch rewrites the catalog's ${id.slice(0, 24)}`);
      if (!isObj(r) || !['host', 'upload', 'script'].includes(r.src) || !(r.by === undefined || PID_RE.test(r.by))) no("a patched box doesn't say where it came from");
      try { return [id, { box: cleanBox(r.box), src: { src: r.src, ...(r.by && { by: r.by }) } }]; } catch (err) { return no(`a patched box: ${err.message}`); }
    });
    const items = entries('items'), had = itemCount();
    let count = had;
    for (const [id, it] of items) {
      if (it === null) { count -= own(host.items, id) ? 1 : 0; continue; }
      if (!own(host.items, id)) { if (!isId(id)) no(`a patched item has the id ${JSON.stringify(id.slice(0, 30))}`); count++; }
      // (an address as the Worker read it, D128 — but text: every read of one on this table takes it as such)
      const why = itemProblem(it) || (Math.abs(it.z) > Z_MAX && `its z is past ${Z_MAX}`) || (it.at !== undefined && !(typeof it.at === 'string' && it.at.length <= 100) && 'its address is not one');
      if (why) no(`a patched item (${id.slice(0, 24)}) is malformed: ${why}`);
    }
    if (count > Math.max(had, MAX_ITEMS)) no(`the patch leaves more than ${MAX_ITEMS} items on the table`);
    for (const [q, pl] of entries('players')) {
      const why = playerProblem(pl), old = own(host.players, q), mine = q === p;
      if (why) no(`a patched player (${who(q)}) is malformed: ${why}`);
      if (!old) {
        if (!PID_RE.test(q) || (job && !(mine && a.t === '_join' && pl.online && pl.name === named && COLORS.includes(pl.color)))) no('the script added a player');
        continue;
      }
      if (!job) continue;
      if (pl.name !== old.name && !(mine && pl.name === named && (a.t === 'name' || a.t === '_name' || (a.t === '_join' && !old.name)))) no(`the script renamed ${who(q)}`);
      if (pl.color !== old.color) no(`the script changed ${who(q)}'s colour`);
      if (pl.online !== old.online && !(mine && (a.t === '_join' ? pl.online : a.t === '_leave' && !pl.online))) no(`the script ${pl.online ? 'brought' : 'took'} ${who(q)} ${pl.online ? 'online' : 'offline'}`);
    }
    let asks;
    const r = s.rules;
    if (r !== undefined) {
      if (!isObj(r)) no('the patched rules are not an object');
      const extra = Object.keys(r).find((k) => !RULES_STATE.includes(k) && !RULES_META.includes(k));
      if (extra !== undefined) no(`the patched rules have an unknown field '${extra.slice(0, 20)}'`);
      const why = patchRulesProblem(r);
      if (why) no(`the script's state fails the engine's gates: ${why}`);
      // (the asks as t.ask leaves them, normalized: what the host keeps and sends)
      try { if ('asks' in r) asks = cleanAsks(r.asks); } catch (err) { no(`the script's state fails the engine's gates: t.ask: ${err.message}`); }
      if (('code' in r && typeof r.code !== 'string') || ('name' in r && !(typeof r.name === 'string' && r.name.length <= 40)) || ('enabled' in r && typeof r.enabled !== 'boolean')) no('the patched rules are malformed');
      const enable = a.t === 'setRules' && p === pid && !!a.enabled;
      if (job && ('code' in r || 'name' in r) && !(enable && (!('code' in r) || r.code === a.code))) no("the script rewrote the rules' code or name");
      if (job && r.enabled === true && !enable) no('the script turned the rules on');
      if (job && r.enabled === false && !out?.error && !(a.t === 'setRules' && p === pid && !a.enabled) && a.t !== '_rulesOff') no('the script turned the rules off without a word');
      if ('box' in r && !(r.box === null || typeof r.box === 'string')) no('the patched rules are malformed');
      if (job && 'box' in r && !(enable && (r.box === null || (r.box === a.box && own(host.boxes, a.box)?.rules === a.code)))) no("the script set the rules' box");
    }
    let table, seats;
    try {
      if (s.table !== undefined) table = cleanTable(s.table);
      if ('seats' in s) seats = s.seats && cleanSeats(s.seats);
    } catch (err) { no(`the patched table: ${err.message}`); }
    const log = s.log ?? [];
    if (!Array.isArray(log) || !log.every((e) => isObj(e) && typeof e.p === 'string' && texty(e.txt) && Number.isFinite(e.ts) && Object.keys(e).every((k) => ['p', 'txt', 'ts', 'c', 'n', 'k'].includes(k))
      && (!('c' in e) || e.c === 1) && (!('k' in e) || e.k === 1) && (!('n' in e) || typeof e.n === 'string'))) no("the script's log lines are malformed");
    if (trimLog(log) !== log) no('the patch brings more log lines than the log keeps');
    const grows = (k, max) => s[k] === undefined || (Number.isFinite(s[k]) && s[k] >= num(host[k]) && s[k] <= max) || no(`the patch's ${k} is out of bounds`);
    grows('zMax', Z_MAX);
    grows('boardSeq', -BOARD_Z0);
    grows('guestDeckChars', GUEST_DECK_CHARS);
    if (job && s.guestDeckChars !== undefined && !((a.t === 'addDeck' || a.t === 'addBox') && p !== pid && s.guestDeckChars >= num(host.guestDeckChars) + num(a.cost))) no("the script spent the guests' deck budget");
    if (s.lastSetup !== undefined && !(typeof s.lastSetup === 'string' && (own(host.boxes, s.lastSetup) || boxes.some(([id]) => id === s.lastSetup)))) no("the patch's last setup is no box");
    if (job && s.lastSetup !== undefined && !(p === pid && (a.t === 'loadBox' || (a.t === 'setup' && s.lastSetup === a.box) || (a.t === 'reset' && s.lastSetup === host.lastSetup)))) no('the script set the last setup outside a setup');
    for (const k of ['refresh', 'refreshHands']) if (s[k] !== undefined && !(Array.isArray(s[k]) && s[k].length <= MAX_ITEMS && s[k].every((x) => typeof x === 'string'))) no(`the patch's ${k} is malformed`);
    const raw = out?.effects ?? [];
    const effects = Array.isArray(raw) ? raw.map((e) => (isObj(e) && own(EFFECTS, e.t)?.(e)) || no("the script's effects are malformed")) : no("the script's effects are malformed");
    if (out?.error !== undefined && !(isObj(out.error) && typeof out.error.hook === 'string' && typeof out.error.message === 'string')) no("the script's error is malformed");
    const said = job ? speakerProblem(log, effects, p, a) : '';
    if (said) no(said);
    // A player's deck, as the host's realm cleans what they sent (D148, D168): an
    // addDeck job that adds a deck, or says anything in their name, adds that
    // very deck and says so once — whatever the patch's lines claim.
    if (job && a.t === 'addDeck' && (decks.length || log.some((e) => e.p === p))) {
      let want;
      try { want = cleanDeck(a.deck); } catch (err) { no(`the script added ${who(p)}'s deck, which the engine refuses (${err.message})`); }
      const line = `added deck "${want.name}" (${want.cards.length} cards)`, theirs = log.filter((e) => e.p === p);
      if (theirs.length !== 1 || theirs[0].txt !== line || !decks.some(([, d]) => canon(d) === canon(want))) no(`the script rewrote ${who(p)}'s deck`);
    }
    if (job) boxJobProblem(s, decks, boxes, log, effects, p, a, no);
    return { decks, boxes, items, asks, table, seats, effects };
  }
  /** checkPatch's part for game boxes (spec §4c), job `a` of player p: a
   *  box comes from the job — the host's own loadBox or addBox ('host', by
   *  the host), a guest's addBox ('upload', by that guest) or a script
   *  anywhere ('script'), one at a time — as the engine makes it of what was
   *  sent: a loadBox's cleanBox(a.box); an addBox's boxOfDef(a.box) with its
   *  decks, under the ids it asked for where they were free, its rulesState
   *  remapped to those it got, said once in p's name — or no box at all and
   *  no line, when the catalog holds that content already; `added` names it.
   *  A setup's `enable` (the rules to start after it) only in the host's
   *  setup with rules, or a reset of the box whose rules run, naming that
   *  box, with the ids that had to change: those its setup asks for that the
   *  table holds (none when it clears), each now a new item of the patch.
   *  Throws through `no`, saying why. */
  function boxJobProblem(s, decks, boxes, log, effects, p, a, no) {
    const who = own(host.players, p)?.name || 'a player', fresh = (id) => !own(host.decks, id) && !own(host.boxes, id);
    const added = boxes.filter(([, { src }]) => src.src !== 'script'), fx = effects.filter((e) => e.t === 'added'), en = effects.filter((e) => e.t === 'enable');
    const from = p === pid ? 'host' : 'upload', mayAdd = p === pid ? ['loadBox', 'addBox'] : ['addBox'];
    if (added.length > 1 || (added.length && (!mayAdd.includes(a.t) || added[0][1].src.src !== from || added[0][1].src.by !== p))) no(`the script added a game box in ${who}'s name`);
    if (a.t === 'loadBox' && added.length) {
      let want;
      try { want = cleanBox(a.box); } catch (err) { no(`the script added the host's box, which the engine refuses (${err.message})`); }
      if (canon(added[0][1].box) !== canon(want)) no("the script rewrote the host's box");
    }
    if (fx.length > (a.t === 'addBox' ? 1 : 0)) no(`the script named a box ${who} never added`);
    if (a.t === 'addBox' && (added.length || fx.length || log.some((e) => e.p === p))) {
      let E;
      try { E = boxOfDef(a.box); } catch (err) { no(`the script added ${who}'s box, which the engine refuses (${err.message})`); }
      if (!added.length) { // (on the table already: no line in their name, and `added` names that box)
        const same = boxWith(boxText(E.box, Object.fromEntries(E.decks.map(([n, d]) => [n, d]))));
        if (!same || log.some((e) => e.p === p) || (fx.length && fx[0].id !== same)) no(`the script rewrote ${who}'s box`);
      } else {
        const [bid, { box }] = added[0], theirs = log.filter((e) => e.p === p), remap = {}, taken = new Set();
        if (theirs.length !== 1 || theirs[0].txt !== addedLine(E.box) || fx[0]?.id !== bid) no(`the script rewrote ${who}'s box`);
        /** Catalog id `id` given for the wanted `w`: w itself when it was free. */
        const got = (w, id) => {
          if (w && id !== w && fresh(w) && !taken.has(w)) no(`the script gave ${who}'s box other ids than it asked for`);
          if (w && id !== w) remap[w] = id;
          taken.add(id);
        };
        for (const [n, d, w] of E.decks) {
          const id = own(box.decks || {}, n), deck = decks.find(([x]) => x === id);
          if (!deck || canon(deck[1]) !== canon(d)) no(`the script rewrote ${who}'s box`);
          got(w, id);
        }
        got(E.id, bid);
        const want = cleanBox({
          ...E.box, ...(E.decks.length && { decks: Object.fromEntries(E.decks.map(([n]) => [n, box.decks[n]])) }),
          ...(E.box.rulesState && { rulesState: mapIds(E.box.rulesState, (x) => own(remap, x) ?? x) }),
        });
        if (canon(want) !== canon(box)) no(`the script rewrote ${who}'s box`);
      }
    }
    if (en.length) {
      const [{ box: id, remap }] = en, box = own(host.boxes, id), clear = a.t === 'reset' || a.clear !== false;
      const asked = box && !clear ? setupIds(box.setup || []).filter((x) => own(host.items, x)).sort() : [], vals = Object.values(remap);
      if (en.length > 1 || p !== pid || !box?.rules || !(a.t === 'setup' ? a.rules === true && id === a.box : a.t === 'reset' && id === host.lastSetup && host.rules?.enabled && host.rules.box === id)
        || Object.keys(remap).sort().join() !== asked.join() || new Set(vals).size !== vals.length || !vals.every((v) => isObj(own(s.items || {}, v)) && !own(host.items, v))) no('the script asked for rules the host never chose');
    }
  }
  /** Applies a rules Worker's StatePatch (spec §3f.6) to this table — the
   *  host's, whose state the Worker's mirror ran the job on. Step 0 checks
   *  all of it first (checkPatch: a failure throws, nothing applied, and the
   *  app ends the rules); then, into the dirty sets: new decks and boxes
   *  (cleaned), the boards, the other items, whole (null: removed), players
   *  whole (keys stay here), the rules' fields (the asks as cleanAsk leaves
   *  them, the secret map with no prototype), the table and the seats, the
   *  log lines to append, the counters, and the refresh touches. The
   *  addresses come as the Worker read them: its job ended reading every
   *  piece a board's change concerned (syncSpots), and those pieces are in
   *  the patch — so this table takes the boards as read (D128): it never
   *  derives an address of its own while a Worker runs. `out` (T.job's):
   *  the job's effects, queued here as if this table had run it (decks,
   *  boxes and the rules code apart: the patch brings those), and its hook
   *  failure as T.rulesError. `job` ({p, a}: the job the patch answers; the
   *  app always says) has the patch checked against who acted too; without
   *  it, a test's hand-made patch, only its shape is. True when anything
   *  changed (renumbered). */
  function applyStatePatch(s, out, job) {
    if (J) throw new Error('applyStatePatch: a journal is open');
    const c = checkPatch(s, out, job);
    for (const [id, deck] of c.decks) {
      host.decks[id] = deck;
      emit({ t: 'deck', id });
    }
    for (const [id, { box, src }] of c.boxes) {
      host.boxes[id] = box;
      host.boxSrc[id] = src;
      boxIndex = null;
      tbVer++;
      emit({ t: 'box', id });
    }
    const board = ([id, it]) => (it ? it.z < 0 : boardIds.has(id)); // (the boards first: the pieces' zones are read against them)
    for (const [id, it] of [...c.items.filter(board), ...c.items.filter((e) => !board(e))]) {
      if (it === null) remove(id);
      else put(id, it);
    }
    for (const [p, pl] of Object.entries(s.players || {})) {
      const old = own(host.players, p);
      touchPlayer(p, { hand: JSON.stringify(old?.hand) !== JSON.stringify(pl.hand) });
      host.players[p] = pl;
    }
    if (s.rules) {
      const was = host.rules;
      host.rules = { ...was, ...s.rules, ...(c.asks && { asks: c.asks }) };
      if (s.rules.box === null) delete host.rules.box;
      if ('secret' in s.rules) host.rules.secret = nullProto(s.rules.secret); // (a structured clone has a prototype: §3a wants none)
      if (host.rules.code !== was?.code || host.rules.enabled !== was?.enabled) emit({ t: 'rules' });
      [lastJSON, partsVer] = [null, partsVer + 1];
    }
    if (c.table) { host.table = c.table; dirty.table = true; }
    if ('seats' in s) { host.seats = c.seats; dirty.seats = true; }
    if (s.log?.length) {
      host.log = trimLog(host.log.concat(s.log));
      dirty.log = dirty.log.concat(s.log);
    }
    for (const k of ['zMax', 'boardSeq', 'guestDeckChars', 'lastSetup']) if (s[k] !== undefined) host[k] = s[k];
    for (const id of s.refresh || []) refreshItem(id);
    for (const p of s.refreshHands || []) if (own(host.players, p)) refreshHand(p);
    [spotTB, spotSig, respot] = [tb(), tbSig, false]; // (the boards as the Worker read them: see above)
    for (const e of c.effects) if (e.t !== 'deck' && e.t !== 'box' && e.t !== 'rules') emit(e);
    if (out?.error) lastRulesError = `${out.error.hook}: ${out.error.message}`;
    return Object.keys(s).length ? bump() : false;
  }

  // --- a rules Worker's side (spec §3f): its jobs, and what it checks -----------
  /** Whether the rules' state changed outside a hook since the last commit
   *  (spec §3f.7: a stray async continuation wrote t.data, or called the
   *  facade): null, or {why, detail?} (then the next job starts from the
   *  JSON taken here). Its JSON must be as committed, and so must its
   *  values: a write JSON can't see (a function, a Date over its own ISO
   *  string) is named here, not by the gate of whichever job comes next
   *  (D144). `why` is the engine's own fixed words, which the public log may
   *  carry; `detail` names the script's own keys (its private t.data, the
   *  player ids of t.secret), for the host alone (D145). A Worker runs it
   *  before each job, and again once the microtasks its last job queued have
   *  run (drain) — before it posts the job's patch: there, a function in a
   *  field the patch carries is left to that post, which fails (D129: the
   *  rules go off keeping the JSON part); any other function is refused
   *  here (D146). */
  function guard() {
    const stray = hooks.stray?.(), posts = carried;
    carried = null;
    guardJSON = null;
    if (stray) return { why: stray };
    if (!host.rules || !lastJSON) return null;
    let json;
    try { json = rulesJSON(); } catch (err) { return { why: 'the script left its state unserializable outside a hook', detail: err.message }; }
    if (['data', 'public', 'asks', 'secret'].some((k) => json[k] !== lastJSON[k])) return { why: 'the script changed t.data outside a hook' };
    for (const k of VALUE_FIELDS) { const detail = valueProblem(k, !posts?.has(k)); if (detail) return { why: `the script changed t.${k} outside a hook`, detail }; }
    guardJSON = json;
    return null;
  }
  /** One job on a rules Worker's mirror (spec §3f.2): guard(), then apply()
   *  in a journal — {changed, patch: its StatePatch, out: {effects (all it
   *  queued, drained), error?: {hook, message} (a hook failed: the rules are
   *  off, and the patch says so)}} — or {fatal, detail?} when the script
   *  broke the rules between jobs (guard's why and detail). A mirror never
   *  broadcasts: its dirty sets are emptied after each job. */
  function job(p, a) {
    const broke = guard();
    if (broke) return { fatal: broke.why, ...(broke.detail && { detail: broke.detail }) };
    wantPatch = true;
    lastPatch = null;
    try {
      const changed = apply(p, a);
      return { changed, patch: lastPatch || {}, out: { effects: effects.splice(0), ...(jobError && { error: jobError }) } };
    } finally {
      wantPatch = false;
      lastPatch = null;
      dirty = newDirty();
      boardsMoving = false;
    }
  }
  /** A cheap structural hash of the table (spec §3f.3): its items, players
   *  and rules (code, name, enabled, data, public, asks, secret, hints) —
   *  no seq, no log, no keys — equal on a host and the Worker mirror whose
   *  patches it applied. */
  function digest() {
    syncSpots();
    const r = host.rules;
    return cyrb53(canon({ items: host.items, players: host.players, rules: r ? { ...Object.fromEntries(RULES_STATE.map((k) => [k, r[k] ?? {}])), code: r.code, name: r.name, enabled: r.enabled } : null }));
  }

  return {
    state: host,
    api: tApi, // the rules facade `t`
    byKind, byType, byOwner,
    /** T.byAt (a qualified address → the pieces there) and T.byZone ('<board
     *  id>:<zone id>' → the pieces in it), brought up to date (syncSpots). */
    get byAt() { syncSpots(); return byAt; },
    get byZone() { syncSpots(); return byZone; },
    /** The table's structured boards: tableBoards() of its items, kept. */
    get boards() { return tb(); },
    snapPiece, display,
    /** The game boxes of the catalog: {boxId: Box} (where each came from: state.boxSrc). */
    get boxes() { return host.boxes; },
    /** id → public item for every item on the table: publicItems(), kept incrementally. */
    get pub() { refresh(); return pub; },
    /** How many items on the table one could hold in a hand (the view's `handy` is T.handy > 0). */
    get handy() { refresh(); return handy.size; },
    /** The last rules-script error, for the rules dialog ('' after a successful enable). */
    get rulesError() { return lastRulesError; },
    /** Whether a rules hook is running now (spec §3f.7: the facade is live only then). */
    get inHook() { return inHook > 0; },
    apply, join, bindKey, open, resume, mayAct, publicItems, publicPlayers, unsaveable, drag, exportBox,
    /** Player p's last connection closed (the _leave job). True if they had a seat (now offline). */
    leave: (p) => apply(p, { t: '_leave' }),
    /** Fires the script timers that are due (the _tick job); true if any ran. */
    runTimers: () => apply(RULES, { t: '_tick' }),
    /** Every asset id the table's decks and boxes show: the only images the host serves (app.js). */
    assetRefs: () => assetRefs(host.decks, host.boxes),
    takeDirty, patchContent, snapContent, mine, refreshFor, applyStatePatch,
    /** Reads the addresses a board's change concerns again now (syncSpots):
     *  the host does before a rules Worker copies its state. */
    syncSpots,
    // the journal (spec §3f.4), and a rules Worker's side (§3f.2, §3f.3, §3f.7)
    begin, savepoint, rollbackTo, rollback: () => rollbackTo(0), checkpoint: () => savepoint(), commit, job, guard, digest,
    /** The state as saved: all of it but the catalog (decks, boxes and where
     *  each box came from), which store.js keeps apart, each written once,
     *  and the rules' hints, which are never saved (spec §3h). */
    snapshot() {
      flushRuns();
      syncSpots();
      const { decks, boxes, boxSrc, ...s } = host;
      if (s.rules) { const { hints, ...r } = s.rules; s.rules = r; }
      return s;
    },
    /** The effects queued since the last drain, oldest first (see the top of this file). */
    drain() { const out = effects; effects = []; return out; },
  };
}
