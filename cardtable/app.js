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
  tableBoards, snapTo, snapAt, snaps, displayAddr, resolveAddr, liveFx, countSetup, checkTransportBox, boxOverBudget, publicBox, groupIds, GROUP_OPS, clampShift, MAX_GROUP,
} from './core.js?v=1';
import { MODULE_V as GRID_V, turn, spotOf } from './grid.js?v=1';
import * as pieces from './pieces.js?v=1';
import { RULES_TEMPLATES, GAMES, BOXES, MODULE_V as TEMPLATES_V } from './templates.js?v=1';
import * as store from './store.js?v=1';
import * as boxio from './boxio.js?v=1';

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
const perf = {
  snaps: 0, patches: 0, gaps: 0, snapRequests: 0, lastApplyMs: 0, lastRenderMs: 0, lastSnapRenderMs: 0, drawn: 0, lastTickMs: 0, lastSaveSyncMs: 0, saves: 0,
  lastJobMs: 0, // the host's last job on its own table (the rules off): T.apply alone (B19)
  // the rules Worker: Workers started and ended, jobs it ran, the last job's round trip (host: post to done applied),
  // its time in the Worker, the last start (spawn to ready), and the digest checks of test builds (checkDigest)
  workerStarts: 0, workerStops: 0, workerJobs: 0, lastRulesRoundtripMs: 0, lastRulesWorkerMs: 0, lastRulesInitMs: 0, digestChecks: 0, digestMismatches: 0,
};

// --- the host's action queue ------------------------------------------------
// Every state change on the host runs through one FIFO, in arrival order
// (spec §3f.5): a player's action, and core's internal jobs (spec §3c:
// `_join`, a player's first action while not online; `_leave`, their last
// connection closed; `_tick`, the rules' timers that are due; `_name`, the
// rename a new connection brings; `_rulesOff`). With the rules off, a job
// runs on the host's table, synchronously: one on an empty queue runs at
// once, in the caller's task, and the host's own clicks feel instant. With
// the rules on, the rules Worker runs every job (below), one at a time: the
// queue waits for its `done` — or for a Worker that is starting
// (`current`). Asynchronous preprocessing (deck ingestion) runs before a job
// enters the queue (submit). An action turned away before it ran changes
// nothing, and never queues: what it named is re-sent at once (refused).
const MAX_QUEUE = 500;
const queue = [];
let current = null; // the job the queue waits for: {p, a, resolve, id (posted to the Worker) | start (the Worker starting for it)}
let pumping = false;
/** Host: queues player p's action `a`. Resolves {ok: true} once it changed
 *  the table, {ok: false} when it changed nothing, and {ok: false, error}
 *  with the notice that refused it (a veto, flood control, a bad deck). A
 *  guest's action finding MAX_QUEUE jobs waiting is refused, and what it
 *  named re-sent; internal jobs (bounded by the peers and the timer) and
 *  the host's own always wait their turn. */
function enqueue(p, a) {
  if (queue.length >= MAX_QUEUE && p !== pid && a.t[0] !== '_') {
    console.warn(`the queue holds ${MAX_QUEUE} jobs: refused`, a.t, 'from', p);
    tell(p, '🚫 The table is busy — try again');
    refused(p, a);
    return Promise.resolve({ ok: false, error: 'the table is busy' });
  }
  return new Promise((resolve) => {
    queue.push({ p, a, resolve });
    pump();
  });
}
/** Player p's action `a` was turned away before it ran (flood control, a
 *  full queue): what it named is re-sent, so their optimistic move snaps
 *  back — at once, outside the queue: a re-send changes no state (core's
 *  refreshFor has its own flood bucket), so a flood never grows the queue
 *  while a slow hook holds it. */
function refused(p, a) {
  if (T.refreshFor(p, a)) scheduleBroadcast();
}
/** Runs the queued jobs in order while none is in flight. */
function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (!current && queue.length && role === 'host') runJob(queue.shift());
  } finally { pumping = false; }
}
/** Whether a `t` job of player p waits in the queue or is in flight. */
const waiting = (p, t) => (current?.p === p && current.a?.t === t) || queue.some((j) => j.p === p && j.a.t === t);
/** The last presence job (`_join`, `_leave`) queued or in flight for player
 *  p — what p's presence will be once the queue has run — or undefined. */
const lastPresence = (p) => [current, ...queue].filter((j) => j?.p === p && (j.a?.t === '_join' || j.a?.t === '_leave')).at(-1)?.a.t;
/** Hands job `job` to whoever runs it: the rules Worker while the rules are
 *  on (an Enable starts a new one; a Disable ends it, then the host's table
 *  takes it), else the host's table. */
function runJob(job) {
  const { p, a } = job;
  if (a.t === 'setRules' && p === pid) rulesHeld = false; // (the host decides about the rules now: see started)
  if (a.t === 'setRules' && p === pid && a.enabled) { startWorker(a.code, job); return; }
  if (worker) {
    if (a.t !== 'setRules' || p !== pid) { toWorker(job); return; }
    stopWorker(); // Disable: no Worker, and the host's table switches the rules off
  }
  hostJob(job);
}
/** Runs job {p, a, resolve} on the host's table, at once. */
function hostJob({ p, a, resolve }) {
  let changed = true; // a job that threw may have changed something: broadcast and save it
  try {
    const t0 = performance.now();
    changed = T.apply(p, a);
    perf.lastJobMs = performance.now() - t0;
  } catch (err) {
    console.error('action failed', a, err);
    toast(`Error: ${err.message}`);
    commit(changed);
    resolve(outcome(false, err.message));
    return;
  }
  const error = commit(changed, p);
  resolve(outcome(changed, error));
}
/** How a job ended, for its caller: {ok, error?}, and for an addBox the
 *  box the catalog holds for it (`id`: the `added` effect, drain). */
