// Card Table — a serverless multiplayer card-game simulator.
//
// Architecture (see mdmath/COLLAB-DESIGN.md for the design space): the peer who
// opens the room is the HOST and the single authority over game state. Guests
// send actions; the host applies them and keeps each guest's view in sync with
// deltas: a snapshot when a guest arrives (or falls behind), then one patch per
// broadcast tick with only what changed — personalized and signed for each
// guest (public table + that guest's private hand + hand counts for everyone
// else). Transport is Trystero WebRTC with signaling over public Nostr relays
// — no server, rooms are invite links. The host saves the game in IndexedDB
// (store.js) so reloading the invite link in the host's browser resumes the
// room; if two hosts ever collide (e.g. a stale resume), the one with the
// older state demotes itself to guest. Card images travel apart, by hash:
// every peer caches them, and a guest asks the host only for those it lacks.
//
// The table's state and every operation on it live in core.js (no DOM, no
// network), storage in store.js; this file is the network, rendering, input,
// dialogs and the terminal bridge around them. The shipped rules scripts are
// in templates.js.
import { joinRoom, selfId, getRelaySockets } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm';
import {
  CARD_W, CARD_H, RANKS, RULES, playR, clampToTable, seatAt, seatAngles, sizeOf, flagsOf, typeAt, PID_RE, ASSET_RE, rand, clamp, own, num, peerText,
  cleanDeck, cleanDeckV1, cleanBox, isBuiltin, deckOverBudget, assetRefs, cleanName, standardDeck, cardName, pieceName, faceLabel, createTable,
  MODULE_V as CORE_V, PROTO, PUBLIC_ACTIONS, HOST_ACTIONS, MAX_ROLL, MAX_N, MAX_BAG, MAX_HAND, MAX_PILE, SIG, sealText, sharedText, spliceBody, viewFromSnap, applyViewPatch, roundTable, FELT,
} from './core.js?v=1';
import { MODULE_V as GRID_V } from './grid.js?v=1';
import * as pieces from './pieces.js?v=1';
import { RULES_TEMPLATES, GAMES, BOXES, MODULE_V as TEMPLATES_V } from './templates.js?v=1';
import * as store from './store.js?v=1';

const { esc, safeColor, contrastFor } = pieces;

/** This file's code version; every module it imports must carry the same (see core.js MODULE_V). */
export const MODULE_V = 1;

const $ = (id) => document.getElementById(id);
const tableEl = $('table'), wrapEl = $('table-wrap'), handEl = $('hand'), barEl = $('action-bar');
const hintEl = $('table-hint'), toastEl = $('toast'), netEl = $('net-status');
const sideEl = $('side'), logEl = $('log');

// The table's shape and size are part of the shared game state (state.table,
// see core.js: round, 1300–2400 across, or a rectangle) — the host can
// change them — so the rendered table lives in these variables, kept in sync
// via setTable().
let TABLE = roundTable(), TABLE_W = 1300, TABLE_H = 1300;
let PLAY_R = 540; // a round table: the max distance of an item's centre from the table centre

/** Draws the table `tb` ({shape, w, h, felt?}, core.js cleanTable's). */
function setTable(tb) {
  TABLE = tb;
  TABLE_W = tb.w;
  TABLE_H = tb.h;
  PLAY_R = playR(tb.w);
  tableEl.style.width = `${tb.w}px`;
  tableEl.style.height = `${tb.h}px`;
  tableEl.classList.toggle('rect', tb.shape === 'rect');
  tableEl.style.setProperty('--felt', safeColor(tb.felt, FELT));
  zoomZ = Math.min(zoomZ, zoomMax());
  renderSizeSel();
  layout();
}
/** The user zoom's ceiling: 4× the fit, and on a rectangle 4 · max(w, h) / 1300,
 *  so 40-unit tokens stay usable on a 6000-unit map. */
const zoomMax = () => (TABLE.shape === 'rect' ? (4 * Math.max(TABLE_W, TABLE_H)) / 1300 : 4);
/** The host's size selector (#size-sel): the round sizes, and on a
 *  rectangle one more option, selected and disabled, naming it. */
function renderSizeSel() {
  const sel = $('size-sel'), rect = TABLE.shape === 'rect';
  sel.querySelector('option[value="rect"]')?.remove();
  if (rect) sel.insertAdjacentHTML('afterbegin', `<option value="rect" disabled>▭ ${num(TABLE_W)} × ${num(TABLE_H)}</option>`);
  sel.value = rect ? 'rect' : String(TABLE_W);
}

// --- loud error reporting -------------------------------------------------
let toastT = 0, pinned = ''; // pinned: a notice that stays up (it returns once later toasts expire)
/** Shows a 5s notice: red (a problem) unless `ok` marks it as good news;
 *  `pin` keeps it up for good. */
function toast(msg, ok, pin) {
  if (pin) pinned = msg;
  toastEl.classList.toggle('ok', !!ok);
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastT);
  if (msg !== pinned) toastT = setTimeout(() => (pinned ? toast(pinned) : toastEl.classList.add('hidden')), 5000);
}
window.addEventListener('error', (e) => { console.error(e.error || e.message); toast(`Error: ${e.message}`); });
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(`Error: ${e.reason?.message || e.reason}`);
});

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
//  • Data hygiene: decks pass one sanitizer (images by hash only, strict
//    color grammar, size caps) before anything renders them, and image bytes
//    are checked (type, size, pixel size, hash) before any peer stores them.
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
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
/** Host → wire: signs a body serialized as JSON `text` (unsigned legacy rooms send the body as-is). */
const seal = (text) => (signKey ? sealText(text, signKey, signPub) : JSON.parse(text));
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
let myName = AS || localStorage.getItem('ct-name') || `Player-${pid.slice(0, 4)}`;

// --- game state -----------------------------------------------------------
// T:      the table (host only): core.js's createTable() over the authoritative
//         state {v, seq, table, seats, items, players, keys, log, rules, decks, boxes, …}
// decks:  {deckId: {name, back, backImg?, imgs: [asset id], cards: [{g?} | {r,s,c}]}}
//         (core.js cleanDeck) — the renderer's deck map; on the host it IS
//         T.state.decks (commit()). Images are drawn from store.js by asset id.
// boxes:  {boxId: Box} (core.js cleanBox) — the renderer's game boxes, the
//         same way (T.state.boxes on the host); boxInfo: {boxId: {src, by?,
//         builtin}}, what the host says of each (for display only).
// view:   what render() consumes, on every tab the host's included: the PUBLIC
//         table {seq, boot, host, table, seats, handy, rules, items, players,
//         log, hand}, folded from the host's snapshots and patches (core.js
//         viewFromSnap, applyViewPatch). Items are the public shape (piles
//         {…, n, top}, no hidden ids or types); `hand` is this player's own.
let role = null, roomId, password, room = null;
let sendAct, sendState, sendDecks, sendBoxes, sendNote, sendRules, stateSend, sendAsset; // (set by connect())
let decks = {}, boxes = {}, boxInfo = {};
let T = null;
let view = viewFromSnap({ seq: 0, boot: 0 });
let peerPid = {};    // host only: Trystero peerId -> stable player id
let hostPeer = null; // guest only: peerId currently acting as host
const early = new Map(), EARLY_MAX = 16; // guest: peer → its catalog messages held until it shows it hosts (see fromHost)
/** Counters and the last durations, for the tests and benchmarks (window.__ct). */
const perf = { snaps: 0, patches: 0, gaps: 0, snapRequests: 0, lastApplyMs: 0, lastRenderMs: 0, lastSnapRenderMs: 0, drawn: 0, lastTickMs: 0, lastSaveSyncMs: 0 };

// --- the host's action queue ------------------------------------------------
// Every state change on the host runs through one FIFO, in arrival order: a
// player's action, and the internal jobs (JOBS) `_leave` (a player's last
// connection closed), `_tick` (the rules' timers), `_refuse` (an action
// turned away before it ran: re-send what it named) and `_unsaveable` (the
// save couldn't copy the rules' state). Jobs are synchronous today, so a job
// on an empty queue runs at once, in the caller's task, and the host's own
// clicks feel instant. Asynchronous preprocessing (deck ingestion) runs
// before a job enters the queue (submit), and a rules Worker would make a
// job asynchronous.
const queue = [];
let running = false;
/** Host: queues player p's action `a`. Resolves {ok: true} once it changed
 *  the table, {ok: false} when it changed nothing, and {ok: false, error}
 *  with the notice that refused it (a veto, flood control, a bad deck). */
function enqueue(p, a) {
  return new Promise((resolve) => {
    queue.push({ p, a, resolve });
    if (running) return;
    running = true;
    try {
      while (queue.length && role === 'host') runJob(queue.shift());
    } finally { running = false; }
  });
}
/** The host's internal jobs, by type (never from the wire: PUBLIC_ACTIONS). */
const JOBS = {
  _leave: (p) => T.leave(p),
  _tick: () => T.runTimers(),
  _refuse: (p, a) => T.refreshFor(p, a.a),
  _unsaveable: (p, a) => T.unsaveable(a.why),
};
function runJob({ p, a, resolve }) {
  let changed = true; // a job that threw may have changed something: broadcast and save it
  try {
    changed = own(JOBS, a.t) ? JOBS[a.t](p, a) : T.apply(p, a);
  } catch (err) {
    console.error('action failed', a, err);
    toast(`Error: ${err.message}`);
    commit(changed);
    resolve({ ok: false, error: err.message });
    return;
  }
  const error = commit(changed, p);
  resolve(error ? { ok: false, error } : { ok: changed });
}

const ingesting = new Map(); // host: player → the last of their decks in the works (a chain)
let reserved = 0; // host: the deck budget the guests' decks in the works will take
/** Host: hands player p's action to the queue — after its preprocessing,
 *  for an action that has one. A deck (addDeck) is ingested (store.js: its
 *  images decoded, checked and hashed, in memory) OUTSIDE the queue: a big
 *  deck takes seconds, and nobody's moves wait for it. Each player's decks
 *  are ingested one at a time, in order (a chain per player); a deck is
 *  queued once ingested, so decks commit in the order their ingestion ends
 *  (nothing can refer to a deck before it commits), and its images are kept
 *  only if it did commit (holdImages): a deck refused by the rules or the
 *  budget leaves nothing in the host's memory or storage. A guest's deck is
 *  checked and measured on receipt (cleanDeckV1), before anything is
 *  decoded, against the deck budget minus what the guests' decks in the
 *  works will take (`reserved`: so the chains never hold more than the
 *  budget) — and again at commit. A failure tells the actor and queues
 *  nothing. Resolves like enqueue(). */
function submit(p, a) {
  if (a.t !== 'addDeck') return enqueue(p, a);
  const refuse = (why) => {
    console.error('rejected a deck:', why);
    tell(p, `🚫 Deck rejected: ${why}`);
    return { ok: false, error: why };
  };
  let deck = a.deck, cost = 0;
  if (p !== pid) {
    try { deck = cleanDeckV1(a.deck); } catch (err) { return Promise.resolve(refuse(err.message)); }
    cost = JSON.stringify(deck).length;
    const over = deckOverBudget((T.state.guestDeckChars || 0) + reserved, cost);
    if (over) return Promise.resolve(refuse(over));
    reserved += cost;
  }
  const ingest = () => store.ingestDeck(deck); // after the player's previous deck, however that one ended (its caller hears how)
  const run = (ingesting.get(p) || Promise.resolve()).then(ingest, ingest).then(async ({ deck: v2, assets }) => {
    if (role !== 'host') return { ok: false, error: 'this tab is no longer the host' };
    const done = await enqueue(p, { ...a, deck: v2, cost });
    holdImages(assets);
    return done;
  }, (err) => refuse(err.message)).finally(() => {
    reserved -= cost;
    if (ingesting.get(p) === run) ingesting.delete(p);
  });
  ingesting.set(p, run);
  return run;
}
/** Host: a deck's ingestion is over, and its job ran: of its images
 *  (`assets`), those the table now shows are held — drawn, served, and
 *  saved with the deck (store.js hold) — and any this table showed as
 *  missing show again (the deck was added again). The others go with the job. */
function holdImages(assets) {
  if (role !== 'host') return;
  const refs = T.assetRefs(), ids = [...assets.keys()].filter((h) => refs.has(h));
  store.hold(new Map(ids.map((h) => [h, assets.get(h)])));
  for (const h of ids) imgs.delete(h);
  if (ids.length) imagesArrived(ids);
}

/** Host, after a job: carries out what the table queued and, when it changed
 *  (core renumbered it), broadcasts (coalesced) and saves. Returns the first
 *  refusal notice ("🚫 …") addressed to `actor`, if any. */
function commit(changed, actor) {
  decks = T.state.decks; // the renderer's deck and box maps are the table's own (core may replace them)
  boxes = T.state.boxes;
  const refusal = drain(actor);
  if (changed) { scheduleBroadcast(); persist(); }
  return refusal;
}

/** Routes a local UI action: hosts queue it, guests send it to the host, and
 *  either way the Promise says how it went ({ok, error?}; for a guest: sent).
 *  Until a (signed) state has revealed which peer is the host, the only thing
 *  a guest sends is an anonymous broadcast "hello" knock — identity and the
 *  seat key go ONLY to the authenticated host, never to the whole room.
 *  Every later action carries the stable player id + name + seat key, so the
 *  host can (re)register the player even if the keyed hello got lost, and the
 *  wire version (`_v`). Actions taken while (re)connecting — e.g. a click
 *  during the host's reload — wait in a short queue and go out as soon as the
 *  host is back. */
const pendingActs = [];
function act(a) {
  if (role === 'host') {
    const done = submit(pid, a);
    flush(); // the host's own move shows at once, not on the next tick
    return done;
  }
  if (!room) { console.warn('action before the room is up', a); return Promise.resolve({ ok: false, error: 'not connected yet' }); }
  const target = hostPeer && room.getPeers()[hostPeer] ? hostPeer : null;
  if (!target) {
    if (a.t !== 'hello' && a.t !== 'snap' && a.t !== 'need') { // (an image request times out and asks again)
      pendingActs.push({ a, at: Date.now() });
      if (pendingActs.length > 30) pendingActs.shift();
      note('Reconnecting to the host — your move will be sent when it\'s back');
    }
    knock();
    return Promise.resolve({ ok: false, error: 'waiting for the host' });
  }
  return sendAct({ ...a, _pid: pid, _name: myName, _key: seatKey, _v: PROTO }, target).then(() => ({ ok: true }), (err) => {
    console.error('send failed', err);
    note('Failed to reach the host');
    return { ok: false, error: err.message };
  });
}
/** The anonymous knock: asks whoever hosts this room for a (signed, public) snapshot. */
const knock = () => sendAct({ t: 'hello', _v: PROTO }).catch((err) => console.error('hello failed', err));
/** Sends what was queued while disconnected (moves older than 30 s are stale). */
function flushPending() {
  const fresh = pendingActs.splice(0).filter((x) => Date.now() - x.at < 30000);
  for (const { a } of fresh) act(a);
}

// --- rules engine (see ENGINE.md; it runs in core.js) -------------------------
let rulesCodeDirty = false; // code changed -> resend on next broadcast
let guestRules = { code: '', name: '' }; // guests: the script text, for reading

// Fire due script timers (t.schedule; core.js runTimers()).
setInterval(() => { if (role === 'host') enqueue(RULES, { t: '_tick' }); }, 700);

// --- host <-> guest sync (TABLETOP.md §3) -------------------------------------
// The host keeps every peer's view in step with one coalesced broadcast tick:
// a peer it hasn't synced yet (a newcomer, a reload, a new registration, one
// that asked) gets a snapshot, the others a patch carrying what changed since
// what THAT peer was last sent (its base), or nothing at all. A guest applies
// a patch only on top of exactly that base; anything else is stale (ignored)
// or a gap (it asks for a snapshot). Both carry the epoch `boot`: a restarted
// host counts seq from its save, so a newer epoch always wins.
const SNAP_MIN_MS = 3000; // a peer gets at most one requested snapshot per 3 s
let dirtyDecks = new Set(), dirtyBoxes = new Set(), bcastT = 0; // deck and box ids not yet broadcast; the pending tick
let hostBoot = 0;  // when this tab became host: the state's epoch
let fxQueue = [];  // action markers accumulated since the last broadcast
let annQueue = []; // script announcements (banners) since the last broadcast
/** Host: per peer, what it was last sent: {seq (its next patch's base), to
 *  (whose hand it gets; null: anonymous), snapAt (its last snapshot), needSnap
 *  (it asked for one), timer and asks (a request waiting out SNAP_MIN_MS)}. */
const sync = new Map();
const incompatible = new Set(); // host: peers on another wire version — they get no state

/** Carries out, in order, what the last table calls queued (core.js T.drain()):
 *  action bulbs and banners (for the next broadcast, which shows them here
 *  too), private notices and peek answers, the host's own toasts, and the
 *  decks and rules code the next broadcast must carry. Returns the first
 *  refusal notice for `actor`. (host only) */
function drain(actor) {
  let refusal;
  for (const e of T.drain()) {
    switch (e.t) {
      case 'fx': fxQueue.push(e.f); break;
      case 'ann': annQueue.push(e.msg); break;
      case 'note':
        if (e.p === actor && !refusal && e.msg.startsWith('🚫')) refusal = e.msg;
        tell(e.p, e.msg);
        break;
      case 'peek': if (e.p === pid) showPeek(e.c); else noteTo(e.p, { peek: e.c }); break;
      case 'toast': toast(e.msg); break;
      case 'deck': dirtyDecks.add(e.id); break;
      case 'box': dirtyBoxes.add(e.id); break;
      case 'rules': rulesCodeDirty = true; break;
      default: console.error('unknown table effect', e);
    }
  }
  return refusal;
}
/** Host: box `id` as everyone may see it (spec §2b, PublicBox): the box
 *  without its setup (which may hold hidden information), plus what the
 *  host says of it — where it came from (`src`, `by`) and whether it is
 *  built in (by content: isBuiltin). Guests only display those. */
function publicBox(id) {
  const { setup, ...box } = T.state.boxes[id], info = T.state.boxSrc[id] || { src: 'host' };
  return { ...box, src: info.src, ...(info.by && { by: info.by }), builtin: isBuiltin(T.state.boxes[id]) };
}
/** Host: sends a private note (a notice, a peek answer) to each of player p's connections. */
function noteTo(p, body) {
  for (const [peer, mapped] of Object.entries(peerPid)) {
    if (mapped === p) sendNote({ ...body, to: p }, peer);
  }
}
/** Host: a private notice for player p — this screen's own, or theirs. */
const tell = (p, msg) => (p === pid ? note(msg) : noteTo(p, { msg: msg.slice(0, 200) }));

function scheduleBroadcast() {
  if (!bcastT) bcastT = setTimeout(broadcast, 40);
}
/** Runs a pending broadcast tick now. */
function flush() {
  if (!bcastT) return;
  clearTimeout(bcastT);
  broadcast();
}

/** The broadcast tick (host): takes what changed once (T.takeDirty),
 *  serializes the shared patch once, then sends each peer a snapshot, a patch
 *  from its own base, or nothing. Each body is that peer's fields spliced onto
 *  the shared text (spliceBody), signed, and bound to its connection (`tp`),
 *  so a guest can't replay its state (hand!) to another. The host's own
 *  screen takes the same body, through the guest path, unsigned. */
function broadcast() {
  bcastT = 0;
  if (role !== 'host') return;
  const t0 = performance.now(), host = T.state, seq = host.seq, now = Date.now();
  if (dirtyDecks.size) {
    // Delta, not the whole map: adding a second deck must not re-ship the first.
    if (room) sendDecks(Object.fromEntries([...dirtyDecks].map((id) => [id, decks[id]])));
    dirtyDecks.clear();
  }
  if (dirtyBoxes.size) { // the same for game boxes
    if (room) sendBoxes(Object.fromEntries([...dirtyBoxes].map((id) => [id, publicBox(id)])));
    dirtyBoxes.clear();
  }
  if (rulesCodeDirty) {
    rulesCodeDirty = false;
    if (room) sendRules({ code: host.rules?.code || '', name: host.rules?.name || '' });
  }
  const d = T.takeDirty(), content = T.patchContent(d);
  if (fxQueue.length) content.fx = fxQueue;
  if (annQueue.length) content.ann = annQueue;
  fxQueue = [];
  annQueue = [];
  // boot: this host instance's epoch, host: whose seat the host is.
  const head = { v: PROTO, boot: hostBoot, seq, host: pid };
  const empty = !Object.keys(content).length;
  const patch = sharedText({ ...head, kind: 'patch', ...content });
  let snap = ''; // the snapshot's shared text, built once if anyone needs one this tick
  const snapText = () => (snap ||= sharedText({ ...head, kind: 'snap', ...T.snapContent(), fx: content.fx || [], ann: content.ann || [] }));
  const hand = (p) => ({ hand: host.players[p].hand });
  for (const peer of room ? Object.keys(room.getPeers()) : []) {
    if (incompatible.has(peer)) continue;
    // Peers that haven't introduced themselves yet get the public view only.
    const p = peerPid[peer], to = p && own(host.players, p) ? p : null, st = sync.get(peer);
    if (!st || st.to !== to || (st.needSnap && now - st.snapAt >= SNAP_MIN_MS)) {
      clearTimeout(st?.timer);
      if (!st) sendCatalog(peer); // a newcomer: the catalog first, in its lane, so its first snapshot draws every face
      sendState(spliceBody({ to, tp: peer, ...(to && hand(to)) }, snapText()), peer);
      sync.set(peer, { seq, to, snapAt: now, needSnap: false, timer: 0, asks: 0 });
    } else if (!empty || (to && d.hands.has(to))) {
      sendState(spliceBody({ to, tp: peer, base: st.seq, ...(to && d.hands.has(to) && hand(to)) }, patch), peer);
      st.seq = seq;
    } // else: nothing for this peer — its base stays put
  }
  perf.lastTickMs = performance.now() - t0;
  // this screen, last: the peers' bodies are on their way first
  if (view.boot !== hostBoot) receive(JSON.parse(spliceBody({ to: pid, ...hand(pid) }, snapText())));
  else if (!empty || d.hands.has(pid)) receive(JSON.parse(spliceBody({ to: pid, base: view.seq, ...(d.hands.has(pid) && hand(pid)) }, patch)));
}

