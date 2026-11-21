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
//
// The table's state and every operation on it live in core.js (no DOM, no
// network); this file is the network, persistence, rendering, input, dialogs
// and the terminal bridge around it. The shipped rules scripts are in templates.js.
import { joinRoom, selfId, getRelaySockets } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm';
import {
  CARD_W, CARD_H, TABLE_SIZES, IMG_RE, COLOR_RE, RANKS, RULES, playR, clampToFelt,
  PID_RE, rand, clamp, own, num, cleanDeck, cleanName, standardDeck, cardName, createTable,
} from './core.js';
import { RULES_TEMPLATES, GAMES } from './templates.js';

const $ = (id) => document.getElementById(id);
const tableEl = $('table'), wrapEl = $('table-wrap'), handEl = $('hand'), barEl = $('action-bar');
const hintEl = $('table-hint'), toastEl = $('toast'), netEl = $('net-status');
const sideEl = $('side'), logEl = $('log');

// The round table's diameter is part of the shared game state (state.size,
// see core.js) — the host can grow the table for bigger groups — so the
// rendered size lives in these variables, kept in sync via setTableSize().
let TABLE_W = 1300, TABLE_H = 1300;
let PLAY_R = 540; // max distance of a card's center from the table center
let SEAT_R = 600; // radius where the seat name labels sit