function outcome(changed, error) {
  const id = addedBox, ruled = ruledNo;
  addedBox = null;
  ruledNo = false;
  return { ...(error ? { ok: false, error, ...(ruled && { ruled }) } : { ok: changed }), ...(id && { id }) };
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
  if (a.t === 'addBox') return submitBox(p, a);
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
/** Host: player p's game box (`addBox`, spec §4c) — as a deck is (submit):
 *  checked on receipt, before anything is decoded (checkTransportBox: its
 *  size, MAX_BOX_CHARS, and its whole structure; a guest's cost against the
 *  guests' budget it shares with decks, minus what is in the works), then
 *  ingested outside the queue, after the player's earlier decks and boxes
 *  (store.js ingestBox: every image checked, re-hashed, at most
 *  MAX_BOX_BYTES in all), then queued as {t: 'addBox', box (its images
 *  asset ids, its decks catalog decks), cost}. All or nothing (spec §4h):
 *  the host's own box's images are stored first (store.stash), and a box
 *  whose images can't be stored is not added; a guest's are kept only once
 *  their box committed (holdImages), saved with it. Resolves like enqueue(),
 *  with `id`: the box the catalog now holds for it (new, or the same one
 *  already there). */
function submitBox(p, a) {
  const refuse = (why) => {
    console.error('rejected a box:', why);
    tell(p, `🚫 Box rejected: ${why}`);
    return { ok: false, error: why };
  };
  let cost;
  try { cost = checkTransportBox(a.box); } catch (err) { return Promise.resolve(refuse(err.message)); }
  if (p !== pid) {
    const over = boxOverBudget((T.state.guestDeckChars || 0) + reserved, cost);
    if (over) return Promise.resolve(refuse(over));
    reserved += cost;
  } else cost = 0;
  const ingest = () => store.ingestBox(a.box);
  const run = (ingesting.get(p) || Promise.resolve()).then(ingest, ingest).then(async ({ box, assets }) => {
    if (role !== 'host') return { ok: false, error: 'this tab is no longer the host' };
    if (p === pid) {
      try { await store.stash(assets); } catch (err) {
        console.error("the box's images could not be stored", err);
        const why = `Couldn't store the box's images: ${err.name === 'QuotaExceededError' ? 'storage is full' : err.message}`;
        toast(why);
        return { ok: false, error: why };
      }
    }
    const done = await enqueue(p, { t: 'addBox', box, cost });
    holdImages(assets, p === pid);
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
function holdImages(assets, stored = false) {
  if (role !== 'host') return;
  const refs = T.assetRefs(), ids = [...assets.keys()].filter((h) => refs.has(h));
  store.hold(new Map(ids.map((h) => [h, assets.get(h)])), stored);
  for (const h of ids) imgs.delete(h);
  if (ids.length) imagesArrived(ids);
}

/** Host, after a job: carries out what the table queued and, when it changed
 *  (core renumbered it), broadcasts (coalesced) and saves. Returns the first
 *  refusal notice ("🚫 …") addressed to `actor`, if any. */
function commit(changed, actor) {
  decks = T.state.decks; // the renderer's deck and box maps are the table's own (core may replace them)
  boxes = T.state.boxes;
  try {
    return drain(actor);
  } finally { // (an effect that fails is a bug, which throws on: the table changed all the same, so it goes out and is saved)
    if (changed) { scheduleBroadcast(); persist(); }
  }
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
    if (a.t === 'drag') { relay(pid, a); return Promise.resolve({ ok: true }); }
    const done = submit(pid, a);
    flush(); // the host's own move shows at once, not on the next tick
    return done;
  }
  if (!room) { console.warn('action before the room is up', a); return Promise.resolve({ ok: false, error: 'not connected yet' }); }
  const target = hostPeer && room.getPeers()[hostPeer] ? hostPeer : null;
  if (!target) {
    if (!['hello', 'snap', 'need', 'drag', 'select'].includes(a.t)) { // (an image request times out and asks again; a live drag and a selection are gone with their moment)
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
/** Host: player p's live drag (spec §3c): no state, no queue, no hook —
 *  what core relays (T.drag: only what p may move, on the table) goes out
 *  with the next broadcast tick, unless a commit in that tick overtakes it. */
function relay(p, a) {
  if (T.drag(p, a)) { drain(p); scheduleBroadcast(); }
}
/** The anonymous knock: asks whoever hosts this room for a (signed, public) snapshot. */
const knock = () => sendAct({ t: 'hello', _v: PROTO }).catch((err) => console.error('hello failed', err));
/** Sends what was queued while disconnected (moves older than 30 s are stale). */
function flushPending() {
  const fresh = pendingActs.splice(0).filter((x) => Date.now() - x.at < 30000);
  for (const { a } of fresh) act(a);
}

// --- the rules Worker (spec §3f; ENGINE.md, "Running in a Worker") ------------
// A rules script never runs on the page. Enabling one starts a module Worker
// (rules-worker.js) over a copy of the host's state, keys excepted: it
// evaluates the script there, and from then on runs every job of the queue
// on its copy (the mirror), sending back what the job changed (a StatePatch,
// `done`), which the host's table takes as it is (applyStatePatch): while
// the rules are on, every change to the host's state comes from the Worker,
// and while they are off, no Worker exists. A job has RULES_TIMEOUT_MS of
// the page's VISIBLE time to come back (the watchdog below: a phone may
// freeze a hidden tab, which must never kill healthy rules); one that
// doesn't, or a Worker that crashes, ends the rules: the Worker goes, the
// host's table switches the rules off (_rulesOff), and the job in flight is
// dropped — the table stays as it was, and the queue goes on.
const RULES_TIMEOUT_MS = 4000, RULES_INIT_MS = 10000;
/** The page globals a shipped template reads (window.CAH_CARDS), copied into each Worker. */
const WORKER_GLOBALS = ['CAH_CARDS'];
let worker = null; // the running rules' Worker: {w, ready: {name, wants, strict}}
let lastRulesError = ''; // the host's last rules error, for the 📜 dialog ('' after a good Enable)
/** Keeps `msg` as the host's last rules error — shown at once when the 📜
 *  dialog is open: the rules failed while the host was reading it. */
function rulesError(msg) {
  lastRulesError = msg;
  if ($('rules-dialog').open) updateRulesDialog();
}
// The saved rules couldn't start on a resume for a reason that isn't the
// script's (this page and the deployed files disagree, the Worker didn't
// load): they are off on this page, yet saved as on — the reload the toast
// asks for runs them again — until the host enables or disables rules.
let rulesHeld = false;
let jobSeq = 0; // ids of the messages the host posts to Workers
const digests = new Map(); // id → the resolve of a digest asked of the Worker
let rulesCodeDirty = false; // code changed -> resend on next broadcast
let guestRules = { code: '', name: '' }; // guests: the script text, for reading

/** The host table's rules runner (core.js env.hooks): no script runs on the
 *  page, so it answers only what the rules view says of the script (wants,
 *  strict), from its Worker's `ready`. A hook called here would break the
 *  one-writer rule: it fails loudly. */
const pageHooks = {
  load() { // (resume() asks, before T is set: the Worker evaluates the saved script)
    if (T) throw new Error('rules scripts run in a Worker, never on the page');
    return '';
  },
  has: (hook) => hook === 'onSelect' && !!worker?.ready.wants.includes('select'),
  flag: (k) => (k === 'strict' ? worker?.ready.strict : undefined),
  call(hook) { throw new Error(`${hook}() was called on the page: rules scripts run in a Worker`); },
};

/** Starts a rules Worker running `code` over the table as it now is (spec
 *  §3f.8). The queue waits for it (`current`). Ready, it replaces the
 *  running one and takes `job` (the host's setRules: its core logs the
 *  enable and runs setup); with no job (a host resuming its table), it just
 *  runs. A script that fails to start (evalError, a crash, RULES_INIT_MS
 *  gone by) changes nothing on an Enable — the running rules keep running —
 *  and switches the saved rules off on a resume. */
function startWorker(code, job) {
  let w;
  try {
    w = new Worker(new URL(`./rules-worker.js?v=${MODULE_V}`, import.meta.url), { type: 'module' });
  } catch (err) {
    console.error('could not start a rules Worker', err);
    current = { ...job };
    started(null, { type: 'evalError', message: "this browser can't run rules scripts (module workers unsupported)", env: true });
    return;
  }
  perf.workerStarts++;
  current = { ...job, start: w, t0: performance.now() };
  listen(w);
  T.syncSpots(); // (the addresses as of now: the mirror takes them as they stand)
  const { keys, decks, boxes, boxSrc, ...state } = T.state; // (the seat keys never leave the page)
  w.postMessage({
    type: 'init', proto: PROTO, mv: MODULE_V, hostId: pid, code, globals: Object.fromEntries(WORKER_GLOBALS.map((k) => [k, window[k]])),
    state, decks, boxes, boxSrc, now: Date.now(),
  });
  watchStart(RULES_INIT_MS, () => started(w, { type: 'evalError', message: `the script didn't start within ${RULES_INIT_MS / 1000} seconds` }));
}
/** Worker `w`'s messages and failures, routed by what it is to the queue:
 *  starting, the running one, or gone (a terminated Worker's last messages
 *  are dropped: nothing it posts after that is applied). A failure's
 *  `message` is shown to the host; `engine`: it is the engine's own fixed
 *  words (a rule of running broken), which the public log may carry too —
 *  the script's own (an error it threw) stay with the host (rulesDown), and
 *  so does `detail` (what the engine says of the script's own state: which
 *  value, under which key); `env`: while starting, the Worker itself didn't load. */
function listen(w) {
  const fail = (message, engine = true, env = false, detail = '') => {
    if (current?.start === w) started(w, { type: 'evalError', message, env });
    else if (worker?.w === w) {
      const said = engine ? detail : message; // (for the host alone)
      rulesDown(engine ? `the script crashed: ${message}` : 'the script crashed', `Rules disabled — the script crashed: ${message}${engine && detail ? ` (${detail})` : ''}`, said);
    }
  };
  w.onmessage = ({ data: m }) => {
    if (current?.start === w) { started(w, m.type === 'fatal' ? { type: 'evalError', message: m.message } : m); return; }
    if (worker?.w !== w) return;
    if (m.type === 'done') done(m);
    else if (m.type === 'digest') { digests.get(m.id)?.(m.digest); digests.delete(m.id); } else if (m.type === 'fatal') fail(String(m.message), m.engine === true, false, m.detail ? String(m.detail) : '');
    else fail(`its Worker sent an unexpected ${String(m.type).slice(0, 20)} message`);
  };
  w.onerror = (e) => { e.preventDefault(); console.error('rules Worker error', e); fail(e.message || 'the rules Worker failed to load', !e.message, true); };
  w.onmessageerror = () => { console.error('a rules Worker message could not be read'); fail('a message could not be read'); };
}
/** How Worker `w` (null: none could be made) answered its `init`: `ready`
 *  ({name, wants, strict}), or an evalError {message, env?} (the code didn't
 *  evaluate, a version mismatch, a crash or a timeout while starting; `env`:
 *  the Worker itself couldn't load or be made). A resume that fails for a
 *  reason that isn't the script's — a version mismatch, or `env` — keeps
 *  the rules on in the save (rulesHeld): the reload its toast asks for runs
 *  them again. */
function started(w, m) {
  watchStop();
  const job = current;
  current = null;
  if (m.type === 'ready') {
    stopWorker(); // (the rules it replaces: the new script's setRules takes over)
    worker = { w, ready: m };
    perf.lastRulesInitMs = performance.now() - job.t0;
    if (job.a) { lastRulesError = ''; toWorker(job); } else scheduleBroadcast(); // (a resume: the rules view says wants and strict now)
    pump();
    return;
  }
  if (w) { w.terminate(); perf.workerStops++; }
  const msg = String(m.message), skew = msg.startsWith('version mismatch');
  console.error('rules: the script did not start —', msg);
  rulesError(msg);
  if (job.a) { // an Enable: whatever ran keeps running
    toast(skew ? 'Card Table was updated — reload this page to run rules' : `Rules error: ${msg}${worker ? ' — the running rules are unchanged' : ''}`);
    job.resolve({ ok: false, error: msg });
  } else { // a resume: the saved rules go off, loudly
    rulesHeld = skew || !!m.env;
    toast(skew ? 'Card Table was updated — reload this page to run rules' : `Saved rules failed to load: ${msg}${rulesHeld ? ' — reload this page to try again' : ''}`);
    commit(T.apply(RULES, { t: '_rulesOff', reason: `the saved script failed to load: ${msg}` }));
  }
  pump();
}
/** Posts job {p, a, resolve} to the running Worker, under the watchdog. */
function toWorker({ p, a, resolve }) {
  const id = ++jobSeq, job = { p, a, resolve };
  current = { ...job, id, t0: performance.now() };
  try {
    worker.w.postMessage({ type: 'act', id, p: job.p, a: job.a, now: Date.now() });
  } catch (err) { // (an action that can't be copied: a bug, never a peer's — they come as JSON)
    console.error('could not post a job to the rules Worker', job.a, err);
    rulesDown(`a job could not be sent: ${err.message}`, `Rules disabled — ${err.message}`);
    return;
  }
  const ms = budget(job.a), s = +(ms / 1000).toFixed(1); // (the stop names the limit this job had: a group's or a setup's is longer)
  watchStart(ms, () => rulesDown(`the script took longer than ${s} s (stopped)`, `Rules stopped — the script didn't answer within ${s} seconds`));
}
/** A job's watchdog budget (spec §3f.5, §4c): RULES_TIMEOUT_MS, and more
 *  per member of a group — 10 ms, and 20 ms for each MB of t.data its
 *  savepoint and gates pass over (T.rulesChars, D234) — or 10 ms per item a
 *  box's setup lays out (a loadBox's, a setup's, a reset's: forEachSeat
 *  counted for every player). */
function budget(a) {
  if (a.t === 'group') return RULES_TIMEOUT_MS + Math.round(groupIds(a).length * (10 + 20 * T.rulesChars() / 1e6));
  const box = a.t === 'loadBox' ? a.setup === true && a.box : a.t === 'setup' ? own(T.state.boxes, a.box) : a.t === 'reset' ? own(T.state.boxes, T.state.lastSetup) : null;
  return RULES_TIMEOUT_MS + (Array.isArray(box?.setup) ? 10 * countSetup(box.setup, Object.keys(T.state.players).length || 1) : 0);
}
/** The running Worker's `done` {id, patch, out, ms} for the job in flight:
 *  the host's table takes the patch (applyStatePatch, which checks all of
 *  it first, against the job too: who acted), carries out its effects,
 *  broadcasts and saves (commit); a failure there is a bug, said, and the
 *  job resolves as failed while the queue goes on. A job that disabled the
 *  rules (a hook failed) ends the Worker. A done for any other job — none
 *  the host posted, or one it posted before — means the Worker ran what the
 *  host never asked of it:
 *  its mirror can't be trusted, and the rules end. So do they when the
 *  table refuses the patch: the job is then dropped, or run again with the
 *  rules off, as rulesDown says. */
function done(m) {
  const job = current;
  if (job?.id !== m.id) {
    console.error('a rules Worker answered a job not in flight', m.id, job?.id);
    rulesDown('the script crashed: its Worker ran a job the host never sent', 'Rules disabled — the script crashed: its Worker ran a job the host never sent');
    return;
  }
  perf.lastRulesWorkerMs = m.ms;
  let changed, error;
  try {
    changed = T.applyStatePatch(m.patch, m.out, job);
  } catch (err) { // (a patch that fails the engine's gates, or a bug: the two states may differ, so the rules go — with the job still in flight)
    console.error('applying a rules patch failed', err);
    rulesDown('the host could not apply the script\'s changes', `Rules disabled — ${err.message}`, err.message);
    return;
  }
  watchStop();
  current = null;
  try {
    error = commit(changed, job.p);
    perf.lastRulesRoundtripMs = performance.now() - job.t0; // (B12: posted to the Worker, back, applied and carried out)
    if (job.p === pid) flush(); // (the host's own move shows at once)
    checkDigest();
  } catch (err) { // (carrying out the job's effects, or broadcasting them, failed: a bug — the table took the patch, which went out and is saved)
    console.error('a rules job\'s effects failed', err);
    toast(`Error: ${err.message}`);
    error = err.message;
  }
  const res = outcome(changed, error);
  if (m.out?.error) rulesError(T.rulesError);
  if (!T.state.rules?.enabled) stopWorker();
  job.resolve(res);
  pump();
}
/** The internal jobs a stop of the rules never drops (spec §3f.5, D134): a
 *  registration, a departure or a rename is kept, as when onJoin or onLeave
 *  fails — they run again on the host's table, where the rules are off. */
const KEPT_JOBS = new Set(['_join', '_leave', '_name']);
/** The running rules stop (spec §3f.5): the watchdog fired, the Worker
 *  crashed, or the host's table refused its patch (done: the job is still
 *  in flight). `reason`: what the log says, publicly; `msg`: the host's toast;
 *  `detail`: what only the host is told beyond `reason` (in the 📜 dialog:
 *  the words of an error the script threw, or which value of the script's
 *  own state, under which key, the engine refused — D145). The Worker
 *  goes, and the host's table switches the rules off (_rulesOff). A job in
 *  flight is dropped —
 *  fail closed: its actor is told, and what it named re-sent — unless it
 *  is a KEPT_JOBS one, which runs again with the rules off. An Enable whose
 *  Worker is starting began from a copy of the table before that _rulesOff:
 *  it starts again from the table as it now is. The queue goes on. */
function rulesDown(reason, msg, detail = '') {
  const error = detail ? `${reason}: ${detail}` : reason;
  console.error(`rules: ${error}`);
  stopWorker();
  const job = current?.id ? current : null, start = current?.start ? current : null;
  if (start) { start.start.terminate(); perf.workerStops++; } // (an Enable starting: see below)
  if (job) {
    watchStop();
    if (!KEPT_JOBS.has(job.a.t)) {
      if (job.p !== RULES) tell(job.p, '🚫 The rules stopped responding — your action was not applied');
      job.resolve({ ok: false, error });
    }
  }
  current = null;
  rulesError(error);
  toast(msg);
  let changed = T.apply(RULES, { t: '_rulesOff', reason });
  if (job && KEPT_JOBS.has(job.a.t)) {
    const ran = T.apply(job.p, job.a);
    job.resolve({ ok: ran });
    changed ||= ran;
  } else if (job) changed = T.refreshFor(job.p, job.a) || changed;
  commit(changed);
  if (start) startWorker(start.a.code, start); // (it began from a copy of the table before that _rulesOff: again, from the table as it now is)
  else pump();
}
/** Ends the running rules' Worker, if any: nothing it may still post is applied. */
function stopWorker() {
  if (!worker) return;
  worker.w.terminate();
  worker = null;
  perf.workerStops++;
  for (const res of digests.values()) res(null);
  digests.clear();
}
/** The running Worker's T.digest() (spec §3f.3), taken after the jobs it
 *  was given before this call (it handles its messages in order) — the
 *  host's equals it once those are applied; null when no Worker runs. */
function workerDigest() {
  if (!worker) return Promise.resolve(null);
  const id = ++jobSeq;
  return new Promise((res) => { digests.set(id, res); worker.w.postMessage({ type: 'digest', id }); });
}
/** Test builds: every 50th Worker job, the host's digest is compared with
 *  the Worker's at the same point (the next job isn't posted yet): a
 *  mismatch is a loud console.error (perf.digestMismatches). */
function checkDigest() {
  if (!window.CARDTABLE_TEST || !worker || ++perf.workerJobs % 50) return;
  const host = T.digest();
  workerDigest().then((d) => {
    perf.digestChecks++;
    if (d !== null && d !== host) { perf.digestMismatches++; console.error(`the rules Worker's state and the host's differ (digest ${d} ≠ ${host})`); }
  });
}

// --- the watchdog: a job's budget counts the page's VISIBLE, on-time waiting --
// (spec §3f.5) Hidden (or frozen), the page stops the clock; visible again
// (or resumed), it gives the rest of the budget plus 1 s of grace. A timer
// that fires over 1 s late (the page or the machine stalled: a `done` may be
// waiting behind it) gives one more second first.
const WD = { left: 0, from: 0, timer: 0, fire: null, late: false };
/** Arms the watchdog: `fire` runs after `ms` of visible, on-time waiting. */
function watchStart(ms, fire) {
  watchStop();
  Object.assign(WD, { left: ms, fire, late: false });
  if (!document.hidden) watchRun(0);
}
function watchStop() {
  clearTimeout(WD.timer);
  WD.timer = 0;
  WD.fire = null;
}
/** Runs the clock again, for what is left plus `grace` ms. */
function watchRun(grace) {
  WD.left += grace;
  WD.from = performance.now();
  WD.timer = setTimeout(watchFired, WD.left);
}
/** Stops the clock (the page hidden or frozen), keeping what is left. */
function watchPause() {
  if (!WD.timer) return;
  clearTimeout(WD.timer);
  WD.timer = 0;
  WD.left = Math.max(0, WD.left - (performance.now() - WD.from));
}
function watchFired() {
  WD.timer = 0;
  if (performance.now() - WD.from - WD.left > 1000 && !WD.late) { // (late: one more second)
    WD.late = true;
    WD.left = 0;
    watchRun(1000);
    return;
  }
  const fire = WD.fire;
  WD.fire = null;
  fire?.();
}
const watchOn = () => { if (WD.fire && !WD.timer && !document.hidden) watchRun(1000); };
document.addEventListener('visibilitychange', () => (document.hidden ? watchPause() : watchOn()));
document.addEventListener('freeze', watchPause);
document.addEventListener('resume', watchOn);

// Fire the script's timers (t.schedule) once due: a `_tick` job, unless one waits in the queue already.
setInterval(() => {
  const timers = role === 'host' && T.state.rules?.enabled && T.state.rules.data?._timers;
  if (Array.isArray(timers) && timers.some((x) => x.at <= Date.now()) && !waiting(RULES, '_tick')) enqueue(RULES, { t: '_tick' });
}, 700);

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
 *  refusal notice for `actor` (whether the rules made it: ruledNo). (host only) */
function drain(actor) {
  let refusal;
  ruledNo = false;
  for (const e of T.drain()) {
    switch (e.t) {
      case 'fx': fxQueue.push(e.f); break;
      case 'ann': annQueue.push(e.msg); break;
      case 'note':
        if (e.p === actor && !refusal && e.msg.startsWith('🚫')) [refusal, ruledNo] = [e.msg, !!e.ruled];
        tell(e.p, e.msg, e.ruled);
        break;
      case 'peek': if (e.p === pid) showPeek(e.c); else noteTo(e.p, { peek: e.c }); break;
      case 'toast': toast(e.msg); break;
      case 'deck': dirtyDecks.add(e.id); break;
      case 'box': dirtyBoxes.add(e.id); break;
      case 'rules': rulesCodeDirty = true; break;
      case 'added': addedBox = e.id; break; // (the box an addBox registered, or found: its caller hears of it, outcome)
      case 'enable': enableBox(e.box, e.remap); break;
      default: console.error('unknown table effect', e);
    }
  }
  return refusal;
}
let addedBox = null; // the box the job just run added or found (drain's `added`), for its caller (outcome)
let ruledNo = false; // the job's refusal (drain's) was the rules' own — a veto, `strict` — not the engine's (outcome)
/** Host: a setup with rules (or a reset of the box whose rules run) just
 *  committed — spec §4c, §4f: the box's rules start now, ahead of every job
 *  that waits, on the box's exported state (`state`: its "@#k" and the ids
 *  that had to change, `remap`, are core's to map, seedState), as the box's
 *  (`box`: a later Reset restarts them). The host's own setRules, through
 *  the queue: a new Worker starts from the table as the setup left it. A
 *  failure to start is said as an Enable's is (started). */
function enableBox(id, remap) {
  const box = T.state.boxes[id];
  const a = { t: 'setRules', enabled: true, reset: true, code: box.rules, box: id, remap, ...(box.rulesState && { state: box.rulesState }) };
  queue.unshift({ p: pid, a, resolve: (r) => { if (!r.ok) console.warn(`the rules of «${box.name}» did not start`, r.error); } });
}
/** Host: box `id` as everyone may see it (core.js publicBox: no setup,
 *  rules or rulesState, plus where it came from and whether it is built in
 *  or has rules, for display). */
const pubBox = (id) => publicBox(T.state.boxes[id], T.state.boxSrc[id]);
/** Host: sends a private note (a notice, a peek answer) to each of player p's connections. */
function noteTo(p, body) {
  for (const [peer, mapped] of Object.entries(peerPid)) {
    if (mapped === p) sendNote({ ...body, to: p }, peer);
  }
}
/** Host: a private notice for player p — this screen's own, or theirs. */
const tell = (p, msg, ruled) => (p === pid ? note(msg, ruled) : noteTo(p, { msg: msg.slice(0, 200), ...(ruled && { ruled }) }));

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
    if (room) sendBoxes(Object.fromEntries([...dirtyBoxes].map((id) => [id, pubBox(id)])));
    dirtyBoxes.clear();
  }
  if (rulesCodeDirty) {
    rulesCodeDirty = false;
    if (room) sendRules({ code: host.rules?.code || '', name: host.rules?.name || '' });
  }
  // (the queues are taken first: a tick that throws can't leave behind what made it throw, to throw again on every tick after)
  const fxs = fxQueue, anns = annQueue;
  fxQueue = [];
  annQueue = [];
  const d = T.takeDirty(), content = T.patchContent(d), fx = liveFx(fxs, d); // (a live drag this tick's commit overtook stays home)
  if (fx.length) content.fx = fx;
  if (anns.length) content.ann = anns;
  // boot: this host instance's epoch, host: whose seat the host is.
  const head = { v: PROTO, boot: hostBoot, seq, host: pid };
  const empty = !Object.keys(content).length;
  const patch = sharedText({ ...head, kind: 'patch', ...content });
  let snap = ''; // the snapshot's shared text, built once if anyone needs one this tick
  const snapText = () => (snap ||= sharedText({ ...head, kind: 'snap', ...T.snapContent(), fx: content.fx || [], ann: content.ann || [] }));
  for (const peer of room ? Object.keys(room.getPeers()) : []) {
    if (incompatible.has(peer)) continue;
    // Peers that haven't introduced themselves yet get the public view only.
    const p = peerPid[peer], to = p && own(host.players, p) ? p : null, st = sync.get(peer);
    if (!st || st.to !== to || (st.needSnap && now - st.snapAt >= SNAP_MIN_MS)) {
      clearTimeout(st?.timer);
      if (!st) sendCatalog(peer); // a newcomer: the catalog first, in its lane, so its first snapshot draws every face
      sendState(spliceBody({ to, tp: peer, ...T.mine(to) }, snapText()), peer);
      sync.set(peer, { seq, to, snapAt: now, needSnap: false, timer: 0, asks: 0 });
    } else {
      const parts = T.mine(to, d); // (its hand, asks, hint and secret, when they changed: no other peer's body carries them)
      if (empty && !Object.keys(parts).length) continue; // nothing for this peer — its base stays put
      sendState(spliceBody({ to, tp: peer, base: st.seq, ...parts }, patch), peer);
      st.seq = seq;
    }
  }
  perf.lastTickMs = performance.now() - t0;
  // this screen, last: the peers' bodies are on their way first
  const parts = T.mine(pid, d);
  if (view.boot !== hostBoot) receive(JSON.parse(spliceBody({ to: pid, ...T.mine(pid) }, snapText())));
  else if (!empty || Object.keys(parts).length) receive(JSON.parse(spliceBody({ to: pid, base: view.seq, ...parts }, patch)));
}

/** Host: sends peer the whole public catalog — the decks, the game boxes
 *  (publicBox) and the rules code — through its lane, ahead of its first
 *  snapshot. Everything sent later to everyone is a delta. */
function sendCatalog(peer) {
  sendDecks(decks, peer);
  sendBoxes(Object.fromEntries(Object.keys(boxes).map((id) => [id, pubBox(id)])), peer);
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
 *  — no more broadcasts, saves, rules Worker or queued jobs (spec §3f.1) —
 *  and takes the next snapshot, of whichever epoch. */
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
  stopWorker();
  watchStop();
  if (current?.start) { current.start.terminate(); perf.workerStops++; }
  for (const job of [...(current ? [current] : []), ...queue.splice(0)]) job.resolve?.({ ok: false, error: 'this tab is no longer the host' });
  current = null;
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
    if (f?.live) { if (f.p !== pid) showLive(f); continue; } // (our own drag is already under our finger)
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
      boxInfo[id] = { src: ['host', 'upload', 'script'].includes(b.src) ? b.src : 'host', ...(PID_RE.test(b.by) && { by: b.by }), builtin: b.builtin === true, hasRules: b.hasRules === true };
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
  const mine = boxWait && got.find((id) => boxInfo[id].by === pid && boxes[id].name === boxWait.name);
  if (mine) boxAnswer(`«${boxes[mine].name}» is on the table — the host can set it up from 📦`, true);
  renderBoxes();
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
    } else if (n.msg) note(String(n.msg), n.ruled === true); // toast + the terminal bridge
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
    if (HOST_ACTIONS.includes(action.t)) { refuse(peer, 'Only the host can do that'); return; }
    if (!PUBLIC_ACTIONS.includes(action.t)) { refuse(peer, 'Unknown action — reload this page'); return; }
    // No action names more than MAX_GROUP items, and a group or a group drag reads only its first MAX_GROUP: cut
    // the rest here, so a million ids cost the host no mapping, no queue and no clone to the rules Worker
    if (Array.isArray(action.ids) && action.ids.length > MAX_GROUP) action.ids = action.ids.slice(0, MAX_GROUP);
    const reason = p === pid ? 'This seat is already open in another tab'
      : typeof p !== 'string' || !PID_RE.test(p) ? 'Invalid player id' // (a crafted {"toString": 1} would make test() throw)
      : typeof key !== 'string' || key.length < 16 ? 'Missing seat key — please reload'
      : peerPid[peer] && peerPid[peer] !== p ? 'One seat per connection'
      : own(T.state.keys, p) && T.state.keys[p] !== key ? 'That seat belongs to another player'
      : '';
    if (reason) { refuse(peer, reason); return; }
    if (!T.mayAct(p, action)) {
      refuse(peer, 'Too many actions — slow down');
      refused(p, action); // what it named goes out again (rate-limited): the guest's optimistic move snaps back
      return;
    }
    // Register/refresh the sender on EVERY action, not just hello — if the
    // keyed hello was lost, the first real action still registers the player.
    // The seat key binds at once, here (two claims of one seat can't both
    // pass; keys never reach a rules Worker); the registration — seated,
    // named, "joined the table", onJoin — is a job (_join) when they are new,
    // back or nameless, ahead of their action. The tick after it commits
    // sends a newly registered peer a snapshot with its hand. Whether they
    // are "back" is what the queue will leave them as, not what it has
    // committed so far: a `_leave` of their last connection may still wait
    // behind a slow hook (lastPresence).
    const newConn = peerPid[peer] !== p, known = own(T.state.players, p), will = lastPresence(p);
    peerPid[peer] = p;
    if (T.bindKey(p, key)) persist();
    if (will === '_leave' || (!will && (!known?.online || !known.name))) enqueue(p, { t: '_join', name });
    else if (newConn) scheduleBroadcast(); // a second tab of a seated player: its first snapshot
    // (the catalog went out with this connection's first snapshot: sendCatalog)
    // Every action carries the sender's current name: a rename the host
    // never received (made while it was away, or in another room) syncs on
    // the next connection, through the logged (and rate-limited) rename path.
    const nm = cleanName(name);
    if (known && nm && nm !== known.name && newConn && action.t !== 'name') enqueue(p, { t: '_name', name: nm });
    // A keyed hello comes only from a guest that hasn't had a state addressed
    // to it (introduce): one that answers it may be lost, so it asks for one too.
    if (action.t === 'snap' || action.t === 'hello') wantSnap(peer);
    else if (action.t === 'need') serveImages(peer, action.a);
    else if (action.t === 'drag') relay(p, action);
    else submit(p, action);
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
      if (boxWait) boxAnswer(`The host left before answering about «${boxWait.name}»: the box wasn't added — try again once they are back.`, false);
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
// whose migration couldn't be written (store.js loadSave). (A rules script
// can't leave a function in t.data for a save to choke on: its Worker never
// sends one — rules-worker.js send.)
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
    persistWarned = false;
    perf.saves++;
    if (+localStorage.getItem(pendingKey()) <= state.seq) localStorage.removeItem(pendingKey());
  } catch (err) {
    console.error('failed to persist game', err);
    savedCatalog.clear(); // the save is a lost marker now: the next one that fits writes every deck again
    if (role === 'host' && !persistWarned) { persistWarned = true; toast(`Can't save this table (${err.message}) — reloading the host tab would reset it`); }
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
  const state = T.snapshot();
  if (rulesHeld && state.rules) state.rules = { ...state.rules, enabled: true }; // (off here, for a reason that isn't the script's: see started)
  return {
    state,
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
let multi = new Set(); // the multi-selection (spec §4g): two or more items picked together, whose bar is the group bar (one picked is `sel`)
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
const landings = new Map(); // item id → {id, x, y, ox, oy}: our own drop (and the drag's origin), held until the host confirms or vetoes it
const MOTION_MS = 260;
/** Holds our own drops `list` ([{id, x, y, ox, oy}]: a drag's, or a group
 *  drag's members) where we let go: the states the host sent before it
 *  applied the drop carry a stale spot from mid-drag. Each is let go when a
 *  state shows it there or back at its origin (a veto: renderItems), and
 *  the rest after 1.5 s, quiet table or not — a script moved it elsewhere,
 *  coalescing merged the state away — shown where the host has them. */
function hold(list) {
  for (const L of list) landings.set(L.id, L);
  setTimeout(() => {
    const due = list.filter((L) => landings.get(L.id) === L);
    for (const L of due) landings.delete(L.id);
    if (due.length) renderItems(new Map(due.map((L) => [L.id, view.items[L.id]])));
  }, 1500);
}

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

// --- spots: pieces sharing an address are fanned (spec §3g) --------------------
// The state keeps every piece on a spot centred on it; drawn, they fan out
// (pieces.js fanOffsets) from the spot's centre: along a space's `dir`, or a
// few units apart. Each piece's element is placed at its fanned spot, where
// it is hit-tested too; the top one carries a "×k" badge (.fanb). A piece
// whose address was read by containment while it lies off the spot's centre
// (a board moved under it, a Phase 2 save: D106) is drawn where it lies and
// only counted (D116), and a press on it takes it — until a piece centred
// there joins it: then the spot fans them all (D120).
const fanAt = new Map();  // display address → the ids of the pieces there
const atOf = new Map();   // piece id → its display address
const fanPos = new Map(); // piece id → where it is drawn (top-left), when fanned
const fanDirty = new Set(); // addresses whose fan is laid out again (layoutFans)
let viewTB = null;        // the view's boards (core.js tableBoards), until one changes
/** The view's structured boards (tableBoards over the public items). */
const boardsNow = () => (viewTB ||= tableBoards(Object.entries(view.items), boxes));
/** Item `id` (public `it`, or undefined: gone) is drawn now: its spot's
 *  members change, and its old and new spots are laid out again. */
function fanTrack(id, it) {
  const at = it?.k === 'g' ? it.at : undefined, was = atOf.get(id);
  if (was !== undefined) fanDirty.add(was);
  if (at === was) return;
  if (was !== undefined) { fanAt.get(was).delete(id); if (!fanAt.get(was).size) fanAt.delete(was); }
  if (at === undefined) atOf.delete(id);
  else { atOf.set(id, at); (fanAt.get(at) || fanAt.set(at, new Set()).get(at)).add(id); fanDirty.add(at); }
  fanPos.delete(id);
}
/** The members of spot `at` on the table, bottom to top (by z). */
const spotMembers = (at) => [...(fanAt.get(at) || [])].filter((id) => view.items[id]).sort((a, b) => view.items[a].z - view.items[b].z);
/** Spot `at` on the view's boards: {r (resolveAddr's: its board b and centre x, y), sp (its space, if one)}, or null. */
function spotOn(at) {
  const r = resolveAddr(boardsNow(), at);
  return r?.b ? { r, sp: r.b.B.spaces?.find((x) => x.id === r.local) } : null;
}
/** Whether spot S (spotOn) fans its members `ids`: when one of them lies
 *  centred on it — then all of them, an off-centre one too (D120), so none
 *  is drawn over another; else each is drawn where it lies (D116). */
const fans = (S, ids) => !!S && ids.some((id) => { const it = view.items[id], { w, h } = sizeOf(it, boxes); return Math.abs(it.x + w / 2 - S.r.x) < 0.5 && Math.abs(it.y + h / 2 - S.r.y) < 0.5; });
/** Where pieces of sizes `sizes` ([{w, h}], bottom first) fanned on spot S
 *  (spotOn) are drawn: their top-lefts on the table, laid out from its
 *  centre (fanOffsets, turned with its board) — or null when there is
 *  nothing to fan (one piece, on a spot with no `dir`). */
function fanSlots(S, sizes) {
  if (!S || (sizes.length < 2 && !S.sp?.dir)) return null;
  const { r } = S;
  return pieces.fanOffsets(S.sp, sizes).map((o, j) => { const [ox, oy] = turn(o.x, o.y, r.b.rot); return { x: r.x + ox - sizes[j].w / 2, y: r.y + oy - sizes[j].h / 2 }; });
}
/** Lays out the fans of the spots that changed (fanDirty): where each member is drawn, and the top one's "×k". */
function layoutFans() {
  if (!viewTB) for (const at of fanAt.keys()) fanDirty.add(at);
  for (const at of fanDirty) {
    const ids = spotMembers(at), S = spotOn(at), slots = fans(S, ids) ? fanSlots(S, ids.map((id) => sizeOf(view.items[id], boxes))) : null;
    ids.forEach((id, j) => {
      if (slots) fanPos.set(id, slots[j]);
      else fanPos.delete(id);
      fanBadge(id, j === ids.length - 1 && ids.length > 1 ? ids.length : 0);
      placeEl(id);
    });
  }
  fanDirty.clear();
}
/** Gives item `id` the fan badge "×k" (k > 1), distinct from a stack's ×N, or takes it away (0). */
function fanBadge(id, k) {
  const el = itemEls.get(id);
  let b = el?.querySelector(':scope > .fanb');
  if (!k) { b?.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'fanb'; el.appendChild(b); }
  b.textContent = `×${k}`;
}
/** The piece a press on item `id` means (spec §3g, D115, D120): in a spot's fan,
 *  the fan's topmost piece this player may move (one of each colour on
 *  backgammon's bar: each player takes their own), else its top one; a
 *  piece drawn where it lies — off its spot's centre (D116), or alone —
 *  is the one pressed. */
function topOf(id) {
  if (!fanPos.has(id)) return id;
  const ids = spotMembers(atOf.get(id));
  return ids.findLast((m) => mayTouch(view.items[m]) && !view.items[m].lock) ?? ids.at(-1);
}
/** Puts item `id`'s element where it is drawn — its fanned place, or its
 *  own — and, while someone else drags it, on its live spot by a
 *  translation (a per-frame move never lays the table out). Our own drag
 *  (a group's too) and drop (`landings`) keep it where the finger left it. */
function placeEl(id) {
  const el = itemEls.get(id), it = view.items[id];
  if (!el || !it || drag?.id === id || drag?.group?.has(id) || landings.has(id)) return;
  const p = fanPos.get(id) || it, L = lives.get(id);
  if (!L && el.classList.contains('live')) { endLive(el, p); return; }
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  el.style.translate = L ? `${L.x - p.x}px ${L.y - p.y}px` : '';
  el.classList.toggle('live', !!L); // (its spot's ×k stays home: style.css)
}
/** A live glide ends (a commit, or the hold ran out) with item element `el`
 *  drawn at `p` (FLIP): it jumps there, translated back to where the glide
 *  has it now (untransitioned), and the translation alone then runs out —
 *  one composited property, so nothing is laid out per frame and the two
 *  never part (left/top's transition starts a frame after translate's: the
 *  piece would jump back half a man first). */
function endLive(el, p) {
  const [tx, ty] = getComputedStyle(el).translate.split(' ').map(parseFloat); // ('none': NaN, so 0 below)
  const x = parseFloat(el.style.left) + (tx || 0) - p.x, y = parseFloat(el.style.top) + (ty || 0) - p.y;
  el.classList.remove('live');
  el.style.transition = 'none';
  Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, translate: `${x}px ${y}px` });
  void getComputedStyle(el).translate; // (a style flush, no layout: this is where the transition starts from)
  el.style.transition = '';
  el.style.translate = '';
}

// --- live drags (spec §3c, §3g): someone else's piece on its way -------------
// A drag sends `drag` every LIVE_MS; the host relays it as an fx {live: 1}
// (no state). Here it shows where it is (placeEl), until a committed update
// of that item (renderItems) or LIVE_HOLD_MS without news: it glides home.
const LIVE_MS = 60, LIVE_HOLD_MS = 1500;
const lives = new Map(); // item id → {x, y, at}: its live top-left, and when it came
let liveT = 0;
/** Shows live drag `f` ({p, id, x, y} or {p, ids, dx, dy}) and its dragger's name. */
function showLive(f) {
  const now = performance.now();
  if (typeof f.id === 'string' && view.items[f.id]) lives.set(f.id, { x: num(f.x), y: num(f.y), at: now });
  for (const id of Array.isArray(f.ids) ? f.ids : []) {
    const it = typeof id === 'string' && view.items[id];
    if (it) lives.set(id, { ...clampToTable(TABLE, it.x + num(f.dx), it.y + num(f.dy), sizeOf(it, boxes).w, sizeOf(it, boxes).h), at: now });
  }
  for (const id of f.id ? [f.id] : f.ids || []) placeEl(id);
  const first = f.id || f.ids?.find((id) => lives.has(id)); // (a group's dragger's name rides its first member)
  if (first) showFx({ ...f, id: first });
  liveT ||= setInterval(() => { // the holds that ran out
    const t = performance.now();
    for (const [id, L] of lives) if (t - L.at > LIVE_HOLD_MS) { lives.delete(id); placeEl(id); }
    if (!lives.size) { clearInterval(liveT); liveT = 0; }
  }, 250);
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
    if ((it && isBoard(it)) || (before && isBoard(before)) || !prev) viewTB = null; // (the boards changed: every fan is laid out again)
    fanTrack(id, it);
    const img = piece ? pieces.imageOf(it, boxes) : side && sideImage(side.d, side.i, side.up);
    let el = itemEls.get(id);
    itemsByDeck.set(id, side?.d);
    itemsByBox.set(id, piece ? pieces.boxOf(it) : undefined);
    itemsByAsset.set(id, img);
    if (!it) {
      if (el) { el.remove(); itemEls.delete(id); }
      lives.delete(id);
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
    const at = (x, y) => Math.abs(it.x - x) < 0.5 && Math.abs(it.y - y) < 0.5, L = landings.get(id);
    if (L && (at(L.x, L.y) || at(L.ox, L.oy))) landings.delete(id);
    lives.delete(id); // (a committed update: no glide outlives it)
    if (!atOf.has(id)) placeEl(id); // (a piece on a spot is placed by layoutFans below, in its fan)
    el.style.transform = `rotate(${it.rot}deg)`;
    // its badges, and a board's printed text, turn back against it (style.css, D91)
    if (it.rot) el.style.setProperty('--rot', `${num(it.rot)}deg`);
    else el.style.removeProperty('--rot');
    if (!drag?.group?.has(id)) el.style.zIndex = it.z; // (a group being dragged stays on top)
    el.classList.toggle('selected', sel === id || multi.has(id));
  }
  layoutFans();
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
const looks = ({ x, y, z, rot, at, ...rest }) => JSON.stringify(rest); // (an address alone redraws nothing: layoutFans places it)
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
let seatSpots = '', seatSizes = ''; // where placeSeats last put the button row and the notices, and what it last sized
// The hint's plate (CSS #table-hint): HINT_FELT of the felt's width on the
// screen at most, and no wider than the gap between the labels within
// HINT_BAND of the middle (half the tallest plate: 6 lines, 146 px, on a
// phone held upright), HINT_GAP clear of them; HINT_MIN_W at least (and
// always its longest word: min-width: min-content).
const HINT_FELT = 0.6, HINT_BAND = 75, HINT_GAP = 8, HINT_MIN_W = 140;
/** The bottom-left corner ⬚ takes (CSS #sel-mode: 8 px in, 44 px wide, and a gap), which no seat label covers. */
const SEL_CORNER = 56;
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
    // phone's fit zoom puts right at the screen edge), and clear of ⬚
    // (#sel-mode), which owns the bottom-left corner: a label that would run
    // under it moves right of it (your own, zoomed in, is clamped there).
    const y = clamp(sy, hh, H - hh), x0 = clamp(sx, hw, W - hw), x = y + hh > H - SEL_CORNER && x0 - hw < SEL_CORNER ? Math.min(W - hw, SEL_CORNER + hw) : x0;
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
  // (#table-wrap and #notices both start at #main's top: the offsets agree)
  const strip = $('game-strip'); // the "What are we playing?" strip pushes the notices down too
  if (!strip.classList.contains('hidden')) noticeTop = Math.max(noticeTop, strip.offsetTop + strip.offsetHeight + 4);
  // The watchers' box stays in its corner unless a label is there: then it goes below that label.
  let watchTop = 8;
  for (const [t, b] of corner.sort((a, c) => a[0] - c[0])) if (t < watchTop + watchH && b > watchTop) watchTop = b + 4;
  // Moved by `translate` from their CSS spots, for the same reason (⬚'s
  // chip: above ⬚, and above a row of the rules' buttons lifted over your label).
  const spots = `${rowBottom}|${noticeTop}|${watchTop}`;
  if (spots !== seatSpots) {
    seatSpots = spots;
    $('rules-row').style.translate = `0 ${12 - rowBottom}px`;
    $('sel-chip').style.translate = `0 ${60 - Math.max(60, rowBottom + 50)}px`; // (CSS bottom: 60px)
    $('notices').style.translate = `0 ${noticeTop - 10}px`;
    $('watch-box').style.translate = `0 ${watchTop - 8}px`;
  }
  // What sizes a box — the hint's plate; the button row's room above its
  // spot, in which the secret card shrinks and scrolls, its head on screen
  // (a phone held sideways with an ask open leaves the table area about 100
  // px); the margins — lays the page out. So it waits while fingers or a
  // felt drag move the view, and catches up as they lift (endPinch, dropFelt):
  // the browser hit-tests the whole table for hover after every layout,
  // which in every frame of a gesture made frames of 33 ms on the B4 phone
  // (D246). A short, wide table area (a phone in landscape) leaves wide
  // empty margins beside the felt (as wide as this view shows it: feltW,
  // layout): the notices move into the left one and the button row into
  // the right one, so neither covers the cards (CSS .gutters).
  if (pinch || feltDrag?.moved) return;
  const gutter = (W - feltW) / 2, gutters = H < 500 && gutter >= 180, gw = gutters ? gutter | 0 : 0; // (--gutter: unused without .gutters)
  const sizes = `${hintW}|${Math.max(0, H - rowBottom - 4)}|${gw}`;
  if (sizes === seatSizes) return;
  seatSizes = sizes;
  hintEl.style.setProperty('--hint-w', hintW);
  $('rules-row').style.setProperty('--row-room', `${Math.max(0, H - rowBottom - 4)}px`);
  $('main').classList.toggle('gutters', gutters);
  // (on the three boxes that use it: on #main, an inherited property, it
  // would restyle every element of the table at each zoom or a rectangle's
  // turn, whose fit changes as it turns)
  if (gutters) for (const id of ['notices', 'rules-row', 'watch-box']) $(id).style.setProperty('--gutter', `${gw}px`);
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
  if (e.composedPath().some((n) => n.matches?.('#seat-menu, #action-bar, #rules-row, #game-strip, #watch-box')) || e.timeStamp - dragEndAt < 300) return;
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
    return x?.s ? SUIT_ORDER[x.s] * 100 - (x.r === 'A' ? 14 : RANKS.indexOf(x.r) + 1) : 1000;
  };
  return sortHand ? order.sort((a, b) => key(view.hand[a]) - key(view.hand[b]) || a - b) : order;
}
function renderHand() {
  const hand = JSON.stringify(view.hand), sig = hand + sortHand;
  if (sig === handSig) return;
  handSig = sig;
  if (hand !== pickOf) { pickOf = hand; handPick.clear(); askState(); } // (a hand ask's picks were indices of the hand before)
  handEl.innerHTML = '';
  $('sort-toggle').classList.toggle('on', sortHand);
  for (const idx of handOrder()) {
    const el = document.createElement('div');
    el.className = 'hcard';
    el.dataset.idx = idx; // the REAL hand index: plays name the card the host holds there
    el.innerHTML = handFace(view.hand[idx]);
    handEl.appendChild(el);
  }
  markHandPicks();
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
/** Whether the running rules are strict (spec §3b: the rules view says so
 *  while they are on): only the moves the script handles, or allows, go. */
const strictRules = () => !!(view.rules?.enabled && view.rules.strict);
/** Draws the rules' buttons for this player, and the 📜 button's state and
 *  title ("strict" when the rules are). */
function renderRulesBtns() {
  const rules = role === 'host' ? T?.state.rules : view.rules;
  const btns = (rules?.enabled && (rules.public?.buttons || []).filter((b) => !b.pid || b.pid === pid)) || [];
  const sig = JSON.stringify(btns) + (rules?.enabled ? rules.name : '') + strictRules();
  if (sig === rbSig) return;
  rbSig = sig;
  const row = $('rules-btns');
  row.classList.toggle('hidden', !btns.length);
  row.innerHTML = btns.map((b) => `<button data-rbtn="${esc(b.id)}">${esc(b.label)}</button>`).join('');
  $('rules-btn').classList.toggle('on', !!rules?.enabled);
  $('rules-btn').title = !rules?.enabled ? 'Game rules script'
    : `Rules active: ${rules.name}${strictRules() ? ' — strict: only the moves the rules allow' : ''}`;
}
$('rules-btns').addEventListener('click', (e) => {
  const id = e.target.dataset.rbtn;
  if (id) act({ t: 'rulesBtn', id });
});

// --- what the rules show this player alone: hints, asks, the secret (spec §3g) --
// All three come in this player's own parts of the host's bodies (view.hint,
// view.ask, view.sec: spec §3b), never in anyone else's. A script's words (a
// prompt, an option's label, a secret) are untrusted text: they reach the
// page through esc() or textContent, and the hint layer is numbers only.
const askEl = $('ask');
const marked = { hint: new Set(), offer: new Set() }; // the item ids carrying .hint / .offer
let hintSig = '', hintLayers = []; // what the hint layers show; their elements (one per board)
let askMin = false, askSig = '', askId = null, askSent = null, askJSON = ''; // the ask panel folded to its chip; what it shows; its ask's id; {id, at}: an answer on its way; the asks it last drew
const ASK_WAIT_MS = 3000; // how long an answer's buttons wait for the host before they work again (a refusal)
const handPick = new Set(); // the hand indices a hand ask has picked (of the hand `pickOf`: another hand has other indices)
let pickOf = '';
/** The ask the panel shows while it is open (not folded), or null: its
 *  picks on the table (items, spaces) and in the hand are live only then. */
const askOpen = () => (!askMin && view.ask[0]) || null;

/** The size of spot `r` (resolveAddr's) a mark is drawn to and a tap
 *  reaches: its grid's cell, or its space's smaller side. */
function spotSize(r) {
  const sp = r.b.B.spaces?.find((x) => x.id === r.local);
  return sp ? Math.min(sp.w ?? 2 * sp.r, sp.h ?? 2 * sp.r) : r.b.B.grid.cell;
}
/** Gives the items `ids` the class `cls` (hint, offer), and takes it from
 *  those that had it — on every redraw: an element made since gets it too. */
function markItems(cls, ids) {
  const now = new Set(ids);
  for (const id of marked[cls]) if (!now.has(id)) itemEls.get(id)?.classList.remove(cls);
  for (const id of now) itemEls.get(id)?.classList.add(cls);
  marked[cls] = now;
}
/** Draws this player's hint (view.hint: items get .hint; cells and spaces a
 *  translucent disc, or a ring around a piece there, on their board's hint
 *  layer — a layer per board, above the pieces, drawn from numbers) and what
 *  the open ask offers on the table (pick 'item': .offer; 'space': violet
 *  marks). Gone when the hint is null and no ask is open. */
function renderHints() {
  const h = view.hint, q = askOpen();
  markItems('hint', h?.items || []);
  markItems('offer', q?.pick === 'item' ? q.among : []);
  const spots = [...(h?.spaces || []).map((s) => [s, 0]), ...(q?.pick === 'space' ? q.among.map((s) => [s, 1]) : [])];
  const TB = spots.length ? boardsNow() : null;
  const sig = TB ? `${JSON.stringify(spots)}|${spots.map(([s]) => +fanAt.has(s)).join('')}|${TB.list.map((b) => `${b.id},${b.x},${b.y},${b.rot}`).join(';')}` : '';
  if (sig === hintSig) return;
  hintSig = sig;
  for (const el of hintLayers) el.remove();
  hintLayers = [];
  const per = new Map(); // board → its marks
  for (const [s, offer] of spots) {
    const r = resolveAddr(TB, s);
    if (!r?.b) continue; // (an address no board shows now: a board gone or turned over)
    const l = spotOf(r.b.B, r.local);
    (per.get(r.b) || per.set(r.b, []).get(r.b)).push({ x: l.x, y: l.y, size: spotSize(r), ring: fanAt.has(s), offer: !!offer });
  }
  for (const [b, marks] of per) {
    const el = document.createElement('div');
    el.className = 'hint-layer';
    Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, transform: `rotate(${b.rot}deg)` });
    el.innerHTML = pieces.hintSVG(b.w, b.h, marks);
    tableEl.appendChild(el);
    hintLayers.push(el);
  }
}

/** The `v` an answer to ask `q` (this player's) sends for `x` (spec §3c,
 *  §3i) — the panel's typed values and the terminal's text alike: an
 *  option's index (a number: the panel's button; text: a label in any case
 *  first — "3" is the option labelled 3 when there is one —, else an index), an offered item's id,
 *  an offered address (any form), hand indices ([0, 3] or "0,3": those
 *  cards, as the host matches them), a whole number in [min, max]. {v}, or
 *  {why} saying what is offered: the host checks again, and refuses
 *  whatever wasn't (its "🚫 That answer wasn't offered"). */
function answerV(q, x) {
  const s = String(x ?? '').trim(), why = (w) => ({ why: `${q.id}: ${w}` });
  if (q.options) {
    const byLabel = typeof x === 'number' ? -1 : q.options.findIndex((l) => l.toLowerCase() === s.toLowerCase());
    const k = byLabel >= 0 ? byLabel : /^\d+$/.test(s) ? +s : -1;
    return k >= 0 && k < q.options.length ? { v: k } : why(`answer ${q.options.map((l, j) => `[${j}] ${l}`).join(' ')}`);
  }
  switch (q.pick) {
    case 'item': return q.among.includes(s) && view.items[s] ? { v: s } : why(`answer one of the items ${q.among.join(', ')}`);
    case 'space': {
      const TB = boardsNow(), at = resolveAddr(TB, s)?.at, a = at && q.among.find((m) => resolveAddr(TB, m)?.at === at);
      return a ? { v: a } : why(`answer one of the spots ${q.among.join(', ')}`);
    }
    case 'hand': {
      const n = q.count ?? 1, ks = (Array.isArray(x) ? x : s.split(/[\s,]+/).filter(Boolean)).map(Number);
      const ok = ks.length === n && new Set(ks).size === n && ks.every((k) => Number.isInteger(k) && view.hand[k]);
      return ok ? { v: ks.map((k) => { const c = view.hand[k]; return 't' in c ? { idx: k, t: c.t, f: c.f } : { idx: k, d: c.d, i: c.i }; }) }
        : why(`answer ${n} different card${n > 1 ? 's' : ''} of your hand, by index (as "0,3")`);
    }
    default: return /^-?\d+$/.test(s) && +s >= q.min && +s <= q.max ? { v: +s } : why(`answer a whole number from ${q.min} to ${q.max}`); // ('number')
  }
}
/** Answers ask `q` with `x` (answerV): sent, the panel waits ASK_WAIT_MS for the host. */
function answerAsk(q, x) {
  const r = answerV(q, x);
  if ('why' in r) { console.warn('not an answer the ask offers', r.why); toast(r.why); return; }
  askSent = { id: q.id, at: Date.now() };
  act({ t: 'answer', id: q.id, v: r.v });
  askState();
  setTimeout(askState, ASK_WAIT_MS + 50);
}
/** Draws the ask panel (#ask, spec §3g): this player's first pending ask,
 *  "1 of N" when more wait, its form — option buttons, a pick on the table
 *  or in the hand, a stepper — or, folded (▾), the "❓ Rules ask" chip (until
 *  another question comes first). No close button: an ask goes when it is
 *  answered, or the script cancels it. */
function renderAsk() {
  const q = view.ask[0];
  if (q?.id !== askId) { handPick.clear(); askSent = null; askMin = false; askId = q?.id ?? null; } // (another question: shown, unfolded)
  const json = JSON.stringify(view.ask), sig = q ? `${askMin}|${json}` : '';
  if (json !== askJSON) { askJSON = json; askSent = null; } // (the asks changed: the answer was taken — the same id asked again works at once)
  if (sig === askSig) return;
  askSig = sig;
  askEl.classList.toggle('hidden', !q);
  askEl.classList.toggle('min', askMin);
  handEl.classList.toggle('picking', q?.pick === 'hand' && !askMin);
  markHandPicks();
  if (!q) return;
  const n = view.ask.length, count = q.count ?? 1;
  $('ask-chip').textContent = `❓ Rules ask${n > 1 ? ` (${n})` : ''}`;
  $('ask-prompt').textContent = q.prompt;
  $('ask-of').textContent = n > 1 ? `1 of ${n}` : '';
  $('ask-body').classList.toggle('glyphs', !!q.options?.every((l) => [...l].length <= 2));
  $('ask-body').innerHTML = q.options ? q.options.map((l, k) => `<button data-k="${k}">${esc(l)}</button>`).join('')
    : q.pick === 'item' ? '<span class="how">Tap one of the highlighted pieces</span>'
      : q.pick === 'space' ? '<span class="how">Tap one of the highlighted spots</span>'
        : q.pick === 'hand' ? `<span class="how">Tap ${count > 1 ? `${count} cards` : 'a card'} in your hand</span><button id="ask-ok">Confirm</button>`
          : `<button data-step="-1" aria-label="Less">−</button><input id="ask-v" type="number" inputmode="numeric" step="1" min="${num(q.min)}" max="${num(q.max)}" value="${num(q.min)}"><button data-step="1" aria-label="More">+</button><button id="ask-ok">OK</button>`;
  askState();
}
/** The panel's controls as they now stand: waiting on an answer just sent
 *  (askSent, ASK_WAIT_MS), and Confirm / OK only for a valid answer — "k of
 *  count" hand cards picked, a number in range — shown before it is sent. */
function askState() {
  const q = view.ask[0];
  if (!q || q.id !== askId) return; // (an ask the panel doesn't show yet: renderAsk draws it, then comes here)
  const sent = askSent?.id === q.id && Date.now() - askSent.at < ASK_WAIT_MS, okb = $('ask-ok');
  askEl.classList.toggle('sent', sent);
  for (const b of askEl.querySelectorAll('#ask-body button')) b.disabled = sent;
  if (!okb) return;
  if (q.pick === 'hand') okb.textContent = `Confirm (${handPick.size}/${q.count ?? 1})`;
  okb.disabled = sent || 'why' in answerV(q, q.pick === 'hand' ? [...handPick] : $('ask-v')?.value);
}
/** Shows which hand cards a hand ask has picked (.picked). */
function markHandPicks() {
  for (const el of handEl.children) el.classList.toggle('picked', handPick.has(+el.dataset.idx));
}
/** Folds the panel to its chip, or opens it again: the table's picks and
 *  highlights go and come with it (renderHints). */
function foldAsk(min) {
  askMin = min;
  renderAsk();
  renderHints();
}
askEl.addEventListener('click', (e) => {
  const q = view.ask[0], b = e.target.closest('button');
  if (!q || !b || b.disabled) return;
  if (b.id === 'ask-min' || b.id === 'ask-chip') foldAsk(b.id === 'ask-min');
  else if (b.dataset.k != null) answerAsk(q, +b.dataset.k);
  else if (b.dataset.step) {
    const inp = $('ask-v');
    inp.value = clamp((parseInt(inp.value, 10) || 0) + +b.dataset.step, q.min, q.max);
    askState();
  } else if (b.id === 'ask-ok') answerAsk(q, q.pick === 'hand' ? [...handPick] : $('ask-v').value);
});
askEl.addEventListener('input', askState); // (a number typed in)
askEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'ask-v') { e.preventDefault(); $('ask-ok').click(); } });
/** A tap on the table (pointer event `e`; `id`: the item a press there
 *  takes, if any) while an open ask picks there: an offered item or spot
 *  answers it, anything else says what to pick. True when the ask took the
 *  tap (it selects nothing then). */