/** Host: sends peer the whole public catalog — the decks, the game boxes
 *  (publicBox) and the rules code — through its lane, ahead of its first
 *  snapshot. Everything sent later to everyone is a delta. */
function sendCatalog(peer) {
  sendDecks(decks, peer);
  sendBoxes(Object.fromEntries(Object.keys(boxes).map((id) => [id, publicBox(id)])), peer);
  if (T.state.rules) sendRules({ code: T.state.rules.code, name: T.state.rules.name }, peer);
}

/** Host: peer asked for a snapshot (a `snap` action, or an anonymous knock).
 *  Each peer gets at most one per SNAP_MIN_MS — it costs a signature over the
 *  whole table: an early request waits out the window on one timer, and the
 *  extra ones are counted and reported once. */
function wantSnap(peer) {
  perf.snapRequests++;
  const st = sync.get(peer);
  if (!st) { scheduleBroadcast(); return; } // not synced yet: its first tick sends one anyway
  st.needSnap = true;
  const wait = st.snapAt + SNAP_MIN_MS - Date.now();
  if (wait <= 0) { scheduleBroadcast(); return; }
  if (st.timer) { st.asks++; return; }
  st.timer = setTimeout(() => {
    if (st.asks) console.warn(`${st.asks} more snapshot requests from ${peer} within ${SNAP_MIN_MS / 1000} s (rate-limited)`);
    st.timer = 0;
    st.asks = 0;
    scheduleBroadcast();
  }, wait);
}

/** Host: a fresh epoch — another host instance showed up, and guests that
 *  followed it (a newer boot) must accept us again. Everyone, this screen
 *  included, gets a snapshot. */
function newEpoch() {
  hostBoot = Math.max(Date.now(), hostBoot + 1);
  for (const st of sync.values()) clearTimeout(st.timer);
  sync.clear();
  scheduleBroadcast();
}

/** Host → guest: another host holds fresher state. Stops being the authority
 *  — no more broadcasts, saves or queued jobs — and takes the next snapshot,
 *  of whichever epoch. */
function demote() {
  console.warn('another host is active — demoting to guest');
  toast('This table is open in another tab — this one is now a viewer');
  role = 'guest';
  for (const st of sync.values()) clearTimeout(st.timer);
  sync.clear();
  peerPid = {};
  clearTimeout(bcastT);
  clearTimeout(persistT);
  bcastT = persistT = 0;
  for (const job of queue.splice(0)) job.resolve({ ok: false, error: 'this tab is no longer the host' });
  for (const box of outbox.values()) clearTimeout(box.wait);
  outbox.clear();
  T = null;
  view.boot = 0;
  $('size-sel').classList.add('hidden');
}

const LANE_MAX = 64; // bodies a peer's lane may hold waiting (see connect())
const lanes = new Map(); // host: peer → its lane {q: [body, send] waiting, busy: one in flight, over: dropping until it drains, lost: it dropped a catalog body, idle: waiters}
/** Host: queues sealed body m for peer, in its lane (see connect()), to go
 *  out through `send` — a state's, or a catalog channel's (decks, boxes, rules). */
function laneSend(m, peer, send = stateSend) {
  const L = lanes.get(peer) || lanes.set(peer, { q: [], busy: false, over: false, lost: false, idle: [] }).get(peer);
  if (!L.over && L.q.length >= LANE_MAX) {
    console.warn(`the lane to ${peer} backed up (${LANE_MAX} bodies waiting): dropped them, and a fresh snapshot follows once it drains`);
    L.lost = L.q.some(([, s]) => s !== stateSend);
    L.q.length = 0;
    L.over = true;
  }
  if (L.over) { L.lost ||= send !== stateSend; return; }
  L.q.push([m, send]);
  if (!L.busy) drainLane(peer, L);
}
/** Sends lane L's bodies one by one; once it is empty, wakes laneIdle()'s
 *  waiters, and a lane that overflowed asks for its peer's snapshot — or,
 *  when it dropped part of the catalog, starts that peer over: the next tick
 *  sends it the whole catalog and a snapshot, as to a newcomer. */
async function drainLane(peer, L) {
  L.busy = true;
  while (L.q.length) {
    const [m, send] = L.q.shift();
    try { await send(m, peer); } catch (err) { console.error('a send to', peer, 'failed', err); } // a state's loss: the guest's gap recovery covers it
  }
  L.busy = false;
  for (const wake of L.idle.splice(0)) wake();
  if (L.over && lanes.get(peer) === L) {
    L.over = false;
    if (role !== 'host') return;
    if (L.lost) { clearTimeout(sync.get(peer)?.timer); sync.delete(peer); scheduleBroadcast(); } else wantSnap(peer); // (rate-limited like any request)
    L.lost = false;
  }
}
/** Resolves once peer's lane has sent what it holds (at once when it is empty). */
const laneIdle = (peer) => new Promise((wake) => { const L = lanes.get(peer); if (L?.busy) L.idle.push(wake); else wake(); });

let registered = false; // guest: the host has bound our seat (we got a state addressed to us)
let lastIntro = 0;
/** Guest, until a state addressed to us arrives: presents identity + seat key
 *  to the (authenticated) host — or knocks, while we don't know which peer that
 *  is. Either way the host answers with a snapshot (rate-limited, wantSnap):
 *  the one that registered us may have been lost, and a quiet table would
 *  never send another. At most once per 2 s, so a registration snapshot that
 *  is merely slow isn't asked for twice. */
function introduce() {
  if (Date.now() - lastIntro < 2000) return;
  lastIntro = Date.now();
  act({ t: 'hello' });
}

let skewWarned = false; // the "different version" toast shows once
/** A state body from the network: already unsealed and bound to this
 *  connection (fromHost). Checks the version, settles two-host collisions,
 *  then takes it as a guest (receive). */
function handleState(d, peer) {
  if (!d || typeof d !== 'object') return;
  if (d.v !== PROTO) {
    if (!skewWarned) {
      skewWarned = true;
      console.error(`the host speaks wire protocol ${d.v}, this page ${PROTO}`);
      toast('The host runs a different version of Card Table — reload this page');
    }
    return;
  }
  if (!Number.isFinite(d.seq) || !Number.isFinite(d.boot)) { console.warn('dropped a malformed state', d.kind); return; }
  if (role === 'host') {
    // Two live hosts (a stale resume, or the invite opened twice in the host's
    // browser). The fresher state wins; peerId breaks the tie deterministically.
    // In a signed room only a holder of this room's key can get this far.
    if (d.seq > T.state.seq || (d.seq === T.state.seq && peer < selfId)) demote();
    else { newEpoch(); return; }
  }
  receive(d, peer);
}

let resyncing = false, resyncT = 0; // guest: waiting for a snapshot after a gap; the timer that asks again
/** Takes one state body addressed to this tab (the host's own screen comes
 *  here too, with no peer): a snapshot replaces the view, the patch that
 *  follows it is folded in, and only what changed is redrawn. A patch that
 *  doesn't follow is never applied: older ones are stale, newer ones mean a
 *  lost message, and the guest asks for a snapshot instead. perf.lastApplyMs
 *  times all of it: the fold and every redraw. */
function receive(d, peer) {
  if (d.to && d.to !== pid) return; // addressed to someone else: a replay
  const t0 = performance.now(), drawn0 = perf.drawn;
  let prev = null, players = null;
  if (d.kind === 'snap') {
    // A NEWER epoch is always accepted, an older one never is (a replay).
    if (d.boot < view.boot || (d.boot === view.boot && d.seq < view.seq)) return;
    const hand = view.hand;
    view = viewFromSnap(d);
    if (!Array.isArray(d.hand)) view.hand = hand; // a public snapshot: our hand stands until the host knows us again
    resyncing = false;
    clearTimeout(resyncT);
    resyncT = 0;
    perf.snaps++;
  } else if (d.kind === 'patch' && d.boot === view.boot && d.base === view.seq) {
    ({ items: prev, players } = applyViewPatch(view, d));
    perf.patches++;
  } else if (d.kind === 'patch') {
    if (d.boot < view.boot || (d.boot === view.boot && d.seq <= view.seq)) return; // stale, or a duplicate
    console.warn('state gap', view.seq, '→', d.base);
    perf.gaps++;
    requestSnap();
    return;
  } else { console.warn('dropped a state of unknown kind', d.kind); return; }
  if (peer) {
    hostPeer = peer;
    registered = d.to === pid;
    if (!registered) introduce(); // the host doesn't know this seat yet
    if (pendingActs.length) flushPending();
  }
  if (view.table.shape !== TABLE.shape || view.table.w !== TABLE_W || view.table.h !== TABLE_H || view.table.felt !== TABLE.felt) setTable(view.table);
  for (const read of (peer && early.get(peer)?.splice(0)) || []) read(); // the catalog it sent just before: every face draws at once
  renderAll(prev, players);
  // B10: a snapshot's whole render — the fold, the catalog held for it, the
  // DOM (every piece with its face: the catalog came first), and the style
  // and layout it costs (read now, which the browser would do before the
  // next frame anyway). Only a snapshot that drew items counts: a guest's
  // first snapshot draws the table, the one that registers it a moment
  // later (the same items) redraws nothing.
  if (d.kind === 'snap' && perf.drawn > drawn0) { void tableEl.offsetHeight; perf.lastSnapRenderMs = performance.now() - t0; }
  for (const f of Array.isArray(d.fx) ? d.fx : []) {
    if (Array.isArray(f?.roll)) for (const id of f.roll) { const el = itemEls.get(id); if (el) pieces.tumble(el); } // every screen, the roller's too
    if (f?.p !== pid) showFx(f); // own actions stay silent
  }
  for (const msg of Array.isArray(d.ann) ? d.ann : []) showAnnounce(msg);
  perf.lastApplyMs = performance.now() - t0;
}
/** Guest: a patch didn't follow our view — ask the host for a snapshot, at
 *  most once per SNAP_MIN_MS, and again every SNAP_MIN_MS until one arrives:
 *  the request or its answer can be lost (flood control refuses it, a send
 *  fails), and a quiet table would never show another gap. The status
 *  tooltip says we're re-syncing. */
function requestSnap() {
  resyncing = true;
  updateNet();
  if (resyncT) return; // asked less than SNAP_MIN_MS ago: the timer asks again
  act({ t: 'snap' });
  resyncT = setTimeout(() => { resyncT = 0; if (resyncing) requestSnap(); }, SNAP_MIN_MS);
}

const refusedAt = {}; // host: peer → last refusal notice (no toast storms)
/** Host: turns away a peer's action, loudly on both ends. */
function refuse(peer, reason) {
  console.warn(`refused an action from ${peer}: ${reason}`);
  if (Date.now() - (refusedAt[peer] || 0) < 10000) return;
  refusedAt[peer] = Date.now();
  sendNote({ msg: `🚫 ${reason}`, to: null }, peer);
}

// --- card images: pulled by hash ------------------------------------------------
// Decks name their images by asset id; the bytes travel apart, on their own
// channel, only when asked for, and only from the host. A guest asks for the
// ones it holds neither in memory nor in IndexedDB (`need`, NEED_BATCH ids
// a request, a few requests a second). The host sends each one this table
// shows — never another room's: its image store is shared by every room this
// browser hosted — paced per peer, after that peer's pending states, within
// a byte budget a minute (past it, the rest waits for the next minute, and
// the guest is told so), and names the ones it lacks (a `missing` note).
// Nothing waits forever: a request the host (while it is here) leaves
// unanswered for NEED_TIMEOUT_MS is asked again once, then the image counts
// as missing, as does one that arrives damaged twice.
const NEED_BATCH = 64, NEED_PER_S = 8, NEED_TIMEOUT_MS = 20000;
const ASSET_INFLIGHT = 2, PEER_ASSET_BUDGET = 64e6, ASSET_WINDOW_MS = 60000;
/** What this tab knows of each image it shows but doesn't hold yet
 *  (store.holds): 'load' (being read from IndexedDB — for good on a host
 *  whose storage went away: it was told to reload), 'missing' (it won't
 *  come: drawn struck out), or on a guest {at, tries}: asked of the host
 *  (at: when last asked, 0 while the request waits to go out; tries: how often). */
const imgs = new Map();
const badBoxes = new Set(); // guest: the ids of boxes from the host that failed cleanBox (said once each)
let heardAt = 0; // guest: when the host last showed progress on our requests (an image came, it said to wait, it came back)
/** The images this guest asks the host for. */
const asked = () => [...imgs].filter(([, x]) => typeof x === 'object').map(([h]) => h);
/** What the image cache's GC must spare: the images of the decks this tab shows, and those it is pulling. */
const keepImages = () => new Set([...assetRefs(decks, boxes), ...asked()]);
/** Guest: whether the host is reachable now (act() would send to it). */
const hostHere = () => !!(room && hostPeer && room.getPeers()[hostPeer]);

/** Gets images `ids` this tab doesn't hold yet: from IndexedDB, else (a
 *  guest) from the host. The host's own images come from its storage only:
 *  what that lacks is missing (the boot check said so). */
function wantImages(ids) {
  const fresh = ids.filter((h) => !store.holds(h) && !imgs.has(h));
  if (!fresh.length) return;
  for (const h of fresh) imgs.set(h, 'load');
  Promise.all(fresh.map((h) => store.loadAsset(h).catch((err) => { console.error('reading a cached image failed', h, err); return undefined; })))
    .then((urls) => {
      const got = fresh.filter((_, k) => urls[k]);
      const lack = fresh.filter((_, k) => urls[k] === null), unread = fresh.filter((_, k) => urls[k] === undefined);
      for (const h of got) imgs.delete(h);
      if (got.length) imagesArrived(got);
      if (role !== 'host') { askHost([...lack, ...unread]); return; }
      if (lack.length) giveUp(lack);
      if (unread.length) toast(`Couldn't read ${unread.length} card images from this browser's storage — reload this page`); // (they stay loading: never "missing")
    });
}
// Deck messages are deltas (or the full map for new joiners) — always merge,
// re-sanitized here too (defense in depth, and legacy unsigned rooms).
/** Guest: decks `d` ({deckId: deck}) from the host (or kept across a reload: keepPaused). */
function takeDecks(d) {
  if (role === 'host' || !d || typeof d !== 'object') return;
  const got = [];
  for (const [id, deck] of Object.entries(d)) {
    if (!/^[0-9a-f]{8}$/.test(id)) { console.warn('ignored a deck with a bad id', id); continue; }
    try { decks[id] = cleanDeck(deck); got.push(id); } catch (err) { console.error(`deck ${id} rejected`, err); }
  }
  // Their images: from memory, IndexedDB or the host, all in one go (before
  // the redraw asks for them face by face). A new decks message (the host
  // is back, or added the deck again) gives the images we gave up on another chance.
  const refs = [...assetRefs(got.map((id) => decks[id]))];
  for (const h of refs) if (imgs.get(h) === 'missing') imgs.delete(h);
  wantImages(refs);
  arrived(itemsByDeck, got, (z) => got.includes(z.d));
}
// Game boxes, the same way: deltas (the whole catalog for a new
// connection), each passing cleanBox here. A box that fails is dropped,
// loudly (once per box): its pieces draw as "?" placeholders. What the host
// says of a box (src, by, builtin) is only ever displayed.
/** Guest: game boxes `d` ({boxId: box and src, by, builtin}) from the host (or kept across a reload). */
function takeBoxes(d) {
  if (role === 'host' || !d || typeof d !== 'object') return;
  const got = [];
  for (const [id, b] of Object.entries(d)) {
    if (!/^[0-9a-f]{8}$/.test(id)) { console.warn('ignored a game box with a bad id', id); continue; }
    try {
      boxes[id] = cleanBox(b);
      boxInfo[id] = { src: ['host', 'upload', 'script'].includes(b.src) ? b.src : 'host', ...(PID_RE.test(b.by) && { by: b.by }), builtin: b.builtin === true };
      got.push(id);
    } catch (err) {
      console.error(`game box ${id} from the host rejected`, err);
      if (!badBoxes.has(id)) { badBoxes.add(id); toast(`A game box from the host couldn't be read: ${err.message}`); }
    }
  }
  const refs = [...assetRefs({}, got.map((id) => boxes[id]))];
  for (const h of refs) if (imgs.get(h) === 'missing') imgs.delete(h);
  wantImages(refs);
  arrived(itemsByBox, got, (z) => 't' in z && got.includes(pieces.boxIdOf(z.t)));
}
let askT = 0;
/** Guest: asks the host for images `ids`. Requests are gathered for a
 *  moment (faces want their images one by one, and each request costs a
 *  token of the host's flood control), then go out NEED_BATCH ids each, at
 *  most NEED_PER_S a second, and only while the host is here. */
function askHost(ids) {
  for (const h of ids) imgs.set(h, { at: 0, tries: imgs.get(h)?.tries || 0 });
  askT ||= setTimeout(sendAsks, 50);
}
function sendAsks() {
  askT = 0;
  const now = Date.now(), wait = asked().filter((h) => !imgs.get(h).at);
  if (!wait.length) return;
  if (hostHere()) {
    const go = wait.slice(0, NEED_BATCH * NEED_PER_S);
    for (let k = 0; k < go.length; k += NEED_BATCH) act({ t: 'need', a: go.slice(k, k + NEED_BATCH) });
    for (const h of go) Object.assign(imgs.get(h), { at: now, tries: imgs.get(h).tries + 1 });
    if (go.length === wait.length) return;
  }
  askT = setTimeout(sendAsks, 1000);
}
// Requests the host left unanswered: asked again once, then given up on. A
// host that is away isn't late: the clock starts again once it is back.
setInterval(() => {
  if (role !== 'guest') return;
  const now = Date.now();
  if (!hostHere()) { heardAt = now; return; }
  const late = [...imgs].filter(([, x]) => x.at && now - Math.max(x.at, heardAt) > NEED_TIMEOUT_MS);
  const again = late.filter(([, x]) => x.tries < 2).map(([h]) => h), gone = late.filter(([, x]) => x.tries >= 2).map(([h]) => h);
  if (again.length) { console.warn(`${again.length} image requests went unanswered — asking again`); askHost(again); }
  if (gone.length) giveUp(gone, `${gone.length} card images are missing on the host — ask them to re-add the deck`);
}, 2000);
/** Stops waiting for images `ids`: their sides show as missing, loudly
 *  (`msg`: a toast too). */
function giveUp(ids, msg) {
  for (const h of ids) imgs.set(h, 'missing');
  console.error(msg || 'card images are missing from this browser\'s storage', ids);
  imagesArrived(ids, true);
  if (msg) toast(msg);
}

/** Guest: image bytes on the `asset` channel. Unsigned, so taken only from
 *  the host, only when asked for, and only if they pass store.putAsset's
 *  checks: the type and its magic bytes, ≤ ASSET_MAX_BYTES, the pixel size
 *  in the header (imageDims), and the hash. Anything else is dropped; a
 *  damaged image is asked for again once. */
function receiveImage(data, peer, meta) {
  const h = peerText(meta?.h), x = imgs.get(h);
  if (role !== 'guest' || peer !== hostPeer) { console.warn('dropped an image that did not come from the host', peer); return; }
  if (typeof x !== 'object') { console.warn('dropped an image nobody asked for', h.slice(0, 16)); return; }
  heardAt = Math.max(heardAt, Date.now()); // (a host that said to wait has its say until then)
  store.putAsset(ArrayBuffer.isView(data) ? data : new Uint8Array(0), peerText(meta?.mime), h).then(() => {
    imgs.delete(h);
    imagesArrived([h]);
  }, (err) => {
    console.error('a card image from the host failed its checks', h, err);
    if (store.holds(h) || imgs.get(h) !== x) return; // another copy made it, or it was asked for again meanwhile
    if (x.tries < 2) {
      toast('A card image from the host was damaged in transit — retrying');
      askHost([h]);
    } else giveUp([h], 'A card image from the host arrived damaged again — it shows as missing');
  });
}

