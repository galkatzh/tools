// Card Table — the state core: the table's state and every operation on it.
//
// No DOM, network, storage or timers here, so the page (app.js), a rules
// Worker and Node tests all run the same state code (TABLETOP.md §5, §7).
// It imports nothing and runs in a page, in a module Worker and in Node 22.
//
// The host owns one table: `const T = createTable(state, env)`.
//  • state is plain JSON, version STATE_V — {v, seq, size, items, players,
//    keys, log, rules, decks, guestDeckChars, zMax} — the host's authoritative
//    copy, so it is called `host` below. T mutates it in place; T.state is
//    that same object, which the app saves (T.snapshot(), decks apart).
//    Older saves are lifted on the way in (migrate, MIGRATE).
//  • env injects what isn't pure: {pid (the host's own player id), now()
//    (Date.now), random() (crypto), uid() (8 hex digits, crypto: the ids of
//    new items and decks), hooks (the rules runner, see scriptHooks)}.
//    Seed now, random and uid, and two tables replay alike.
//  • Side effects become data: every call queues effects, in order, and the
//    app takes them with T.drain() after each call:
//      {t:'fx', f}         an action marker {p, id, x, y} (the name bulbs)
//      {t:'ann', msg}      a banner for every screen (t.announce)
//      {t:'note', p, msg}  a private notice for player p
//      {t:'peek', p, c}    a peeked card {d, i}, for player p's eyes only
//      {t:'toast', msg}    a notice for the host's own screen (script errors)
//      {t:'deck', id}      a new deck, to send to everyone
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

// --- versions -----------------------------------------------------------------
/** The code version every cardtable module exports, and every import of one
 *  carries (`./core.js?v=1`): bumped in all of them by every change to any,
 *  so a page never mixes a fresh module with a cached one (app.js checks). */
export const MODULE_V = 1;
/** The wire protocol: actions carry it as `_v`, host bodies as `v`; a peer
 *  on another version is refused loudly rather than misread. */
export const PROTO = 2;
/** The host state's schema version (state.v), the newest MIGRATE target. */
export const STATE_V = 2;

// --- table geometry ---------------------------------------------------------
// The table is a circle: a square logical space with a round felt. A circle is
// rotation-invariant, which is what makes per-player arbitrary view rotation
// (and seats anywhere on the rim) work without letterboxing. Its diameter is
// part of the state (state.size): the host can grow the table for bigger groups.
export const CARD_W = 100, CARD_H = 140;
export const TABLE_SIZES = { 1300: 'small', 1800: 'medium', 2400: 'large' };
const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ecd444', '#ee6352', '#9ac2c9', '#8acb88', '#1be7ff'];
/** Max distance of a card's center from the center of a table `size` units across. */
export const playR = (size) => size / 2 - 110;

/** Radially clamps an item's top-left position so the card stays on a felt `size` units across. */
export function clampToFelt(x, y, size) {
  const r = playR(size), cx = x + CARD_W / 2 - size / 2, cy = y + CARD_H / 2 - size / 2;
  const d = Math.hypot(cx, cy);
  if (d <= r) return { x, y };
  const f = r / d;
  return { x: size / 2 + cx * f - CARD_W / 2, y: size / 2 + cy * f - CARD_H / 2 };
}

// --- small helpers --------------------------------------------------------
export const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const uid = () => rand(4);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** obj[key] only when it's the object's OWN property — never Object.prototype
 *  via a crafted id like "__proto__" or "constructor". Only a string or a
 *  number is a key: a peer's {"toString": 1} would make Object.hasOwn throw. */
export const own = (obj, key) => ((typeof key === 'string' || typeof key === 'number') && Object.hasOwn(obj, key) ? obj[key] : null);
/** A finite number from untrusted input, else the fallback. */
export const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const normRot = (v) => ((num(v) % 360) + 360) % 360;
/** Player ids: 16 hex digits (app.js mints them; the host refuses others). */
export const PID_RE = /^[0-9a-f]{16}$/;
/** A uniform float in [0, 1) from the crypto RNG (the default env.random).
 *  Drawn from a refilled pool: one getRandomValues call per card would make
 *  shuffling a 5000-card pile ~30× slower than Math.random. */
const pool = new Uint32Array(1024);
let poolLeft = 0;
const cryptoRandom = () => {
  if (!poolLeft) { crypto.getRandomValues(pool); poolLeft = pool.length; }
  return pool[--poolLeft] / 2 ** 32;
};

// --- data hygiene: decks pass one sanitizer (strict image references, strict
// color grammar, size caps) before anything renders them ---------------------
// A deck travels in two shapes. The catalog shape (v2, cleanDeck) is what the
// table holds, saves and sends: its images are asset ids, the SHA-256 of
// their bytes, which store.js keeps and every peer pulls by hash (app.js).
// The transport shape (v1, cleanDeckV1) carries the images as data URLs: an
// upload, a save from before Phase 1. It only ever goes to store.js's
// ingestDeck, which checks every image and turns the deck into the v2 shape.
export const IMG_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
/** An image's asset id: the hex SHA-256 of its bytes. */
export const ASSET_RE = /^[0-9a-f]{64}$/;
/** The image types a deck may carry (as IMG_RE's data URLs, or as assets). */
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
 *  images as data URLs (IMG_RE) in `imgs`, a card's `img` or the `back`, at
 *  most 24 MB of them. It runs first on every addDeck, and the guests' deck
 *  budget is measured on its result (JSON length) before anything is decoded;
 *  then store.js's ingestDeck turns it into the v2 shape. Throws on unusable decks. */
