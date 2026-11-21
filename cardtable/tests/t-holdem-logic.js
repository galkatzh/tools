// Hold'em template logic, driven through a Node port of the rules facade
// (no browser for the game itself — deterministic decks, every edge case).
// The template is read from APP_ROOT's app.js. The mock mirrors the engine:
// rulesBtn only runs buttons offered to that player, validate() vetoes.
// (final overlay: the mock gains t.schedule (+ m.expire / m.join) and
// takeHand's card filter; a dropped player is folded after a grace (PT-5),
// Abandon is its own two-press button (PT-11), busted players get a Rebuy
// button (PT-10), refusals are told (PT-8), New hand gathers only its own
// deck, face down (PT-2, PT-3), the deck/muck/burns can't be peeked (SEC-F4).)
const h = require('./h');
const { ok, section } = h;
const fs = require('fs');

const src = fs.readFileSync(h.APP_ROOT + '/cardtable/app.js', 'utf8');
const s0 = src.indexOf('const RULES_TEMPLATES = {'), s1 = src.indexOf('\n};\n', s0);
const TPL = eval('(' + src.slice(s0 + 'const RULES_TEMPLATES = '.length, s1 + 2) + ')').holdem;

const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const STD = SUITS.flatMap((s) => RANKS.map((r) => ({ r, s })));
const JOKER = 52; // index of a '+ Deck' joker in the 'std' deck (only scenarios that add it)
const idx = (name) => STD.findIndex((c) => c.r + c.s === name);

