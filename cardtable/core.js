// Card Table — the state core: the table's state and every operation on it.
//
// No DOM, network, storage or timers here, so the page (app.js), a rules
// Worker and Node tests all run the same state code (TABLETOP.md §5, §7).
// It imports nothing and runs in a page, in a module Worker and in Node 22.
//
// The host owns one table: `const T = createTable(state, env)`.
//  • state is plain JSON — {seq, size, items, players, log, rules, decks,
//    guestDeckChars} — the host's authoritative copy, so it is called `host`
//    below. T mutates it in place; T.state is that same object, which the app
//    saves (T.snapshot(), decks apart) and redacts for broadcasts
//    (T.publicItems(), T.publicPlayers()).
//  • env injects what isn't pure: {pid (the host's own player id), now()
//    (Date.now), random() (crypto), hooks (the rules runner, see scriptHooks)}.
//  • Side effects become data: every call queues effects, in order, and the
//    app takes them with T.drain() after each call:
//      {t:'fx', f}         an action marker {p, id, x, y} (the name bulbs)
//      {t:'ann', msg}      a banner for every screen (t.announce)
//      {t:'note', p, msg}  a private notice for player p
//      {t:'peek', p, c}    a peeked card {d, i}, for player p's eyes only
//      {t:'toast', msg}    a notice for the host's own screen (script errors)
//      {t:'log', e}        a new log entry
//      {t:'deck', id}      a new deck, to send to everyone
//      {t:'rules'}         the script or its on/off state changed: resend the code
//  • apply(), leave() and runTimers() return true when the table changed (it
//    was renumbered, state.seq): the app then re-renders, broadcasts and saves.

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
 *  via a crafted id like "__proto__" or "constructor". */
export const own = (obj, key) => (key != null && Object.hasOwn(obj, key) ? obj[key] : null);
/** A finite number from untrusted input, else the fallback. */
export const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const normRot = (v) => ((num(v) % 360) + 360) % 360;
/** A uniform float in [0, 1) from the crypto RNG (the default env.random). */
const cryptoRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

// --- data hygiene: decks pass one sanitizer (strict image data-URLs, strict
// color grammar, size caps) before anything renders them ---------------------
export const IMG_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
export const COLOR_RE = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i;
export const RANKS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'JOKER']);
export const SUITS = new Set(['♠', '♥', '♦', '♣', '🃏']);
export const MAX_DECK_BYTES = 24e6, MAX_DECK_CARDS = 5000;
export const GUEST_DECK_CHARS = 1.5e6; // all decks guests add to one table, together (see apply 'addDeck')
// Control characters (C0, DEL, C1) never reach a page or the terminal bridge:
// a peer's ESC sequences could clear or spoof a bridge user's terminal.
// CTRL_NL spares the newline, for multi-line card texts.
export const CTRL = /[\u0000-\u001f\u007f-\u009f]/g, CTRL_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
export const str = (v, n, strip = CTRL) => (typeof v === 'string' && v ? v.replace(strip, '').slice(0, n) : undefined);

/** The one gate every deck passes (uploads, scripts, saves, the wire): keeps
 *  only known fields of the right type, so nothing a peer sends can smuggle
 *  markup, script URLs or CSS into anyone's page. Throws on unusable decks. */
