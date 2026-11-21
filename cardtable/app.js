// Card Table — a serverless multiplayer card-game simulator.
//
// Architecture (see mdmath/COLLAB-DESIGN.md for the design space): the peer who
// opens the room is the HOST and the single authority over game state. Guests
// send actions; the host applies them and broadcasts a personalized view to
// each guest (public table + that guest's private hand + hand counts for
// everyone else). Transport is Trystero WebRTC with signaling over public
// Nostr relays — no server, rooms are invite links. The host persists the game
// to localStorage so reloading the invite link in the host's browser resumes
// the room; if two hosts ever collide (e.g. a stale resume), the one with the
// older state demotes itself to guest.
import { joinRoom, selfId, getRelaySockets } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm';

const $ = (id) => document.getElementById(id);
const tableEl = $('table'), wrapEl = $('table-wrap'), handEl = $('hand'), barEl = $('action-bar');
const hintEl = $('table-hint'), toastEl = $('toast'), netEl = $('net-status');
const sideEl = $('side'), logEl = $('log');

// The table is a circle: a square logical space with a round felt. A circle is
// rotation-invariant, which is what makes per-player arbitrary view rotation
// (and seats anywhere on the rim) work without letterboxing.
// Its diameter is part of the shared game state — the host can grow the table
// for bigger groups — so these are variables kept in sync via setTableSize().
let TABLE_W = 1300, TABLE_H = 1300;
let PLAY_R = 540; // max distance of a card's center from the table center
let SEAT_R = 600; // radius where the seat name labels sit
const CARD_W = 100, CARD_H = 140;
const TABLE_SIZES = { 1300: 'small', 1800: 'medium', 2400: 'large' };
const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ecd444', '#ee6352', '#9ac2c9', '#8acb88', '#1be7ff'];

function setTableSize(size) {
  TABLE_W = TABLE_H = size;
  PLAY_R = size / 2 - 110;
  SEAT_R = size / 2 - 50;
  tableEl.style.width = `${size}px`;
  tableEl.style.height = `${size}px`;
  layout();
}

/** Radially clamps an item's top-left position so the card stays on the felt. */
function clampToFelt(x, y) {
  const cx = x + CARD_W / 2 - TABLE_W / 2, cy = y + CARD_H / 2 - TABLE_H / 2;
  const d = Math.hypot(cx, cy);
  if (d <= PLAY_R) return { x, y };
  const f = PLAY_R / d;
  return { x: TABLE_W / 2 + cx * f - CARD_W / 2, y: TABLE_H / 2 + cy * f - CARD_H / 2 };
}

// --- loud error reporting -------------------------------------------------
let toastT = 0;
/** Shows a 5s notice: red (a problem) unless `ok` marks it as good news. */
function toast(msg, ok) {
  toastEl.classList.toggle('ok', !!ok);
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.add('hidden'), 5000);
}
window.addEventListener('error', (e) => { console.error(e.error || e.message); toast(`Error: ${e.message}`); });
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(`Error: ${e.reason?.message || e.reason}`);
});

// --- small helpers --------------------------------------------------------
const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const uid = () => rand(4);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** obj[key] only when it's the object's OWN property — never Object.prototype
 *  via a crafted id like "__proto__" or "constructor". */
const own = (obj, key) => (key != null && Object.hasOwn(obj, key) ? obj[key] : null);
/** A finite number from untrusted input, else the fallback. */
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const normRot = (v) => ((num(v) % 360) + 360) % 360;

// --- trust: who speaks for the host, who owns a seat, what data is safe -----
// A peer can send anything over the room's channels, so the host is
// AUTHENTICATED and everything rendered from shared data is SANITIZED:
//  • Host authenticity: a new room's id IS the fingerprint of the host's ECDSA
//    public key (first 12 bytes of SHA-256 → 24 hex), and the host signs every
//    message it sends. Guests check signature + fingerprint against the id in
//    their invite link, so no other peer can impersonate the host, rewrite the
//    log, swap card faces, or demote the real host. (Rooms created before this
//    scheme have 16-hex ids and run unsigned, as they always did.)
//  • Seat ownership: each player holds a secret key that is only ever sent to
//    the authenticated host; the host binds it to the seat on first contact,
//    so a guest can't claim someone else's (publicly visible) player id.
//  • Data hygiene: decks pass one sanitizer (strict image data-URLs, strict
//    color grammar, size caps) before anything renders them.
const ALG = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
const enc = (s) => new TextEncoder().encode(s);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fingerprint = async (raw) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))]
  .slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
let signedRoom = false;            // this room's messages must be signed (24-hex id)
let signKey = null, signPub = '';  // host: private key + base64 raw public key
let hostKey = null;                // guest: { k, key } once the host's key checked out

/** Creates the signing key for a brand-new room; returns the room id (its fingerprint). */
async function newHostKey() {
  const kp = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const id = await fingerprint(await crypto.subtle.exportKey('raw', kp.publicKey));
  localStorage.setItem(`ct-hostkey-${id}`, JSON.stringify({
    pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
  }));
  return id;
}
/** Loads this room's host key (host only); false if this browser doesn't hold it. */
async function useHostKey(id) {
  const saved = JSON.parse(localStorage.getItem(`ct-hostkey-${id}`) || 'null');
  if (!saved) return false;
  signKey = await crypto.subtle.importKey('jwk', saved.priv, ALG, false, ['sign']);
  signPub = b64(await crypto.subtle.exportKey('raw', await crypto.subtle.importKey('jwk', saved.pub, ALG, true, ['verify'])));
  return true;
}
/** Host → wire: signs the JSON body (unsigned legacy rooms send it as-is). */
async function seal(body) {
  if (!signKey) return body;
  const b = JSON.stringify(body);
  return { b, s: b64(await crypto.subtle.sign(SIG, signKey, enc(b))), k: signPub };
}
/** Wire → guest: the body if the room's host signed it, else null (dropped loudly). */
async function unseal(m) {
  if (!signedRoom) return m;
  try {
    if (typeof m?.b !== 'string' || typeof m.s !== 'string' || typeof m.k !== 'string') throw new Error('unsigned');
    if (m.k !== hostKey?.k) {
      const raw = unb64(m.k);
      if (await fingerprint(raw) !== roomId) throw new Error('key does not match the room');
      hostKey = { k: m.k, key: await crypto.subtle.importKey('raw', raw, ALG, false, ['verify']) };
    }
    if (!(await crypto.subtle.verify(SIG, hostKey.key, unb64(m.s), enc(m.b)))) throw new Error('bad signature');
    return JSON.parse(m.b);
  } catch (err) {
    console.warn('dropped a message not signed by the host:', err.message);
    return null;
  }
}

const IMG_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const COLOR_RE = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i;
const safeColor = (v, fallback = '#64748b') => (COLOR_RE.test(v) ? v : fallback);
const RANKS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'JOKER']);
const SUITS = new Set(['♠', '♥', '♦', '♣', '🃏']);
const MAX_DECK_BYTES = 24e6, MAX_DECK_CARDS = 5000;
const GUEST_DECK_CHARS = 1.5e6; // all decks guests add to one table, together (see apply 'addDeck')
// Control characters (C0, DEL, C1) never reach a page or the terminal bridge:
// a peer's ESC sequences could clear or spoof a bridge user's terminal.
// CTRL_NL spares the newline, for multi-line card texts.
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g, CTRL_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const str = (v, n, strip = CTRL) => (typeof v === 'string' && v ? v.replace(strip, '').slice(0, n) : undefined);

/** The one gate every deck passes (uploads, scripts, saves, the wire): keeps
 *  only known fields of the right type, so nothing a peer sends can smuggle
 *  markup, script URLs or CSS into anyone's page. Throws on unusable decks. */
function cleanDeck(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.cards) || !d.cards.length) throw new Error('a deck needs at least one card');
  if (d.cards.length > MAX_DECK_CARDS) throw new Error(`decks are limited to ${MAX_DECK_CARDS} cards`);
  const imgs = (Array.isArray(d.imgs) ? d.imgs : []).slice(0, MAX_DECK_CARDS).map((s) => (IMG_RE.test(s) ? s : null));
  let bytes = imgs.reduce((n, s) => n + (s?.length || 0), 0);
  const cards = d.cards.map((c) => {
    const o = {};
    if (!c || typeof c !== 'object') return o;
    if (RANKS.has(c.r) && SUITS.has(c.s)) Object.assign(o, { r: c.r, s: c.s, c: c.c === 'r' ? 'r' : 'b' });
    if (IMG_RE.test(c.img)) { o.img = c.img; bytes += c.img.length; }
    if (Number.isInteger(c.g) && imgs[c.g]) o.g = c.g;
    for (const [k, n, strip] of [['n', 60], ['txt', 300, CTRL_NL]]) if (str(c[k], n, strip)) o[k] = str(c[k], n, strip);
    for (const k of ['col', 'b']) if (COLOR_RE.test(c[k])) o[k] = c[k];
    if (c.meta !== undefined) {
      const j = JSON.stringify(c.meta);
      if (j && j.length <= 2000) o.meta = JSON.parse(j);
    }
    return o;
  });
  if (bytes > MAX_DECK_BYTES) throw new Error('deck images are too large (24 MB max)');
  const back = IMG_RE.test(d.back) || COLOR_RE.test(d.back) ? d.back : null;
  return { name: str(d.name, 24) || 'Deck', back, imgs, cards };
}

// Optional hash extras after "#room~id~pw": "~cli~PORT-TOKEN" connects this
// tab to a local terminal bridge (see cli.js / cli.py), "~as~Name" joins as a
// separate scripted player (a bot's body) instead of the local identity.
const HASHX = (() => {
  const seg = location.hash.split('~').slice(3);
  const o = {};
  for (let k = 0; k + 1 < seg.length; k += 2) {
    try { o[seg[k]] = decodeURIComponent(seg[k + 1]); } catch (err) {
      console.error('bad hash extra', seg[k], err);
      toast(`Ignored a malformed "~${seg[k]}~" in the URL`);
    }
  }
  return o;
})();
const CLI = HASHX.cli ? { port: HASHX.cli.split('-')[0], token: HASHX.cli.split('-')[1] || '' } : null;
const AS = HASHX.as ? [...HASHX.as].slice(0, 24).join('') : null; // code points: never split an emoji

// Stable player identity across reloads (a Trystero peerId changes per page
// load). "~as~Name" bots get their own identity slot so a bot tab never
// collides with the human playing in the same browser.
const pidKey = AS ? `ct-pid-as-${AS}` : 'ct-pid';
const pid = localStorage.getItem(pidKey) || rand(8);
localStorage.setItem(pidKey, pid);
// The seat's secret: proves to the host that this browser owns `pid` (which
// everyone can see). Sent to the authenticated host only — see act().
const seatKey = localStorage.getItem(`${pidKey}-key`) || rand(16);
localStorage.setItem(`${pidKey}-key`, seatKey);
const PID_RE = /^[0-9a-f]{16}$/;
let myName = AS || localStorage.getItem('ct-name') || `Player-${pid.slice(0, 4)}`;

// --- game state -----------------------------------------------------------
// decks:  {deckId: {name, back: dataURL|null, cards: [{img} | {r,s,c}]}}
// items:  {itemId: card {k:'c',x,y,rot,z,d,i,up} | pile {k:'p',x,y,rot,z,name,cards:[{d,i,up}]}}
// host:   authoritative state (host only): {seq, items, players:{pid:{name,color,online,hand:[{d,i}]}}}
// view:   what render() consumes — on guests this arrives from the host; its
//         items are the PUBLIC shape (publicItems: piles {…, n, top}, no hidden ids).
let role = null, roomId, password, room = null;
let sendAct, sendState, sendDecks, sendLog, sendNote, sendRules;
let decks = {};
let host = null;
let view = { seq: 0, items: {}, players: {} };
let myHand = [];
let gameLog = []; // the shared activity/chat feed (authoritative copy lives in host.log)
let peerPid = {};    // host only: Trystero peerId -> stable player id
let hostPeer = null; // guest only: peerId currently acting as host

function standardDeck(jokers) {
  const cards = [];
  for (const [s, c] of [['♠', 'b'], ['♥', 'r'], ['♦', 'r'], ['♣', 'b']]) {
    for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) cards.push({ r, s, c });
  }
  if (jokers) cards.push({ r: 'JOKER', s: '🃏', c: 'r' }, { r: 'JOKER', s: '🃏', c: 'b' });
  return { name: 'Standard', back: null, cards };
}

const zTop = () => 1 + Object.values(host.items).reduce((m, it) => Math.max(m, it.z), 0);

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

function ensurePlayer(p, name) {
  const pl = host.players[p] || (host.players[p] = { name: '', color: freeColor(), online: true, hand: [] });
  pl.seat ??= assignSeat();
  pl.online = true;
  // Only fill an empty name here — explicit renames go through the 'name'
  // action so they land in the log.
  if (name && !pl.name) pl.name = cleanName(name);
}
/** A color no ONLINE player wears (offline seats don't hold one hostage); cycles once all are taken. */
function freeColor() {
  const used = new Set(Object.values(host.players).filter((x) => x.online).map((x) => x.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[Object.keys(host.players).length % COLORS.length];
}
/** Player names: plain text, bounded, and never dressed up as the 📜 Rules actor. */
const cleanName = (s) => String(s).replace(CTRL, '').replace(/^[\s📜]+/u, '').trim().slice(0, 24);

// --- activity log (host-authored, broadcast to everyone) -------------------
/** Human name for a card that is public knowledge; never call for hidden cards. */
function cardName(d, i) {
  const deck = decks[d], c = deck?.cards[i];
  if (!c) return 'a card';
  if (c.n) return c.n; // custom decks carry per-card names (manifest or filename)
  if (c.r === 'JOKER') return 'Joker 🃏';
  if (c.r) return c.r + c.s;
  if (c.txt) return `“${c.txt.length > 40 ? `${c.txt.slice(0, 39)}…` : c.txt}”`; // text-only cards (CAH, t.newDeck)
  return `${deck.name} #${i + 1}`;
}
function itemLabel(it) {
  if (it.k === 'c') return it.up ? cardName(it.d, it.i) : 'a face-down card';
  return `the ${it.name || 'stacked'} pile`;
}
/** Tags an applied action with actor + item for the transient name bulbs every
 *  other player sees. Call BEFORE deleting an item so the position survives. */
function mark(p, id) {
  const it = host.items[id];
  const f = { p, id, x: it?.x ?? 0, y: it?.y ?? 0 };
  fxQueue.push(f);
  if (p !== pid) showFx(f); // the host is a viewer too; own actions stay silent
}

/** Appends to the shared log. Consecutive duplicates (drag/rotate spam) collapse.
 *  Entries render the actor's CURRENT name, unless `as` freezes one (renames).
 *  Three buckets are capped separately: talk (chat + renames, the entries
 *  carrying `c` or `n`) at 100, on-the-record entries (`loud`, stored as `k`:
 *  peeks) at 50, and every other action at 200 — so neither chatter nor a
 *  flood of cheap moves can push the record of a peek out of the log. */
function logEvent(p, txt, chat, as, loud) {
  const last = host.log.at(-1);
  if (!chat && last && last.p === p && last.txt === txt) return;
  host.log.push({ p, txt, ts: Date.now(), ...(chat ? { c: 1 } : {}), ...(as ? { n: as } : {}), ...(loud ? { k: 1 } : {}) });
  const kind = (e) => (e.c || 'n' in e ? 'talk' : e.k ? 'loud' : 'act'), mine = kind(host.log.at(-1));
  const same = host.log.filter((e) => kind(e) === mine);
  if (same.length > { talk: 100, loud: 50, act: 200 }[mine]) host.log.splice(host.log.indexOf(same[0]), 1);
  logDirty = true;
}
function dropIfEmpty(pileId) {
  if (host.items[pileId]?.cards.length === 0) delete host.items[pileId];
}
// Resolve a hand index robustly: guests send both the index and the card they
// see there; if the hand changed in flight, fall back to the first match.
function handIdx(pl, a) {
  if (Number.isInteger(a.idx) && pl.hand[a.idx]?.d === a.d && pl.hand[a.idx]?.i === a.i) return a.idx;
  return pl.hand.findIndex((c) => c.d === a.d && c.i === a.i);
}

/** State changed: renumber, re-render, sync, save. (host only) */
function bump() {
  host.seq++;
  refreshView();
  renderAll();
  scheduleBroadcast();
  persist();
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
    logEvent(actor, `dealt a card from ${itemLabel(pile)} to ${pl.name || 'a player'}`);
  } else {
    const at = clampToFelt(num(o.x, pile.x + CARD_W + 18), num(o.y, pile.y));
    nid = uid();
    host.items[nid] = { k: 'c', x: at.x, y: at.y, rot: normRot(o.rot), z: zTop(), d: c.d, i: c.i, up: !!o.up };
    logEvent(actor, `dealt ${o.up ? cardName(c.d, c.i) : 'a card face down'} from ${itemLabel(pile)}`);
    mark(actor, nid);
  }
  mark(actor, pileId);
  dropIfEmpty(pileId);
  // the dealt card's identity, so scripts can track what they dealt
  return o.to ? { d: c.d, i: c.i } : { id: nid, d: c.d, i: c.i };
}

function opShuffle(actor, pileId) {
  const pile = own(host.items, pileId);
  if (pile?.k !== 'p') return false;
  for (let i = pile.cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pile.cards[i], pile.cards[j]] = [pile.cards[j], pile.cards[i]];
  }
  logEvent(actor, `shuffled ${itemLabel(pile)} (${pile.cards.length} cards)`);
  mark(actor, pileId);
  return true;
}

function opFlip(actor, id) {
  const it = own(host.items, id);
  if (!it) return false;
  if (it.k === 'c') {
    it.up = !it.up;
    logEvent(actor, `flipped ${cardName(it.d, it.i)} face ${it.up ? 'up' : 'down'}`);
  } else {
    it.cards.reverse();
    for (const c of it.cards) c.up = !c.up;
    logEvent(actor, `flipped ${itemLabel(it)}`);
  }
  mark(actor, id);
  return true;
}

function opToPile(actor, cardId, pileId) {
  const it = own(host.items, cardId), pile = own(host.items, pileId);
  if (it?.k !== 'c' || pile?.k !== 'p') return false;
  logEvent(actor, `put ${itemLabel(it)} onto ${itemLabel(pile)}`);
  mark(actor, pileId);
  pile.cards.push({ d: it.d, i: it.i, up: it.up });
  delete host.items[cardId];
  return true;
}

function opNewPile(actor, cards, o = {}) {
  const at = clampToFelt(o.x ?? TABLE_W / 2 - CARD_W / 2, o.y ?? TABLE_H / 2 - CARD_H / 2);
  const nid = uid();
  host.items[nid] = { k: 'p', x: at.x, y: at.y, rot: 0, z: zTop(), name: String(o.name || '').slice(0, 24), cards: cards.map((c) => ({ d: c.d, i: c.i, up: !!c.up })) };
  logEvent(actor, `made a pile of ${cards.length} cards`);
  mark(actor, nid);
  return nid;
}

/** Stacks card `id` onto card `ontoId`: both become a new pile where `ontoId` lay. Returns its id. */
function opStack(actor, id, ontoId) {
  const it = own(host.items, id), b = own(host.items, ontoId);
  if (it?.k !== 'c' || b?.k !== 'c' || it === b) return false;
  logEvent(actor, `stacked ${itemLabel(it)} onto ${itemLabel(b)}`);
  const nid = uid();
  host.items[nid] = { k: 'p', x: b.x, y: b.y, rot: b.rot, z: zTop(), name: '', cards: [{ d: b.d, i: b.i, up: b.up }, { d: it.d, i: it.i, up: it.up }] };
  delete host.items[id];
  delete host.items[ontoId];
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
    logEvent(actor, `returned ${whose} (${out.length}) to ${itemLabel(pile)}`);
    mark(actor, pileId);
    pl.hand = pl.hand.filter((c) => !out.includes(c));
    for (const c of out) pile.cards.push({ d: c.d, i: c.i, up: false });
  }
  return true;
}