/** A table: players named in seat order (the first is the host). */
function table(names, o = {}) {
  const W = o.size || 1300, R = W / 2 - 110, CW = 100, CH = 140;
  let n = 0; const uid = () => 'id' + (++n);
  const log = [], tells = [], refused = [], timers = [];
  const host = { players: {}, items: {}, rules: { data: {}, public: {} } };
  names.forEach((nm, k) => { host.players[nm] = { name: nm, online: true, hand: [], seat: k * (360 / 8) }; });
  host.items.deck = { k: 'p', x: W / 2 - CW / 2, y: W / 2 - CH / 2, cards: STD.map((_, i) => ({ d: 'std', i, up: false })) };
  let rig = null; // cards to deal next, in deal order (replaces the shuffle)
  const clamp = (x, y) => { const cx = x + CW / 2 - W / 2, cy = y + CH / 2 - W / 2, d = Math.hypot(cx, cy); if (d <= R) return { x, y }; const f = R / d; return { x: W / 2 + cx * f - CW / 2, y: W / 2 + cy * f - CH / 2 }; };
  const dealTop = (pileId, o2 = {}) => {
    const pile = host.items[pileId], c = pile?.k === 'p' && pile.cards.pop();
    if (!c) return false;
    let nid = null;
    if (o2.to) host.players[o2.to].hand.push({ d: c.d, i: c.i });
    else { const at = clamp(o2.x ?? pile.x + 118, o2.y ?? pile.y); nid = uid(); host.items[nid] = { k: 'c', x: at.x, y: at.y, rot: o2.rot || 0, d: c.d, i: c.i, up: !!o2.up }; }
    if (!pile.cards.length) delete host.items[pileId];
    return o2.to ? { d: c.d, i: c.i } : { id: nid, d: c.d, i: c.i };
  };
  const t = {
    get data() { return host.rules.data; }, get public() { return host.rules.public; }, set public(v) { host.rules.public = v || {}; },
    hostId: names[0],
    players: () => Object.entries(host.players).filter(([, p]) => p.seat != null).map(([id, p]) => ({ id, name: p.name, seat: p.seat, online: p.online, handCount: p.hand.length })).sort((a, b) => a.seat - b.seat),
    hand: (p) => (host.players[p]?.hand || []).map((c) => ({ ...c })),
    items: () => Object.entries(host.items).map(([id, it]) => structuredClone({ id, ...it })),
    piles() { return this.items().filter((x) => x.k === 'p'); },
    deal: (p, o2) => dealTop(p, o2),
    takeHand(p, pileId, only = () => true) { const pl = host.players[p], pile = host.items[pileId]; if (!pl || pile?.k !== 'p') return false; const out = pl.hand.filter((c) => only({ ...c })); pl.hand = pl.hand.filter((c) => !out.includes(c)); for (const c of out) pile.cards.push({ d: c.d, i: c.i, up: false }); return true; },
    schedule: (sec, tag) => timers.push(String(tag)),
    playFromHand(p, i, o2 = {}) { const c = host.players[p]?.hand.splice(i, 1)[0]; if (!c) return false; const at = clamp(o2.x, o2.y); const nid = uid(); host.items[nid] = { k: 'c', x: at.x, y: at.y, rot: o2.rot || 0, d: c.d, i: c.i, up: o2.up !== false }; return nid; },
    shuffle(id) {
      const p = host.items[id];
      for (let i = p.cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p.cards[i], p.cards[j]] = [p.cards[j], p.cards[i]]; }
      if (rig) { // put the rigged cards on top, first-dealt last
        const want = rig.map(idx);
        p.cards = p.cards.filter((c) => !want.includes(c.i)).concat(want.reverse().map((i) => ({ d: 'std', i, up: false })));
        rig = null;
      }
    },
    flip: (id) => { const it = host.items[id]; if (it) it.up = !it.up; },
    toPile: (cid, pid) => { const it = host.items[cid], p = host.items[pid]; if (it?.k !== 'c' || p?.k !== 'p') return false; p.cards.push({ d: it.d, i: it.i, up: it.up }); delete host.items[cid]; return true; },
    newPile: (cards, o2 = {}) => { const at = clamp(o2.x ?? 600, o2.y ?? 580); const id = uid(); host.items[id] = { k: 'p', x: at.x, y: at.y, name: o2.name || '', cards: cards.map((c) => ({ d: c.d, i: c.i, up: !!c.up })) }; return id; },
    merge: (f, to) => { const a = host.items[f], b = host.items[to]; if (a?.k !== 'p' || b?.k !== 'p' || a === b) return false; b.cards.push(...a.cards); delete host.items[f]; return true; },
    move: (id, x, y) => { const it = host.items[id]; if (!it) return false; Object.assign(it, clamp(x, y)); return true; },
    remove: (id) => { if (!host.items[id]) return false; delete host.items[id]; return true; },
    geom: () => ({ size: W, cx: W / 2, cy: W / 2, r: R }),
    say: (m) => log.push(m), announce: (m) => log.push('📣 ' + m),
    win(w, m) { host.rules.public.winners = [].concat(w); this.announce(m); },
    tell: (p, m) => tells.push(p + ': ' + m),
    nextSeat(p) { const ps = this.players().filter((x) => x.online || x.id === p); const i = ps.findIndex((x) => x.id === p); return ps.length ? ps[(i + 1) % ps.length].id : p; },
    cardName: (r) => (r.d === 'std' ? (r.i === JOKER ? 'Joker 🃏' : STD[r.i].r + STD[r.i].s) : '“white card ' + r.i + '”'),
    card: (r) => (r.d === 'std' ? { name: t.cardName(r), rank: r.i === JOKER ? 'JOKER' : STD[r.i].r, suit: STD[r.i]?.s } : { name: t.cardName(r), text: 'white card ' + r.i }),
  };
  const script = new Function(`"use strict"; return (\n${TPL}\n);`)();
  const d = () => host.rules.data;
  const m = {
    t, host, script, log, tells, refused, d,
    buttons: () => script.buttons(t),
    /** rulesBtn as the engine runs it: only a button offered to p. */
    btn(p, id) {
      const b = script.buttons(t).find((x) => x.id === id);
      if (b && (!b.pid || b.pid === p)) script.onButton(t, id, p); else refused.push(p + ':' + id);
    },
    mine: (p) => script.buttons(t).filter((b) => !b.pid || b.pid === p),
    chat: (p, msg) => script.onChat(t, msg, p),
    /** The actor presses its first offered action (Check, else Call). */
    passive() { const b = m.mine(d().turn).find((x) => x.id === 'check' || x.id === 'call'); m.btn(d().turn, b.id); },
    leave(p) { host.players[p].online = false; script.onLeave?.(t, p); },
    join(p) { host.players[p].online = true; script.onJoin?.(t, p); },
    /** Fires every scheduled timer now (the grace periods run out). */
    expire() { for (const tag of timers.splice(0)) script.onTimer?.(t, tag); },
    rig: (cards) => { rig = cards; },
    chips: () => Object.values(d().stacks).reduce((a, b) => a + b, 0) + (d().stage === 'hand' ? d().pot : 0),
    lastTell: (p) => tells.filter((x) => x.startsWith(p + ':')).pop() || '',
  };
  script.setup(t);
  return m;
}
const conserved = (m, total, what) => ok(m.chips() === total, `${what}: chips conserved (${m.chips()} = ${total})`);
/** Runs one scenario; a throw is a failed check, not the end of the suite. */
function guard(fn) { try { fn(); } catch (e) { ok(false, 'scenario crashed: ' + e.message); } }
/** Plays passively (check/call) until the hand is over. */
function finish(m) { for (let k = 0; k < 60 && m.d().stage === 'hand' && m.d().turn; k++) m.passive(); }