const outbox = new Map(); // host: peer → its image queue {q, queued, inflight, sent: Map<id, {at, n}>, since, bytes, warned, wait}
/** Host: peer asked for images `list` (a need, ≤ NEED_BATCH ids): queues
 *  the ones this table shows and this browser holds, names the ones it lacks
 *  (missing), and ignores the rest. The same image goes to the same peer at
 *  most twice a minute (a guest asks again once, when one arrives damaged). */
async function serveImages(peer, list) {
  const refs = T.assetRefs(), now = Date.now();
  const box = outbox.get(peer) || outbox.set(peer, { q: [], queued: new Set(), inflight: 0, sent: new Map(), since: now, bytes: 0, warned: false, wait: 0 }).get(peer);
  const want = (Array.isArray(list) ? list.slice(0, NEED_BATCH) : []).filter((h) => typeof h === 'string' && ASSET_RE.test(h));
  const ids = want.filter((h) => {
    const s = box.sent.get(h);
    return refs.has(h) && !box.queued.has(h) && !(s && now - s.at < ASSET_WINDOW_MS && s.n >= 2);
  });
  const foreign = want.filter((h) => !refs.has(h)).length;
  if (foreign) console.warn(`${peer} asked for ${foreign} images this table doesn't show — ignored`);
  for (const h of ids) box.queued.add(h);
  let lack;
  try { lack = new Set(await store.lacking(ids)); } catch (err) { // never "missing": this browser can't read them now
    console.error(`looking up the images ${peer} asked for failed`, err);
    for (const h of ids) box.queued.delete(h);
    return;
  }
  for (const h of lack) box.queued.delete(h);
  if (lack.size) missing(peer, [...lack]);
  if (outbox.get(peer) !== box) return; // the peer left meanwhile
  box.q.push(...ids.filter((h) => !lack.has(h)));
  pumpImages(peer, box);
}
/** Host: tells peer, loudly, that this browser lacks images `ids` of this table (a `missing` note). */
function missing(peer, ids) {
  console.error(`${peer} asked for ${ids.length} images of this table that this browser doesn't hold`, ids);
  sendNote({ missing: ids, to: peerPid[peer] ?? null }, peer);
}
/** Host: keeps up to ASSET_INFLIGHT image sends going to peer (none while its budget waits for the next window). */
function pumpImages(peer, box) {
  while (!box.wait && box.inflight < ASSET_INFLIGHT && box.q.length) {
    const h = box.q.shift();
    box.inflight++;
    sendImage(peer, box, h).then((done) => { if (done) box.queued.delete(h); }, (err) => {
      console.error('sending an image failed', h, err);
      box.queued.delete(h);
    }).finally(() => {
      box.inflight--;
      if (outbox.get(peer) === box) pumpImages(peer, box);
    });
  }
}
/** Host: sends image h to peer, once its pending states are out. A peer
 *  gets at most PEER_ASSET_BUDGET bytes of images per ASSET_WINDOW_MS: past
 *  that, h and the rest of its queue wait for the next window (false), and
 *  the peer is told once, with how long (`wait`), so a guest pulling a big
 *  table keeps waiting rather than giving up, and nobody can make the host
 *  send more. True once h is sent, or reported missing. */
async function sendImage(peer, box, h) {
  await laneIdle(peer); // states first: play stays live during a big pull
  const img = await store.getAsset(h), now = Date.now();
  if (!img) { missing(peer, [h]); return true; }
  if (now - box.since > ASSET_WINDOW_MS) Object.assign(box, { since: now, bytes: 0, warned: false });
  if (box.bytes + img.data.byteLength > PEER_ASSET_BUDGET) {
    const wait = box.since + ASSET_WINDOW_MS - now;
    box.q.unshift(h);
    box.wait ||= setTimeout(() => { box.wait = 0; if (outbox.get(peer) === box) pumpImages(peer, box); }, wait + 1);
    if (!box.warned) {
      box.warned = true;
      console.warn(`${peer} is over its image budget (${PEER_ASSET_BUDGET / 1e6} MB a minute): the rest waits ${Math.ceil(wait / 1000)} s`);
      sendNote({ msg: '🚫 Too many image requests — slow down', wait, to: peerPid[peer] ?? null }, peer);
    }
    return false;
  }
  box.bytes += img.data.byteLength;
  const s = box.sent.get(h);
  box.sent.set(h, s && now - s.at < ASSET_WINDOW_MS ? { at: s.at, n: s.n + 1 } : { at: now, n: 1 });
  await sendAsset(img.data, peer, { h, mime: img.mime });
  return true;
}

function connect() {
  /** The page's RTCPeerConnection, for Trystero (D95). Each page keeps a
   *  pool of 20 offers made in advance; Trystero 0.25.3 hands out one older
   *  than 57 s by an ICE restart that first rolls the unanswered offer back.
   *  In Chromium and WebKit (Safari, every iOS browser) that rollback drops
   *  the data channel's m-line (Firefox keeps it), so the restart's offer is
   *  empty and the peer that answers it never links: a guest joining or
   *  reloading into a room whose host has been open for over a minute (or a
   *  host reloading beside a guest that has), whenever the older page's id
   *  sorts first and so makes the offer. Here a rollback of an offer never
   *  answered (no remote description yet) does nothing: the restart
   *  re-offers the same connection, whole. Trystero 0.26 skips that
   *  restart's rollback itself; this class skips every such rollback, so a
   *  remote offer that collides with ours (glare: Trystero rolls back, then
   *  takes it) is left to setRemoteDescription, which rolls ours back
   *  implicitly. (tests/h.js hands the raw test peers this very class, cut
   *  from this file's text.) */
  class WholeOffers extends RTCPeerConnection {
    setLocalDescription(d) {
      return d?.type === 'rollback' && !this.remoteDescription ? Promise.resolve() : super.setLocalDescription(d);
    }
  }
  // window.CARDTABLE_RELAYS overrides the default public Nostr relays (tests, self-hosting).
  // redundancy 10 (default 5): more relays per room = better odds that two
  // peers share a live one when parts of the public infrastructure are down.
  const relays = window.CARDTABLE_RELAYS;
  joinAt = Date.now();
  hostSeenAt ||= joinAt;
  room = joinRoom({ appId: 'gk-cardtable', password, rtcPolyfill: WholeOffers, relayConfig: relays ? { urls: relays } : { redundancy: 10 } }, roomId);
  const actA = room.makeAction('act');
  const stateA = room.makeAction('state');
  const decksA = room.makeAction('decks');
  const boxesA = room.makeAction('boxes');
  const noteA = room.makeAction('note');
  const rulesA = room.makeAction('rules');
  const assetA = room.makeAction('asset');
  // Host → guest channels are signed in send order (sealing is async, the
  // queue keeps it FIFO); guests verify them in arrival order the same way.
  // Bodies are sealed as JSON text: a state is spliced from the tick's shared text.
  let sealQ = Promise.resolve();
  const signed = (what, send) => (data, target) => {
    const sealed = sealQ.then(() => seal(typeof data === 'string' ? data : JSON.stringify(data)));
    sealQ = sealed.catch((err) => console.error(`signing a ${what} failed`, err)); // keeps the FIFO alive
    return sealed.then((m) => send(m, target)).catch((err) => console.error(`${what} send failed`, err));
  };
  // A peer's states go out one at a time, in a lane: Trystero chunks each
  // message in a loop of its own, so a one-chunk patch sent while a big
  // snapshot is still being chunked would arrive first, and the guest would
  // drop it as a gap, and every patch after it. Each send starts once the one
  // before it to that peer is done (Trystero resolves when every chunk is on
  // the ordered channel). The catalog (decks, boxes, rules) takes the same
  // lane, so a newcomer gets it before its first snapshot (sendCatalog) and
  // draws the table's faces at once. A lane that backs up (its peer stopped
  // reading, or its link stalled) must not grow for as long as that lasts:
  // past LANE_MAX waiting bodies they are all dropped, the lane takes nothing
  // until it drains, and then that peer gets one fresh snapshot instead of a backlog.
  stateSend = (m, peer) => stateA.send(m, { target: peer });
  sendAsset = (data, peer, meta) => assetA.send(data, { target: peer, metadata: meta });
  // States and notes always go to one peer: its connection id (`tp`) is
  // signed into the body, so a copy relayed to anyone else is dropped.
  const bound = (send) => (data, target) => send({ ...data, tp: target }, target);
  /** A catalog channel's sender: through the lane of `target`, or of every peer. */
  const laned = (A) => (m, target) => { for (const peer of target ? [target] : Object.keys(room.getPeers())) laneSend(m, peer, (b, to) => A.send(b, { target: to })); };
  sendAct = (data, target) => actA.send(data, target ? { target } : {});
  sendState = signed('state', laneSend); // the tick splices `tp` in itself
  sendDecks = signed('decks', laned(decksA));
  sendBoxes = signed('boxes', laned(boxesA));
  sendNote = bound(signed('note', (m, target) => noteA.send(m, { target })));
  sendRules = signed('rules', laned(rulesA));
  // A signature proves the host wrote a message, not who delivers it: any
  // peer could relay one (e.g. to pose as the host and harvest seat keys).
  // So states and notes must name THIS connection (`tp`, see bound()), and the
  // other channels must come from the peer whose state we accepted. The host
  // sends a newcomer its catalog just BEFORE its first state, so what a peer
  // we don't know as the host sends there is held (early), and read only
  // once that peer's state makes it the host (receive): never otherwise.
  let inbox = Promise.resolve();
  const fromHost = (fn, isBound) => (m, { peerId }) => {
    inbox = inbox.then(async () => {
      const d = await unseal(m);
      if (d == null) return;
      if (isBound && d.tp !== selfId) { console.warn('dropped a host message relayed by', peerId); return; }
      if (!isBound && peerId !== hostPeer) {
        const held = early.get(peerId) || early.set(peerId, []).get(peerId);
        if (held.length < EARLY_MAX) held.push(() => fn(d, peerId));
        else console.warn('dropped a host message relayed by', peerId, '(too many held)');
        return;
      }
      fn(d, peerId);
    }).catch((err) => console.error('message from the host failed', err));
  };
  noteA.onMessage = fromHost((n) => {
    if (role === 'host' || !n || (n.to && n.to !== pid)) return;
    if (num(n.wait) > 0) { // the host paces our image pull (its budget a minute): we keep waiting, and say why
      heardAt = Math.max(heardAt, Date.now() + Math.min(num(n.wait), ASSET_WINDOW_MS));
      note(`Card images are coming slowly — the host sends at most ${PEER_ASSET_BUDGET / 1e6} MB of them a minute`);
    } else if (n.msg) note(String(n.msg)); // toast + the terminal bridge
    if (n.peek && n.to === pid) { // the host's private answer to our peek: a card {d, i}, or a piece {t, f}
      showPeek('t' in n.peek ? { t: peerText(n.peek.t), f: num(n.peek.f, -1) } : { d: peerText(n.peek.d), i: num(n.peek.i, -1) });
    }
    if (Array.isArray(n.missing)) { // images we asked for that the host doesn't hold
      const gone = n.missing.filter((h) => typeof imgs.get(h) === 'object');
      if (gone.length) giveUp(gone, `${gone.length} card images are missing on the host — ask them to re-add the deck`);
    }
  }, true);
  rulesA.onMessage = fromHost((r) => { if (role !== 'host') guestRules = { code: String(r?.code || ''), name: String(r?.name || '') }; });
  stateA.onMessage = fromHost(handleState, true);
  // Images: unsigned, so taken only from the host, only when asked for, and
  // only once their bytes check out (receiveImage).
  assetA.onMessage = (data, { peerId, metadata }) => receiveImage(data, peerId, metadata);
  decksA.onMessage = fromHost(takeDecks);
  boxesA.onMessage = fromHost(takeBoxes);

  actA.onMessage = (a, { peerId: peer }) => {
    if (role !== 'host' || !a || typeof a !== 'object') return; // only the host adjudicates
    // Another version of the app would misread our bodies: refuse it, and send it no state.
    if (a._v !== PROTO) {
      incompatible.add(peer);
      refuse(peer, 'This table runs a different version of Card Table — reload this page');
      return;
    }
    incompatible.delete(peer);
    // An anonymous knock: answer with a (signed) public snapshot, so the guest
    // learns who the authenticated host is before revealing its identity.
    if (a._pid == null) { if (a.t === 'hello') wantSnap(peer); return; }
    const { _pid: p, _name: name, _key: key, _v, ...action } = a;
    if (HOST_ACTIONS.has(action.t)) { refuse(peer, 'Only the host can do that'); return; }
    if (!PUBLIC_ACTIONS.has(action.t)) { refuse(peer, 'Unknown action — reload this page'); return; }
    const reason = p === pid ? 'This seat is already open in another tab'
      : typeof p !== 'string' || !PID_RE.test(p) ? 'Invalid player id' // (a crafted {"toString": 1} would make test() throw)
      : typeof key !== 'string' || key.length < 16 ? 'Missing seat key — please reload'
      : peerPid[peer] && peerPid[peer] !== p ? 'One seat per connection'
      : own(T.state.keys, p) && T.state.keys[p] !== key ? 'That seat belongs to another player'
      : '';
    if (reason) { refuse(peer, reason); return; }
    if (!T.mayAct(p)) {
      refuse(peer, 'Too many actions — slow down');
      enqueue(p, { t: '_refuse', a: action }); // what it named goes out again (rate-limited): the guest's optimistic move snaps back
      return;
    }
    // Register/refresh the sender on EVERY action, not just hello — if the
    // keyed hello was lost, the first real action still registers the player
    // (and binds the seat key; onJoin runs if they are new or back). The next
    // tick sends a newly registered peer a snapshot with its hand.
    const newConn = peerPid[peer] !== p;
    peerPid[peer] = p;
    const { known, changed } = T.join(p, name, key);
    if (changed) commit(true);
    else if (newConn) scheduleBroadcast(); // a second tab of a seated player: its first snapshot
    // (the catalog went out with this connection's first snapshot: sendCatalog)
    // Every action carries the sender's current name: a rename the host
    // never received (made while it was away, or in another room) syncs on
    // the next connection, through the logged (and rate-limited) rename path.
    const nm = cleanName(name);
    if (known && nm && nm !== known.name && newConn && action.t !== 'name') enqueue(p, { t: 'name', name: nm });
    // A keyed hello comes only from a guest that hasn't had a state addressed
    // to it (introduce): one that answers it may be lost, so it asks for one too.
    if (action.t === 'snap' || action.t === 'hello') wantSnap(peer);
    if (action.t === 'need') serveImages(peer, action.a);
    submit(p, action);
  };

  room.onPeerJoin = () => {
    updateNet();
    if (role === 'host') scheduleBroadcast(); // the newcomer gets a signed public snapshot
    else if (!registered) act({ t: 'hello' }); // a host may be back; a bound seat has nothing to ask
  };
  room.onPeerLeave = (peer) => {
    updateNet();
    if (early.get(peer)?.length) console.warn(`dropped ${early.get(peer).length} host messages relayed by`, peer, '(it never showed it hosts)');
    early.delete(peer);
    if (peer === hostPeer) { // the table is paused: say so (hint + host seat greyed), knock again when a host reappears
      hostPeer = null;
      registered = false;
      renderAll();
    }
    if (role !== 'host') return;
    clearTimeout(sync.get(peer)?.timer);
    sync.delete(peer);
    if (lanes.has(peer)) lanes.get(peer).q.length = 0;
    lanes.delete(peer);
    clearTimeout(outbox.get(peer)?.wait);
    outbox.delete(peer);
    incompatible.delete(peer);
    const p = peerPid[peer];
    delete peerPid[peer];
    if (p && !Object.values(peerPid).includes(p)) enqueue(p, { t: '_leave' });
  };
}
// Belt and braces: until the host has bound our seat, keep knocking — covers
// hellos (or their answers) lost in connection churn and a host that comes
// back after a reload.
setInterval(() => { if (room && role === 'guest' && !registered) introduce(); }, 3000);

/** Open WebSockets to signaling relays right now. 0 = we're invisible. */
function openRelays() {
  try {
    return Object.values(getRelaySockets()).filter((s) => s?.readyState === 1).length;
  } catch (err) { console.error('relay status unavailable', err); return 0; }
}

// The grace periods below count from when this page joined the room
// (connect), not from when it loaded: a first-time player may spend a while
// in the name dialog before it.
let joinAt = 0;
const RELAY_GRACE_MS = 10000;
let relaysSeen = false; // a relay has been open on this page
function updateNet() {
  const n = room ? Object.keys(room.getPeers()).length : 0;
  const r = openRelays();
  relaysSeen ||= r > 0;
  netEl.classList.toggle('on', n > 0);
  netEl.classList.toggle('dead', r === 0);
  netEl.textContent = n > 0 ? `● ${n + 1}` : r > 0 ? '● …' : '● ✕';
  netEl.title = `${n + 1} player${n ? 's' : ''} here · ${r} signaling relays connected${r ? '' : ' — searching for relays'}${resyncing ? ' · re-syncing with the host…' : ''}`;
  if (role === 'guest') {
    hintEl.classList.toggle('hidden', view.seq > 0 && !!hostPeer);
    // Our own side first: with no peers and no relays, it's OUR connection
    // that is down, never the host — once the relays were up on this page
    // (lost), or had RELAY_GRACE_MS since joining to come up (never
    // reached). Until then (and before it joins) a page with no table is
    // still connecting, and one the watchdog reloaded for an absent host
    // shows its kept table, paused.
    const ours = !!room && n === 0 && r === 0 && (relaysSeen || Date.now() - joinAt > RELAY_GRACE_MS);
    hintEl.textContent = ours ? (relaysSeen ? 'Connection lost — reconnecting…' : "Can't reach the signaling relays — reconnecting…")
      : view.seq ? 'The host left — the table is paused until they return'
        : relaysSeen ? 'Waiting for the host…\n(the table lives in the host\'s open tab)' : 'Connecting…';
  }
}

// --- signaling watchdog ----------------------------------------------------
// Public Nostr relays are best-effort. If signaling dies (no open relay
// sockets) or a guest can't reach the host, recover by RELOADING the page with
// backoff. (Rejoining in place — room.leave() + joinRoom — proved unreliable:
// tearing down a room over dead sockets can leave trystero half-subscribed
// and undiscoverable. A reload is the reset that provably works: the host
// resumes from its save, a guest re-enters with identity and hand intact.)
// A guest without the host counts, whatever other peers it has: one that
// never got the table, at once (then the backoff's 20 s); one that had it,
// once the host has been gone HOST_GONE_MS — a link to a returning host
// that never forms (its relays lost, or a WebRTC offer that went wrong:
// see WholeOffers in connect()) would otherwise freeze its screen for
// good, the "host left" hint up forever.
// That guest keeps its table across the reload (keepPaused): a host that
// simply left leaves its guests the last table, paused, as before — and
// when the host was last seen, so the next page counts the absence on.
// The backoff lives in sessionStorage precisely so it survives those
// reloads; it goes once we're back (the host here again, for a guest), not
// merely when nothing starves yet: a guest that kept its table would
// otherwise restart it at 20 s on every page, and reload every minute. It is
// the room's, and only the page its reload opened trusts it (written up to
// REJOIN_FRESH_MS before this page's navigation began), as only that page
// takes the kept table's "host last seen": a later visit to the room in
// this tab (the tab went elsewhere, or was restored; a reload that landed
// on the browser's offline page) starts afresh, with its 20 s of grace.
const HOST_GONE_MS = 60000, REJOIN_FRESH_MS = 5000; // (the record, then the toast's 600 ms and the unload; a later visit, much more)
const rejoinKey = () => `ct-rejoin-${roomId}`;
/** Whether a record written at `at` came from the reload that opened this
 *  page: this navigation began just after it (performance.timeOrigin, set
 *  when the reload starts, however long the page then takes to load). */