/** Applies one action from player `p` to the authoritative state (host only). */
function apply(p, a) {
  const items = host.items, pl = own(host.players, p);
  const it = own(items, a.id);
  // Rules veto: an enabled script may block gameplay actions with a reason.
  if (RULED_ACTIONS.has(a.t) && host.rules?.enabled) {
    const reason = runHook('validate', { ...a, p });
    // Fail closed: a validate() that throws has just disabled the rules, and
    // the action that crashed it must not slip through unvalidated.
    const why = host.rules.enabled ? typeof reason === 'string' && reason : 'rules script error';
    if (why) {
      logEvent(RULES, `blocked ${pl?.name || 'a player'}: ${why}`);
      notify(p, `🚫 ${why}`);
      bump(); // the fresh broadcast reverts the actor's optimistic UI
      return;
    }
  }
  if ((a.t === 'chat' || a.t === 'name') && !mayTalk(p)) {
    console.warn(`flood control: dropped a ${a.t} from`, p);
    notify(p, '🚫 Slow down — at most 5 messages or renames per 5 seconds');
    return;
  }
  // Every op that takes effect mark()s it, so fxQueue growing during the
  // switch is the "it really happened" signal for onAction below: a no-op
  // (a card not in hand, a vanished item) never reaches the script, and for
  // the ones that did happen the payload's ids were matched host-side.
  const fx0 = fxQueue.length;
  switch (a.t) {
    case 'hello': break; // registration + join logging happen in the action handler
    case 'name': {
      const name = cleanName(a.name || '');
      if (pl && name && name !== pl.name) {
        const old = pl.name;
        pl.name = name;
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
      if (p !== pid) {
        const size = JSON.stringify(deck).length, used = host.guestDeckChars || 0;
        if (used + size > GUEST_DECK_CHARS) {
          console.warn('guest deck over budget', p, size, used);
          notify(p, `🚫 Deck rejected: this table's deck budget for guests is full (${Math.round((GUEST_DECK_CHARS - used) / 1e3)} kB left) — ask the host to add it`);
          break;
        }
        host.guestDeckChars = used + size;
      }
      const deckId = uid(); // host-minted: a peer must not choose (or overwrite) deck ids
      decks[deckId] = deck;
      dirtyDecks.add(deckId);
      const nid = uid(), at = clampToFelt(num(a.x, TABLE_W / 2 - CARD_W / 2), num(a.y, TABLE_H / 2 - CARD_H / 2));
      items[nid] = {
        k: 'p', x: at.x, y: at.y, rot: 0, z: zTop(), name: deck.name,
        cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })),
      };
      logEvent(p, `added deck "${deck.name}" (${deck.cards.length} cards)`);
      mark(p, nid);
      break;
    }
    case 'move':
      if (it) {
        ({ x: it.x, y: it.y } = clampToFelt(num(a.x, it.x), num(a.y, it.y)));
        it.z = zTop();
        logEvent(p, `moved ${itemLabel(it)}`);
        mark(p, a.id);
      }
      break;
    case 'rot': if (it) { it.rot = normRot(a.rot); logEvent(p, `rotated ${itemLabel(it)}`); mark(p, a.id); } break;
    case 'flip': if (it) opFlip(p, a.id); break;
    case 'shuffle': if (it?.k === 'p') opShuffle(p, a.id); break;
    case 'draw': {
      const c = it?.k === 'p' && it.cards.pop();
      if (c && pl) {
        pl.hand.push({ d: c.d, i: c.i });
        logEvent(p, `drew a card from ${itemLabel(it)}`);
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
        const nid = uid(), at = clampToFelt(num(a.x, TABLE_W / 2), num(a.y, TABLE_H / 2)), up = !!a.up;
        items[nid] = { k: 'c', x: at.x, y: at.y, rot: normRot(a.rot), z: zTop(), d: c.d, i: c.i, up };
        logEvent(p, `played ${up ? cardName(c.d, c.i) : 'a card face down'} from hand`);
        mark(p, nid);
      }
      break;
    }
    case 'handPile': {
      const idx = pl && handIdx(pl, a);
      const pile = own(items, a.pile);
      if (pl && idx >= 0 && pile?.k === 'p') {
        const c = pl.hand.splice(idx, 1)[0];
        // A card discarded onto a pile matches the pile's exposed face
        // (face up onto a face-up pile, face down onto a deck).
        const up = pile.cards.at(-1)?.up ?? false;
        pile.cards.push({ d: c.d, i: c.i, up });
        logEvent(p, `put ${up ? cardName(c.d, c.i) : 'a card face down'} from hand onto ${itemLabel(pile)}`);
        mark(p, a.pile);
      }
      break;
    }
    case 'toHand':
      if (it?.k === 'c' && pl) {
        logEvent(p, `took ${itemLabel(it)} from the table into hand`);
        mark(p, a.id);
        pl.hand.push({ d: it.d, i: it.i });
        delete items[a.id];
      }
      break;
    case 'toPile': opToPile(p, a.id, a.pile); break;
    case 'stack': opStack(p, a.id, a.onto); break;
    case 'merge': {
      const to = own(items, a.pile);
      if (it?.k === 'p' && to?.k === 'p' && it !== to) {
        logEvent(p, `merged ${itemLabel(it)} (${it.cards.length} cards) into ${itemLabel(to)}`);
        mark(p, a.pile);
        to.cards.push(...it.cards);
        delete items[a.id];
      }
      break;
    }
    case 'del':
      if (it) {
        logEvent(p, `removed ${itemLabel(it)}${it.k === 'p' ? ` (${it.cards.length} cards)` : ''}`);
        mark(p, a.id);
        delete items[a.id];
      }
      break;
    // Peek is deliberately "loud": the reveal happens on the peeker's screen
    // only, but the fact of peeking goes on the record for everyone. Guests
    // never hold hidden identities (see publicItems), so the host answers
    // with a note addressed to the peeker alone.
    case 'peek': {
      const c = it?.k === 'c' ? !it.up && it : it?.k === 'p' && it.cards.at(-1);
      if (!c) break;
      logEvent(p, it.k === 'c' ? 'peeked at a face-down card' : `peeked at the top card of ${itemLabel(it)}`, false, undefined, true);
      mark(p, a.id);
      if (p === pid) showPeek(c);
      else for (const [peer, mapped] of Object.entries(peerPid)) {
        if (mapped === p) sendNote({ peek: { d: c.d, i: c.i }, to: p }, peer).catch((e) => console.error('peek reply failed', e));
      }
      break;
    }
    case 'size': {
      // Host-only: the size selector is only shown to the host, and the host
      // applies its own actions, so p must be the host's own player id.
      const size = own(TABLE_SIZES, a.size) && +a.size;
      if (p === pid && size && size !== TABLE_W) {
        const shift = (size - TABLE_W) / 2; // items stay centered on the felt
        host.size = size;
        setTableSize(size);
        for (const o of Object.values(items)) {
          ({ x: o.x, y: o.y } = clampToFelt(o.x + shift, o.y + shift));
        }
        logEvent(p, `set the table size to ${TABLE_SIZES[size]}`);
      }
      break;
    }
    case 'chat': {
      const msg = String(a.msg ?? '').replace(CTRL, ' ').trim().slice(0, 300);
      if (pl && msg) logEvent(p, msg, true);
      break;
    }
    case 'setRules': {
      if (p !== pid) break; // only the host configures rules
      if (a.enabled) {
        try {
          const s = evalRules(a.code);
          if (!s || typeof s !== 'object') throw new Error('script must evaluate to an ({...}) object');
          // Re-enabling the same game (after a fix, a Disable or a script
          // error) keeps its state — chips, scores, timers — unless the host
          // ticked "Reset game state"; setup() runs again either way.
          const name = String(s.name || 'Rules').slice(0, 40);
          const prev = host.rules?.name === name ? host.rules : null, keep = prev && !a.reset;
          // Another game's state (chips, scores, a hand in progress) is lost: say so.
          const lost = keep ? ' (game state kept)' : prev ? ' (game state reset)' : host.rules ? ` («${host.rules.name}» game state discarded)` : '';
          script = s;
          host.rules = { code: a.code, name, enabled: true, data: keep ? prev.data : {}, public: keep ? prev.public : {} };
          rulesCodeDirty = true;
          lastRulesError = '';
          logEvent(RULES, `«${name}» enabled by ${pl?.name || 'the host'}${lost}`);
          runHook('setup');
          refreshButtons();
        } catch (err) {
          // Nothing was assigned yet: whatever rules were running keep running.
          console.error('rules script failed to load', err);
          lastRulesError = err.message;
          toast(`Rules error: ${err.message}${host.rules?.enabled ? ' — the running rules are unchanged' : ''}`);
        }
      } else if (host.rules?.enabled) {
        host.rules.enabled = false;
        rulesCodeDirty = true;
        logEvent(RULES, `rules disabled by ${pl?.name || 'the host'}`);
      }
      break;
    }
    case 'rulesBtn': {
      // The engine enforces what the script offered: a button the player
      // can't see (another player's, or one that just went away) is refused.
      const b = (host.rules?.enabled && host.rules.public.buttons || []).find((x) => x.id === String(a.id));
      if (!b || (b.pid && b.pid !== p)) { // nothing happened: no hooks, no new state
        console.warn('refused rules button', a.id, 'from', p);
        notify(p, '🚫 That button is not available to you right now');
        return;
      }
      runHook('onButton', b.id, p);
      break;
    }
    default: console.warn('unknown action', a);
  }
  if (host.rules?.enabled && (a.t === 'chat' || a.t === 'rulesBtn' || (RULED_ACTIONS.has(a.t) && fxQueue.length > fx0))) {
    if (a.t === 'chat') runHook('onChat', String(a.msg || ''), p);
    runHook('onAction', { ...a, p });
    refreshButtons();
  }
  bump();
}

/** Routes a local UI action: hosts apply directly, guests send to the host.
 *  Until a (signed) state has revealed which peer is the host, the only thing
 *  a guest sends is an anonymous broadcast "hello" knock — identity and the
 *  seat key go ONLY to the authenticated host, never to the whole room.
 *  Every later action carries the stable player id + name + seat key, so the
 *  host can (re)register the player even if the keyed hello got lost.
 *  Actions taken while (re)connecting — e.g. a click during the host's
 *  reload — wait in a short queue and go out as soon as the host is back. */
const pendingActs = [];
function act(a) {
  if (role === 'host') { apply(pid, a); return; }
  if (!room) { console.warn('action before the room is up', a); return; }
  const target = hostPeer && room.getPeers()[hostPeer] ? hostPeer : null;
  if (!target) {
    if (a.t !== 'hello') {
      pendingActs.push({ a, at: Date.now() });
      if (pendingActs.length > 30) pendingActs.shift();
      note('Reconnecting to the host — your move will be sent when it\'s back');
    }
    sendAct({ t: 'hello' }).catch((err) => console.error('hello failed', err));
    return;
  }
  sendAct({ ...a, _pid: pid, _name: myName, _key: seatKey }, target)
    .catch((err) => { console.error('send failed', err); note('Failed to reach the host'); });
}
/** Sends what was queued while disconnected (moves older than 30 s are stale). */
function flushPending() {
  const fresh = pendingActs.splice(0).filter((x) => Date.now() - x.at < 30000);
  for (const { a } of fresh) act(a);
}

// --- rules engine (see ENGINE.md) ------------------------------------------
// Host-only execution of a host-written script that can veto actions
// (validate) and drive automations (setup/onAction/onButton/onJoin/onLeave/
// onTimer) through the same audited ops as human actions. The engine knows
// no game concepts — all game semantics live in the script.
const RULES = 'RULES'; // synthetic actor id for script-performed ops
const RULED_ACTIONS = new Set(['move', 'rot', 'flip', 'shuffle', 'draw', 'deal', 'play', 'handPile', 'toHand', 'toPile', 'stack', 'merge', 'del', 'addDeck', 'peek']);
let script = null;          // evaluated script object (host only)
let lastRulesError = '';    // shown in the rules dialog
let rulesCodeDirty = false; // code changed -> resend on next broadcast
let guestRules = { code: '', name: '' }; // guests: the script text, for reading

function evalRules(code) {
  // The code sits on its own lines so a trailing // comment can't swallow the ")".
  return new Function(`"use strict"; return (\n${code}\n);`)();
}

/** Runs one script hook; any throw disables the rules loudly. */
function runHook(name, ...args) {
  if (role !== 'host' || !host.rules?.enabled || typeof script?.[name] !== 'function') return undefined;
  try {
    return script[name](tApi, ...args);
  } catch (err) {
    hookFailed(name, err);
    return undefined;
  }
}
/** A script error: disable the rules, loudly and on the record. */
function hookFailed(name, err) {
  console.error(`rules hook ${name}() failed`, err);
  lastRulesError = `${name}(): ${err.message}`;
  host.rules.enabled = false;
  rulesCodeDirty = true;
  logEvent(RULES, `rules disabled — script error in ${name}()`);
  toast(`Rules disabled — error in ${name}(): ${err.message}`);
}

/** Sends a private text notice to a player (toast on their screen). Each
 *  costs a signature: a guest gets at most a burst of 10, then 5 per second. */
function notify(p, msg) {
  if (p === pid) { note(msg); return; }
  if (!flood(notesOf, p, 10, 5)) { console.warn('notice dropped (flood control)', p, msg); return; }
  for (const [peer, mapped] of Object.entries(peerPid)) {
    if (mapped === p) sendNote({ msg: String(msg).slice(0, 200), to: p }, peer).catch((e) => console.error('note failed', e));
  }
}

/** Token bucket (host flood control): true while `key` may act — a burst of
 *  `burst`, refilling at `perSec`. `map` keeps each key's {n, at}. */
function flood(map, key, burst, perSec) {
  const now = Date.now(), b = map.get(key) || { n: burst, at: now };
  b.n = Math.min(burst, b.n + ((now - b.at) / 1000) * perSec);
  b.at = now;
  map.set(key, b);
  if (b.n < 1) return false;
  b.n--;
  return true;
}
const actsOf = new Map(), notesOf = new Map(); // host: player id → token bucket (see flood)
const talk = new Map(); // host: player id → timestamps of recent chats/renames
/** Flood control (host): a guest may chat or rename at most 5 times per 5 s.
 *  The host itself is exempt — it is the authority over the log anyway. */
function mayTalk(p) {
  if (p === pid) return true;
  const now = Date.now(), recent = (talk.get(p) || []).filter((ts) => ts > now - 5000);
  talk.set(p, recent);
  if (recent.length >= 5) return false;
  recent.push(now);
  return true;
}

/** Refreshes the script-declared button row into the broadcast public data. */
function refreshButtons() {
  if (role !== 'host' || !host.rules?.enabled || typeof script?.buttons !== 'function') return;
  try {
    const btns = script.buttons(tApi) || [];
    host.rules.public.buttons = btns.map((b) => ({ id: String(b.id), label: String(b.label).slice(0, 30), ...(b.pid ? { pid: b.pid } : {}) }));
  } catch (err) {
    hookFailed('buttons', err);
  }
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
  items: () => Object.entries(host.items).map(([id, it]) => structuredClone({ id, ...it })),
  piles() { return this.items().filter((it) => it.k === 'p'); },
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
    const at = clampToFelt(o.x ?? TABLE_W / 2 - CARD_W / 2, o.y ?? TABLE_H / 2 - CARD_H / 2);
    const nid = uid();
    host.items[nid] = { k: 'c', x: at.x, y: at.y, rot: normRot(o.rot), z: zTop(), d: c.d, i: c.i, up: o.up !== false };
    logEvent(RULES, `played ${o.up !== false ? cardName(c.d, c.i) : 'a card face down'} from ${pl.name || 'a player'}'s hand`);
    mark(RULES, nid);
    return nid;
  },
  toHand(p, cardId) {
    const it = own(host.items, cardId), pl = own(host.players, p);
    if (it?.k !== 'c' || !pl) return false;
    logEvent(RULES, `gave ${itemLabel(it)} to ${pl.name || 'a player'}`);
    mark(RULES, cardId);
    pl.hand.push({ d: it.d, i: it.i });
    delete host.items[cardId];
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
    logEvent(RULES, `merged ${itemLabel(from)} (${from.cards.length} cards) into ${itemLabel(to)}`);
    mark(RULES, toId);
    to.cards.push(...from.cards);
    delete host.items[fromId];
    return true;
  },
  move(id, x, y) {
    const it = own(host.items, id);
    if (!it) return false;
    ({ x: it.x, y: it.y } = clampToFelt(x, y));
    it.z = zTop();
    logEvent(RULES, `moved ${itemLabel(it)}`);
    mark(RULES, id);
    return true;
  },
  rot(id, deg) {
    const it = own(host.items, id);
    if (!it) return false;
    it.rot = normRot(deg);
    logEvent(RULES, `rotated ${itemLabel(it)}`);
    mark(RULES, id);
    return true;
  },
  remove(id) {
    const it = own(host.items, id);
    if (!it) return false;
    logEvent(RULES, `removed ${itemLabel(it)}${it.k === 'p' ? ` (${it.cards.length} cards)` : ''}`);
    mark(RULES, id);
    delete host.items[id];
    return true;
  },
  /** Registers a script-defined deck of image-less cards ({name, text, color,
   *  bg, meta} each) and returns its deckId — it creates NO pile, so scripts
   *  can keep big decks off the table (small piles via t.newPile([{d,i,up}])
   *  keep the broadcast state light). `back` may be a solid color ("#111"). */
  newDeck(def) {
    const deckId = uid();
    decks[deckId] = cleanDeck({
      name: def.name, back: def.back,
      cards: (def.cards || []).map((c) => ({ n: c.name, txt: c.text, col: c.color, b: c.bg, meta: c.meta })),
    });
    dirtyDecks.add(deckId);
    logEvent(RULES, `defined deck "${decks[deckId].name}" (${decks[deckId].cards.length} cards)`);
    return deckId;
  },
  addStandardDeck(o = {}) {
    const deck = standardDeck(!!o.jokers);
    const deckId = uid();
    decks[deckId] = deck;
    dirtyDecks.add(deckId);
    const nid = opNewPile(RULES, deck.cards.map((_, i) => ({ d: deckId, i, up: false })), { x: o.x, y: o.y, name: deck.name });
    own(host.items, nid).name = deck.name;
    return nid;
  },
  geom: () => ({ size: TABLE_W, cx: TABLE_W / 2, cy: TABLE_H / 2, r: PLAY_R }),
  hostId: pid, // the host's own player id: for host-only buttons ({pid: t.hostId}) and commands
  say: (msg) => logEvent(RULES, String(msg).slice(0, 300)),
  /** Big banner on every screen (also logged). For "Flop!", "You win", ... */
  announce(msg) {
    const text = String(msg).slice(0, 200);
    logEvent(RULES, `📣 ${text}`);
    annQueue.push(text);
    showAnnounce(text); // the host is a viewer too
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
    (host.rules.data._timers ||= []).push({ at: Date.now() + sec * 1000, tag: String(tag) });
  },
  nextSeat(p) {
    const ps = this.players().filter((x) => x.online || x.id === p);
    const i = ps.findIndex((x) => x.id === p);
    return ps.length ? ps[(i + 1) % ps.length].id : p;
  },
  cardName: (ref) => cardName(ref.d, ref.i),
  /** Full card identity for game logic: {name, rank, suit, text, meta, deck}.
   *  `meta` is the free-form JSON from a custom deck's manifest. */
  card(ref) {
    const deck = decks[ref.d], c = deck?.cards[ref.i];
    if (!c) return null;
    return structuredClone({
      name: cardName(ref.d, ref.i), rank: c.r, suit: c.s, text: c.txt,
      meta: c.meta, deck: deck.name,
    });
  },
};

// Fire due script timers (t.schedule). They live in rules.data, so they
// survive a host reload along with everything else.
setInterval(() => {
  if (role !== 'host' || !host?.rules?.enabled) return;
  const timers = host.rules.data._timers;
  if (!timers?.length) return;
  const now = Date.now(); // one clock reading, so no timer falls between the two filters
  const due = timers.filter((x) => x.at <= now);
  if (!due.length) return;
  host.rules.data._timers = timers.filter((x) => x.at > now);
  for (const x of due) runHook('onTimer', x.tag);
  refreshButtons();
  bump();
}, 700);

// --- host <-> guest sync --------------------------------------------------
let dirtyDecks = new Set(), logDirty = false, bcastT = 0; // deck ids not yet broadcast
let hostBoot = 0;  // when this tab became host: the state's epoch (see handleState)
let fxQueue = [];  // action markers accumulated since the last broadcast
let annQueue = []; // script announcements (banners) since the last broadcast

function publicPlayers() {
  return Object.fromEntries(Object.entries(host.players).map(([p, pl]) => [
    p, { name: pl.name, color: pl.color, online: pl.online, handCount: pl.hand.length, seat: pl.seat },
  ]));
}

/** The table as players see it — hidden identities stay on the host. A pile
 *  becomes {…, n: count, top} (a face-down top keeps only its deck, for the
 *  back), and a face-down loose card loses its index `i`. Everyone renders
 *  this one shape, the host included; only host LOGIC reads host.items. */
function publicItems() {
  return Object.fromEntries(Object.entries(host.items).map(([id, it]) => {
    if (it.k === 'p') {
      const { cards, ...rest } = it, top = cards.at(-1);
      return [id, { ...rest, n: cards.length, top: top && (top.up ? { ...top } : { d: top.d, up: false }) }];
    }
    const { i, ...rest } = it;
    return [id, it.up ? { ...rest, i } : rest];
  }));
}

function refreshView() {
  if (role !== 'host') return;
  view = {
    seq: host.seq, items: publicItems(), players: publicPlayers(),
    rules: host.rules ? { name: host.rules.name, enabled: host.rules.enabled, public: host.rules.public } : null,
  };
  myHand = host.players[pid]?.hand || [];
  gameLog = host.log;
}

function scheduleBroadcast() {
  if (bcastT) return;
  bcastT = setTimeout(() => { bcastT = 0; broadcast(); }, 40);
}

function broadcast() {
  if (role !== 'host' || !room) return;
  if (dirtyDecks.size) {
    // Delta, not the whole map: adding a second deck must not re-ship the first.
    const delta = Object.fromEntries([...dirtyDecks].map((id) => [id, decks[id]]));
    dirtyDecks.clear();
    sendDecks(delta).catch((e) => console.error('decks send failed', e));
  }
  if (logDirty) { logDirty = false; sendLog(host.log).catch((e) => console.error('log send failed', e)); }
  if (rulesCodeDirty) {
    rulesCodeDirty = false;
    sendRules({ code: host.rules?.code || '', name: host.rules?.name || '' }).catch((e) => console.error('rules send failed', e));
  }
  const rules = host.rules ? { name: host.rules.name, enabled: host.rules.enabled, public: host.rules.public } : null;
  // boot: this host instance's epoch (seq restarts lower after a resume), host: whose seat the host is.
  const pub = { seq: host.seq, boot: hostBoot, host: pid, size: host.size, rules, items: publicItems(), players: publicPlayers(), fx: fxQueue, ann: annQueue };
  fxQueue = [];
  annQueue = [];
  // Each state is personalized AND addressed (`to`): the signature binds it to
  // its recipient, so a guest can't replay its own state (hand!) to another.
  // Peers that haven't introduced themselves yet get the public view only.
  for (const peer of Object.keys(room.getPeers())) {
    const to = peerPid[peer] || null;
    sendState({ ...pub, to, hand: to ? host.players[to].hand : [] }, peer)
      .catch((e) => console.error('state send failed', e));
  }
}

let registered = false; // guest: the host has bound our seat (we got a state addressed to us)
let lastIntro = 0;
/** Guest: presents identity + seat key to the (authenticated) host. Throttled. */
function introduce() {
  if (Date.now() - lastIntro < 2000) return;
  lastIntro = Date.now();
  act({ t: 'hello' });
}

function handleState(s, peer) {
  if (!s || typeof s !== 'object' || !Number.isFinite(s.seq)) return;
  if (role === 'host') {
    // Two live hosts (a stale resume, or the invite opened twice in the host's
    // browser). The fresher state wins; peerId breaks the tie deterministically.
    // In a signed room only a holder of this room's key can get this far.
    if (s.seq > host.seq || (s.seq === host.seq && peer < selfId)) {
      console.warn('another host is active — demoting to guest');
      toast('This table is open in another tab — this one is now a viewer');
      role = 'guest';
      host = null;
      $('size-sel').classList.add('hidden');
    } else {
      hostBoot = Date.now(); // a fresh epoch: guests that followed the rival (a newer boot) accept us again
      scheduleBroadcast();
      return;
    }
  }
  // Stale reordering: a host that restarted (reload, resume of an older save)
  // counts seq from its save, so a NEWER epoch (`boot`, the host's start time)
  // is always accepted — an older one never is (that would be a replay).
  if (s.boot < view.boot || (s.boot === view.boot && s.seq < view.seq)) return;
  if (s.to && s.to !== pid) return; // addressed to someone else: a replay
  hostPeer = peer;
  registered = s.to === pid;
  if (!registered) introduce(); // the host doesn't know this seat yet
  if (pendingActs.length) flushPending();
  if (own(TABLE_SIZES, s.size) && +s.size !== TABLE_W) setTableSize(+s.size);
  view = { seq: s.seq, boot: s.boot, host: s.host, items: s.items || {}, players: s.players || {}, rules: s.rules };
  if (registered) myHand = Array.isArray(s.hand) ? s.hand : [];
  for (const f of s.fx || []) if (f.p !== pid) showFx(f);
  for (const msg of s.ann || []) showAnnounce(msg);
  renderAll();
}

const refusedAt = {}; // host: peer → last refusal notice (no toast storms)
/** Host: turns away a peer's action, loudly on both ends. */
function refuse(peer, reason) {
  console.warn(`refused an action from ${peer}: ${reason}`);
  if (Date.now() - (refusedAt[peer] || 0) < 10000) return;
  refusedAt[peer] = Date.now();
  sendNote({ msg: `🚫 ${reason}`, to: null }, peer).catch((e) => console.error('note failed', e));
}