function askTap(e, id) {
  const q = askOpen();
  if (q?.pick === 'item') {
    const hit = [e.target.closest?.('.item')?.dataset.id, id].find((x) => x && q.among.includes(x));
    if (hit) answerAsk(q, hit);
    else toast('Pick one of the highlighted pieces');
    return true;
  }
  if (q?.pick !== 'space') return false;
  const at = spaceAt(q, toTable(e));
  if (at) answerAsk(q, at);
  else toast('Pick one of the highlighted spots');
  return true;
}
/** The offered address of space ask `q` a tap at table point p means: the
 *  spot snapping finds there when it is offered, else the nearest offered
 *  one within reach (three quarters of its size) — or null. */
function spaceAt(q, p) {
  const TB = boardsNow(), s = snapAt(TB, p.x, p.y), hit = s && q.among.find((a) => resolveAddr(TB, a)?.at === s.at);
  if (hit) return hit;
  let best = null, bd = Infinity;
  for (const a of q.among) {
    const r = resolveAddr(TB, a), d = r?.b ? Math.hypot(r.x - p.x, r.y - p.y) : Infinity;
    if (d < bd && d <= 0.75 * spotSize(r)) [best, bd] = [a, d];
  }
  return best;
}
/** A hand card tapped (index idx) while a hand ask is open: picked or let go. True when the ask took the tap. */
function askHandTap(idx) {
  const q = askOpen();
  if (q?.pick !== 'hand') return false;
  if (!handPick.delete(idx)) handPick.add(idx);
  markHandPicks();
  askState();
  return true;
}