const fromMyReload = (at) => Number.isFinite(at) && performance.timeOrigin - at < REJOIN_FRESH_MS;
let hostSeenAt = 0; // guest: when the host was last reachable (or this page joined, connect(); resumePaused: the last page's)
setInterval(() => {
  if (!room) return;
  updateNet(); // keep the relay indicator fresh even when nothing happens
  const n = Object.keys(room.getPeers()).length, now = Date.now(), back = role !== 'guest' || hostHere();
  if (back) hostSeenAt = now;
  const ours = n === 0 && openRelays() === 0; // nobody, and no relay: our own connection is down
  const hostless = role === 'guest' && !back && (view.seq === 0 || now - hostSeenAt > HOST_GONE_MS);
  try {
    if (!ours && !hostless) {
      if (back) sessionStorage.removeItem(rejoinKey());
      return;
    }
    const kept = JSON.parse(sessionStorage.getItem(rejoinKey()) || '{}'), st = fromMyReload(kept.at) ? kept : {};
    const backoff = clamp(st.backoff || 20000, 20000, 120000);
    if (now - (st.at || joinAt) < backoff) return;
    sessionStorage.setItem(rejoinKey(), JSON.stringify({ backoff: Math.min(backoff * 2, 120000), at: now }));
    // Each cause says what it is: our relays (checked first: then the host
    // may well be there), a host never found, or one gone a while (and how long).
    const away = Math.round((now - hostSeenAt) / 1000);
    const [why, msg] = ours ? ['no relays reachable', 'Connection is struggling — reconnecting…']
      : view.seq ? [`the host has been unreachable for ${away} s`, `The host has been away for ${away < 90 ? 'a minute' : `${Math.round(away / 60)} minutes`} — reconnecting…`]
        : ['no host found yet', 'No host found yet — looking again…'];
    console.warn(`reconnecting via reload: ${why}`);
    toast(msg);
    if (role === 'guest' && view.seq) keepPaused();
    setTimeout(() => location.reload(), 600); // let the toast paint first
  } catch (err) { console.error('watchdog failed', err); }
}, 5000);
const pausedKey = () => `ct-paused-${roomId}`;
/** Guest, reloading with a table (the watchdog): keeps the view, the
 *  catalog it draws with and when the host was last seen in sessionStorage
 *  (this tab's only) for the next page — resumePaused shows the table
 *  again, paused, until the host is back. */
function keepPaused() {
  try {
    const bx = Object.fromEntries(Object.entries(boxes).map(([id, b]) => [id, { ...b, ...boxInfo[id] }]));
    sessionStorage.setItem(pausedKey(), JSON.stringify({ view, decks, boxes: bx, seenAt: hostSeenAt, at: Date.now() }));
  } catch (err) { console.error('could not keep the paused table across the reload', err); }
}
/** Guest, at boot: the table keepPaused kept, shown again, paused (the hint
 *  says so), until the host's first snapshot replaces it. It goes through
 *  the gates the host's messages do (cleanDeck, cleanBox, viewFromSnap). */
function resumePaused() {
  try {
    const kept = sessionStorage.getItem(pausedKey());
    if (kept === null) return;
    sessionStorage.removeItem(pausedKey());
    const { view: v, decks: d, boxes: b, seenAt, at } = JSON.parse(kept);
    if (fromMyReload(at) && Number.isFinite(seenAt) && seenAt <= Date.now()) hostSeenAt = seenAt; // the host's absence goes on counting
    view = viewFromSnap(v);
    setTable(view.table);
    takeDecks(d);
    takeBoxes(b);
  } catch (err) {
    console.error('the paused table could not be shown again', err);
    toast(`Couldn't show the paused table again (${err.message})`);
  }
}

// --- host persistence -----------------------------------------------------
// The table is saved in IndexedDB (store.js): the state at most once a
// second (throttled, not debounced: a busy game still hits storage), and
// never in the burst of work of the change that asked for it (SAVE_DEFER_MS
// later at least: the move's broadcast and redraw have run, and its glide's
// first frames don't wait for the save; run at once, the save of a
// 1,000-item table took 2.4 ms median, once 11.5 ms under load, against
// 1.9 ms deferred — B6) — but a page's first save starts at once: it puts
// the table in storage, for a host who leaves right away (pagehide's own
// save may not commit). One write at a time; each deck and game box once,
// into the room's catalog, with its images, in the same transaction as the
// first save that has it. When storage is
// full, store.js makes room (the image cache, then other rooms' saves,
// oldest first); if the table still can't be saved, a tiny lost marker
// replaces the save, so a reload never quietly rewinds to stale state — it
// resets the table loudly (and this browser stays the host instead of
// waiting in its own room), or resumes, as loudly, the pre-Phase 1 save
// whose migration couldn't be written (store.js loadSave). A state that
// can't be stored at all (a rules script left a function in t.data) costs
// the rules, not the save (_unsaveable).
// A tab that goes away (pagehide), or is hidden (visibilitychange: a phone
// may suspend, then discard it, with no pagehide), saves at once (flushSave).
// An IndexedDB write started then may never commit, so it also leaves the
// seq it meant to save in localStorage (synchronous): ct-pending-<room>. A
// commit of that seq removes it; a boot that finds it ahead of the save says
// the last moment of play was lost.
const SAVE_DEFER_MS = 250;
let persistT = 0, lastSave = 0, again = false, persistWarned = false;
let savedSeq = -1; // host: the seq of the last save that committed
let savingSeq = -1; // host: a save is in flight (-1: none), holding this seq at least (it may take a later state: store.js saveTable)
let cloneFixed = false; // host: since the last good save, the rules' state was cut down to JSON (_unsaveable) once
let noSave = ''; // host: why this tab never writes its room's save ('' = it does)
const savedCatalog = new Set(); // host: the deck and box ids this room's catalog holds
const pendingKey = () => `ct-pending-${roomId}`;
/** Writes the table (host), see above; a request made while a write is in
 *  flight runs once it is done — unless the page is `leaving`: then it
 *  starts at once (IndexedDB runs the two in order). perf.lastSaveSyncMs:
 *  the main-thread part of its state write (B6). */
async function doSave(leaving) {
  if (role !== 'host' || noSave) return; // a demoted host's pending timer must not clobber the winner's save
  if (savingSeq !== -1 && !leaving) { again = true; return; }
  savingSeq = T.state.seq;
  lastSave = Date.now();
  try {
    const { state, catalog, pruned, syncMs } = await store.saveTable(roomId, snap);
    perf.lastSaveSyncMs = syncMs;
    savedSeq = state.seq;
    for (const c of catalog) savedCatalog.add(c.id);
    if (pruned) toast(`Browser storage was full — deleted ${pruned} old table save${pruned > 1 ? 's' : ''} to keep this one`);
    persistWarned = cloneFixed = false;
    if (+localStorage.getItem(pendingKey()) <= state.seq) localStorage.removeItem(pendingKey());
  } catch (err) {
    console.error('failed to persist game', err);
    if (err.name === 'DataCloneError' && !cloneFixed) { // the last save stands; the next one follows
      cloneFixed = true;
      enqueue(RULES, { t: '_unsaveable', why: err.message });
    } else {
      savedCatalog.clear(); // the save is a lost marker now: the next one that fits writes every deck again
      if (role === 'host' && !persistWarned) { persistWarned = true; toast(`Can't save this table (${err.message}) — reloading the host tab would reset it`); }
    }
  } finally {
    savingSeq = -1;
    if (again) { again = false; doSave(); }
  }
}
/** What a save writes (store.saveTable takes it again before a retry): the
 *  state, and the decks and boxes the room's catalog lacks (a box with where
 *  it came from: src, by). */
function snap() {
  if (role !== 'host') throw new Error('this tab is no longer the host');
  const { decks: d, boxes: b, boxSrc } = T.state, fresh = (all) => Object.keys(all).filter((id) => !savedCatalog.has(id));
  return {
    state: T.snapshot(),
    catalog: [...fresh(d).map((id) => ({ id, kind: 'deck', deck: d[id] })), ...fresh(b).map((id) => ({ id, kind: 'box', box: b[id], ...(boxSrc[id] || { src: 'host' }) }))],
  };
}
function persist() {
  if (role !== 'host' || noSave || persistT) return;
  persistT = setTimeout(() => { persistT = 0; doSave(); }, Math.max(lastSave ? SAVE_DEFER_MS : 0, 1000 - (Date.now() - lastSave)));
}
/** Host, `leaving` (pagehide) or maybe leaving (the tab hidden): the
 *  table's last moment is marked pending until a save of it commits (see
 *  above), and saved now if it isn't yet (not SAVE_DEFER_MS later) — unless
 *  the save in flight holds it already. Only a page that is leaving starts
 *  its save beside the one in flight (it may not live to see that one end);
 *  a hidden page lives on, and its save waits its turn (`again`). */