function connect() {
  // window.CARDTABLE_RELAYS overrides the default public Nostr relays (tests, self-hosting).
  // redundancy 10 (default 5): more relays per room = better odds that two
  // peers share a live one when parts of the public infrastructure are down.
  const relays = window.CARDTABLE_RELAYS;
  room = joinRoom({ appId: 'gk-cardtable', password, relayConfig: relays ? { urls: relays } : { redundancy: 10 } }, roomId);
  const actA = room.makeAction('act');
  const stateA = room.makeAction('state');
  const decksA = room.makeAction('decks');
  const logA = room.makeAction('log');
  const noteA = room.makeAction('note');
  const rulesA = room.makeAction('rules');
  // Host → guest channels are signed in send order (sealing is async, the
  // queue keeps it FIFO); guests verify them in arrival order the same way.
  let sealQ = Promise.resolve();
  const signed = (send) => (data, target) => {
    const sealed = sealQ.then(() => seal(data));
    sealQ = sealed.catch((err) => console.error('signing a host message failed', err)); // keeps the FIFO alive; the caller reports it too
    return sealed.then((m) => send(m, target));
  };
  // States and notes always go to one peer: its connection id (`tp`) is
  // signed into the body, so a copy relayed to anyone else is dropped.
  const bound = (send) => (data, target) => send({ ...data, tp: target }, target);
  sendAct = (data, target) => actA.send(data, target ? { target } : {});
  sendState = bound(signed((m, target) => stateA.send(m, { target })));
  sendDecks = signed((m, target) => decksA.send(m, target ? { target } : {}));
  sendLog = signed((m, target) => logA.send(m, target ? { target } : {}));
  sendNote = bound(signed((m, target) => noteA.send(m, { target })));
  sendRules = signed((m, target) => rulesA.send(m, target ? { target } : {}));
  // A signature proves the host wrote a message, not who delivers it: any
  // peer could relay one (e.g. to pose as the host and harvest seat keys).
  // So states and notes must name THIS connection (`tp`, see bound()), and the
  // other channels must come from the peer whose state we accepted.
  let inbox = Promise.resolve();
  const fromHost = (fn, isBound) => (m, { peerId }) => {
    inbox = inbox.then(async () => {
      const d = await unseal(m);
      if (d == null) return;
      if (isBound ? d.tp !== selfId : peerId !== hostPeer) { console.warn('dropped a host message relayed by', peerId); return; }
      fn(d, peerId);
    }).catch((err) => console.error('message from the host failed', err));
  };
  noteA.onMessage = fromHost((n) => {
    if (role === 'host' || !n || (n.to && n.to !== pid)) return;
    if (n.msg) note(String(n.msg)); // toast + the terminal bridge
    if (n.peek && n.to === pid) showPeek({ d: String(n.peek.d), i: num(n.peek.i, -1) }); // the host's private answer to our peek
  }, true);
  rulesA.onMessage = fromHost((r) => { if (role !== 'host') guestRules = { code: String(r?.code || ''), name: String(r?.name || '') }; });
  stateA.onMessage = fromHost(handleState, true);
  // Deck messages are deltas (or the full map for new joiners) — always merge,
  // re-sanitized here too (defense in depth, and legacy unsigned rooms).
  decksA.onMessage = fromHost((d) => {
    if (role === 'host' || !d || typeof d !== 'object') return;
    for (const [id, deck] of Object.entries(d)) {
      if (!/^[0-9a-f]{8}$/.test(id)) { console.warn('ignored a deck with a bad id', id); continue; }
      try { decks[id] = cleanDeck(deck); } catch (err) { console.error(`deck ${id} rejected`, err); }
    }
    handSig = ''; // the hand may hold placeholders for these decks: redraw it even if the hand didn't change
    renderAll();
  });
  logA.onMessage = fromHost((l) => { if (role !== 'host' && Array.isArray(l)) { gameLog = l; renderAll(); } });

  actA.onMessage = (a, { peerId: peer }) => {
    if (role !== 'host' || !a || typeof a !== 'object') return; // only the host adjudicates
    // An anonymous knock: answer with a (signed) public state, so the guest
    // learns who the authenticated host is before revealing its identity.
    if (a._pid == null) { if (a.t === 'hello') scheduleBroadcast(); return; }
    const { _pid: p, _name: name, _key: key, ...action } = a;
    const reason = p === pid ? 'This seat is already open in another tab'
      : !PID_RE.test(p) ? 'Invalid player id'
      : typeof key !== 'string' || key.length < 16 ? 'Missing seat key — please reload'
      : peerPid[peer] && peerPid[peer] !== p ? 'One seat per connection'
      : own(host.players, p)?.key && host.players[p].key !== key ? 'That seat belongs to another player'
      : '';
    if (reason) { refuse(peer, reason); return; }
    // Every action re-renders the host (the one authority): a guest may
    // send bursts of 40 (a drag, a reconnect's queue), then 20 per second.
    if (!flood(actsOf, p, 40, 20)) { refuse(peer, 'Too many actions — slow down'); return; }
    // Register/refresh the sender on EVERY action, not just hello — if the
    // keyed hello was lost, the first real action still registers the player.
    const newConn = peerPid[peer] !== p;
    const known = own(host.players, p);
    const back = !known?.online; // read BEFORE ensurePlayer flips the same object online
    peerPid[peer] = p;
    ensurePlayer(p, name);
    host.players[p].key ||= key; // first contact binds the seat (older saves adopt their first claimant)
    if (back) logEvent(p, known ? 'is back at the table' : 'joined the table');
    if (newConn) {
      // Fresh connection: hand over the (possibly large) deck images, the
      // log, and the rules code targeted, so regular broadcasts stay light.
      sendDecks(decks, peer).catch((e) => console.error('decks send failed', e));
      sendLog(host.log, peer).catch((e) => console.error('log send failed', e));
      if (host.rules) sendRules({ code: host.rules.code, name: host.rules.name }, peer).catch((e) => console.error('rules send failed', e));
    }
    if (back && host.rules?.enabled) { runHook('onJoin', p); refreshButtons(); }
    // Every action carries the sender's current name: a rename the host
    // never received (made while it was away, or in another room) syncs on
    // the next connection, through the logged (and rate-limited) rename path.
    const nm = cleanName(name ?? '');
    if (known && nm && nm !== known.name && newConn && action.t !== 'name') apply(p, { t: 'name', name: nm });
    apply(p, action); // apply() schedules a broadcast, which catches joiners up
  };

  room.onPeerJoin = () => {
    updateNet();
    if (role === 'host') scheduleBroadcast(); // the newcomer gets a signed public state
    else act({ t: 'hello' });
  };
  room.onPeerLeave = (peer) => {
    updateNet();
    if (peer === hostPeer) { // the table is paused: say so (hint + host seat greyed), knock again when a host reappears
      hostPeer = null;
      registered = false;
      renderAll();
    }
    if (role !== 'host') return;
    const p = peerPid[peer];
    delete peerPid[peer];
    if (p && host.players[p] && !Object.values(peerPid).includes(p)) {
      host.players[p].online = false;
      logEvent(p, 'left the table');
      if (host.rules?.enabled) { runHook('onLeave', p); refreshButtons(); }
      bump();
    }
  };
}
// Belt and braces: until the host has bound our seat, keep knocking — covers
// hellos lost in connection churn and a host that comes back after a reload.
setInterval(() => { if (room && role === 'guest' && !registered) act({ t: 'hello' }); }, 3000);
window.addEventListener('pagehide', () => { try { room?.leave(); } catch (e) { console.error(e); } });

/** Open WebSockets to signaling relays right now. 0 = we're invisible. */
function openRelays() {
  try {
    return Object.values(getRelaySockets()).filter((s) => s?.readyState === 1).length;
  } catch (err) { console.error('relay status unavailable', err); return 0; }
}

function updateNet() {
  const n = room ? Object.keys(room.getPeers()).length : 0;
  const r = openRelays();
  netEl.classList.toggle('on', n > 0);
  netEl.classList.toggle('dead', r === 0);
  netEl.textContent = n > 0 ? `● ${n + 1}` : r > 0 ? '● …' : '● ✕';
  netEl.title = `${n + 1} player${n ? 's' : ''} here · ${r} signaling relays connected${r ? '' : ' — searching for relays'}`;
  if (role === 'guest') {
    hintEl.classList.toggle('hidden', view.seq > 0 && !!hostPeer);
    // Blame the host only when we can still reach the room: with no peers
    // and no relays, it's OUR connection that dropped.
    hintEl.textContent = !view.seq ? 'Waiting for the host…\n(the table lives in the host\'s open tab)'
      : n === 0 && r === 0 ? 'Connection lost — reconnecting…'
        : 'The host left — the table is paused until they return';
  }
}

// --- signaling watchdog ----------------------------------------------------
// Public Nostr relays are best-effort. If signaling dies (no open relay
// sockets) or a guest can't find the host, recover by RELOADING the page with
// backoff. (Rejoining in place — room.leave() + joinRoom — proved unreliable:
// tearing down a room over dead sockets can leave trystero half-subscribed
// and undiscoverable. A reload is the reset that provably works: the host
// resumes from its save, a guest re-enters with identity and hand intact.)
// The backoff lives in sessionStorage precisely so it survives those reloads.
const bootAt = Date.now();
setInterval(() => {
  if (!room) return;
  updateNet(); // keep the relay indicator fresh even when nothing happens
  const n = Object.keys(room.getPeers()).length;
  const starving = n === 0 && (openRelays() === 0 || (role === 'guest' && view.seq === 0));
  try {
    if (!starving) { sessionStorage.removeItem('ct-rejoin'); return; }
    const st = JSON.parse(sessionStorage.getItem('ct-rejoin') || '{}');
    const backoff = clamp(st.backoff || 20000, 20000, 120000);
    if (Date.now() - (st.at || bootAt) < backoff) return;
    sessionStorage.setItem('ct-rejoin', JSON.stringify({ backoff: Math.min(backoff * 2, 120000), at: Date.now() }));
    console.warn(`reconnecting via reload: ${openRelays() === 0 ? 'no relays reachable' : 'no host found yet'}`);
    toast('Connection is struggling — reconnecting…');
    setTimeout(() => location.reload(), 600); // let the toast paint first
  } catch (err) { console.error('watchdog failed', err); }
}, 5000);

// --- host persistence -----------------------------------------------------
// Two keys per room: ct-decks-<room> (the big image data, rewritten only when
// a deck is added) and ct-save-<room> = {ts, state} (small, throttle-saved).
// When storage is full, other rooms' saves are deleted oldest first (see
// oldSaves()); if this table still can't be saved, a tiny {lost} marker
// replaces the snapshot, so a reload never quietly rewinds to stale state —
// it resets the table loudly (and this browser stays the host instead of
// waiting in its own room).
let persistT = 0, lastSave = 0, persistWarned = false;
let savedDecks = -1; // how many decks storage holds: decks are append-only, so a new count means "rewrite"
function doSave() {
  if (role !== 'host') return; // a demoted host's pending timer must not clobber the winner's save
  lastSave = Date.now();
  const n = Object.keys(decks).length, deckJson = n !== savedDecks ? JSON.stringify(decks) : '';
  const saveJson = JSON.stringify({ ts: Date.now(), state: host });
  let old = null, freed = 0;
  for (;;) {
    try {
      if (n !== savedDecks) {
        savedDecks = -1;
        localStorage.setItem(`ct-decks-${roomId}`, deckJson);
        savedDecks = n;
      }
      localStorage.setItem(`ct-save-${roomId}`, saveJson);
      if (freed) toast(`Browser storage was full — deleted ${freed} old table save${freed > 1 ? 's' : ''} to keep this one`);
      persistWarned = false;
      return;
    } catch (err) {
      if (err.name === 'QuotaExceededError' && (old ??= oldSaves(deckJson.length + saveJson.length)).length) {
        const id = old.shift();
        console.warn('browser storage full — deleting the save of an older room', id);
        // (its ct-hostkey stays: tiny, and a tab still hosting that room needs it to resume)
        localStorage.removeItem(`ct-save-${id}`);
        localStorage.removeItem(`ct-decks-${id}`);
        freed++;
        continue;
      }
      console.error('failed to persist game', err);
      const why = err.name === 'QuotaExceededError' ? 'browser storage is full' : `auto-save failed: ${err.message}`;
      try {
        localStorage.removeItem(`ct-decks-${roomId}`);
        savedDecks = -1; // the next save that fits must write the decks again, or the state alone would "resume" without them
        localStorage.setItem(`ct-save-${roomId}`, JSON.stringify({ ts: Date.now(), lost: why }));
      } catch (e) { console.error('could not even mark the save as lost', e); }
      if (!persistWarned) { persistWarned = true; toast(`Can't save this table (${why}) — reloading the host tab would reset it`); }
      return;
    }
  }
}
/** Other rooms' saves that pruning may delete to fit `need` more chars,
 *  oldest first (saves without a ts — older versions — go first). Spared:
 *  saves written in the last 30 s (another tab is hosting that room right
 *  now — evicting each other would be endless), and all of them when even
 *  deleting every one couldn't make room (unrelated tables lost for nothing). */
function oldSaves(need) {
  const old = Object.keys(localStorage).filter((k) => k.startsWith('ct-save-') && k !== `ct-save-${roomId}`)
    .map((k) => {
      const id = k.slice('ct-save-'.length), raw = localStorage.getItem(k);
      let ts = 0;
      try { ts = num(JSON.parse(raw)?.ts); } catch (err) { console.error('unreadable save', k, err); }
      return { id, ts, size: raw.length + (localStorage.getItem(`ct-decks-${id}`)?.length || 0) };
    })
    .filter((x) => x.ts < Date.now() - 30000);
  const bytes = old.reduce((sum, x) => sum + x.size, 0);
  if (bytes < need) { console.warn(`not pruning other saves: this table (${need} chars) is bigger than all of them (${bytes})`); return []; }
  return old.sort((a, b) => a.ts - b.ts).map((x) => x.id);
}
// Another tab of this browser may delete this room's decks (storage-full
// pruning above): write them again with the next save.
window.addEventListener('storage', (e) => { if (e.key === `ct-decks-${roomId}` && e.newValue == null) savedDecks = -1; });
// Throttled (not debounced!) — a busy game must still hit storage regularly.
function persist() {
  if (role !== 'host' || persistT) return;
  persistT = setTimeout(() => { persistT = 0; doSave(); }, Math.max(0, 1000 - (Date.now() - lastSave)));
}
window.addEventListener('pagehide', () => {
  if (role === 'host') { clearTimeout(persistT); persistT = 0; doSave(); }
});
/** This room's save: {decks, state}, {lost: why} when it can't be resumed, or null if this browser never hosted it. */
function loadSave() {
  const raw = localStorage.getItem(`ct-save-${roomId}`);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (typeof s?.lost === 'string') return s;
    if (!s?.state?.items || !s.state.players) throw new Error('the save holds no table');
    s.decks ??= JSON.parse(localStorage.getItem(`ct-decks-${roomId}`) || 'null'); // older saves embed their decks
    if (!s.decks) throw new Error('the saved decks are missing');
    return s;
  } catch (err) {
    console.error('corrupt save discarded', err);
    return { lost: `the save is unreadable: ${err.message}` };
  }
}

// --- rendering ------------------------------------------------------------
const itemEls = new Map();
let sel = null, drag = null, handDrag = null, facedown = false;
let scale = 1;

/** Black or white text for a hex background (naive luminance split). */
const colorCtx = document.createElement('canvas').getContext('2d');
/** Light or dark text for any CSS background color (the canvas normalizes
 *  names, #rgb, #rrggbbaa… to #rrggbb for opaque colors). */