(async () => {
  const env = await h.start();

  section("recheck: a deck with jokers (bottom card a Joker) is still the game's deck");
  guard(() => {
    const m = table(['A', 'B']);
    m.host.items.deck.cards.unshift({ d: 'std', i: JOKER, up: false });
    ok(m.script.deck(m.t)?.cards.length === 53, 'deck() finds the 53-card pile whose bottom card is a Joker');
    m.btn('A', 'new');
    ok(m.d().stage === 'hand' && m.host.players.A.hand.length === 2, 'New hand deals from it');
  });

  section('GAME-1: only online players are dealt in');
  guard(() => {
    const m = table(['A', 'B', 'C']);
    m.host.players.C.online = false;
    m.btn('A', 'new');
    ok(m.host.players.C.hand.length === 0, 'offline C gets no hole cards');
    ok(!m.d().pending.includes('C'), 'offline C is not waited on');
    finish(m);
    ok(m.d().stage === 'done', `the hand plays to the end (stage ${m.d().stage}, turn ${m.d().turn})`);
    conserved(m, 3000, 'offline seat');
  });
  section('GAME-1: leaving mid-hand folds the leaver');
  guard(() => {
    const m = table(['A', 'B', 'C']);
    m.btn('A', 'new');
    const who = m.d().turn;
    m.leave(who);
    ok(!m.d().folded.includes(who) && m.d().turn === who && m.log.some((x) => x.includes(who + ' disconnected — folding in 20 s')), `${who} is not folded the moment they drop (the hand waits, it says so)`);
    m.expire();
    ok(m.d().folded.includes(who) && m.host.players[who].hand.length === 0, `${who} (on turn) is folded, cards mucked`);
    ok(m.d().turn && m.d().turn !== who, `the turn moves on (${m.d().turn})`);
    finish(m);
    ok(m.d().stage === 'done', 'the hand finishes without the leaver');
    conserved(m, 3000, 'leave on turn');
  });
  guard(() => {
    const m = table(['A', 'B', 'C']);
    m.btn('A', 'new');
    const turn = m.d().turn, other = ['A', 'B', 'C'].find((x) => x !== turn && m.d().pending.includes(x));
    m.leave(other); m.expire();
    ok(m.d().folded.includes(other) && !m.d().pending.includes(other), `${other} (not on turn) is folded and no longer pending`);
    ok(m.d().turn === turn, 'the turn stays where it was');
    finish(m);
    ok(m.d().stage === 'done', 'the hand finishes');
    conserved(m, 3000, 'leave out of turn');
  });
  guard(() => {
    const m = table(['A', 'B']);
    m.btn('A', 'new');
    const stay = m.d().turn, other = stay === 'A' ? 'B' : 'A';
    m.leave(other); m.expire();
    ok(m.d().stage === 'done' && JSON.stringify(m.host.rules.public.winners) === JSON.stringify([stay]), `heads-up: ${stay} takes the pot when ${other} leaves`);
    conserved(m, 2000, 'heads-up leave');
  });
  guard(() => {
    const m = table(['A', 'B', 'C']);
    m.btn('A', 'new'); // dealer A, SB B, BB C; A acts first
    m.chat('A', '!allin');
    m.leave('A'); m.expire();
    ok(!m.d().folded.includes('A') && m.host.players.A.hand.length === 2, 'an all-in leaver keeps their cards (nothing left to decide)');
    finish(m);
    conserved(m, 3000, 'all-in leaver');
  });
  guard(() => {
    const m = table(['A', 'B']);
    m.d().stacks.A = 1234;
    m.script.setup(m.t); m.script.onJoin(m.t, 'A');
    ok(m.d().stacks.A === 1234, 're-running setup / onJoin (reconnect) keeps the stack');
  });

  section('GAME-2 / SEC-13: mid-hand, only the host can call the hand off');
  guard(() => {
    const m = table(['A', 'B', 'C']);
    m.btn('B', 'new');
    ok(m.d().stage === 'hand', 'between hands anyone may deal');
    const nb = m.buttons().find((b) => b.id === 'abandon');
    ok(nb.pid === 'A' && /abandon/i.test(nb.label) && !m.buttons().some((b) => b.id === 'new'), `mid-hand "abandon" is the host's, labelled "${nb.label}"`);
    m.chat(m.d().turn, '!raise 100');
    const potBefore = m.d().pot, comm = m.d().comm.length;
    m.btn('B', 'abandon'); m.btn('C', 'abandon');
    ok(m.refused.length === 2 && m.d().pot === potBefore && m.d().comm.length === comm, 'guests cannot abandon the hand');
    m.btn('A', 'abandon');
    ok(!m.log.some((x) => x.includes('Hand abandoned')) && /again/.test(m.lastTell('A')), `one press only asks for a second ("${m.lastTell('A')}")`);
    m.btn('A', 'abandon');
    ok(m.log.some((x) => x.includes('Hand abandoned — bets refunded')), 'the host can (bets refunded)');
    conserved(m, 3000, 'abandon');
  });

  section('GAME-6: blinds that put everyone all-in run the board out');
  guard(() => {
    const m = table(['A', 'B']);
    m.d().stacks.A = 5; m.d().stacks.B = 10;
    m.btn('A', 'new');
    ok(m.d().stage === 'done' && m.d().comm.length === 5, `the hand runs out to a showdown (stage ${m.d().stage}, board ${m.d().comm.length})`);
    ok(!m.log.some((x) => x.includes('?')), 'no "? to act" in the announcement');
    conserved(m, 15, 'blind all-in');
  });

  section('GAME-7: a short all-in does not reopen the raising');
  for (const [cStack, full] of [[160, false], [210, true]]) guard(() => {
    const m = table(['A', 'B', 'C']);
    m.d().stacks.C = cStack;
    const total = 2000 + cStack;
    m.btn('A', 'new'); // dealer A, SB B, BB C
    m.passive(); m.passive(); m.passive(); // A calls, B calls, C checks
    ok(m.d().comm.length === 3 && m.d().turn === 'B', 'flop, B to act');
    m.chat('B', '!bet 100');
    m.chat('C', '!allin');
    m.chat('A', '!call');
    ok(m.d().turn === 'B', `back to B, facing C's all-in for ${cStack - 10}`);
    m.chat('B', '!raise 600');
    if (full) ok(m.d().curBet === 600, 'a FULL all-in raise reopens: B re-raises to 600');
    else {
      ok(m.d().curBet === 150 && /not reopened/.test(m.lastTell('B')), `short all-in: B's re-raise refused ("${m.lastTell('B')}")`);
      const ids = m.mine('B').map((b) => b.id);
      ok(ids.includes('call') && !ids.some((x) => x.startsWith('r:') || x === 'allin'), `B is offered only call/fold (${ids})`);
      m.chat('B', '!allin');
      ok(m.d().curBet === 150, '!allin (a raise) is refused too');
      m.chat('B', '!call');
      ok(m.d().comm.length === 4, 'B calls and the turn is dealt');
    }
    finish(m);
    conserved(m, total, full ? 'full all-in' : 'short all-in');
  });

  section('GAME-8: an uncalled bet is returned, not "won"');
  guard(() => {
    const m = table(['A', 'B']);
    m.d().stacks.B = 300;
    // heads-up: A (dealer/SB) gets 7-2, B gets aces; the board helps nobody
    m.rig(['7♣', '2♦', 'A♠', 'A♥', '3♣', '9♠', 'J♦', 'Q♣', '4♣', 'K♥', '5♦', '8♥']);
    m.btn('A', 'new');
    m.chat('A', '!raise 500');
    m.chat('B', '!allin');
    ok(m.d().stage === 'done', 'all-in call runs out to a showdown');
    ok(m.log.some((x) => x.includes('Uncalled 200 returned to A')), 'the 200 nobody called goes back to A');
    const banner = m.log.filter((x) => x.startsWith('📣')).pop();
    ok(!/^📣 A |& A| A wins|\(side\)/.test(banner) && JSON.stringify(m.host.rules.public.winners) === '["B"]', `only B wins, no fake side pot ("${banner}")`);
    ok(m.d().stacks.A === 700 && m.d().stacks.B === 600, `stacks A 700 / B 600 (${m.d().stacks.A}/${m.d().stacks.B})`);
    conserved(m, 1300, 'uncalled bet');
  });

  section('GAME-9: deck, muck and board are guarded mid-hand');
  guard(() => {
    const m = table(['A', 'B', 'C']);
    m.btn('A', 'new');
    m.btn('A', 'fold'); // A folds -> muck exists
    m.passive(); m.passive(); // flop
    const d = m.d(), deckId = m.script.deck(m.t).id, burnId = d.burn[0];
    const v = (a) => m.script.validate(m.t, { p: 'B', ...a });
    ok(burnId && m.host.items[burnId], 'the burn card is tracked');
    ok(v({ t: 'del', id: deckId }), 'deleting the deck is blocked');
    ok(v({ t: 'merge', id: d.muckId, pile: deckId }), 'merging the muck into the deck is blocked');
    ok(v({ t: 'flip', id: d.muckId }), 'flipping the muck is blocked');
    ok(v({ t: 'shuffle', id: deckId }), 'shuffling the deck is blocked');
    ok(v({ t: 'flip', id: burnId }), 'flipping a burn card is blocked');
    const commId = Object.entries(m.host.items).find(([, it]) => it.k === 'c' && it.up)[0];
    ok(v({ t: 'del', id: commId }), 'deleting a board card is blocked');
    ok(!v({ t: 'move', id: commId, x: 1, y: 1 }), 'moving one is fine');
    delete m.host.items[deckId]; // the deck vanishes anyway (belt and braces)
    let threw = null;
    try { finish(m); } catch (e) { threw = e; }
    ok(!threw, `the next street does not crash (${threw?.message || 'ok'})`);
    ok(d.stage === 'done' && m.log.some((x) => x.includes('deck is gone')), 'the hand is abandoned and refunded');
    conserved(m, 3000, 'deck gone');
  });

  section('GAME-14: !rebuy only refills a busted stack, between hands');
  guard(() => {
    const m = table(['A', 'B']);
    m.chat('A', '!rebuy');
    ok(m.d().stacks.A === 1000 && /busted/.test(m.lastTell('A')), 'a funded stack cannot rebuy');
    m.d().stacks.A = 0;
    m.d().stage = 'hand';
    m.chat('A', '!rebuy');
    ok(m.d().stacks.A === 0, 'not mid-hand, even when busted');
    m.d().stage = 'done';
    m.chat('A', '!rebuy');
    ok(m.d().stacks.A === 1000, 'a busted stack rebuys to 1000 between hands');
  });

  section('GAME-16: revealed hole cards stay off the board (8 seats, small table)');
  guard(() => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const m = table(names);
    m.btn('A', 'new');
    m.btn('D', 'fold'); // first to act (UTG) folds: the muck is on the table too
    finish(m);
    ok(m.d().stage === 'done', 'a 7-way hand checks down to a showdown');
    // rotated-rectangle overlap (separating axis test)
    const corners = (it) => {
      const a = ((it.rot || 0) * Math.PI) / 180, cx = it.x + 50, cy = it.y + 70;
      return [[-50, -70], [50, -70], [50, 70], [-50, 70]].map(([x, y]) => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]);
    };
    const overlap = (p, q) => [p, q].every((poly) => poly.every((pt, i) => {
      const nx = poly[(i + 1) % 4][1] - pt[1], ny = pt[0] - poly[(i + 1) % 4][0];
      const proj = (P) => P.map(([x, y]) => x * nx + y * ny);
      const a = proj(p), b = proj(q);
      return Math.max(...a) > Math.min(...b) && Math.max(...b) > Math.min(...a);
    }));
    const items = Object.values(m.host.items), boardKeys = new Set(m.d().comm.map((c) => c.i));
    const board = items.filter((it) => it.k === 'p' || (it.k === 'c' && (boardKeys.has(it.i) || !it.up)));
    const reveals = items.filter((it) => it.k === 'c' && it.up && !boardKeys.has(it.i));
    ok(reveals.length === 14 && board.length === 5 + 3 + 2, `14 reveals; board, burns, deck and muck present (${reveals.length}/${board.length})`);
    const hits = reveals.flatMap((r) => board.filter((b) => overlap(corners(r), corners(b))).map((b) => `${r.x | 0},${r.y | 0}@${r.rot} × ${b.k}${b.up ? '' : '↓'} ${b.x | 0},${b.y | 0}`));
    ok(hits.length === 0, `no reveal overlaps the board, burns, deck or muck (${hits.join('; ') || 'none'})`);
    conserved(m, 8000, '8-way');
  });

  section('GAME-17: !blinds — host only, between hands, 0 < SB ≤ BB');
  guard(() => {
    const m = table(['A', 'B']);
    m.chat('B', '!blinds 50 100');
    ok(m.d().blinds.bb === 10 && /host/.test(m.lastTell('B')), 'a guest cannot change the blinds');
    for (const bad of ['0 0', '50 10', '0 10']) {
      m.chat('A', '!blinds ' + bad);
      ok(m.d().blinds.sb === 5 && m.d().blinds.bb === 10, `"!blinds ${bad}" refused`);
    }
    m.chat('A', '!blinds 10 20');
    ok(m.d().blinds.sb === 10 && m.d().blinds.bb === 20, 'the host sets 10/20');
    m.btn('A', 'new');
    m.chat('A', '!blinds 25 50');
    ok(m.d().blinds.bb === 20, 'not mid-hand');
  });

  section('GAME-18: odd chips go left of the button; no dead helper');
  guard(() => {
    const m = table(['A', 'B', 'C']);
    // A and C tie on a royal-flush board; B folds its small blind -> pot 25
    m.rig(['2♣', '3♦', '4♣', '5♦', '7♣', '8♦', '6♠', '10♠', 'J♠', 'Q♠', '9♥', 'K♠', '9♦', 'A♠']);
    m.btn('A', 'new'); // dealer A, SB B, BB C
    m.btn('A', 'call'); m.btn('B', 'fold');
    finish(m);
    ok(/split 25/.test(m.log.filter((x) => x.startsWith('📣')).pop()), 'A and C split 25');
    ok(m.d().stacks.C === 1003 && m.d().stacks.A === 1002, `C (first left of the button) gets the odd chip: A ${m.d().stacks.A}, C ${m.d().stacks.C}`);
    ok(!('funded' in m.script), 'the unused funded() helper is gone');
    conserved(m, 3000, 'split');
  });

  section('UX-I6: quick-bet buttons for the player to act');
  guard(() => {
    const m = table(['A', 'B']);
    m.d().stacks.B = 80;
    m.btn('A', 'new'); // heads-up: A dealer/SB acts first
    const pre = m.mine('A').filter((b) => b.id !== 'abandon').map((b) => b.label);
    ok(JSON.stringify(pre) === JSON.stringify(['Call 5', 'Fold', 'Min raise → 20', 'Pot → 30', 'All-in → 1000']), `preflop: ${pre.join(' | ')} (½ pot = min raise, shown once)`);
    ok(!m.mine('B').some((b) => b.id.startsWith('r:') || b.id === 'allin'), 'nobody else gets them');
    m.btn('B', 'r:20');
    ok(m.refused.includes('B:r:20'), "B cannot press A's raise");
    m.btn('A', 'r:12345');
    ok(m.refused.includes('A:r:12345') && m.d().curBet === 10, 'a forged amount is refused by the engine');
    m.btn('A', 'r:30');
    ok(m.d().curBet === 30 && m.log.includes('A raises to 30'), 'Pot raises to 30');
    m.btn('B', 'call');
    const flop = m.mine('B').map((b) => b.label); // pot 60, B has 50 behind
    ok(JSON.stringify(flop) === JSON.stringify(['Check', 'Fold', 'Min raise → 10', '½ pot → 30', 'All-in → 50']), `flop, short stack: ${flop.join(' | ')} (Pot → 60 exceeds the stack: left out)`);
    m.btn('B', 'r:30');
    ok(m.d().curBet === 30, '½ pot bets 30');
    const vs = m.mine('A').filter((b) => b.id !== 'abandon').map((b) => b.label);
    ok(JSON.stringify(vs) === JSON.stringify(['Call 30', 'Fold', 'Min raise → 60', '½ pot → 90', 'Pot → 150', 'All-in → 970']), `facing a bet: ${vs.join(' | ')}`);
    m.btn('A', 'allin');
    m.btn('B', 'call');
    ok(m.d().stage === 'done', 'All-in + call runs it out');
    conserved(m, 1080, 'quick bets');
  });
  await env.done();
})().catch(h.crash);