function flushSave(leaving) {
  if (role !== 'host' || noSave || T.state.seq === savedSeq) return;
  try { localStorage.setItem(pendingKey(), String(T.state.seq)); } catch (err) { console.error('could not mark the save as pending', err); }
  clearTimeout(persistT);
  persistT = 0;
  if (T.state.seq !== savingSeq) doSave(leaving);
}
// Leaving: the save first, then the room is left — which marks the guests
// offline, a change not worth a save. A tab hidden may never come back
// either: a phone that switches apps or locks often hides it with no
// pagehide, then suspends its timers and may discard it.
window.addEventListener('pagehide', () => {
  flushSave(true);
  try { room?.leave(); } catch (err) { console.error('leaving the room failed', err); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(false); });
/** Host, at boot: a save this tab left pending (flushSave) that never
 *  committed is said, once — unless the boot says worse (a save lost). */
function checkPending(save) {
  const mark = localStorage.getItem(pendingKey());
  if (mark === null) return;
  localStorage.removeItem(pendingKey());
  if (save?.lost || save?.behind || +mark <= num(save?.state?.seq)) return;
  console.warn(`the last save before the reload never committed (seq ${mark}; the save has ${save?.state?.seq ?? 'none'})`);
  toast("The last moment of play before the reload wasn't saved (the browser closed first)");
}

// --- rendering ------------------------------------------------------------
const itemEls = new Map();
let sel = null, drag = null, handDrag = null, facedown = false;
let scale = 1;

/** The image a card side shows — a face's, or its deck's image back — as
 *  an asset id; undefined for a drawn face or back, or a deck not here yet. */
function sideImage(d, i, up) {
  const deck = decks[d];
  if (!up) return deck?.backImg;
  const g = deck?.cards[i]?.g; // g: the card's entry in imgs (copies share one image)
  return g === undefined ? undefined : deck.imgs[g];
}
/** Whether image h is drawn ('u'), missing for good ('x') or on its way ('l'): part of an item's signature. */
const imageState = (h) => (!h ? '' : store.holds(h) ? 'u' : imgs.get(h) === 'missing' ? 'x' : 'l');
/** An image side (cls: face or back): the picture once this tab holds it
 *  (an object URL from store.js, never a peer's string), else a placeholder
 *  while it is fetched (wantImages), or the missing look for good. */
function imageHTML(h, cls) {
  const url = store.getAssetURL(h);
  if (url) return `<img class="${cls}" src="${esc(url)}" alt="">`;
  wantImages([h]);
  if (imgs.get(h) === 'missing') return `<div class="${cls} missing" title="This card's image is missing"><s>🖼</s></div>`;
  return cls === 'face' ? '<div class="face loading">🂠</div>' : '<div class="back"></div>';
}
function faceHTML(d, i) {
  const deck = decks[d], c = deck?.cards[i];
  if (!c) return '<div class="face loading">🂠</div>'; // deck data not yet received
  if (c.g !== undefined) return imageHTML(deck.imgs[c.g], 'face');
  if (c.r === 'JOKER') return `<div class="face std ${c.c}"><div class="corner">★</div><div class="mid joker">🃏</div><div class="corner br">★</div></div>`;
  if (c.r) return `<div class="face std ${c.c}"><div class="corner">${c.r}\n${c.s}</div><div class="mid"><div class="mr">${c.r}</div><div class="ms">${c.s}</div></div><div class="corner br">${c.r}\n${c.s}</div></div>`;
  // Image-less custom card: rendered from its manifest name/text/colors.
  const bg = c.b && safeColor(c.b, null);
  const style = `border-color:${safeColor(c.col || bg)}${bg ? `;background:${bg};color:${contrastFor(bg)}` : ''}`;
  return `<div class="face txt" style="${style}"><div class="tn">${esc(c.n || '')}</div>${c.txt ? `<div class="tt">${esc(c.txt)}</div>` : ''}</div>`;
}
function backHTML(d) {
  const deck = decks[d];
  if (deck?.backImg) return imageHTML(deck.backImg, 'back');
  return deck?.back ? `<div class="back" style="background:${safeColor(deck.back)}"></div>` : '<div class="back"></div>'; // a solid-color back, or the pattern
}

/** Whether public item `it` is drawn by pieces.js: a piece, a supply, a bag
 *  or a pile of pieces (the rest are cards and piles of cards). */
const pieceLike = (it) => it.k === 'g' || it.k === 's' || it.k === 'b' || (it.k === 'p' && !!it.top && !('d' in it.top));
// What this player may do with a public item, read from the public view
// alone (spec §2c). The bar, the gestures and the keys offer nothing else:
// the client never sends an action it knows the host refuses.
/** Whether public item `it` is a board, or a die (pieces.js). */
const isBoard = (it) => pieces.isBoard(it, boxes), isDie = (it) => pieces.isDie(it, boxes);
/** Whose public item `it` is: its owner resolved (a seat-bound owner is whoever sits there), or null. */
const ownerOf = (it) => (!it.owner ? null : it.owner.startsWith('seat:') ? seatHolder(it.owner.slice(5)) : it.owner);
/** Whether this player may handle public item `it`: nobody else owns it. */
const mayTouch = (it) => !it.owner || ownerOf(it) === pid;
/** Whether this player may lock or unlock `it`: the host; or anyone who may
 *  handle a piece, supply or bag of a box whose pieces anyone may lock (a
 *  bag's box: the one whose setup made it, public by D88). */
const mayLock = (it) => role === 'host' || (mayTouch(it) && 'gsb'.includes(it.k) && own(boxes, it.k === 'b' ? it.box : pieces.boxOf(it))?.lockable === 'anyone');
/** Whether this player's hand has room for `n` more (core's MAX_HAND). */
const handRoom = (n = 1) => view.hand.length + n <= MAX_HAND;
/** Whether piece `it` turns over (flip): a hidden one shows its face; a shown one has a back or several faces, and is no die. */
function flips(it) {
  if ('b' in it) return !!it.b;
  const ty = typeAt(boxes, it.t);
  return !!ty && ty.kind !== 'die' && (!!ty.back || ty.faces.length > 1);
}
/** Markup for an image on a piece's face (imageHTML's, as a face). */
const faceImage = (h) => imageHTML(h, 'face');
/** Markup for a PUBLIC card or pile of cards (see publicItems: piles carry n + top). */
function contentFor(it) {
  const badges = pieces.badgesHTML(it, ownerColor(it.owner));
  if (it.k === 'c') return `<div class="cardbox">${it.up ? faceHTML(it.d, it.i) : backHTML(it.d)}</div>${badges}`;
  const top = it.top;
  const inner = top ? (top.up ? faceHTML(top.d, top.i) : backHTML(top.d)) : '';
  return `<div class="cardbox">${inner}</div><span class="count">${num(it.n)}</span>${it.name ? `<span class="pname">${esc(it.name)}</span>` : ''}${badges}`;
}
/** The colour of owner `o`'s dot: a player's colour; a seat-bound owner's is its seat's (grey for a seat without one). */
function ownerColor(o) {
  if (!o) return '';
  return o.startsWith('seat:') ? view.seats?.find((s) => s.id === o.slice(5))?.color || '#94a3b8' : view.players[o]?.color || '#94a3b8';
}

// --- motion (UX-I1) ----------------------------------------------------------
// Remote moves glide via a CSS transition on .item left/top (style.css; off
// while dragging and under prefers-reduced-motion). Here, from what a patch
// replaced (the `prev` maps receive() hands the renderer): a card that appears
// where a pile just shrank slides out of it (a deal), one that appears as a
// player's hand shrank slides in from their seat (a play), a pile that shrank
// while hands grew sends card backs flying to those seats, and a flip turns
// the card. Web Animations only: nothing to clean up, no forced reflows.
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let landing = null; // {id, x, y, ox, oy}: our own drop (and the drag's origin), held until the host confirms or vetoes it
const MOTION_MS = 260;

/** Where player p sits, in table coords: on the rim at their seat's angle,
 *  or a named seat placed with `at` at that very point (core's seatAt). */
function seatXY(p) {
  const pl = view.players[p];
  return seatAt(TABLE, num(pl?.seat ?? 90), pl?.seatId && view.seats?.find((s) => s.id === pl.seatId));
}
/** A seat's spot in table coords (top-left of a card centred there). */
function seatSpot(p) {
  const at = seatXY(p);
  return { x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 };
}

/** Where the cards that newly appeared came from: piles that shrank (each with
 *  how many cards left them) and other players whose hands shrank. */
function motionSources(prev, prevPlayers) {
  const piles = [...prev].filter(([, o]) => o?.k === 'p')
    .map(([id, o]) => ({ o, left: num(o.n) - num(view.items[id]?.n) })).filter((s) => s.left > 0);
  const hands = [...prevPlayers].filter(([p, o]) => o && p !== pid && num(view.players[p]?.handCount) < num(o.handCount))
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

// Late arrivals: a deck can land after the items that show it (a joiner's
// snapshot outruns the decks), and an image after both. Each item is indexed
// by the deck and the image its visible side shows (a pile's by its top), so
// an arrival redraws exactly those: dirty-set rendering redraws only items
// whose public data changed.
/** A late-arrival index: key (a deck or asset id) → the ids of the items showing it. */
function showing() {
  const by = new Map(), of = new Map(); // key → item ids; item id → key
  return {
    get: (k) => by.get(k) || [],
    /** Item `id` now shows `k` (undefined: nothing, or it is gone). */
    set(id, k) {
      const was = of.get(id);
      if (k === was) return;
      by.get(was)?.delete(id);
      if (k === undefined) { of.delete(id); return; }
      of.set(id, k);
      if (!by.has(k)) by.set(k, new Set());
      by.get(k).add(id);
    },
  };
}
const itemsByDeck = showing(), itemsByAsset = showing(), itemsByBox = showing();
/** What arrived — `ids` of `index`: decks, boxes or images — redraws the
 *  items showing it, the hand (it may hold placeholders: handSig) and an
 *  open zoom or peek whose card or piece `zoomShows`. */
function arrived(index, ids, zoomShows) {
  const prev = new Map();
  for (const k of ids) for (const id of index.get(k)) prev.set(id, view.items[id]);
  handSig = '';
  if (zoomed && !peekEl.classList.contains('hidden') && zoomShows(zoomed.c)) showZoom(zoomed.c, zoomed.caption);
  renderAll(prev);
}
let landed = new Set(), landT = 0;
/** Images `ids` arrived, or turned out missing: their items redraw — in
 *  batches (a big pull lands many at once), or `now`, before a toast says why. */
function imagesArrived(ids, now) {
  for (const h of ids) landed.add(h);
  if (!now) { landT ||= setTimeout(redrawLanded, 30); return; }
  clearTimeout(landT);
  redrawLanded();
}
function redrawLanded() {
  const hs = [...landed];
  landed = new Set();
  landT = 0;
  arrived(itemsByAsset, hs, (z) => hs.includes('t' in z ? pieces.imageOf({ k: 'g', ...z }, boxes) : sideImage(z.d, z.i, true)));
}

/** Draws the items: those in `prev` (a Map of id → the public item it
 *  replaced, undefined for a new one; ids gone from view.items are removed),
 *  or with prev null, all of them (after a snapshot). `prevPlayers` (pid →
 *  previous public player) drives the motion. */
function renderItems(prev, prevPlayers = new Map()) {
  const t0 = performance.now();
  // A full render creates the elements bottom to top (by z), so the page's
  // order is the table's stacking order, not the snapshot's (sorted by id).
  const ids = prev ? prev.keys() : new Set([...itemEls.keys(), ...Object.keys(view.items).sort((a, b) => num(view.items[a].z) - num(view.items[b].z))]);
  const move = prev && !calm.matches && motionSources(prev, prevPlayers);
  for (const id of ids) {
    const it = view.items[id], before = prev?.get(id), piece = it && pieceLike(it), side = it && !piece && (it.k === 'c' ? it : it.top);
    const img = piece ? pieces.imageOf(it, boxes) : side && sideImage(side.d, side.i, side.up);
    let el = itemEls.get(id);
    itemsByDeck.set(id, side?.d);
    itemsByBox.set(id, piece ? pieces.boxOf(it) : undefined);
    itemsByAsset.set(id, img);
    if (!it) {
      if (el) { el.remove(); itemEls.delete(id); }
      continue;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'item';
      el.dataset.id = id;
      tableEl.appendChild(el);
      itemEls.set(id, el);
      // A brand-new card slides in from where it came from (deal / play).
      const src = move && it.k === 'c' && !before && (move.piles.find((s) => s.left > 0) || move.hands.length && { o: seatSpot(move.hands[0]) });
      if (src) {
        src.left--;
        el.animate([{ left: `${src.o.x}px`, top: `${src.o.y}px` }, { left: `${it.x}px`, top: `${it.y}px` }], { duration: MOTION_MS, easing: 'ease-out' });
      }
    }
    const mine = `${ownerColor(it.owner)}|${!!it.lock}`; // the badges
    const sig = piece ? `g|${looks(it)}|${!!boxes[pieces.boxOf(it)]}|${imageState(img)}|${mine}`
      : it.k === 'c' ? `c|${it.d}|${it.i}|${it.up}|${!!decks[it.d]}|${imageState(img)}|${mine}`
        : `p|${it.n}|${JSON.stringify(it.top)}|${it.name}|${!!decks[it.top?.d]}|${imageState(img)}|${mine}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      perf.drawn++;
      if (piece) {
        const v = pieces.itemView(it, boxes, faceImage, ownerColor(it.owner));
        el.innerHTML = v.html;
        kind(el, v.cls, v.w, v.h);
      } else {
        el.innerHTML = contentFor(it);
        kind(el, it.k === 'p' ? ['pile', ...(it.n > 1 ? ['multi'] : [])] : []);
      }
      // Flipped (a card, or a pile whose size didn't change): the new side turns in.
      if (move && before?.k === it.k && (it.k === 'c' ? before.up !== it.up : before.n === it.n && !!before.top?.up !== !!it.top?.up)) {
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
    // its badges, and a board's printed text, turn back against it (style.css, D91)
    if (it.rot) el.style.setProperty('--rot', `${num(it.rot)}deg`);
    else el.style.removeProperty('--rot');
    el.style.zIndex = it.z;
    el.classList.toggle('selected', sel === id);
  }
  // Cards a pile lost without landing on the table went into hands: fly them there.
  if (move) {
    for (const [p, o] of prevPlayers) {
      let gain = o ? num(view.players[p]?.handCount) - num(o.handCount) : 0;
      for (const s of move.piles) {
        const n = Math.min(gain, s.left);
        if (n > 0) { flyToSeat(s.o, p, Math.min(n, 3)); s.left -= n; gain -= n; }
      }
    }
  }
  perf.lastRenderMs = performance.now() - t0;
}

/** What an item's drawing depends on: all of it but where it lies. */
const looks = ({ x, y, z, rot, ...rest }) => JSON.stringify(rest);
/** Gives item element `el` the classes of its kind (`cls`: those drawn last
 *  go, these come) and its size (a card's by default: the CSS variables). */
function kind(el, cls, w, h) {
  el.classList.remove(...(el.dataset.kc ? el.dataset.kc.split(' ') : []));
  el.classList.add(...cls);
  el.dataset.kc = cls.join(' ');
  el.style.width = w ? `${w}px` : '';
  el.style.height = h ? `${h}px` : '';
  // a piece pile's half diagonal: its name sits just past it (style.css .pname; a card pile's is the default)
  if (w && cls.includes('pile')) el.style.setProperty('--pr', `${Math.round(Math.hypot(w, h) / 2)}px`);
  else el.style.removeProperty('--pr');
}

// Seat labels: everyone sees the same seating, each from their own rotation.
// A named seat nobody holds shows as a ghost label ("White — empty"). The
// labels let every pointer event through (the cards under them stay
// draggable); a tap on one opens the seat menu (seatLabelAt, openSeatMenu).
let seatSig = '', seatEls = []; // what the labels show; [{p (a player) | seat (a free named seat's SeatDef), el, hw, hh}]
/** Gives seat label `el` its border colour `c` — and a light halo when `c`
 *  is near black (Dark's), which would vanish on the label's dark ground. */
function inkBorder(el, c) {
  el.style.borderColor = c;
  el.classList.toggle('inky', pieces.luma(c) < 60);
}
/** Whose move the rules wait on: public.turn is one player id or a list of them. */
const turnOf = () => [].concat((view.rules?.enabled && view.rules.public?.turn) || []);
/** Draws the seat labels when what they say changed, and places them
 *  (placeSeats) when they were redrawn or, with `viewMoved`, the view did. */
function renderPlayers(viewMoved) {
  const turn = turnOf();
  const winners = (view.rules?.enabled && view.rules.public?.winners) || [];
  const badges = (view.rules?.enabled && view.rules.public?.badges) || {};
  // Only the host publishes online flags, so a guest marks a departed host itself.
  const hostGone = role === 'guest' && !hostPeer ? view.host : null;
  // A table drawn small (phones) gets small, see-through labels: full-size
  // ones would reach into the felt and hide the cards the game puts there.
  const small = scale < 0.4;
  // (the "What are we playing?" strip moves the notices: placeSeats)
  const sig = `${JSON.stringify(view.players)}|${JSON.stringify(view.seats)}|${view.handy}|${turn}|${winners.join()}|${JSON.stringify(badges)}|${hostGone}|${small}|${$('game-strip').className}`;
  if (sig !== seatSig) {
    seatSig = sig;
    for (const s of seatEls) s.el.remove();
    wrapEl.classList.toggle('small-table', small);
    seatEls = [];
    for (const [p, pl] of Object.entries(view.players)) {
      if (pl.seat == null) continue;
      const el = document.createElement('div');
      const waited = turn.includes(p), named = pl.seatId && view.seats?.find((st) => st.id === pl.seatId);
      el.className = `seat${pl.online && p !== hostGone ? '' : ' offline'}${p === pid ? ' me' : ''}${waited ? ' turn' : ''}${winners.includes(p) ? ' winner' : ''}`;
      inkBorder(el, safeColor(named?.color || pl.color)); // a named seat's colour; the log keeps the player's
      // (a hand count only where hands matter: a table with hand items, or a hand that holds some)
      const cards = view.handy || pl.handCount ? ` 🂠${pl.handCount}` : '';
      el.textContent = `${winners.includes(p) ? '🏆 ' : ''}${waited ? '⏳ ' : ''}${named ? `${named.name} — ` : ''}${pl.name || 'Player'}${cards}${badges[p] ? ` ${badges[p]}` : ''}`;
      seatEls.push({ p, el });
    }
    for (const st of view.seats || []) {
      if (seatHolder(st.id)) continue;
      const el = document.createElement('div');
      el.className = 'seat ghost';
      inkBorder(el, safeColor(st.color, '#94a3b8'));
      el.textContent = `${st.name} — empty`;
      seatEls.push({ seat: st, el });
    }
    wrapEl.append(...seatEls.map((s) => s.el));
    // All sizes are read before any position is written: one layout for all the labels.
    for (const s of seatEls) { s.hw = s.el.offsetWidth / 2 + 4; s.hh = s.el.offsetHeight / 2 + 2; }
  } else if (!viewMoved) return; // nothing to move: no layout read (a patch's redraw stays cheap)
  placeSeats();
}
let seatSpots = ''; // where placeSeats last put the button row and the notices
// The hint's plate (CSS #table-hint): HINT_FELT of the felt's width on the
// screen at most, and no wider than the gap between the labels within
// HINT_BAND of the middle (half the tallest plate: 6 lines, 146 px, on a
// phone held upright), HINT_GAP clear of them; HINT_MIN_W at least (and
// always its longest word: min-width: min-content).
const HINT_FELT = 0.6, HINT_BAND = 75, HINT_GAP = 8, HINT_MIN_W = 140;
/** Puts the seat labels where this view shows their seats. It runs on every
 *  pan, zoom and pinch frame, so it moves things by transform only: a
 *  layout per frame would also make the browser hit-test the whole table
 *  for hover, which is slow with 1,000 cards (B4). */
function placeSeats() {
  const W = wrapW, H = wrapH;
  let rowBottom = 12, noticeTop = 10; // #rules-btns' and #notices' default spots (CSS)
  const angles = view.seats && seatEls.some((s) => s.seat) && seatAngles(TABLE, view.seats);
  const corner = []; // the labels the watchers' box (top right, watchW × watchH) could cover: [top, bottom]
  let side = Infinity; // how far the hint's plate may reach either side of the middle before a label beside it
  for (const { p, seat, el, hw, hh } of seatEls) {
    // (the seat's point is read here, not kept with the label: a new table
    // size moves it, and layout() places the labels again then)
    const at = p ? seatXY(p) : seatAt(TABLE, angles.get(seat.id), seat), [sx, sy] = tableToScreen(at.x, at.y);
    // Keep the whole label on screen (side seats sit on the rim, which a
    // phone's fit zoom puts right at the screen edge).
    const x = clamp(sx, hw, W - hw), y = clamp(sy, hh, H - hh);
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    if (x + hw > W - 8 - watchW && y < H / 2) corner.push([y - hh, y + hh]);
    // Your own label in the lower half: lift the rules button row just above
    // it, so the row never hides your name, ⏳, chips or score.
    if (p === pid && y > H / 2) rowBottom = Math.max(rowBottom, H - (y - hh) + 6);
    // Labels across the top: the banner and toasts start just below them.
    if (y < H / 4) noticeTop = Math.max(noticeTop, y + hh + 4);
    if (Math.abs(y - H / 2) < hh + HINT_BAND) side = Math.min(side, Math.abs(x - W / 2) - hw - HINT_GAP);
  }
  // The table's hint, centred on the table area, on a plate that wraps in
  // the middle of the felt and between the labels beside it.
  const hintW = `${Math.round(Math.max(HINT_MIN_W, Math.min(HINT_FELT * feltW, 2 * side)))}px`;
  if (hintW !== hintEl.style.getPropertyValue('--hint-w')) hintEl.style.setProperty('--hint-w', hintW);
  // (#table-wrap and #notices both start at #main's top: the offsets agree)
  const strip = $('game-strip'); // the "What are we playing?" strip pushes the notices down too
  if (!strip.classList.contains('hidden')) noticeTop = Math.max(noticeTop, strip.offsetTop + strip.offsetHeight + 4);
  // The watchers' box stays in its corner unless a label is there: then it goes below that label.
  let watchTop = 8;
  for (const [t, b] of corner.sort((a, c) => a[0] - c[0])) if (t < watchTop + watchH && b > watchTop) watchTop = b + 4;
  // A short, wide table area (a phone in landscape) leaves wide empty
  // margins beside the felt (as wide as this view shows it: feltW, layout):
  // the notices move into the left one and the button row into the right
  // one, so neither covers the cards (CSS .gutters).
  const gutter = (W - feltW) / 2, gutters = H < 500 && gutter >= 180;
  const spots = `${rowBottom}|${noticeTop}|${watchTop}|${gutters}|${gutter | 0}`;
  if (spots === seatSpots) return;
  seatSpots = spots;
  // Moved by `translate` from their CSS spots, for the same reason.
  $('rules-btns').style.translate = `0 ${12 - rowBottom}px`;
  $('notices').style.translate = `0 ${noticeTop - 10}px`;
  $('watch-box').style.translate = `0 ${watchTop - 8}px`;
  $('main').classList.toggle('gutters', gutters);
  // (on the three boxes that use it: on #main, an inherited property, it
  // would restyle every element of the table at each frame of a zoom or of
  // a rectangle's turn, whose fit changes as it turns)
  for (const id of ['notices', 'rules-btns', 'watch-box']) $(id).style.setProperty('--gutter', `${gutter | 0}px`);
}

// --- the seat menu (spec §2g) and the watchers -----------------------------------
const seatMenuEl = $('seat-menu');
let seatMenuActs = []; // the open menu's actions, by button
/** The seat label under client point (x, y), or undefined: a label (17 px
 *  tall on a phone) counts as at least TAP_PX tall, a finger's size. */
const TAP_PX = 32;
const seatLabelAt = (x, y) => seatEls.find(({ el }) => {
  const r = el.getBoundingClientRect(), pad = Math.max(0, (TAP_PX - r.height) / 2);
  return x >= r.left && x <= r.right && y >= r.top - pad && y <= r.bottom + pad;
});
/** What the seat menu offers on label `s`, as [text, action] pairs: your own
 *  named seat → stand up; a free named seat → sit there (the host: or seat
 *  anyone there); another player's label → the host moves them to the
 *  watchers. Nothing that the host would refuse. */
function seatMenu(s) {
  const host = role === 'host', players = Object.entries(view.players);
  if (s.seat) return [['Sit here', { t: 'seat', id: s.seat.id }], ...(host ? players.filter(([p]) => p !== pid).map(([p, pl]) => [`Seat ▸ ${pl.name || 'Player'}`, { t: 'seat', id: s.seat.id, p }]) : [])];
  if (s.p === pid) return view.players[pid]?.seatId ? [['Stand up (watch)', { t: 'seat', watch: true }]] : [];
  return host ? [['Move to watchers', { t: 'seat', watch: true, p: s.p }]] : [];
}
/** The seat label a tap (event e) opens the menu of, or null: the label
 *  under it, if its menu offers anything — unless the tap is on an item,
 *  which the labels let through (a board aside: boards cover the felt). */
function seatTap(e) {
  const on = e.target.closest?.('.item'), s = (!on || isBoard(view.items[on.dataset.id] || {})) && seatLabelAt(e.clientX, e.clientY);
  return s && seatMenu(s).length ? s : null;
}
/** Opens the seat menu of label `s`, in screen space next to it. */
function openSeatMenu(s) {
  const entries = seatMenu(s);
  seatMenuActs = entries.map(([, a]) => a);
  seatMenuEl.innerHTML = entries.map(([text], k) => `<button data-k="${k}">${esc(text)}</button>`).join('');
  seatMenuEl.classList.remove('hidden');
  const r = s.el.getBoundingClientRect(), w = wrapEl.getBoundingClientRect(), mw = seatMenuEl.offsetWidth, mh = seatMenuEl.offsetHeight;
  const below = r.bottom - w.top + 6, above = r.top - w.top - mh - 6;
  seatMenuEl.style.left = `${clamp(r.left + r.width / 2 - w.left - mw / 2, 4, w.width - mw - 4)}px`;
  seatMenuEl.style.top = `${below + mh <= w.height - 4 ? below : Math.max(4, above)}px`;
}
const closeSeatMenu = () => seatMenuEl.classList.add('hidden');
seatMenuEl.addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]')?.dataset.k;
  if (k != null) act(seatMenuActs[k]);
  closeSeatMenu();
});
// A tap on a seat label opens its menu (the labels let the pointer through:
// the table's own handlers skip such a tap, see pointerup); any other click
// closes it. The click a browser sends after a drag (to where it ended: a
// piece dropped on a label, a pan) is no tap; nor is one on a control over
// the table — read off the event's path, which keeps a bar button that the
// click just redrew away (Give ▸ over a label must not open its menu).
wrapEl.addEventListener('click', (e) => {
  if (e.composedPath().some((n) => n.matches?.('#seat-menu, #action-bar, #rules-btns, #game-strip, #watch-box')) || e.timeStamp - dragEndAt < 300) return;
  const s = seatTap(e);
  if (s) openSeatMenu(s);
  else closeSeatMenu();
});

/** The watchers chip ("👀 Carol, Dan": the online players without a seat),
 *  and for a watcher how to sit down again: tap a free named seat (while one
 *  is free), or with automatic seating the Sit down button. On a short
 *  screen (a phone in landscape: the table fills its height, and a board
 *  reaches the corner) both are compact ("👀 2", "👀 Watching") until a tap
 *  opens them, in the right margin, for WATCH_OPEN_MS or until the next
 *  touch on the table. */
const shortScreen = matchMedia('(max-height: 500px)'), WATCH_OPEN_MS = 6000;
let watchSig = '', watchW = 0, watchH = 0, watchOpen = false, watchT = 0; // what the watchers' box shows; its size; opened by a tap; its closing timer
function renderWatchers() {
  const watching = Object.entries(view.players).filter(([, pl]) => pl.seat == null && pl.online), me = view.players[pid];
  const compact = shortScreen.matches && !watchOpen, free = !!view.seats?.some((st) => !seatHolder(st.id));
  const sig = `${watching.map(([, pl]) => pl.name).join()}|${me?.seat == null}|${!!me}|${!!view.seats}|${free}|${compact}`;
  if (sig === watchSig) return;
  watchSig = sig;
  $('watchers').textContent = `👀 ${compact ? watching.length : watching.map(([, pl]) => pl.name || 'Player').join(', ')}`;
  $('watchers').classList.toggle('hidden', !watching.length);
  const iWatch = !!me && me.seat == null;
  $('watch-me').classList.toggle('hidden', !iWatch);
  $('watch-me-text').textContent = compact ? '👀 Watching' : !view.seats ? '👀 You are watching'
    : free ? '👀 You are watching — tap a free seat to sit' : '👀 You are watching — every seat is taken';
  $('sit-btn').classList.toggle('hidden', !!view.seats);
  const box = $('watch-box');
  [watchW, watchH] = [box.offsetWidth, box.offsetHeight]; // (placeSeats keeps the labels clear of it)
}
$('sit-btn').addEventListener('click', () => act({ t: 'seat', sit: true }));
/** Opens (for WATCH_OPEN_MS) or closes a short screen's watchers' box: its
 *  texts and size drawn again, and the seat labels put clear of it. */
function openWatch(open) {
  clearTimeout(watchT);
  watchOpen = open;
  if (open) watchT = setTimeout(() => openWatch(false), WATCH_OPEN_MS);
  renderWatchers();
  placeSeats();
}
shortScreen.addEventListener('change', () => openWatch(false));
$('watch-box').addEventListener('click', (e) => {
  if (e.target.closest('#sit-btn') || !shortScreen.matches) return;
  openWatch(!watchOpen);
});
wrapEl.addEventListener('pointerdown', (e) => { if (watchOpen && !e.target.closest('#watch-box')) openWatch(false); });

let handSig = '';
let sortHand = false; // ⇅: show the hand sorted (display only — the host's order is untouched)
try { sortHand = localStorage.getItem('ct-sort') === '1'; } catch (err) { console.error('hand sort setting unreadable', err); }
const SUIT_ORDER = { '♠': 0, '♥': 1, '♦': 2, '♣': 3, '🃏': 4 };
/** Hand indices in display order: as held, or (⇅) standard cards by suit,
 *  high rank first (like the Bridge dummy), other cards after them as held. */
function handOrder() {
  const order = view.hand.map((_, k) => k);
  const key = (c) => {
    const x = decks[c.d]?.cards[c.i];
    return x?.s ? SUIT_ORDER[x.s] * 100 - (x.r === 'A' ? 14 : [...RANKS].indexOf(x.r) + 1) : 1000;
  };
  return sortHand ? order.sort((a, b) => key(view.hand[a]) - key(view.hand[b]) || a - b) : order;
}
function renderHand() {
  const sig = JSON.stringify(view.hand) + sortHand;
  if (sig === handSig) return;
  handSig = sig;
  handEl.innerHTML = '';
  $('sort-toggle').classList.toggle('on', sortHand);
  for (const idx of handOrder()) {
    const el = document.createElement('div');
    el.className = 'hcard';
    el.dataset.idx = idx; // the REAL hand index: plays name the card the host holds there
    el.innerHTML = handFace(view.hand[idx]);
    handEl.appendChild(el);
  }
  fitHand();
}
/** A hand entry's face: a card {d, i}, or a piece {t, f, up?} (its holder sees it). */
const handFace = (c) => ('t' in c ? pieces.handHTML(c, boxes, faceImage) : faceHTML(c.d, c.i));
/** What names hand entry c in an action (play, handPile): a card's {d, i}, a piece's {type, f}. */
const handRef = (c) => ('t' in c ? { type: c.t, f: c.f } : { d: c.d, i: c.i });
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

let logNames = '', logOf = null; // the names the rows were drawn with; the view.log they show
const logRows = new Map(); // log entry → its row
/** One log entry as a row's markup. */
function logRow(e) {
  const who = actorInfo(e.p);
  const name = `<b style="color:${safeColor(who.color)}">${esc(typeof e.n === 'string' ? e.n : who.name)}</b>`;
  const time = `<span class="lt">${new Date(e.ts).toTimeString().slice(0, 5)}</span>`;
  return `<div class="lg${e.c ? ' chat' : ''}">${time}${name}${e.c ? ':' : ''} ${esc(e.txt)}</div>`;
}
/** Draws the log, row by row: the rows of trimmed entries go (each bucket
 *  trims its own oldest, so they can sit anywhere), and new entries, which
 *  only ever arrive at the end, are appended. Everything is redrawn only when
 *  a name changed (rows show the names of the moment) or a snapshot replaced
 *  every entry. */
function renderLog() {
  const log = view.log;
  // Names are resolved live from view.players, which may change (renames): key on them too.
  const names = Object.entries(view.players).map(([p, pl]) => p + pl.name + pl.color).join();
  if (log === logOf && names === logNames) return;
  // (a hidden log reads no layout: the 💬 button scrolls it down when it opens)
  const atBottom = !sideEl.classList.contains('hidden') && logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  const keep = new Set(log);
  const gone = names === logNames ? [...logRows.keys()].filter((e) => !keep.has(e)) : null;
  if (!gone || gone.length === logRows.size) { logEl.textContent = ''; logRows.clear(); } else for (const e of gone) { logRows.get(e).remove(); logRows.delete(e); }
  logNames = names;
  logOf = log;
  let k = log.length; // the new entries: those after the last one drawn
  while (k > 0 && !logRows.has(log[k - 1])) k--;
  logEl.insertAdjacentHTML('beforeend', log.slice(k).map(logRow).join(''));
  for (let j = log.length - 1, el = logEl.lastElementChild; j >= k; j--, el = el.previousElementSibling) logRows.set(log[j], el);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

let rbSig = '';
function renderRulesBtns() {
  const rules = role === 'host' ? T?.state.rules : view.rules;
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

/** Redraws the screen: the items in `prev` (see renderItems; null: all of
 *  them, none by default), and everything else that changed (each keeps a
 *  signature of what it last drew). */
function renderAll(prev = new Map(), prevPlayers) {
  applySeatView();
  renderItems(prev, prevPlayers);
  renderGames(); // before the seats: the strip's place moves the notices
  renderWatchers(); // (its size, too: placeSeats moves it off the labels)
  renderPlayers();
  // The hand bar hides on a table with nothing to hold and an empty hand
  // (draughts); the patch that brings a hand item back shows it. Either way
  // the table refits (layout's ResizeObserver on #table-wrap).
  document.body.classList.toggle('nohand', view.seq > 0 && !view.handy && !view.hand.length);
  renderHand();
  renderLog();
  renderRulesBtns();
  renderFacedown();
  renderCues();
  syncBar(prev);
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
// The table area's size, read by layout() (which runs on every resize): what
// is placed in screen space between two layouts reads these, never the DOM,
// so a patch that moves an item and puts up a name bulb forces no layout (B3).
let wrapW = 0, wrapH = 0;

/** Rotates a vector by `a` degrees (screen coords, clockwise-positive). */
function rotv(x, y, a) {
  const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

// The view sheet: what follows the view, written as rules of one adopted
// stylesheet, so that only what they match restyles, and only when the view
// changed. A rule, not a property on #table: an inherited property there
// would restyle all 3,700 elements of the 1,000-piece bench table (9 ms a
// turn on a desktop, 16 ms on the B4 phone, with a labelled board of 51
// texts); a rule restyles what it matches alone.
//   0  --bz, the badges' growth (style.css). Badges (×N, ∞, a pile's count
//      and name, an owner's dot, 🔒) and selection rings are drawn in table
//      units, so on a table drawn small (a phone's fit) they'd be a few
//      pixels: they grow back toward a readable size, by at most BADGE_MAX×;
//      a board's coordinates too, by at most what fits their margin (its
//      --lmax, pieces.js gridSVG).
//   1  --view for a board's printed text (D91), which turns back against
//      the view: every frame of a turn (a board holds a few dozen texts).
//   2  --view for the badges with a number or a name, 🔒 and a bag, which
//      turn back too (D91).
// On a 1,000-stack table the badges are a thousand: a restyle of them all
// (rule 0 or 2) in a frame that also moves the table is a long task on the
// B4 phone, 50 to 670 ms (D96), where at a rest it costs a frame. So
// while two fingers move the view (a pinch, a twist) neither is written:
// the badges keep their turn and size, moving with the table as its pieces
// do. Once the fingers rest (PINCH_REST_MS without a move), the badges take
// this view's size if the zoom has changed it by more than BZ_STEP since
// they were sized (pinchRest): a restyle the resting hand doesn't feel, and
// no badge stays grown over the pieces being zoomed in on; a twist alone
// never resizes them (a rectangle refits as it turns: by its fit alone,
// every twist would). They settle (upright, exact) once the fingers lift.
const viewSheet = new CSSStyleSheet(), BADGE_MAX = 3, BZ_STEP = 1.25, PINCH_REST_MS = 120;
viewSheet.replaceSync('#table .item > .count, #table .item > .odot, #table .item > .lockb, #table .pile > .pname, #table .item.selected, #table .blabels text {} '
  + '#table .psvg text {} #table .item > .count, #table .pile > .pname, #table .bag > .bagbox, #table .item > .lockb {}');
document.adoptedStyleSheets = [...document.adoptedStyleSheets, viewSheet];
let badgeZ = '', textAngle = 0, badgeAngle = 0, feltW = 0;

/** Sizes the badges for the view's scale (rule 0's --bz), if that changes it:
 *  a 12-unit badge text shows ≥ 8 px while it can. */
function sizeBadges() {
  const bz = clamp(0.67 / scale, 1, BADGE_MAX).toFixed(2);
  if (bz !== badgeZ) viewSheet.cssRules[0].style.setProperty('--bz', (badgeZ = bz));
}

function layout() {
  const w = (wrapW = wrapEl.clientWidth), h = (wrapH = wrapEl.clientHeight);
  // The fit: a round table by its diameter (so it never refits as the view
  // turns), a rectangle by its bounding box at the view's angle.
  const a = (viewAngle * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)), rect = TABLE.shape === 'rect';
  const bw = rect ? TABLE_W * c + TABLE_H * sn : TABLE_W, bh = rect ? TABLE_W * sn + TABLE_H * c : TABLE_H;
  scale = Math.min(w / bw, h / bh) * zoomZ; // fit × user zoom
  if (viewAngle !== textAngle) viewSheet.cssRules[1].style.setProperty('--view', `${(textAngle = viewAngle)}deg`);
  if (!pinch) {
    sizeBadges();
    if (viewAngle !== badgeAngle) viewSheet.cssRules[2].style.setProperty('--view', `${(badgeAngle = viewAngle)}deg`);
  }
  feltW = bw * scale; // (placeSeats: the hint's plate fits its middle, the notices the margins beside it)
  // keep at least the table's center reachable
  panX = clamp(panX, -(bw * scale) / 2, (bw * scale) / 2);
  panY = clamp(panY, -(bh * scale) / 2, (bh * scale) / 2);
  // Center the unscaled table on the wrap; then scale, rotate, and pan.
  tableEl.style.left = `${(w - TABLE_W) / 2}px`;
  tableEl.style.top = `${(h - TABLE_H) / 2}px`;
  tableEl.style.transform = `translate(${panX}px, ${panY}px) rotate(${viewAngle}deg) scale(${scale})`;
  if (sel) placeBar();
  for (const b of bulbs.values()) placeFx(b);
  renderPlayers(true); // seat labels live in screen space and track the view
}
new ResizeObserver(layout).observe(wrapEl);

/** Pointer event (or {clientX, clientY}) `e` → table coords: the item
 *  frame, #table's padding box, which is its whole w × h (style.css: the
 *  rail is a shadow, not a border). */
function toTable(e) {
  const r = wrapEl.getBoundingClientRect();
  const [ux, uy] = rotv(e.clientX - r.left - r.width / 2 - panX, e.clientY - r.top - r.height / 2 - panY, -viewAngle);
  return { x: TABLE_W / 2 + ux / scale, y: TABLE_H / 2 + uy / scale };
}

/** Table coords -> wrap-relative screen px, honoring the view transform. */
function tableToScreen(x, y) {
  const [rx, ry] = rotv((x - TABLE_W / 2) * scale, (y - TABLE_H / 2) * scale, viewAngle);
  return [wrapW / 2 + panX + rx, wrapH / 2 + panY + ry];
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
  zoomZ = clamp(zoomZ * Math.exp(-e.deltaY * 0.0015), 0.5, zoomMax());
  layout();
  anchorView(before, e.clientX, e.clientY);
}, { passive: false });

/** Item rotation that appears upright on THIS player's rotated screen. */
const uprightRot = () => ((-viewAngle % 360) + 360) % 360;

/** Rotates the view so the player's own seat is at the bottom of the
 *  screen: on a round table by the seat's angle; on a rectangle by the
 *  multiple of 90° that puts the edge nearest the seat at the bottom. */
function applySeatView() {
  if (manualView) return;
  const s = view.players[pid]?.seat, rect = TABLE.shape === 'rect';
  if (s == null && !rect) return; // a watcher keeps the view it has; on a rectangle, squared to its nearest edge
  let a = s ?? 90 - Math.round(viewAngle / 90) * 90; // the angle that goes to the bottom (90°)
  if (rect && s != null) {
    const { x, y } = seatXY(pid), gaps = [[0, TABLE_W - x], [90, TABLE_H - y], [180, x], [270, y]]; // right, bottom, left, top
    a = gaps.reduce((m, g) => (g[1] < m[1] ? g : m))[0];
  }
  const want = (((90 - a) % 360) + 360) % 360;
  if (Math.abs(want - viewAngle) > 0.5) { viewAngle = want; layout(); }
}

// --- selection & action bar ----------------------------------------------
const ARM_MS = 5000; // how long ✥ Move stays armed
let moveAll = null; // {id, at}: ✥ Move armed at `at` — the next drag of that ×N stack or supply moves all of it (until ARM_MS has passed)
let giveOpen = false; // the host's Give ▸ list is open in the bar
let barHTML = ''; // what the bar shows (barFor's markup)
function select(id) {
  sel = id;
  giveOpen = false;
  for (const [i, el] of itemEls) el.classList.toggle('selected', i === sel);
  renderBar();
}
/** Builds the selected item's action bar (hidden when it offers nothing) and
 *  places it. An armed ✥ Move shows how much of its time is left (style.css). */
function renderBar() {
  const it = sel && view.items[sel];
  barEl.innerHTML = barHTML = it ? barFor(sel, it) : '';
  barEl.classList.toggle('hidden', !barHTML);
  barEl.querySelector('.on[data-cmd="all"]')?.style.setProperty('animation-delay', `${moveAll.at - Date.now()}ms`);
  if (it) placeBar();
}
/** Keeps the open bar true to the view after a redraw (`prev`: the items
 *  it redrew, null: all): redrawn when what it offers changed — its item,
 *  or who may do what with it (a seat taken or left turns who owns a
 *  seat-bound piece, a player joins the Give ▸ list) — else moved along
 *  with its item. A bar that offers what the host would now refuse would
 *  send it, from a button or a key. */
function syncBar(prev) {
  const it = sel && view.items[sel];
  if (sel && !it) select(null);
  else if (it && barFor(sel, it) !== barHTML) renderBar();
  else if (it && (!prev || prev.has(sel))) placeBar();
}
/** The buttons of public item `it`'s bar (spec §2g), built from the public
 *  view alone (a hidden piece's flags are its back's: flagsOf), and only
 *  with what this player may do. */
function barFor(id, it) {
  const b = (cmd, text, cls = '') => `<button data-cmd="${cmd}"${cls ? ` class="${cls}"` : ''}>${text}</button>`;
  const may = mayTouch(it), free = may && !it.lock, F = flagsOf(it, boxes), room = handRoom();
  const lock = mayLock(it) ? b('lock', it.lock ? '🔓 Unlock' : '🔒 Lock') : '', del = free ? b('del', '🗑') : '';
  const unlock = it.lock ? lock : ''; // cards and piles: only the host locks them, rarely (a script does): unlocking is offered, locking isn't
  const all = (text) => b('all', text, moveAll?.id === id ? 'on' : ''); // ✥: Shift+drag for touch
  if (it.k === 'c') {
    return (free ? b('flip', 'Flip') : '') + (it.up ? b('zoom', '🔍') : may ? b('peek', 'Peek') : '')
      + (free ? b('rl', '⟲90') + b('rr', '⟳90') + (room ? b('hand', 'Hand') : '') : '') + unlock + del;
  }
  if (it.k === 'p') { // a pile of cards, or of pieces (a pile of pieces turns over when they have a back, and is drawn when they go in a hand)
    const top = it.top || {}, cards = 'd' in top;
    const turns = cards || 'b' in top || !!typeAt(boxes, top.t)?.back;
    return (may && F.hand && room ? b('draw', 'Draw') : '') + (may ? b('peek', 'Peek') + b('dealup', 'Deal↑') + b('dealdn', 'Deal↓') + b('shuffle', 'Shuffle') : '')
      + (free && turns ? b('flip', 'Flip') : '') + (free ? b('rr', cards ? '⟳90' : '⟳') : '') + unlock + del;
  }
  if (it.k === 'b') return (may && it.n ? b('pull', 'Draw') + (it.hand && room ? b('pullHand', '✋ Draw to hand') : '') : '') + lock + del;
  if (it.k === 's') return (may ? b('take', 'Take 1') + (F.hand && room ? b('takeHand', '✋') : '') : '') + (free ? all('✥ Move') : '') + lock + del;
  const die = isDie(it), owner = ownerOf(it), host = role === 'host';
  const players = Object.entries(view.players).filter(([p]) => p !== it.owner);
  const give = giveOpen ? `<span class="give">${players.map(([p, pl]) => `<button data-cmd="giveTo" data-to="${esc(p)}">${esc(pl.name || 'Player')}</button>`).join('')}${
    (view.seats || []).filter((st) => it.owner !== `seat:${st.id}`).map((st) => `<button data-cmd="giveTo" data-to="seat:${esc(st.id)}">🪑 ${esc(st.name)}</button>`).join('')}</span>` : '';
  return (free && flips(it) ? b('flip', 'Flip') : '')
    + (die && may ? b('roll', '🎲 Roll') : '')
    + (free && !die && pieces.turnShows(it, boxes) ? b('rl', '⟲') + b('rr', '⟳') : '') // (a plain checker looks the same at any angle)
    + (free && it.n >= 2 ? b('split', '✂ Take 1') + all('✥ Move all') : '')
    + (free && F.hand && room ? b('hand', '✋ Hand') : '')
    + (pieces.zoomable(it, boxes) ? b('zoom', '🔍') : '')
    + lock
    + (!it.owner && !it.lock && !isBoard(it) ? b('claim', '👤 Claim') : it.owner && (owner === pid || host) ? b('release', '👤 Release') : '')
    + (host ? b('give', 'Give ▸', giveOpen ? 'on' : '') + give : '')
    + del;
}

// The bar lives OUTSIDE the scaled table (in screen space) so its buttons stay
// finger-sized on small screens; convert the item's table coords to screen px.
function placeBar() {
  const it = view.items[sel];
  if (!it) return;
  const { w, h } = sizeOf(it, boxes), [sx, sy] = tableToScreen(it.x + w / 2, it.y + h / 2);
  const half = Math.max(w, h) * 0.6 * scale; // covers rotated items too
  // The bar's real size: it wraps into rows on a narrow screen.
  const hw = barEl.offsetWidth / 2, bh = barEl.offsetHeight;
  const yAbove = sy - half - bh - 4;
  barEl.style.left = `${clamp(sx, hw + 4, wrapW - hw - 4)}px`;
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
/** Puts name bulb `b` over its item, by a translation: a pan frame that
 *  moves it lays nothing out (no layout, and so no hover hit test of the
 *  table under a resting mouse: on 1,000 cards that cost a frame, B4). */
function placeFx(b) {
  const it = b.f.id && view.items[b.f.id], { w, h } = it ? sizeOf(it, boxes) : { w: CARD_W, h: CARD_H };
  const [sx, sy] = tableToScreen((it ? it.x : b.f.x) + w / 2, (it ? it.y : b.f.y) + h / 2);
  b.el.style.translate = `${clamp(sx, 30, wrapW - 30)}px ${Math.max(20, sy - h * 0.55 * scale)}px`;
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

/** A spot next to an item for dealt cards (or pieces), jittered so repeated deals stay visible. */
function dealSpot(it) {
  const j = () => Math.round(Math.random() * 24 - 12), { w } = sizeOf(it, boxes);
  const x = it.x + w + 18;
  return x + w <= TABLE_W ? { x: x + j(), y: it.y + j() } : { x: it.x - w - 18 + j(), y: it.y + j() };
}

/** The bar's commands on the selected item `it` (the keys run them too: see keydown). */
const CMDS = {
  flip: (id) => act({ t: 'flip', id }),
  rl: (id, it) => act({ t: 'rot', id, rot: it.rot - rotStep(it) }),
  rr: (id, it) => act({ t: 'rot', id, rot: it.rot + rotStep(it) }),
  hand: (id) => act({ t: 'toHand', id }),
  del: (id) => act({ t: 'del', id }),
  draw: (id) => act({ t: 'draw', id }),
  dealup: (id, it) => act({ t: 'deal', id, up: true, rot: uprightRot(), ...dealSpot(it) }),
  dealdn: (id, it) => act({ t: 'deal', id, up: false, rot: uprightRot(), ...dealSpot(it) }),
  shuffle: (id) => act({ t: 'shuffle', id }),
  peek: (id) => act({ t: 'peek', id }), // the host logs it, then reveals the card to us alone (showPeek)
  zoom: (id, it) => showZoom(it.k === 'c' ? it : pieces.zoomable(it, boxes)), // a face everyone sees: silent
  roll: (id) => act({ t: 'roll', ids: handful(id) }),
  take: (id, it) => act({ t: 'take', id, ...dealSpot(it) }),
  takeHand: (id) => act({ t: 'take', id, hand: true }),
  pull: (id, it) => act({ t: 'pull', id, ...dealSpot(it) }),
  pullHand: (id) => act({ t: 'pull', id, hand: true }),
  split: (id, it) => act({ t: 'split', id, n: 1, ...dealSpot(it) }),
  all: (id) => { // arms (or disarms) a whole-stack or supply drag for ARM_MS: touch has no Shift key
    const armed = (moveAll = moveAll?.id === id ? null : { id, at: Date.now() });
    if (armed) setTimeout(() => { if (moveAll === armed) { moveAll = null; renderBar(); } }, ARM_MS);
    renderBar();
  },
  lock: (id, it) => act({ t: 'lock', id, on: !it.lock }),
  claim: (id) => act({ t: 'owner', id, to: pid }),
  release: (id) => act({ t: 'owner', id, to: null }),
  give: () => { giveOpen = !giveOpen; renderBar(); },
  giveTo: (id, it, to) => act({ t: 'owner', id, to }),
};
/** The step ⟲ and ⟳ turn item `it` by: a card's 90°; a piece's rotStep (45 when it turns freely). */
const rotStep = (it) => (pieceLike(it) ? flagsOf(it, boxes).rotStep || 45 : 90);
barEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]'), it = sel && view.items[sel];
  if (btn && it) CMDS[btn.dataset.cmd]?.(sel, it, btn.dataset.to);
});

/** The dice a roll of die `id` takes along (spec §2g, a handful): every die
 *  this player may handle within one die-width of a die already in it,
 *  transitively (dice side by side roll together), up to MAX_ROLL; `id` first. */
function handful(id) {
  const spot = (it) => { const { w, h } = sizeOf(it, boxes); return { x: it.x + w / 2, y: it.y + h / 2, s: Math.max(w, h) }; };
  const dice = Object.keys(view.items).filter((k) => k !== id && isDie(view.items[k]) && mayTouch(view.items[k])).map((k) => [k, spot(view.items[k])]);
  const out = [id], at = [spot(view.items[id])];
  for (let k = 0; k < at.length && out.length < MAX_ROLL; k++) {
    for (let j = 0; j < dice.length && out.length < MAX_ROLL; j++) {
      const [d, b] = dice[j], a = at[k];
      if (Math.hypot(a.x - b.x, a.y - b.y) > (a.s + b.s) / 2 + Math.min(a.s, b.s)) continue;
      out.push(d);
      at.push(b);
      dice.splice(j--, 1);
    }
  }
  return out;
}

// --- card zoom overlay (also used by the loud peek) -------------------------
const peekEl = $('peek');
let zoomed = null; // {c, caption}: the card {d, i} or piece {t, f} the overlay shows (redrawn when its deck or box arrives)
/** Shows card {d, i} or piece {t, f} `c` enlarged (a zoom, or a peek's answer). */
function showZoom(c, caption) {
  zoomed = { c, caption };
  const v = 't' in c ? pieces.zoomView(c, boxes, faceImage) : { html: faceHTML(c.d, c.i), w: CARD_W, h: CARD_H };
  // Scale the card to comfortably fill the viewport — this is the readable
  // view for decks with small text.
  const f = Math.min((window.innerHeight * 0.72) / v.h, (window.innerWidth * 0.85) / v.w), inner = $('peek-inner');
  inner.style.transform = `scale(${f})`;
  inner.style.width = 't' in c ? `${v.w}px` : '';
  inner.style.height = 't' in c ? `${v.h}px` : '';
  inner.innerHTML = v.html;
  $('peek-cap').textContent = caption || 'Click anywhere to close';
  peekEl.classList.remove('hidden');
}
peekEl.addEventListener('click', () => peekEl.classList.add('hidden'));
// A button clicked or tapped lets go of the focus, as one pressed on the
// table does (pointerdown): the keys below skip a focused button, and Space
// or Enter would press it again — after the bar's ⟳ (which leaves the bar as
// it was: syncBar redraws only what changed) or 🧭 in the header, R must turn
// the piece and Space roll the die. A focus the click put elsewhere stays: in
// an open dialog, or in the chat (➤ puts it back there). A button reached
// and pressed from the keyboard (detail 0) keeps the focus.
// A dialog that closes hands the focus back to the button that opened it,
// however it closes (a button, Escape, or + Deck's form once its deck is
// built: after an await, for a guest or an image deck). So that button lets
// go again then, if a pointer pressed it last (one pressed from the keyboard
// keeps it): `close` doesn't bubble, hence the capture.
const byPointer = new WeakSet(); // the buttons a pointer, not a key, pressed last
/** Blurs the focused button, unless it is in an open dialog (`opener`: only
 *  one a pointer pressed last). */
function letGo(opener) {
  const f = document.activeElement;
  if (f?.matches('button') && !f.closest('dialog[open]') && (!opener || byPointer.has(f))) f.blur();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('button');
  if (!b) return;
  if (!e.detail) { byPointer.delete(b); return; }
  byPointer.add(b);
  letGo();
});
document.addEventListener('close', () => { letGo(true); setTimeout(() => letGo(true)); }, true); // (at once, and after a browser that restores the focus later)
// Keys, outside inputs (an open <dialog> keeps them, Escape included: the
// browser closes it). Escape closes the zoom or peek overlay, else the seat
// menu, else dismisses the action bar. The others are the bar's shortcuts on
// the selected item, run only when its bar offers them: R / Shift+R rotate,
// F flips, Space rolls a die (and its handful), Delete removes.
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (!peekEl.classList.contains('hidden')) peekEl.classList.add('hidden');
    else if (!seatMenuEl.classList.contains('hidden')) closeSeatMenu();
    else select(null);
    return;
  }
  // (a held key fires once: an auto-repeat would roll, flip or delete again and again, for everyone)
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, button')) return;
  const k = e.key.toLowerCase(), cmd = k === 'r' ? (e.shiftKey ? 'rl' : 'rr') : { f: 'flip', ' ': 'roll', delete: 'del', backspace: 'del' }[k];
  const it = sel && view.items[sel];
  if (!cmd || !it || !barEl.querySelector(`[data-cmd="${cmd}"]`)) return;
  e.preventDefault();
  CMDS[cmd](sel, it);
});
/** Reveals a peeked card {d, i} or piece {t, f} to this player only (the host's answer to a peek action). */
function showPeek(c) {
  showZoom(c, 'Only you can see this — everyone knows you peeked. Click to close.');
  if (CLI) cliMsgs.push(`peek: ${'t' in c ? pieceName(boxes, c.t, c.f) : cardName(decks, c.d, c.i)}`);
}

// --- dragging table items / pan / pinch -------------------------------------
let feltDrag = null; // dragging empty felt = panning MY view
let pinch = null;    // two-finger gesture: zoom + rotate + pan in one
let holdZoom = false; // a long-press zoom is showing: it closes when the finger lifts
const tPtrs = new Map(); // pointers currently down on the table
let dragEndAt = -1e9; // when the last drag, pan or pinch ended (event time): the click that follows it is no tap

/** Puts down drag `d`'s element: a copy taken out of a stack or a supply goes; a moved item loses its drag look. */
const dropEl = (d) => (d.ghost ? d.el.remove() : d.el.classList.remove('dragging'));
/** Ends an in-flight item drag cleanly (used when a pinch takes over): a
 *  moved item stays where it is; a piece being taken out goes back. */
function cancelItemDrag() {
  if (!drag) return;
  dropEl(drag);
  if (drag.moved && drag.mode === 'move' && view.items[drag.id]) act({ t: 'move', id: drag.id, x: drag.x, y: drag.y });
  drag = null;
}

/** What a drag that starts on public item `it` does (spec §2g): 'take' a
 *  new piece out of a supply, 'split' one piece off a ×N stack, or 'move'
 *  the item — Shift, or ✥ Move armed, moves a whole stack or a supply.
 *  null: it pans the view, as empty felt does — the item is locked (a board,
 *  by default) or someone else's, and the host would refuse the action. */
function dragMode(id, it, e) {
  if (!mayTouch(it)) return null;
  const all = e.shiftKey || moveAll?.id === id;
  if (it.k === 's' && !all) return 'take'; // (a locked supply still hands pieces out)
  if (it.lock) return null;
  return it.k === 'g' && it.n >= 2 && !all ? 'split' : 'move';
}

/** Whether piece `a` (adding `add` pieces) joins piece `b`'s ×N stack: both
 *  shown, of one type, face and owner, of a type stacking by count, ≤ MAX_N (core's stackable). */
const counts = (a, b, add) => a.k === 'g' && b.k === 'g' && 't' in a && 't' in b && a.t === b.t && a.f === b.f && a.owner === b.owner
  && flagsOf(b, boxes).stack === 'count' && (b.n || 1) + add <= MAX_N;
/** Whether loose piece-like `m` and public item `b` pile up (core's fits): cards with cards, or pieces stacking as a pile, of one size. */
function fits(m, b) {
  const fm = flagsOf(m, boxes), fb = flagsOf(b, boxes), card = (x) => x.k === 'c' || (x.k === 'p' && 'd' in (x.top || {}));
  if (card(m) || card(b)) return card(m) && card(b);
  return fm.stack === 'pile' && fb.stack === 'pile' && fm.w === fb.w && fm.h === fb.h && !fm.placeholder;
}
/** Whether piece `it` goes back into public supply `s` (join b): a shown piece of its type. */
const returns = (it, s) => s.k === 's' && 't' in it && s.t === it.t;
/** Whether public bag `bag` takes `n` of piece `it` (core's toBag): room for
 *  them (MAX_BAG), and a bag made for hands takes only pieces that go in one. */
const bagTakes = (bag, it, n) => bag.k === 'b' && (bag.n || 0) + n <= MAX_BAG && (!bag.hand || flagsOf(it, boxes).hand);
/** The action a drop of drag `d` (of public item `it`) sends (spec §2g): onto
 *  the hand bar, onto public item `tgt` (id tgtId), or else a move to the drop
 *  spot — and never one the host would refuse (an owner, a lock, a cap: a
 *  full bag, pile or hand takes nothing, the piece just lands there). One
 *  piece taken off a ×N stack goes onto what it lands on in one `split`
 *  {onto}: a matching stack, its supply, a bag. */
function dropAction(d, it, tgtId, tgt, onHand) {
  const { id, x, y, mode } = d, held = onHand && flagsOf(it, boxes).hand && handRoom(), may = !!tgt && mayTouch(tgt);
  if (mode === 'take') return held ? { t: 'take', id, hand: true } : { t: 'take', id, x, y };
  if (mode === 'split') {
    if (held) return { t: 'toHand', id };
    return may && (counts(it, tgt, 1) || returns(it, tgt) || bagTakes(tgt, it, 1)) ? { t: 'split', id, n: 1, onto: tgtId } : { t: 'split', id, n: 1, x, y };
  }
  if (held && (it.k === 'c' || it.k === 'g')) return { t: 'toHand', id };
  if (may && it.k === 'g') {
    if (counts(it, tgt, it.n || 1) || returns(it, tgt)) return { t: 'join', id, onto: tgtId };
    if (bagTakes(tgt, it, it.n || 1)) return { t: 'toBag', id, bag: tgtId };
  }
  if (may && (it.k === 'c' || (it.k === 'g' && !(it.n >= 2))) && 'cgp'.includes(tgt.k) && fits(it, tgt) && !(tgt.n >= MAX_PILE)) {
    return tgt.k === 'p' ? { t: 'toPile', id, pile: tgtId } : { t: 'stack', id, onto: tgtId };
  }
  if (may && it.k === 'p' && tgt.k === 'p' && fits(it, tgt) && it.n + tgt.n <= MAX_PILE) return { t: 'merge', id, pile: tgtId };
  return { t: 'move', id, x, y };
}

/** The face a long press shows enlarged on public item `it`: a face-up card
 *  or card pile top; a piece's face with an image, a text or a label; else null. */
const pressFace = (it) => (it.k === 'c' ? it.up && it : it.k === 'p' && 'd' in (it.top || {}) ? it.top.up && it.top : pieces.zoomable(it, boxes));

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
    zb: zoomZ, // the zoom the badges were last sized at
    rest: 0, // the timer that sees the fingers rest (pinchRest)
  };
}

/** The fingers rest mid-pinch: the badges take this view's size if the zoom
 *  has changed it by more than BZ_STEP since they were sized (see viewSheet). */
function pinchRest() {
  if (Math.max(zoomZ / pinch.zb, pinch.zb / zoomZ) <= BZ_STEP) return;
  pinch.zb = zoomZ;
  sizeBadges();
}

/** The two-finger gesture ends: the badges, which kept their turn (and their size, but for a rest's) meanwhile, settle (layout). */
function endPinch() {
  clearTimeout(pinch.rest);
  pinch = null;
  layout();
}

function updatePinch() {
  const [p1, p2] = [...tPtrs.values()];
  const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const ang = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
  zoomZ = clamp(pinch.z0 * (d / pinch.d0), 0.5, zoomMax());
  viewAngle = (((pinch.a0 + ang - pinch.ang0) % 360) + 360) % 360;
  manualView = true;
  layout();
  anchorView(pinch.t0, m.x, m.y); // the felt tracks the fingers
  clearTimeout(pinch.rest);
  pinch.rest = setTimeout(pinchRest, PINCH_REST_MS);
}

tableEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('#action-bar')) return;
  closeSeatMenu();
  // (the preventDefault below also keeps the focus where it was: let it go, as a
  // click elsewhere would, so the keys reach the table and not, say, 🧭)
  document.activeElement?.blur?.();
  tPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tPtrs.size === 2) { e.preventDefault(); startPinch(); return; }
  if (tPtrs.size > 2 || pinch) return;
  const el = e.target.closest('.item'), id = el?.dataset.id, it = id && view.items[id];
  const mode = it && dragMode(id, it, e);
  if (mode) e.preventDefault();
  const p = mode && toTable(e);
  // An item drag, or a pan: felt, and items this player may not drag (spec
  // §2g: locked, or someone else's), pan the view; a tap on such an item
  // still selects it. An item drag's live position lives on its record (x,
  // y), never in view.items: incoming states replace those objects mid-drag
  // (a guest would drop at a stale spot), and the host must not touch state
  // outside apply() (a vetoed drop has to snap back). A take or a split
  // drags a copy of one piece (made once the drag starts: a tap leaves nothing behind).
  const g = mode ? (drag = { id, el, mode, ghost: false, dx: p.x - it.x, dy: p.y - it.y, sx: p.x, sy: p.y, x: it.x, y: it.y, ox: it.x, oy: it.y, moved: false, last: 0 })
    : (feltDrag = { sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false, tap: it ? id : null });
  // Touch long-press (≈450 ms without moving) zooms a face-up card, a pile's
  // top or a piece's face until the finger lifts (UX-I5); a drag, a pinch or
  // an early lift cancels it. Release-to-close also swallows the tap the
  // browser may synthesize on release, which would otherwise land on the overlay.
  const face = it && pressFace(it);
  if (face && e.pointerType !== 'mouse') {
    setTimeout(() => {
      if ((drag !== g && feltDrag !== g) || g.moved || pinch) return;
      drag = feltDrag = null;
      holdZoom = true;
      showZoom(face, 'Release to close');
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
  if (!view.items[drag.id]) { dropEl(drag); drag = null; return; }
  if (!drag.moved) {
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) < 5 / scale) return;
    drag.moved = true;
    if (drag.mode !== 'move') { // one piece out of a stack or a supply: its copy moves, the original stays
      const copy = drag.el.cloneNode(true);
      for (const x of copy.querySelectorAll('.count, .lockb')) x.remove();
      copy.classList.remove('selected', 'supply');
      delete copy.dataset.id;
      tableEl.appendChild(copy);
      Object.assign(drag, { el: copy, ghost: true });
    }
    if (drag.mode === 'move' || moveAll?.id === drag.id) moveAll = null; // (an armed Move all is spent)
    drag.el.classList.add('dragging');
    drag.el.style.zIndex = 100000; // visually on top; the host assigns the real z on move
    select(null);
  }
  const { w, h } = sizeOf(view.items[drag.id], boxes);
  ({ x: drag.x, y: drag.y } = clampToTable(TABLE, p.x - drag.dx, p.y - drag.dy, w, h));
  drag.el.style.left = `${drag.x}px`;
  drag.el.style.top = `${drag.y}px`;
  // Throttled live position for the other players; the final one is sent on drop.
  if (role === 'guest' && drag.mode === 'move' && e.timeStamp - drag.last > 60) {
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
  if (pinch && tPtrs.size < 2) endPinch();
  handResize = null;
  feltDrag = null;
  if (handDrag?.moved) { ghost?.remove(); ghost = null; }
  handDrag = null;
  cancelItemDrag();
});

window.addEventListener('pointerup', (e) => {
  tPtrs.delete(e.pointerId);
  if (pinch || drag?.moved || feltDrag?.moved || handDrag?.moved) dragEndAt = e.timeStamp;
  if (endHoldZoom()) return;
  if (pinch) {
    if (tPtrs.size < 2) endPinch(); // a leftover finger is inert
    return;
  }
  if (handResize) {
    handResize = null;
    localStorage.setItem('ct-handh', handH);
    return;
  }
  if (handDrag) { dropGhost(e); return; }
  if (feltDrag) {
    const { moved, tap } = feltDrag;
    feltDrag = null;
    // A plain click on empty felt deselects; on an item that can't be
    // dragged, (de)selects it — a board only when nothing else is selected:
    // a tap beside a selected piece mostly lands on the board, and only puts its bar away.
    if (!moved && !seatTap(e)) select(tap && sel !== tap && !(sel && isBoard(view.items[tap] || {})) ? tap : null);
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;
  const it = view.items[d.id];
  if (!it || !d.moved) {
    dropEl(d);
    if (it && !seatTap(e)) select(sel === d.id ? null : d.id);
    return;
  }
  // The drop target: hit-test BEFORE the dragged element takes the pointer
  // back (.dragging lets it through), so elementFromPoint sees underneath it.
  const under = document.elementFromPoint(e.clientX, e.clientY), tgtId = under?.closest('.item')?.dataset.id;
  dropEl(d);
  if (tgtId === d.id) return; // a piece taken out of its stack or supply and put back on it: nothing happened
  const a = dropAction(d, it, tgtId, tgtId && view.items[tgtId], !!under?.closest('#hand-bar'));
  if (a.t === 'move') {
    // The hold heals itself: with no confirming state (a script moved the
    // card elsewhere, a veto left it mid-drag, coalescing merged the state
    // away) we show where the host has it after 1.5 s, quiet table or not.
    const L = landing = { id: d.id, x: d.x, y: d.y, ox: d.ox, oy: d.oy };
    setTimeout(() => { if (landing === L) { landing = null; renderItems(new Map([[L.id, view.items[L.id]]])); } }, 1500);
  }
  act(a);
});

/** What a double-click on public item `it` does (spec §2g), or null: a card
 *  flips; a pile is drawn from; a die rolls with its handful; another piece
 *  turns over; a supply hands one out next to it; a bag hands one out next to
 *  it, or into the hand when it holds hand pieces. Nothing on a board, nor
 *  on what someone else owns, nor what the host would refuse. */
function dblAction(id, it) {
  if (!mayTouch(it) || isBoard(it)) return null;
  switch (it.k) {
    case 'c': return it.lock ? null : { t: 'flip', id };
    case 'p': return flagsOf(it, boxes).hand && handRoom() ? { t: 'draw', id } : null;
    case 's': return { t: 'take', id, ...dealSpot(it) };
    case 'b': return !it.n ? null : it.hand && handRoom() ? { t: 'pull', id, hand: true } : { t: 'pull', id, ...dealSpot(it) };
    default: return isDie(it) ? { t: 'roll', ids: handful(id) } : !it.lock && flips(it) ? { t: 'flip', id } : null;
  }
}
tableEl.addEventListener('dblclick', (e) => {
  const id = e.target.closest('.item')?.dataset.id, a = id && view.items[id] && dblAction(id, view.items[id]);
  if (a) act(a);
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
  if (!view.hand[idx]) return;
  handDragged = false;
  handDrag = { idx, card: view.hand[idx], sx: e.clientX, sy: e.clientY, moved: false, touch: e.pointerType !== 'mouse' };
});
// The zoom opens on click, not pointerup: a tap's click would otherwise land on
// the overlay that just opened under the finger and close it at once.
handEl.addEventListener('click', (e) => {
  const el = e.target.closest('.hcard');
  const c = el && view.hand[+el.dataset.idx];
  if (c && !handDragged) showZoom(c); // a drag dropped back on its card isn't a click
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
    ghost.innerHTML = playFacedown() && !('t' in handDrag.card) ? backHTML(handDrag.card.d) : handFace(handDrag.card);
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
  const overItem = under?.closest('.item'), loose = 't' in card ? { k: 'g', t: card.t, f: card.f } : { k: 'c' };
  const tgt = overItem && view.items[overItem.dataset.id]; // (view items carry no id: it is the key)
  if (tgt?.k === 'p' && mayTouch(tgt) && fits(loose, tgt) && tgt.n < MAX_PILE) { act({ t: 'handPile', idx, ...handRef(card), pile: overItem.dataset.id }); return; }
  if (!under?.closest('#table')) return;
  const p = toTable(e), { w, h } = sizeOf(loose, boxes);
  // rot: cards land upright from the player's (possibly rotated) point of view
  act({ t: 'play', idx, ...handRef(card), x: p.x - w / 2, y: p.y - h / 2, up: !playFacedown(), rot: uprightRot() });
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

// --- rules dialog & game picker (🎲, host only; templates.js) ---------------
let askGame = false; // a brand-new table: invite the host to pick a game (the strip)

/** The picker entry matching what the host is running now: a rules
 *  template, else the built-in box last set up (rules off), else the free table. */
function currentGame() {
  if (T?.state.rules?.enabled) return GAMES.find((g) => RULES_TEMPLATES[g.k] === T.state.rules.code)?.k || 'custom';
  const last = T?.state.boxes[T.state.lastSetup];
  return (last && isBuiltin(last) && GAMES.find((g) => g.box && BOXES[g.box].name === last.name)?.k) || 'free';
}

function renderGames() {
  const isHost = role === 'host';
  $('games-btn').classList.toggle('hidden', !isHost);
  $('game-strip').classList.toggle('hidden', !isHost || !askGame || !!T?.state.rules);
  $('game-strip').classList.toggle('compact', Object.keys(view.players).length > 1);
}

/** Starts game `k` through the same setRules action as the 📜 dialog
 *  (whose act() re-renders, hiding the strip; 'custom' renders itself).
 *  Switching away from a running game asks first: its state would be lost.
 *  (The free table only disables the rules: re-enabling keeps the state.) */
function pickGame(k) {
  const box = GAMES.find((g) => g.k === k)?.box;
  if (box) { pickBox(k, box); return; }
  // Another game's state (chips, scores, a hand) is discarded by setRules —
  // even while the rules are off ("Free table" keeps it for re-enabling).
  // setRules keeps the state of a script with the same name: compare names too.
  const tplName = /\bname: (['"])(.*?)\1/.exec(RULES_TEMPLATES[k] || '')?.[2], rules = T?.state.rules;
  if (RULES_TEMPLATES[k] && rules && rules.name !== tplName && !confirm(rules.enabled
    ? `Stop ${rules.name}? Its game state (chips, scores, the hand in progress) will be lost.`
    : `Discard the kept ${rules.name} game state (chips, scores)?`)) return;
  askGame = false;
  $('games-dialog').close();
  if (k === 'custom') { renderAll(); $('rules-btn').click(); }
  else if (k === 'free') act({ t: 'setRules', enabled: false });
  else {
    $('rules-code').value = RULES_TEMPLATES[k]; // the 📜 dialog shows what runs
    act({ t: 'setRules', code: RULES_TEMPLATES[k], enabled: true });
  }
}

/** Sets up box game `k` (BOXES[box], spec §2g): on a table with items or a
 *  rules state, only once the host agrees to discard them; the rules are
 *  switched off (it is played by hand), then the box is set up on a cleared table. */
function pickBox(k, box) {
  const { title } = GAMES.find((g) => g.k === k);
  if ((Object.keys(T.state.items).length || T.state.rules) && !confirm(`Clear the table and set up ${title}? The current game is discarded.`)) return;
  askGame = false;
  $('games-dialog').close();
  if (T.state.rules?.enabled) act({ t: 'setRules', enabled: false });
  act({ t: 'loadBox', box: BOXES[box], setup: true, clear: true });
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
  const meta = isHost ? T?.state.rules : view.rules;
  $('rules-status').textContent = meta?.enabled ? `active: ${meta.name}` : 'inactive';
  $('rules-tpl').classList.toggle('hidden', !isHost);
  $('rules-enable').classList.toggle('hidden', !isHost);
  $('rules-reset-lbl').classList.toggle('hidden', !isHost);
  $('rules-disable').classList.toggle('hidden', !isHost || !meta?.enabled);
  $('rules-code').readOnly = !isHost;
  $('rules-err').textContent = T?.rulesError || ''; // the host's last script error
}

$('rules-btn').addEventListener('click', () => {
  const ta = $('rules-code');
  if (role === 'host') {
    if (!ta.value.trim()) ta.value = T?.state.rules?.code || RULES_TEMPLATES.blank;
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
  act({ t: 'setRules', code: $('rules-code').value, enabled: true, reset: $('rules-reset').checked });
  if (!T?.rulesError) $('rules-dialog').close(); // (the host applied it at once: setRules set or cleared the error)
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

// On a rectangle, a round size replaces it: asked first (items outside the circle are pulled in).
$('size-sel').addEventListener('change', () => {
  const size = +$('size-sel').value;
  if (TABLE.shape !== 'rect') act({ t: 'size', size });
  else if (confirm('Switch to a round table? Items outside it are pulled in.')) act({ t: 'table', shape: 'round', w: size, h: size });
  else renderSizeSel();
});
$('log-btn').addEventListener('click', () => {
  sideEl.classList.toggle('hidden');
  if (!sideEl.classList.contains('hidden')) logEl.scrollTop = logEl.scrollHeight;
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input'), msg = input.value.trim();
  input.focus(); // (sent with ➤: the next keys are the chat's, not R, F, Space or Delete on the selected piece)
  if (!msg) return;
  act({ t: 'chat', msg });
  input.value = '';
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
let persistAsked = false; // host: navigator.storage.persist() was asked, from its first upload
const deckBtn = (busy) => { $('deck-add').disabled = busy; $('deck-add').textContent = busy ? 'Building…' : 'Add deck'; };
$('deck-dialog').addEventListener('close', () => { deckBuild++; deckBtn(false); });
$('deck-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'add') return;
  e.preventDefault();
  if ($('deck-add').disabled) return;
  // The host's table now holds images worth keeping: ask the browser not to
  // evict its storage — here, in the gesture (Firefox prompts, and a prompt
  // right after an upload explains itself; one at boot would not).
  if (role === 'host' && !persistAsked && navigator.storage?.persist) {
    persistAsked = true;
    navigator.storage.persist().then((ok) => console.info(`persistent storage ${ok ? 'granted' : 'not granted'}`), (err) => console.error('asking for persistent storage failed', err));
  }
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
    // A guest ingests its own deck first (store.js: the same checks the host
    // runs), so it holds every image before the host's deck message names them.
    if (role === 'guest') await store.cache((await store.ingestDeck(deck)).assets);
    if (run !== deckBuild) return; // the player cancelled while it was building
    act({ t: 'addDeck', deck, x: TABLE_W / 2 - CARD_W / 2, y: TABLE_H / 2 - CARD_H / 2 });
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
/** Takes the host role over this room's save (store.js loadSave: a table,
 *  {lost}, {newer} or null), or a fresh table. `unsaved`: why this tab must
 *  not save at all (no IndexedDB, or a save it couldn't read), said at boot. */
function becomeHost(saved, unsaved) {
  noSave = unsaved || '';
  if (saved?.newer) {
    // Mixed versions run for minutes after a deploy: this older tab must
    // never overwrite the newer save with a downgraded one. It still hosts
    // (the save proves ownership), a fresh table, and saves nothing.
    noSave = 'a newer save';
    console.error(`this table was saved by a newer Card Table (state v${saved.newer}): not resuming it, and never writing over it`);
    toast('This table was saved by a newer Card Table — reload this page', false, true);
    saved = null;
  } else if (!noSave) checkPending(saved);
  if (saved?.lost) {
    console.error('this table could not be resumed:', saved.lost);
    toast(`Couldn't resume this table (${saved.lost}) — started a fresh one`);
    saved = null;
  } else if (saved?.behind) { // its last save is lost, an older copy isn't (a pre-Phase 1 save its migration couldn't replace)
    console.error("this table's last save could not be resumed:", saved.behind);
    toast(`Couldn't resume this table's last save (${saved.behind}) — resumed an older one`);
  }
  const t = createTable(saved ? { ...saved.state, decks: saved.decks, boxes: saved.boxes, boxSrc: saved.boxSrc } : {}, { pid });
  if (saved) t.resume(myName); // re-sanitizes the decks and boxes, reloads the rules, everyone else waits offline
  else t.open(myName); // the host's seat and a standard deck
  T = t;
  role = 'host';
  hostBoot = Date.now();
  askGame = !saved;
  savedCatalog.clear();
  if (saved?.stored) for (const id of [...Object.keys(saved.decks), ...Object.keys(saved.boxes || {})]) savedCatalog.add(id);
  $('size-sel').classList.remove('hidden'); // table size is the host's call
  commit(true);
  flush(); // this screen's first snapshot
  // The images this table shows must be in this browser's storage: say at
  // once if some are gone (their cards show as missing, never as loading forever).
  store.lacking([...T.assetRefs()]).then((lack) => { if (lack.length) giveUp(lack, `${lack.length} card images of this table are missing from this browser's storage`); }, (err) => {
    console.error("checking this table's images failed", err);
    toast(`Couldn't check this table's card images (${err.message})`);
  });
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
  return { name: cardName(decks, d, i), ...(c?.txt ? { text: c.txt } : {}), ...(c?.meta !== undefined ? { meta: c.meta } : {}) };
}
/** Who sits in named seat `id` (from the public view), or null. */
const seatHolder = (id) => Object.keys(view.players).find((p) => view.players[p].seatId === id) || null;
/** How the terminal names owner `o`: a seat's name ("White"), else the player's. */
const cliOwner = (o) => (o.startsWith('seat:') ? view.seats?.find((s) => s.id === o.slice(5))?.name || o.slice(5) : view.players[o]?.name || 'a player');
/** What the terminal says of a shown piece face {t, f}: its type's name and
 *  kind, the face's number, its label (or pips) and text — {} when its box isn't here. */
function cliFace(t, f) {
  const ty = typeAt(boxes, t), face = ty?.faces[f];
  if (!face) return {};
  const label = face.label ?? (face.pips !== undefined ? faceLabel(face, f) : undefined);
  return { kind: ty.kind, type: ty.name, typeRef: t, face: f, ...(label !== undefined && { label }), ...(face.text && { text: face.text }) };
}
/** A public item as the terminal sees it (spec §2i). */
function cliItemInfo(id, it) {
  const at = { x: it.x | 0, y: it.y | 0 }, mine = { ...(it.owner && { owner: cliOwner(it.owner) }), ...(it.lock && { locked: true }) };
  if (it.k === 'c') return { id, kind: 'card', ...at, up: !!it.up, ...(it.up ? cliCardInfo(it.d, it.i) : {}), ...mine };
  if (it.k === 'p') {
    const t = it.top, { type = '?', label } = t && !('d' in t) && t.up ? cliFace(t.t, t.f) : {};
    const top = t && ('d' in t ? t.up && cliCardInfo(t.d, t.i) : t.up ? { type, ...(label !== undefined && { label }) } : { hidden: true });
    return { id, kind: 'pile', name: it.name || null, count: it.n, ...at, ...(top && { top }), ...mine };
  }
  if (it.k === 'b') return { id, kind: 'bag', name: it.name || '', count: it.n, ...at, ...mine };
  const face = 't' in it ? cliFace(it.t, it.f) : null;
  if (it.k === 's') return { id, kind: 'supply', ...(!face ? { hidden: true } : face.kind ? { ...face, kind: 'supply', pieceKind: face.kind } : { unknown: true, typeRef: it.t }), ...at, ...mine };
  if (!face) return { id, kind: 'hidden', ...(it.n > 1 && { n: it.n }), ...at, ...mine };
  return face.kind ? { id, ...face, ...(it.n > 1 && { n: it.n }), ...at, ...mine } : { id, kind: 'unknown', typeRef: it.t, ...at, ...mine };
}

function cliSnapshot() {
  const rules = role === 'host' ? T?.state.rules : view.rules;
  const pub = (rules?.enabled && rules.public) || {};
  return {
    pid, name: myName, role, seq: view.seq, room: roomId,
    table: { shape: view.table.shape, w: view.table.w, h: view.table.h },
    seats: view.seats && view.seats.map((st) => ({ id: st.id, name: st.name, player: seatHolder(st.id) })),
    me: { seat: view.players[pid]?.seat ?? null, ...(view.players[pid]?.seatId && { seatId: view.players[pid].seatId }) },
    // key names the card (or piece) itself: a stable handle while indices shift (see cliExec 'play')
    hand: view.hand.map((c, idx) => ('t' in c
      ? { idx, key: `t:${c.t}:${c.f}`, kind: 'piece', name: typeAt(boxes, c.t)?.name || '?', ...(cliFace(c.t, c.f).label !== undefined && { label: cliFace(c.t, c.f).label }) }
      : { idx, key: `${c.d}:${c.i}`, ...cliCardInfo(c.d, c.i) })),
    players: Object.entries(view.players).map(([id, pl]) => ({
      id, name: pl.name, seat: pl.seat, online: pl.online, cards: pl.handCount,
      ...(pl.seatId ? { seatId: pl.seatId } : {}), ...(pl.seat == null ? { watching: true } : {}),
      ...([].concat(pub.turn).includes(id) ? { turn: true } : {}),
      ...(pub.badges?.[id] ? { badge: pub.badges[id] } : {}),
      ...(pub.winners?.includes(id) ? { winner: true } : {}),
    })),
    items: Object.entries(view.items).map(([id, it]) => cliItemInfo(id, it)),
    buttons: ((rules?.enabled && rules.public?.buttons) || [])
      .filter((b) => !b.pid || b.pid === pid).map((b) => ({ id: b.id, label: b.label })),
    rules: rules?.enabled ? rules.name : null,
    // rules: true marks script lines — a player can NAME itself "📜 Rules", but can't fake this
    log: view.log.slice(-40).map((e) => ({
      who: typeof e.n === 'string' ? e.n : actorInfo(e.p).name, text: e.txt,
      ...(e.c ? { chat: true } : {}), ...(e.p === RULES ? { rules: true } : {}), ts: e.ts,
    })),
    msgs: cliMsgs.slice(),
  };
}

const CLI_KINDS = { p: 'pile', b: 'bag', s: 'supply' };
/** Resolves a command's item reference: an exact id, a pile's or a bag's
 *  name, a supply's type name, or (for pile commands with no ref) the
 *  biggest pile on the table. */
function cliItem(ref, kind) {
  if (ref != null && view.items[ref] && (!kind || view.items[ref].k === kind)) return String(ref);
  const ent = Object.entries(view.items).filter(([, it]) => !kind || it.k === kind);
  const s = String(ref ?? '').toLowerCase();
  const byName = s && ent.find(([, it]) => (it.name || '').toLowerCase() === s || (it.k === 's' && typeAt(boxes, it.t)?.name.toLowerCase() === s));
  if (byName) return byName[0];
  if (ref == null && kind === 'p') {
    const top = ent.sort((a, b) => (b[1].n || 0) - (a[1].n || 0))[0];
    if (top) return top[0];
  }
  throw new Error(`no such ${CLI_KINDS[kind] || 'item'}: ${ref}`);
}

/** Drop spot for terminal plays/deals (an item w × h): explicit x/y, or
 *  jittered toward the player's own seat (like dropping cards in front of yourself). */
function cliSpot(c, w = CARD_W, h = CARD_H) {
  if (c.x != null && c.y != null) return clampToTable(TABLE, +c.x, +c.y, w, h);
  const S = seatXY(pid), cx = TABLE_W / 2, cy = TABLE_H / 2;
  const f = (0.5 + Math.random() * 0.25) * (TABLE.shape === 'rect' ? 1 : PLAY_R / Math.hypot(S.x - cx, S.y - cy));
  return clampToTable(TABLE, cx + (S.x - cx) * f - w / 2, cy + (S.y - cy) * f - h / 2, w, h);
}

/** The hand index a command means: by card (or piece) `key` when given (on
 *  the host seat a play shows in view.hand at once, so indices shift between
 *  two queued plays), else idx. */
function cliHandIdx(c) {
  const idx = c.key ? view.hand.findIndex((e) => ('t' in e ? `t:${e.t}:${e.f}` : `${e.d}:${e.i}`) === c.key) : +c.idx;
  if (!view.hand[idx]) throw new Error(`no hand card ${c.key || `#${c.idx}`}`);
  return idx;
}

function cliExec(c) {
  try {
    switch (c.t) {
      case 'chat': { const msg = String(c.msg ?? '').slice(0, 300); if (msg) act({ t: 'chat', msg }); break; }
      case 'play': {
        const idx = cliHandIdx(c), card = view.hand[idx];
        const { w, h } = sizeOf('t' in card ? { k: 'g', t: card.t, f: card.f } : { k: 'c' }, boxes), at = cliSpot(c, w, h);
        // as in the drag path, the rules' face-down hint wins over the default face up
        act({ t: 'play', idx, ...handRef(card), x: at.x, y: at.y, up: c.up !== false && !forcedFacedown(), rot: uprightRot() });
        break;
      }
      case 'discard': {
        const idx = cliHandIdx(c), card = view.hand[idx];
        act({ t: 'handPile', idx, ...handRef(card), pile: cliItem(c.pile, 'p') });
        break;
      }
      case 'draw': act({ t: 'draw', id: cliItem(c.id, 'p') }); break;
      case 'deal': { const at = cliSpot(c); act({ t: 'deal', id: cliItem(c.id, 'p'), up: !!c.up, rot: uprightRot(), x: at.x, y: at.y }); break; }
      case 'shuffle': act({ t: 'shuffle', id: cliItem(c.id, 'p') }); break;
      case 'flip': act({ t: 'flip', id: cliItem(c.id) }); break;
      case 'move': {
        const id = cliItem(c.id), { w, h } = sizeOf(view.items[id], boxes), at = clampToTable(TABLE, +c.x || 0, +c.y || 0, w, h);
        act({ t: 'move', id, x: at.x, y: at.y });
        break;
      }
      case 'rot': act({ t: 'rot', id: cliItem(c.id), rot: +c.deg || 0 }); break;
      case 'toHand': act({ t: 'toHand', id: cliItem(c.id) }); break;
      case 'peek': { // a face-up card is public; anything else is answered privately by the host (showPeek)
        const id = cliItem(c.id), it = view.items[id];
        if (it.k === 'c' && it.up) cliMsgs.push(`peek: ${cardName(decks, it.d, it.i)}`);
        else act({ t: 'peek', id });
        break;
      }
      case 'btn': act({ t: 'rulesBtn', id: String(c.id) }); break;
      case 'roll': { // `all`: every die this player may handle that isn't hidden (one roll takes at most MAX_ROLL)
        const ids = c.all ? Object.keys(view.items).filter((id) => { const it = view.items[id]; return it.k === 'g' && typeAt(boxes, it.t)?.kind === 'die' && mayTouch(it); })
          : (Array.isArray(c.ids) ? c.ids : [c.ids]).map((id) => cliItem(id));
        if (!ids.length) throw new Error('no dice to roll');
        if (c.all && ids.length > MAX_ROLL) throw new Error(`roll all: that is ${ids.length} dice — at most ${MAX_ROLL} per roll, name them`);
        act({ t: 'roll', ids });
        break;
      }
      case 'face': act({ t: 'face', id: cliItem(c.id), f: +c.f }); break;
      case 'take': case 'pull': {
        const id = cliItem(c.id, c.t === 'take' ? 's' : 'b'), at = c.x != null && c.y != null ? { x: +c.x, y: +c.y } : dealSpot(view.items[id]);
        act({ t: c.t, id, ...(c.hand ? { hand: true } : at) });
        break;
      }
      case 'split': act({ t: 'split', id: cliItem(c.id), ...(c.n != null && { n: +c.n }), ...(c.x != null && c.y != null && { x: +c.x, y: +c.y }) }); break;
      case 'toBag': act({ t: 'toBag', id: cliItem(c.id), bag: cliItem(c.bag, 'b') }); break;
      case 'lock': act({ t: 'lock', id: cliItem(c.id), on: c.on !== false }); break;
      case 'owner': act({ t: 'owner', id: cliItem(c.id), to: c.to ?? null }); break;
      case 'seat': act(c.watch ? { t: 'seat', watch: true } : c.sit ? { t: 'seat', sit: true } : { t: 'seat', id: String(c.id) }); break;
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
  // Module skew: a page cached across a deploy could pair this app.js with
  // other versions of its modules. Stop here, plainly, not with odd errors later.
  const skew = [['core.js', CORE_V], ['grid.js', GRID_V], ['pieces.js', pieces.MODULE_V], ['templates.js', TEMPLATES_V], ['store.js', store.MODULE_V]].filter(([, v]) => v !== MODULE_V);
  if (skew.length) {
    console.error(`module version mismatch: app.js is v${MODULE_V}, ${skew.map(([f, v]) => `${f} v${v}`).join(', ')}`);
    document.body.insertAdjacentHTML('afterbegin', '<div id="skew-banner">Card Table was updated while this page loaded — reload this page</div>');
    return;
  }
  // Storage first: the role depends on it. A failure is said, never covered
  // by a fallback (localStorage couldn't hold a big table anyway).
  let idbFailed = '', readFailed = '';
  await store.open({
    notify: toast, keep: keepImages,
    onVersionChange() { // a newer Card Table upgraded the database in another tab
      console.warn('the database was upgraded in another tab — this tab stops using it');
      if (role === 'host') noSave = 'an upgrade in another tab';
      toast(`Card Table was updated in another tab — reload this tab to keep ${role === 'host' ? 'saving' : 'caching card images'}`, false, true);
    },
    onPruned(room) { // another tab deleted our (idle) save to make room: write it again, every deck included
      if (room !== roomId) return;
      savedCatalog.clear();
      persist();
    },
  }).catch((err) => { idbFailed = `IndexedDB: ${err.message}`; });
  const m = location.hash.match(/^#room~([0-9a-f]+)~([0-9a-f]+)(?:~|$)/);
  let saved = null;
  if (m) {
    [, roomId, password] = m;
    // (a bot tab never hosts, so it never reads, or migrates, the host's save)
    if (!AS && !idbFailed) saved = await store.loadSave(roomId).catch((err) => { readFailed = err.message; return null; });
  } else {
    roomId = await newHostKey(); // the room id IS the host key's fingerprint
    password = rand(8);
    history.replaceState({}, '', `#room~${roomId}~${password}`);
  }
  signedRoom = roomId.length === 24;
  if (!localStorage.getItem('ct-name') && !AS) await askName();
  // The role. A bot tab is always a guest — even in the host's browser,
  // where the room's save would otherwise make this tab claim the table. A
  // browser that can't read its storage but holds the room's host key is the
  // host still (it lives in localStorage): a reload must not make the host a
  // guest of its own room. One that couldn't read the save never writes over
  // it: what it holds may be intact, and a reload may read it.
  let hosting = !AS && (!m || !!saved || (!!(idbFailed || readFailed) && localStorage.getItem(`ct-hostkey-${roomId}`) !== null));
  if (hosting && signedRoom && !(await useHostKey(roomId))) {
    console.error('this browser has the save but not the host key for this room');
    toast('This room\'s host key is missing here — joining as a guest');
    hosting = false;
  }
  if (idbFailed) {
    toast(hosting ? `This browser blocks storage (${idbFailed}) — the table can't be saved; reloading the host tab will reset it`
      : `This browser blocks storage (${idbFailed}) — card images will download again next time`);
  }
  if (readFailed) {
    toast(hosting ? `Couldn't read this table's save (${readFailed}) — this tab won't save over it; reload this page to try again`
      : `Couldn't read this browser's storage (${readFailed}) — reload this page to try again`, false, hosting);
  }
  if (hosting) becomeHost(saved, idbFailed || (readFailed && "its save couldn't be read"));
  else {
    role = 'guest';
    resumePaused();
  }
  if (window.innerWidth <= 820) sideEl.classList.add('hidden');
  layout();
  renderAll(null);
  connect();
  cliConnect();
  // Upkeep, once the page is settled: the image cache's GC (store.js gc).
  setTimeout(() => (window.requestIdleCallback || ((f) => f()))(() => store.gc({ keep: keepImages() }).then(
    ({ deleted, bytes }) => { if (deleted) console.info(`image cache: deleted ${deleted} unused images (${(bytes / 1e6).toFixed(1)} MB)`); },
    (err) => console.error('image cache upkeep failed', err))), 5000);
}
// The test hook (the harness sets window.CARDTABLE_TEST before load): the same
// act() a click uses, the view, this player's hand and log, the game boxes it
// holds (cleanBox'd; the host's are its table's), and the counters.
if (window.CARDTABLE_TEST) window.__ct = { act, view: () => view, hand: () => view.hand, log: () => view.log, boxes: () => boxes, perf };
boot().catch((err) => { console.error('boot failed', err); toast(`Failed to start: ${err.message}`); });