function contrastFor(color) {
  colorCtx.fillStyle = '#000';
  colorCtx.fillStyle = color;
  const m = colorCtx.fillStyle.match(/^#(..)(..)(..)$/);
  if (!m) return '#1e293b';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? '#f8fafc' : '#1e293b';
}
function faceHTML(d, i) {
  const deck = decks[d], c = deck?.cards[i];
  if (!c) return '<div class="face loading">🂠</div>'; // deck data not yet received
  const img = c.img ?? (c.g != null ? deck.imgs?.[c.g] : null); // g: shared-image index (copies ship the image once)
  if (img) return `<img class="face" src="${esc(img)}" alt="">`;
  if (c.r === 'JOKER') return `<div class="face std ${c.c}"><div class="corner">★</div><div class="mid joker">🃏</div><div class="corner br">★</div></div>`;
  if (c.r) return `<div class="face std ${c.c}"><div class="corner">${c.r}\n${c.s}</div><div class="mid"><div class="mr">${c.r}</div><div class="ms">${c.s}</div></div><div class="corner br">${c.r}\n${c.s}</div></div>`;
  // Image-less custom card: rendered from its manifest name/text/colors.
  const bg = c.b && safeColor(c.b, null);
  const style = `border-color:${safeColor(c.col || bg)}${bg ? `;background:${bg};color:${contrastFor(bg)}` : ''}`;
  return `<div class="face txt" style="${style}"><div class="tn">${esc(c.n || '')}</div>${c.txt ? `<div class="tt">${esc(c.txt)}</div>` : ''}</div>`;
}
function backHTML(d) {
  const b = decks[d]?.back;
  if (!b) return '<div class="back"></div>';
  if (IMG_RE.test(b)) return `<img class="back" src="${esc(b)}" alt="">`;
  return `<div class="back" style="background:${safeColor(b)}"></div>`; // solid-color back
}

/** Markup for a PUBLIC item (see publicItems: piles carry n + top). */
function contentFor(it) {
  if (it.k === 'c') return `<div class="cardbox">${it.up ? faceHTML(it.d, it.i) : backHTML(it.d)}</div>`;
  const top = it.top;
  const inner = top ? (top.up ? faceHTML(top.d, top.i) : backHTML(top.d)) : '';
  return `<div class="cardbox">${inner}</div><span class="count">${num(it.n)}</span>${it.name ? `<span class="pname">${esc(it.name)}</span>` : ''}`;
}

// --- motion (UX-I1) ----------------------------------------------------------
// Remote moves glide via a CSS transition on .item left/top (style.css; off
// while dragging and under prefers-reduced-motion). Here, diffing the last
// rendered view against the new one: a card that appears where a pile just
// shrank slides out of it (a deal), one that appears as a player's hand
// shrank slides in from their seat (a play), a pile that shrank while hands
// grew sends card backs flying to those seats, and a flip turns the card.
// Web Animations only: nothing to clean up, no forced reflows.
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let shown = { items: {}, players: {} }; // the view renderItems last drew
let landing = null; // {id, x, y, ox, oy}: our own drop (and the drag's origin), held until the host confirms or vetoes it
const MOTION_MS = 260;

/** A seat's spot on the rim in table coords (top-left of a card centred there). */
function seatSpot(p) {
  const rad = (num(view.players[p]?.seat) * Math.PI) / 180;
  return { x: TABLE_W / 2 + SEAT_R * Math.cos(rad) - CARD_W / 2, y: TABLE_H / 2 + SEAT_R * Math.sin(rad) - CARD_H / 2 };
}

/** Where the cards that newly appeared came from: piles that shrank (each with
 *  how many cards left them) and other players whose hands shrank. */
function motionSources() {
  const piles = Object.entries(shown.items).filter(([, o]) => o.k === 'p')
    .map(([id, o]) => ({ o, left: num(o.n) - num(view.items[id]?.n) })).filter((s) => s.left > 0);
  const hands = Object.entries(shown.players).filter(([p, o]) => p !== pid && num(view.players[p]?.handCount) < num(o.handCount))
    .map(([p]) => p);
  return { piles, hands };
}

/** Sends `n` card backs flying from pile `o` to player `p`'s seat (a deal or draw into a hand). */
function flyToSeat(o, p, n) {
  const to = seatSpot(p);
  for (let k = 0; k < n; k++) {
    const el = document.createElement('div');
    el.className = 'fly';
    el.innerHTML = `<div class="cardbox">${backHTML(o.top?.d)}</div>`;
    el.style.cssText = `left:${to.x}px;top:${to.y}px;z-index:99999`;
    tableEl.appendChild(el);
    el.animate([{ left: `${o.x}px`, top: `${o.y}px`, transform: `rotate(${num(o.rot)}deg)` }, { opacity: 0.2, transform: 'scale(0.6)' }],
      { duration: MOTION_MS + 120, delay: k * 70, easing: 'ease-in', fill: 'backwards' }).finished
      .catch((err) => console.error('card flight failed', err)).finally(() => el.remove());
  }
}

function renderItems() {
  const seen = new Set();
  const move = !calm.matches && motionSources();
  for (const [id, it] of Object.entries(view.items)) {
    seen.add(id);
    let el = itemEls.get(id);
    const prev = shown.items[id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'item';
      el.dataset.id = id;
      tableEl.appendChild(el);
      itemEls.set(id, el);
      // A brand-new card slides in from where it came from (deal / play).
      const src = move && it.k === 'c' && !prev && (move.piles.find((s) => s.left > 0) || move.hands.length && { o: seatSpot(move.hands[0]) });
      if (src) {
        src.left--;
        el.animate([{ left: `${src.o.x}px`, top: `${src.o.y}px` }, { left: `${it.x}px`, top: `${it.y}px` }], { duration: MOTION_MS, easing: 'ease-out' });
      }
    }
    const sig = it.k === 'c'
      ? `c|${it.d}|${it.i}|${it.up}|${!!decks[it.d]}`
      : `p|${it.n}|${JSON.stringify(it.top)}|${it.name}|${!!decks[it.top?.d]}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = contentFor(it);
      el.classList.toggle('pile', it.k === 'p');
      el.classList.toggle('multi', it.k === 'p' && it.n > 1);
      // Flipped (a card, or a pile whose size didn't change): the new side turns in.
      if (move && prev?.k === it.k && (it.k === 'c' ? prev.up !== it.up : prev.n === it.n && !!prev.top?.up !== !!it.top?.up)) {
        el.firstChild.animate([{ transform: 'perspective(600px) rotateY(90deg)' }, { transform: 'none' }], { duration: MOTION_MS, easing: 'ease-out' });
      }
    }
    // Our own drop: states the host sent before it applied our final move
    // carry a stale spot from mid-drag; keep the card where we let go until
    // the host confirms it (or vetoes it: the card was back at its origin).
    // Anything else (a script moved it on) is shown once the hold times out.
    const at = (x, y) => Math.abs(it.x - x) < 0.5 && Math.abs(it.y - y) < 0.5;
    if (landing?.id === id && (at(landing.x, landing.y) || at(landing.ox, landing.oy))) landing = null;
    if (drag?.id !== id && landing?.id !== id) { el.style.left = `${it.x}px`; el.style.top = `${it.y}px`; }
    el.style.transform = `rotate(${it.rot}deg)`;
    el.style.zIndex = it.z;
    el.classList.toggle('selected', sel === id);
  }
  for (const [id, el] of itemEls) if (!seen.has(id)) { el.remove(); itemEls.delete(id); }
  // Cards a pile lost without landing on the table went into hands: fly them there.
  if (move) {
    for (const [p, o] of Object.entries(view.players)) {
      let gain = shown.players[p] ? num(o.handCount) - num(shown.players[p].handCount) : 0;
      for (const s of move.piles) {
        const n = Math.min(gain, s.left);
        if (n > 0) { flyToSeat(s.o, p, Math.min(n, 3)); s.left -= n; gain -= n; }
      }
    }
  }
  shown = { items: view.items, players: view.players };
  if (sel && !view.items[sel]) select(null);
  else if (sel) placeBar();
}

// Seat labels: everyone sees the same seating, each from their own rotation.
let seatSig = '';
/** Whose move the rules wait on: public.turn is one player id or a list of them. */
const turnOf = () => [].concat((view.rules?.enabled && view.rules.public?.turn) || []);
function renderPlayers() {
  const turn = turnOf();
  const winners = (view.rules?.enabled && view.rules.public?.winners) || [];
  const badges = (view.rules?.enabled && view.rules.public?.badges) || {};
  // Only the host publishes online flags, so a guest marks a departed host itself.
  const hostGone = role === 'guest' && !hostPeer ? view.host : null;
  const strip = $('game-strip'); // the "What are we playing?" strip pushes the notices down too
  const sig = `${JSON.stringify(view.players)}|${turn}|${winners.join()}|${JSON.stringify(badges)}|${hostGone}|${viewAngle.toFixed(1)}|${scale.toFixed(4)}|${panX | 0},${panY | 0}|${wrapEl.clientWidth}x${wrapEl.clientHeight}|${strip.className}`;
  if (sig === seatSig) return;
  seatSig = sig;
  for (const el of wrapEl.querySelectorAll('.seat')) el.remove();
  // A table drawn small (phones) gets small, see-through labels: full-size
  // ones would reach into the felt and hide the cards the game puts there.
  wrapEl.classList.toggle('small-table', scale < 0.4);
  const seats = [];
  for (const [p, pl] of Object.entries(view.players)) {
    if (pl.seat == null) continue;
    const rad = (pl.seat * Math.PI) / 180;
    const [sx, sy] = tableToScreen(TABLE_W / 2 + SEAT_R * Math.cos(rad), TABLE_H / 2 + SEAT_R * Math.sin(rad));
    const el = document.createElement('div');
    const waited = turn.includes(p);
    el.className = `seat${pl.online && p !== hostGone ? '' : ' offline'}${p === pid ? ' me' : ''}${waited ? ' turn' : ''}${winners.includes(p) ? ' winner' : ''}`;
    el.style.borderColor = pl.color;
    el.textContent = `${winners.includes(p) ? '🏆 ' : ''}${waited ? '⏳ ' : ''}${pl.name || 'Player'} 🂠${pl.handCount}${badges[p] ? ` ${badges[p]}` : ''}`;
    seats.push({ p, el, sx, sy });
  }
  wrapEl.append(...seats.map((s) => s.el));
  // All sizes are read before any position is written: one layout for all the
  // labels, not one per seat (this runs on every pan/zoom/pinch frame).
  for (const s of seats) { s.hw = s.el.offsetWidth / 2 + 4; s.hh = s.el.offsetHeight / 2 + 2; }
  const W = wrapEl.clientWidth, H = wrapEl.clientHeight;
  let rowBottom = 12, noticeTop = 10; // #rules-btns' and #notices' default spots (CSS)
  for (const { p, el, sx, sy, hw, hh } of seats) {
    // Keep the whole label on screen (side seats sit on the rim, which a
    // phone's fit zoom puts right at the screen edge).
    const y = clamp(sy, hh, H - hh);
    el.style.left = `${clamp(sx, hw, W - hw)}px`;
    el.style.top = `${y}px`;
    // Your own label in the lower half: lift the rules button row just above
    // it, so the row never hides your name, ⏳, chips or score.
    if (p === pid && y > H / 2) rowBottom = Math.max(rowBottom, H - (y - hh) + 6);
    // Labels across the top: the banner and toasts start just below them.
    if (y < H / 4) noticeTop = Math.max(noticeTop, y + hh + 4);
  }
  // (#table-wrap and #notices both start at #main's top: the offsets agree)
  if (!strip.classList.contains('hidden')) noticeTop = Math.max(noticeTop, strip.offsetTop + strip.offsetHeight + 4);
  $('rules-btns').style.bottom = `${rowBottom}px`;
  $('notices').style.top = `${noticeTop}px`;
  // A short, wide table area (a phone in landscape) leaves wide empty
  // margins beside the round felt: the notices move into the left one and
  // the button row into the right one, so neither covers the cards (CSS .gutters).
  const gutter = (W - TABLE_W * scale) / 2, main = $('main');
  main.classList.toggle('gutters', H < 500 && gutter >= 180);
  main.style.setProperty('--gutter', `${gutter | 0}px`);
}

let handSig = '';
let sortHand = false; // ⇅: show the hand sorted (display only — the host's order is untouched)
try { sortHand = localStorage.getItem('ct-sort') === '1'; } catch (err) { console.error('hand sort setting unreadable', err); }
const SUIT_ORDER = { '♠': 0, '♥': 1, '♦': 2, '♣': 3, '🃏': 4 };
/** Hand indices in display order: as held, or (⇅) standard cards by suit,
 *  high rank first (like the Bridge dummy), other cards after them as held. */
function handOrder() {
  const order = myHand.map((_, k) => k);
  const key = (c) => {
    const x = decks[c.d]?.cards[c.i];
    return x?.s ? SUIT_ORDER[x.s] * 100 - (x.r === 'A' ? 14 : [...RANKS].indexOf(x.r) + 1) : 1000;
  };
  return sortHand ? order.sort((a, b) => key(myHand[a]) - key(myHand[b]) || a - b) : order;
}
function renderHand() {
  const sig = JSON.stringify(myHand) + sortHand;
  if (sig === handSig) return;
  handSig = sig;
  handEl.innerHTML = '';
  $('sort-toggle').classList.toggle('on', sortHand);
  for (const idx of handOrder()) {
    const el = document.createElement('div');
    el.className = 'hcard';
    el.dataset.idx = idx; // the REAL hand index: plays name the card the host holds there
    el.innerHTML = faceHTML(myHand[idx].d, myHand[idx].i);
    handEl.appendChild(el);
  }
  fitHand();
}
/** Fans a crowded hand: the cards overlap just enough to all fit, like a
 *  hand of real cards (each keeps at least 40% showing, its corner index
 *  readable); a hand too big even for that scrolls sideways. */
function fitHand() {
  const n = handEl.children.length, cw = handEl.firstElementChild?.offsetWidth || 0, gap = 8;
  const over = n * cw + (n - 1) * gap - (handEl.clientWidth - 4); // 4: #hand's side padding
  // keep ≥ 40% of a card AND ≥ 28px showing: small cards stay tappable
  const ov = n > 1 && over > 0 ? Math.min(Math.ceil(over / (n - 1)), Math.min(cw * 0.6, cw - 28) + gap) : 0;
  handEl.style.setProperty('--hov', `${ov}px`);
}
new ResizeObserver(fitHand).observe(handEl); // window, side panel and hand-bar changes
$('sort-toggle').addEventListener('click', () => {
  sortHand = !sortHand;
  try { localStorage.setItem('ct-sort', sortHand ? '1' : '0'); } catch (err) { console.error('hand sort setting not saved', err); }
  renderHand();
});

/** Display identity for a log/bulb actor (players or the Rules script). */
function actorInfo(p) {
  if (p === RULES) return { name: '📜 Rules', color: '#a78bfa' };
  const pl = view.players[p];
  return { name: pl?.name || 'Player', color: pl?.color || '#94a3b8' };
}

let logSig = '';
function renderLog() {
  const last = gameLog.at(-1);
  // Names are resolved live from view.players, which may arrive AFTER the log
  // (a joiner gets the log first) or change (renames): key on them too.
  const names = Object.entries(view.players).map(([p, pl]) => p + pl.name + pl.color).join();
  const sig = `${gameLog.length}|${last?.ts}|${last?.txt}|${names}`;
  if (sig === logSig) return;
  logSig = sig;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  logEl.innerHTML = gameLog.map((e) => {
    const who = actorInfo(e.p);
    const name = `<b style="color:${safeColor(who.color)}">${esc(typeof e.n === 'string' ? e.n : who.name)}</b>`;
    const time = `<span class="lt">${new Date(e.ts).toTimeString().slice(0, 5)}</span>`;
    return e.c
      ? `<div class="lg chat">${time}${name}: ${esc(e.txt)}</div>`
      : `<div class="lg">${time}${name} ${esc(e.txt)}</div>`;
  }).join('');
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

let rbSig = '';
function renderRulesBtns() {
  const rules = role === 'host' ? host?.rules : view.rules;
  const btns = (rules?.enabled && (rules.public?.buttons || []).filter((b) => !b.pid || b.pid === pid)) || [];
  const sig = JSON.stringify(btns) + (rules?.enabled ? rules.name : '');
  if (sig === rbSig) return;
  rbSig = sig;
  const row = $('rules-btns');
  row.classList.toggle('hidden', !btns.length);
  row.innerHTML = btns.map((b) => `<button data-rbtn="${esc(b.id)}">${esc(b.label)}</button>`).join('');
  $('rules-btn').classList.toggle('on', !!rules?.enabled);
  $('rules-btn').title = rules?.enabled ? `Rules active: ${rules.name}` : 'Game rules script';
}
$('rules-btns').addEventListener('click', (e) => {
  const id = e.target.dataset.rbtn;
  if (id) act({ t: 'rulesBtn', id });
});

// --- table cues: your-turn alert (UX-I2) and win celebration (UX-I4) --------
// Generic: any script that sets public.turn / public.winners gets them.
const baseTitle = document.title;
const CONFETTI = ['🎉', '✨', '🃏', '⭐', '🏆', '💰'];
let myTurn = false, winSeen = null, cueT = 0;
/** Vibrates where supported (phones). Not before the first tap: Chrome would
 *  log a "blocked" error (e.g. on a reload during your turn). Browsers
 *  without userActivation just try. */
const buzz = (pattern) => navigator.userActivation?.hasBeenActive !== false && navigator.vibrate?.(pattern);

function renderCues() {
  const pub = (view.rules?.enabled && view.rules.public) || {};
  const mine = turnOf().includes(pid);
  if (mine !== myTurn) {
    myTurn = mine;
    document.title = mine ? `⏳ Your turn · ${baseTitle}` : baseTitle;
    $('hand-bar').classList.toggle('myturn', mine);
    $('turn-cue').classList.toggle('hidden', !mine);
    clearTimeout(cueT);
    if (mine) {
      buzz([60, 40, 60]);
      cueT = setTimeout(() => $('turn-cue').classList.add('hidden'), 2200);
    }
  }
  const winners = Array.isArray(pub.winners) ? pub.winners : [];
  // A win is a t.win() call (winSeq grew) or a new name in winners (a script
  // may set them directly). winSeen stays null until the first real state of
  // a running game: joining (or reloading into) a finished game, or
  // re-enabling a kept one, is not a new win.
  const seq = num(pub.winSeq);
  if (!view.rules?.enabled) winSeen = null;
  else {
    if (winSeen && (seq > winSeen.seq || winners.some((w) => !winSeen.ids.includes(w)))) celebrate(winners.includes(pid));
    if (view.seq) winSeen = { ids: winners, seq };
  }
}

/** An emoji confetti burst over the whole screen (bigger, plus a buzz, for the winners). */
function celebrate(won) {
  if (won) buzz([90, 50, 90, 50, 220]);
  if (calm.matches) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let k = 0; k < (won ? 48 : 24); k++) {
    const s = document.createElement('span');
    s.textContent = CONFETTI[k % CONFETTI.length]; // array of whole emoji: never split a surrogate pair
    s.style.cssText = `left:${Math.random() * 100}%;animation-delay:${Math.random() * 0.4}s;--dx:${Math.random() * 160 - 80}px;--r:${Math.random() * 720 - 360}deg`;
    box.append(s);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2400);
}

function renderAll() {
  applySeatView();
  renderItems();
  renderGames(); // before the seats: the strip's place moves the notices
  renderPlayers();
  renderHand();
  renderLog();
  renderRulesBtns();
  renderFacedown();
  renderCues();
  updateNet();
}

// --- viewport: fit + per-player view (rotate / zoom / pan) ------------------
// Each player has their OWN view of the round table: a rotation (auto-set so
// their seat is at the bottom), a zoom factor and a pan offset. Desktop:
// wheel zooms about the cursor, dragging empty felt pans. Touch: two fingers
// pinch-zoom, twist-rotate and pan in one gesture. 🧭 resets everything to
// the seat view. All purely local projection — shared state never rotates.
let viewAngle = 0;
let manualView = false; // true after a manual rotation, until 🧭 resets it
let zoomZ = 1, panX = 0, panY = 0;

/** Rotates a vector by `a` degrees (screen coords, clockwise-positive). */
function rotv(x, y, a) {
  const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

function layout() {
  const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
  scale = Math.min(w / TABLE_W, h / TABLE_H) * zoomZ; // fit × user zoom
  const lim = (TABLE_W * scale) / 2; // keep at least the table's center reachable
  panX = clamp(panX, -lim, lim);
  panY = clamp(panY, -lim, lim);
  // Center the unscaled table on the wrap; then scale, rotate, and pan.
  tableEl.style.left = `${(w - TABLE_W) / 2}px`;
  tableEl.style.top = `${(h - TABLE_H) / 2}px`;
  tableEl.style.transform = `translate(${panX}px, ${panY}px) rotate(${viewAngle}deg) scale(${scale})`;
  hintEl.style.transform = `rotate(${-viewAngle}deg)`; // keep the hint readable
  if (sel) placeBar();
  for (const b of bulbs.values()) placeFx(b);
  renderPlayers(); // seat labels live in screen space and track the view
}
new ResizeObserver(layout).observe(wrapEl);

function toTable(e) {
  const r = wrapEl.getBoundingClientRect();
  const [ux, uy] = rotv(e.clientX - r.left - r.width / 2 - panX, e.clientY - r.top - r.height / 2 - panY, -viewAngle);
  return { x: TABLE_W / 2 + ux / scale, y: TABLE_H / 2 + uy / scale };
}

/** Table coords -> wrap-relative screen px, honoring the view transform. */
function tableToScreen(x, y) {
  const [rx, ry] = rotv((x - TABLE_W / 2) * scale, (y - TABLE_H / 2) * scale, viewAngle);
  return [wrapEl.clientWidth / 2 + panX + rx, wrapEl.clientHeight / 2 + panY + ry];
}

/** Re-anchors the view so table point `t` sits at client position (cx, cy). */
function anchorView(t, cx, cy) {
  const r = wrapEl.getBoundingClientRect();
  const [sx, sy] = tableToScreen(t.x, t.y);
  panX += cx - r.left - sx;
  panY += cy - r.top - sy;
  layout();
}

// Wheel: zoom about the cursor so the point under it stays put.
wrapEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = toTable(e);
  zoomZ = clamp(zoomZ * Math.exp(-e.deltaY * 0.0015), 0.5, 4);
  layout();
  anchorView(before, e.clientX, e.clientY);
}, { passive: false });

/** Item rotation that appears upright on THIS player's rotated screen. */
const uprightRot = () => ((-viewAngle % 360) + 360) % 360;

/** Rotates the view so the player's own seat is at the bottom of the screen. */
function applySeatView() {
  if (manualView) return;
  const s = view.players[pid]?.seat;
  if (s == null) return;
  const want = (((90 - s) % 360) + 360) % 360;
  if (Math.abs(want - viewAngle) > 0.5) { viewAngle = want; layout(); }
}

// --- selection & action bar ----------------------------------------------
function select(id) {
  sel = id;
  for (const [i, el] of itemEls) el.classList.toggle('selected', i === sel);
  if (!sel) { barEl.classList.add('hidden'); return; }
  const it = view.items[sel];
  barEl.innerHTML = it.k === 'c'
    ? `<button data-cmd="flip">Flip</button>${it.up ? '<button data-cmd="zoom">🔍</button>' : '<button data-cmd="peek">Peek</button>'}<button data-cmd="rl">⟲90</button><button data-cmd="rr">⟳90</button><button data-cmd="hand">Hand</button><button data-cmd="del">🗑</button>`
    : `<button data-cmd="draw">Draw</button><button data-cmd="peek">Peek</button><button data-cmd="dealup">Deal↑</button><button data-cmd="dealdn">Deal↓</button><button data-cmd="shuffle">Shuffle</button><button data-cmd="flip">Flip</button><button data-cmd="rr">⟳90</button><button data-cmd="del">🗑</button>`;
  barEl.classList.remove('hidden');
  placeBar();
}

// The bar lives OUTSIDE the scaled table (in screen space) so its buttons stay
// finger-sized on small screens; convert the item's table coords to screen px.
function placeBar() {
  const it = view.items[sel];
  if (!it) return;
  const [sx, sy] = tableToScreen(it.x + CARD_W / 2, it.y + CARD_H / 2);
  const half = CARD_H * 0.6 * scale; // covers rotated cards too
  // The bar's real size: it wraps into rows on a narrow screen.
  const hw = barEl.offsetWidth / 2, bh = barEl.offsetHeight;
  const yAbove = sy - half - bh - 4;
  barEl.style.left = `${clamp(sx, hw + 4, wrapEl.clientWidth - hw - 4)}px`;
  barEl.style.top = `${yAbove >= 4 ? yAbove : sy + half + 8}px`;
}

// --- announcement banner (t.announce / t.win) -------------------------------
let annT = 0;
function showAnnounce(msg) {
  const el = $('announce');
  el.textContent = String(msg);
  el.classList.remove('hidden', 'fade');
  clearTimeout(annT);
  annT = setTimeout(() => {
    el.classList.add('fade');
    annT = setTimeout(() => el.classList.add('hidden'), 700);
  }, 3800);
}

// --- transient "who did that" bulbs ----------------------------------------
const bulbs = new Map(); // "pid|itemId" -> {el, timer, f}
/** Puts a bulb over its item (or the spot the item left), in screen space —
 *  re-run by layout() so bulbs follow pan, zoom, rotation and resizes. */
function placeFx(b) {
  const it = b.f.id && view.items[b.f.id];
  const [sx, sy] = tableToScreen((it ? it.x : b.f.x) + CARD_W / 2, (it ? it.y : b.f.y) + CARD_H / 2);
  b.el.style.left = `${clamp(sx, 30, wrapEl.clientWidth - 30)}px`;
  b.el.style.top = `${Math.max(20, sy - CARD_H * 0.55 * scale)}px`;
}
function showFx(f) {
  // Script ops are credited "📜 Rules" in the log; a bulb per op would just
  // pile up (a single deal or judge does several).
  if (f.p === RULES) return;
  const who = actorInfo(f.p);
  const key = `${f.p}|${f.id}`;
  let b = bulbs.get(key);
  if (!b) {
    const el = document.createElement('div');
    el.className = 'fx-bulb';
    wrapEl.appendChild(el);
    b = { el, timer: 0 };
    bulbs.set(key, b);
  }
  b.f = f;
  b.el.textContent = who.name;
  b.el.style.borderColor = who.color;
  placeFx(b);
  b.el.classList.remove('fade');
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    b.el.classList.add('fade');
    b.timer = setTimeout(() => { b.el.remove(); bulbs.delete(key); }, 450);
  }, 1500);
}

/** A spot next to a pile for dealt cards, jittered so repeated deals stay visible. */
function dealSpot(it) {
  const j = () => Math.round(Math.random() * 24 - 12);
  const x = it.x + CARD_W + 18;
  return x + CARD_W <= TABLE_W ? { x: x + j(), y: it.y + j() } : { x: it.x - CARD_W - 18 + j(), y: it.y + j() };
}

barEl.addEventListener('click', (e) => {
  const cmd = e.target.dataset.cmd;
  const it = sel && view.items[sel];
  if (!cmd || !it) return;
  const cmds = {
    flip: () => act({ t: 'flip', id: sel }),
    rl: () => act({ t: 'rot', id: sel, rot: it.rot - 90 }),
    rr: () => act({ t: 'rot', id: sel, rot: it.rot + 90 }),
    hand: () => act({ t: 'toHand', id: sel }),
    del: () => act({ t: 'del', id: sel }),
    draw: () => act({ t: 'draw', id: sel }),
    dealup: () => act({ t: 'deal', id: sel, up: true, rot: uprightRot(), ...dealSpot(it) }),
    dealdn: () => act({ t: 'deal', id: sel, up: false, rot: uprightRot(), ...dealSpot(it) }),
    shuffle: () => act({ t: 'shuffle', id: sel }),
    peek: () => act({ t: 'peek', id: sel }), // the host logs it, then reveals the card to us alone (showPeek)
    zoom: () => showZoom(it.d, it.i), // face-up card: public info, silent
  };
  cmds[cmd]?.();
});

// --- card zoom overlay (also used by the loud peek) -------------------------
const peekEl = $('peek');
function showZoom(d, i, caption) {
  // Scale the card to comfortably fill the viewport — this is the readable
  // view for decks with small text.
  const f = Math.min((window.innerHeight * 0.72) / CARD_H, (window.innerWidth * 0.85) / CARD_W);
  $('peek-inner').style.transform = `scale(${f})`;
  $('peek-inner').innerHTML = faceHTML(d, i);
  $('peek-cap').textContent = caption || 'Click anywhere to close';
  peekEl.classList.remove('hidden');
}
peekEl.addEventListener('click', () => peekEl.classList.add('hidden'));
// Escape closes the zoom/peek overlay, else dismisses the action bar. An open
// <dialog> keeps Escape for itself (the browser closes it).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (!peekEl.classList.contains('hidden')) peekEl.classList.add('hidden');
  else select(null);
});
/** Reveals a peeked card {d, i} to this player only (the host's answer to a peek action). */
function showPeek(c) {
  showZoom(c.d, c.i, 'Only you can see this — everyone knows you peeked. Click to close.');
  if (CLI) cliMsgs.push(`peek: ${cardName(c.d, c.i)}`);
}

// --- dragging table items / pan / pinch -------------------------------------
let feltDrag = null; // dragging empty felt = panning MY view
let pinch = null;    // two-finger gesture: zoom + rotate + pan in one
let holdZoom = false; // a long-press zoom is showing: it closes when the finger lifts
const tPtrs = new Map(); // pointers currently down on the table

/** Ends an in-flight item drag cleanly (used when a pinch takes over). */
function cancelItemDrag() {
  if (!drag) return;
  drag.el.classList.remove('dragging');
  if (drag.moved && view.items[drag.id]) act({ t: 'move', id: drag.id, x: drag.x, y: drag.y });
  drag = null;
}

function startPinch() {
  cancelItemDrag();
  feltDrag = null;
  const [p1, p2] = [...tPtrs.values()];
  const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  pinch = {
    z0: zoomZ,
    a0: viewAngle,
    d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
    ang0: (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI,
    t0: toTable({ clientX: m.x, clientY: m.y }), // table point pinned under the fingers
  };
}

function updatePinch() {
  const [p1, p2] = [...tPtrs.values()];
  const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const ang = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
  zoomZ = clamp(pinch.z0 * (d / pinch.d0), 0.5, 4);
  viewAngle = (((pinch.a0 + ang - pinch.ang0) % 360) + 360) % 360;
  manualView = true;
  layout();
  anchorView(pinch.t0, m.x, m.y); // the felt tracks the fingers
}

tableEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('#action-bar')) return;
  tPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tPtrs.size === 2) { e.preventDefault(); startPinch(); return; }
  if (tPtrs.size > 2 || pinch) return;
  const el = e.target.closest('.item');
  if (!el) {
    feltDrag = { sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false };
    return;
  }
  const it = view.items[el.dataset.id];
  if (!it) return;
  e.preventDefault();
  const p = toTable(e);
  // The live position lives on the drag record (x, y), never in view.items:
  // incoming states replace those objects mid-drag (a guest would drop at a
  // stale spot), and the host must not touch state outside apply() (a vetoed
  // drop has to snap back).
  const d = drag = { id: el.dataset.id, el, dx: p.x - it.x, dy: p.y - it.y, sx: p.x, sy: p.y, x: it.x, y: it.y, ox: it.x, oy: it.y, moved: false, last: 0 };
  // Touch long-press (≈450 ms without moving) zooms a face-up card or pile
  // top until the finger lifts (UX-I5); a drag, a pinch or an early lift
  // cancels it. Release-to-close also swallows the tap the browser may
  // synthesize on release, which would otherwise land on the overlay.
  const face = it.k === 'c' ? it.up && it : it.top?.up && it.top;
  if (face && e.pointerType !== 'mouse') {
    setTimeout(() => {
      if (drag !== d || d.moved || pinch) return;
      drag = null;
      holdZoom = true;
      showZoom(face.d, face.i, 'Release to close');
    }, 450);
  }
});

// Android's long-press image menu ("Download image…") would cover or cancel
// the long-press zoom on image-deck cards (iOS: -webkit-touch-callout).
tableEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.item')) e.preventDefault(); });

window.addEventListener('pointermove', (e) => {
  if (tPtrs.has(e.pointerId)) tPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) { if (tPtrs.size >= 2) updatePinch(); return; }
  if (handResize) {
    handH = clamp(handResize.h + (handResize.y - e.clientY), 60, 340);
    document.documentElement.style.setProperty('--hch', `${handH}px`);
    fitHand();
    return;
  }
  if (handDrag) { moveGhost(e); return; }
  if (feltDrag) {
    if (!feltDrag.moved && Math.hypot(e.clientX - feltDrag.sx, e.clientY - feltDrag.sy) < 5) return;
    feltDrag.moved = true;
    panX = feltDrag.px + (e.clientX - feltDrag.sx);
    panY = feltDrag.py + (e.clientY - feltDrag.sy);
    layout();
    return;
  }
  if (!drag) return;
  const p = toTable(e);
  if (!view.items[drag.id]) { drag = null; return; }
  if (!drag.moved) {
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) < 5 / scale) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
    drag.el.style.zIndex = 100000; // visually on top; the host assigns the real z on move
    select(null);
  }
  ({ x: drag.x, y: drag.y } = clampToFelt(p.x - drag.dx, p.y - drag.dy));
  drag.el.style.left = `${drag.x}px`;
  drag.el.style.top = `${drag.y}px`;
  // Throttled live position for the other players; the final one is sent on drop.
  if (role === 'guest' && e.timeStamp - drag.last > 60) {
    drag.last = e.timeStamp;
    act({ t: 'move', id: drag.id, x: drag.x, y: drag.y });
  }
});

/** Closes a long-press zoom (the finger lifted); true if there was one. */
function endHoldZoom() {
  if (!holdZoom) return false;
  holdZoom = false;
  peekEl.classList.add('hidden');
  return true;
}

window.addEventListener('pointercancel', (e) => {
  tPtrs.delete(e.pointerId);
  endHoldZoom();
  if (tPtrs.size < 2) pinch = null;
  handResize = null;
  feltDrag = null;
  if (handDrag?.moved) { ghost?.remove(); ghost = null; }
  handDrag = null;
  cancelItemDrag();
});

window.addEventListener('pointerup', (e) => {
  tPtrs.delete(e.pointerId);
  if (endHoldZoom()) return;
  if (pinch) {
    if (tPtrs.size < 2) pinch = null; // gesture ends; a leftover finger is inert
    return;
  }
  if (handResize) {
    handResize = null;
    localStorage.setItem('ct-handh', handH);
    return;
  }
  if (handDrag) { dropGhost(e); return; }
  if (feltDrag) {
    const panned = feltDrag.moved;
    feltDrag = null;
    if (!panned) select(null); // a plain click on empty felt just deselects
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;
  const it = view.items[d.id];
  if (!it) { d.el.classList.remove('dragging'); return; }
  if (!d.moved) { d.el.classList.remove('dragging'); select(sel === d.id ? null : d.id); return; }

  // Drop target: the hand bar takes a card into your hand; a pile/card under
  // the pointer stacks or merges. Hit-test BEFORE re-enabling pointer-events
  // on the dragged element (.dragging), so elementFromPoint sees underneath it.
  const under = document.elementFromPoint(e.clientX, e.clientY);
  d.el.classList.remove('dragging');
  const overItem = under?.closest('.item');
  const tgtId = overItem && overItem.dataset.id !== d.id ? overItem.dataset.id : null;
  const tgt = tgtId && view.items[tgtId];
  if (it.k === 'c' && under?.closest('#hand-bar')) act({ t: 'toHand', id: d.id });
  else if (it.k === 'c' && tgt?.k === 'p') act({ t: 'toPile', id: d.id, pile: tgtId });
  else if (it.k === 'c' && tgt?.k === 'c') act({ t: 'stack', id: d.id, onto: tgtId });
  else if (it.k === 'p' && tgt?.k === 'p') act({ t: 'merge', id: d.id, pile: tgtId });
  else {
    // The hold heals itself: with no confirming state (a script moved the
    // card elsewhere, a veto left it mid-drag, coalescing merged the state
    // away) we show where the host has it after 1.5 s, quiet table or not.
    const L = landing = { id: d.id, x: d.x, y: d.y, ox: d.ox, oy: d.oy };
    setTimeout(() => { if (landing === L) { landing = null; renderItems(); } }, 1500);
    act({ t: 'move', id: d.id, x: d.x, y: d.y });
  }
});

tableEl.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.item');
  const it = el && view.items[el.dataset.id];
  if (!it) return;
  act(it.k === 'c' ? { t: 'flip', id: el.dataset.id } : { t: 'draw', id: el.dataset.id });
});

// --- dragging out of the hand (a plain click zooms the card instead) -------
// Touch: .hcard is `touch-action: pan-x`, so a sideways swipe scrolls the hand
// (the browser takes it over and sends pointercancel); only a mostly vertical
// drag pulls a card out. A mouse drags out in any direction.
let ghost = null, handDragged = false; // handDragged: the last press became a drag
handEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.hcard');
  if (!el || e.button !== 0) return;
  e.preventDefault();
  const idx = +el.dataset.idx;
  if (!myHand[idx]) return;
  handDragged = false;
  handDrag = { idx, card: myHand[idx], sx: e.clientX, sy: e.clientY, moved: false, touch: e.pointerType !== 'mouse' };
});
// The zoom opens on click, not pointerup: a tap's click would otherwise land on
// the overlay that just opened under the finger and close it at once.
handEl.addEventListener('click', (e) => {
  const el = e.target.closest('.hcard');
  const c = el && myHand[+el.dataset.idx];
  if (c && !handDragged) showZoom(c.d, c.i); // a drag dropped back on its card isn't a click
});
// A mouse wheel scrolls the hand sideways (it has no vertical scroll).
handEl.addEventListener('wheel', (e) => {
  if (e.shiftKey || !e.deltaY) return;
  handEl.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

function moveGhost(e) {
  if (!handDrag.moved) {
    const dx = e.clientX - handDrag.sx, dy = e.clientY - handDrag.sy;
    if (Math.hypot(dx, dy) < 6 || (handDrag.touch && Math.abs(dx) > Math.abs(dy))) return;
    handDrag.moved = true;
    ghost = document.createElement('div');
    ghost.id = 'ghost';
    ghost.innerHTML = playFacedown() ? backHTML(handDrag.card.d) : faceHTML(handDrag.card.d, handDrag.card.i);
    document.body.appendChild(ghost);
  }
  ghost.style.left = `${e.clientX - handH * 5 / 14}px`; // center: half of hch*5/7 width
  ghost.style.top = `${e.clientY - handH / 2}px`;
  $('hand-bar').classList.toggle('droppable', !!e.target.closest?.('#hand-bar'));
}

function dropGhost(e) {
  const { idx, card, moved } = handDrag;
  handDrag = null;
  if (!moved) return; // a click, not a drag: the click handler enlarges it
  handDragged = true;
  ghost.remove();
  ghost = null;
  $('hand-bar').classList.remove('droppable');
  const under = document.elementFromPoint(e.clientX, e.clientY);
  if (under?.closest('#hand-bar')) return; // dropped back into the hand
  const overItem = under?.closest('.item');
  const tgt = overItem && view.items[overItem.dataset.id]; // (view items carry no id: it is the key)
  if (tgt?.k === 'p') { act({ t: 'handPile', idx, d: card.d, i: card.i, pile: overItem.dataset.id }); return; }
  if (!under?.closest('#table')) return;
  const p = toTable(e);
  // rot: cards land upright from the player's (possibly rotated) point of view
  act({ t: 'play', idx, d: card.d, i: card.i, x: p.x - CARD_W / 2, y: p.y - CARD_H / 2, up: !playFacedown(), rot: uprightRot() });
}

// Face-down mode is the player's own toggle, unless the rules script forces
// it (public.facedown: true, or a list of pids — ENGINE.md §4), e.g. for
// secret submissions: then the toggle shows locked on.
const forcedFacedown = () => {
  const fd = view.rules?.enabled && view.rules.public?.facedown;
  return fd === true || (Array.isArray(fd) && fd.includes(pid));
};
const playFacedown = () => facedown || forcedFacedown();
function renderFacedown() {
  const btn = $('facedown-toggle'), forced = forcedFacedown();
  btn.classList.toggle('on', facedown || forced);
  btn.classList.toggle('locked', forced);
  btn.title = forced ? 'The rules require cards from your hand to be played face down'
    : 'When on, cards dragged from your hand land face down';
}
$('facedown-toggle').addEventListener('click', () => {
  if (forcedFacedown()) { toast('The rules require face-down plays right now'); return; }
  facedown = !facedown;
  renderFacedown();
});

// --- resizable hand tray ---------------------------------------------------
// Default: smaller cards on short screens (phone landscape), so the table keeps room.
let handH = clamp(parseInt(localStorage.getItem('ct-handh'), 10) || (innerHeight < 500 ? 76 : 120), 60, 340);
let handResize = null;
document.documentElement.style.setProperty('--hch', `${handH}px`);
$('hand-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handResize = { y: e.clientY, h: handH };
});

// --- toolbar --------------------------------------------------------------
const nameInput = $('name-input');
nameInput.value = myName;
nameInput.addEventListener('change', () => {
  myName = nameInput.value.trim() || myName;
  nameInput.value = myName;
  if (!AS) localStorage.setItem('ct-name', myName); // a bot tab never renames the human
  act({ t: 'name', name: myName });
});

// Invites are rebuilt from the room id — never location.href, which may carry
// this tab's private bridge/bot hash extras.
const inviteLink = () => `${location.origin}${location.pathname}#room~${roomId}~${password}`;
$('invite-btn').addEventListener('click', async () => {
  const link = inviteLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied — send it to your friends', true);
  } catch (err) {
    console.error('clipboard unavailable', err);
    window.prompt('Share this invite link:', link);
  }
});

$('qr-btn').addEventListener('click', async () => {
  try {
    // Lazy-loaded: the QR library is only fetched when someone actually asks for a code.
    const { toCanvas } = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
    await toCanvas($('qr-canvas'), inviteLink(), { width: 320, margin: 2 });
    $('qr-link').textContent = inviteLink();
    $('qr-dialog').showModal();
  } catch (err) {
    console.error('QR code failed', err);
    toast(`QR code failed: ${err.message}`);
  }
});

$('help-btn').addEventListener('click', () => $('help-dialog').showModal());
$('add-deck-btn').addEventListener('click', () => $('deck-dialog').showModal());

// --- rules dialog -----------------------------------------------------------
const RULES_TEMPLATES = {
  blank: `({
  name: 'My game',
  // Runs once when you enable the rules.
  setup(t) { t.say('Rules are on.'); },
  // Return a string to BLOCK a player's action. a = {t, p, ...}; a.p is the
  // acting player's id, a.t the action type ('play', 'draw', 'move', ...).
  validate(t, a) { },
  // React AFTER an action applies — automations go here.
  onAction(t, a) { },
  // Buttons shown under the table ({pid: playerId} restricts who sees one).
  buttons: (t) => [],
  onButton(t, id, byPid) { },
  onJoin(t, p) { }, onLeave(t, p) { },
  // t.schedule(seconds, tag) later fires onTimer(t, tag).
  onTimer(t, tag) { },
})`,
  turns: `({
  name: 'Turn order',
  setup(t) {
    const ps = t.players();
    t.data.turn ??= ps[0]?.id; // a re-enable keeps whose turn it is
    // never leave the turn with someone who is away (nextSeat skips offline seats)
    if (!ps.some((p) => p.id === t.data.turn && p.online)) t.data.turn = t.nextSeat(t.data.turn);
    t.public.turn = t.data.turn;
    t.say('Turn order: ' + ps.map((p) => p.name).join(' → '));
  },
  onLeave(t, p) { if (p === t.data.turn) this.passOn(t); },
  // After a host reload a turn holder who never comes back gets no onLeave:
  // whenever someone (re)joins, give an absent turn holder 10 s to return.
  onJoin(t) { t.schedule(10, 'away'); },
  onTimer(t) { if (!t.players().some((p) => p.id === t.data.turn && p.online)) this.passOn(t); },
  passOn(t) {
    t.data.turn = t.public.turn = t.nextSeat(t.data.turn);
    t.say('The turn passes on — its player left');
  },
  validate(t, a) {
    const guarded = ['play', 'handPile', 'deal', 'draw', 'toHand'];
    if (guarded.includes(a.t) && a.p !== t.data.turn) return "It's not your turn";
  },
  onAction(t, a) {
    if (a.t === 'play' || a.t === 'handPile') {
      t.data.turn = t.nextSeat(t.data.turn);
      t.public.turn = t.data.turn;
    }
  },
})`,
  holdem: `({
  name: "Hold'em (chips)",
  // Full no-limit Hold'em with chip tracking: stacks live on the seat labels
  // (💰), blinds post automatically (dealer button rotates), betting rounds
  // are turn-enforced. The player to act gets buttons — Check/Call, Fold and
  // quick bets (Min raise, ½ pot, Pot, All-in; each shows the round total it
  // raises TO) — or types in chat: "!bet 50" / "!raise 50" (raise TO 50),
  // "!allin", "!check", "!call", "!fold". A short all-in doesn't reopen the
  // raising for players who already acted. Streets deal themselves when a
  // round closes, all-ins run out automatically, and the showdown returns an
  // uncalled bet, evaluates best-5-of-7, builds side pots, and pays every pot
  // to the right hands (ties split, odd chips left of the button).
  // Only online players are dealt in; a player who drops mid-hand has 20 s
  // to come back before they are folded (unless they're all-in). Between
  // hands anyone may deal, a busted player gets a "💰 Rebuy" button (or types
  // "!rebuy") and the host sets the blinds ("!blinds 5 10"). Mid-hand only
  // the host can call the hand off (every bet refunded): Abandon, pressed twice.
  // New hand gathers only this game's deck; another deck's cards in a hand
  // (say, from a game played before) go onto a "Set aside" pile.
  BUYIN: 1000,
  AWAY: 20, // seconds a dropped player has to return
  setup(t) {
    t.data.stacks ||= {};
    t.data.blinds ||= { sb: 5, bb: 10 };
    t.data.burn ||= []; // (a hand dealt by an older version of this script lacks these)
    t.data.canRaise ||= [];
    for (const p of t.players()) t.data.stacks[p.id] ??= this.BUYIN;
    this.badges(t);
    t.say("Hold'em: everyone starts with 💰" + this.BUYIN + '. Press New hand.');
  },
  onJoin(t, p) {
    const d = t.data;
    d.stacks ||= {};
    d.stacks[p] ??= this.BUYIN;
    this.badges(t);
    if (d.away && d.away[p]) { delete d.away[p]; t.tell(p, "You're back — still in the hand"); }
    else if (d.stage === 'hand' && (d.awayFolded || []).includes(p)) t.tell(p, 'You were folded: you left mid-hand');
  },
  // A player who still has to act would stall the hand, but phones drop
  // out all the time (a reload, a locked screen): fold them only if they're
  // still gone after AWAY seconds. An all-in player has nothing left to
  // decide and stays in to the showdown.
  onLeave(t, p) {
    const d = t.data;
    if (d.stage !== 'hand' || !this.active(t).some((x) => x.id === p)) return;
    d.awayN = (d.awayN || 0) + 1;
    d.away = Object.assign({}, d.away, { [p]: d.awayN }); // only this absence's timer may fold them
    t.schedule(this.AWAY, 'away:' + p + ':' + d.awayN);
    t.announce(this.nameOf(t, p) + ' disconnected — folding in ' + this.AWAY + ' s unless they return');
  },
  onTimer(t, tag) {
    const d = t.data, [kind, p, n] = tag.split(':');
    if (kind !== 'away' || !d.away || d.away[p] !== +n) return;
    delete d.away[p];
    if (d.stage !== 'hand' || !this.active(t).some((x) => x.id === p)) return;
    d.awayFolded = (d.awayFolded || []).concat(p);
    t.say(this.nameOf(t, p) + ' left mid-hand');
    if (d.turn === p) return this.doAction(t, p, 'fold');
    this.fold(t, p);
    t.say(this.nameOf(t, p) + ' folds');
    d.pending = d.pending.filter((x) => x !== p);
    if (this.contenders(t).length === 1) this.afterAction(t, p, false); // pays the last one standing
  },
  badges(t) {
    t.public.badges = Object.fromEntries(t.players().map((p) => [p.id, '💰' + (t.data.stacks[p.id] ?? 0)]));
  },
  nameOf(t, p) { return (t.players().find((x) => x.id === p) || {}).name || '?'; },
  // The game's deck: the biggest pile of one standard deck (not the muck,
  // and not another game's cards).
  deck(t) {
    const std = (p) => p.id !== t.data.muckId && p.cards.length && p.cards.every((c) => c.d === p.cards[0].d) && !!(t.card(p.cards[0]) || {}).rank;
    return t.piles().filter(std).sort((a, b) => b.cards.length - a.cards.length)[0];
  },
  // Cards of another deck than D leave the hands, onto a pile of their own.
  aside(t, D) {
    const g = t.geom();
    let id = null;
    for (const p of t.players()) {
      if (!t.hand(p.id).some((c) => c.d !== D)) continue;
      id = id || t.newPile([], { x: g.cx + 190, y: g.cy - 240, name: 'Set aside' });
      t.takeHand(p.id, id, (c) => c.d !== D);
    }
  },
  contenders(t) { return t.players().filter((p) => p.handCount === 2 && !t.data.folded.includes(p.id)); },
  active(t) { return this.contenders(t).filter((p) => t.data.stacks[p.id] > 0); },
  // The next player in list clockwise from p, by seat. Not t.nextSeat: that
  // skips offline players, and after a host reload everyone is offline until
  // they reconnect — the turn must wait for them, not vanish.
  nextFrom(t, p, list) {
    const ps = t.players(), i = ps.findIndex((x) => x.id === p);
    for (let k = 1; k <= ps.length; k++) {
      const q = ps[(i + k) % ps.length].id;
      if (list.some((x) => x.id === q)) return q;
    }
    return null;
  },
  put(t, p, amt) {
    const d = t.data;
    amt = Math.max(0, Math.min(amt, d.stacks[p]));
    d.stacks[p] -= amt;
    d.paid[p] = (d.paid[p] || 0) + amt;
    d.bet[p] = (d.bet[p] || 0) + amt;
    d.pot += amt;
    this.badges(t);
    return amt;
  },
  fold(t, p) {
    const d = t.data;
    d.folded.push(p);
    if (!t.items().some((x) => x.id === d.muckId)) {
      const g = t.geom();
      d.muckId = t.newPile([], { x: g.cx + 70, y: g.cy - 240, name: 'muck' });
    }
    t.takeHand(p, d.muckId);
  },
  /** Calls the hand off: every bet goes back to its owner. */
  abandon(t, msg) {
    const d = t.data;
    for (const [p, amt] of Object.entries(d.paid || {})) d.stacks[p] += amt;
    Object.assign(d, { stage: 'done', paid: {}, pot: 0, turn: null });
    t.public.turn = null;
    this.badges(t);
    t.say(msg);
  },
  buttons(t) {
    const d = t.data, p = d.turn;
    if (d.stage !== 'hand') { // deal; each busted player sees a Rebuy of their own
      return [{ id: 'new', label: '🂠 New hand' }].concat(t.players().filter((x) => !(d.stacks[x.id] > 0))
        .map((x) => ({ id: 'rebuy:' + x.id, label: '💰 Rebuy ' + this.BUYIN, pid: x.id })));
    }
    // Mid-hand only the host may call the hand off: the refund would let
    // anyone who is losing take their bets back instead of folding. It comes
    // last in the row and takes a second press (onButton): a mis-tap beside
    // Call must not undo the hand.
    const btns = [], abandon = { id: 'abandon', label: '🂠 Abandon hand (refund)', pid: t.hostId };
    if (!p) return [abandon];
    const owed = d.curBet - (d.bet[p] || 0), all = (d.bet[p] || 0) + d.stacks[p];
    btns.push(owed > 0 ? { id: 'call', label: 'Call ' + Math.min(owed, d.stacks[p]), pid: p } : { id: 'check', label: 'Check', pid: p },
      { id: 'fold', label: 'Fold', pid: p });
    if (all > d.curBet && d.canRaise.includes(p)) {
      // Quick raises, as round totals ("r:<total>"). A pot-sized raise is the
      // call plus the pot after calling. Sizes that aren't legal raises below
      // the stack are left out: the All-in button covers the rest.
      const pot = d.pot + owed;
      const sizes = [['Min raise', d.curBet + d.minRaise], ['½ pot', d.curBet + Math.floor(pot / 2)], ['Pot', d.curBet + pot]];
      for (const [name, to] of sizes) {
        if (to - d.curBet >= d.minRaise && to < all && !btns.some((b) => b.id === 'r:' + to)) btns.push({ id: 'r:' + to, label: name + ' → ' + to, pid: p });
      }
      btns.push({ id: 'allin', label: 'All-in → ' + all, pid: p });
    }
    return btns.concat(abandon);
  },
  onButton(t, id, byPid) {
    const d = t.data;
    if (id === 'new') return this.startHand(t, byPid);
    if (id === 'abandon') {
      if (Date.now() - (d.abandonArm || 0) > 4000) {
        d.abandonArm = Date.now();
        return t.tell(byPid, 'Press Abandon again to call the hand off (every bet is refunded)');
      }
      d.abandonArm = 0;
      return this.startHand(t, byPid);
    }
    if (id.startsWith('rebuy:')) return this.rebuy(t, byPid);
    if (id.startsWith('r:')) return this.doAction(t, byPid, 'bet', +id.slice(2));
    this.doAction(t, byPid, id);
  },
  onChat(t, msg, p) {
    const d = t.data;
    let m;
    if ((m = /^!(check|call|fold|allin)$/i.exec(msg))) return this.doAction(t, p, m[1].toLowerCase());
    if ((m = /^!(?:bet|raise)\\s+(\\d+)$/i.exec(msg))) return this.doAction(t, p, 'bet', +m[1]);
    if (/^!rebuy$/i.test(msg)) return this.rebuy(t, p);
    if ((m = /^!blinds\\s+(\\d+)\\s+(\\d+)$/i.exec(msg))) {
      if (p !== t.hostId) return t.tell(p, 'Only the host sets the blinds');
      if (d.stage === 'hand') return t.tell(p, 'After this hand');
      const sb = +m[1], bb = +m[2];
      if (!(sb > 0 && sb <= bb)) return t.tell(p, 'Use !blinds SB BB with 0 < SB ≤ BB');
      d.blinds = { sb, bb };
      return t.say('Blinds set to ' + sb + '/' + bb);
    }
  },
  rebuy(t, p) {
    const d = t.data;
    if (d.stage === 'hand') return t.tell(p, 'Rebuy after this hand');
    if ((d.stacks[p] || 0) > 0) return t.tell(p, 'Rebuy is only for a busted (0-chip) stack');
    d.stacks[p] = this.BUYIN;
    this.badges(t);
    t.say(this.nameOf(t, p) + ' rebuys for ' + this.BUYIN);
  },
  // by: who pressed (refusals go to them — the log is hidden on phones)
  startHand(t, by) {
    const d = t.data, deckP = this.deck(t), g = t.geom();
    if (d.stage === 'hand') this.abandon(t, 'Hand abandoned — bets refunded.');
    if (!deckP) return t.tell(by, 'No deck on the table!');
    const funded = t.players().filter((p) => p.online && (d.stacks[p.id] || 0) > 0);
    if (funded.length < 2) return t.tell(by, 'Need 2+ online players with chips (a busted player presses 💰 Rebuy)');
    // Gather this deck (D) only: its loose cards (face down — a face-up
    // card would show on the deck's top), its other piles (the muck), the hands.
    const D = deckP.cards[0].d, ours = (c) => c.d === D;
    for (const it of t.items()) if (it.k === 'c' && ours(it)) { if (it.up) t.flip(it.id); t.toPile(it.id, deckP.id); }
    for (const p of t.piles()) if (p.id !== deckP.id && p.cards.every(ours)) t.merge(p.id, deckP.id);
    this.aside(t, D);
    for (const p of t.players()) t.takeHand(p.id, deckP.id);
    t.shuffle(deckP.id);
    // Layout: burns | deck | muck in a row above the board row through the
    // center — all clear of the hole cards revealed by the seats.
    t.move(deckP.id, g.cx - 50, g.cy - 240);
    for (const p of funded) { t.deal(deckP.id, { to: p.id }); t.deal(deckP.id, { to: p.id }); }
    Object.assign(d, { stage: 'hand', comm: [], burn: [], folded: [], muckId: null, paid: {}, bet: {}, pot: 0, away: {}, awayFolded: [], abandonArm: 0 });
    t.public.winners = null;
    d.dealer = d.dealer && funded.some((x) => x.id !== d.dealer) ? this.nextFrom(t, d.dealer, funded) : funded[0].id;
    const sb = funded.length === 2 ? d.dealer : this.nextFrom(t, d.dealer, funded);
    const bb = this.nextFrom(t, sb, funded);
    this.put(t, sb, d.blinds.sb);
    this.put(t, bb, d.blinds.bb);
    d.curBet = d.blinds.bb;
    d.minRaise = d.blinds.bb;
    const act = this.active(t);
    d.pending = act.map((x) => x.id);
    d.canRaise = [...d.pending]; // who may still raise this round (see afterAction)
    d.turn = this.nextFrom(t, bb, act);
    t.public.turn = d.turn;
    t.announce('New hand — blinds ' + d.blinds.sb + '/' + d.blinds.bb + ' (' + this.nameOf(t, sb) + '/' + this.nameOf(t, bb) + ')'
      + (d.turn ? ', ' + this.nameOf(t, d.turn) + ' to act' : ''));
    if (!d.turn) this.nextStreet(t); // everyone dealt in is all-in from the blinds: run it out
  },
  doAction(t, p, kind, amt) {
    const d = t.data;
    if (d.stage !== 'hand' || !d.turn) return t.tell(p, 'No betting right now');
    if (p !== d.turn) return t.tell(p, 'Not your turn');
    const name = this.nameOf(t, p);
    const owed = d.curBet - (d.bet[p] || 0);
    const closed = () => t.tell(p, 'Betting was not reopened — call or fold');
    if (kind === 'check') {
      if (owed > 0) return t.tell(p, 'You must call ' + owed + ' (or raise / fold)');
      t.say(name + ' checks');
    } else if (kind === 'call') {
      if (owed <= 0) return this.doAction(t, p, 'check');
      const paid = this.put(t, p, owed);
      t.say(name + ' calls ' + paid + (d.stacks[p] === 0 ? ' (all-in)' : ''));
    } else if (kind === 'fold') {
      this.fold(t, p);
      t.say(name + ' folds');
    } else if (kind === 'bet') {
      if (!(amt > 0)) return t.tell(p, 'Say "!bet 50" (the round total to raise to)');
      const maxTotal = (d.bet[p] || 0) + d.stacks[p];
      if (amt >= maxTotal) return this.doAction(t, p, 'allin');
      if (!d.canRaise.includes(p)) return closed();
      const delta = amt - d.curBet;
      if (delta < d.minRaise) return t.tell(p, 'Min raise to ' + (d.curBet + d.minRaise));
      this.put(t, p, amt - (d.bet[p] || 0));
      d.minRaise = delta;
      d.curBet = amt;
      t.say(name + ' raises to ' + amt);
      return this.afterAction(t, p, true, true);
    } else if (kind === 'allin') {
      const total = (d.bet[p] || 0) + d.stacks[p];
      if (total <= 0) return t.tell(p, 'No chips left — "!rebuy" after the hand');
      const raised = total > d.curBet, full = total - d.curBet >= d.minRaise;
      if (raised && !d.canRaise.includes(p)) return closed();
      this.put(t, p, d.stacks[p]);
      if (raised) { if (full) d.minRaise = total - d.curBet; d.curBet = total; }
      t.say(name + ' is ALL-IN for ' + total);
      return this.afterAction(t, p, raised, full);
    }
    this.afterAction(t, p, false);
  },
  // raised: everyone else must respond again. reopen: a full raise, so they
  // may also re-raise — a short all-in only raises the price (TDA rules).
  afterAction(t, p, raised, reopen) {
    const d = t.data, others = () => this.active(t).map((x) => x.id).filter((id) => id !== p);
    d.pending = raised ? others() : d.pending.filter((id) => id !== p);
    d.canRaise = reopen ? others() : d.canRaise.filter((id) => id !== p);
    const live = this.contenders(t);
    if (live.length === 1) {
      d.stacks[live[0].id] += d.pot;
      this.badges(t);
      d.stage = 'done';
      d.turn = null;
      t.public.turn = null;
      return t.win([live[0].id], live[0].name + ' takes the pot (' + d.pot + ') — everyone else folded');
    }
    if (!d.pending.length) return this.nextStreet(t);
    const waiting = this.active(t).filter((x) => d.pending.includes(x.id));
    d.turn = this.nextFrom(t, p, waiting);
    t.public.turn = d.turn;
  },
  nextStreet(t) {
    const d = t.data, g = t.geom(), deckP = this.deck(t);
    d.bet = {};
    d.curBet = 0;
    d.minRaise = d.blinds.bb;
    d.turn = null;
    t.public.turn = null;
    if (d.comm.length === 5) return this.showdown(t);
    if (!deckP) return this.abandon(t, 'The deck is gone — hand abandoned, bets refunded');
    const burn = t.deal(deckP.id, { x: g.cx - 170, y: g.cy - 240, up: false });
    if (burn) d.burn.push(burn.id);
    const n = d.comm.length === 0 ? 3 : 1;
    for (let i = 0; i < n; i++) { // the board: one row through the center
      const c = t.deal(deckP.id, { x: g.cx - 280 + d.comm.length * 115, y: g.cy - 70, up: true });
      if (c) d.comm.push({ d: c.d, i: c.i });
    }
    t.announce((n === 3 ? 'Flop' : d.comm.length === 4 ? 'Turn' : 'River') + ' — pot ' + d.pot);
    const act = this.active(t);
    if (act.length <= 1) return this.nextStreet(t); // all-in run-out
    d.pending = act.map((x) => x.id);
    d.canRaise = [...d.pending];
    d.turn = this.nextFrom(t, d.dealer, act);
    t.public.turn = d.turn;
  },
  // --- hand evaluation (best 5 of 7) ---
  HANDS: ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'],
  parsed(t, ref) {
    const n = t.cardName(ref), r = n.slice(0, -1);
    return { v: { A: 14, K: 13, Q: 12, J: 11 }[r] || parseInt(r, 10) || 0, s: n.slice(-1) };
  },
  score5(cs) {
    const vs = cs.map((c) => c.v).sort((a, b) => b - a);
    const flush = cs.every((c) => c.s === cs[0].s);
    const u = [...new Set(vs)];
    let straight = 0;
    if (u.length === 5) {
      if (u[0] - u[4] === 4) straight = u[0];
      else if (u[0] === 14 && u[1] === 5 && u[4] === 2) straight = 5; // the wheel
    }
    const cnt = {};
    for (const v of vs) cnt[v] = (cnt[v] || 0) + 1;
    const groups = Object.entries(cnt).map(([v, c]) => [+v, c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const kick = groups.flatMap(([v, c]) => Array(c).fill(v));
    if (flush && straight) return [8, straight];
    if (groups[0][1] === 4) return [7, ...kick];
    if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...kick];
    if (flush) return [5, ...vs];
    if (straight) return [4, straight];
    if (groups[0][1] === 3) return [3, ...kick];
    if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...kick];
    if (groups[0][1] === 2) return [1, ...kick];
    return [0, ...vs];
  },
  cmp(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  },
  best7(t, refs) {
    const cs = refs.map((r) => this.parsed(t, r));
    let best = null;
    for (let i = 0; i < 7; i++) {
      for (let j = i + 1; j < 7; j++) {
        const s = this.score5(cs.filter((_, k) => k !== i && k !== j));
        if (!best || this.cmp(s, best) > 0) best = s;
      }
    }
    return best;
  },
  /** Main + side pots from per-player contributions. Pure data -> data. */
  buildPots(paid, contenderIds) {
    const lvls = [...new Set(contenderIds.map((p) => paid[p] || 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of lvls) {
      let amt = 0;
      for (const v of Object.values(paid)) amt += Math.max(0, Math.min(v, lvl) - prev);
      const elig = contenderIds.filter((p) => (paid[p] || 0) >= lvl);
      if (amt > 0) pots.push({ amt, elig });
      prev = lvl;
    }
    return pots;
  },
  showdown(t) {
    const d = t.data, g = t.geom();
    // An uncalled bet (the top contributor's excess over everyone else) is
    // simply returned — it isn't a pot anyone won.
    const [top, second] = Object.keys(d.paid).sort((a, b) => d.paid[b] - d.paid[a]);
    const uncalled = d.paid[top] - (d.paid[second] || 0);
    if (uncalled > 0) {
      d.paid[top] -= uncalled;
      d.stacks[top] += uncalled;
      d.pot -= uncalled;
      t.say('Uncalled ' + uncalled + ' returned to ' + this.nameOf(t, top));
    }
    const players = this.contenders(t);
    const scores = {};
    for (const p of players) {
      const hole = t.hand(p.id);
      // reveal by the seat, outside the board row
      const rad = (p.seat * Math.PI) / 180, tx = -Math.sin(rad), ty = Math.cos(rad);
      for (let k = t.hand(p.id).length - 1; k >= 0; k--) {
        t.playFromHand(p.id, k, {
          x: g.cx + Math.cos(rad) * (g.r - 130) + tx * (k * 72 - 36) - 50,
          y: g.cy + Math.sin(rad) * (g.r - 130) + ty * (k * 72 - 36) - 70,
          up: true, rot: ((p.seat - 90) % 360 + 360) % 360,
        });
      }
      scores[p.id] = this.best7(t, hole.concat(d.comm));
    }
    const pots = this.buildPots(d.paid, players.map((p) => p.id));
    const total = pots.reduce((s, x) => s + x.amt, 0);
    if (total < d.pot && pots.length) pots[pots.length - 1].amt += d.pot - total;
    // odd chips go to the first tied players left of the button
    const ids = t.players().map((p) => p.id), n = ids.length, di = ids.indexOf(d.dealer);
    const leftOfButton = (p) => (ids.indexOf(p) - di - 1 + n) % n;
    const winnersAll = new Set(), parts = [];
    pots.forEach((pot, i) => {
      let best = pot.elig[0];
      for (const p of pot.elig) if (this.cmp(scores[p], scores[best]) > 0) best = p;
      const tied = pot.elig.filter((p) => this.cmp(scores[p], scores[best]) === 0).sort((a, b) => leftOfButton(a) - leftOfButton(b));
      const share = Math.floor(pot.amt / tied.length);
      let odd = pot.amt - share * tied.length;
      for (const p of tied) { d.stacks[p] += share + (odd-- > 0 ? 1 : 0); winnersAll.add(p); }
      const names = tied.map((p) => this.nameOf(t, p)).join(' & ');
      parts.push(names + (tied.length > 1 ? ' split ' : ' wins ') + pot.amt
        + (pots.length > 1 ? (i === 0 ? ' (main)' : ' (side)') : '') + ' with ' + this.HANDS[scores[best][0]]);
    });
    this.badges(t);
    for (const p of players) if (d.stacks[p.id] === 0) t.tell(p.id, 'You are out of chips — press 💰 Rebuy to play on');
    d.stage = 'done';
    d.turn = null;
    t.public.turn = null;
    t.win([...winnersAll], parts.join(' · '));
  },
  validate(t, a) {
    const d = t.data;
    if (d.stage !== 'hand') {
      if (a.t === 'draw' || a.t === 'deal') return 'Use the New hand button';
      return;
    }
    if (['play', 'handPile', 'toHand', 'draw', 'deal', 'addDeck'].includes(a.t)) {
      return 'Hand in progress — act with the buttons or chat (!bet, !fold, ...)';
    }
    // The deck and the muck (folded hole cards) stay closed, the board and
    // burn cards stay where they are: none of them may be peeked at,
    // deleted, merged, shuffled, flipped or stacked mid-hand.
    const deckId = this.deck(t)?.id;
    const guarded = (id) => {
      if (!id) return false;
      if (id === deckId || id === d.muckId || d.burn.includes(id)) return true;
      const it = t.items().find((x) => x.id === id);
      return it && it.k === 'c' && d.comm.some((c) => c.d === it.d && c.i === it.i);
    };
    if (['del', 'merge', 'toPile', 'stack', 'shuffle', 'flip', 'peek'].includes(a.t) && [a.id, a.pile, a.onto].some(guarded)) {
      return 'The deck, muck and board stay put during a hand';
    }
  },
})`,
  bridge: `({
  name: 'Bridge',
  // Full flow: Deal -> AUCTION IN CHAT -> play. Bidding commands (in turn,
  // dealer first, rotating each deal): "!bid 1H" (or "!1H"; strains C D H S NT),
  // "!pass", "!double", "!redouble". Three passes after a bid fix the
  // contract (declarer = first of the winning side to name the strain);
  // four passes throw the hand in. "!contract 4H <name>" (the dealer or the
  // host, during the auction) skips it if you bid out loud instead. The four
  // players online at Deal play the hand in fixed seat order; if one drops,
  // play waits for them. Then: left of declarer leads, the dummy is
  // laid face up and played by the DECLARER (slide a dummy card to an empty
  // spot in the middle), turns and following suit are enforced, tricks are
  // resolved trump-aware and swept, and the winning side takes the trophy.
  STRAINS: ['C', 'D', 'H', 'S', 'NT'],
  SYMS: { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT' },
  setup(t) {
    const n = t.players().filter((p) => p.online).length;
    t.say(n === 4 ? 'Bridge: press Deal, then bid in chat ("!bid 1H", "!pass", ...).' : this.needFour(n));
  },
  // Everyone online holds a seat, so extras must leave before the deal.
  needFour: (n) => n < 4
    ? 'Bridge deals to exactly 4 online players (' + n + ' online) — waiting for ' + (4 - n) + ' more.'
    : 'Bridge deals to exactly 4 online players (' + n + ' online) — extra players must leave before the deal; anyone who joins later watches.',
  buttons: (t) => (t.data.phase === 'play' || t.data.phase === 'bid' ? [] : [{ id: 'deal', label: '🂠 Deal (13 each)' }]),
  deck(t) { return t.piles().sort((a, b) => b.cards.length - a.cards.length)[0]; },
  suitOf(t, c) { return t.cardName(c).slice(-1); },
  rankOf(t, c) {
    const r = t.cardName(c).slice(0, -1);
    return { A: 14, K: 13, Q: 12, J: 11 }[r] || parseInt(r, 10) || 0;
  },
  // The four dealt players, frozen at Deal in seat order: partnerships and
  // turns never shift when someone joins, leaves or drops (t.nextSeat would
  // skip an offline player — here the turn waits for them instead).
  seats(t) { return t.data.seats || t.players().filter((p) => p.online).map((p) => p.id); },
  nextP(t, p) { const s = this.seats(t); return s[(s.indexOf(p) + 1) % s.length]; },
  sideOf(t, p) { return this.seats(t).indexOf(p) % 2; },
  sideName(t, s) { const q = this.seats(t); return this.nameOf(t, q[s]) + '–' + this.nameOf(t, q[s + 2]); },
  sidePids(t, s) { return this.seats(t).filter((_, i) => i % 2 === s); },
  nameOf(t, p) { return (t.players().find((x) => x.id === p) || {}).name || '?'; },
  inCenter(t, x, y) { const g = t.geom(); return Math.hypot(x + 50 - g.cx, y + 70 - g.cy) < g.r * 0.4; },
  dummyRef(t, id) {
    const it = t.items().find((x) => x.id === id);
    return it && it.k === 'c' && (t.data.dummyCards || []).find((c) => c.d === it.d && c.i === it.i);
  },
  // by: who pressed Deal (a refusal tells them — phones hide the log)
  onButton(t, id, by) {
    if (id !== 'deal') return;
    if (t.data.phase === 'play' || t.data.phase === 'bid') return t.tell(by, 'Finish the hand first.');
    const ps = t.players().filter((p) => p.online);
    if (ps.length !== 4) return t.announce(this.needFour(ps.length));
    // This game's deck: the one dealt last time while any of it is still
    // around (after a passed-out hand it is all in the hands, with no pile
    // left), else the biggest pile. Other decks' cards and piles stay put.
    const has = (D) => D != null && (t.items().some((it) => it.d === D || (it.cards || []).some((c) => c.d === D))
      || t.players().some((p) => t.hand(p.id).some((c) => c.d === D)));
    const D = has(t.data.deckD) ? t.data.deckD : this.deck(t)?.cards[0].d;
    if (D == null) return t.tell(by, 'No deck on the table!');
    const ours = (p) => p.cards.every((c) => c.d === D);
    const g = t.geom(), mine = t.piles().filter(ours).sort((a, b) => b.cards.length - a.cards.length)[0];
    const deckId = mine ? mine.id : t.newPile([], { x: g.cx - 50, y: g.cy - 70, name: 'Deck' });
    // gather all 52: loose cards, both sides' trick piles, stray stacks, every
    // hand — after another deck's cards in a hand went onto a pile of their own
    for (const it of t.items()) if (it.k === 'c' && it.d === D) t.toPile(it.id, deckId);
    for (const p of t.piles()) if (p.id !== deckId && ours(p)) t.merge(p.id, deckId);
    let aside = null;
    for (const p of t.players()) {
      if (!t.hand(p.id).some((c) => c.d !== D)) continue;
      aside = aside || t.newPile([], { x: g.cx + 250, y: g.cy - 390, name: 'Set aside' });
      t.takeHand(p.id, aside, (c) => c.d !== D);
    }
    for (const p of t.players()) t.takeHand(p.id, deckId);
    if (!t.piles().find((p) => p.id === deckId).cards.length) { t.remove(deckId); return t.tell(by, 'No deck on the table!'); }
    t.data.deckD = D;
    t.shuffle(deckId);
    t.dealToAll(deckId, 13);
    const dealerIdx = ((t.data.dealerIdx ?? -1) + 1) % 4; // rotates every deal
    Object.assign(t.data, {
      phase: 'bid', dealerIdx, trump: null, level: null, declarer: null, dummy: null,
      trick: [], tricks: [0, 0], sidePiles: {}, firstLead: false, dummyCards: [],
      auction: { passes: 0, best: null, first: {}, dbl: '' }, away: [],
      seats: ps.map((p) => p.id), // dealToAll dealt exactly these four
    });
    t.data.turn = this.seats(t)[dealerIdx];
    t.public = { turn: t.data.turn };
    t.say('Dealt 13 to each (' + this.sideName(t, 0) + ' vs ' + this.sideName(t, 1) + ').');
    t.announce('Auction: ' + this.nameOf(t, t.data.turn) + ' bids first — "!bid 1H", "!pass", ...');
  },
  onChat(t, msg, p) {
    if (t.data.phase === 'bid') return this.onBid(t, msg.trim(), p);
    if (/^!contract\\b/i.test(msg.trim())) t.tell(p, '!contract works during the auction, after Deal');
  },
  // Manual override for tables that bid out loud: "!contract 4H Alice" —
  // during the auction only, by the dealer or the host.
  contract(t, msg, p) {
    const dealer = this.seats(t)[t.data.dealerIdx];
    if (p !== dealer && !t.players().some((x) => x.id === p && x.host)) {
      return t.tell(p, 'Only the dealer (' + this.nameOf(t, dealer) + ') or the host can set the contract');
    }
    const m = /^!contract\\s*([1-7])?\\s*(NT|[SHDC])\\s+(.+)$/i.exec(msg);
    if (!m) return t.tell(p, 'Usage: !contract 4H <declarer>');
    const name = m[3].trim().toLowerCase();
    const decl = this.seats(t).find((id) => this.nameOf(t, id).toLowerCase().startsWith(name));
    if (!decl) return t.tell(p, 'Nobody named "' + m[3].trim() + '" plays this hand');
    this.startPlay(t, m[1] ? +m[1] : null, m[2].toUpperCase(), decl, '');
  },
  onBid(t, msg, p) {
    const a = t.data.auction;
    const bid = /^!(?:bid\\s+)?([1-7])\\s*(NT|[SHDC])$/i.exec(msg);
    const pass = /^!p(?:ass)?$/i.exec(msg);
    const dbl = /^!double$/i.exec(msg) || /^!x$/i.exec(msg);
    const rdbl = /^!redouble$/i.exec(msg) || /^!xx$/i.exec(msg);
    if (/^!contract\\b/i.test(msg)) return this.contract(t, msg, p);
    if (!bid && !pass && !dbl && !rdbl) return; // ordinary chatter
    if (p !== t.data.turn) return t.tell(p, "It's not your turn to bid");
    const side = this.sideOf(t, p);
    if (bid) {
      const level = +bid[1], s = this.STRAINS.indexOf(bid[2].toUpperCase());
      const b = a.best;
      if (b && (level < b.level || (level === b.level && s <= b.s))) {
        return t.tell(p, 'Insufficient — you must outbid ' + b.level + this.SYMS[this.STRAINS[b.s]]);
      }
      a.best = { level, s, side, by: p };
      a.first[side + ':' + s] ??= p;
      a.passes = 0;
      a.dbl = '';
      t.say(this.nameOf(t, p) + ' bids ' + level + this.SYMS[this.STRAINS[s]]);
    } else if (dbl) {
      if (!a.best || a.best.side === side || a.dbl) return t.tell(p, 'Nothing to double');
      a.dbl = 'X';
      a.passes = 0;
      t.say(this.nameOf(t, p) + ' doubles');
    } else if (rdbl) {
      if (a.dbl !== 'X' || !a.best || a.best.side !== side) return t.tell(p, 'Nothing to redouble');
      a.dbl = 'XX';
      a.passes = 0;
      t.say(this.nameOf(t, p) + ' redoubles');
    } else {
      a.passes++;
      t.say(this.nameOf(t, p) + ' passes');
    }
    if (a.best && a.passes === 3) {
      const declarer = a.first[a.best.side + ':' + a.best.s] || a.best.by;
      return this.startPlay(t, a.best.level, this.STRAINS[a.best.s], declarer, a.dbl);
    }
    if (!a.best && a.passes === 4) {
      t.data.phase = 'done';
      t.public.turn = null;
      return t.announce('Passed out — press Deal for a new hand');
    }
    t.data.turn = this.nextP(t, p);
    t.public.turn = t.data.turn;
  },
  // Whose move the table waits on (⏳, the your-turn cue): the DECLARER
  // plays the dummy's cards. (data.turn stays the seat whose card is due.)
  pubTurn(t) { const d = t.data; t.public.turn = d.turn && d.turn === d.dummy ? d.declarer : d.turn; },
  startPlay(t, level, strain, declarer, dbl) {
    const s = this.seats(t);
    t.data.level = level;
    t.data.trump = strain === 'NT' ? null : this.SYMS[strain];
    t.data.declarer = declarer;
    t.data.dummy = s[(s.indexOf(declarer) + 2) % 4];
    t.data.phase = 'play';
    t.data.firstLead = true;
    t.data.trick = [];
    t.data.turn = this.nextP(t, declarer);
    this.pubTurn(t);
    t.public.badges = { [t.data.dummy]: '🃏 dummy' }; // the dummy's seat, once ⏳ no longer lands on it
    t.announce('Contract: ' + (level || '') + this.SYMS[strain] + (dbl ? ' ' + dbl : '') + ' by '
      + this.nameOf(t, declarer) + ' — ' + this.nameOf(t, t.data.turn) + ' leads');
  },
  // Lays the dummy's whole hand face up in two sorted rows by their seat,
  // oriented to face them; the declarer plays these by sliding to the middle.
  showDummy(t) {
    const dummy = t.players().find((p) => p.id === t.data.dummy);
    if (!dummy) return;
    const order = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
    const refs = t.hand(dummy.id).sort((a, b) =>
      (order[this.suitOf(t, a)] - order[this.suitOf(t, b)]) || (this.rankOf(t, b) - this.rankOf(t, a)));
    t.data.dummyCards = refs.map((c) => ({ d: c.d, i: c.i }));
    const g = t.geom(), rad = (dummy.seat * Math.PI) / 180;
    const tx = -Math.sin(rad), ty = Math.cos(rad); // tangent along the rim
    const rot = ((dummy.seat - 90) % 360 + 360) % 360; // upright for the dummy
    refs.forEach((c, k) => {
      const row = k < 7 ? 0 : 1, off = ((k < 7 ? k : k - 7) - 3) * 68;
      const rr = g.r - 260 + row * 155; // both rows clear of the r*0.4 'played' center zone
      const idx = t.hand(dummy.id).findIndex((h) => h.d === c.d && h.i === c.i);
      t.playFromHand(dummy.id, idx, {
        x: g.cx + Math.cos(rad) * rr + tx * off - 50,
        y: g.cy + Math.sin(rad) * rr + ty * off - 70,
        up: true, rot,
      });
    });
    t.say('Dummy (' + dummy.name + ') is on the table — the DECLARER slides dummy cards to an empty spot in the middle to play them.');
  },
  validate(t, a) {
    if (t.data.phase === 'bid') {
      // While bidding, all 52 cards stay where they are — hands in hands.
      if (['play', 'handPile', 'draw', 'deal', 'toHand', 'flip', 'addDeck'].includes(a.t)) {
        return 'Bidding — cards stay in hand ("!bid 1H", "!pass", ...)';
      }
      return;
    }
    if (t.data.phase !== 'play') {
      if (a.t === 'draw' || a.t === 'deal') return 'Use the Deal button';
      return;
    }
    if (['draw', 'deal', 'handPile', 'toHand', 'addDeck'].includes(a.t)) return 'The hand is in progress';
    // cards of the current trick must stay loose so the sweep can collect them
    const inTrick = (id) => {
      const it = t.items().find((x) => x.id === id);
      return it && it.k === 'c' && t.data.trick.some((c) => c.d === it.d && c.i === it.i);
    };
    if (['toPile', 'stack', 'del', 'flip'].includes(a.t) && ((a.id && inTrick(a.id)) || (a.onto && inTrick(a.onto)))) {
      return 'Those cards are mid-trick';
    }
    // the dummy's exposed cards: only the declarer touches them
    if (a.id && ['toPile', 'stack', 'del', 'flip'].includes(a.t) && this.dummyRef(t, a.id)) {
      return 'Slide dummy cards to an EMPTY spot in the middle to play them';
    }
    if (a.t === 'move' && a.id && this.dummyRef(t, a.id)) {
      if (a.p !== t.data.declarer) return 'Only the declarer plays the dummy';
      if (this.inCenter(t, a.x, a.y)) {
        if (t.data.turn !== t.data.dummy) return "Not dummy's turn yet";
        const it = t.items().find((x) => x.id === a.id);
        const led = t.data.trick[0] && this.suitOf(t, t.data.trick[0]);
        if (led && this.suitOf(t, it) !== led && (t.data.dummyCards || []).some((c) => this.suitOf(t, c) === led)) {
          return 'Dummy must follow ' + led;
        }
      }
      return;
    }
    if (a.t !== 'play') return; // arranging the table is otherwise free
    if (a.p !== t.data.turn) {
      return a.p === t.data.declarer && t.data.turn === t.data.dummy
        ? "Dummy's turn: slide one of the dummy's cards to the middle" : "It's not your turn";
    }
    if (!a.up) return 'Play your card face up';
    const led = t.data.trick[0] && this.suitOf(t, t.data.trick[0]);
    if (led && this.suitOf(t, a) !== led && t.hand(a.p).some((c) => this.suitOf(t, c) === led)) {
      return 'You must follow ' + led;
    }
  },
  recordPlay(t, card) {
    if (t.data.firstLead) { t.data.firstLead = false; this.showDummy(t); }
    t.data.trick.push(card);
    if (t.data.trick.length === 4) {
      t.data.turn = t.public.turn = null; // nobody plays until the sweep
      t.schedule(2.5, 'sweep'); // let everyone look at the trick first
    } else {
      t.data.turn = this.nextP(t, card.p);
      this.pubTurn(t);
    }
  },
  onAction(t, a) {
    if (t.data.phase !== 'play') return;
    if (a.t === 'play') return this.recordPlay(t, { p: a.p, d: a.d, i: a.i });
    // declarer sliding a dummy card into the middle = the dummy's play
    if (a.t === 'move' && a.p === t.data.declarer && t.data.turn === t.data.dummy) {
      const ref = this.dummyRef(t, a.id);
      const it = ref && t.items().find((x) => x.id === a.id);
      if (ref && this.inCenter(t, it.x, it.y)) {
        t.data.dummyCards = t.data.dummyCards.filter((c) => c !== ref);
        this.recordPlay(t, { p: t.data.dummy, d: ref.d, i: ref.i });
      }
    }
  },
  onTimer(t, tag) {
    if (tag !== 'sweep' || t.data.trick.length !== 4) return;
    const trick = t.data.trick;
    let win = trick[0];
    for (const c of trick.slice(1)) {
      const s = this.suitOf(t, c), ws = this.suitOf(t, win), tr = t.data.trump;
      if ((s === ws && this.rankOf(t, c) > this.rankOf(t, win)) || (tr && s === tr && ws !== tr)) win = c;
    }
    const side = this.sideOf(t, win.p);
    t.data.tricks[side]++;
    const winner = t.players().find((p) => p.id === win.p);
    // sweep the four cards into the winning side's face-down trick pile
    let pileId = t.data.sidePiles[side];
    if (!pileId || !t.items().some((it) => it.id === pileId)) {
      // by a hand-holding seat: the dummy's seat is covered by its cards
      const by = side === this.sideOf(t, t.data.declarer) ? t.data.declarer : win.p;
      const g = t.geom(), rad = (t.players().find((p) => p.id === by).seat * Math.PI) / 180;
      pileId = t.newPile([], { x: g.cx + Math.cos(rad) * (g.r - 40) - 50, y: g.cy + Math.sin(rad) * (g.r - 40) - 70, name: this.sideName(t, side) + ' tricks' });
      t.data.sidePiles[side] = pileId;
    }
    for (const it of t.items()) {
      if (it.k === 'c' && trick.some((c) => c.d === it.d && c.i === it.i)) { t.flip(it.id); t.toPile(it.id, pileId); }
    }
    t.data.trick = [];
    t.say('Trick to ' + winner.name + ' — ' + this.sideName(t, 0) + ' ' + t.data.tricks[0] + ' : ' + t.data.tricks[1] + ' ' + this.sideName(t, 1));
    if (t.data.tricks[0] + t.data.tricks[1] === 13) {
      const dSide = this.sideOf(t, t.data.declarer);
      const made = t.data.tricks[dSide];
      const target = t.data.level ? 6 + t.data.level : null;
      const success = target === null || made >= target;
      const winSide = success ? dSide : 1 - dSide;
      let msg = this.sideName(t, winSide) + ' win — declarer took ' + made + ' tricks';
      if (target) msg += success ? ' (contract MADE)' : ' (DOWN ' + (target - made) + ')';
      t.win(this.sidePids(t, winSide), msg + ' 🏆');
      t.data.phase = 'done';
      t.public.turn = null;
    } else {
      t.data.turn = win.p;
      this.pubTurn(t);
    }
  },
  // A dealt player who drops keeps their seat: their turn waits for them.
  onLeave(t, p) {
    const d = t.data;
    if ((d.phase !== 'bid' && d.phase !== 'play') || !this.seats(t).includes(p)) return;
    if (d.phase === 'play' && p === d.dummy) return; // the declarer plays the dummy
    d.away = (d.away || []).concat(p);
    t.announce(this.nameOf(t, p) + ' dropped out — the hand waits for them to rejoin');
  },
  onJoin(t, p) {
    const d = t.data;
    if (!(d.away || []).includes(p)) return;
    d.away = d.away.filter((x) => x !== p);
    t.say(this.nameOf(t, p) + ' is back — play on');
  },
})`,
  cah: `({
  name: 'Cards Against Humanity',
  // The printed rules, automated. Everyone holds 10 white cards. Each round
  // the Card Czar (👑) flips a black prompt; everyone else answers it (⏳) by
  // playing the required number of white cards from their hand (they go
  // FACE DOWN into the Answers pile — the 🂠 toggle locks on — or drop them
  // straight onto it). Once everyone has answered, the answers come out of
  // the pile in shuffled, numbered columns, upright for the Czar, who
  // presses 👉 1/2/3… to crown the funniest — the winner takes an Awesome
  // Point (⭐), the result stays up for a few seconds, everyone draws back to
  // 10, and the Czar rotates. First to the goal wins (the host's "!goal N"
  // changes it, default 5). The Czar can press "Judge now" to skip
  // stragglers; anyone can press "Skip Czar" while the Czar is away. PICK 2
  // prompts take two cards (in the order you play them); PICK 3 prompts deal
  // everyone 2 extra first. Another game's cards in a hand are set aside.
  // Card texts load from cah-cards.js (CC BY-NC-SA, Cards Against Humanity
  // LLC). Only the draw piles sit on the table; the rest of the ~1300-card
  // deck waits in script state to keep the shared state small.
  HAND: 10,
  CHUNK: 40,
  COLS: 30, // column markers #1..#30; card COLS of the marker deck is the 🏆
  setup(t) {
    if (!window.CAH_CARDS) throw new Error('cah-cards.js is missing');
    const d = t.data;
    d.goal = d.goal || 5;
    d.scores = d.scores || {};
    if (!d.wd) {
      d.wd = t.newDeck({ name: 'CAH White', back: '#f1f5f9',
        cards: window.CAH_CARDS.white.map((s) => ({ text: s })) });
      d.bd = t.newDeck({ name: 'CAH Black', back: '#0a0a0a',
        cards: window.CAH_CARDS.black.map((c) => ({ text: c[0], bg: '#0a0a0a', meta: { pick: c[1] } })) });
      d.wleft = this.shuf(window.CAH_CARDS.white.map((s, i) => i));
      d.bleft = this.shuf(window.CAH_CARDS.black.map((c, i) => i));
      d.wdisc = []; d.bdisc = [];
    }
    d.nd ||= t.newDeck({ name: 'CAH columns', back: '#fde047',
      cards: Array.from({ length: this.COLS }, (_, k) => ({ name: '#' + (k + 1), bg: '#fde047' }))
        .concat({ name: '🏆 Winner', bg: '#22c55e' }) });
    if (t.players().length < 3) t.say('CAH plays best with 3+ players — you can still try it.');
    if (!this.online(t, d.czar)) d.czar = (t.players().find((p) => p.online) || t.players()[0]).id;
    // another game's cards (another deck) leave the hands: refill counts only answers
    let aside = null;
    for (const p of t.players()) {
      if (!t.hand(p.id).some((c) => c.d !== d.wd)) continue;
      aside = aside || t.newPile([], { ...this.at(t, 340, 0), name: 'Set aside' });
      t.takeHand(p.id, aside, (c) => c.d !== d.wd);
    }
    // setup re-runs on every Enable: a game in progress restarts its round
    if (d.phase !== 'over') { this.clearRound(t); this.startRound(t); }
  },
  shuf(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; } return a; },
  nameOf(t, p) { return (t.players().find((x) => x.id === p) || {}).name || '?'; },
  online(t, p) { return t.players().some((x) => x.id === p && x.online); },
  // Draw piles hold only a small window of the shuffled deck; refills come
  // from index lists in t.data, and discards reshuffle in when a list runs dry.
  stock(t, kind, need) {
    const d = t.data, deckId = kind === 'w' ? d.wd : d.bd;
    let pile = t.piles().find((p) => p.id === d[kind + 'pile']);
    while ((pile ? pile.cards.length : 0) < need) {
      if (!d[kind + 'left'].length) {
        if (!d[kind + 'disc'].length) throw new Error('the ' + (kind === 'w' ? 'white' : 'black') + ' deck ran dry');
        d[kind + 'left'] = this.shuf(d[kind + 'disc']); d[kind + 'disc'] = [];
        t.say('reshuffled the ' + (kind === 'w' ? 'white' : 'black') + ' discards back in');
      }
      const idxs = d[kind + 'left'].splice(0, this.CHUNK);
      const nid = t.newPile(idxs.map((i) => ({ d: deckId, i, up: false })),
        { ...this.pileAt(t, kind), name: kind === 'w' ? 'White deck' : 'Black deck' });
      if (pile) t.merge(nid, pile.id); else d[kind + 'pile'] = nid;
      pile = t.piles().find((p) => p.id === d[kind + 'pile']);
    }
    return pile;
  },
  dealWhite(t, p, n) {
    const pile = this.stock(t, 'w', n);
    for (let k = 0; k < n; k++) t.deal(pile.id, { to: p });
  },
  refill(t) {
    for (const p of t.players()) {
      if (p.online && p.handCount < this.HAND) this.dealWhite(t, p.id, this.HAND - p.handCount);
    }
  },
  badges(t) {
    const d = t.data;
    t.public.badges = Object.fromEntries(t.players().map((p) =>
      [p.id, '⭐' + (d.scores[p.id] || 0) + (p.id === d.czar && d.phase !== 'over' ? ' 👑' : '')]));
  },
  // A table spot in the Czar's frame, as t.deal options: dx to the Czar's
  // right, dy toward the Czar (from the center), upright for the Czar.
  at(t, dx, dy) {
    const g = t.geom(), s = (t.players().find((x) => x.id === t.data.czar) || { seat: 90 }).seat;
    const rot = ((s - 90) % 360 + 360) % 360, r = (rot * Math.PI) / 180;
    return { x: g.cx - 50 + dx * Math.cos(r) - dy * Math.sin(r), y: g.cy - 70 + dx * Math.sin(r) + dy * Math.cos(r), rot, up: true };
  },
  // The draw piles flank the center across the Czar's view (|dy| ≤ 70): clear
  // of a standard deck in the very center, the prompt (dy -220) and the
  // columns (dy ≥ 120). startRound moves them along when the Czar changes.
  pileAt(t, kind) { const o = this.at(t, kind === 'w' ? -170 : 170, 0); return { x: o.x, y: o.y }; },
  // Answer column gi: its #marker (k = -1) on top, then the answer cards
  // (each overlapping the one before, so the top lines of all stay readable).
  spot(t, gi, k) {
    return this.at(t, (gi - (t.data.order.length - 1) / 2) * 110, k < 0 ? 190 : 232 + k * 42);
  },
  // Lays cards [{d, i}] face up at the given spots as NEW table items, dealt
  // from a temporary pile: nothing links them to the items they came from.
  lay(t, cards, spots) {
    const tmp = t.newPile(cards.slice().reverse().map((c) => ({ d: c.d, i: c.i, up: true })), spots[0]);
    return spots.map((o) => t.deal(tmp, o).id);
  },
  startRound(t, lead) {
    const d = t.data;
    d.subs = {}; d.order = null; d.phase = 'submit'; d.round = (d.round || 0) + 1;
    this.refill(t);
    d.black = t.deal(this.stock(t, 'b', 1).id, this.at(t, 0, -220));
    for (const k of ['w', 'b']) { const o = this.pileAt(t, k); t.move(d[k + 'pile'], o.x, o.y); }
    d.pick = ((t.card(d.black) || {}).meta || {}).pick || 1;
    d.roundPlayers = t.players().filter((p) => p.online && p.id !== d.czar).map((p) => p.id);
    if (d.pick === 3) for (const p of d.roundPlayers) this.dealWhite(t, p, 2); // the printed rule: draw 2 for PICK 3
    t.public.turn = d.roundPlayers.slice(); // ⏳ + the your-turn cue: the answerers now, the Czar when judging
    t.public.winners = [];
    t.public.facedown = d.roundPlayers.slice(); // locks their 🂠 toggle on
    this.badges(t);
    t.announce((lead ? lead + ' — ' : '') + this.nameOf(t, d.czar) + ' is the Card Czar — answer with '
      + d.pick + ' card' + (d.pick > 1 ? 's' : '') + ', FACE DOWN (🂠)');
  },
  validate(t, a) {
    const d = t.data;
    if (!d.phase || d.phase === 'over') return;
    if (a.t === 'move' || a.t === 'rot') return; // arranging the table stays free
    if (a.t !== 'play' && !(a.t === 'handPile' && a.pile === d.ans)) return 'The game runs the cards here';
    if (d.phase !== 'submit') return 'Wait for the next black card';
    if (a.p === d.czar) return 'The Card Czar does not answer';
    if (!d.roundPlayers.includes(a.p)) return 'You deal in next round';
    if (a.d !== d.wd) return 'Answer with a white card';
    if (a.t === 'play' && a.up) return 'Submit FACE DOWN — toggle 🂠 in the hand bar';
    if ((d.subs[a.p] || []).length >= d.pick) return 'You already submitted';
  },
  onAction(t, a) {
    const d = t.data;
    if (d.phase !== 'submit' || !(a.t === 'play' || (a.t === 'handPile' && a.pile === d.ans))) return;
    if (a.t === 'play') {
      // straight into the face-down Answers pile: left where it was dropped,
      // the card's spot and item id would tell everyone who played it
      const it = t.items().find((x) => x.k === 'c' && x.d === a.d && x.i === a.i);
      if (!it) return;
      if (!t.piles().some((p) => p.id === d.ans)) d.ans = t.newPile([], { ...this.at(t, 0, 190), name: 'Answers' });
      t.toPile(it.id, d.ans);
    }
    (d.subs[a.p] = d.subs[a.p] || []).push({ d: a.d, i: a.i });
    const waiting = this.waiting(t);
    t.public.turn = waiting;
    if (!waiting.length) this.judge(t);
    else t.say('answers in: ' + (d.roundPlayers.length - waiting.length) + '/' + d.roundPlayers.length);
  },
  waiting(t) { const d = t.data; return d.roundPlayers.filter((p) => (d.subs[p] || []).length < d.pick); },
  judge(t) {
    const d = t.data;
    // shuffled columns so the Czar cannot tell who played what
    d.order = this.shuf(Object.keys(d.subs).filter((p) => d.subs[p].length === d.pick));
    if (!d.order.length) return this.endRound(t, null, 'No answers came in — new prompt');
    d.phase = 'judge';
    t.public.turn = d.czar;
    delete t.public.facedown;
    t.remove(d.ans); d.ans = null; // the answers come back out as new items
    const cards = [], spots = [];
    d.order.forEach((p, gi) => {
      cards.push({ d: d.nd, i: gi % this.COLS }); spots.push(this.spot(t, gi, -1));
      d.subs[p].forEach((c, k) => { cards.push(c); spots.push(this.spot(t, gi, k)); });
    });
    d.laid = this.lay(t, cards, spots);
    t.announce(this.nameOf(t, d.czar) + ' judges — press 👉 for the funniest answer');
  },
  onButton(t, id, by) {
    const d = t.data;
    if (id === 'newgame' && d.phase === 'over') {
      d.scores = {}; t.public.winners = []; d.czar = t.nextSeat(d.czar);
      return this.startRound(t);
    }
    if (id === 'skipczar' && (d.phase === 'submit' || d.phase === 'judge') && !this.online(t, d.czar)) {
      return this.endRound(t, null, 'The Card Czar is away — new prompt');
    }
    if (id === 'force' && by === d.czar && d.phase === 'submit') return this.judge(t);
    if (d.phase === 'judge' && by === d.czar && id.indexOf('pick') === 0) {
      const gi = +id.slice(4), winner = d.order[gi];
      if (!winner) return;
      d.scores[winner] = (d.scores[winner] || 0) + 1;
      // The result stays up a few seconds: 🏆 over the winning column, the
      // winner on the banner, log and seat — then the next round.
      d.phase = 'reveal'; d.winner = winner; t.public.turn = null;
      d.laid.push(...this.lay(t, [{ d: d.nd, i: this.COLS }], [this.spot(t, gi, -1)]));
      // the column's answers back on top, so the 🏆 heads it as its # did
      d.laid.slice(gi * (d.pick + 1) + 1, (gi + 1) * (d.pick + 1))
        .forEach((id, k) => { const o = this.spot(t, gi, k); t.move(id, o.x, o.y); });
      t.public.winners = [winner];
      this.badges(t);
      const texts = d.subs[winner].map((c) => (t.card(c) || {}).text).join(' / ');
      t.announce(this.nameOf(t, winner) + ' wins the round with #' + (gi + 1) + ': "' + texts + '" (⭐' + d.scores[winner] + ')');
      t.schedule(4, 'next' + d.round);
    }
  },
  onTimer(t, tag) {
    if (tag === 'next' + t.data.round && t.data.phase === 'reveal') this.endRound(t, t.data.winner);
  },
  // Clears the round's cards off the table into the discards.
  clearRound(t) {
    const d = t.data;
    for (const p of Object.keys(d.subs || {})) for (const c of d.subs[p]) d.wdisc.push(c.i);
    if (d.black) d.bdisc.push(d.black.i);
    for (const id of [d.ans, d.black && d.black.id].concat(d.laid || [])) if (id) t.remove(id);
    d.subs = {}; d.black = null; d.ans = null; d.laid = [];
  },
  endRound(t, winner, lead) {
    const d = t.data;
    this.clearRound(t);
    if (winner && d.scores[winner] >= d.goal) {
      d.phase = 'over'; t.public.turn = null; delete t.public.facedown; this.badges(t);
      return t.win([winner], this.nameOf(t, winner) + ' wins the game with ⭐' + d.scores[winner] + '!');
    }
    d.czar = t.nextSeat(d.czar);
    this.startRound(t, lead);
  },
  buttons(t) {
    const d = t.data;
    if (d.phase === 'over') return [{ id: 'newgame', label: '🔄 New game' }];
    if ((d.phase === 'submit' || d.phase === 'judge') && !this.online(t, d.czar)) return [{ id: 'skipczar', label: '⏭ Skip Czar' }];
    if (d.phase === 'submit') return [{ id: 'force', label: '⚖️ Judge now', pid: d.czar }];
    if (d.phase === 'judge') {
      return d.order.map((p, gi) => {
        const s = '👉 ' + (gi + 1) + ': ' + d.subs[p].map((c) => (t.card(c) || {}).text).join(' / ');
        return { id: 'pick' + gi, label: s.length > 30 ? s.slice(0, 29) + '…' : s, pid: d.czar };
      });
    }
    return [];
  },
  onChat(t, msg, p) {
    const m = msg.trim().toLowerCase();
    if (m.indexOf('!goal ') === 0) {
      if (p !== t.hostId) return t.tell(p, 'Only the host sets the goal');
      const n = parseInt(m.slice(6), 10);
      if (n > 0) { t.data.goal = n; t.say('the goal is now ⭐' + n); }
    }
  },
  onJoin(t, p) {
    const d = t.data;
    if (!d.phase || d.phase === 'over') return;
    const pl = t.players().find((x) => x.id === p);
    if (pl && pl.handCount < this.HAND) this.dealWhite(t, p, this.HAND - pl.handCount);
    // onJoin also fires on a reconnect: only a newcomer sits this round out
    if (p !== d.czar && !(d.roundPlayers || []).includes(p)) t.tell(p, 'You deal in next round');
  },
  onLeave(t, p) {
    const d = t.data;
    if (d.phase !== 'submit' && d.phase !== 'judge') return;
    if (p === d.czar) return this.endRound(t, null, 'The Card Czar left — new prompt');
    if (d.phase === 'submit' && d.roundPlayers.includes(p)) {
      // their answer is dropped (it stays hidden in the Answers pile until the reveal clears it)
      d.roundPlayers = d.roundPlayers.filter((x) => x !== p);
      for (const c of d.subs[p] || []) d.wdisc.push(c.i);
      delete d.subs[p];
      const waiting = this.waiting(t);
      t.public.turn = waiting;
      if (d.roundPlayers.length && !waiting.length) this.judge(t);
    }
  },
})`,
  dealer: `({
  name: 'Simple dealer',
  buttons: () => [{ id: 'deal1', label: 'Deal 1 to all' }],
  onButton(t, id, by) {
    const deck = t.piles().sort((a, b) => b.cards.length - a.cards.length)[0];
    if (!deck) return t.tell(by, 'No deck on the table — add one first');
    const n = t.players().filter((p) => p.online).length;
    if (deck.cards.length < n) t.announce('The deck is short (' + deck.cards.length + ' left) — the last seats get none');
    t.dealToAll(deck.id, 1);
  },
})`,
};

// --- game picker (🎲, host only) --------------------------------------------
/** One entry per shipped template (k = its RULES_TEMPLATES key), plus the
 *  free table (rules off) and a custom script (the 📜 dialog). */
const GAMES = [
  { k: 'holdem', emoji: '🃏', title: "Texas Hold'em", short: "Hold'em", pitch: 'No-limit poker: chips, blinds, betting rounds, automatic showdown', players: '2–8 players' },
  { k: 'cah', emoji: '😈', title: 'Cards Against Humanity', pitch: 'Fill in the blank; the Card Czar crowns the funniest answer', players: '3+ players' },
  { k: 'bridge', emoji: '🤝', title: 'Bridge', pitch: 'Partners bid in the chat, then tricks, trumps, the dummy and scoring', players: '4 players' },
  { k: 'turns', emoji: '🔁', title: 'Turn order', short: 'Turns', pitch: 'Any game you like, one player at a time', players: '2+ players' },
  { k: 'dealer', emoji: '🤵', title: 'Simple dealer', short: 'Dealer', pitch: 'A "Deal 1 to all" button and nothing enforced', players: 'any number' },
  { k: 'free', emoji: '🖐', title: 'Free table', pitch: 'No rules: deal, move and flip cards however you like', players: 'any number' },
  { k: 'custom', emoji: '📜', title: 'Custom script…', short: 'Custom…', pitch: 'Write or paste your own rules', players: '' },
];
let askGame = false; // a brand-new table: invite the host to pick a game (the strip)

/** The picker entry matching what the host is running now. */
const currentGame = () => (!host?.rules?.enabled ? 'free'
  : GAMES.find((g) => RULES_TEMPLATES[g.k] === host.rules.code)?.k || 'custom');

function renderGames() {
  const isHost = role === 'host';
  $('games-btn').classList.toggle('hidden', !isHost);
  $('game-strip').classList.toggle('hidden', !isHost || !askGame || !!host?.rules);
  $('game-strip').classList.toggle('compact', Object.keys(view.players).length > 1);
}

/** Starts game `k` through the same setRules action as the 📜 dialog
 *  (whose act() re-renders, hiding the strip; 'custom' renders itself).
 *  Switching away from a running game asks first: its state would be lost.
 *  (The free table only disables the rules: re-enabling keeps the state.) */
function pickGame(k) {
  // Another game's state (chips, scores, a hand) is discarded by setRules —
  // even while the rules are off ("Free table" keeps it for re-enabling).
  // setRules keeps the state of a script with the same name: compare names too.
  const tplName = /\bname: (['"])(.*?)\1/.exec(RULES_TEMPLATES[k] || '')?.[2];
  if (RULES_TEMPLATES[k] && host?.rules && host.rules.name !== tplName && !confirm(host.rules.enabled
    ? `Stop ${host.rules.name}? Its game state (chips, scores, the hand in progress) will be lost.`
    : `Discard the kept ${host.rules.name} game state (chips, scores)?`)) return;
  askGame = false;
  $('games-dialog').close();
  if (k === 'custom') { renderAll(); $('rules-btn').click(); }
  else if (k === 'free') act({ t: 'setRules', enabled: false });
  else {
    lastRulesError = '';
    $('rules-code').value = RULES_TEMPLATES[k]; // the 📜 dialog shows what runs
    act({ t: 'setRules', code: RULES_TEMPLATES[k], enabled: true });
  }
}

$('game-strip').querySelector('.games').innerHTML = GAMES.map((g) =>
  `<button data-game="${g.k}" title="${esc(`${g.title}: ${g.pitch}`)}">${g.emoji} ${g.short || g.title}</button>`).join('');
$('games-btn').addEventListener('click', () => {
  const cur = currentGame();
  $('games-list').innerHTML = GAMES.map((g) => `<button data-game="${g.k}"${g.k === cur ? ' class="on"' : ''}>
    <span class="ge">${g.emoji}</span><span><b>${g.title}</b>${g.k === cur ? ' <i>playing</i>' : ''}<small>${g.pitch}${g.players ? ` · ${g.players}` : ''}</small></span></button>`).join('');
  $('games-dialog').showModal();
});
for (const el of [$('games-list'), $('game-strip')]) {
  el.addEventListener('click', (e) => {
    const k = e.target.closest('[data-game]')?.dataset.game;
    if (k) pickGame(k);
  });
}
$('game-strip-x').addEventListener('click', () => { askGame = false; renderAll(); });
$('game-strip-ask').addEventListener('click', () => $('games-btn').click());

function updateRulesDialog() {
  const isHost = role === 'host';
  const meta = isHost ? host?.rules : view.rules;
  $('rules-status').textContent = meta?.enabled ? `active: ${meta.name}` : 'inactive';
  $('rules-tpl').classList.toggle('hidden', !isHost);
  $('rules-enable').classList.toggle('hidden', !isHost);
  $('rules-reset-lbl').classList.toggle('hidden', !isHost);
  $('rules-disable').classList.toggle('hidden', !isHost || !meta?.enabled);
  $('rules-code').readOnly = !isHost;
  $('rules-err').textContent = lastRulesError;
}

$('rules-btn').addEventListener('click', () => {
  const ta = $('rules-code');
  if (role === 'host') {
    if (!ta.value.trim()) ta.value = host?.rules?.code || RULES_TEMPLATES.blank;
    $('rules-reset').checked = false;
  } else {
    ta.value = guestRules.code || '// The host has not written a rules script yet.';
  }
  updateRulesDialog();
  $('rules-dialog').showModal();
});

$('rules-tpl').addEventListener('change', () => {
  const k = $('rules-tpl').value;
  if (RULES_TEMPLATES[k]) $('rules-code').value = RULES_TEMPLATES[k];
  $('rules-tpl').value = '';
});

$('rules-form').addEventListener('submit', (e) => {
  if (e.submitter?.id !== 'rules-enable') return; // Close button
  e.preventDefault();
  lastRulesError = '';
  act({ t: 'setRules', code: $('rules-code').value, enabled: true, reset: $('rules-reset').checked });
  if (!lastRulesError) $('rules-dialog').close();
  else updateRulesDialog(); // keep it open and show the error
});

$('rules-disable').addEventListener('click', () => {
  act({ t: 'setRules', enabled: false });
  updateRulesDialog();
});
$('view-btn').addEventListener('click', () => {
  // Full view reset: zoom, pan, and rotation back to "my seat at the bottom".
  manualView = false;
  zoomZ = 1;
  panX = panY = 0;
  applySeatView();
  layout();
});

$('size-sel').addEventListener('change', () => act({ t: 'size', size: +$('size-sel').value }));
$('log-btn').addEventListener('click', () => {
  sideEl.classList.toggle('hidden');
  if (!sideEl.classList.contains('hidden')) logEl.scrollTop = logEl.scrollHeight;
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = $('chat-input').value.trim();
  if (!msg) return;
  act({ t: 'chat', msg });
  $('chat-input').value = '';
});

// --- deck creation --------------------------------------------------------
/** Downscales an image file to a compact data URL (keeps decks shareable & persistable). */
async function fileToDataURL(file, max = 560) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/webp', 0.8);
}

/** Card name from an image filename: "dragon_rider.png" → "dragon rider". */
const nameFromFile = (fn) => fn.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 60);

/** Custom deck without a manifest: one card per image, named after its file. */
async function filenameDeck(images) {
  const imgs = [], cards = [];
  for (const f of images) {
    cards.push({ g: imgs.length, n: nameFromFile(f.name) });
    imgs.push(await fileToDataURL(f));
  }
  return { name: 'Deck', back: null, imgs, cards };
}

/** Custom deck from a deck.json manifest plus its images. Entries:
 *  { file?, name?, count?, text?, color?, meta? } — `file`-less entries render
 *  as text cards; `meta` is free-form JSON for rules scripts (t.card).
 *  Each image is stored once in deck.imgs and shared by all its copies. */
async function manifestDeck(m, images) {
  if (!Array.isArray(m.cards) || !m.cards.length) throw new Error('deck.json needs a non-empty "cards" array');
  const byName = new Map(images.map((f) => [f.name, f]));
  const imgs = [], gOf = new Map(); // filename → index into imgs
  const imgIdx = async (fn) => {
    if (!gOf.has(fn)) {
      const f = byName.get(fn);
      if (!f) throw new Error(`deck.json references "${fn}" but no such image was uploaded`);
      gOf.set(fn, imgs.length);
      imgs.push(await fileToDataURL(f));
    }
    return gOf.get(fn);
  };
  const cards = [];
  for (const e of m.cards) {
    if (!e.file && !e.name) throw new Error('every deck.json card needs a "file" or a "name"');
    const card = {
      n: String(e.name ?? nameFromFile(e.file)).slice(0, 60),
      ...(e.file ? { g: await imgIdx(String(e.file)) } : {}),
      ...(e.text ? { txt: String(e.text).slice(0, 300) } : {}),
      ...(e.color ? { col: String(e.color).slice(0, 24) } : {}),
      ...(e.bg ? { b: String(e.bg).slice(0, 24) } : {}),
      ...(e.meta !== undefined ? { meta: e.meta } : {}),
    };
    const count = Math.min(Math.max(1, e.count | 0 || 1), 500);
    for (let k = 0; k < count; k++) cards.push(card); // copies share the object; card defs are never mutated
  }
  const deck = { name: String(m.name || 'Deck').slice(0, 24), back: null, imgs, cards };
  // back: an uploaded image's filename, or a solid color like "#111"
  if (m.back != null) deck.back = String(m.back).startsWith('#') ? String(m.back).slice(0, 24) : imgs[await imgIdx(String(m.back))];
  // Uploaded images the manifest didn't mention still join, filename-named.
  for (const f of images) {
    if (gOf.has(f.name)) continue;
    cards.push({ g: imgs.length, n: nameFromFile(f.name) });
    imgs.push(await fileToDataURL(f));
  }
  return deck;
}

// Building a big image deck takes seconds: one build at a time, and closing
// the dialog meanwhile (Cancel/Escape) abandons that build — its result is
// dropped even if the player has reopened the dialog since.
let deckBuild = 0; // bumped on every close: a build that started before is stale
const deckBtn = (busy) => { $('deck-add').disabled = busy; $('deck-add').textContent = busy ? 'Building…' : 'Add deck'; };
$('deck-dialog').addEventListener('close', () => { deckBuild++; deckBtn(false); });
$('deck-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'add') return;
  e.preventDefault();
  if ($('deck-add').disabled) return;
  const run = deckBuild;
  deckBtn(true);
  const kind = document.querySelector('input[name="deck-kind"]:checked').value;
  const name = $('deck-name').value.trim();
  try {
    let deck;
    if (kind === 'std') {
      deck = standardDeck($('deck-jokers').checked);
      if (name) deck.name = name;
    } else {
      const files = [...$('deck-files').files];
      const mf = files.find((f) => /\.json$/i.test(f.name));
      const images = files.filter((f) => f !== mf);
      if (!mf && !images.length) { toast('Pick card images and/or a deck.json'); return; }
      if (mf) {
        let m;
        try { m = JSON.parse(await mf.text()); } catch (err) { throw new Error(`${mf.name} is not valid JSON: ${err.message}`); }
        deck = await manifestDeck(m, images);
      } else {
        deck = await filenameDeck(images);
      }
      const backFile = $('deck-back').files[0];
      if (backFile) deck.back = await fileToDataURL(backFile);
      if (name) deck.name = name;
    }
    if (run !== deckBuild) return; // the player cancelled while it was building
    act({ t: 'addDeck', deckId: uid(), deck, x: TABLE_W / 2 - CARD_W / 2, y: TABLE_H / 2 - CARD_H / 2 });
    $('deck-dialog').close();
    $('deck-form').reset();
  } catch (err) {
    console.error('failed to build deck', err);
    toast(`Failed to build deck: ${err.message}`);
  } finally {
    if (run === deckBuild) deckBtn(false); // else the close already reset it (maybe for a new build)
  }
});

// --- boot -----------------------------------------------------------------
function becomeHost(saved) {
  role = 'host';
  hostBoot = Date.now();
  $('size-sel').classList.remove('hidden'); // table size is the host's call
  if (saved?.lost) {
    console.error('this table could not be resumed:', saved.lost);
    toast(`Couldn't resume this table (${saved.lost}) — started a fresh one`);
    saved = null;
  }
  if (saved) {
    // Saves may predate the sanitizer (and could hold a deck a guest crafted).
    decks = {};
    for (const [id, d] of Object.entries(saved.decks || {})) {
      try { decks[id] = cleanDeck(d); } catch (err) { console.error(`saved deck ${id} dropped`, err); }
    }
    host = saved.state;
    host.log ||= []; // saves from before the log existed
    host.size ||= 1300;
    // Re-evaluate a saved rules script; a save that no longer parses
    // disables the rules loudly rather than wedging the resume.
    if (host.rules?.code) {
      try {
        script = evalRules(host.rules.code);
        rulesCodeDirty = true;
      } catch (err) {
        console.error('saved rules script failed to load', err);
        lastRulesError = err.message;
        host.rules.enabled = false;
        toast(`Saved rules failed to load: ${err.message}`);
      }
    }
    setTableSize(host.size);
    $('size-sel').value = String(host.size);
    for (const pl of Object.values(host.players)) pl.online = false;
    // Migrate older saves: seats didn't exist, and the table used to be a
    // larger rectangle — pull stranded items back onto the round felt.
    for (const pl of Object.values(host.players)) pl.seat ??= assignSeat();
    for (const it of Object.values(host.items)) ({ x: it.x, y: it.y } = clampToFelt(it.x, it.y));
    ensurePlayer(pid, myName);
    logEvent(pid, 'resumed the table');
    host.seq++;
  } else {
    host = { seq: 1, size: TABLE_W, items: {}, players: {}, log: [] };
    askGame = true;
    ensurePlayer(pid, myName);
    const deck = standardDeck(false);
    const deckId = uid();
    decks[deckId] = deck;
    host.items[uid()] = {
      k: 'p', x: TABLE_W / 2 - CARD_W / 2, y: TABLE_H / 2 - CARD_H / 2, rot: 0, z: 1,
      name: deck.name, cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })),
    };
    logEvent(pid, 'opened the table');
  }
  refreshView();
  persist();
}