/** Draws this player's t.secret (view.sec, spec §3g) on the 🔒 For you card
 *  by the rules' buttons: its `text`, at most 1,000 characters, as text —
 *  or no card. A new text opens a folded card again. */
let secText = '';
function renderSecret() {
  const t = typeof view.sec?.text === 'string' ? view.sec.text.slice(0, 1000) : '';
  if (t === secText) return;
  secText = t;
  $('secret').classList.toggle('hidden', !t);
  $('secret').classList.remove('shut');
  $('secret-text').textContent = t;
}
$('secret-head').addEventListener('click', () => $('secret').classList.toggle('shut'));

/** A tap selects item `id` (null: nothing). When the running rules want
 *  selections (view.rules.wants: an onSelect, which typically hints where it
 *  may go), it is sent too — never for a piece hidden from this player,
 *  which the host would drop (spec §3c). */
function tapSelect(id) {
  select(id);
  wantSelect(id);
}
/** Why the host would drop a `select` of item `id` now (spec §3c), or '':
 *  no such item, rules that take no selections, a piece hidden from this
 *  player (it shows only its back: §2d). */
function noSelect(id) {
  const it = id && view.items[id];
  if (!it) return 'no such item';
  if (!(view.rules?.enabled && view.rules.wants?.includes('select'))) return 'the rules take no selections';
  return (it.k === 'g' || it.k === 's') && !('t' in it) ? 'that piece is hidden from you' : '';
}
/** Sends `select` of item `id` when the rules want it (tapSelect; a drag's start too). */
function wantSelect(id) {
  if (!noSelect(id)) act({ t: 'select', id });
}

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
  renderBoxes();
  renderWatchers(); // (its size, too: placeSeats moves it off the labels)
  renderPlayers();
  // The hand bar hides on a table with nothing to hold and an empty hand
  // (draughts); the patch that brings a hand item back shows it. Either way
  // the table refits (layout's ResizeObserver on #table-wrap).
  document.body.classList.toggle('nohand', view.seq > 0 && !view.handy && !view.hand.length);
  renderHand();
  renderLog();
  renderRulesBtns();
  renderAsk();
  renderHints(); // (after the items and the ask: it marks their elements)
  renderSecret();
  renderFacedown();
  renderCues();
  syncBar(prev);
  renderInspector();
  updateNet();
  cliParts();
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
// The table area's size, read when it changes (its ResizeObserver): layout()
// and what is placed in screen space read these, never the DOM, so a patch
// that moves an item and puts up a name bulb forces no layout (B3), nor does
// a pan, zoom or pinch frame — two fingers move twice a frame, and each read
// after the other's writes made the browser restyle the table then (B4).
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
//   0  --bz, the badges' growth (style.css). Badges (×N, a spot's ×k, ∞, a
//      pile's count and name, an owner's dot, 🔒), selection and hint rings
//      and the snap preview's outline are drawn in table units, so on a table drawn
//      small (a phone's fit) they'd be a few pixels: they grow back toward a
//      readable size, by at most BADGE_MAX×; a board's coordinates too, by
//      at most what fits their margin (its --lmax, pieces.js gridSVG).
//   1  --view for a board's printed text (D91), which turns back against
//      the view: every frame of a turn (a board holds a few dozen texts).
//   2  --view for the badges with a number or a name (a spot's ×k too), 🔒
//      and a bag, which turn back too (D91), and an `upright` type's label
//      (.uptext, D160: a chess glyph; its own class, so a change restyles
//      those labels alone, never every piece's).
// On a 1,000-stack table the badges are a thousand: a restyle of them all
// (rule 0 or 2) in a frame that also moves the table is a long task on the
// B4 phone, 50 to 670 ms (D96). So while two fingers move the view (a
// pinch, a twist) neither is written: the badges keep their turn and size,
// moving with the table as its pieces do. Once the fingers rest
// (PINCH_REST_MS without a move: longer than a hesitation mid-pinch), the
// badges take the view's exact size if it differs from theirs by more than
// BZ_STEP, and the zoom's size at the fit the fingers landed on does too
// (pinchRest, D103): no badge stays grown over the pieces being zoomed in
// on; no restyle buys a change you can't see (held at BADGE_MAX, a zoom to
// 3.46× the fit, 1.9× that of the rest before, moves the size 3.00 → 2.98);
// and a twist alone never resizes them (a rectangle refits as it turns: by
// its exact size alone, every twist would). They settle (upright, exact)
// once the fingers lift. A resize still costs, at a rest or a lift: a task
// of 50–100 ms on the B4 phone, then the browser rasters the table's layer
// again, which fingers that move again within about 100 ms wait for (one
// more task of 50–90 ms). D102 has the measures; B4's rested pinch, the
// budget.
const viewSheet = new CSSStyleSheet(), BADGE_MAX = 3, BZ_STEP = 1.25, PINCH_REST_MS = 300;
viewSheet.replaceSync('#table .item > .count, #table .item > .fanb, #table .item > .odot, #table .item > .lockb, #table .pile > .pname, #table .item.selected, #table .item.hint, #table .item.offer, #table .blabels text, #table .snap-ghost {} '
  + '#table .psvg text {} #table .item > .count, #table .item > .fanb, #table .pile > .pname, #table .bag > .bagbox, #table .item > .lockb, #table .uptext {}');
document.adoptedStyleSheets = [...document.adoptedStyleSheets, viewSheet];
let badgeZ = '', textAngle = 0, badgeAngle = 0, feltW = 0;

/** The badges' growth for the table's scale `s`: a 12-unit badge text shows ≥ 8 px while it can. */
const badgeSize = (s) => clamp(0.67 / s, 1, BADGE_MAX);
/** Sizes the badges for scale `s` (rule 0's --bz), if that changes it. */
function sizeBadges(s) {
  const bz = badgeSize(s).toFixed(2);
  if (bz !== badgeZ) viewSheet.cssRules[0].style.setProperty('--bz', (badgeZ = bz));
}

/** The view's fit (no DOM: what layout() then draws): `scale` from the
 *  table area's size, the view's angle and zoom — a round table fits by its
 *  diameter (so it never refits as the view turns), a rectangle by its
 *  bounding box at the view's angle — and the pan kept so that at least the
 *  table's centre stays reachable. */
function fit() {
  if (!wrapW) [wrapW, wrapH] = [wrapEl.clientWidth, wrapEl.clientHeight]; // (before the observer's first call)
  const a = (viewAngle * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)), rect = TABLE.shape === 'rect';
  const bw = rect ? TABLE_W * c + TABLE_H * sn : TABLE_W, bh = rect ? TABLE_W * sn + TABLE_H * c : TABLE_H;
  scale = Math.min(wrapW / bw, wrapH / bh) * zoomZ; // fit × user zoom
  feltW = bw * scale; // (placeSeats: the hint's plate fits its middle, the notices the margins beside it)
  panX = clamp(panX, -(bw * scale) / 2, (bw * scale) / 2);
  panY = clamp(panY, -(bh * scale) / 2, (bh * scale) / 2);
}
function layout() {
  fit();
  if (viewAngle !== textAngle) viewSheet.cssRules[1].style.setProperty('--view', `${(textAngle = viewAngle)}deg`);
  if (!pinch) {
    sizeBadges(scale);
    if (viewAngle !== badgeAngle) viewSheet.cssRules[2].style.setProperty('--view', `${(badgeAngle = viewAngle)}deg`);
  }
  // Center the unscaled table on the wrap; then scale, rotate, and pan.
  tableEl.style.left = `${(wrapW - TABLE_W) / 2}px`;
  tableEl.style.top = `${(wrapH - TABLE_H) / 2}px`;
  tableEl.style.transform = `translate(${panX}px, ${panY}px) rotate(${viewAngle}deg) scale(${scale})`;
  if (barHTML) placeBar();
  placeInspector();
  for (const b of bulbs.values()) placeFx(b);
  renderPlayers(true); // seat labels live in screen space and track the view
}
new ResizeObserver(() => { [wrapW, wrapH] = [wrapEl.clientWidth, wrapEl.clientHeight]; layout(); }).observe(wrapEl);

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

/** Re-anchors the view so table point `t` sits at client position (cx, cy)
 *  (`r`: the table area's client rect, if read already), and draws it. */
function anchorView(t, cx, cy, r = wrapEl.getBoundingClientRect()) {
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
  fit();
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
let giveOpen = false; // a list is open in the bar: the host's Give ▸, or the group bar's 👜 Into bag ▸
let delAsk = null; // the group bar's 🗑 asks "Remove N?" (a token: its ARM_MS timer's; GROUP_CMDS.del)
let barHTML = ''; // what the bar shows (barFor's or groupBar's markup)
/** Selects item `id` alone (null: nothing), with its bar; the multi-selection stays as it is.
 *  `picked`: it is a selection being built by picks (Shift, ⬚), whose bar docks (placeBar). */
function select(id, picked = false) {
  sel = id;
  picking = picked;
  giveOpen = false;
  markSelected();
  renderBar();
}
/** Gives .selected to the selected item and the multi-selection's members, and takes it from the rest. */
function markSelected() {
  for (const [i, el] of itemEls) el.classList.toggle('selected', i === sel || multi.has(i));
}
/** The bar as it should now be: the group bar for a multi-selection, else
 *  the selected item's (barFor's markup) — none while a tap only selects
 *  for the rules: strict rules that want selections (spec §3g, D154), whose
 *  game moves by drags, asks and buttons, and whose pieces' bar — or a
 *  group's — would offer what they refuse, over the very squares their hint marks. */
function barNow() {
  if (strictRules() && view.rules.wants?.includes('select')) return '';
  if (multi.size) return groupBar();
  const it = sel && view.items[sel], html = it ? barFor(sel, it) : '';
  return html && picking ? `${html}<button data-cmd="none">✕</button>` : html; // (docked over the toolbar, it gives the toolbar back: placeBar)
}
/** Builds the bar (hidden when it offers nothing, while the inspector is
 *  open, and while a group is carried) and places it. An armed ✥ Move shows
 *  how much of its time is left (style.css). A selection's bar (placeBar)
 *  holds its buttons off a moment when it shows or offers something else
 *  (armBar), and fits its one row to its room, an ask of 🗑 in sight. */
function renderBar() {
  const was = barEl.classList.contains('hidden') ? '' : barHTML;
  barEl.innerHTML = barHTML = barNow();
  barEl.classList.toggle('hidden', !barHTML || !!insp || !!drag?.group);
  barEl.querySelector('.on[data-cmd="all"]')?.style.setProperty('animation-delay', `${moveAll.at - Date.now()}ms`);
  if (!barHTML) return;
  placeBar();
  if (!barAt) return;
  if (barHTML !== was || barArm) armBar(); // (new buttons: held off too while it arms)
  // "🗑 Remove 8?" is wider than the 🗑 it replaces, the last button of a
  // row a phone scrolls sideways: the row scrolls to its end, unfaded, so
  // the question is never cut off or read half faded.
  if (delAsk) barEl.scrollLeft = barEl.scrollWidth;
  fitRow();
}
// A selection's bar holds its buttons off for BAR_ARM_MS after it shows,
// offers something else or docks somewhere new (as #box-ask's, D204): a
// click or a tap aimed at what lay there a moment before — the felt, a
// toolbar button, the button that was there (the 🗑 that became "🗑 Remove
// 8?") — presses nothing. The keys (R, F, Space, Delete) still act at
// once: a key is no misaimed tap.
// (A piece's own bar isn't held: it shows beside the piece just tapped,
// where the next quick tap is meant for it.)
const BAR_ARM_MS = 400;
let barArm = 0; // the timer that lets the docked bar's buttons act again (0: they act)
function armBar() {
  for (const b of barEl.querySelectorAll('button')) b.disabled = true;
  clearTimeout(barArm);
  barArm = setTimeout(() => { barArm = 0; for (const b of barEl.querySelectorAll('button')) b.disabled = false; }, BAR_ARM_MS);
}
/** Keeps the open bar true to the view after a redraw (`prev`: the items
 *  it redrew, null: all): redrawn when what it offers changed — its item,
 *  or who may do what with it (a seat taken or left turns who owns a
 *  seat-bound piece, a player joins the Give ▸ list) — else placed again:
 *  a piece's own bar when its item moved, a selection's after any redraw
 *  (any piece, anyone's, may have come into or left the strip it docks in).
 *  A bar that offers what the host would now refuse would send it, from a
 *  button or a key. The multi-selection loses the members that are gone or
 *  that this player may no longer handle (a locked one stays: 🔓 unlocks it). */
function syncBar(prev) {
  if (multi.size) {
    const keep = [...multi].filter((id) => view.items[id] && mayTouch(view.items[id]));
    if (keep.length < multi.size) setMulti(keep);
    else if (barNow() !== barHTML) renderBar();
    else if (barHTML) placeBar();
    return;
  }
  const it = sel && view.items[sel];
  if (sel && !it) select(null);
  else if (it && barNow() !== barHTML) renderBar();
  else if (barHTML && (barAt || !prev || prev.has(sel))) placeBar();
}
/** Whether a pile `it` turns over: cards do, and pieces with a back. */
const pileTurns = (it) => { const top = it.top || {}; return 'd' in top || 'b' in top || !!typeAt(boxes, top.t)?.back; };
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
    const cards = 'd' in (it.top || {});
    return (may && F.hand && room ? b('draw', 'Draw') : '') + (may ? b('peek', 'Peek') + b('dealup', 'Deal↑') + b('dealdn', 'Deal↓') + b('shuffle', 'Shuffle') : '')
      + (free && pileTurns(it) ? b('flip', 'Flip') : '') + (free ? b('rr', cards ? '⟳90' : '⟳') : '') + unlock + del;
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
    + (free && inspectOf(id) ? b('inspect', '⋯ Inspect') : '') // (anyone's ×N or ×k badge opens it too: spec §4g)
    + (free && F.hand && room ? b('hand', '✋ Hand') : '')
    + (pieces.zoomable(it, boxes) ? b('zoom', '🔍') : '')
    + lock
    + (!it.owner && !it.lock && !isBoard(it) ? b('claim', '👤 Claim') : it.owner && (owner === pid || host) ? b('release', '👤 Release') : '')
    + (host ? b('give', 'Give ▸', giveOpen ? 'on' : '') + give : '')
    + del;
}