export function cleanDeckV1(d) {
  const { name, imgs, cards } = deckParts(d, (s) => IMG_RE.test(s), true);
  const bytes = [...imgs, ...cards.map((c) => c.img)].reduce((n, s) => n + (s?.length || 0), 0);
  if (bytes > MAX_DECK_BYTES) throw new Error('deck images are too large (24 MB max)');
  return { name, back: IMG_RE.test(d.back) || COLOR_RE.test(d.back) ? d.back : null, imgs, cards };
}

/** Every asset id the decks of `decks` (a deck map) show: their images and image backs. */
export function assetRefs(decks) {
  const refs = new Set();
  for (const d of Object.values(decks)) {
    for (const h of d.imgs || []) if (h) refs.add(h);
    if (d.backImg) refs.add(d.backImg);
  }
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
  return { name: 'Standard', back: null, cards };
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
export function itemLabel(decks, it) {
  if (it.k === 'c') return it.up ? cardName(decks, it.d, it.i) : 'a face-down card';
  return `the ${it.name || 'stacked'} pile`;
}

// --- rules engine (see ENGINE.md) ------------------------------------------
// Host-only execution of a host-written script that can veto actions
// (validate) and drive automations (setup/onAction/onButton/onJoin/onLeave/
// onTimer) through the same audited ops as human actions. The engine knows
// no game concepts — all game semantics live in the script.
export const RULES = 'RULES'; // synthetic actor id for script-performed ops
export const RULED_ACTIONS = new Set(['move', 'rot', 'flip', 'shuffle', 'draw', 'deal', 'play', 'handPile', 'toHand', 'toPile', 'stack', 'merge', 'del', 'addDeck', 'peek']);
/** Every action type a guest may send: the host refuses anything else at the
 *  network boundary. Host-only actions (size, setRules) and the host's
 *  internal jobs (types starting with "_") never come from the wire. */
export const PUBLIC_ACTIONS = new Set([...RULED_ACTIONS, 'hello', 'snap', 'need', 'name', 'chat', 'rulesBtn']);
/** Actions that take from or give to the actor's hand: a refusal re-sends it. */
const HAND_ACTIONS = new Set(['play', 'handPile', 'toHand', 'draw']);
/** How many of an action's `ids` a refusal re-sends. No Phase 1 action
 *  carries ids; group actions (Phase 4) bring their own cap. A small one keeps
 *  a vetoed action from making the host re-send many items to everyone. */
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
/** An item as players see it — hidden identities stay on the host. A pile
 *  becomes {…, n: count, top} (a face-down top keeps only its deck, for the
 *  back), and a face-down loose card loses its index `i`. Everyone renders
 *  this one shape, the host included; only host LOGIC reads host.items. */
function pubItem(it) {
  if (it.k === 'p') {
    const { cards, ...rest } = it, top = cards.at(-1);
    return { ...rest, n: cards.length, top: top && (top.up ? { ...top } : { d: top.d, up: false }) };
  }
  const { i, ...rest } = it;
  return it.up ? { ...rest, i } : rest;
}
/** A player as everyone sees them: a hand COUNT, never the hand (nor the seat key, kept in state.keys). */
const pubPlayer = (pl) => ({ name: pl.name, color: pl.color, online: pl.online, handCount: pl.hand.length, seat: pl.seat });

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
// A body is a snapshot {v, kind:'snap', boot, seq, host, size, rules, items,
// players, log, fx, ann} or a patch {v, kind:'patch', boot, seq, host, size?,
// rules?, items?, del?, players?, log?, fx?, ann?}, plus the recipient's own
// fields {to, tp, base (patches), hand?}. The shared part is serialized once
// per broadcast tick and each recipient's body is spliced from it as text.
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

// A guest's view: {seq, boot, host, size, rules, items, players, log, hand}.
// items and players are null-prototype maps: an id from the wire is only
// ever a key, never Object.prototype (a legacy unsigned room can send anything).
const dict = (o) => Object.assign(Object.create(null), o && typeof o === 'object' && !Array.isArray(o) ? o : {});
const entries = (l) => (Array.isArray(l) ? l.filter((e) => e && typeof e === 'object') : []);
/** A guest's whole view from a snapshot body. */
export function viewFromSnap(d) {
  return {
    seq: d.seq, boot: d.boot, host: d.host, size: own(TABLE_SIZES, d.size) ? +d.size : 1300, rules: d.rules ?? null,
    items: dict(d.items), players: dict(d.players), log: trimLog(entries(d.log)), hand: Array.isArray(d.hand) ? d.hand : [],
  };
}
/** Folds a patch body into view V, in place: items and players are replaced
 *  whole, `del` removed, log entries appended (then trimmed), the hand
 *  replaced when present. Returns what it replaced, for the renderer:
 *  {items: Map<id, old public item | undefined (new)>, players: Map<pid, old | undefined>}. */
export function applyViewPatch(V, d) {
  const items = new Map(), players = new Map();
  for (const [id, it] of Object.entries(dict(d.items))) { items.set(id, V.items[id]); V.items[id] = it; }
  for (const id of Array.isArray(d.del) ? d.del : []) {
    if (!items.has(id)) items.set(id, V.items[id]);
    delete V.items[id];
  }
  for (const [p, pl] of Object.entries(dict(d.players))) { players.set(p, V.players[p]); V.players[p] = pl; }
  if ('rules' in d) V.rules = d.rules;
  if (own(TABLE_SIZES, d.size)) V.size = +d.size;
  if (Array.isArray(d.log)) V.log = trimLog(V.log.concat(entries(d.log)));
  if (Array.isArray(d.hand)) V.hand = d.hand;
  V.seq = d.seq;
  return { items, players };
}

// --- the table ---------------------------------------------------------------
// decks:  {deckId: Deck v2 (cleanDeck): {name, back, backImg?, imgs: [asset id], cards: [{r,s,c} | {g?, n?, txt?, …}]}}
// items:  {itemId: card {k:'c',x,y,rot,z,d,i,up} | pile {k:'p',x,y,rot,z,name,cards:[{d,i,up}]}}
// players: {pid: {name, color, online, seat, hand:[{d,i}]}}; keys: {pid: seat key}
/** A table over `host` (its state, mutated in place) — see the top of this file. */
export function createTable(host, env = {}) {
  const pid = env.pid;
  // Host-only powers (setRules, size, no deck budget) go to `p === pid`: an
  // unset pid would hand them to any caller that passes no player id.
  if (!pid || typeof pid !== 'string' || pid === RULES) throw new Error(`createTable: env.pid must be the host's player id, got ${pid}`);
  const now = env.now || Date.now, random = env.random || cryptoRandom, hooks = env.hooks || scriptHooks();
  const newId = env.uid || uid;
  host.seq ??= 1;
  host.items ??= {};
  host.players ??= {};
  host.log ||= []; // saves from before the log existed
  host.size ||= 1300;
  // Core reads host.decks afresh at every use (never a captured copy), so a
  // resync or a rollback may replace it.
  host.decks ??= {};
  migrate(host);
  host.keys ??= {};
  host.zMax = Object.values(host.items).reduce((m, it) => Math.max(m, num(it.z)), num(host.zMax));
  let effects = []; // queued for the app (T.drain)
  let marks = 0;    // action markers so far: apply()'s "it really happened" signal
  let lastRulesError = ''; // shown in the rules dialog
  const emit = (e) => { effects.push(e); };

  // --- what changed since the last broadcast tick: the dirty sets ------------
  // Not persisted; T.takeDirty() hands them over and starts afresh.
  const newDirty = () => ({
    items: new Set(),   // put/touch: an item created or changed
    removed: new Set(), // remove: an item deleted
    players: new Set(), // anything publicPlayers shows changed (name, colour, online, handCount, seat)
    hands: new Set(),   // that player's private hand changed
    rules: false,       // rules meta or public changed (found by comparison, in takeDirty)
    size: false,
    log: [],            // entries appended
  });
  let dirty = newDirty();
  const pub = new Map();   // T.pub: id → public item, refreshed lazily for the ids in `stale`
  const stale = new Set(Object.keys(host.items));
  /** T.byKind: 'c' (cards) and 'p' (piles) → their ids, for indexed script reads. */
  const byKind = new Map([['c', new Set()], ['p', new Set()]]);
  for (const [id, it] of Object.entries(host.items)) byKind.get(it.k)?.add(id);

  // --- item writes ---------------------------------------------------------
  // Every change to host.items goes through put / remove / touch, and every
  // change to a player through touchPlayer: what delta sync sends is exactly
  // what was recorded here.
  /** Places item `it` under `id` (new, or replacing one); returns the id. */
  const put = (id, it) => {
    const old = own(host.items, id);
    if (old) byKind.get(old.k)?.delete(id);
    host.items[id] = it;
    byKind.get(it.k)?.add(id);
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
    byKind.get(it.k)?.delete(id);
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
  /** A new id for `map` (host.items or host.decks): host-minted, never one in use. */
  const mint = (map) => {
    let id = newId();
    while (own(map, id)) id = newId();
    return id;
  };
  /** The next z on top of everything: a running max, never a scan of the table. */
  const zTop = () => ++host.zMax;
  /** Brings the cached public items (T.pub) up to date. */
  function refresh() {
    for (const id of stale) {
      const it = own(host.items, id);
      if (it) pub.set(id, pubItem(it));
      else pub.delete(id);
    }
    stale.clear();
  }

  /** Picks a seat angle for a new player: bottom first, then always the middle
   *  of the largest empty arc — 2 players sit opposite, a 3rd between them, etc.
   *  (Angles are table-space degrees; 90° = the table's "south" rim.) */
  function assignSeat() {
    const seats = Object.values(host.players).map((pl) => pl.seat).filter((s) => s != null).sort((a, b) => a - b);
    if (!seats.length) return 90;
    if (seats.length === 1) return (seats[0] + 180) % 360;
    let best = 0, bestGap = -1;
    for (let i = 0; i < seats.length; i++) {
      const a = seats[i], b = i + 1 < seats.length ? seats[i + 1] : seats[0] + 360;
      if (b - a > bestGap) { bestGap = b - a; best = (a + (b - a) / 2) % 360; }
    }
    return best;
  }

  /** Seats player p (new, or back online), filling an empty name. True when
   *  that changed anything: the app registers the sender of every action
   *  here, and an unchanged player must not travel with each of them. */
  function ensurePlayer(p, name) {
    const known = own(host.players, p), pl = known || (host.players[p] = { name: '', color: freeColor(), online: true, hand: [] });
    const was = known && `${pl.seat}|${pl.online}|${pl.name}`;
    pl.seat ??= assignSeat();
    pl.online = true;
    // Only fill an empty name here — explicit renames go through the 'name'
    // action so they land in the log.
    if (name && !pl.name) pl.name = cleanName(name);
    if (was === `${pl.seat}|${pl.online}|${pl.name}`) return false;
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
   *  other player sees. Call BEFORE deleting an item so the position survives. */
  function mark(p, id) {
    const it = host.items[id];
    marks++;
    emit({ t: 'fx', f: { p, id, x: it?.x ?? 0, y: it?.y ?? 0 } });
  }

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
  // Resolve a hand index robustly: guests send both the index and the card they
  // see there; if the hand changed in flight, fall back to the first match.
  // An empty slot never matches (a missing d/i would equal its undefined),
  // so an index past the hand finds nothing: -1.
  function handIdx(pl, a) {
    const c = Number.isInteger(a.idx) && pl.hand[a.idx];
    if (c && c.d === a.d && c.i === a.i) return a.idx;
    return pl.hand.findIndex((c) => c.d === a.d && c.i === a.i);
  }

  /** State changed: renumber it. Returns true (the caller's "changed"). */
  function bump() {
    host.seq++;
    return true;
  }

  // --- core table ops ---------------------------------------------------------
  // Shared between apply() and the rules-script facade, so scripted automations
  // mutate state through exactly the same audited path as human actions.
  // `actor` is a player id or RULES; every op logs and marks as that actor.

  /** Deals the top card of a pile — to a player's hand ({to}) or onto the table. */
  function opDealTop(actor, pileId, o = {}) {
    const pile = own(host.items, pileId);
    const c = pile?.k === 'p' && pile.cards.pop();
    if (!c) { console.warn('opDealTop: no card to deal', pileId); return false; }
    let nid = null;
    if (o.to) {
      const pl = own(host.players, o.to);
      if (!pl) { pile.cards.push(c); console.warn('opDealTop: unknown player', o.to); return false; }
      pl.hand.push({ d: c.d, i: c.i });
      touchPlayer(o.to, { hand: true });
      logEvent(actor, `dealt a card from ${itemLabel(host.decks, pile)} to ${pl.name || 'a player'}`);
    } else {
      const at = clampToFelt(num(o.x, pile.x + CARD_W + 18), num(o.y, pile.y), host.size);
      nid = put(mint(host.items), { k: 'c', x: at.x, y: at.y, rot: normRot(o.rot), z: zTop(), d: c.d, i: c.i, up: !!o.up });
      logEvent(actor, `dealt ${o.up ? cardName(host.decks, c.d, c.i) : 'a card face down'} from ${itemLabel(host.decks, pile)}`);
      mark(actor, nid);
    }
    touch(pileId);
    mark(actor, pileId);
    dropIfEmpty(pileId);
    // the dealt card's identity, so scripts can track what they dealt
    return o.to ? { d: c.d, i: c.i } : { id: nid, d: c.d, i: c.i };
  }

  function opShuffle(actor, pileId) {
    const pile = own(host.items, pileId);
    if (pile?.k !== 'p') return false;
    for (let i = pile.cards.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pile.cards[i], pile.cards[j]] = [pile.cards[j], pile.cards[i]];
    }
    touch(pileId);
    logEvent(actor, `shuffled ${itemLabel(host.decks, pile)} (${pile.cards.length} cards)`);
    mark(actor, pileId);
    return true;
  }

  function opFlip(actor, id) {
    const it = own(host.items, id);
    if (!it) return false;
    if (it.k === 'c') {
      it.up = !it.up;
      logEvent(actor, `flipped ${cardName(host.decks, it.d, it.i)} face ${it.up ? 'up' : 'down'}`);
    } else {
      it.cards.reverse();
      for (const c of it.cards) c.up = !c.up;
      logEvent(actor, `flipped ${itemLabel(host.decks, it)}`);
    }
    touch(id);
    mark(actor, id);
    return true;
  }

  function opToPile(actor, cardId, pileId) {
    const it = own(host.items, cardId), pile = own(host.items, pileId);
    if (it?.k !== 'c' || pile?.k !== 'p') return false;
    logEvent(actor, `put ${itemLabel(host.decks, it)} onto ${itemLabel(host.decks, pile)}`);
    mark(actor, pileId);
    pile.cards.push({ d: it.d, i: it.i, up: it.up });
    touch(pileId);
    remove(cardId);
    return true;
  }

  function opNewPile(actor, cards, o = {}) {
    const at = clampToFelt(o.x ?? host.size / 2 - CARD_W / 2, o.y ?? host.size / 2 - CARD_H / 2, host.size);
    const nid = put(mint(host.items), { k: 'p', x: at.x, y: at.y, rot: 0, z: zTop(), name: String(o.name || '').slice(0, 24), cards: cards.map((c) => ({ d: c.d, i: c.i, up: !!c.up })) });
    logEvent(actor, `made a pile of ${cards.length} cards`);
    mark(actor, nid);
    return nid;
  }

  /** Stacks card `id` onto card `ontoId`: both become a new pile where `ontoId` lay. Returns its id. */
  function opStack(actor, id, ontoId) {
    const it = own(host.items, id), b = own(host.items, ontoId);
    if (it?.k !== 'c' || b?.k !== 'c' || it === b) return false;
    logEvent(actor, `stacked ${itemLabel(host.decks, it)} onto ${itemLabel(host.decks, b)}`);
    const nid = put(mint(host.items), { k: 'p', x: b.x, y: b.y, rot: b.rot, z: zTop(), name: '', cards: [{ d: b.d, i: b.i, up: b.up }, { d: it.d, i: it.i, up: it.up }] });
    remove(id);
    remove(ontoId);
    mark(actor, nid);
    return nid;
  }

  /** Moves a player's hand onto a pile, face down: every card, or only those
   *  `only({d, i})` picks (scripts: "my game's deck", leaving others' cards). */
  function opTakeHand(actor, p, pileId, only) {
    const pl = own(host.players, p), pile = own(host.items, pileId);
    if (!pl || pile?.k !== 'p') return false;
    const out = typeof only === 'function' ? pl.hand.filter((c) => only({ d: c.d, i: c.i })) : pl.hand.slice();
    if (out.length) {
      const whose = out.length === pl.hand.length ? `${pl.name || 'a player'}'s hand` : `cards from ${pl.name || 'a player'}'s hand`;
      logEvent(actor, `returned ${whose} (${out.length}) to ${itemLabel(host.decks, pile)}`);
      mark(actor, pileId);
      pl.hand = pl.hand.filter((c) => !out.includes(c));
      touchPlayer(p, { hand: true });
      for (const c of out) pile.cards.push({ d: c.d, i: c.i, up: false });
      touch(pileId);
    }
    return true;
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
    // (a card not in hand, a vanished item) never reaches the script, and for
    // the ones that did happen the payload's ids were matched host-side.
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
        const at = clampToFelt(num(a.x, host.size / 2 - CARD_W / 2), num(a.y, host.size / 2 - CARD_H / 2), host.size);
        const nid = put(mint(host.items), {
          k: 'p', x: at.x, y: at.y, rot: 0, z: zTop(), name: deck.name,
          cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })),
        });
        logEvent(p, `added deck "${deck.name}" (${deck.cards.length} cards)`);
        mark(p, nid);
        break;
      }
      case 'move':
        if (it) {
          ({ x: it.x, y: it.y } = clampToFelt(num(a.x, it.x), num(a.y, it.y), host.size));
          it.z = zTop();
          touch(a.id);
          logEvent(p, `moved ${itemLabel(host.decks, it)}`);
          mark(p, a.id);
        }
        break;
      case 'rot': if (it) { it.rot = normRot(a.rot); touch(a.id); logEvent(p, `rotated ${itemLabel(host.decks, it)}`); mark(p, a.id); } break;
      case 'flip': if (it) opFlip(p, a.id); break;
      case 'shuffle': if (it?.k === 'p') opShuffle(p, a.id); break;
      case 'draw': {
        const c = it?.k === 'p' && pl && it.cards.pop(); // a player with no seat takes nothing
        if (c) {
          pl.hand.push({ d: c.d, i: c.i });
          touchPlayer(p, { hand: true });
          touch(a.id);
          logEvent(p, `drew a card from ${itemLabel(host.decks, it)}`);
          mark(p, a.id);
          dropIfEmpty(a.id);
        }
        break;
      }
      case 'deal': if (it?.k === 'p') opDealTop(p, a.id, { x: a.x, y: a.y, up: !!a.up, rot: a.rot }); break;
      case 'play': {
        const idx = pl && handIdx(pl, a);
        if (pl && idx >= 0) {
          const c = pl.hand.splice(idx, 1)[0];
          touchPlayer(p, { hand: true });
          const at = clampToFelt(num(a.x, host.size / 2), num(a.y, host.size / 2), host.size), up = !!a.up;
          const nid = put(mint(host.items), { k: 'c', x: at.x, y: at.y, rot: normRot(a.rot), z: zTop(), d: c.d, i: c.i, up });
          logEvent(p, `played ${up ? cardName(host.decks, c.d, c.i) : 'a card face down'} from hand`);
          mark(p, nid);
        }
        break;
      }
      case 'handPile': {
        const idx = pl && handIdx(pl, a);
        const pile = own(items, a.pile);
        if (pl && idx >= 0 && pile?.k === 'p') {
          const c = pl.hand.splice(idx, 1)[0];
          touchPlayer(p, { hand: true });
          // A card discarded onto a pile matches the pile's exposed face
          // (face up onto a face-up pile, face down onto a deck).
          const up = pile.cards.at(-1)?.up ?? false;
          pile.cards.push({ d: c.d, i: c.i, up });
          touch(a.pile);
          logEvent(p, `put ${up ? cardName(host.decks, c.d, c.i) : 'a card face down'} from hand onto ${itemLabel(host.decks, pile)}`);
          mark(p, a.pile);
        }
        break;
      }
      case 'toHand':
        if (it?.k === 'c' && pl) {
          logEvent(p, `took ${itemLabel(host.decks, it)} from the table into hand`);
          mark(p, a.id);
          pl.hand.push({ d: it.d, i: it.i });
          touchPlayer(p, { hand: true });
          remove(a.id);
        }
        break;
      case 'toPile': opToPile(p, a.id, a.pile); break;
      case 'stack': opStack(p, a.id, a.onto); break;
      case 'merge': {
        const to = own(items, a.pile);
        if (it?.k === 'p' && to?.k === 'p' && it !== to) {
          logEvent(p, `merged ${itemLabel(host.decks, it)} (${it.cards.length} cards) into ${itemLabel(host.decks, to)}`);
          mark(p, a.pile);
          to.cards.push(...it.cards);
          touch(a.pile);
          remove(a.id);
        }
        break;
      }
      case 'del':
        if (it) {
          logEvent(p, `removed ${itemLabel(host.decks, it)}${it.k === 'p' ? ` (${it.cards.length} cards)` : ''}`);
          mark(p, a.id);
          remove(a.id);
        }
        break;
      // Peek is deliberately "loud": the reveal happens on the peeker's screen
      // only, but the fact of peeking goes on the record for everyone. Guests
      // never hold hidden identities (see publicItems), so the host answers
      // the peeker alone (the 'peek' effect).
      case 'peek': {
        const c = it?.k === 'c' ? !it.up && it : it?.k === 'p' && it.cards.at(-1);
        if (!c) break;
        logEvent(p, it.k === 'c' ? 'peeked at a face-down card' : `peeked at the top card of ${itemLabel(host.decks, it)}`, false, undefined, true);
        mark(p, a.id);
        emit({ t: 'peek', p, c: { d: c.d, i: c.i } });
        break;
      }
      case 'size': {
        // Host-only: the size selector is only shown to the host, and the host
        // applies its own actions, so p must be the host's own player id.
        const size = own(TABLE_SIZES, a.size) && +a.size;
        if (p === pid && size && size !== host.size) {
          const shift = (size - host.size) / 2; // items stay centered on the felt
          host.size = size;
          dirty.size = true;
          for (const [id, o] of Object.entries(items)) {
            ({ x: o.x, y: o.y } = clampToFelt(o.x + shift, o.y + shift, size));
            touch(id);
          }
          logEvent(p, `set the table size to ${TABLE_SIZES[size]}`);
        }
        break;
      }
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
    // A ruled action that did nothing (its target had just gone: a pile merged
    // away under a drop) re-sends what it named, like a refusal: the actor's
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
    put(mint(host.items), {
      k: 'p', x: host.size / 2 - CARD_W / 2, y: host.size / 2 - CARD_H / 2, rot: 0, z: zTop(),
      name: deck.name, cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })),
    });
    logEvent(pid, 'opened the table');
  }

  /** Resumes a saved table in the host's browser, the host seated as `name`.
   *  Saves may predate the sanitizer (and could hold a deck a guest crafted),
   *  so their decks pass it again; a saved rules script that no longer loads
   *  disables the rules loudly rather than wedging the resume. */
  function resume(name) {
    const decks = {}; // a fresh map: a corrupt save may hold a string or an array here
    for (const [id, d] of Object.entries(host.decks)) {
      try { decks[id] = cleanDeck(d); } catch (err) { console.error(`saved deck ${id} dropped`, err); }
    }
    host.decks = decks;
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
    // Migrate older saves: seats didn't exist, and the table used to be a
    // larger rectangle — pull stranded items back onto the round felt.
    for (const [p, pl] of Object.entries(host.players)) {
      pl.online = false;
      pl.seat ??= assignSeat();
      touchPlayer(p);
    }
    for (const [id, it] of Object.entries(host.items)) {
      ({ x: it.x, y: it.y } = clampToFelt(it.x, it.y, host.size));
      touch(id);
    }
    ensurePlayer(pid, name);
    logEvent(pid, 'resumed the table');
    bump();
  }

  // --- the engine around the script ------------------------------------------
  const FIND_KEYS = ['kind', 'name', 'up'];
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
  const copyItem = (id, it) => ({ id, ...it, ...(it.cards && { cards: it.cards.map((c) => ({ ...c })) }) });
  /** Runs one script hook; any throw disables the rules loudly. */
  function runHook(name, ...args) {
    if (!host.rules?.enabled || !hooks.has(name)) return undefined;
    try {
      return callHook(name, ...args);
    } catch (err) {
      hookFailed(name, err);
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
   *  per job (plus one after validate), not one per hook. True when the
   *  rules were disabled (a change: the caller renumbers). */
  function dataOver() {
    const names = [...jobHooks].join('(), ');
    jobHooks.clear();
    const n = names && host.rules?.enabled ? JSON.stringify(host.rules.data)?.length || 0 : 0;
    if (n <= DATA_MAX_CHARS) return false;
    hookFailed(names, new Error(`t.data is too large (${n.toLocaleString('en-US')} chars, max ${DATA_MAX_CHARS.toLocaleString('en-US')})`));
    return true;
  }
  /** A script error: disable the rules, loudly and on the record. */
  function hookFailed(name, err) {
    console.error(`rules hook ${name}() failed`, err);
    lastRulesError = `${name}(): ${err.message}`;
    host.rules.enabled = false;
    emit({ t: 'rules' });
    logEvent(RULES, `rules disabled — script error in ${name}()`);
    emit({ t: 'toast', msg: `Rules disabled — error in ${name}(): ${err.message}` });
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
      hookFailed('buttons', err);
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

  // The script's window onto the table: full read access, the complete op set
  // (audited as the "📜 Rules" actor), scratch state, and player interaction.
  const tApi = {
    get data() { return host.rules.data; },
    get public() { return host.rules.public; },
    set public(v) { host.rules.public = v || {}; },
    players: () => Object.entries(host.players)
      .filter(([, pl]) => pl.seat != null)
      .map(([id, pl]) => ({ id, name: pl.name, seat: pl.seat, online: pl.online, handCount: pl.hand.length, host: id === pid }))
      .sort((a, b) => a.seat - b.seat),
    hand: (p) => (own(host.players, p)?.hand || []).map((c) => ({ ...c })),
    /** Every item, copied: O(n) — t.item(id) and t.find(q) are the cheap reads. */
    items: () => Object.entries(host.items).map(([id, it]) => copyItem(id, it)),
    /** One item, copied ({id, ...item}), or null. */
    item: (id) => { const it = own(host.items, id); return it ? copyItem(id, it) : null; },
    /** The items matching q = {kind?: 'card'|'pile', name? (a pile's, any case), up?}, copied. */
    find(q = {}) {
      for (const k of Object.keys(q)) if (!FIND_KEYS.includes(k)) throw new TypeError(`t.find: unknown filter '${k}' — known: ${FIND_KEYS.join(', ')}`);
      const kinds = q.kind === undefined ? ['c', 'p'] : [own({ card: 'c', pile: 'p' }, q.kind)];
      if (!kinds[0]) throw new TypeError(`t.find: unknown kind '${q.kind}' — known: card, pile`);
      const name = q.name === undefined ? null : String(q.name).toLowerCase();
      const out = [];
      for (const k of kinds) {
        for (const [id, it] of ofKind(k)) {
          if (name !== null && (it.k !== 'p' || String(it.name || '').toLowerCase() !== name)) continue;
          if (q.up !== undefined && !!(it.k === 'c' ? it.up : it.cards.at(-1)?.up) !== !!q.up) continue;
          out.push(copyItem(id, it));
        }
      }
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
      const c = pl.hand.splice(idx, 1)[0];
      touchPlayer(p, { hand: true });
      const at = clampToFelt(o.x ?? host.size / 2 - CARD_W / 2, o.y ?? host.size / 2 - CARD_H / 2, host.size);
      const nid = put(mint(host.items), { k: 'c', x: at.x, y: at.y, rot: normRot(o.rot), z: zTop(), d: c.d, i: c.i, up: o.up !== false });
      logEvent(RULES, `played ${o.up !== false ? cardName(host.decks, c.d, c.i) : 'a card face down'} from ${pl.name || 'a player'}'s hand`);
      mark(RULES, nid);
      return nid;
    },
    toHand(p, cardId) {
      const it = own(host.items, cardId), pl = own(host.players, p);
      if (it?.k !== 'c' || !pl) return false;
      logEvent(RULES, `gave ${itemLabel(host.decks, it)} to ${pl.name || 'a player'}`);
      mark(RULES, cardId);
      pl.hand.push({ d: it.d, i: it.i });
      touchPlayer(p, { hand: true });
      remove(cardId);
      return true;
    },
    shuffle: (id) => opShuffle(RULES, id),
    flip: (id) => opFlip(RULES, id),
    toPile: (cardId, pileId) => opToPile(RULES, cardId, pileId),
    stack: (id, ontoId) => opStack(RULES, id, ontoId),
    newPile: (cards, o) => opNewPile(RULES, cards, o),
    merge(fromId, toId) {
      const from = own(host.items, fromId), to = own(host.items, toId);
      if (from?.k !== 'p' || to?.k !== 'p' || from === to) return false;
      logEvent(RULES, `merged ${itemLabel(host.decks, from)} (${from.cards.length} cards) into ${itemLabel(host.decks, to)}`);
      mark(RULES, toId);
      to.cards.push(...from.cards);
      touch(toId);
      remove(fromId);
      return true;
    },
    move(id, x, y) {
      const it = own(host.items, id);
      if (!it) return false;
      ({ x: it.x, y: it.y } = clampToFelt(x, y, host.size));
      it.z = zTop();
      touch(id);
      logEvent(RULES, `moved ${itemLabel(host.decks, it)}`);
      mark(RULES, id);
      return true;
    },
    rot(id, deg) {
      const it = own(host.items, id);
      if (!it) return false;
      it.rot = normRot(deg);
      touch(id);
      logEvent(RULES, `rotated ${itemLabel(host.decks, it)}`);
      mark(RULES, id);
      return true;
    },
    remove(id) {
      const it = own(host.items, id);
      if (!it) return false;
      logEvent(RULES, `removed ${itemLabel(host.decks, it)}${it.k === 'p' ? ` (${it.cards.length} cards)` : ''}`);
      mark(RULES, id);
      remove(id);
      return true;
    },
    /** Registers a script-defined deck of image-less cards ({name, text, color,
     *  bg, meta} each) and returns its deckId — it creates NO pile, so scripts
     *  can keep big decks off the table (small piles via t.newPile([{d,i,up}])
     *  keep the broadcast state light). `back` may be a solid color ("#111"). */
    newDeck(def) {
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
      own(host.items, nid).name = deck.name;
      touch(nid);
      return nid;
    },
    geom: () => ({ size: host.size, cx: host.size / 2, cy: host.size / 2, r: playR(host.size) }),
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

  // --- the public view: what guests may know (full recomputes) -------------------
  function publicPlayers() {
    return Object.fromEntries(Object.entries(host.players).map(([p, pl]) => [p, pubPlayer(pl)]));
  }
  /** The table as players see it (see pubItem); T.pub holds the same, kept up to date incrementally. */
  function publicItems() {
    return Object.fromEntries(Object.entries(host.items).map(([id, it]) => [id, pubItem(it)]));
  }
  const rulesView = () => (host.rules ? { name: host.rules.name, enabled: host.rules.enabled, public: host.rules.public } : null);
  let rulesSig = JSON.stringify(rulesView()); // what the last takeDirty() saw

  // --- delta sync: the dirty sets, patches and snapshots ------------------------
  /** Hands over what changed since the last call (the dirty sets) and starts
   *  afresh. The app calls it once per broadcast tick. Scripts change
   *  t.public in place, so the rules are found dirty by comparison here. */
  function takeDirty() {
    refresh();
    const d = dirty, sig = JSON.stringify(rulesView());
    dirty = newDirty();
    if (sig !== rulesSig) { rulesSig = sig; d.rules = true; }
    return d;
  }
  /** The part of a patch every recipient shares, from a takeDirty() result:
   *  only what changed — whole public items and players, removed ids, new log
   *  entries — item ids in sorted order (creation order never shows). */
  function patchContent(d) {
    refresh();
    const c = {};
    if (d.size) c.size = host.size;
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
    return { size: host.size, rules: rulesView(), items, players: publicPlayers(), log: host.log };
  }
  /** Marks the items action `a` names (id, pile, onto, and the first
   *  NAMED_IDS of ids), and for a hand action p's hand, to be re-sent
   *  unchanged: after a refusal the actor's optimistic UI (a drag, a card
   *  taken from the hand) must snap back, and deltas only carry what is
   *  marked. True when anything was marked. */
  function touchNamed(p, a) {
    let any = false;
    for (const id of [a.id, a.pile, a.onto, ...(Array.isArray(a.ids) ? a.ids.slice(0, NAMED_IDS) : [])]) any = touch(id) || any;
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
   *  stay here), new decks (sanitized again), rules fields, log entries to
   *  append, counters, and refresh touches. Everything lands in the dirty
   *  sets; the caller renumbers (state.seq) and broadcasts. */
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
    if (s.rules) {
      const was = host.rules;
      host.rules = { ...was, ...s.rules };
      if (host.rules.code !== was?.code || host.rules.enabled !== was?.enabled) emit({ t: 'rules' });
    }
    if (own(TABLE_SIZES, s.size) && +s.size !== host.size) { host.size = +s.size; dirty.size = true; }
    if (Array.isArray(s.log)) {
      host.log = trimLog(host.log.concat(s.log));
      dirty.log = dirty.log.concat(s.log);
    }
    for (const k of ['zMax', 'guestDeckChars']) if (Number.isFinite(s[k])) host[k] = s[k];
    for (const id of s.refresh || []) touch(id);
    for (const p of s.refreshHands || []) if (own(host.players, p)) touchPlayer(p, { hand: true });
  }

  return {
    state: host,
    api: tApi, // the rules facade `t`
    byKind,
    /** id → public item for every item on the table: publicItems(), kept incrementally. */
    get pub() { refresh(); return pub; },
    /** The last rules-script error, for the rules dialog ('' after a successful enable). */
    get rulesError() { return lastRulesError; },
    apply, join, leave, open, resume, runTimers, mayAct, publicItems, publicPlayers,
    /** Every asset id the table's decks show: the only images the host serves (app.js). */
    assetRefs: () => assetRefs(host.decks),
    takeDirty, patchContent, snapContent, refreshFor, applyStatePatch,
    /** The state as saved: all of it but the decks, which are saved apart
     *  (store.js's catalog: written once, when a deck is added). */
    snapshot() { const s = { ...host }; delete s.decks; return s; },
    /** The effects queued since the last drain, oldest first (see the top of this file). */
    drain() { const out = effects; effects = []; return out; },
  };
}