// --- terminal bridge (opt-in) ---------------------------------------------
// With "~cli~PORT-TOKEN" in the hash, this tab pairs with a local bridge
// server (cli.js for Node, cli.py for Python) on 127.0.0.1: it mirrors its
// view of the table over there and executes the commands it gets back —
// through the very same act() path as a click, so rules validation, the log
// and the anti-cheat record all apply unchanged. Plain long-polling HTTP,
// because localhost is exempt from mixed-content rules and needs no deps on
// the server side. The token (minted by the CLI) keeps random websites the
// user visits from driving the table through the same local port.
const cliMsgs = []; // bridge-only feedback: command errors, peek results, notices

/** A private notice for this player (a veto, t.tell, a failed send): a toast,
 *  and on a bridged tab the terminal/bot gets it too — nobody may be
 *  watching that browser. */
function note(msg) {
  toast(msg);
  if (CLI) cliMsgs.push(`note: ${msg}`);
}

function cliCardInfo(d, i) {
  const c = decks[d]?.cards[i];
  return { name: cardName(d, i), ...(c?.txt ? { text: c.txt } : {}), ...(c?.meta !== undefined ? { meta: c.meta } : {}) };
}

function cliSnapshot() {
  const rules = role === 'host' ? host?.rules : view.rules;
  const pub = (rules?.enabled && rules.public) || {};
  return {
    pid, name: myName, role, seq: view.seq, room: roomId,
    // key names the card itself: a stable handle while indices shift (see cliExec 'play')
    hand: myHand.map((c, idx) => ({ idx, key: `${c.d}:${c.i}`, ...cliCardInfo(c.d, c.i) })),
    players: Object.entries(view.players).map(([id, pl]) => ({
      id, name: pl.name, seat: pl.seat, online: pl.online, cards: pl.handCount,
      ...([].concat(pub.turn).includes(id) ? { turn: true } : {}),
      ...(pub.badges?.[id] ? { badge: pub.badges[id] } : {}),
      ...(pub.winners?.includes(id) ? { winner: true } : {}),
    })),
    items: Object.entries(view.items).map(([id, it]) => (it.k === 'c'
      ? { id, kind: 'card', x: it.x | 0, y: it.y | 0, up: !!it.up, ...(it.up ? cliCardInfo(it.d, it.i) : {}) }
      : { id, kind: 'pile', name: it.name || null, count: it.n, x: it.x | 0, y: it.y | 0,
        ...(it.top?.up ? { top: cliCardInfo(it.top.d, it.top.i) } : {}) })),
    buttons: ((rules?.enabled && rules.public?.buttons) || [])
      .filter((b) => !b.pid || b.pid === pid).map((b) => ({ id: b.id, label: b.label })),
    rules: rules?.enabled ? rules.name : null,
    // rules: true marks script lines — a player can NAME itself "📜 Rules", but can't fake this
    log: gameLog.slice(-40).map((e) => ({
      who: typeof e.n === 'string' ? e.n : actorInfo(e.p).name, text: e.txt,
      ...(e.c ? { chat: true } : {}), ...(e.p === RULES ? { rules: true } : {}), ts: e.ts,
    })),
    msgs: cliMsgs.slice(),
  };
}

