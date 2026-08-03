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
function toast(msg) {
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

// Stable player identity across reloads (a Trystero peerId changes per page load).
const pid = localStorage.getItem('ct-pid') || rand(8);
localStorage.setItem('ct-pid', pid);
let myName = localStorage.getItem('ct-name') || `Player-${pid.slice(0, 4)}`;

// --- game state -----------------------------------------------------------
// decks:  {deckId: {name, back: dataURL|null, cards: [{img} | {r,s,c}]}}
// items:  {itemId: card {k:'c',x,y,rot,z,d,i,up} | pile {k:'p',x,y,rot,z,name,cards:[{d,i,up}]}}
// host:   authoritative state (host only): {seq, items, players:{pid:{name,color,online,hand:[{d,i}]}}}
// view:   what render() consumes — on guests this arrives from the host.
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
  const pl = host.players[p] || (host.players[p] = {
    name: '', color: COLORS[Object.keys(host.players).length % COLORS.length], online: true, hand: [],
  });
  pl.seat ??= assignSeat();
  pl.online = true;
  // Only fill an empty name here — explicit renames go through the 'name'
  // action so they land in the log.
  if (name && !pl.name) pl.name = String(name).slice(0, 24);
}

// --- activity log (host-authored, broadcast to everyone) -------------------
/** Human name for a card that is public knowledge; never call for hidden cards. */
function cardName(d, i) {
  const deck = decks[d], c = deck?.cards[i];
  if (!c) return 'a card';
  if (c.img) return `${deck.name} #${i + 1}`;
  if (c.r === 'JOKER') return 'Joker 🃏';
  return c.r + c.s;
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

/** Appends to the shared log. Consecutive duplicates (drag/rotate spam) collapse. */
function logEvent(p, txt, chat) {
  const last = host.log.at(-1);
  if (!chat && last && last.p === p && last.txt === txt) return;
  host.log.push({ p, txt, ts: Date.now(), ...(chat ? { c: 1 } : {}) });
  if (host.log.length > 200) host.log.splice(0, host.log.length - 200);
  logDirty = true;
}
function dropIfEmpty(pileId) {
  if (host.items[pileId]?.cards.length === 0) delete host.items[pileId];
}
// Resolve a hand index robustly: guests send both the index and the card they
// see there; if the hand changed in flight, fall back to the first match.
function handIdx(pl, a) {
  if (pl.hand[a.idx]?.d === a.d && pl.hand[a.idx]?.i === a.i) return a.idx;
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
  const pile = host.items[pileId];
  const c = pile?.k === 'p' && pile.cards.pop();
  if (!c) { console.warn('opDealTop: no card to deal', pileId); return false; }
  if (o.to) {
    const pl = host.players[o.to];
    if (!pl) { pile.cards.push(c); console.warn('opDealTop: unknown player', o.to); return false; }
    pl.hand.push({ d: c.d, i: c.i });
    logEvent(actor, `dealt a card from ${itemLabel(pile)} to ${pl.name || 'a player'}`);
  } else {
    const at = clampToFelt(o.x ?? pile.x + CARD_W + 18, o.y ?? pile.y);
    const nid = uid();
    host.items[nid] = { k: 'c', x: at.x, y: at.y, rot: ((o.rot || 0) % 360 + 360) % 360, z: zTop(), d: c.d, i: c.i, up: !!o.up };
    logEvent(actor, `dealt ${o.up ? cardName(c.d, c.i) : 'a card face down'} from ${itemLabel(pile)}`);
    mark(actor, nid);
  }
  mark(actor, pileId);
  dropIfEmpty(pileId);
  return true;
}

function opShuffle(actor, pileId) {
  const pile = host.items[pileId];
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
  const it = host.items[id];
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
  const it = host.items[cardId], pile = host.items[pileId];
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

/** Moves every card of a player's hand onto a pile, face down. */
function opTakeHand(actor, p, pileId) {
  const pl = host.players[p], pile = host.items[pileId];
  if (!pl || pile?.k !== 'p') return false;
  if (pl.hand.length) {
    logEvent(actor, `returned ${pl.name || 'a player'}'s hand (${pl.hand.length}) to ${itemLabel(pile)}`);
    mark(actor, pileId);
    for (const c of pl.hand.splice(0)) pile.cards.push({ d: c.d, i: c.i, up: false });
  }
  return true;
}

/** Applies one action from player `p` to the authoritative state (host only). */
function apply(p, a) {
  const items = host.items, pl = host.players[p];
  const it = a.id != null ? items[a.id] : null;
  // Rules veto: an enabled script may block gameplay actions with a reason.
  if (RULED_ACTIONS.has(a.t) && host.rules?.enabled) {
    const reason = runHook('validate', { ...a, p });
    if (typeof reason === 'string' && reason) {
      logEvent(RULES, `blocked ${pl?.name || 'a player'}: ${reason}`);
      notify(p, `🚫 ${reason}`);
      bump(); // the fresh broadcast reverts the actor's optimistic UI
      return;
    }
  }
  switch (a.t) {
    case 'hello': break; // registration + join logging happen in the action handler
    case 'name':
      if (pl && a.name) { pl.name = String(a.name).slice(0, 24); logEvent(p, `is now known as "${pl.name}"`); }
      break;
    case 'addDeck': {
      decks[a.deckId] = a.deck;
      dirtyDecks.add(a.deckId);
      const nid = uid();
      items[nid] = {
        k: 'p', x: a.x, y: a.y, rot: 0, z: zTop(), name: a.deck.name,
        cards: a.deck.cards.map((_, i) => ({ d: a.deckId, i, up: false })),
      };
      logEvent(p, `added deck "${a.deck.name}" (${a.deck.cards.length} cards)`);
      mark(p, nid);
      break;
    }
    case 'move':
      if (it) {
        ({ x: it.x, y: it.y } = clampToFelt(a.x, a.y));
        it.z = zTop();
        logEvent(p, `moved ${itemLabel(it)}`);
        mark(p, a.id);
      }
      break;
    case 'rot': if (it) { it.rot = ((a.rot % 360) + 360) % 360; logEvent(p, `rotated ${itemLabel(it)}`); mark(p, a.id); } break;
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
    case 'deal': if (it?.k === 'p') opDealTop(p, a.id, { x: a.x, y: a.y, up: a.up, rot: a.rot }); break;
    case 'play': {
      const idx = pl && handIdx(pl, a);
      if (pl && idx >= 0) {
        const c = pl.hand.splice(idx, 1)[0];
        const nid = uid(), at = clampToFelt(a.x, a.y);
        items[nid] = { k: 'c', x: at.x, y: at.y, rot: ((a.rot || 0) % 360 + 360) % 360, z: zTop(), d: c.d, i: c.i, up: a.up };
        logEvent(p, `played ${a.up ? cardName(c.d, c.i) : 'a card face down'} from hand`);
        mark(p, nid);
      }
      break;
    }
    case 'handPile': {
      const idx = pl && handIdx(pl, a);
      const pile = items[a.pile];
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
    case 'stack': {
      const b = items[a.onto];
      if (it?.k === 'c' && b?.k === 'c') {
        logEvent(p, `stacked ${itemLabel(it)} onto ${itemLabel(b)}`);
        const nid = uid();
        items[nid] = { k: 'p', x: b.x, y: b.y, rot: b.rot, z: zTop(), name: '', cards: [{ d: b.d, i: b.i, up: b.up }, { d: it.d, i: it.i, up: it.up }] };
        delete items[a.id];
        delete items[a.onto];
        mark(p, nid);
      }
      break;
    }
    case 'merge': {
      const to = items[a.pile];
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
    // only, but the fact of peeking goes on the record for everyone.
    case 'peek':
      if (it?.k === 'c' && !it.up) { logEvent(p, 'peeked at a face-down card'); mark(p, a.id); }
      else if (it?.k === 'p' && it.cards.length) { logEvent(p, `peeked at the top card of ${itemLabel(it)}`); mark(p, a.id); }
      break;
    case 'size': {
      // Host-only: the size selector is only shown to the host, and the host
      // applies its own actions, so p must be the host's own player id.
      const size = TABLE_SIZES[a.size] && a.size;
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
    case 'chat': if (pl && a.msg) logEvent(p, String(a.msg).slice(0, 300), true); break;
    case 'setRules': {
      if (p !== pid) break; // only the host configures rules
      if (a.enabled) {
        try {
          const s = evalRules(a.code);
          if (!s || typeof s !== 'object') throw new Error('script must evaluate to an ({...}) object');
          script = s;
          host.rules = { code: a.code, name: String(s.name || 'Rules').slice(0, 40), enabled: true, data: {}, public: {} };
          rulesCodeDirty = true;
          lastRulesError = '';
          logEvent(RULES, `«${host.rules.name}» enabled by ${pl?.name || 'the host'}`);
          runHook('setup');
          refreshButtons();
        } catch (err) {
          console.error('rules script failed to load', err);
          lastRulesError = err.message;
          toast(`Rules error: ${err.message}`);
          script = null;
          if (host.rules) host.rules.enabled = false;
        }
      } else if (host.rules?.enabled) {
        host.rules.enabled = false;
        rulesCodeDirty = true;
        logEvent(RULES, `rules disabled by ${pl?.name || 'the host'}`);
      }
      break;
    }
    case 'rulesBtn': if (host.rules?.enabled) runHook('onButton', String(a.id), p); break;
    default: console.warn('unknown action', a);
  }
  if (host.rules?.enabled && (RULED_ACTIONS.has(a.t) || a.t === 'chat' || a.t === 'rulesBtn')) {
    runHook('onAction', { ...a, p });
    refreshButtons();
  }
  bump();
}

/** Routes a local UI action: hosts apply directly, guests send to the room.
 *  Every guest action carries the sender's stable player id + name, so the
 *  host can (re)register a player even if the initial hello got lost.
 *  Actions go targeted to the host once we know who it is — only the host
 *  adjudicates, so shipping them (incl. multi-MB addDeck payloads) to every
 *  guest is pure waste. Until the first state reveals the host, broadcast. */
function act(a) {
  if (role === 'host') { apply(pid, a); return; }
  const target = hostPeer && room?.getPeers()[hostPeer] ? hostPeer : undefined;
  sendAct({ ...a, _pid: pid, _name: myName }, target)
    .catch((err) => { console.error('send failed', err); toast('Failed to reach the room'); });
}

// --- rules engine (see ENGINE.md) ------------------------------------------
// Host-only execution of a host-written script that can veto actions
// (validate) and drive automations (setup/onAction/onButton/onJoin/onLeave/
// onTimer) through the same audited ops as human actions. The engine knows
// no game concepts — all game semantics live in the script.
const RULES = 'RULES'; // synthetic actor id for script-performed ops
const RULED_ACTIONS = new Set(['move', 'rot', 'flip', 'shuffle', 'draw', 'deal', 'play', 'handPile', 'toHand', 'toPile', 'stack', 'merge', 'del', 'addDeck']);
let script = null;          // evaluated script object (host only)
let lastRulesError = '';    // shown in the rules dialog
let rulesCodeDirty = false; // code changed -> resend on next broadcast
let guestRules = { code: '', name: '' }; // guests: the script text, for reading

function evalRules(code) {
  return new Function(`"use strict"; return (${code});`)();
}

/** Runs one script hook; any throw disables the rules loudly. */
function runHook(name, ...args) {
  if (role !== 'host' || !host.rules?.enabled || typeof script?.[name] !== 'function') return undefined;
  try {
    return script[name](tApi, ...args);
  } catch (err) {
    console.error(`rules hook ${name}() failed`, err);
    lastRulesError = `${name}(): ${err.message}`;
    host.rules.enabled = false;
    rulesCodeDirty = true;
    logEvent(RULES, `rules disabled — script error in ${name}()`);
    toast(`Rules disabled — error in ${name}(): ${err.message}`);
    return undefined;
  }
}

/** Sends a private text notice to a player (toast on their screen). */
function notify(p, msg) {
  if (p === pid) { toast(msg); return; }
  for (const [peer, mapped] of Object.entries(peerPid)) {
    if (mapped === p) sendNote({ msg: String(msg).slice(0, 200) }, peer).catch((e) => console.error('note failed', e));
  }
}

/** Refreshes the script-declared button row into the broadcast public data. */
function refreshButtons() {
  if (role !== 'host' || !host.rules?.enabled || typeof script?.buttons !== 'function') return;
  try {
    const btns = script.buttons(tApi) || [];
    host.rules.public.buttons = btns.map((b) => ({ id: String(b.id), label: String(b.label).slice(0, 30), ...(b.pid ? { pid: b.pid } : {}) }));
  } catch (err) {
    console.error('rules buttons() failed', err);
    lastRulesError = `buttons(): ${err.message}`;
    host.rules.enabled = false;
    rulesCodeDirty = true;
    toast(`Rules disabled — error in buttons(): ${err.message}`);
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
    .map(([id, pl]) => ({ id, name: pl.name, seat: pl.seat, online: pl.online, handCount: pl.hand.length }))
    .sort((a, b) => a.seat - b.seat),
  hand: (p) => (host.players[p]?.hand || []).map((c) => ({ ...c })),
  items: () => Object.entries(host.items).map(([id, it]) => structuredClone({ id, ...it })),
  piles() { return this.items().filter((it) => it.k === 'p'); },
  deal: (pileId, o) => opDealTop(RULES, pileId, o),
  dealToAll(pileId, n = 1, o = {}) {
    for (let i = 0; i < n; i++) {
      for (const p of this.players()) {
        if (o.onlineOnly !== false && !host.players[p.id].online) continue;
        opDealTop(RULES, pileId, { ...o, to: p.id });
      }
    }
  },
  draw(p, pileId, n = 1) { for (let i = 0; i < n; i++) opDealTop(RULES, pileId, { to: p }); },
  takeHand: (p, pileId) => opTakeHand(RULES, p, pileId),
  playFromHand(p, idx, o = {}) {
    const pl = host.players[p];
    const c = pl?.hand.splice(idx, 1)[0];
    if (!c) return false;
    const at = clampToFelt(o.x ?? TABLE_W / 2 - CARD_W / 2, o.y ?? TABLE_H / 2 - CARD_H / 2);
    const nid = uid();
    host.items[nid] = { k: 'c', x: at.x, y: at.y, rot: ((o.rot || 0) % 360 + 360) % 360, z: zTop(), d: c.d, i: c.i, up: o.up !== false };
    logEvent(RULES, `played ${o.up !== false ? cardName(c.d, c.i) : 'a card face down'} from ${pl.name || 'a player'}'s hand`);
    mark(RULES, nid);
    return nid;
  },
  toHand(p, cardId) {
    const it = host.items[cardId], pl = host.players[p];
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
  newPile: (cards, o) => opNewPile(RULES, cards, o),
  move(id, x, y) {
    const it = host.items[id];
    if (!it) return false;
    ({ x: it.x, y: it.y } = clampToFelt(x, y));
    it.z = zTop();
    logEvent(RULES, `moved ${itemLabel(it)}`);
    mark(RULES, id);
    return true;
  },
  rot(id, deg) {
    const it = host.items[id];
    if (!it) return false;
    it.rot = ((deg % 360) + 360) % 360;
    mark(RULES, id);
    return true;
  },
  remove(id) {
    const it = host.items[id];
    if (!it) return false;
    logEvent(RULES, `removed ${itemLabel(it)}${it.k === 'p' ? ` (${it.cards.length} cards)` : ''}`);
    mark(RULES, id);
    delete host.items[id];
    return true;
  },
  addStandardDeck(o = {}) {
    const deck = standardDeck(!!o.jokers);
    const deckId = uid();
    decks[deckId] = deck;
    dirtyDecks.add(deckId);
    const nid = opNewPile(RULES, deck.cards.map((_, i) => ({ d: deckId, i, up: false })), { x: o.x, y: o.y, name: deck.name });
    host.items[nid].name = deck.name;
    return nid;
  },
  geom: () => ({ size: TABLE_W, cx: TABLE_W / 2, cy: TABLE_H / 2, r: PLAY_R }),
  say: (msg) => logEvent(RULES, String(msg).slice(0, 300)),
  tell: (p, msg) => notify(p, String(msg)),
  schedule(sec, tag) { (host.rules.data._timers ||= []).push({ at: Date.now() + sec * 1000, tag: String(tag) }); },
  nextSeat(p) {
    const ps = this.players().filter((x) => x.online || x.id === p);
    const i = ps.findIndex((x) => x.id === p);
    return ps.length ? ps[(i + 1) % ps.length].id : p;
  },
  cardName: (ref) => cardName(ref.d, ref.i),
};

// Fire due script timers (t.schedule). They live in rules.data, so they
// survive a host reload along with everything else.
setInterval(() => {
  if (role !== 'host' || !host?.rules?.enabled) return;
  const timers = host.rules.data._timers;
  if (!timers?.length) return;
  const due = timers.filter((x) => x.at <= Date.now());
  if (!due.length) return;
  host.rules.data._timers = timers.filter((x) => x.at > Date.now());
  for (const x of due) runHook('onTimer', x.tag);
  refreshButtons();
  bump();
}, 700);

// --- host <-> guest sync --------------------------------------------------
let dirtyDecks = new Set(), logDirty = false, bcastT = 0; // deck ids not yet broadcast
let fxQueue = []; // action markers accumulated since the last broadcast

function publicPlayers() {
  return Object.fromEntries(Object.entries(host.players).map(([p, pl]) => [
    p, { name: pl.name, color: pl.color, online: pl.online, handCount: pl.hand.length, seat: pl.seat },
  ]));
}

function refreshView() {
  if (role !== 'host') return;
  view = {
    seq: host.seq, items: host.items, players: publicPlayers(),
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
  const pub = { seq: host.seq, size: host.size, rules, items: host.items, players: publicPlayers(), fx: fxQueue };
  fxQueue = [];
  for (const peer of Object.keys(room.getPeers())) {
    sendState({ ...pub, hand: host.players[peerPid[peer]]?.hand || [] }, peer)
      .catch((e) => console.error('state send failed', e));
  }
}

function handleState(s, peer) {
  if (role === 'host') {
    // Two live hosts (a stale resume, or the invite opened twice in the host's
    // browser). The fresher state wins; peerId breaks the tie deterministically.
    if (s.seq > host.seq || (s.seq === host.seq && peer < selfId)) {
      console.warn('another host is active — demoting to guest');
      toast('Another host is active — joined as guest');
      role = 'guest';
      host = null;
      $('size-sel').classList.add('hidden');
    } else { scheduleBroadcast(); return; }
  }
  if (s.seq < view.seq) return; // stale reordering
  hostPeer = peer;
  if (s.size && s.size !== TABLE_W) setTableSize(s.size);
  view = { seq: s.seq, items: s.items, players: s.players, rules: s.rules };
  myHand = s.hand || [];
  for (const f of s.fx || []) if (f.p !== pid) showFx(f);
  renderAll();
}

let helloTimer = 0;
function connect() {
  clearInterval(helloTimer);
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
  sendAct = (data) => actA.send(data, {});
  sendState = (data, target) => stateA.send(data, { target });
  sendDecks = (data, target) => decksA.send(data, target ? { target } : {});
  sendLog = (data, target) => logA.send(data, target ? { target } : {});
  sendNote = (data, target) => noteA.send(data, { target });
  sendRules = (data, target) => rulesA.send(data, target ? { target } : {});
  noteA.onMessage = (n) => { if (role !== 'host' && n?.msg) toast(String(n.msg)); };
  rulesA.onMessage = (r) => { if (role !== 'host') { guestRules = { code: String(r.code || ''), name: String(r.name || '') }; } };

  actA.onMessage = (a, { peerId: peer }) => {
    if (role !== 'host') return; // actions are broadcast; only the host adjudicates
    if (!a?._pid) { console.warn('action without player id ignored', a); return; }
    // Register/refresh the sender on EVERY action, not just hello — if the
    // hello was lost, the first real action still registers the player.
    const newConn = peerPid[peer] !== a._pid;
    const known = host.players[a._pid];
    peerPid[peer] = a._pid;
    ensurePlayer(a._pid, a._name);
    if (!known?.online) logEvent(a._pid, known ? 'is back at the table' : 'joined the table');
    if (newConn) {
      // Fresh connection: hand over the (possibly large) deck images, the
      // log, and the rules code targeted, so regular broadcasts stay light.
      sendDecks(decks, peer).catch((e) => console.error('decks send failed', e));
      sendLog(host.log, peer).catch((e) => console.error('log send failed', e));
      if (host.rules) sendRules({ code: host.rules.code, name: host.rules.name }, peer).catch((e) => console.error('rules send failed', e));
    }
    if (!known?.online && host.rules?.enabled) { runHook('onJoin', a._pid); refreshButtons(); }
    apply(a._pid, a); // apply() schedules a broadcast, which catches joiners up
  };
  stateA.onMessage = (s, { peerId: peer }) => handleState(s, peer);
  // Deck messages are deltas (or the full map for new joiners) — always merge.
  decksA.onMessage = (d) => { if (role !== 'host') { Object.assign(decks, d); renderAll(); } };
  logA.onMessage = (l) => { if (role !== 'host') { gameLog = l; renderAll(); } };

  room.onPeerJoin = (peer) => {
    updateNet();
    if (role !== 'host') act({ t: 'hello' });
  };
  // Belt and braces: until the first state arrives, keep knocking — covers a
  // hello lost in the initial connection churn (the host drops actions from
  // peers it has never registered, so a lost hello used to mean a dead guest).
  helloTimer = setInterval(() => {
    if (role === 'guest' && view.seq === 0) act({ t: 'hello' });
    else clearInterval(helloTimer);
  }, 3000);
  room.onPeerLeave = (peer) => {
    updateNet();
    if (peer === hostPeer) hostPeer = null; // fall back to broadcast until a host reappears
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
    hintEl.classList.toggle('hidden', view.seq > 0);
    hintEl.textContent = 'Waiting for the host…\n(the table lives in the host\'s open tab)';
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
let persistT = 0, lastSave = 0, persistWarned = false;
function doSave() {
  lastSave = Date.now();
  try {
    localStorage.setItem(`ct-save-${roomId}`, JSON.stringify({ decks, state: host }));
  } catch (err) {
    console.error('failed to persist game', err);
    if (!persistWarned) { persistWarned = true; toast('Game too large to auto-save (host reload will lose it)'); }
  }
}
// Throttled (not debounced!) — a busy game must still hit storage regularly.
function persist() {
  if (role !== 'host' || persistT) return;
  persistT = setTimeout(() => { persistT = 0; doSave(); }, Math.max(0, 1000 - (Date.now() - lastSave)));
}
window.addEventListener('pagehide', () => {
  if (role === 'host') { clearTimeout(persistT); persistT = 0; doSave(); }
});
function loadSave() {
  try {
    const raw = localStorage.getItem(`ct-save-${roomId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { console.error('corrupt save discarded', err); return null; }
}

// --- rendering ------------------------------------------------------------
const itemEls = new Map();
let sel = null, drag = null, handDrag = null, facedown = false;
let scale = 1;

function faceHTML(d, i) {
  const deck = decks[d], c = deck?.cards[i];
  if (!c) return '<div class="face loading">🂠</div>'; // deck data not yet received
  if (c.img) return `<img class="face" src="${c.img}" alt="">`;
  if (c.r === 'JOKER') return `<div class="face std ${c.c}"><div class="corner">★</div><div class="mid joker">🃏</div><div class="corner br">★</div></div>`;
  return `<div class="face std ${c.c}"><div class="corner">${c.r}\n${c.s}</div><div class="mid"><div class="mr">${c.r}</div><div class="ms">${c.s}</div></div><div class="corner br">${c.r}\n${c.s}</div></div>`;
}
function backHTML(d) {
  const b = decks[d]?.back;
  return b ? `<img class="back" src="${b}" alt="">` : '<div class="back"></div>';
}

function contentFor(it) {
  if (it.k === 'c') return `<div class="cardbox">${it.up ? faceHTML(it.d, it.i) : backHTML(it.d)}</div>`;
  const top = it.cards.at(-1);
  const inner = top ? (top.up ? faceHTML(top.d, top.i) : backHTML(top.d)) : '';
  return `<div class="cardbox">${inner}</div><span class="count">${it.cards.length}</span>${it.name ? `<span class="pname">${esc(it.name)}</span>` : ''}`;
}

function renderItems() {
  const seen = new Set();
  for (const [id, it] of Object.entries(view.items)) {
    seen.add(id);
    let el = itemEls.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'item';
      el.dataset.id = id;
      tableEl.appendChild(el);
      itemEls.set(id, el);
    }
    const sig = it.k === 'c'
      ? `c|${it.d}|${it.i}|${it.up}|${!!decks[it.d]}`
      : `p|${it.cards.length}|${JSON.stringify(it.cards.at(-1))}|${it.name}|${!!decks[it.cards.at(-1)?.d]}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = contentFor(it);
      el.classList.toggle('pile', it.k === 'p');
      el.classList.toggle('multi', it.k === 'p' && it.cards.length > 1);
    }
    if (drag?.id !== id) { el.style.left = `${it.x}px`; el.style.top = `${it.y}px`; }
    el.style.transform = `rotate(${it.rot}deg)`;
    el.style.zIndex = it.z;
    el.classList.toggle('selected', sel === id);
  }
  for (const [id, el] of itemEls) if (!seen.has(id)) { el.remove(); itemEls.delete(id); }
  if (sel && !view.items[sel]) select(null);
  else if (sel) placeBar();
}

// Seat labels: everyone sees the same seating, each from their own rotation.
let seatSig = '';
function renderPlayers() {
  const turn = view.rules?.enabled ? view.rules.public?.turn : null;
  const sig = `${JSON.stringify(view.players)}|${turn}|${viewAngle.toFixed(1)}|${scale.toFixed(4)}|${panX | 0},${panY | 0}|${wrapEl.clientWidth}`;
  if (sig === seatSig) return;
  seatSig = sig;
  for (const el of wrapEl.querySelectorAll('.seat')) el.remove();
  for (const [p, pl] of Object.entries(view.players)) {
    if (pl.seat == null) continue;
    const rad = (pl.seat * Math.PI) / 180;
    const [sx, sy] = tableToScreen(TABLE_W / 2 + SEAT_R * Math.cos(rad), TABLE_H / 2 + SEAT_R * Math.sin(rad));
    const el = document.createElement('div');
    el.className = `seat${pl.online ? '' : ' offline'}${p === pid ? ' me' : ''}${p === turn ? ' turn' : ''}`;
    el.style.borderColor = pl.color;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    el.textContent = `${p === turn ? '⏳ ' : ''}${pl.name || 'Player'} 🂠${pl.handCount}`;
    wrapEl.appendChild(el);
  }
}

let handSig = '';
function renderHand() {
  const sig = JSON.stringify(myHand);
  if (sig === handSig) return;
  handSig = sig;
  handEl.innerHTML = '';
  myHand.forEach((c, idx) => {
    const el = document.createElement('div');
    el.className = 'hcard';
    el.dataset.idx = idx;
    el.innerHTML = faceHTML(c.d, c.i);
    handEl.appendChild(el);
  });
}

/** Display identity for a log/bulb actor (players or the Rules script). */
function actorInfo(p) {
  if (p === RULES) return { name: '📜 Rules', color: '#a78bfa' };
  const pl = view.players[p];
  return { name: pl?.name || 'Player', color: pl?.color || '#94a3b8' };
}

let logSig = '';
function renderLog() {
  const last = gameLog.at(-1);
  const sig = `${gameLog.length}|${last?.ts}|${last?.txt}`;
  if (sig === logSig) return;
  logSig = sig;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  logEl.innerHTML = gameLog.map((e) => {
    const who = actorInfo(e.p);
    const name = `<b style="color:${who.color}">${esc(who.name)}</b>`;
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

function renderAll() {
  applySeatView();
  renderItems();
  renderPlayers();
  renderHand();
  renderLog();
  renderRulesBtns();
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
  const yAbove = sy - half - 42;
  barEl.style.left = `${clamp(sx, 90, wrapEl.clientWidth - 90)}px`;
  barEl.style.top = `${yAbove >= 4 ? yAbove : sy + half + 8}px`;
}

// --- transient "who did that" bulbs ----------------------------------------
const bulbs = new Map(); // "pid|itemId" -> {el, timer}
function showFx(f) {
  const who = actorInfo(f.p);
  const it = f.id && view.items[f.id];
  const [sx, sy] = tableToScreen((it ? it.x : f.x) + CARD_W / 2, (it ? it.y : f.y) + CARD_H / 2);
  const key = `${f.p}|${f.id}`;
  let b = bulbs.get(key);
  if (!b) {
    const el = document.createElement('div');
    el.className = 'fx-bulb';
    wrapEl.appendChild(el);
    b = { el, timer: 0 };
    bulbs.set(key, b);
  }
  b.el.textContent = who.name;
  b.el.style.borderColor = who.color;
  b.el.style.left = `${clamp(sx, 30, wrapEl.clientWidth - 30)}px`;
  b.el.style.top = `${Math.max(20, sy - CARD_H * 0.55 * scale)}px`;
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
    peek: () => {
      const c = it.k === 'c' ? it : it.cards.at(-1);
      if (!c) return;
      act({ t: 'peek', id: sel }); // announce it before enjoying it
      showZoom(c.d, c.i, 'Only you can see this — everyone knows you peeked. Click to close.');
    },
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

// --- dragging table items / pan / pinch -------------------------------------
let feltDrag = null; // dragging empty felt = panning MY view
let pinch = null;    // two-finger gesture: zoom + rotate + pan in one
const tPtrs = new Map(); // pointers currently down on the table

/** Ends an in-flight item drag cleanly (used when a pinch takes over). */
function cancelItemDrag() {
  if (!drag) return;
  const it = view.items[drag.id];
  drag.el.classList.remove('dragging');
  if (drag.moved && it) act({ t: 'move', id: drag.id, x: it.x, y: it.y });
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
  drag = { id: el.dataset.id, el, dx: p.x - it.x, dy: p.y - it.y, sx: p.x, sy: p.y, moved: false, last: 0 };
});

window.addEventListener('pointermove', (e) => {
  if (tPtrs.has(e.pointerId)) tPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) { if (tPtrs.size >= 2) updatePinch(); return; }
  if (handResize) {
    handH = clamp(handResize.h + (handResize.y - e.clientY), 80, 340);
    document.documentElement.style.setProperty('--hch', `${handH}px`);
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
  const it = view.items[drag.id];
  if (!it) { drag = null; return; }
  if (!drag.moved) {
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) < 5 / scale) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
    drag.el.style.zIndex = 100000; // visually on top; the host assigns the real z on move
    select(null);
  }
  ({ x: it.x, y: it.y } = clampToFelt(p.x - drag.dx, p.y - drag.dy));
  drag.el.style.left = `${it.x}px`;
  drag.el.style.top = `${it.y}px`;
  // Throttled live position for the other players; the final one is sent on drop.
  if (role === 'guest' && e.timeStamp - drag.last > 60) {
    drag.last = e.timeStamp;
    act({ t: 'move', id: drag.id, x: it.x, y: it.y });
  }
});

window.addEventListener('pointercancel', (e) => {
  tPtrs.delete(e.pointerId);
  if (tPtrs.size < 2) pinch = null;
  handResize = null;
  feltDrag = null;
  if (handDrag?.moved) { ghost?.remove(); ghost = null; }
  handDrag = null;
  cancelItemDrag();
});

window.addEventListener('pointerup', (e) => {
  tPtrs.delete(e.pointerId);
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
  else act({ t: 'move', id: d.id, x: it.x, y: it.y });
});

tableEl.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.item');
  const it = el && view.items[el.dataset.id];
  if (!it) return;
  act(it.k === 'c' ? { t: 'flip', id: el.dataset.id } : { t: 'draw', id: el.dataset.id });
});

// --- dragging out of the hand (a plain click zooms the card instead) -------
let ghost = null;
handEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.hcard');
  if (!el || e.button !== 0) return;
  e.preventDefault();
  const idx = +el.dataset.idx;
  if (!myHand[idx]) return;
  handDrag = { idx, card: myHand[idx], sx: e.clientX, sy: e.clientY, moved: false };
});

function moveGhost(e) {
  if (!handDrag.moved) {
    if (Math.hypot(e.clientX - handDrag.sx, e.clientY - handDrag.sy) < 6) return;
    handDrag.moved = true;
    ghost = document.createElement('div');
    ghost.id = 'ghost';
    ghost.innerHTML = facedown ? backHTML(handDrag.card.d) : faceHTML(handDrag.card.d, handDrag.card.i);
    document.body.appendChild(ghost);
  }
  ghost.style.left = `${e.clientX - handH * 5 / 14}px`; // center: half of hch*5/7 width
  ghost.style.top = `${e.clientY - handH / 2}px`;
  $('hand-bar').classList.toggle('droppable', !!e.target.closest?.('#hand-bar'));
}

function dropGhost(e) {
  const { idx, card, moved } = handDrag;
  handDrag = null;
  if (!moved) { showZoom(card.d, card.i); return; } // click, not drag: enlarge
  ghost.remove();
  ghost = null;
  $('hand-bar').classList.remove('droppable');
  const under = document.elementFromPoint(e.clientX, e.clientY);
  if (under?.closest('#hand-bar')) return; // dropped back into the hand
  const overItem = under?.closest('.item');
  const tgt = overItem && view.items[overItem.dataset.id];
  if (tgt?.k === 'p') { act({ t: 'handPile', idx, d: card.d, i: card.i, pile: tgt.id }); return; }
  if (!under?.closest('#table')) return;
  const p = toTable(e);
  // rot: cards land upright from the player's (possibly rotated) point of view
  act({ t: 'play', idx, d: card.d, i: card.i, x: p.x - CARD_W / 2, y: p.y - CARD_H / 2, up: !facedown, rot: uprightRot() });
}

$('facedown-toggle').addEventListener('click', () => {
  facedown = !facedown;
  $('facedown-toggle').classList.toggle('on', facedown);
});

// --- resizable hand tray ---------------------------------------------------
let handH = clamp(parseInt(localStorage.getItem('ct-handh'), 10) || 120, 80, 340);
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
  localStorage.setItem('ct-name', myName);
  act({ t: 'name', name: myName });
});

$('invite-btn').addEventListener('click', async () => {
  const link = location.href;
  try {
    await navigator.clipboard.writeText(link);
    toastEl.style.background = '#059669';
    toast('Invite link copied — send it to your friends');
    setTimeout(() => { toastEl.style.background = ''; }, 5000);
  } catch (err) {
    console.error('clipboard unavailable', err);
    window.prompt('Share this invite link:', link);
  }
});

$('qr-btn').addEventListener('click', async () => {
  try {
    // Lazy-loaded: the QR library is only fetched when someone actually asks for a code.
    const { toCanvas } = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
    await toCanvas($('qr-canvas'), location.href, { width: 320, margin: 2 });
    $('qr-link').textContent = location.href;
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
    t.data.turn = ps[0]?.id;
    t.public.turn = t.data.turn;
    t.say('Turn order: ' + ps.map((p) => p.name).join(' → '));
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
  name: "Hold'em dealer",
  setup(t) { t.say("Hold'em dealer ready — use the buttons under the table."); },
  buttons: () => [
    { id: 'new', label: '🂠 New hand' },
    { id: 'flop', label: 'Flop' },
    { id: 'turn', label: 'Turn' },
    { id: 'river', label: 'River' },
  ],
  deck(t) { // the biggest pile on the table acts as the deck
    return t.piles().sort((a, b) => b.cards.length - a.cards.length)[0];
  },
  onButton(t, id) {
    const deck = this.deck(t);
    if (!deck) return t.say('No pile to deal from!');
    const g = t.geom();
    if (id === 'new') {
      for (const it of t.items()) if (it.k === 'c') t.toPile(it.id, deck.id);
      for (const p of t.players()) t.takeHand(p.id, deck.id);
      t.shuffle(deck.id);
      t.dealToAll(deck.id, 2);
      t.data.community = 0;
      t.say('New hand — 2 hole cards to everyone.');
    } else {
      // burns collect left of the community row; streets fill it left to right
      t.deal(deck.id, { x: g.cx - 480, y: g.cy - 220, up: false });
      const n = id === 'flop' ? 3 : 1;
      for (let i = 0; i < n; i++) {
        t.deal(deck.id, { x: g.cx - 330 + (t.data.community || 0) * 115, y: g.cy - 220, up: true });
        t.data.community = (t.data.community || 0) + 1;
      }
    }
  },
})`,
  bridge: `({
  name: 'Bridge (play phase)',
  // Bidding happens in CHAT. Then "!contract 4H Alice" (level optional,
  // strain S/H/D/C/NT) starts play: left of declarer leads. On the opening
  // lead the dummy's whole hand is laid FACE UP by the dummy's seat, and
  // the DECLARER plays it by sliding a dummy card to the middle of the
  // table. Turns and following suit are enforced (for the dummy too), each
  // trick is decided trump-aware and swept to the winning side, and the
  // score is kept. No dealing or new decks until the hand is over.
  setup(t) {
    t.say(t.players().length === 4
      ? 'Bridge: press Deal, bid in chat, then "!contract 4H <name>".'
      : 'Bridge needs exactly 4 players (' + t.players().length + ' seated).');
  },
  buttons: (t) => (t.data.phase === 'play' ? [] : [{ id: 'deal', label: '🂠 Deal (13 each)' }]),
  deck(t) { return t.piles().sort((a, b) => b.cards.length - a.cards.length)[0]; },
  suitOf(t, c) { return t.cardName(c).slice(-1); },
  rankOf(t, c) {
    const r = t.cardName(c).slice(0, -1);
    return { A: 14, K: 13, Q: 12, J: 11 }[r] || parseInt(r, 10) || 0;
  },
  seats(t) { return t.players().map((p) => p.id); },
  sideName(t, s) { const ps = t.players(); return ps[s].name + '–' + ps[s + 2].name; },
  inCenter(t, x, y) { const g = t.geom(); return Math.hypot(x + 50 - g.cx, y + 70 - g.cy) < g.r * 0.4; },
  dummyRef(t, id) {
    const it = t.items().find((x) => x.id === id);
    return it && it.k === 'c' && (t.data.dummyCards || []).find((c) => c.d === it.d && c.i === it.i);
  },
  onButton(t, id) {
    if (id !== 'deal') return;
    if (t.data.phase === 'play') return t.say('Finish the hand first.');
    const ps = t.players();
    if (ps.length !== 4) return t.say('Bridge needs exactly 4 players.');
    const deck = this.deck(t);
    if (!deck) return t.say('No deck on the table!');
    for (const it of t.items()) if (it.k === 'c') t.toPile(it.id, deck.id);
    for (const p of ps) t.takeHand(p.id, deck.id);
    t.shuffle(deck.id);
    t.dealToAll(deck.id, 13);
    Object.assign(t.data, { phase: 'bid', trump: null, level: null, declarer: null, dummy: null, trick: [], tricks: [0, 0], sidePiles: {}, firstLead: false, dummyCards: [] });
    t.public.turn = null;
    t.say('Dealt 13 to each (' + this.sideName(t, 0) + ' vs ' + this.sideName(t, 1) + '). Bid in chat, then "!contract 4H <name>".');
  },
  onChat(t, a) {
    const m = /^!contract\\s*(\\d)?\\s*(NT|[SHDC])\\s+(.+)$/i.exec(a.msg || '');
    if (!m) return;
    const ps = t.players();
    const decl = ps.find((p) => p.name.toLowerCase().startsWith(m[3].trim().toLowerCase()));
    if (!decl) return t.say('No player named "' + m[3].trim() + '"');
    t.data.level = m[1] ? +m[1] : null;
    t.data.trump = { S: '♠', H: '♥', D: '♦', C: '♣' }[m[2].toUpperCase()] || null;
    t.data.declarer = decl.id;
    t.data.dummy = ps[(ps.indexOf(decl) + 2) % 4].id;
    t.data.phase = 'play';
    t.data.firstLead = true;
    t.data.trick = [];
    t.data.turn = t.nextSeat(decl.id);
    t.public.turn = t.data.turn;
    const leader = ps.find((p) => p.id === t.data.turn);
    t.say('Contract: ' + (m[1] || '') + m[2].toUpperCase() + ' by ' + decl.name + '. ' + leader.name + ' leads.');
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
        return 'Bidding — cards stay in hand until "!contract 4H <name>"';
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
    if (a.p !== t.data.turn) return "It's not your turn";
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
      t.public.turn = null;
      t.schedule(2.5, 'sweep'); // let everyone look at the trick first
    } else {
      t.data.turn = t.nextSeat(card.p);
      t.public.turn = t.data.turn;
    }
  },
  onAction(t, a) {
    if (a.t === 'chat') return this.onChat(t, a);
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
    const ps = this.seats(t);
    const side = ps.indexOf(win.p) % 2;
    t.data.tricks[side]++;
    const winner = t.players().find((p) => p.id === win.p);
    // sweep the four cards into the winning side's face-down trick pile
    let pileId = t.data.sidePiles[side];
    if (!pileId || !t.items().some((it) => it.id === pileId)) {
      const g = t.geom(), rad = (winner.seat * Math.PI) / 180;
      pileId = t.newPile([], { x: g.cx + Math.cos(rad) * (g.r - 40) - 50, y: g.cy + Math.sin(rad) * (g.r - 40) - 70, name: this.sideName(t, side) + ' tricks' });
      t.data.sidePiles[side] = pileId;
    }
    for (const it of t.items()) {
      if (it.k === 'c' && trick.some((c) => c.d === it.d && c.i === it.i)) t.toPile(it.id, pileId);
    }
    t.data.trick = [];
    t.say('Trick to ' + winner.name + ' — ' + this.sideName(t, 0) + ' ' + t.data.tricks[0] + ' : ' + t.data.tricks[1] + ' ' + this.sideName(t, 1));
    if (t.data.tricks[0] + t.data.tricks[1] === 13) {
      const made = t.data.tricks[ps.indexOf(t.data.declarer) % 2];
      let msg = 'Hand over — declarer side took ' + made + ' tricks';
      if (t.data.level) msg += made >= 6 + t.data.level ? ' — contract MADE' : ' — DOWN ' + (6 + t.data.level - made);
      t.say(msg);
      t.data.phase = 'done';
      t.public.turn = null;
    } else {
      t.data.turn = win.p;
      t.public.turn = win.p;
    }
  },
})`,
  dealer: `({
  name: 'Simple dealer',
  buttons: () => [{ id: 'deal1', label: 'Deal 1 to all' }],
  onButton(t, id) {
    const deck = t.piles().sort((a, b) => b.cards.length - a.cards.length)[0];
    if (deck) t.dealToAll(deck.id, 1);
  },
})`,
};

function updateRulesDialog() {
  const isHost = role === 'host';
  const meta = isHost ? host?.rules : view.rules;
  $('rules-status').textContent = meta?.enabled ? `active: ${meta.name}` : 'inactive';
  $('rules-tpl').classList.toggle('hidden', !isHost);
  $('rules-enable').classList.toggle('hidden', !isHost);
  $('rules-disable').classList.toggle('hidden', !isHost || !meta?.enabled);
  $('rules-code').readOnly = !isHost;
  $('rules-err').textContent = lastRulesError;
}

$('rules-btn').addEventListener('click', () => {
  const ta = $('rules-code');
  if (role === 'host') {
    if (!ta.value.trim()) ta.value = host?.rules?.code || RULES_TEMPLATES.blank;
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
  act({ t: 'setRules', code: $('rules-code').value, enabled: true });
  if (host?.rules?.enabled) $('rules-dialog').close();
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

$('deck-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'add') return;
  e.preventDefault();
  const kind = document.querySelector('input[name="deck-kind"]:checked').value;
  const name = $('deck-name').value.trim();
  try {
    let deck;
    if (kind === 'std') {
      deck = standardDeck($('deck-jokers').checked);
      if (name) deck.name = name;
    } else {
      const files = [...$('deck-files').files];
      if (!files.length) { toast('Pick at least one card image'); return; }
      const cards = [];
      for (const f of files) cards.push({ img: await fileToDataURL(f) });
      const backFile = $('deck-back').files[0];
      deck = { name: name || 'Deck', back: backFile ? await fileToDataURL(backFile) : null, cards };
    }
    act({ t: 'addDeck', deckId: uid(), deck, x: TABLE_W / 2 - CARD_W / 2, y: TABLE_H / 2 - CARD_H / 2 });
    $('deck-dialog').close();
    $('deck-form').reset();
  } catch (err) {
    console.error('failed to build deck', err);
    toast(`Failed to build deck: ${err.message}`);
  }
});

// --- boot -----------------------------------------------------------------
function becomeHost(saved) {
  role = 'host';
  $('size-sel').classList.remove('hidden'); // table size is the host's call
  if (saved) {
    decks = saved.decks;
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
  const m = location.hash.match(/^#room~([0-9a-f]+)~([0-9a-f]+)$/);
  let saved = null;
  if (m) {
    [, roomId, password] = m;
    saved = loadSave();
  } else {
    roomId = rand(8);
    password = rand(8);
    history.replaceState({}, '', `#room~${roomId}~${password}`);
  }
  if (!localStorage.getItem('ct-name')) await askName();
  if (!m || saved) becomeHost(saved);
  else role = 'guest';
  if (window.innerWidth <= 820) sideEl.classList.add('hidden');
  layout();
  renderAll();
  connect();
}
boot().catch((err) => { console.error('boot failed', err); toast(`Failed to start: ${err.message}`); });