/** Where items `ids` are drawn on the screen, together: {x0, x1, y0, y1}
 *  (wrap px; each where it is drawn — fanned on a crowded spot, or where
 *  our own drop holds it — its box grown to cover it turned), or null when
 *  none is on the table. */
function screenBox(ids) {
  let b = null;
  for (const id of ids) {
    const it = view.items[id];
    if (!it) continue;
    const { w, h } = sizeOf(it, boxes), at = landings.get(id) || fanPos.get(id) || it, [sx, sy] = tableToScreen(at.x + w / 2, at.y + h / 2), half = Math.max(w, h) * 0.6 * scale;
    b = b ? { x0: Math.min(b.x0, sx - half), x1: Math.max(b.x1, sx + half), y0: Math.min(b.y0, sy - half), y1: Math.max(b.y1, sy + half) }
      : { x0: sx - half, x1: sx + half, y0: sy - half, y1: sy + half };
  }
  return b;
}
/** Puts popover `el` (in screen space, centred on its `left`) beside screen
 *  box `b`, never over it while there is room: above it when it fits there
 *  (its real size: it wraps into rows on a narrow screen), else below it,
 *  else as low as it fits. */
function placeBeside(el, b) {
  const hw = el.offsetWidth / 2, bh = el.offsetHeight, above = b.y0 - bh - 4, below = b.y1 + 8;
  el.style.left = `${clamp((b.x0 + b.x1) / 2, hw + 4, wrapW - hw - 4)}px`;
  el.style.top = `${above >= 4 ? above : below + bh <= wrapH - 4 ? below : Math.max(4, wrapH - 4 - bh)}px`;
}
// The bar lives OUTSIDE the scaled table (in screen space) so its buttons stay
// finger-sized on small screens; it goes beside what it acts on, where it is
// drawn: the item — with the rest of its crowded spot, whose pieces a finger
// presses to take the top one (topOf). A selection being built (two or more
// picked, or one picked by Shift or ⬚) docks its bar instead, where no piece
// is drawn, so it never lies on a piece still to pick (D240, D245): one row
// (style.css #action-bar.row: at most 54 px tall, scrolling sideways when
// wider than the screen) along the top of the table area — below the "What
// are we playing?" strip when it shows — when no piece is drawn across that
// strip of the screen (a table seen whole leaves its rim there), else over
// the toolbar, as a phone's selection bar does (the toolbar comes back with
// ✕, Esc, or a click on the felt). It is placed again after every redraw
// (anyone's piece may come into its strip) and, docking somewhere new, held
// off a moment (armBar). Beside the picks it moved with each pick and lay
// on the next row; at the top edge regardless, on the top row and the game
// strip; wrapped into two rows (a phone), on the row below the strip: a tap
// meant for a piece ran a command for the whole group.
const toolbarEl = $('toolbar'), barHome = barEl.nextElementSibling; // (where the bar goes back to in #table-wrap)
/** How tall a strip a selection's bar takes along the table area's top: its row's most (#action-bar.row's max-height, 54 px) and a gap. */
const DOCK_H = 60;
let barAt = ''; // where a selection's bar is docked: 'top' (the table area's), 'toolbar' (over it); '' for a piece's own bar (beside it)
/** Where a selection's bar docks in the table area: the top of a strip
 *  across it, below the game strip when that shows, in which no piece (but
 *  a board) is drawn — or null, when every such strip holds one. */
function dockTop() {
  const strip = $('game-strip'), top = strip.classList.contains('hidden') ? 4 : strip.offsetTop + strip.offsetHeight + 4;
  for (const id in view.items) {
    const b = !isBoard(view.items[id]) && screenBox([id]);
    if (b && b.y0 < top + DOCK_H && b.y1 > top && b.x1 > 0 && b.x0 < wrapW) return null;
  }
  return top;
}
/** Puts the bar where it goes (see above): a selection's docked — one row,
 *  held off a moment and fitted to its room whenever it docks somewhere
 *  new — and a piece's own beside it (placeBeside). */
function placeBar() {
  const row = !!(multi.size || picking), top = row ? dockTop() : null, at = !row ? '' : top === null ? 'toolbar' : 'top';
  if (at !== barAt) {
    if (at === 'toolbar') toolbarEl.append(barEl);
    else if (barAt === 'toolbar') wrapEl.insertBefore(barEl, barHome);
    barEl.classList.toggle('row', !!at);
    barEl.classList.toggle('docked', at === 'toolbar');
    barEl.classList.remove('more');
    barEl.style.left = barEl.style.top = '';
    barAt = at;
    if (at) { armBar(); fitRow(); }
  }
  if (at === 'top') {
    barEl.style.left = `${wrapW / 2}px`;
    barEl.style.top = `${top}px`;
  } else if (!at) {
    const b = screenBox(multi.size ? multi : fanPos.has(sel) ? spotMembers(atOf.get(sel)) : [sel]);
    if (b) placeBeside(barEl, b);
  }
}
/** Fits a selection's one-row bar to its room: its end fades while more of
 *  it lies beyond (`.more`; a phone scrolls it sideways). */
function fitRow() {
  barEl.classList.toggle('more', barEl.scrollLeft + barEl.clientWidth < barEl.scrollWidth - 1);
}
barEl.addEventListener('scroll', fitRow, { passive: true });
new ResizeObserver(() => { if (barAt) fitRow(); }).observe(barEl); // (its room changed: the toolbar it covers, the screen's width)

// --- multi-select (spec §4g) -------------------------------------------------
// Several items picked at once: a rubber band (Shift+drag on the felt — on
// a locked board too, which counts as felt — or, with ⬚ select mode on, a
// plain drag there: one finger on a phone), Shift+click (⬚: a tap) to pick
// an item or put it back; Esc, a click on the felt, ✕ or ⬚ off clear them.
// Only items this player may handle (nobody else's, not locked) are picked,
// and boards never: the others are counted in a chip. Members are .selected;
// a drag of one carries them all (one `drag {ids, dx, dy}` each LIVE_MS, one
// `group` move on the drop); the group bar acts on them with one `group`
// each (spec §4c). One picked item is just selected (its own bar).
let selMode = false; // ⬚: a drag (but of a picked member) draws a band, a tap picks
let picking = false; // the selection is being built by picks (Shift, ⬚): its bar docks (placeBar)
const selBtn = $('sel-mode'), selChip = $('sel-chip'), bandEl = $('band');
let chipT = 0;
/** Says `msg` for a moment in the selection's chip (by ⬚). */
function chip(msg) {
  selChip.textContent = msg;
  selChip.classList.remove('hidden');
  clearTimeout(chipT);
  chipT = setTimeout(() => selChip.classList.add('hidden'), 2600);
}
/** Whether public item `it` may join a multi-selection: not a board, nobody else's, not locked. */
const pickable = (it) => !!it && !isBoard(it) && mayTouch(it) && !it.lock;
/** Whether this player may move item `id` (a group's member the group's
 *  moves, turns, flips and removals take): nobody else's, not locked. */
const mayMove = (id) => { const it = view.items[id]; return !!it && mayTouch(it) && !it.lock; };
/** Makes `ids` the multi-selection: two or more are a group (the group
 *  bar); one is just selected (its own bar); none clears the selection. */
function setMulti(ids) {
  multi = new Set(ids);
  giveOpen = false;
  delAsk = null;
  if (multi.size === 1) {
    const [id] = multi;
    multi.clear();
    select(id, true);
  } else {
    sel = null;
    picking = false;
    markSelected();
    renderBar();
  }
}
/** What is picked now: the multi-selection, or the item selected alone when this player may pick it. */
const picked = () => (multi.size ? [...multi] : pickable(view.items[sel]) ? [sel] : []);
/** Picks items `ids` (a band's) into the selection: those this player may
 *  handle, up to MAX_GROUP in all (a `group`'s most); the others are
 *  counted in the chip ("3 not selectable"). */
function pick(ids) {
  const its = ids.filter((id) => view.items[id] && !isBoard(view.items[id])), ok = its.filter((id) => pickable(view.items[id]));
  const all = [...new Set([...picked(), ...ok])], over = all.length - MAX_GROUP;
  const no = [its.length > ok.length && `${its.length - ok.length} not selectable (locked or someone else's)`, over > 0 && `${MAX_GROUP} at most: ${over} left out`];
  if (no.some(Boolean)) chip(no.filter(Boolean).join(' · '));
  if (ok.length) setMulti(all.slice(0, MAX_GROUP));
}
/** Picks item `id`, or puts it back (Shift+click; a tap in ⬚ select mode). */
function togglePick(id) {
  const it = view.items[id], now = new Set(picked());
  if (!it || isBoard(it)) return;
  if (now.has(id)) now.delete(id);
  else if (!pickable(it)) return chip("1 not selectable (locked or someone else's)");
  else if (now.size >= MAX_GROUP) return chip(`${MAX_GROUP} at most`);
  else now.add(id);
  setMulti([...now]);
}
selBtn.addEventListener('click', () => {
  selMode = !selMode;
  selBtn.classList.toggle('on', selMode);
  selBtn.setAttribute('aria-pressed', selMode);
  if (selMode) chip('Select: drag a box, or tap pieces');
  else {
    setMulti([]);
    selChip.classList.add('hidden');
  }
});
/** The rubber band of felt drag `f` (its start, sx/sy, and the table area's
 *  place, r) to pointer event `e`: {x0, x1, y0, y1} in wrap px. */
function bandRect(f, e) {
  const xs = [f.sx, e.clientX].map((x) => x - f.r.left).sort((a, b) => a - b), ys = [f.sy, e.clientY].map((y) => y - f.r.top).sort((a, b) => a - b);
  return { x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] };
}
/** Draws the band of felt drag `f` to pointer event `e`. */
function drawBand(f, e) {
  const b = bandRect(f, e);
  Object.assign(bandEl.style, { translate: `${b.x0}px ${b.y0}px`, width: `${b.x1 - b.x0}px`, height: `${b.y1 - b.y0}px` });
  bandEl.classList.remove('hidden');
}
/** The band of felt drag `f` let go at pointer event `e`: it picks every
 *  item drawn with its centre inside it. */
function endBand(f, e) {
  bandEl.classList.add('hidden');
  const b = bandRect(f, e), ids = [];
  for (const [id, it] of Object.entries(view.items)) {
    const { w, h } = sizeOf(it, boxes), at = fanPos.get(id) || it, [sx, sy] = tableToScreen(at.x + w / 2, at.y + h / 2);
    if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) ids.push(id);
  }
  pick(ids);
}

/** The group bar (spec §4g): what this player may do with the members —
 *  ⟲ ⟳ by the largest rotStep among them (else 90), Flip, 🎲 Roll (the
 *  dice), 🔒 / 🔓, 👜 Into bag ▸ (the bags on the table), 🗑 — and ✕. */
function groupBar() {
  const ids = [...multi], its = ids.map((id) => view.items[id]), mine = ids.filter(mayMove).map((id) => view.items[id]);
  const b = (cmd, text, cls = '') => `<button data-cmd="${cmd}"${cls ? ` class="${cls}"` : ''}>${text}</button>`;
  const bags = mine.some((it) => it.k === 'g') ? Object.entries(view.items).filter(([id, it]) => it.k === 'b' && !multi.has(id) && mayTouch(it)) : [];
  const locks = its.filter(mayLock);
  return `<span class="gn">${ids.length} selected</span>`
    + (mine.some(turnsAround) ? b('rl', '⟲') + b('rr', '⟳') : '')
    + (mine.some(turnsOver) ? b('flip', 'Flip') : '')
    + (its.some((it) => isDie(it) && mayTouch(it)) ? b('roll', '🎲 Roll') : '')
    + (locks.length ? b('lock', locks.some((it) => !it.lock) ? '🔒 Lock' : '🔓 Unlock') : '')
    + (bags.length ? b('bag', '👜 Into bag ▸', giveOpen ? 'on' : '') + (giveOpen ? `<span class="give">${
      bags.map(([id, bg]) => `<button data-cmd="bagTo" data-to="${esc(id)}">👜 ${esc(bg.name || 'Bag')}</button>`).join('')}</span>` : '') : '')
    + (mine.length ? (delAsk ? b('del', `🗑 Remove ${mine.length}?`, 'on') : b('del', '🗑')) : '')
    + b('none', '✕');
}
/** Whether a turn of public item `it` shows (the bar's ⟲ ⟳): cards and piles; a piece that isn't a die and doesn't look the same at any angle. */
const turnsAround = (it) => it.k === 'c' || it.k === 'p' || (it.k === 'g' && !isDie(it) && pieces.turnShows(it, boxes));
/** Whether public item `it` turns over (the bar's Flip): a card, a pile that turns, a piece that flips. */
const turnsOver = (it) => it.k === 'c' || (it.k === 'p' ? pileTurns(it) : it.k === 'g' && flips(it));
/** The step the group bar's ⟲ ⟳ turn by: the largest rotStep among members `ids`, else 90 (each member snaps it to its own). */
const groupStep = (ids) => Math.max(0, ...ids.map((id) => flagsOf(view.items[id], boxes).rotStep || 0)) || 90;
/** 🗑 of more than this many members asks first, in the bar (GROUP_CMDS.del). */
const GROUP_DEL_ASK = 5;
/** Sends one `group` `op` of the members among `ids` this player may move, that `fit` takes (`o`: its other fields). */
const groupAct = (op, ids, o = {}, fit = () => true) => act({ t: 'group', op, ids: ids.filter((id) => mayMove(id) && fit(view.items[id])), ...o });
/** The group bar's commands on members `ids` (`key`: a key ran it, not a button — see keydown). */
const GROUP_CMDS = {
  rl: (ids) => groupAct('rot', ids, { rot: -groupStep(ids) }, turnsAround),
  rr: (ids) => groupAct('rot', ids, { rot: groupStep(ids) }, turnsAround),
  flip: (ids) => groupAct('flip', ids, {}, turnsOver),
  roll: (ids) => { // (the host rolls them as one: at most MAX_ROLL, as a single roll; the chip says what was left out)
    const dice = ids.filter((id) => isDie(view.items[id]) && mayTouch(view.items[id]));
    if (dice.length > MAX_ROLL) chip(`${MAX_ROLL} dice at most: ${dice.length - MAX_ROLL} left out`);
    act({ t: 'group', op: 'roll', ids: dice.slice(0, MAX_ROLL) });
  },
  lock: (ids) => { const its = ids.filter((id) => mayLock(view.items[id])); act({ t: 'group', op: 'lock', ids: its, on: its.some((id) => !view.items[id].lock) }); },
  bag: () => { giveOpen = !giveOpen; renderBar(); },
  bagTo: (ids, bag) => groupAct('toBag', ids, { bag }, (it) => it.k === 'g' && bagTakes(view.items[bag], it, it.n || 1)), // (pieces only: what core's toBag takes)
  del: (ids, to, key) => { // (from the bar, more than GROUP_DEL_ASK ask first: "🗑 Remove 12?" removes them, for ARM_MS; Delete removes at once)
    if (!key && !delAsk && ids.filter(mayMove).length > GROUP_DEL_ASK) {
      const ask = (delAsk = {});
      setTimeout(() => { if (delAsk === ask) { delAsk = null; renderBar(); } }, ARM_MS);
      return renderBar();
    }
    delAsk = null;
    groupAct('del', ids);
  },
  none: () => setMulti([]),
};

// --- the stack inspector (spec §4g) --------------------------------------------
// A popover in screen space beside what it shows, never over it: a ×N stack —
// its face (its back when hidden), the count, Take [k] (a stepper, 1 … N−1:
// `split {n: k}` beside the stack, where the host snaps it) and Take all
// (arms the whole-stack drag, ✥) — or a crowded spot's members, top first,
// each with its face (or back), its name and its owner's dot: a tap selects
// that piece (its bar), a drag out of the list carries it. It opens on a
// tap of a ×N badge or a spot's ×k, a long press of a ×N stack (touch: in
// place of the zoom) and ⋯ Inspect in the bar; it closes on Esc, ✕, a tap
// outside it, or when what it shows is gone, and is drawn again when that
// changes (renderAll). The bar hides while it is open.
const inspEl = $('inspector');
let insp = null; // what it shows: {id} a ×N stack, or {at} a crowded spot's display address; k: Take's count; html: what it drew
let inspPress = null; // a press on a member of its list: {id, x, y} (client px), until it lifts or becomes a drag out (dragOut)
/** What the inspector shows for item `id`: on `badge` 'stack', its ×N
 *  stack; on 'spot', its crowded spot; with no badge (⋯ Inspect), the spot
 *  when it is crowded, else the stack — or null, when there is none. */
function inspectOf(id, badge = '') {
  const it = view.items[id], at = atOf.get(id);
  if (badge !== 'stack' && at !== undefined && spotMembers(at).length > 1) return { at };
  return badge !== 'spot' && it?.k === 'g' && it.n >= 2 ? { id } : null;
}
/** Opens the inspector on `o` (inspectOf's); false when there is nothing to show. */
function openInspector(o) {
  if (!o) return false;
  insp = { ...o, k: 1, html: '' };
  renderInspector();
  renderBar();
  return true;
}
function closeInspector() {
  insp = null;
  inspPress = null;
  inspEl.classList.add('hidden');
  renderBar();
}
/** What public piece `it` is called in the inspector: its type's name and
 *  the face's label ("Azure infantry · 4-3"), or that it is hidden. */
function pieceTitle(it) {
  if (!('t' in it)) return 'A hidden piece';
  const name = typeAt(boxes, it.t)?.name, face = pieceName(boxes, it.t, it.f);
  return name && name !== face ? `${name} · ${face}` : face;
}
/** A small picture of public piece `it`, its face — its back when hidden —
 *  as pieces.js draws it on the table, scaled to fit `px` (no badges). */