/** Resolves a command's item reference: an exact id, a pile name, or (for
 *  pile commands with no ref) the biggest pile on the table. */
function cliItem(ref, kind) {
  if (ref != null && view.items[ref] && (!kind || view.items[ref].k === kind)) return String(ref);
  const ent = Object.entries(view.items).filter(([, it]) => !kind || it.k === kind);
  const s = String(ref ?? '').toLowerCase();
  const byName = s && ent.find(([, it]) => (it.name || '').toLowerCase() === s);
  if (byName) return byName[0];
  if (ref == null && kind === 'p') {
    const top = ent.sort((a, b) => (b[1].n || 0) - (a[1].n || 0))[0];
    if (top) return top[0];
  }
  throw new Error(`no such ${kind === 'p' ? 'pile' : 'item'}: ${ref}`);
}

/** Drop spot for terminal plays/deals: explicit x/y, or jittered toward the
 *  player's own seat (like dropping cards in front of yourself). */
function cliSpot(c) {
  if (c.x != null && c.y != null) return clampToFelt(+c.x, +c.y);
  const seat = ((view.players[pid]?.seat ?? 90) * Math.PI) / 180;
  const r = PLAY_R * (0.5 + Math.random() * 0.25);
  return clampToFelt(TABLE_W / 2 + r * Math.cos(seat) - CARD_W / 2, TABLE_H / 2 + r * Math.sin(seat) - CARD_H / 2);
}