export function cleanDeck(d) {
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

/** Player names: plain text, bounded, and never dressed up as the 📜 Rules actor. */
export const cleanName = (s) => String(s).replace(CTRL, '').replace(/^[\s📜]+/u, '').trim().slice(0, 24);

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

/** The rules runner a table drives its hooks through (env.hooks). This one
 *  evaluates the script right here; the interface lets the rules run
 *  elsewhere (a Worker) without the table noticing:
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

// --- the table ---------------------------------------------------------------
// decks:  {deckId: {name, back: dataURL|null, cards: [{img} | {r,s,c}]}}
// items:  {itemId: card {k:'c',x,y,rot,z,d,i,up} | pile {k:'p',x,y,rot,z,name,cards:[{d,i,up}]}}
// players: {pid: {name, color, online, seat, key, hand:[{d,i}]}}
/** A table over `host` (its state, mutated in place) — see the top of this file. */
export function createTable(host, env = {}) {
  const pid = env.pid;
  const now = env.now || Date.now, random = env.random || cryptoRandom, hooks = env.hooks || scriptHooks();
  host.seq ??= 1;
  host.items ??= {};
  host.players ??= {};
  host.log ||= []; // saves from before the log existed
  host.size ||= 1300;
  host.decks ??= {};
  const { decks } = host;
  let effects = []; // queued for the app (T.drain)
  let marks = 0;    // action markers so far: apply()'s "it really happened" signal
  let lastRulesError = ''; // shown in the rules dialog
  const emit = (e) => { effects.push(e); };

  // --- item writes ---------------------------------------------------------
  // Every change to host.items goes through put / remove / touch: the one
  // place where delta sync (TABLETOP.md §3) will record what changed.
  /** Places item `it` under `id`; returns the id. */
  const put = (id, it) => { host.items[id] = it; return id; };
  /** Takes item `id` off the table. */
  const remove = (id) => { delete host.items[id]; };
  /** Item `id` changed in place (moved, turned, flipped, its pile changed). Nothing to record yet. */
  const touch = (id) => id;

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
   *  Three buckets are capped separately: talk (chat + renames, the entries
   *  carrying `c` or `n`) at 100, on-the-record entries (`loud`, stored as `k`:
   *  peeks) at 50, and every other action at 200 — so neither chatter nor a
   *  flood of cheap moves can push the record of a peek out of the log. */
  function logEvent(p, txt, chat, as, loud) {
    const last = host.log.at(-1);
    if (!chat && last && last.p === p && last.txt === txt) return;
    host.log.push({ p, txt, ts: now(), ...(chat ? { c: 1 } : {}), ...(as ? { n: as } : {}), ...(loud ? { k: 1 } : {}) });
    const kind = (e) => (e.c || 'n' in e ? 'talk' : e.k ? 'loud' : 'act'), mine = kind(host.log.at(-1));
    const same = host.log.filter((e) => kind(e) === mine);
    if (same.length > { talk: 100, loud: 50, act: 200 }[mine]) host.log.splice(host.log.indexOf(same[0]), 1);
    emit({ t: 'log', e: host.log.at(-1) });
  }
  function dropIfEmpty(pileId) {
    if (host.items[pileId]?.cards.length === 0) remove(pileId);
  }
  // Resolve a hand index robustly: guests send both the index and the card they
  // see there; if the hand changed in flight, fall back to the first match.
  function handIdx(pl, a) {
    if (Number.isInteger(a.idx) && pl.hand[a.idx]?.d === a.d && pl.hand[a.idx]?.i === a.i) return a.idx;
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
      logEvent(actor, `dealt a card from ${itemLabel(decks, pile)} to ${pl.name || 'a player'}`);
    } else {
      const at = clampToFelt(num(o.x, pile.x + CARD_W + 18), num(o.y, pile.y), host.size);
      nid = put(uid(), { k: 'c', x: at.x, y: at.y, rot: normRot(o.rot), z: zTop(), d: c.d, i: c.i, up: !!o.up });
      logEvent(actor, `dealt ${o.up ? cardName(decks, c.d, c.i) : 'a card face down'} from ${itemLabel(decks, pile)}`);
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
    logEvent(actor, `shuffled ${itemLabel(decks, pile)} (${pile.cards.length} cards)`);
    mark(actor, pileId);
    return true;
  }

  function opFlip(actor, id) {
    const it = own(host.items, id);
    if (!it) return false;
    if (it.k === 'c') {
      it.up = !it.up;
      logEvent(actor, `flipped ${cardName(decks, it.d, it.i)} face ${it.up ? 'up' : 'down'}`);
    } else {
      it.cards.reverse();
      for (const c of it.cards) c.up = !c.up;
      logEvent(actor, `flipped ${itemLabel(decks, it)}`);
    }
    touch(id);
    mark(actor, id);
    return true;
  }

  function opToPile(actor, cardId, pileId) {
    const it = own(host.items, cardId), pile = own(host.items, pileId);
    if (it?.k !== 'c' || pile?.k !== 'p') return false;
    logEvent(actor, `put ${itemLabel(decks, it)} onto ${itemLabel(decks, pile)}`);
    mark(actor, pileId);
    pile.cards.push({ d: it.d, i: it.i, up: it.up });
    touch(pileId);
    remove(cardId);
    return true;
  }

  function opNewPile(actor, cards, o = {}) {
    const at = clampToFelt(o.x ?? host.size / 2 - CARD_W / 2, o.y ?? host.size / 2 - CARD_H / 2, host.size);
    const nid = put(uid(), { k: 'p', x: at.x, y: at.y, rot: 0, z: zTop(), name: String(o.name || '').slice(0, 24), cards: cards.map((c) => ({ d: c.d, i: c.i, up: !!c.up })) });
    logEvent(actor, `made a pile of ${cards.length} cards`);
    mark(actor, nid);
    return nid;
  }

  /** Stacks card `id` onto card `ontoId`: both become a new pile where `ontoId` lay. Returns its id. */
  function opStack(actor, id, ontoId) {
    const it = own(host.items, id), b = own(host.items, ontoId);
    if (it?.k !== 'c' || b?.k !== 'c' || it === b) return false;
    logEvent(actor, `stacked ${itemLabel(decks, it)} onto ${itemLabel(decks, b)}`);
    const nid = put(uid(), { k: 'p', x: b.x, y: b.y, rot: b.rot, z: zTop(), name: '', cards: [{ d: b.d, i: b.i, up: b.up }, { d: it.d, i: it.i, up: it.up }] });
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
      logEvent(actor, `returned ${whose} (${out.length}) to ${itemLabel(decks, pile)}`);
      mark(actor, pileId);
      pl.hand = pl.hand.filter((c) => !out.includes(c));
      for (const c of out) pile.cards.push({ d: c.d, i: c.i, up: false });
      touch(pileId);
    }
    return true;
  }

  /** Applies one action from player `p` to the authoritative state. True when
   *  the table changed (render, broadcast, save); false when the action was
   *  dropped before it could (flood control, a refused rules button). */
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
        return bump(); // the fresh broadcast reverts the actor's optimistic UI
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
      case 'hello': break; // registration + join logging happen in join()
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
        emit({ t: 'deck', id: deckId });
        const at = clampToFelt(num(a.x, host.size / 2 - CARD_W / 2), num(a.y, host.size / 2 - CARD_H / 2), host.size);
        const nid = put(uid(), {
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
          logEvent(p, `moved ${itemLabel(decks, it)}`);
          mark(p, a.id);
        }
        break;
      case 'rot': if (it) { it.rot = normRot(a.rot); touch(a.id); logEvent(p, `rotated ${itemLabel(decks, it)}`); mark(p, a.id); } break;
      case 'flip': if (it) opFlip(p, a.id); break;
      case 'shuffle': if (it?.k === 'p') opShuffle(p, a.id); break;
      case 'draw': {
        const c = it?.k === 'p' && it.cards.pop();
        if (c && pl) {
          pl.hand.push({ d: c.d, i: c.i });
          touch(a.id);
          logEvent(p, `drew a card from ${itemLabel(decks, it)}`);
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
          const at = clampToFelt(num(a.x, host.size / 2), num(a.y, host.size / 2), host.size), up = !!a.up;
          const nid = put(uid(), { k: 'c', x: at.x, y: at.y, rot: normRot(a.rot), z: zTop(), d: c.d, i: c.i, up });
          logEvent(p, `played ${up ? cardName(decks, c.d, c.i) : 'a card face down'} from hand`);
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
          touch(a.pile);
          logEvent(p, `put ${up ? cardName(decks, c.d, c.i) : 'a card face down'} from hand onto ${itemLabel(decks, pile)}`);
          mark(p, a.pile);
        }
        break;
      }
      case 'toHand':
        if (it?.k === 'c' && pl) {
          logEvent(p, `took ${itemLabel(decks, it)} from the table into hand`);
          mark(p, a.id);
          pl.hand.push({ d: it.d, i: it.i });
          remove(a.id);
        }
        break;
      case 'toPile': opToPile(p, a.id, a.pile); break;
      case 'stack': opStack(p, a.id, a.onto); break;
      case 'merge': {
        const to = own(items, a.pile);
        if (it?.k === 'p' && to?.k === 'p' && it !== to) {
          logEvent(p, `merged ${itemLabel(decks, it)} (${it.cards.length} cards) into ${itemLabel(decks, to)}`);
          mark(p, a.pile);
          to.cards.push(...it.cards);
          touch(a.pile);
          remove(a.id);
        }
        break;
      }
      case 'del':
        if (it) {
          logEvent(p, `removed ${itemLabel(decks, it)}${it.k === 'p' ? ` (${it.cards.length} cards)` : ''}`);
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
        logEvent(p, it.k === 'c' ? 'peeked at a face-down card' : `peeked at the top card of ${itemLabel(decks, it)}`, false, undefined, true);
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
          for (const [id, o] of Object.entries(items)) {
            ({ x: o.x, y: o.y } = clampToFelt(o.x + shift, o.y + shift, size));
            touch(id);
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
        const b = (host.rules?.enabled && host.rules.public.buttons || []).find((x) => x.id === String(a.id));
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
    if (host.rules?.enabled && (a.t === 'chat' || a.t === 'rulesBtn' || (RULED_ACTIONS.has(a.t) && marks > fx0))) {
      if (a.t === 'chat') runHook('onChat', String(a.msg || ''), p);
      runHook('onAction', { ...a, p });
      refreshButtons();
    }
    return bump();
  }

  // --- players come and go ---------------------------------------------------
  /** Registers player p, who just sent an action with this name and seat key:
   *  a new player gets a seat, and the first contact binds the key to it
   *  (checking it is the app's job). Returns the player as it was before
   *  (null if new) and whether they're back (new, or were offline). */
  function join(p, name, key) {
    const known = own(host.players, p);
    const back = !known?.online; // read BEFORE ensurePlayer flips the same object online
    ensurePlayer(p, name);
    host.players[p].key ||= key; // first contact binds the seat (older saves adopt their first claimant)
    if (back) {
      logEvent(p, known ? 'is back at the table' : 'joined the table');
      if (host.rules?.enabled) { runHook('onJoin', p); refreshButtons(); }
    }
    return { known, back };
  }
  /** Player p's last connection closed. True if they had a seat (now offline). */
  function leave(p) {
    const pl = own(host.players, p);
    if (!pl) return false;
    pl.online = false;
    logEvent(p, 'left the table');
    if (host.rules?.enabled) { runHook('onLeave', p); refreshButtons(); }
    return bump();
  }

  /** Opens a fresh table: the host seated as `name`, one standard deck in the middle. */
  function open(name) {
    ensurePlayer(pid, name);
    const deck = standardDeck(false);
    const deckId = uid();
    decks[deckId] = deck;
    put(uid(), {
      k: 'p', x: host.size / 2 - CARD_W / 2, y: host.size / 2 - CARD_H / 2, rot: 0, z: 1,
      name: deck.name, cards: deck.cards.map((_, i) => ({ d: deckId, i, up: false })),
    });
    logEvent(pid, 'opened the table');
  }

  /** Resumes a saved table in the host's browser, the host seated as `name`.
   *  Saves may predate the sanitizer (and could hold a deck a guest crafted),
   *  so their decks pass it again; a saved rules script that no longer loads
   *  disables the rules loudly rather than wedging the resume. */
  function resume(name) {
    for (const [id, d] of Object.entries(decks)) {
      try { decks[id] = cleanDeck(d); } catch (err) { console.error(`saved deck ${id} dropped`, err); delete decks[id]; }
    }
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
    for (const pl of Object.values(host.players)) pl.online = false;
    // Migrate older saves: seats didn't exist, and the table used to be a
    // larger rectangle — pull stranded items back onto the round felt.
    for (const pl of Object.values(host.players)) pl.seat ??= assignSeat();
    for (const [id, it] of Object.entries(host.items)) {
      ({ x: it.x, y: it.y } = clampToFelt(it.x, it.y, host.size));
      touch(id);
    }
    ensurePlayer(pid, name);
    logEvent(pid, 'resumed the table');
    bump();
  }

  // --- the engine around the script ------------------------------------------
  /** Runs one script hook; any throw disables the rules loudly. */
  function runHook(name, ...args) {
    if (!host.rules?.enabled || !hooks.has(name)) return undefined;
    try {
      return hooks.call(name, tApi, ...args);
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
      const btns = hooks.call('buttons', tApi) || [];
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
      const at = clampToFelt(o.x ?? host.size / 2 - CARD_W / 2, o.y ?? host.size / 2 - CARD_H / 2, host.size);
      const nid = put(uid(), { k: 'c', x: at.x, y: at.y, rot: normRot(o.rot), z: zTop(), d: c.d, i: c.i, up: o.up !== false });
      logEvent(RULES, `played ${o.up !== false ? cardName(decks, c.d, c.i) : 'a card face down'} from ${pl.name || 'a player'}'s hand`);
      mark(RULES, nid);
      return nid;
    },
    toHand(p, cardId) {
      const it = own(host.items, cardId), pl = own(host.players, p);
      if (it?.k !== 'c' || !pl) return false;
      logEvent(RULES, `gave ${itemLabel(decks, it)} to ${pl.name || 'a player'}`);
      mark(RULES, cardId);
      pl.hand.push({ d: it.d, i: it.i });
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
      logEvent(RULES, `merged ${itemLabel(decks, from)} (${from.cards.length} cards) into ${itemLabel(decks, to)}`);
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
      logEvent(RULES, `moved ${itemLabel(decks, it)}`);
      mark(RULES, id);
      return true;
    },
    rot(id, deg) {
      const it = own(host.items, id);
      if (!it) return false;
      it.rot = normRot(deg);
      touch(id);
      logEvent(RULES, `rotated ${itemLabel(decks, it)}`);
      mark(RULES, id);
      return true;
    },
    remove(id) {
      const it = own(host.items, id);
      if (!it) return false;
      logEvent(RULES, `removed ${itemLabel(decks, it)}${it.k === 'p' ? ` (${it.cards.length} cards)` : ''}`);
      mark(RULES, id);
      remove(id);
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
      emit({ t: 'deck', id: deckId });
      logEvent(RULES, `defined deck "${decks[deckId].name}" (${decks[deckId].cards.length} cards)`);
      return deckId;
    },
    addStandardDeck(o = {}) {
      const deck = standardDeck(!!o.jokers);
      const deckId = uid();
      decks[deckId] = deck;
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
    cardName: (ref) => cardName(decks, ref.d, ref.i),
    /** Full card identity for game logic: {name, rank, suit, text, meta, deck}.
     *  `meta` is the free-form JSON from a custom deck's manifest. */
    card(ref) {
      const deck = decks[ref.d], c = deck?.cards[ref.i];
      if (!c) return null;
      return structuredClone({
        name: cardName(decks, ref.d, ref.i), rank: c.r, suit: c.s, text: c.txt,
        meta: c.meta, deck: deck.name,
      });
    },
  };

  // --- the public view: what guests may know -----------------------------------
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

  return {
    state: host,
    api: tApi, // the rules facade `t`
    /** The last rules-script error, for the rules dialog ('' after a successful enable). */
    get rulesError() { return lastRulesError; },
    apply, join, leave, open, resume, runTimers, mayAct, publicItems, publicPlayers,
    /** The state as saved: all of it but the decks, which are saved apart
     *  (big, and rewritten only when a deck is added). */
    snapshot() { const s = { ...host }; delete s.decks; return s; },
    /** The effects queued since the last drain, oldest first (see the top of this file). */
    drain() { const out = effects; effects = []; return out; },
  };
}