function thumb(it, px) {
  const v = pieces.itemView({ ...it, n: 1, owner: null, lock: false }, boxes, faceImage), f = px / Math.max(v.w, v.h, 1);
  return `<span class="ithumb" style="width:${Math.round(v.w * f)}px;height:${Math.round(v.h * f)}px"><span class="${v.cls.join(' ')}" style="width:${num(v.w)}px;height:${num(v.h)}px;scale:${f}">${v.html}</span></span>`;
}
/** Draws the inspector as the view now has it (when that changed), or closes it when what it shows is gone; then places it. */
function renderInspector() {
  if (!insp) return;
  let html;
  const x = '<button data-ins="x" title="Close" aria-label="Close">✕</button>';
  if (insp.id) {
    const it = view.items[insp.id];
    if (it?.k !== 'g' || !(it.n >= 2)) { closeInspector(); return; }
    const k = (insp.k = clamp(insp.k, 1, it.n - 1)), free = mayTouch(it) && !it.lock;
    html = `<div class="ins-head">${thumb(it, 44)}<div class="ins-what"><b>${esc(pieceTitle(it))}</b><small>×${num(it.n)} in this stack</small></div>${x}</div>`
      + (free ? `<div class="ins-take"><span>Take</span><button data-ins="less" aria-label="One fewer"${k <= 1 ? ' disabled' : ''}>−</button><output>${k}</output>`
        + `<button data-ins="more" aria-label="One more"${k >= it.n - 1 ? ' disabled' : ''}>+</button><button data-ins="take" class="main">Take ${k}</button></div>`
        + '<button data-ins="all" class="ins-all">✥ Take all</button>'
        : `<p class="ins-note">${it.lock ? '🔒 Locked' : "Someone else's stack"}</p>`);
  } else {
    const ids = spotMembers(insp.at).reverse();
    if (ids.length < 2) { closeInspector(); return; }
    html = `<div class="ins-head"><div class="ins-what"><b>${esc(insp.at)}</b><small>${ids.length} pieces here, the top one first</small></div>${x}</div><ul class="ins-list">${
      ids.map((id) => {
        const m = view.items[id];
        return `<li data-id="${esc(id)}">${thumb(m, 36)}<span>${esc(pieceTitle(m))}${m.n >= 2 ? ` ×${num(m.n)}` : ''}</span>${
          m.owner ? `<i class="odot" style="background:${safeColor(ownerColor(m.owner))}"></i>` : ''}</li>`;
      }).join('')}</ul>`;
  }
  if (html !== insp.html) inspEl.innerHTML = insp.html = html;
  inspEl.classList.remove('hidden');
  placeInspector();
}
/** Puts the inspector beside its stack, or its spot's members. */
function placeInspector() {
  const b = insp && screenBox(insp.id ? [insp.id] : spotMembers(insp.at));
  if (b) placeBeside(inspEl, b);
}
inspEl.addEventListener('click', (e) => {
  if (!insp) return; // (a click that ends a drag out of the list, after it closed)
  const b = e.target.closest('[data-ins]'), it = insp.id && view.items[insp.id];
  // (a piece chosen here — a member of the list, a stack whose Take all is armed — is the selection: a group picked before ends)
  if (!b) { const li = e.target.closest('li[data-id]'); if (li && view.items[li.dataset.id]) { closeInspector(); setMulti([]); tapSelect(li.dataset.id); } return; }
  switch (b.dataset.ins) {
    case 'x': closeInspector(); break;
    case 'less': case 'more': insp.k += b.dataset.ins === 'more' ? 1 : -1; renderInspector(); break;
    case 'take': if (it) act({ t: 'split', id: insp.id, n: insp.k, ...dealSpot(it) }); break;
    case 'all': { const id = insp.id; closeInspector(); setMulti([]); select(id); CMDS.all(id); break; } // (the bar's ✥ Move all, armed: the next drag moves the whole stack)
  }
});
inspEl.addEventListener('pointerdown', (e) => {
  const li = e.button === 0 && e.target.closest('li[data-id]');
  inspPress = li ? { id: li.dataset.id, x: e.clientX, y: e.clientY } : null;
});
// A tap outside the inspector closes it (and anything it held: the press itself goes on).
document.addEventListener('pointerdown', (e) => { if (insp && !inspEl.contains(e.target)) closeInspector(); }, true);
/** A press on a member of the inspector's list moved (pointer event e): the
 *  list closes and that piece is carried, held by its centre, as a drag that
 *  started on it would (dragMode: nothing when this player may not drag it). */
function dragOut(e) {
  const { id } = inspPress, it = view.items[id], mode = it && dragMode(id, it, e);
  closeInspector();
  if (!mode) return;
  const { w, h } = sizeOf(it, boxes), d0 = fanPos.get(id) || it;
  drag = { id, el: itemEls.get(id), mode, ghost: false, dx: w / 2, dy: h / 2, sx: d0.x + w / 2, sy: d0.y + h / 2, x: d0.x, y: d0.y, ox: it.x, oy: it.y, moved: false, last: 0 };
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
  const it = b.f.id && view.items[b.f.id], { w, h } = it ? sizeOf(it, boxes) : { w: CARD_W, h: CARD_H }, at = lives.get(b.f.id) || fanPos.get(b.f.id) || it || b.f;
  const [sx, sy] = tableToScreen(at.x + w / 2, at.y + h / 2);
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
  inspect: (id) => openInspector(inspectOf(id)),
  none: () => setMulti([]), // (the ✕ of a docked bar: one piece picked by Shift or ⬚)
};
/** The step ⟲ and ⟳ turn item `it` by: a card's 90°; a piece's rotStep (45 when it turns freely). */
const rotStep = (it) => (pieceLike(it) ? flagsOf(it, boxes).rotStep || 45 : 90);
/** Runs bar command `cmd` (`to`: its button's data-to; `key`: a key ran it): on the multi-selection's members, or on the selected item. */
function runCmd(cmd, to, key = false) {
  const it = sel && view.items[sel];
  if (multi.size) GROUP_CMDS[cmd]?.([...multi], to, key);
  else if (it) CMDS[cmd]?.(sel, it, to);
}
barEl.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); }); // (a Shift+click on a button, picking along, would select the page's text up to it)
barEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  if (btn) runCmd(btn.dataset.cmd, btn.dataset.to);
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
// browser closes it). Escape closes the stack inspector, else the zoom or
// peek overlay, else the seat menu, else clears the selection (the
// multi-selection too) and its bar. The others are the bar's shortcuts — on
// the selected item, or the group bar's on the multi-selection — run only
// when the bar shows and offers them: R / Shift+R rotate, F flips, Space
// rolls a die (and its handful; the group's dice), Delete removes.
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (insp) closeInspector();
    else if (!peekEl.classList.contains('hidden')) peekEl.classList.add('hidden');
    else if (!seatMenuEl.classList.contains('hidden')) closeSeatMenu();
    else setMulti([]);
    return;
  }
  // (a held key fires once: an auto-repeat would roll, flip or delete again and again, for everyone)
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, button')) return;
  const k = e.key.toLowerCase(), cmd = k === 'r' ? (e.shiftKey ? 'rl' : 'rr') : { f: 'flip', ' ': 'roll', delete: 'del', backspace: 'del' }[k];
  if (!cmd || barEl.classList.contains('hidden') || !barEl.querySelector(`[data-cmd="${cmd}"]`)) return;
  e.preventDefault();
  runCmd(cmd, undefined, true);
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
  const d = drag;
  drag = null;
  if (d.group) { dropGroup(d); return; }
  dropEl(d);
  hideSnap();
  if (d.moved && d.mode === 'move' && view.items[d.id]) act({ t: 'move', id: d.id, x: d.x, y: d.y });
}

// A group drag (spec §4g): a drag of a member of the multi-selection carries
// every member this player may move, by one shift, cut as the host cuts it
// (clampShift over their centres: the group keeps its shape at the table's
// edge), each drawn by a translation; the other screens follow one `drag
// {ids, dx, dy}` every LIVE_MS (one flood token however many), and the drop
// is one `group` move — each piece then snaps on its own, as the host does.
/** A group drag of the members (`ids`, bottom to top) begins with a press at table point p. */
function groupDrag(id, ids, p) {
  const cs = ids.map((m) => { const it = view.items[m], { w, h } = sizeOf(it, boxes); return [it.x + w / 2, it.y + h / 2]; });
  return { id, group: new Set(ids), cs, sx: p.x, sy: p.y, dx: 0, dy: 0, moved: false, last: 0 };
}
/** Group drag `d` follows table point p (pointer event e). */
function moveGroup(d, p, e) {
  if (!d.moved) {
    if (Math.hypot(p.x - d.sx, p.y - d.sy) < 5 / scale) return;
    d.moved = true;
    let z = 100000; // (on top, in their order, while carried: the host sets their real z on the drop)
    for (const id of d.group) { const el = itemEls.get(id); if (el) { el.classList.add('dragging'); el.style.zIndex = z++; } }
    barEl.classList.add('hidden');
  }
  ({ dx: d.dx, dy: d.dy } = clampShift(TABLE, d.cs, p.x - d.sx, p.y - d.sy));
  for (const id of d.group) { const el = itemEls.get(id); if (el) el.style.translate = `${d.dx}px ${d.dy}px`; }
  if (e.timeStamp - d.last > LIVE_MS) {
    d.last = e.timeStamp;
    act({ t: 'drag', ids: [...d.group], dx: d.dx, dy: d.dy });
  }
}
/** Group drag `d` ends (drag is null by now): each member lands where the
 *  host will put it (its own snap: snapTo), held there until the host's
 *  state shows it (hold); one `group` move. Not moved: nothing is sent. */
function dropGroup(d) {
  const B = boardsNow(), held = [];
  for (const id of d.group) {
    const el = itemEls.get(id), it = view.items[id];
    if (!el || !it) continue;
    el.classList.remove('dragging');
    el.style.zIndex = it.z;
    el.style.translate = '';
    if (!d.moved) { placeEl(id); continue; } // (a state that came meanwhile wasn't drawn: the press held it)
    const { w, h } = sizeOf(it, boxes), s = snapTo(B, TABLE, w, h, it.x + d.dx, it.y + d.dy, { free: !snaps(it, boxes) });
    Object.assign(el.style, { left: `${s.x}px`, top: `${s.y}px` });
    held.push({ id, x: s.x, y: s.y, ox: it.x, oy: it.y });
  }
  renderBar();
  if (!held.length) return;
  hold(held);
  act({ t: 'group', op: 'move', ids: [...d.group], dx: d.dx, dy: d.dy });
}

// The snap preview (spec §3g): while a piece is dragged over a structured
// board, an outline (.snap-ghost, in #table: table units) shows the spot it
// would land on — where it will be drawn, fanned in with the pieces there
// — and a chip by the finger (.snap-chip, screen space) names its address.
// Computed here from the public view by core's own snapping (snapTo), so the
// drop sends the spot the host snaps to. Both move by translation.
const ghostEl = Object.assign(document.createElement('div'), { className: 'snap-ghost hidden' });
const chipEl = Object.assign(document.createElement('div'), { className: 'snap-chip hidden' });
tableEl.appendChild(ghostEl);
wrapEl.appendChild(chipEl);
/** What drag `d` (of public item `it`, in mode `mode`) puts down that
 *  snaps (core's snaps): the piece moved, or the one a supply or a stack
 *  hands out — {w, h, shape, rot} — or null (cards, piles, bags, boards and
 *  dice never snap). */
function snapsAs(it, mode) {
  const put = mode === 'move' ? it : { k: 'g', t: it.t }; // (the item itself, or one piece its supply or stack hands out)
  return snaps(put, boxes) ? { ...flagsOf(it, boxes), rot: mode === 'take' ? 0 : num(it.rot) } : null;
}
/** Shows where the dragged piece would land, or nothing: drag.spot = {x, y
 *  (the top-left the host centres it at, sent with the drop), to (its
 *  address), slot (where it will be drawn: its place in the spot's fan)}. */