/** The hand index a command means: by card `key` when given (on the host
 *  seat myHand is live, so indices shift between two queued plays), else idx. */
function cliHandIdx(c) {
  const idx = c.key ? myHand.findIndex((h) => `${h.d}:${h.i}` === c.key) : +c.idx;
  if (!myHand[idx]) throw new Error(`no hand card ${c.key || `#${c.idx}`}`);
  return idx;
}

function cliExec(c) {
  try {
    switch (c.t) {
      case 'chat': { const msg = String(c.msg ?? '').slice(0, 300); if (msg) act({ t: 'chat', msg }); break; }
      case 'play': {
        const idx = cliHandIdx(c), card = myHand[idx];
        const at = cliSpot(c);
        // as in the drag path, the rules' face-down hint wins over the default face up
        act({ t: 'play', idx, d: card.d, i: card.i, x: at.x, y: at.y, up: c.up !== false && !forcedFacedown(), rot: uprightRot() });
        break;
      }
      case 'discard': {
        const idx = cliHandIdx(c), card = myHand[idx];
        act({ t: 'handPile', idx, d: card.d, i: card.i, pile: cliItem(c.pile, 'p') });
        break;
      }
      case 'draw': act({ t: 'draw', id: cliItem(c.id, 'p') }); break;
      case 'deal': { const at = cliSpot(c); act({ t: 'deal', id: cliItem(c.id, 'p'), up: !!c.up, rot: uprightRot(), x: at.x, y: at.y }); break; }
      case 'shuffle': act({ t: 'shuffle', id: cliItem(c.id, 'p') }); break;
      case 'flip': act({ t: 'flip', id: cliItem(c.id) }); break;
      case 'move': { const at = clampToFelt(+c.x || 0, +c.y || 0); act({ t: 'move', id: cliItem(c.id), x: at.x, y: at.y }); break; }
      case 'rot': act({ t: 'rot', id: cliItem(c.id), rot: +c.deg || 0 }); break;
      case 'toHand': act({ t: 'toHand', id: cliItem(c.id) }); break;
      case 'peek': { // a face-up card is public; anything else is answered privately by the host (showPeek)
        const id = cliItem(c.id), it = view.items[id];
        if (it.k === 'c' && it.up) cliMsgs.push(`peek: ${cardName(it.d, it.i)}`);
        else act({ t: 'peek', id });
        break;
      }
      case 'btn': act({ t: 'rulesBtn', id: String(c.id) }); break;
      default: throw new Error(`unknown command: ${c.t}`);
    }
  } catch (err) {
    console.error('bridge command failed', err, c);
    cliMsgs.push(`error: ${err.message}`);
  }
}

function cliConnect() {
  if (!CLI) return;
  const base = `http://127.0.0.1:${CLI.port}`;
  const q = `?token=${encodeURIComponent(CLI.token)}`;
  let last = '', inflight = false;
  /** fetch() to the bridge. Only fetch itself failing means nobody answered
   *  (it rejects with a TypeError); such errors are tagged `unreachable`. */
  const call = (path, init) => fetch(`${base}${path}${q}`, init)
    .catch((err) => { err.unreachable = true; throw err; });
  const push = async () => {
    if (inflight) return;
    inflight = true;
    try {
      const snap = cliSnapshot();
      const s = JSON.stringify(snap);
      if (s === last) return;
      const r = await call('/state', { method: 'POST', body: s, headers: { 'Content-Type': 'text/plain' } });
      if (!r.ok) throw new Error(`bridge rejected state (${r.status})`);
      last = s;
      cliMsgs.splice(0, snap.msgs.length); // delivered
    } finally { inflight = false; }
  };
  (async () => {
    // status: '' until the first outcome, then 'ok' or the failure last shown —
    // each change is toasted once, so a bridge that never answers is visible too.
    let status = '';
    for (;;) {
      try {
        await push();
        const r = await call('/poll');
        if (!r.ok) throw new Error(`bridge poll failed (${r.status})`);
        if (status !== 'ok') { status = 'ok'; toast('🖥 Terminal bridge connected', true); console.log('terminal bridge connected', base); }
        for (const c of await r.json()) { cliExec(c); }
      } catch (err) {
        console.error('terminal bridge error', err);
        // Only a bridge that didn't answer is "lost"/"not reachable"; anything
        // else (a bad reply, a bug in this tab) is shown as the error it is.
        const msg = /\(403\)/.test(err.message) ? '🖥 Terminal bridge rejected this tab\'s token — open the URL the CLI printed'
          : !err.unreachable ? `🖥 Terminal bridge error: ${err.message}`
            : status === 'ok' ? '🖥 Terminal bridge lost — retrying'
              : `🖥 Terminal bridge not reachable on 127.0.0.1:${CLI.port} — is cli.js / cli.py running?`;
        if (msg !== status) { status = msg; toast(msg); }
        last = ''; // a restarted bridge has no state yet: the next push is a full one
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  })();
  setInterval(() => push().catch((err) => console.error('bridge push failed', err)), 500);
}

/** First-visit nickname prompt; resolves once the player picked a name. */
function askName() {
  return new Promise((resolve) => {
    const dlg = $('name-dialog');
    $('name-first').value = myName;
    dlg.addEventListener('close', () => {
      const v = $('name-first').value.trim();
      if (v) myName = v;
      localStorage.setItem('ct-name', myName);
      nameInput.value = myName;
      resolve();
    }, { once: true });
    dlg.showModal();
  });
}

async function boot() {
  const m = location.hash.match(/^#room~([0-9a-f]+)~([0-9a-f]+)(?:~|$)/);
  let saved = null;
  if (m) {
    [, roomId, password] = m;
    saved = loadSave();
  } else {
    roomId = await newHostKey(); // the room id IS the host key's fingerprint
    password = rand(8);
    history.replaceState({}, '', `#room~${roomId}~${password}`);
  }
  signedRoom = roomId.length === 24;
  if (!localStorage.getItem('ct-name') && !AS) await askName();
  // A bot tab is always a guest — even in the host's browser, where the
  // room's save would otherwise make this tab claim the table.
  let hosting = !AS && (!m || saved);
  if (hosting && signedRoom && !(await useHostKey(roomId))) {
    console.error('this browser has the save but not the host key for this room');
    toast('This room\'s host key is missing here — joining as a guest');
    hosting = false;
  }
  if (hosting) becomeHost(saved);
  else role = 'guest';
  if (window.innerWidth <= 820) sideEl.classList.add('hidden');
  layout();
  renderAll();
  connect();
  cliConnect();
}
boot().catch((err) => { console.error('boot failed', err); toast(`Failed to start: ${err.message}`); });