function setTableSize(size) {
  TABLE_W = TABLE_H = size;
  PLAY_R = playR(size);
  SEAT_R = size / 2 - 50;
  tableEl.style.width = `${size}px`;
  tableEl.style.height = `${size}px`;
  layout();
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

// --- small helpers (the pure ones are in core.js) --------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

const safeColor = (v, fallback = '#64748b') => (COLOR_RE.test(v) ? v : fallback);

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
//         state {seq, size, items, players, log, rules, decks, …} — see core.js
// decks:  {deckId: {name, back: dataURL|null, cards: [{img} | {r,s,c}]}} — the
//         renderer's deck map; on the host it IS T.state.decks (refreshView)
// view:   what render() consumes — on guests this arrives from the host; its
//         items are the PUBLIC shape (publicItems: piles {…, n, top}, no hidden ids).
let role = null, roomId, password, room = null;
let sendAct, sendState, sendDecks, sendLog, sendNote, sendRules;
let decks = {};
let T = null;
let view = { seq: 0, items: {}, players: {} };
let myHand = [];
let gameLog = []; // the shared activity/chat feed (authoritative copy lives in T.state.log)
let peerPid = {};    // host only: Trystero peerId -> stable player id
let hostPeer = null; // guest only: peerId currently acting as host

/** Applies player p's action to the table (host only), then carries out what it queued. */
function apply(p, a) {
  if (T.apply(p, a)) changed();
  else drain();
}

/** The table changed (core renumbered it): carry out its effects, re-render,
 *  sync, save. (host only) */
function changed() {
  drain();
  if (T.state.size !== TABLE_W) setTableSize(T.state.size);
  refreshView();
  renderAll();
  scheduleBroadcast();
  persist();
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

// --- rules engine (see ENGINE.md; it runs in core.js) -------------------------
let rulesCodeDirty = false; // code changed -> resend on next broadcast
let guestRules = { code: '', name: '' }; // guests: the script text, for reading

// Fire due script timers (t.schedule; core.js runTimers()).
setInterval(() => { if (role === 'host' && T.runTimers()) changed(); }, 700);

// --- host <-> guest sync --------------------------------------------------
let dirtyDecks = new Set(), logDirty = false, bcastT = 0; // deck ids not yet broadcast
let hostBoot = 0;  // when this tab became host: the state's epoch (see handleState)
let fxQueue = [];  // action markers accumulated since the last broadcast
let annQueue = []; // script announcements (banners) since the last broadcast

/** Carries out, in order, what the last table calls queued (core.js T.drain()):
 *  action bulbs and banners (shown here too — the host is a viewer as well —
 *  and kept for the next broadcast), private notices and peek answers, the
 *  host's own toasts, and what the next broadcast must carry. (host only) */
function drain() {
  for (const e of T.drain()) {
    switch (e.t) {
      case 'fx': fxQueue.push(e.f); if (e.f.p !== pid) showFx(e.f); break; // own actions stay silent
      case 'ann': annQueue.push(e.msg); showAnnounce(e.msg); break;
      case 'note': if (e.p === pid) note(e.msg); else noteTo(e.p, { msg: e.msg.slice(0, 200) }); break;
      case 'peek': if (e.p === pid) showPeek(e.c); else noteTo(e.p, { peek: e.c }); break;
      case 'toast': toast(e.msg); break;
      case 'log': logDirty = true; break;
      case 'deck': dirtyDecks.add(e.id); break;
      case 'rules': rulesCodeDirty = true; break;
      default: console.error('unknown table effect', e);
    }
  }
}
/** Host: sends a private note (a notice, a peek answer) to each of player p's connections. */
function noteTo(p, body) {
  for (const [peer, mapped] of Object.entries(peerPid)) {
    if (mapped === p) sendNote({ ...body, to: p }, peer).catch((e) => console.error('note failed', e));
  }
}

function refreshView() {
  if (role !== 'host') return;
  const host = T.state;
  view = {
    seq: host.seq, items: T.publicItems(), players: T.publicPlayers(),
    rules: host.rules ? { name: host.rules.name, enabled: host.rules.enabled, public: host.rules.public } : null,
  };
  myHand = host.players[pid]?.hand || [];
  gameLog = host.log;
  decks = host.decks; // the renderer's deck map is the table's own (core may replace it)
}

function scheduleBroadcast() {
  if (bcastT) return;
  bcastT = setTimeout(() => { bcastT = 0; broadcast(); }, 40);
}

function broadcast() {
  if (role !== 'host' || !room) return;
  const host = T.state;
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
  const pub = { seq: host.seq, boot: hostBoot, host: pid, size: host.size, rules, items: T.publicItems(), players: T.publicPlayers(), fx: fxQueue, ann: annQueue };
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
    if (s.seq > T.state.seq || (s.seq === T.state.seq && peer < selfId)) {
      console.warn('another host is active — demoting to guest');
      toast('This table is open in another tab — this one is now a viewer');
      role = 'guest';
      T = null;
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
      : own(T.state.players, p)?.key && T.state.players[p].key !== key ? 'That seat belongs to another player'
      : '';
    if (reason) { refuse(peer, reason); return; }
    if (!T.mayAct(p)) { refuse(peer, 'Too many actions — slow down'); return; }
    // Register/refresh the sender on EVERY action, not just hello — if the
    // keyed hello was lost, the first real action still registers the player
    // (and binds the seat key; onJoin runs if they are new or back).
    const newConn = peerPid[peer] !== p;
    peerPid[peer] = p;
    const { known } = T.join(p, name, key);
    if (newConn) {
      // Fresh connection: hand over the (possibly large) deck images, the
      // log, and the rules code targeted, so regular broadcasts stay light.
      const host = T.state;
      sendDecks(decks, peer).catch((e) => console.error('decks send failed', e));
      sendLog(host.log, peer).catch((e) => console.error('log send failed', e));
      if (host.rules) sendRules({ code: host.rules.code, name: host.rules.name }, peer).catch((e) => console.error('rules send failed', e));
    }
    // Every action carries the sender's current name: a rename the host
    // never received (made while it was away, or in another room) syncs on
    // the next connection, through the logged (and rate-limited) rename path.
    const nm = cleanName(name ?? '');
    if (known && nm && nm !== known.name && newConn && action.t !== 'name') apply(p, { t: 'name', name: nm });
    apply(p, action); // apply() schedules a broadcast (which catches joiners up) and drains join()'s effects
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
    if (p && !Object.values(peerPid).includes(p) && T.leave(p)) changed();
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
  const saveJson = JSON.stringify({ ts: Date.now(), state: T.snapshot() });
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
  if (CLI) cliMsgs.push(`peek: ${cardName(decks, c.d, c.i)}`);
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
  ({ x: drag.x, y: drag.y } = clampToFelt(p.x - drag.dx, p.y - drag.dy, TABLE_W));
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

// --- rules dialog & game picker (🎲, host only; templates.js) ---------------
let askGame = false; // a brand-new table: invite the host to pick a game (the strip)

/** The picker entry matching what the host is running now. */
const currentGame = () => (!T?.state.rules?.enabled ? 'free'
  : GAMES.find((g) => RULES_TEMPLATES[g.k] === T.state.rules.code)?.k || 'custom');

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
    T = createTable({ ...saved.state, decks: saved.decks }, { pid });
    T.resume(myName); // re-sanitizes the decks, reloads the rules, everyone else waits offline
    setTableSize(T.state.size);
    $('size-sel').value = String(T.state.size);
  } else {
    T = createTable({}, { pid });
    askGame = true;
    T.open(myName); // the host's seat and a standard deck
  }
  drain();
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
  return { name: cardName(decks, d, i), ...(c?.txt ? { text: c.txt } : {}), ...(c?.meta !== undefined ? { meta: c.meta } : {}) };
}

function cliSnapshot() {
  const rules = role === 'host' ? T?.state.rules : view.rules;
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
  if (c.x != null && c.y != null) return clampToFelt(+c.x, +c.y, TABLE_W);
  const seat = ((view.players[pid]?.seat ?? 90) * Math.PI) / 180;
  const r = PLAY_R * (0.5 + Math.random() * 0.25);
  return clampToFelt(TABLE_W / 2 + r * Math.cos(seat) - CARD_W / 2, TABLE_H / 2 + r * Math.sin(seat) - CARD_H / 2, TABLE_W);
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
      case 'move': { const at = clampToFelt(+c.x || 0, +c.y || 0, TABLE_W); act({ t: 'move', id: cliItem(c.id), x: at.x, y: at.y }); break; }
      case 'rot': act({ t: 'rot', id: cliItem(c.id), rot: +c.deg || 0 }); break;
      case 'toHand': act({ t: 'toHand', id: cliItem(c.id) }); break;
      case 'peek': { // a face-up card is public; anything else is answered privately by the host (showPeek)
        const id = cliItem(c.id), it = view.items[id];
        if (it.k === 'c' && it.up) cliMsgs.push(`peek: ${cardName(decks, it.d, it.i)}`);
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