function previewSnap() {
  const P = drag.snap, T = P && boardsNow(), s = P && snapTo(T, TABLE, P.w, P.h, drag.x, drag.y);
  drag.spot = s?.at ? { x: s.x, y: s.y, to: displayAddr(T, s.at) } : null;
  ghostEl.classList.toggle('hidden', !drag.spot);
  chipEl.classList.toggle('hidden', !drag.spot);
  if (!drag.spot) return;
  const S = spotOn(drag.spot.to), others = S ? spotMembers(drag.spot.to).filter((id) => id !== drag.id) : [];
  // (centred there, it fans them all, D120 — and goes on top of them)
  drag.spot.slot = fanSlots(S, [...others.map((id) => sizeOf(view.items[id], boxes)), P])?.[others.length] || { x: s.x, y: s.y };
  Object.assign(ghostEl.style, { width: `${P.w}px`, height: `${P.h}px`, translate: `${drag.spot.slot.x}px ${drag.spot.slot.y}px`, rotate: `${P.rot}deg` });
  ghostEl.classList.toggle('round', P.shape === 'round' || P.shape === 'disc');
  const [px, py] = tableToScreen(drag.x + drag.dx, drag.y + drag.dy); // (the finger: no layout read)
  if (chipEl.textContent !== drag.spot.to) chipEl.textContent = drag.spot.to; // (a DOM write only when the address changes)
  // (its width estimated, not measured — a measure would lay the table out
  // mid-drag: 15 px bold, at most 9.5 px a character, and its padding)
  const cw = 20 + 9.5 * drag.spot.to.length;
  chipEl.style.translate = `${Math.round(clamp(px + 18, 4, wrapW - cw - 4))}px ${Math.round(Math.max(4, py - 46))}px`;
}
/** Takes the snap preview away. */
function hideSnap() {
  ghostEl.classList.add('hidden');
  chipEl.classList.add('hidden');
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
 *  {onto}: a matching stack, its supply, a bag. A piece landing on a board
 *  lands on the snap preview's spot (d.x, d.y), its address an advisory `to`. */
function dropAction(d, it, tgtId, tgt, onHand) {
  const { id, x, y, mode } = d, held = onHand && flagsOf(it, boxes).hand && handRoom(), may = !!tgt && mayTouch(tgt), to = d.spot && { to: d.spot.to };
  if (mode === 'take') return held ? { t: 'take', id, hand: true } : { t: 'take', id, x, y, ...to };
  if (mode === 'split') {
    if (held) return { t: 'toHand', id };
    return may && (counts(it, tgt, 1) || returns(it, tgt) || bagTakes(tgt, it, 1)) ? { t: 'split', id, n: 1, onto: tgtId } : { t: 'split', id, n: 1, x, y, ...to };
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
  return { t: 'move', id, x, y, ...to };
}

/** The face a long press shows enlarged on public item `it`: a face-up card
 *  or card pile top; a piece's face with an image, a text or a label; else null. */
const pressFace = (it) => (it.k === 'c' ? it.up && it : it.k === 'p' && 'd' in (it.top || {}) ? it.top.up && it.top : pieces.zoomable(it, boxes));

/** A felt drag ends (let go, or a pinch, a long press, a cancel): its band,
 *  if it drew one, goes (a band let go picks first: endBand), and a pan
 *  writes the sizes placeSeats held back while it moved. */
function dropFelt() {
  const f = feltDrag;
  feltDrag = null;
  bandEl.classList.add('hidden');
  if (f?.moved && !f.band) placeSeats(); // (a pan's end: the sizes it held back)
}
function startPinch() {
  cancelItemDrag();
  dropFelt();
  const [p1, p2] = [...tPtrs.values()];
  const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  pinch = {
    z0: zoomZ,
    a0: viewAngle,
    d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
    ang0: (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI,
    t0: toTable({ clientX: m.x, clientY: m.y }), // table point pinned under the fingers
    r: wrapEl.getBoundingClientRect(), // the table area's client rect, read once (each finger's move would force a restyle: updatePinch)
    fit: scale / zoomZ, // the fit as the fingers land: whether a rest resizes the badges goes by it too (pinchRest)
    rest: 0, // the timer that sees the fingers rest (pinchRest)
  };
}

/** The fingers rest mid-pinch: the badges take the view's exact size if it
 *  differs from theirs by more than BZ_STEP, and so does the zoom's size at
 *  the fit the fingers landed on — which a twist leaves as it is, though it
 *  refits a rectangle (see viewSheet). */
function pinchRest() {
  const far = (s) => { const bz = badgeSize(s); return Math.max(bz / badgeZ, badgeZ / bz) > BZ_STEP; };
  if (far(scale) && far(pinch.fit * zoomZ)) sizeBadges(scale);
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
  fit();
  anchorView(pinch.t0, m.x, m.y, pinch.r); // the felt tracks the fingers (one layout, reading nothing back)
  clearTimeout(pinch.rest);
  pinch.rest = setTimeout(pinchRest, PINCH_REST_MS);
}

/** A finger's reach (CSS px, D170): a supply drawn smaller than twice this —
 *  go's bowl on a 19 × 19 board is 16 px wide on a phone held upright — is
 *  taken by a press this near its centre, as a 44 px target would be. Only
 *  supplies (a game's few bowls and piles, where every move starts): on a
 *  crowded table zoomed out, small pieces everywhere would leave a finger no
 *  felt to pan by. */
const TOUCH_REACH = 22;
/** The supply a touch at table point p that took nothing means: the nearest
 *  one this player may drag (dragMode, for event e) drawn under 2 ×
 *  TOUCH_REACH px whose centre is within TOUCH_REACH px of p — or null. */
function nearTouch(p, e) {
  let best = null, bd = TOUCH_REACH / scale;
  for (const [id, it] of Object.entries(view.items)) {
    if (it.k !== 's') continue;
    const { w, h } = sizeOf(it, boxes);
    if (Math.max(w, h) * scale >= 2 * TOUCH_REACH) continue;
    const o = fanPos.get(id) || it, d = Math.hypot(o.x + w / 2 - p.x, o.y + h / 2 - p.y);
    if (d <= bd && dragMode(id, it, e)) [best, bd] = [id, d];
  }
  return best;
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
  const hit = e.target.closest('.item')?.dataset.id;
  let id = hit && topOf(hit), it = id && view.items[id], mode = it && dragMode(id, it, e);
  // A finger that took nothing it may drag takes a small supply right by it
  // (an ask's table pick reads the tap itself, as it was).
  const near = !mode && e.pointerType !== 'mouse' && !askOpen()?.among && nearTouch(toTable(e), e);
  if (near) [id, it, mode] = [near, view.items[near], dragMode(near, view.items[near], e)];
  const el = id && itemEls.get(id);
  // Shift and a press where a plain drag would pan — the felt, a locked board,
  // an item this player may not drag — draw a band; so does, in ⬚ select
  // mode, a press anywhere but on a picked member (which carries the
  // selection): the mode's drag draws a box, its tap picks (D225, D237).
  const band = selMode ? !(mode && picked().includes(id)) : e.shiftKey && !mode;
  if (band) mode = null;
  if (mode || band) e.preventDefault();
  const p = toTable(e);
  // (a tap on a ×N stack's count, or on a crowded spot's ×k, opens the inspector)
  const badge = hit && hit === id && (e.target.closest('.fanb') ? 'spot' : e.target.closest('.count') ? 'stack' : '');
  // An item drag, or a pan: felt, and items this player may not drag (spec
  // §2g: locked, or someone else's), pan the view; a tap on such an item
  // still selects it. An item drag's live position lives on its record (x,
  // y), never in view.items: incoming states replace those objects mid-drag
  // (a guest would drop at a stale spot), and the host must not touch state
  // outside apply() (a vetoed drop has to snap back). A take or a split
  // drags a copy of one piece (made once the drag starts: a tap leaves nothing behind).
  // An item drag starts where the item is drawn (fanned on a crowded spot:
  // a press anywhere on the crowd takes its top piece, into the finger).
  // A member of the multi-selection carries the whole group (groupDrag).
  let g;
  if (mode && multi.has(id)) {
    g = drag = { ...groupDrag(id, [...multi].filter(mayMove).sort((a, b) => view.items[a].z - view.items[b].z), p), badge };
  } else if (mode) {
    // (the grip: where the finger or the mouse took it — but a touch take from a supply drawn smaller than a fingertip
    // holds the new piece by its centre, as nearTouch's does: by its corner, it would land off the spot the finger is on)
    const d0 = fanPos.get(id) || it, { w, h } = sizeOf(it, boxes), tiny = mode === 'take' && e.pointerType !== 'mouse' && Math.max(w, h) * scale < 2 * TOUCH_REACH;
    const [dx, dy] = hit === id && !tiny ? [p.x - d0.x, p.y - d0.y] : [w / 2, h / 2];
    g = drag = { id, el, mode, ghost: false, dx, dy, sx: p.x, sy: p.y, x: d0.x, y: d0.y, ox: it.x, oy: it.y, moved: false, last: 0, badge };
  } else g = feltDrag = { sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false, tap: it ? id : null, badge, band, r: band && wrapEl.getBoundingClientRect() };
  // Touch long-press (≈450 ms without moving) zooms a face-up card, a pile's
  // top or a piece's face until the finger lifts (UX-I5) — on a ×N stack it
  // opens the inspector instead (spec §4g); a drag, a pinch or an early lift
  // cancels it. Release-to-close also swallows the tap the browser may
  // synthesize on release, which would otherwise land on the overlay.
  const face = it && pressFace(it), stack = it?.k === 'g' && it.n >= 2;
  if ((face || stack) && e.pointerType !== 'mouse') {
    setTimeout(() => {
      if ((drag !== g && feltDrag !== g) || g.moved || pinch) return;
      drag = null;
      dropFelt();
      if (stack) { openInspector({ id }); return; }
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
    if (feltDrag.band) { drawBand(feltDrag, e); return; }
    panX = feltDrag.px + (e.clientX - feltDrag.sx);
    panY = feltDrag.py + (e.clientY - feltDrag.sy);
    layout();
    return;
  }
  if (inspPress && Math.hypot(e.clientX - inspPress.x, e.clientY - inspPress.y) >= 8) dragOut(e);
  if (!drag) return;
  const p = toTable(e);
  if (drag.group) { moveGroup(drag, p, e); return; }
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
    drag.snap = snapsAs(view.items[drag.id], drag.mode);
    drag.el.classList.add('dragging');
    drag.el.style.zIndex = 100000; // visually on top; the host assigns the real z on move
    select(null);
    wantSelect(drag.id); // (a piece dragged without a tap first: the rules' hint shows where it may go while it is carried)
  }
  const { w, h } = sizeOf(view.items[drag.id], boxes);
  ({ x: drag.x, y: drag.y } = clampToTable(TABLE, p.x - drag.dx, p.y - drag.dy, w, h));
  drag.el.style.left = `${drag.x}px`;
  drag.el.style.top = `${drag.y}px`;
  // The live position for the other players (a `drag`: no state); the drop is the one move.
  if (drag.mode === 'move' && e.timeStamp - drag.last > LIVE_MS) {
    drag.last = e.timeStamp;
    act({ t: 'drag', id: drag.id, x: drag.x, y: drag.y });
  }
  previewSnap();
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
  dropFelt();
  inspPress = null;
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
  inspPress = null;
  if (feltDrag) {
    const f = feltDrag;
    dropFelt();
    if (f.band && f.moved) { endBand(f, e); return; }
    // A plain click on empty felt deselects; on an item that can't be
    // dragged, (de)selects it — a board only when nothing else is selected:
    // a tap beside a selected piece mostly lands on the board, and only puts
    // its bar away. An open ask that picks on the table takes the tap instead.
    // With Shift or ⬚, a tap picks (togglePick); the felt and boards keep the selection.
    if (f.moved || seatTap(e) || askTap(e, f.tap)) return;
    if (f.band) { if (f.tap) togglePick(f.tap); return; }
    if (f.badge && openInspector(inspectOf(f.tap, f.badge))) return;
    if (multi.size) setMulti([]);
    tapSelect(f.tap && sel !== f.tap && !(sel && isBoard(view.items[f.tap] || {})) ? f.tap : null);
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.group) {
    dropGroup(d);
    if (!d.moved && !seatTap(e) && !askTap(e, d.id)) tapItem(e, d.id, d.badge);
    return;
  }
  const it = view.items[d.id];
  if (!it || !d.moved) {
    dropEl(d);
    if (it && !seatTap(e) && !askTap(e, d.id)) tapItem(e, d.id, d.badge);
    return;
  }
  // The drop target: hit-test BEFORE the dragged element takes the pointer
  // back (.dragging lets it through), so elementFromPoint sees underneath it.
  const under = document.elementFromPoint(e.clientX, e.clientY), tgtId = under?.closest('.item')?.dataset.id;
  dropEl(d);
  hideSnap();
  if (tgtId === d.id) return; // a piece taken out of its stack or supply and put back on it: nothing happened
  if (d.spot) [d.x, d.y] = [d.spot.x, d.spot.y]; // (onto the snap preview's spot: the host snaps there too)
  const a = dropAction(d, it, tgtId, tgtId && view.items[tgtId], !!under?.closest('#hand-bar'));
  // (drawn where the preview showed it — its place in the spot's fan — while
  // the landing hold waits for the state to centre it on the spot)
  if (a.t === 'move' && d.spot) { d.el.style.left = `${d.spot.slot.x}px`; d.el.style.top = `${d.spot.slot.y}px`; }
  if (a.t === 'move') hold([{ id: d.id, x: d.x, y: d.y, ox: d.ox, oy: d.oy }]);
  act(a);
});

/** A tap (a click) on item `id` that dragged nothing (`badge`: the pressed
 *  one's 'stack' or 'spot' badge, or ''): with Shift or ⬚ select mode it
 *  picks the item or puts it back; on a badge it opens the inspector; else
 *  it selects the item alone — or deselects it, tapped again. */
function tapItem(e, id, badge) {
  if (e.shiftKey || selMode) { togglePick(id); return; }
  if (badge && openInspector(inspectOf(id, badge))) return;
  if (multi.size) setMulti([]);
  tapSelect(sel === id ? null : id);
}

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
  if (e.shiftKey || selMode) return; // (two clicks that pick a piece and put it back are no double-click: nothing flips, rolls or draws)
  const id0 = e.target.closest('.item')?.dataset.id, id = id0 && topOf(id0), a = id && view.items[id] && dblAction(id, view.items[id]);
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
// the overlay that just opened under the finger and close it at once. While
// a hand ask is open, a click picks the card for it instead.
handEl.addEventListener('click', (e) => {
  const el = e.target.closest('.hcard');
  const c = el && view.hand[+el.dataset.idx];
  if (c && !handDragged && !askHandTap(+el.dataset.idx)) showZoom(c); // a drag dropped back on its card isn't a click
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
 *  template, else the built-in box last set up (rules off), else the free
 *  table — or none ('') while a box's own rules run (📦's: Hexfront). */
function currentGame() {
  const rules = T?.state.rules;
  if (rules?.enabled) return rules.box ? '' : GAMES.find((g) => RULES_TEMPLATES[g.k] === rules.code)?.k || 'custom';
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
  const game = GAMES.find((g) => g.k === k);
  if (game?.box || game?.clear) { pickCleared(game); return; }
  // Another game's state (chips, scores, a hand) is discarded by setRules —
  // even while the rules are off ("Free table" keeps it for re-enabling).
  // setRules keeps the state of a script with the same name: compare names too.
  const tplName = scriptName(RULES_TEMPLATES[k]), rules = T?.state.rules;
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

/** Sets up a game that needs a cleared table: a box game (`box`: BOXES[box],
 *  spec §2g, played by hand — the rules are switched off, then the box set
 *  up, its own rules started after it when it has some: Hexfront's turn
 *  script, built in) or a rules game that builds its own board (`clear`: chess, go,
 *  reversi, §3g — the table cleared, then the rules enabled afresh, their
 *  setup laying the game out; `code`: its text, the 📜 dialog's perhaps
 *  edited). On a table with items or a rules state, only once the host
 *  agrees to discard them. The last act()'s promise, or null when the host
 *  keeps the table. */
function pickCleared(game, code = RULES_TEMPLATES[game.k]) {
  if ((Object.keys(T.state.items).length || T.state.rules) && !confirm(`Clear the table and set up ${game.title}? The current game is discarded.`)) return null;
  askGame = false;
  $('games-dialog').close();
  if (game.box) {
    if (T.state.rules?.enabled) act({ t: 'setRules', enabled: false });
    return act({ t: 'loadBox', box: BOXES[game.box], setup: true, clear: true, ...(BOXES[game.box].rules && { rules: true }) });
  }
  act({ t: 'clear' });
  $('rules-code').value = code; // the 📜 dialog shows what runs
  return act({ t: 'setRules', code, enabled: true, reset: true });
}
/** The script name `code` gives itself (its `name: '…'`, however spaced or
 *  quoted: "name": "…", name:`…`), as setRules keeps a game's state by it. */
const scriptName = (code) => /["']?\bname["']?\s*:\s*(['"`])(.*?)\1/.exec(code || '')?.[2];

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
  $('rules-status').textContent = meta?.enabled ? `active: ${meta.name}${strictRules() ? ' · strict' : ''}` : 'inactive';
  $('rules-tpl').classList.toggle('hidden', !isHost);
  $('rules-enable').classList.toggle('hidden', !isHost);
  $('rules-reset-lbl').classList.toggle('hidden', !isHost);
  $('rules-disable').classList.toggle('hidden', !isHost || !meta?.enabled);
  $('rules-code').readOnly = !isHost;
  $('rules-err').textContent = isHost ? lastRulesError : ''; // the host's last script error
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

// Enable starts a rules Worker, then runs the script's setup there: "Starting…"
// until it is done; the dialog then closes, or stays open showing what went
// wrong (the code didn't evaluate, setup threw), the running rules unchanged.
// A game that lays out the whole table (chess, go, reversi: GAMES `clear`,
// known by its script name, so an edited copy too) starts afresh as 🎲 starts
// it, on a cleared table once the host agrees — unless it is the game this
// table holds, going on (D169, D173).
$('rules-form').addEventListener('submit', async (e) => {
  if (e.submitter?.id !== 'rules-enable') return; // Close button
  e.preventDefault();
  const btn = $('rules-enable'), code = $('rules-code').value, name = scriptName(code), reset = $('rules-reset').checked;
  const game = GAMES.find((g) => g.clear && scriptName(RULES_TEMPLATES[g.k]) === name), fresh = game && (reset || T.state.rules?.name !== name);
  btn.disabled = true;
  btn.textContent = 'Starting…';
  $('rules-err').textContent = '';
  const r = await (fresh ? pickCleared(game, code) : act({ t: 'setRules', code, enabled: true, reset }));
  btn.disabled = false;
  btn.textContent = 'Enable';
  if (!r) return; // (the host kept the table)
  if (r.ok && !lastRulesError) $('rules-dialog').close();
  else {
    updateRulesDialog();
    if (!lastRulesError) $('rules-err').textContent = r.error || 'The rules did not start';
  }
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

// --- game boxes (📦, spec §4g) -------------------------------------------------
// The dialog lists every box on this table (the host's, a guest's upload, a
// script's, a built-in one once set up), the built-in boxes, an upload, and
// the export. Anyone may upload (a guest within the guests' budget); setting
// a box up, resetting it and exporting are the host's. A box's rules never
// run without the host's click in the trust dialog, unless the box is built
// in — by its content (isBuiltin, which keeps its answer per box), never by anything a peer can send.
/** Every box on this table as the dialog and the terminal list it: {id,
 *  name, types, decks, src, by (a pid), builtin, rules} — and on the host
 *  `setup`, whether Set up has anything to do (a layout, or rules that lay
 *  the table out themselves: t.layout). A guest knows what the host says
 *  of each (boxInfo). */
function boxEntries() {
  const host = role === 'host';
  return Object.entries(host ? T.state.boxes : boxes).map(([id, b]) => {
    const i = (host ? T.state.boxSrc[id] : boxInfo[id]) || { src: 'host' };
    return {
      id, name: b.name, types: Object.keys(b.types).length, decks: Object.keys(b.decks || {}).length, src: i.src, by: i.by,
      builtin: host ? isBuiltin(b) : !!i.builtin, rules: host ? !!b.rules : !!i.hasRules, ...(host && { setup: !!b.setup?.length || !!b.rules }),
    };
  });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** "3 piece types · 1 deck" */
const boxSize = (e) => [e.types && plural(e.types, 'piece type'), e.decks && plural(e.decks, 'deck')].filter(Boolean).join(' · ') || 'empty';
/** Who a box comes from, as the dialog says it. */
const boxBy = (e) => (e.builtin ? 'built in' : e.src === 'script' ? 'made by 📜 Rules' : `by ${e.by ? actorInfo(e.by).name : 'the host'}`);

/** Redraws the 📦 dialog's lists while it is open (renderAll, takeBoxes): a guest's is read-only. */
function renderBoxes() {
  if (!$('box-dialog').open) return;
  const host = role === 'host', last = host && T.state.lastSetup, again = host && !noReset();
  const row = (e) => `<div class="box-row" data-box="${esc(e.id)}"><div class="box-info"><b>${esc(e.name)}</b>${e.rules ? ' <span title="comes with rules">📜</span>' : ''}${e.id === last ? ' <i>set up</i>' : ''}
    <small>${esc(boxSize(e))} · ${esc(boxBy(e))}</small></div>${host ? `<span class="box-btns">${e.id === last && again ? '<button data-act="reset">↺ Reset</button>' : ''}${e.setup ? '<button data-act="setup">Set up</button>' : ''}</span>` : ''}</div>`;
  const html = boxEntries().map(row).join('') || '<p class="box-note">No game box on this table yet.</p>';
  if ($('box-list').innerHTML !== html) $('box-list').innerHTML = html; // (unchanged: the focus stays)
  for (const id of ['box-builtin', 'box-export', 'box-now-lbl']) $(id).classList.toggle('hidden', !host);
  if (!host) return;
  if (!$('box-builtins').children.length) {
    $('box-builtins').innerHTML = Object.entries(BOXES).map(([k, b]) => `<div class="box-row"><div class="box-info"><b>${esc(b.name)}</b>
      <small>${esc(GAMES.find((g) => g.box === k)?.pitch || b.meta?.pitch || boxSize({ types: Object.keys(b.types).length }))}</small></div><span class="box-btns"><button data-builtin="${k}">Set up</button></span></div>`).join('');
  }
  const code = !!T.state.rules?.code;
  $('box-x-rules').disabled = $('box-x-state').disabled = !code;
}
$('box-btn').addEventListener('click', () => {
  for (const id of ['box-progress', 'box-err', 'box-msg', 'box-x-msg']) $(id).textContent = '';
  if (role === 'host') $('box-x-rules').checked = $('box-x-state').checked = !!T.state.rules?.enabled; // (rules the table runs go with it, by default)
  $('box-dialog').showModal();
  renderBoxes();
});
$('deck-to-box').addEventListener('click', () => { $('deck-dialog').close(); $('box-btn').click(); });
let setupUnderWay = false; // a Set up or Reset is under way (asking, or sent): a press meanwhile — a double click's second — starts nothing
/** Runs a Set up or a Reset (`fn`: its promise of act()'s outcome, or null) — one at a time: null while another is under way. */
async function oneSetup(fn) {
  if (setupUnderWay) return null;
  setupUnderWay = true;
  try { return await fn(); } finally { setupUnderWay = false; }
}
$('box-dialog').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act], button[data-builtin]');
  if (!b) return;
  $('box-msg').textContent = '';
  boxDone(await oneSetup(() => (b.dataset.builtin ? pickCleared({ box: b.dataset.builtin, title: BOXES[b.dataset.builtin].name })
    : b.dataset.act === 'reset' ? resetBox() : setUpBox(b.closest('[data-box]').dataset.box))));
});
/** After Set up or Reset (act()'s outcome, null when the host cancelled): the
 *  dialog closes on the table set up, or says why it wasn't. */
function boxDone(r) {
  if (r?.ok) {
    askGame = false; // (the strip's question is answered)
    $('box-dialog').close();
    renderAll();
  } else if (r) show($('box-msg'), r.error || 'Nothing was set up');
}

/** How long a question's buttons stay disabled once it shows: the second
 *  click of a double-click (or tap) that answered the dialog before must not
 *  answer this one — the trust dialog follows the setup confirm in the same
 *  element (D204). */
const ASK_ARM_MS = 500;
/** Asks the host in #box-ask (`kind`: setup, reset or trust, its data-kind):
 *  a title, then `body` — each a line of text, or a checkbox {id, label, on}
 *  — and the buttons [[value, label, main?]], left to right, each disabled
 *  for ASK_ARM_MS. Resolves {v: the button's value ('cancel' on Esc), on:
 *  {checkbox id: ticked}}. Every text is set as text. */
function boxAsk(kind, title, body, btns) {
  const dlg = $('box-ask'), el = (tag, o) => Object.assign(document.createElement(tag), o);
  const check = ({ id, label, on }) => {
    const box = el('input', { type: 'checkbox', checked: on }), l = el('label', { className: 'radio' });
    box.dataset.c = id;
    l.append(box, ` ${label}`);
    return l;
  };
  dlg.dataset.kind = kind;
  dlg.returnValue = '';
  $('box-ask-title').textContent = title;
  $('box-ask-body').replaceChildren(...body.map((x) => (typeof x === 'string' ? el('p', { textContent: x }) : check(x))));
  const buttons = btns.map(([v, label, main]) => el('button', { value: v, textContent: label, className: main ? 'main' : '', disabled: true }));
  $('box-ask-btns').replaceChildren(...buttons);
  dlg.showModal();
  setTimeout(() => { for (const b of buttons) b.disabled = false; }, ASK_ARM_MS);
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve({
    v: dlg.returnValue || 'cancel', on: Object.fromEntries([...dlg.querySelectorAll('[data-c]')].map((c) => [c.dataset.c, c.checked])),
  }), { once: true }));
}
/** Whether a setup would discard anything: items on the table, or cards in a hand. */
const tableBusy = () => Object.keys(T.state.items).length > 0 || Object.values(T.state.players).some((pl) => pl.hand.length);
/** "The rules running now («Chess») are switched off." */
const stopLine = (name) => `The rules running now («${name}») are switched off.`;
/** Host: sets box `id` up (spec §4g). From the dialog, it first asks what
 *  there is to decide — "This clears the table", the running rules it stops,
 *  "Enable its rules" (ticked), and for a guest's box "Shuffle face-down
 *  piles" (ticked) under "{Bob} added this box and knows its starting
 *  layout"; from the terminal `o` says it ({clear, rules}). Then, before the
 *  rules of any box that isn't built in, the trust dialog: Enable rules, Set
 *  up without rules, or Cancel. A box without a layout is set up by its
 *  rules alone (t.layout): neither its checkbox nor "Set up without rules"
 *  is offered — they would clear the table for nothing (D213). A clearing
 *  setup stops the game that ran (its rules switched off first, as 🎲 does:
 *  pickCleared) — the box's own rules, when enabled, start after it (D205).
 *  Resolves act()'s outcome, or null when the host cancelled. */
async function setUpBox(id, o) {
  const box = T.state.boxes[id], src = T.state.boxSrc[id] || { src: 'host' }, layout = !!box.setup?.length;
  const by = src.src === 'upload' ? T.state.players[src.by]?.name || 'A guest' : '';
  let { clear = true, rules = !!box.rules, shuffle } = o || {};
  const stops = clear && T.state.rules?.enabled ? T.state.rules.name : '';
  if (!o && (tableBusy() || (box.rules && layout) || by || stops)) {
    const r = await boxAsk('setup', `Set up «${box.name}»?`, [
      ...(tableBusy() ? ['This clears the table.'] : []),
      ...(stops ? [stopLine(stops)] : []),
      ...(box.rules && layout ? [{ id: 'rules', label: 'Enable its rules', on: true }] : []),
      ...(by ? [`${by} added this box and knows its starting layout.`, ...(layout ? [{ id: 'shuffle', label: 'Shuffle face-down piles', on: true }] : [])] : []),
    ], [['cancel', 'Cancel'], ['ok', 'Set up', true]]);
    if (r.v !== 'ok') return null;
    rules = r.on.rules ?? rules;
    shuffle = r.on.shuffle;
  }
  if (rules && !isBuiltin(box)) {
    // (Cancel, never Enable rules, where the confirm's Set up was — the last
    // button stands at #box-ask's bottom right: a stray second click cancels)
    const { v } = await boxAsk('trust', `«${box.name}» has rules`, [
      `«${box.name}» comes with rules written by its author${by ? `, added by ${by}` : ''}. A rules script sees every hand and hidden piece and can reveal them. Enable the rules?`,
    ], [['enable', 'Enable rules', true], ...(layout ? [['without', 'Set up without rules']] : []), ['cancel', 'Cancel']]);
    if (v === 'cancel') return null;
    rules = v === 'enable';
  }
  if (stops) act({ t: 'setRules', enabled: false });
  return act({ t: 'setup', box: id, clear, rules, ...(shuffle !== undefined && { shuffle }) });
}
/** Why the box last set up can't be reset now, or '': without a layout it is
 *  laid out by its own rules alone, and they aren't running — a Reset would
 *  clear the table for nothing (core refuses it too: D215). 📦 offers no
 *  Reset then, and the terminal says this; Set up starts the rules again. */
function noReset() {
  const last = T.state.lastSetup, box = T.state.boxes[last], r = T.state.rules;
  return box && !box.setup?.length && !(r?.enabled && r.box === last) ? `«${box.name}» is laid out by its rules, which aren't running: Set up starts them again` : '';
}
/** Host: Reset (spec §4g) — the box last set up laid out again on a cleared
 *  table, its rules restarted when they are running, any other rules
 *  switched off; asked first, unless from the terminal (`quiet`). Resolves
 *  act()'s outcome, or null. */
async function resetBox(quiet) {
  const last = T.state.lastSetup, name = T.state.boxes[last]?.name, r = T.state.rules;
  const stops = r?.enabled && r.box !== last ? r.name : '', again = r?.enabled && !stops; // (its own rules restart; any other stops)
  if (!quiet) {
    const { v } = await boxAsk('reset', `Reset «${name}»?`, [`The table is cleared and «${name}» laid out again${again ? ', its rules started afresh' : ''}.`, ...(stops ? [stopLine(stops)] : [])],
      [['cancel', 'Cancel'], ['ok', 'Reset', true]]);
    if (v !== 'ok') return null;
  }
  if (stops) act({ t: 'setRules', enabled: false });
  return act({ t: 'reset' });
}

let boxRun = 0; // the upload in the works (closing the dialog drops it: its result is not added)
let boxWait = null; // guest: the box it sent, {name, timer}, until the host answers (note, takeBoxes) or BOX_WAIT_MS pass
/** How long a guest waits for the host's answer to its box (it is a few seconds' transfer at most: the guests' budget is 1.5 M characters). */
const BOX_WAIT_MS = 30000;
/** Busy reading an upload: one at a time. */
const boxBusy = (on) => { $('box-up').disabled = on; $('box-up').textContent = on ? 'Reading…' : '⬆ Upload a game…'; };
/** Guest: stops waiting for the host's answer (answered, timed out, or the dialog closed). */
const unwait = () => { clearTimeout(boxWait?.timer); boxWait = null; };
$('box-dialog').addEventListener('close', () => { boxRun++; unwait(); boxBusy(false); });
$('box-up').addEventListener('click', () => $('box-files').click());
$('box-files').addEventListener('change', () => {
  const files = [...$('box-files').files];
  $('box-files').value = ''; // (the same files picked again are a new upload)
  if (files.length) uploadBox(files);
});
/** Writes `msg` into the dialog's element `el`, scrolled into view (a phone shows a few lines of the dialog). */
function show(el, msg) {
  el.textContent = msg;
  if (msg) el.scrollIntoView({ block: 'nearest' });
}
/** A guest hears how the box it sent went (note, takeBoxes, the host
 *  leaving, no answer within BOX_WAIT_MS): in the dialog, scrolled into
 *  view — a toast lies under a modal's backdrop (D190). */
function boxAnswer(msg, good) {
  unwait();
  show($('box-progress'), good ? msg : '');
  show($('box-err'), good ? '' : msg);
  if (!good) console.error('the box sent to the host was not added:', msg);
}
/** Refusal `msg` of an upload that the running rules (`rules`: {name}) made
 *  — a strict game takes no new boxes (D186), a script may veto one — with
 *  what to do about it. Only the rules' own refusal (a note's `ruled`, an
 *  outcome's) gets it: never the engine's gates or a storage failure (D211). */
const ruledOut = (msg, rules) => `${msg} — the rules running («${rules?.name || 'a script'}») refused the box; the host can switch them off in 📜, then it can be uploaded again`;
/** Reads an upload into a game box (boxio.readBox, which reports each file)
 *  and adds it. Progress and any failure show in the dialog (a failure as a
 *  toast too), naming the file or the field. The host's box is checked
 *  (checkTransportBox), added at once and, with "Set up now", set up; a
 *  guest's is checked, its images cached here first (as a deck's are), then
 *  sent: the host answers with a notice or with the box itself (boxWait). */
async function uploadBox(files) {
  const run = ++boxRun, say = (msg) => { if (run === boxRun) show($('box-progress'), msg); };
  boxBusy(true);
  $('box-err').textContent = '';
  try {
    const tb = await boxio.readBox(files, say);
    if (run !== boxRun) return;
    say('Checking the box…');
    const cost = checkTransportBox(tb), name = String(tb.name);
    if (role !== 'host') {
      const over = boxOverBudget(0, cost); // (bigger than all of the guests' budget; the host says what is left)
      if (over) throw new Error(over);
      await store.cache((await store.ingestBox(tb)).assets);
      if (run !== boxRun) return;
      if (!hostPeer) throw new Error("the host isn't here (the table is paused): try again once they are back");
      boxWait = { name, timer: setTimeout(() => boxAnswer(`No answer from the host about «${name}» — is their tab open? The box wasn't added: try again.`, false), BOX_WAIT_MS) };
      const r = await act({ t: 'addBox', box: tb });
      if (!r.ok) throw new Error(r.error);
      say(`Sent «${name}» to the host…`);
      return;
    }
    say(`Adding «${name}»…`);
    const r = await act({ t: 'addBox', box: tb }), box = T.state.boxes[r.id];
    if (!box) throw new Error(r.ruled ? ruledOut(r.error, T.state.rules) : r.error || 'the box was not added');
    const set = !!(box.setup?.length || box.rules); // (Set up has something to do: lay it out, or start its rules)
    say(`${r.ok ? `Added «${name}»` : 'That box is already on this table'}${!set && $('box-now').checked ? ' — it has no layout to set up: its pieces are in the catalog' : ''}`);
    boxBusy(false);
    if (run === boxRun && set && $('box-now').checked) boxDone(await oneSetup(() => setUpBox(r.id)));
  } catch (err) {
    console.error('a game upload failed', err);
    if (run !== boxRun) return;
    unwait();
    say('');
    show($('box-err'), `Couldn't add the game: ${err.message}`);
    toast(`Couldn't add the game: ${err.message}`);
  } finally {
    if (run === boxRun) boxBusy(false);
  }
}
// Export (host only, spec §4d: the file holds every hidden identity): core
// writes the table as a box (T.exportBox), boxio.js the file, saved through
// an object URL and <a download>.
$('box-x-go').addEventListener('click', async () => {
  const btn = $('box-x-go'), msg = $('box-x-msg');
  btn.disabled = true;
  msg.className = '';
  msg.textContent = 'Exporting…';
  try {
    const { box, warnings } = T.exportBox({ rules: $('box-x-rules').checked, state: $('box-x-state').checked });
    const { name, blob } = await boxio.exportFile(box, store.getAsset);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    show(msg, `Saved ${name}${warnings.length ? ` — left out: ${warnings.join('; ')}` : ''}`);
  } catch (err) {
    console.error('the export failed', err);
    msg.className = 'box-err';
    show(msg, `Export failed: ${err.message}`);
    toast(`Export failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// --- deck creation --------------------------------------------------------
// The images become data URLs through boxio.js (encodeImage: checked by their
// header, re-encoded and stepped down to fit 2 MB), as a game box's do.
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
        if (mf.size > boxio.FILE_MAX_BYTES) throw new Error(`${mf.name} is ${(mf.size / 1e6).toFixed(1)} MB (max ${boxio.FILE_MAX_BYTES / 1e6} MB)`);
        let m;
        try { m = JSON.parse(await mf.text()); } catch (err) { throw new Error(`${mf.name} is not valid JSON: ${err.message}`); }
        if (m && (m.pieces !== undefined || m.setup !== undefined)) throw new Error(`${mf.name} is a game box (it has pieces or a setup): upload it from 📦`);
        deck = await boxio.manifestDeck(m, images);
      } else {
        deck = await boxio.filenameDeck(images);
      }
      const backFile = $('deck-back').files[0];
      if (backFile) deck.back = await boxio.encodeImage(backFile, { name: backFile.name });
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
  const t = createTable(saved ? { ...saved.state, decks: saved.decks, boxes: saved.boxes, boxSrc: saved.boxSrc } : {}, { pid, hooks: pageHooks });
  if (saved) t.resume(myName); // re-sanitizes the decks and boxes, everyone else waits offline
  else t.open(myName); // the host's seat and a standard deck
  if (window.CARDTABLE_TEST) { // the one-writer rule (spec §3f.1), asserted: with a rules Worker running, only its patches change the table
    const apply = t.apply;
    t.apply = (p, a) => { if (worker || current?.start) throw new Error(`the one-writer rule broken: ${a.t} ran on the page while a rules Worker ${worker ? 'runs' : 'starts'}`); return apply(p, a); };
  }
  T = t;
  role = 'host';
  hostBoot = Date.now();
  askGame = !saved;
  savedCatalog.clear();
  if (saved?.stored) for (const id of [...Object.keys(saved.decks), ...Object.keys(saved.boxes || {})]) savedCatalog.add(id);
  $('size-sel').classList.remove('hidden'); // table size is the host's call
  commit(true);
  flush(); // this screen's first snapshot
  if (T.state.rules?.enabled) startWorker(T.state.rules.code, null); // (the saved rules run again — setup doesn't — once their Worker is ready; the queue waits)
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
 *  watching that browser. `ruled`: the rules refused this player's action
 *  (the host says so: the note's `ruled`). */
function note(msg, ruled = false) {
  toast(msg);
  if (CLI) cliMsgs.push(`note: ${msg}`);
  // (the guest waits on the box it sent — the dialog is modal: a refusal now is its answer, whatever refused it)
  if (boxWait && /^(🚫|That box is already)/u.test(msg)) boxAnswer(ruled ? ruledOut(msg, view.rules) : msg, msg.startsWith('That'));
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
  const at = { x: it.x | 0, y: it.y | 0, ...(it.at && { at: it.at }) }, mine = { ...(it.owner && { owner: cliOwner(it.owner) }), ...(it.lock && { locked: true }) };
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
    // this player's own parts (spec §3i): the rules' questions (an option's label only), hint and t.secret
    asks: view.ask.map((q) => (q.pick === 'hand' ? { ...q, count: q.count ?? 1 } : q)),
    hint: view.hint, secret: view.sec,
    rules: rules?.enabled ? rules.name : null, // (a name, as ever: cah-bot.py compares it; strict is its own field)
    strict: strictRules(),
    // the game boxes on this table (spec §4i), and the one last set up (the host's to know)
    boxes: boxEntries().map(({ id, name, types, rules: r, src, builtin }) => ({ id, name, types, rules: r, src, builtin })),
    lastSetup: (role === 'host' && T.state.lastSetup) || null,
    // rules: true marks script lines — a player can NAME itself "📜 Rules", but can't fake this
    log: view.log.slice(-40).map((e) => ({
      who: typeof e.n === 'string' ? e.n : actorInfo(e.p).name, text: e.txt,
      ...(e.c ? { chat: true } : {}), ...(e.p === RULES ? { rules: true } : {}), ts: e.ts,
    })),
    msgs: cliMsgs.slice(),
  };
}

const CLI_KINDS = { p: 'pile', b: 'bag', s: 'supply' };
/** Host: the box a command names, by its id or (any case) its name. */
function cliBox(ref) {
  if (own(T.state.boxes, ref)) return ref;
  const s = String(ref ?? '').toLowerCase(), named = Object.keys(T.state.boxes).filter((id) => T.state.boxes[id].name.toLowerCase() === s);
  if (named.length === 1) return named[0];
  throw new Error(named.length ? `two boxes are named «${ref}»: say its id (see "boxes")` : `no such game box: ${ref} — see "boxes"`);
}
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

/** An ask as the terminal says it (spec §3i): "❓ promo: Promote to [0] ♕
 *  [1] ♖ [2] ♗ [3] ♘", and for a pick what to answer — the one text both
 *  REPLs print, as the tab writes it. */
function cliAsk(q) {
  const n = q.count ?? 1, how = q.options ? q.options.map((l, k) => `[${k}] ${l}`).join(' ')
    : { item: () => `(an item: ${q.among.join(', ')})`, space: () => `(a spot: ${q.among.join(', ')})`,
      hand: () => `(${n} of your hand cards, by index${n > 1 ? ', comma-separated' : ''})`,
      number: () => `(a number from ${q.min} to ${q.max})` }[q.pick]();
  return `❓ ${q.id}: ${q.prompt} ${how}`;
}
let cliSeen = { asks: new Set(), hint: 'null', sec: 'null' }; // what the terminal was told of this player's own parts
/** Tells the terminal what reached this player alone (spec §3i: the REPLs
 *  print new asks as they come): each new ask (cliAsk), a new hint, a new
 *  t.secret — as messages, like a notice. (a bridged tab only) */
function cliParts() {
  if (!CLI) return;
  const asks = new Set(view.ask.map((q) => JSON.stringify(q))), hint = JSON.stringify(view.hint), sec = JSON.stringify(view.sec);
  view.ask.forEach((q) => { if (!cliSeen.asks.has(JSON.stringify(q))) cliMsgs.push(cliAsk(q)); });
  if (hint !== cliSeen.hint && view.hint) cliMsgs.push(`💡 hint: ${[...view.hint.spaces, ...view.hint.items].join(', ') || 'nothing'}`);
  if (sec !== cliSeen.sec && view.sec != null) cliMsgs.push(`🔒 for you: ${typeof view.sec.text === 'string' ? view.sec.text : sec}`);
  cliSeen = { asks, hint, sec };
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
      case 'group': { // (spec §4i) one op on many items, one action: `op` as the terminal says it (unlock: lock off; bag: into a bag)
        const op = { unlock: 'lock', bag: 'toBag' }[c.op] || String(c.op ?? ''), ids = (Array.isArray(c.ids) ? c.ids : [c.ids]).map((id) => cliItem(id));
        if (!GROUP_OPS.includes(op)) throw new Error(`group: no such op "${c.op}" — move, rot, flip, roll, lock, unlock, del, bag`);
        act({ t: 'group', op, ids, ...(op === 'move' && { dx: +c.dx || 0, dy: +c.dy || 0 }), ...(op === 'rot' && { rot: +(c.deg ?? c.rot) || 0 }),
          ...(op === 'lock' && { on: c.op !== 'unlock' && c.on !== false }), ...(op === 'toBag' && { bag: cliItem(c.bag, 'b') }) });
        break;
      }
      case 'seat': act(c.watch ? { t: 'seat', watch: true } : c.sit ? { t: 'seat', sit: true } : { t: 'seat', id: String(c.id) }); break;
      case 'answer': { // the rules' question `id`, answered with `v` as typed (answerV converts it: spec §3i)
        const q = view.ask.find((x) => x.id === String(c.id ?? ''));
        if (!q) throw new Error(`no question "${c.id}" waits for you — see "asks"`);
        const r = answerV(q, c.v);
        if ('why' in r) throw new Error(r.why);
        act({ t: 'answer', id: q.id, v: r.v });
        break;
      }
      case 'select': { // (the rules' hint comes back in the next state; what the host would drop is said here)
        const id = cliItem(c.id), why = noSelect(id);
        if (why) throw new Error(`select ${id}: ${why}`);
        act({ t: 'select', id });
        break;
      }
      case 'setup': { // (spec §4i) the trust dialog still asks on the page before the rules of a box that isn't built in
        if (role !== 'host') throw new Error('setup: only the host sets up a game');
        const id = cliBox(c.box), box = T.state.boxes[id];
        if (!box.setup?.length && !box.rules) throw new Error(`setup: «${box.name}» has nothing to set up (no layout, no rules)`);
        if (c.rules && !box.rules) throw new Error(`setup: «${box.name}» has no rules`);
        if (!box.setup?.length && !c.rules) throw new Error(`setup: «${box.name}» has no layout — its rules lay the table out: add --rules`);
        if (c.rules && !isBuiltin(box)) cliMsgs.push(`setup: «${box.name}» has rules — confirm them on the page (the host's click enables a box's rules)`);
        oneSetup(() => setUpBox(id, { clear: !c.keep, rules: !!c.rules })).then((r) => { if (!r) cliMsgs.push(`setup: «${box.name}» was not set up (cancelled on the page, or another setup was under way)`); },
          (err) => { console.error('bridge setup failed', err); cliMsgs.push(`error: ${err.message}`); });
        break;
      }
      case 'reset': {
        if (role !== 'host') throw new Error('reset: only the host resets a game');
        if (!T.state.boxes[T.state.lastSetup]) throw new Error('reset: no game box was set up on this table');
        const why = noReset(); // (said before anything is sent: no other rules switched off for a refused reset)
        if (why) throw new Error(`reset: ${why}`);
        oneSetup(() => resetBox(true)).catch((err) => { console.error('bridge reset failed', err); cliMsgs.push(`error: ${err.message}`); }); // (other rules than the box's own are switched off, as on the page)
        break;
      }
      case 'asks': for (const line of view.ask.length ? view.ask.map(cliAsk) : ['❓ no questions wait for you']) cliMsgs.push(line); break;
      case 'place': { // onto a board's spot (spec §3i): an item moves there, centred; a supply (id or type name) hands one out there
        const B = boardsNow(), r = resolveAddr(B, String(c.at ?? ''));
        if (r?.ambiguous) throw new Error(`🚫 Which board? Say '${r.ambiguous[0]}'`);
        if (!r) throw new Error(`no such address: ${c.at}`);
        const it = c.id != null && view.items[c.id], id = it && it.k !== 's' ? String(c.id) : cliItem(c.id, 's');
        const { w, h } = sizeOf(view.items[id], boxes), s = snapTo(B, TABLE, w, h, 0, 0, { at: r.at }); // (centred there: the host's own rule, D112)
        act({ t: view.items[id].k === 's' ? 'take' : 'move', id, x: s.x, y: s.y, to: displayAddr(B, r.at) });
        break;
      }
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
      if (s === last && !snap.msgs.length) return; // (a message again in the same words is news all the same)
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
  const skew = [['core.js', CORE_V], ['grid.js', GRID_V], ['pieces.js', pieces.MODULE_V], ['templates.js', TEMPLATES_V], ['store.js', store.MODULE_V], ['boxio.js', boxio.MODULE_V]].filter(([, v]) => v !== MODULE_V);
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
// Phase 3: `resolve(addr)` reads an address off this view's boards (core's
// resolveAddr: {at, local, x, y} of its centre, {ambiguous}, or null),
// `drawn(id)` where an item is drawn ({x, y, tx, ty}: its element's left/top
// and translate — fanned on a crowded spot, gliding in a live drag),
// `lives()` the live drags it shows ({id: {x, y}}), `spot()` the snap
// preview's spot ({x, y, to} or null), `snap(id, x, y)` where a move of
// item `id` to top-left (x, y) lands as this view sees it ({x, y, at}: on
// the board's spot it snaps to, else where it is clamped, at null).
// Phase 3B (the rules Worker, host only): `workerDigest()` the running
// Worker's T.digest() of its mirror (a Promise; null with no Worker: see
// workerDigest), `digest()` the host table's, `lastRulesError` the 📜
// dialog's error, `jobs()` how many jobs wait in the queue or are in flight
// (a Worker starting counts); perf adds the Worker's counters.
if (window.CARDTABLE_TEST) {
  window.__ct = {
    act, view: () => view, hand: () => view.hand, log: () => view.log, boxes: () => boxes, perf,
    workerDigest, digest: () => T?.digest() ?? null, jobs: () => queue.length + !!current,
    /** The host's state, copied (its seat keys left out): the catalog with its boxes' setups and rules, boxSrc, lastSetup, rules.box. */
    hostState: () => (T ? JSON.parse(JSON.stringify({ ...T.state, keys: undefined })) : null),
    get lastRulesError() { return lastRulesError; },
    resolve: (a) => { const r = resolveAddr(boardsNow(), a); return r && (r.ambiguous ? { ambiguous: r.ambiguous } : { at: displayAddr(boardsNow(), r.at), local: r.local, x: r.x, y: r.y }); },
    drawn(id) {
      const el = itemEls.get(id), [tx = 0, ty = 0] = (el?.style.translate || '').split(' ').map(parseFloat);
      return el && { x: parseFloat(el.style.left), y: parseFloat(el.style.top), tx: tx || 0, ty: ty || 0 };
    },
    lives: () => Object.fromEntries([...lives].map(([id, L]) => [id, { x: L.x, y: L.y }])),
    spot: () => drag?.spot ?? null,
    snap(id, x, y) {
      const it = view.items[id], { w, h } = sizeOf(it, boxes), B = boardsNow(), s = snapTo(B, TABLE, w, h, x, y, { free: !snaps(it, boxes) });
      return { ...s, at: s.at && displayAddr(B, s.at) };
    },
  };
}
boot().catch((err) => { console.error('boot failed', err); toast(`Failed to start: ${err.message}`); });
