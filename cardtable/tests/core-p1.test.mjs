// Phase 1 delta sync in plain Node (spec §1l, core-p1.test.mjs), checked
// against the spec rather than against the core itself:
//  (1) T.pub equals the full publicItems(), and the shapes of §1d, after
//      every op of a seeded 600-op run: every Phase 1 action, the host's
//      joins, leaves, timers and refusals, and rules ops through T.api.
//  (2) The broadcast tick of §1b.3 (a per-peer sync map and base, one shared
//      text spliced per recipient), folded by the guest algorithm of §1b.4
//      (and by core's viewFromSnap / applyViewPatch, which the app runs),
//      reproduces the next snapshot exactly: items, players, log, hands,
//      rules, size. That includes ticks that send a peer nothing, reloads,
//      registrations and host reloads.
//  (3) trimLog keeps the newest of each bucket, the same on both sides.
//  (4) zTop is a running max, and createTable restores zMax.
//  (5) t.item, t.find and t.piles return detached copies that agree with a
//      scan of the state; an unknown filter throws.
//  (6) MIGRATE[1] lifts a v1 save: keys, zMax, v:2.
//  (7) A veto or refusal re-sends the items the action named, and the hand.
//  (8) The body splice parses, with an empty or non-empty shared part and
//      with or without a hand; the sealed text verifies.
// Then the t.data cap, the applyStatePatch seam (§1f), and regressions for
// what the Phase 1A review found (each names what it guards).
// Every random sequence is seeded and every failure names its seed: SEED=n
// replays one.
import { isDeepStrictEqual } from 'node:util';
import { core, RULES_TEMPLATES, ok, section, report, crash, guard, seeds, rng, env, json, canon, keyOf, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

const { createTable, own, PROTO, STATE_V, MIGRATE, migrate, trimLog, spliceBody, sharedText, sealText, SIG, viewFromSnap, applyViewPatch, playR, CARD_W, CARD_H } = core;
const map = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
const pileOf = (T) => Object.keys(T.state.items).find((id) => T.state.items[id].k === 'p');
const maxZ = (s) => Math.max(0, ...Object.values(s.items).map((it) => it.z));

// --- the spec's oracles ---------------------------------------------------------
/** An item as §1d says everyone receives it. */
function specItem(it) {
  const { k, x, y, rot, z } = it;
  if (k === 'p') {
    const top = it.cards.at(-1);
    return { k, x, y, rot, z, name: it.name, n: it.cards.length, top: top && (top.up ? { d: top.d, i: top.i, up: true } : { d: top.d, up: false }) };
  }
  return it.up ? { k, x, y, rot, z, d: it.d, i: it.i, up: true } : { k, x, y, rot, z, d: it.d, up: false };
}
const specPlayer = (pl) => ({ name: pl.name, color: pl.color, online: pl.online, handCount: pl.hand.length, seat: pl.seat });
/** What a snapshot for `to` holds (§1b.1), from the host state alone. */
const specSnap = (s, to) => ({
  size: s.size, rules: s.rules ? { name: s.rules.name, enabled: s.rules.enabled, public: s.rules.public } : null,
  items: map(s.items, specItem), players: map(s.players, specPlayer), log: s.log, hand: to ? s.players[to].hand : [],
});
/** A body item that shows a hidden identity (§1d): a face-down card's `i`, a pile's cards, a face-down top's `i`. */
const leaks = (it) => (it.k === 'c' && !it.up && 'i' in it) || (it.k === 'p' && ('cards' in it || (it.top && !it.top.up && 'i' in it.top)));
const CAPS = { talk: 100, loud: 50, act: 200 };
/** A log entry's bucket (§1a; today's buckets: chat and renames, peeks, every other action). */
const bucket = (e) => (e.c || 'n' in e ? 'talk' : e.k ? 'loud' : 'act');
/** The newest CAPS[b] entries of each bucket b, in log order (§1a "Trimming"). */
function refTrim(log) {
  const keep = new Set();
  for (const b of Object.keys(CAPS)) log.map((e, k) => [e, k]).filter(([e]) => bucket(e) === b).slice(-CAPS[b]).forEach(([, k]) => keep.add(k));
  return log.filter((_, k) => keep.has(k));
}
const overCaps = (log) => Object.keys(CAPS).find((b) => log.filter((e) => bucket(e) === b).length > CAPS[b]);
/** Whether a snapshot is accepted over view V (§1b.4). */
const takesSnap = (V, d) => !V || d.boot > V.boot || (d.boot === V.boot && d.seq >= V.seq);
/** A guest receiving body d (§1b.4), as the spec writes it: returns what it did. */
function specReceive(r, d) {
  const V = r.spec;
  if (d.v !== PROTO || (d.to && d.to !== r.pid)) return 'dropped';
  if (d.kind === 'snap') {
    if (!takesSnap(V, d)) return 'stale';
    r.spec = { boot: d.boot, seq: d.seq, size: d.size, rules: d.rules, items: { ...d.items }, players: { ...d.players }, log: d.log, hand: d.hand ?? [] };
    return 'snap';
  }
  if (V && d.boot === V.boot && d.base === V.seq) {
    Object.assign(V.items, d.items);
    for (const id of d.del || []) delete V.items[id];
    Object.assign(V.players, d.players);
    if ('rules' in d) V.rules = d.rules;
    if (d.size) V.size = d.size;
    if (d.log) V.log = refTrim([...V.log, ...d.log]);
    if ('hand' in d) V.hand = d.hand;
    V.seq = d.seq;
    return 'patch';
  }
  return V && (d.boot < V.boot || (d.boot === V.boot && d.seq <= V.seq)) ? 'stale' : 'gap';
}

const PATCH_KEYS = ['size', 'rules', 'items', 'del', 'players', 'log', 'fx', 'ann'], SNAP_KEYS = ['size', 'rules', 'items', 'players', 'log'];
/** The host's 'state' channel in Node. Each tick (§1b.3) takes the dirty sets
 *  once, serializes the shared part once, then sends each peer a snapshot (a
 *  new connection, or its `to` changed), a patch from that peer's own base, or
 *  nothing (W.d and W.sent keep the last tick's dirty sets and bodies). Each
 *  peer folds what it receives twice, by specReceive and with
 *  core's viewFromSnap / applyViewPatch, from separate parses. Problems are
 *  collected (the first few kept) rather than thrown:
 *    wire   body shape (envelope, hand presence, sorted ids, hidden identities, seat keys, gaps)
 *    spec   a spec-folded view that differs from the next snapshot
 *    impl   the same for core's fold
 *    snap   T.snapContent() that differs from the spec's view of the state */
function wire(T, label) {
  const sync = new Map(), bad = { wire: [], spec: [], impl: [], snap: [] };
  const flag = (kind, msg) => { if (bad[kind].length < 3) bad[kind].push(`${label}: ${msg}`); };
  const W = {
    T, boot: 1, peers: [], bad, skipped: 0, afterSkip: 0, snaps: 0, patches: 0, d: null, sent: new Map(),
    add(tp, pid) { const r = { tp, pid, spec: null, impl: null, missed: false }; W.peers.push(r); return r; },
    /** Peer r reloads: a new connection (no sync entry), an empty view. */
    reload(r) { sync.delete(r.tp); r.spec = r.impl = null; },
    /** The host reloads from its save (table T2): a new epoch, every peer re-synced. */
    hostReload(T2) { W.T = T2; W.boot++; sync.clear(); },
    tick() {
      const T = W.T, s = T.state, d = T.takeDirty(), seq = s.seq, content = T.patchContent(d);
      const fx = [], ann = [];
      for (const e of T.drain()) {
        if (e.t === 'fx') fx.push(e.f);
        else if (e.t === 'ann') ann.push(e.msg);
      }
      if (Object.keys(content).some((k) => !PATCH_KEYS.includes(k))) flag('wire', `patch content carries ${Object.keys(content)}`);
      if (fx.length) content.fx = fx;
      if (ann.length) content.ann = ann;
      W.d = d;
      W.sent = new Map();
      const head = { v: PROTO, boot: W.boot, seq, host: HOST };
      const patch = JSON.stringify({ ...head, kind: 'patch', ...content });
      let snap;
      for (const r of W.peers) {
        const to = r.pid && own(s.players, r.pid) ? r.pid : null, st = sync.get(r.tp), mine = !!to && d.hands.has(to);
        let text;
        if (!st || st.to !== to) {
          if (!snap) {
            const sc = T.snapContent();
            if (Object.keys(sc).some((k) => !SNAP_KEYS.includes(k))) flag('wire', `snapshot content carries ${Object.keys(sc)}`);
            snap = JSON.stringify({ ...head, kind: 'snap', ...sc, fx, ann });
          }
          text = spliceBody({ to, tp: r.tp, ...(to ? { hand: s.players[to].hand } : {}) }, snap);
          sync.set(r.tp, { seq, to });
        } else if (Object.keys(content).length || mine) {
          text = spliceBody({ to, tp: r.tp, base: st.seq, ...(mine ? { hand: s.players[to].hand } : {}) }, patch);
          st.seq = seq;
        } else { W.skipped++; r.missed = true; continue; }
        W.sent.set(r, text);
        W.deliver(r, text, to, mine);
      }
    },
    deliver(r, text, to, mine) {
      const b = JSON.parse(text), at = `${r.tp} @${b.seq}`;
      if (b.v !== PROTO || b.tp !== r.tp || b.to !== to || b.seq !== W.T.state.seq) flag('wire', `${at}: envelope ${JSON.stringify({ v: b.v, to: b.to, tp: b.tp, seq: b.seq })}`);
      if (('hand' in b) !== (b.kind === 'snap' ? !!to : mine)) flag('wire', `${at}: a ${b.kind} ${'hand' in b ? 'with' : 'without'} a hand`);
      const ids = Object.keys(b.items || {});
      if (ids.join() !== [...ids].sort().join()) flag('wire', `${at}: items not in sorted id order`);
      const leak = ids.find((id) => leaks(b.items[id]));
      if (leak) flag('wire', `${at}: ${JSON.stringify(b.items[leak])} shows a hidden identity`);
      if (/"keys?"|key-/.test(text)) flag('wire', `${at}: a seat key travels`);
      const how = specReceive(r, b);
      if (how !== 'snap' && how !== 'patch') flag('wire', `${at}: the guest found a ${how} (base ${b.base}, view at ${r.spec?.seq})`);
      const c = JSON.parse(text); // core's fold, on its own copy
      if (c.kind === 'snap' && takesSnap(r.impl, c)) r.impl = viewFromSnap(c);
      else if (c.kind === 'patch' && r.impl && c.boot === r.impl.boot && c.base === r.impl.seq) applyViewPatch(r.impl, c);
      if (how === 'patch') { W.patches++; if (r.missed) W.afterSkip++; } else W.snaps++;
      r.missed = false;
    },
    /** Every peer's views against the spec's snapshot of the state now, and T.snapContent() too. */
    check(where) {
      const s = W.T.state, sc = W.T.snapContent();
      const diff = (V, want) => ['items', 'players', 'rules', 'log', 'hand', 'size'].find((k) => canon(V[k]) !== canon(want[k]));
      const field = diff({ ...json(sc), hand: [] }, specSnap(s, null));
      if (field) flag('snap', `${where}: T.snapContent().${field} differs from the state's public view`);
      for (const r of W.peers) {
        if (!r.spec) continue;
        const want = specSnap(s, r.pid && own(s.players, r.pid) ? r.pid : null);
        const a = diff(r.spec, want), b = r.impl ? diff(r.impl, want) : 'everything';
        if (a) flag('spec', `${where}, peer ${r.tp}: ${a} differs from the next snapshot`);
        if (b) flag('impl', `${where}, peer ${r.tp}: ${b} differs from the next snapshot`);
      }
    },
  };
  return W;
}

// --- the rules a fuzz runs under ---------------------------------------------------
const FUZZ_RULES = `({
  name: 'Fuzz',
  setup(t) { t.public.round = 0; },
  validate(t, a) {
    if (a.boom) throw new Error('boom');
    if (t.data.veto || a.rot === 45) return 'not now';
  },
  buttons: () => [{ id: 'quiet', label: 'Quiet' }, { id: 'round', label: 'Round' }, { id: 'veto', label: 'Veto' }],
  onButton(t, id) {
    if (id === 'quiet') { t.data.n = (t.data.n || 0) + 1; t.schedule(0, 'quiet'); }
    if (id === 'round') { t.public.round++; t.announce('Round ' + t.public.round); }
    if (id === 'veto') t.data.veto = !t.data.veto;
  },
  onTimer(t) { t.data.fired = (t.data.fired || 0) + 1; },
})`;
const QUERIES = [{}, { kind: 'card' }, { kind: 'pile' }, { kind: 'card', up: true }, { kind: 'card', up: false }, { name: 'standard' },
  { name: 'STANDARD' }, { name: 'Stan' }, { kind: 'pile', name: 'discard' }, { kind: 'card', name: 'standard' }];
/** t.find(q) by a scan of the state (§1e): kind, a pile's exact name in any case, a card's face. */
const scan = (s, q) => Object.entries(s.items).filter(([, it]) => (q.kind === undefined || it.k === { card: 'c', pile: 'p' }[q.kind])
  && (q.name === undefined || (it.k === 'p' && it.name.toLowerCase() === q.name.toLowerCase()))
  && (q.up === undefined || (it.k === 'c' && !!it.up === q.up))).map(([id, it]) => ({ id, ...it }));
const byId = (list) => canon([...list].sort((a, b) => (a.id < b.id ? -1 : 1)));
/** The first way the facade's indexed reads disagree with a scan of the state, or ''. */
function readsDisagree(T) {
  const t = T.api, s = T.state;
  for (const q of QUERIES) if (byId(t.find(q)) !== byId(scan(s, q))) return `t.find(${JSON.stringify(q)})`;
  if (byId(t.piles()) !== byId(scan(s, { kind: 'pile' }))) return 't.piles()';
  const bad = Object.keys(s.items).find((id) => canon(t.item(id)) !== canon({ id, ...s.items[id] }));
  return bad ? `t.item(${bad})` : '';
}

/** One seeded run of `n` random ops on a table seen by five peers: the host's
 *  own screen, Bob, Carol and Dave (anonymous until they join) and an
 *  anonymous peer. A tick follows each op with probability 0.4 (so ticks
 *  batch a few ops); Dave and the anonymous peer reload now and then; the host
 *  reloads from its save at ops 200 and 400. */
function fuzz(seed, n) {
  const r = rng(seed), E = env(seed), stats = { kinds: new Set(), total: 0, pub: tally(), spec: tally(), z: '', caps: '', reads: '' };
  let T = createTable({}, E);
  T.open('Alice');
  T.join(BOB, 'Bob', keyOf(BOB));
  const W = wire(T, `seed ${seed}`);
  const dave = W.add('peer-dave', DAVE), anon = W.add('peer-anon', null);
  for (const [tp, pid] of [['peer-self', HOST], ['peer-bob', BOB], ['peer-carol', CAROL]]) W.add(tp, pid);
  W.tick();
  for (let k = 0; k < n; k++) {
    if (Object.keys(T.state.items).length < 6) T.api.addStandardDeck({ x: 200 + r() * 800, y: 200 + r() * 800 }); // deletes would empty the table
    const s = T.state, t = T.api, ids = Object.keys(s.items);
    const piles = ids.filter((id) => s.items[id].k === 'p'), cards = ids.filter((id) => s.items[id].k === 'c'), players = Object.keys(s.players);
    const p = r() < 0.05 ? r.pick([CAROL, DAVE]) : r.pick(players); // now and then someone who may not be seated
    const hand = own(s.players, p)?.hand || [], hi = r.int(hand.length + 1), c = hand[hi] || {};
    const any = (list) => (r() < 0.93 && list.length ? r.pick(list) : r.pick(['nope', '__proto__', undefined]));
    const xy = () => ({ x: r() * 1100 + 50, y: r() * 1100 + 50 });
    const boom = () => (r() < 0.04 ? { boom: 1 } : {}); // the Fuzz script's validate() throws on it
    const ops = {
      hello: () => T.apply(p, { t: 'hello' }),
      snap: () => T.apply(p, { t: 'snap' }),
      name: () => T.apply(p, { t: 'name', name: `N${r.int(9)}` }),
      chat: () => T.apply(p, { t: 'chat', msg: `hi ${k}` }),
      rulesBtn: () => T.apply(p, { t: 'rulesBtn', id: r.pick(['quiet', 'quiet', 'quiet', 'round', 'veto', 'nope']) }),
      move: () => T.apply(p, { t: 'move', id: any(ids), ...xy(), ...boom() }),
      rot: () => T.apply(p, { t: 'rot', id: any(ids), rot: r.pick([0, 45, 90, 270]) }),
      flip: () => T.apply(p, { t: 'flip', id: any(ids), ...boom() }),
      shuffle: () => T.apply(p, { t: 'shuffle', id: any(piles) }),
      draw: () => T.apply(p, { t: 'draw', id: any(piles), ...boom() }),
      deal: () => T.apply(p, { t: 'deal', id: any(piles), up: r() < 0.5, ...xy() }),
      play: () => T.apply(p, { t: 'play', idx: hi, d: c.d, i: c.i, up: r() < 0.5, ...xy(), ...boom() }),
      handPile: () => T.apply(p, { t: 'handPile', idx: hi, d: c.d, i: c.i, pile: any(piles) }),
      toHand: () => T.apply(p, { t: 'toHand', id: any(cards) }),
      toPile: () => T.apply(p, { t: 'toPile', id: any(cards), pile: any(piles) }),
      stack: () => T.apply(p, { t: 'stack', id: any(cards), onto: any(cards) }),
      merge: () => T.apply(p, { t: 'merge', id: any(piles), pile: any(piles) }),
      del: () => T.apply(p, { t: 'del', id: any(ids) }),
      peek: () => T.apply(p, { t: 'peek', id: any(ids) }),
      addDeck: () => T.apply(p, { t: 'addDeck', deck: r() < 0.85 ? { name: 'Mini', cards: [{ n: 'one' }, { r: 'A', s: '♠' }, { txt: 'three' }] } : { cards: [] }, ...xy() }),
      size: () => T.apply(r() < 0.85 ? HOST : p, { t: 'size', size: r.pick([1300, 1800, 2400]) }),
      setRules: () => T.apply(r() < 0.9 ? HOST : p, r() < 0.75 ? { t: 'setRules', enabled: true, reset: r() < 0.3, code: r() < 0.6 ? FUZZ_RULES : RULES_TEMPLATES.turns } : { t: 'setRules', enabled: false }),
      join: () => { const q = r.pick([BOB, CAROL, DAVE]); T.join(q, `P${q[0]}`, keyOf(q)); },
      leave: () => T.leave(r.pick([BOB, CAROL, DAVE])),
      runTimers: () => T.runTimers(),
      refused: () => T.refreshFor(p, r.pick([{ t: 'move', id: any(ids) }, { t: 'play', idx: hi, d: c.d, i: c.i }, { t: 'toPile', id: any(cards), pile: any(piles) }])),
      't.deal': () => t.deal(any(piles), r() < 0.5 ? { ...xy(), up: r() < 0.5 } : { to: r.pick(players) }),
      't.dealToAll': () => t.dealToAll(any(piles), 1 + r.int(2), { onlineOnly: r() < 0.5 }),
      't.draw': () => t.draw(r.pick(players), any(piles), 1 + r.int(2)),
      't.takeHand': () => t.takeHand(r.pick(players), any(piles), r() < 0.5 ? undefined : (x) => x.i % 2 === 0),
      't.playFromHand': () => hand.length && t.playFromHand(p, r.int(hand.length), { ...xy(), up: r() < 0.5 }),
      't.toHand': () => t.toHand(r.pick(players), any(cards)),
      't.shuffle': () => t.shuffle(any(piles)),
      't.flip': () => t.flip(any(ids)),
      't.toPile': () => t.toPile(any(cards), any(piles)),
      't.stack': () => t.stack(any(cards), any(cards)),
      't.newPile': () => t.newPile(r() < 0.9 ? [{ d: 'x', i: 1 }, { d: 'x', i: 2, up: true }] : [], { ...xy(), name: r.pick(['Discard', '', 'Spare']) }),
      't.merge': () => t.merge(any(piles), any(piles)),
      't.move': () => t.move(any(ids), r() * 1300, r() * 1300),
      't.rot': () => t.rot(any(ids), r.pick([0, 90, 180])),
      't.remove': () => t.remove(any(ids)),
      't.newDeck': () => t.newDeck({ name: 'Scripted', cards: [{ name: 'x' }, { name: 'y' }] }),
      't.addStandardDeck': () => t.addStandardDeck({ ...xy(), jokers: r() < 0.3 }),
      't.say': () => t.say(`rules say ${k}`),
      't.announce': () => t.announce(`Banner ${k}`),
      't.win': () => s.rules && t.win([r.pick(players)], 'Won'),
      't.tell': () => t.tell(r.pick(players), 'psst'),
      't.schedule': () => s.rules && t.schedule(0, 'later'),
      't.public': () => s.rules && (t.public.note = k),
      't.data': () => s.rules && (t.data.n = k),
    };
    stats.total = Object.keys(ops).length + 1; // + the host reload
    const z0 = s.zMax, zs = new Map(ids.map((id) => [id, s.items[id].z]));
    const kind = k === 200 || k === 400 ? 'hostReload' : r.pick(Object.keys(ops));
    if (kind === 'hostReload') {
      T = createTable({ ...json(T.snapshot()), decks: json(s.decks) }, E);
      T.resume('Alice');
      W.hostReload(T);
    } else ops[kind]();
    stats.kinds.add(kind);
    const at = `seed ${seed}, op ${k} (${kind}${own(s.players, p) ? '' : ' by an unseated player'})`, S = T.state;
    // (1) T.pub, the full recompute and the spec's shapes
    const inc = Object.fromEntries(T.pub);
    stats.pub.see(inc, T.publicItems(), at, kind);
    stats.spec.see(inc, map(S.items, specItem), at, kind);
    // (4) a running max: never lower, never below an item, and whatever this op lifted sits above the old max
    const lifted = Object.keys(S.items).filter((id) => zs.get(id) !== S.items[id].z);
    const zBad = maxZ(S) > S.zMax || (kind !== 'hostReload' && (S.zMax < z0 || lifted.some((id) => !(S.items[id].z > z0))));
    if (!stats.z && zBad) stats.z = `${at}: zMax ${z0} → ${S.zMax}, top item ${maxZ(S)}`;
    // (3) the host trims after every entry
    if (!stats.caps && overCaps(S.log)) stats.caps = `${at}: the ${overCaps(S.log)} bucket is over its cap`;
    // (5) indexed reads agree with a scan, now and then
    if (!stats.reads && k % 25 === 0) {
      const before = JSON.stringify(S), why = readsDisagree(T);
      if (why || JSON.stringify(S) !== before) stats.reads = `${at}: ${why || 'a read changed the state'}`;
    }
    if (r() < 0.02) W.reload(dave);
    if (r() < 0.01) W.reload(anon);
    if (r() < 0.4 || kind === 'hostReload') { W.tick(); W.check(at); }
  }
  W.tick();
  W.check(`seed ${seed}, the end`);
  return { W, stats };
}

/** Mismatches between T.pub and a full view, each blamed on the op that
 *  started it (a stale item stays stale until touched again: later ops don't
 *  count it twice). `why` summarizes them, '' when there were none. */
function tally() {
  let prev = new Set(), first = '';
  const kinds = new Map();
  return {
    see(inc, full, at, kind) {
      const bad = isDeepStrictEqual(inc, full) ? new Set()
        : new Set([...Object.keys(inc), ...Object.keys(full)].filter((id) => !isDeepStrictEqual(inc[id], full[id])));
      const fresh = [...bad].filter((id) => !prev.has(id));
      if (fresh.length) {
        kinds.set(kind, (kinds.get(kind) || 0) + 1);
        first ||= `${at}: item ${fresh[0]} is ${JSON.stringify(inc[fresh[0]])} in T.pub, ${JSON.stringify(full[fresh[0]])} in full`;
      }
      prev = bad;
    },
    get why() { return first && `first: ${first}; ops that started one: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(', ')}`; },
  };
}

/** Runs fn with console.warn and console.error collected, not printed (the
 *  fuzz provokes refusals by the hundred); returns the distinct messages. */
function quietly(fn) {
  const seen = new Map(), keep = [console.warn, console.error];
  console.warn = console.error = (...a) => { const m = String(a[0]).slice(0, 60); seen.set(m, (seen.get(m) || 0) + 1); };
  try { fn(); } finally { [console.warn, console.error] = keep; }
  return [...seen].map(([m, c]) => `${c}× ${m}`);
}

(async () => {
  section('seeded 600-op runs, checked after every op and every tick');
  const kinds = new Set();
  let total = 0;
  for (const seed of seeds([1, 2, 3])) {
    await guard(`seed ${seed}`, () => {
      let run;
      const noise = quietly(() => { run = fuzz(seed, 600); });
      const { W, stats } = run;
      console.log(`    seed ${seed}: ${stats.kinds.size} op kinds, ${W.snaps} snapshots, ${W.patches} patches, ${W.skipped} sends skipped; console: ${noise.slice(0, 6).join(' | ')}`);
      stats.kinds.forEach((k) => kinds.add(k));
      total = stats.total;
      ok(!stats.pub.why, `(1) seed ${seed}: T.pub deep-equals publicItems() after every op${stats.pub.why && ` — ${stats.pub.why}`}`);
      ok(!stats.spec.why, `(1) seed ${seed}: and the public shapes of §1d (no face-down i, piles as n + top)${stats.spec.why && ` — ${stats.spec.why}`}`);
      ok(!W.bad.snap.length, `(2) seed ${seed}: T.snapContent() is the state's public view after every tick ${W.bad.snap.join('; ')}`);
      ok(!W.bad.wire.length, `(2) seed ${seed}: every body is bound to its peer, sorted, hand only for its owner, no hidden identity or seat key, and no gap ${W.bad.wire.join('; ')}`);
      ok(!W.bad.spec.length, `(2) seed ${seed}: patches folded by §1b.4 reproduce the next snapshot (items, players, log, hands, rules, size) for every peer ${W.bad.spec.join('; ')}`);
      ok(!W.bad.impl.length, `(2) seed ${seed}: so do core's viewFromSnap/applyViewPatch ${W.bad.impl.join('; ')}`);
      ok(W.skipped > 0 && W.afterSkip > 0, `(2) seed ${seed}: ticks that send a peer nothing keep its base, and its next patch applies (${W.skipped} skipped sends, ${W.afterSkip} patches after one)`);
      ok(!stats.z, `(4) seed ${seed}: zMax never drops, no item is above it, and every lifted item lands above the old max${stats.z ? ` — ${stats.z}` : ''}`);
      ok(!stats.caps, `(3) seed ${seed}: the host log never exceeds a bucket cap${stats.caps ? ` — ${stats.caps}` : ''}`);
      ok(!stats.reads, `(5) seed ${seed}: t.find, t.piles and t.item agree with a scan of the state every 25 ops, and change nothing${stats.reads ? ` — ${stats.reads}` : ''}`);
    });
  }
  ok(kinds.size === total, `every op kind ran: every Phase 1 action, the host's joins, leaves, timers and refusals, rules ops through T.api, a host reload (${kinds.size} of ${total})`);

  section('(2) private-only commits send nothing, and the next patch still follows');
  for (const seed of seeds([4])) {
    await guard(`seed ${seed}`, () => {
      const T = createTable({}, env(seed));
      T.open('Alice');
      T.join(BOB, 'Bob', keyOf(BOB));
      T.join(CAROL, 'Carol', keyOf(CAROL));
      T.apply(HOST, { t: 'setRules', enabled: true, code: FUZZ_RULES });
      const W = wire(T, `seed ${seed}`), self = W.add('peer-self', HOST), bob = W.add('peer-bob', BOB);
      W.add('peer-carol', CAROL);
      W.add('peer-anon', null);
      W.tick();
      const seq0 = T.state.seq, skipped0 = W.skipped;
      let sent = 0;
      for (let k = 0; k < 50; k++) {
        T.apply(BOB, { t: 'rulesBtn', id: 'quiet' }); // t.data and a timer: host-private
        W.tick();
        sent += W.sent.size;
        T.runTimers(); // onTimer writes t.data only
        W.tick();
        sent += W.sent.size;
      }
      ok(T.state.seq >= seq0 + 100 && T.api.data.fired === 50, `100 commits that change only rules data and timers (seq ${seq0} → ${T.state.seq})`);
      ok(sent === 0 && W.skipped - skipped0 === 400, `send nothing to anyone (${sent} bodies, ${W.skipped - skipped0} skipped sends)`);
      T.apply(BOB, { t: 'move', id: pileOf(T), x: 400, y: 400 });
      W.tick();
      W.check(`seed ${seed}`);
      const bodies = [...W.sent.values()].map((x) => JSON.parse(x));
      ok(bodies.length === 4 && bodies.every((b) => b.kind === 'patch' && b.base === seq0 && b.seq === T.state.seq), `a move then reaches every peer as a patch on the old base (${bodies.map((b) => `${b.base}→${b.seq}`)})`);
      ok(!W.bad.wire.length && !W.bad.spec.length && !W.bad.impl.length && self.spec.seq === T.state.seq && bob.spec.seq === T.state.seq,
        `with no gap, and every view equals the snapshot ${[...W.bad.wire, ...W.bad.spec, ...W.bad.impl].join('; ')}`);
    });
  }

  section('(3) trimLog: the newest of each bucket, however entries are batched');
  for (const seed of seeds([5])) {
    await guard(`seed ${seed}`, () => {
      const r = rng(seed);
      const mixed = Array.from({ length: 1000 }, (_, k) => ({ p: 'x', txt: `e${k}`, ts: k, ...(r() < 0.3 ? { c: 1 } : r() < 0.1 ? { k: 1 } : r() < 0.08 ? { n: 'old' } : {}) }));
      const copy = json(mixed), want = refTrim(mixed);
      let one = [];
      for (const e of mixed) one = trimLog([...one, e]); // the host: after every entry
      let batched = [];
      for (let k = 0; k < 1000;) { const m = 1 + r.int(120); batched = trimLog(batched.concat(mixed.slice(k, k + m))); k += m; } // a guest: per patch
      ok(canon(trimLog(mixed.slice())) === canon(want), `seed ${seed}: 1,000 mixed entries keep the newest 100 talk, 50 peeks and 200 actions, in order (${want.length} kept)`);
      ok(canon(one) === canon(want) && canon(batched) === canon(want), `seed ${seed}: one entry at a time and random batches keep the same entries`);
      ok(canon(mixed) === canon(copy), 'trimLog does not change its argument');
      const short = mixed.slice(0, 40);
      ok(canon(trimLog(short)) === canon(short), 'a log within the caps is kept whole');
    });
  }
  for (const seed of seeds([6])) {
    await guard(`seed ${seed}`, () => {
      const r = rng(seed), T = createTable({}, env(seed));
      T.open('Alice');
      T.join(BOB, 'Bob', keyOf(BOB));
      const P = pileOf(T);
      for (let k = 0; k < 12; k++) T.apply(HOST, { t: 'deal', id: P, x: 100 + 60 * k, y: 300 });
      const W = wire(T, `seed ${seed}`);
      W.add('peer-self', HOST);
      W.add('peer-bob', BOB);
      W.add('peer-anon', null);
      W.tick();
      const all = [...W.d.log], ids = Object.keys(T.state.items);
      let logged = 0, ticks = 0, ops = 0, diverged = '';
      const lines = [
        () => T.apply(HOST, { t: 'chat', msg: `host says ${ops}` }),
        () => T.apply(BOB, { t: 'chat', msg: `bob says ${ops}` }),
        () => T.apply(r.pick([HOST, BOB]), { t: 'name', name: `Name${r.int(13)}` }),
        () => T.apply(r.pick([HOST, BOB]), { t: 'peek', id: r.pick(ids) }),
        () => T.apply(r.pick([HOST, BOB]), { t: 'move', id: r.pick(ids), x: r() * 1000, y: r() * 1000 }),
        () => T.apply(r.pick([HOST, BOB]), { t: 'flip', id: r.pick(ids) }),
        () => T.api.say(`line ${ops}`),
      ];
      quietly(() => {
        while (logged < 1000) {
          for (let m = 1 + r.int(40); m > 0; m--, ops++) r.pick(lines)();
          W.tick();
          ticks++;
          all.push(...W.d.log);
          logged += W.d.log.length;
          const host = canon(T.state.log);
          const bad = W.peers.find((p) => canon(p.spec.log) !== host || canon(p.impl.log) !== host);
          if (bad && !diverged) diverged = `tick ${ticks}, peer ${bad.tp}`;
        }
      });
      ok(!diverged, `seed ${seed}: ${logged} mixed entries over ${ticks} ticks of 1–40 actions: every guest's log equals the host's after every tick${diverged ? ` — first divergence: ${diverged}` : ''}`);
      ok(canon(T.state.log) === canon(refTrim(all)) && Object.keys(CAPS).every((b) => T.state.log.filter((e) => bucket(e) === b).length === CAPS[b]),
        'the host log is the newest of each bucket of everything ever logged (all three buckets full)');
    });
  }
  await guard('250 lines from one action', () => {
    const T = createTable({}, env(7));
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Spam", buttons: () => [{ id: "go", label: "Go" }], onButton(t) { for (let k = 0; k < 250; k++) t.say("line " + k); } })' });
    const W = wire(T, '250 lines'), bob = W.add('peer-bob', BOB);
    W.tick();
    T.apply(BOB, { t: 'rulesBtn', id: 'go' });
    W.tick();
    const acts = (log) => log.filter((e) => bucket(e) === 'act').map((e) => e.txt);
    const want = Array.from({ length: 200 }, (_, k) => `line ${k + 50}`).join();
    ok(acts(T.state.log).join() === want, 'the host keeps exactly the newest 200 action entries: lines 50 to 249');
    ok(canon(bob.spec.log) === canon(T.state.log) && canon(bob.impl.log) === canon(T.state.log), 'and the guest keeps the same 200, folded by the spec and by applyViewPatch');
  });

  section('(4) z is a running max, restored by createTable');
  await guard('zTop', () => {
    const E = env(8), T = createTable({}, E), s = T.state, t = T.api;
    ok(s.zMax === 0, 'a new table starts at zMax 0');
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    const P = pileOf(T);
    ok(s.items[P].z === 1 && s.zMax === 1, 'the first item gets z 1');
    T.apply(BOB, { t: 'draw', id: P });
    T.apply(BOB, { t: 'draw', id: P });
    // each op returns the item it lifted, or lifts a new one
    const newest = (before) => Object.keys(s.items).find((id) => !before.includes(id));
    const card = () => Object.keys(s.items).find((id) => s.items[id].k === 'c');
    const lifts = [
      ['deal', () => { T.apply(HOST, { t: 'deal', id: P, x: 300, y: 300 }); }],
      ['deal', () => { T.apply(HOST, { t: 'deal', id: P, x: 500, y: 300 }); }],
      ['move', () => { const id = card(); T.apply(BOB, { t: 'move', id, x: 600, y: 600 }); return id; }],
      ['play', () => { const c = s.players[BOB].hand[0]; T.apply(BOB, { t: 'play', idx: 0, d: c.d, i: c.i, x: 400, y: 400 }); }],
      ['stack', () => { const [a, b] = Object.keys(s.items).filter((id) => s.items[id].k === 'c'); T.apply(HOST, { t: 'stack', id: a, onto: b }); }],
      ['addDeck', () => { T.apply(BOB, { t: 'addDeck', deck: { name: 'D', cards: [{ n: 'a' }] } }); }],
      ['t.newPile', () => t.newPile([{ d: 'x', i: 0 }], { x: 200, y: 200 })],
      ['t.move', () => { t.move(P, 700, 700); return P; }],
      ['t.playFromHand', () => t.playFromHand(BOB, 0, { x: 800, y: 300 })],
      ['t.deal', () => t.deal(P, { x: 900, y: 500 }).id],
      ['t.addStandardDeck', () => t.addStandardDeck({ x: 300, y: 800 })],
    ];
    const bad = [];
    for (const [what, op] of lifts) {
      const z0 = s.zMax, before = Object.keys(s.items), id = op() || newest(before);
      const others = Object.keys(s.items).filter((x) => x !== id).map((x) => s.items[x].z);
      if (!(s.items[id]?.z === z0 + 1 && s.zMax === z0 + 1 && others.every((z) => z < s.items[id].z))) bad.push(`${what}: z ${s.items[id]?.z}, zMax ${z0} → ${s.zMax}`);
    }
    ok(!bad.length, `each op that lifts an item gives it ++zMax, above every other item (${lifts.map(([w]) => w).join(', ')}) ${bad.join('; ')}`);
    const full = json(T.snapshot()), decks = json(s.decks);
    ok(full.zMax === s.zMax, 'the save carries zMax');
    ok(createTable({ ...json(full), decks }, E).state.zMax === s.zMax, 'createTable restores it');
    const top = Object.keys(s.items).find((id) => s.items[id].z === s.zMax), zTop = s.zMax;
    T.apply(HOST, { t: 'del', id: top });
    ok(s.zMax === zTop, `deleting the top item leaves zMax at ${zTop} (a running max, not a scan)`);
    T.apply(HOST, { t: 'deal', id: P, x: 300, y: 900 });
    ok(maxZ(s) === zTop + 1, 'the next item lands above the deleted one');
    T.apply(HOST, { t: 'del', id: Object.keys(s.items).find((id) => s.items[id].z === s.zMax) });
    const saved = json(T.snapshot()), T2 = createTable({ ...saved, decks }, E);
    ok(T2.state.zMax >= maxZ(saved) && T2.state.zMax <= saved.zMax, `a save whose top item was deleted resumes with zMax between its items' (${maxZ(saved)}) and its saved one (${saved.zMax}): ${T2.state.zMax}`);
    T2.resume('Alice');
    T2.apply(HOST, { t: 'deal', id: P, x: 500, y: 900 });
    const z2 = T2.state.zMax;
    ok(Object.values(T2.state.items).filter((it) => it.z === z2).length === 1 && maxZ(T2.state) === z2, 'and the first item dealt after the resume is on top of everything');
    const card41 = { k: 'c', x: 0, y: 0, rot: 0, z: 41, d: 'x', i: 0, up: true };
    ok(createTable({ v: 2, zMax: 3, items: { a: card41 }, players: {}, keys: {} }, E).state.zMax >= 41, 'a save whose zMax is below an item is lifted to that item');
    ok(createTable({ v: 2, items: { a: card41 }, players: {}, keys: {} }, E).state.zMax === 41, 'a save without zMax takes the largest item z');
    ok(createTable({ items: { a: card41 }, players: {} }, E).state.zMax === 41, 'so does a v1 save');
  });

  section('(5) t.item and t.find return detached copies');
  await guard('reads', () => {
    const T = createTable({}, env(9)), s = T.state, t = T.api;
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    const P = pileOf(T);
    t.deal(P, { x: 300, y: 300, up: true });
    t.deal(P, { x: 500, y: 300 });
    const discard = t.newPile([{ d: 'x', i: 0, up: true }, { d: 'x', i: 1 }], { x: 700, y: 300, name: 'Discard' });
    const spare = t.newPile([{ d: 'x', i: 2, up: true }], { x: 700, y: 600, name: 'Discard pile' });
    t.addStandardDeck({ x: 900, y: 300 });
    const [up, down] = Object.keys(s.items).filter((id) => s.items[id].k === 'c').sort((a, b) => s.items[b].up - s.items[a].up);
    const seq = s.seq, logN = s.log.length, state = JSON.stringify(s);
    ok(!readsDisagree(T), `t.find(q) for ${QUERIES.length} queries, t.piles() and t.item(id) agree with a scan of the state (${readsDisagree(T) || 'all'})`);
    ok(t.find({ name: 'DISCARD' }).map((x) => x.id).join() === discard && !t.find({ name: 'Discard' }).some((x) => x.id === spare), 'a name matches exactly, in any case');
    ok(t.find({ kind: 'card', up: true }).map((x) => x.id).join() === up && t.find({ kind: 'card', up: false }).map((x) => x.id).join() === down, 'up picks cards by their face');
    ok(['nope', '__proto__', 'constructor', 'toString'].every((id) => t.item(id) === null), 't.item is null for an unknown id (even one Object.prototype has)');
    const it = t.item(up), pile = t.item(P), found = t.find({ kind: 'pile' }), listed = t.piles();
    it.x = -1; it.up = false; delete it.d;
    pile.cards.pop(); pile.cards[0].up = 'x'; pile.cards.push({ d: 'zz', i: 9 }); pile.name = 'Mine';
    for (const x of [...found, ...listed]) { x.cards.length = 0; x.z = -5; }
    ok(JSON.stringify(s) === state, 'changing the copies (a pile\'s cards too) leaves the table untouched');
    ok(s.seq === seq && s.log.length === logN, 'reads are not logged and renumber nothing');
    const held = t.item(P), heldFound = t.find({ name: 'discard' })[0], n = held.cards.length;
    t.deal(P, { x: 400, y: 700 });
    t.toPile(down, discard);
    ok(held.cards.length === n && heldFound.cards.length === 2, 'and a copy held across ops does not change under its holder');
    t.remove(spare);
    T.apply(BOB, { t: 'merge', id: discard, pile: P });
    ok(t.item(spare) === null && t.item(discard) === null && !readsDisagree(T), 'removed and merged piles leave the index');
    const thrown = (q) => { try { t.find(q); return 'nothing'; } catch (e) { return e instanceof TypeError ? e.message : `a ${e.constructor.name}`; } };
    ok(thrown({ zone: 'a' }) === "t.find: unknown filter 'zone' — known: kind, name, up", `an unknown filter throws a TypeError naming the known ones (${thrown({ zone: 'a' })})`);
    ok(/unknown filter 'owner'/.test(thrown({ kind: 'card', owner: 'x' })), `even next to known ones (${thrown({ kind: 'card', owner: 'x' })})`);
  });

  section('(6) MIGRATE[1] lifts a v1 save');
  await guard('MIGRATE[1]', () => {
    const v1 = {
      seq: 9, size: 1800, guestDeckChars: 12, rules: null,
      items: {
        a1: { k: 'c', x: 400, y: 400, rot: 0, z: 7, d: 'dd', i: 1, up: true },
        b2: { k: 'p', x: 600, y: 600, rot: 90, z: 12, name: 'P', cards: [{ d: 'dd', i: 2, up: false }] },
        c3: { k: 'c', x: 800, y: 600, rot: 0, z: 3, d: 'dd', i: 3, up: false },
      },
      players: {
        [BOB]: { name: 'Bob', color: '#30bced', online: true, hand: [{ d: 'dd', i: 0 }], seat: 90, key: keyOf(BOB) },
        [CAROL]: { name: 'Carol', color: '#6eeb83', online: false, hand: [], seat: 270 },
      },
      log: [{ p: BOB, txt: 'joined the table', ts: 1 }],
    };
    const noKeys = (st) => ({ ...st, players: map(st.players, ({ key, ...pl }) => pl) });
    const m = MIGRATE[1](json(v1));
    ok(STATE_V === 2 && m.v === 2, 'v becomes 2 (STATE_V in Phase 1)');
    ok(canon(m.keys) === canon({ [BOB]: keyOf(BOB) }) && !Object.values(m.players).some((pl) => 'key' in pl), "Bob's seat key moves to keys; Carol, who had none, gets none; no player keeps one");
    ok(m.zMax === 12, 'zMax is the highest z');
    const { v, keys, zMax, ...rest } = m;
    ok(canon(rest) === canon(noKeys(v1)), 'everything else is unchanged');
    ok(canon(migrate(json(v1))) === canon(m), 'migrate() runs the chain up to STATE_V');
    const T = createTable(json(v1), { ...env(10) });
    ok(T.state.v === 2 && T.state.keys[BOB] === keyOf(BOB) && T.state.zMax === 12 && !('key' in T.state.players[BOB]), 'createTable lifts a v1 save');
    T.resume('Alice');
    const snap = json(T.snapshot());
    ok(snap.v === 2 && snap.keys[BOB] === keyOf(BOB) && snap.zMax === 12 && !('key' in snap.players[BOB]), 'and saves it as v2');
    const T2 = createTable(json(snap), env(10));
    ok(T2.state.keys[BOB] === keyOf(BOB), 'a v2 save keeps its keys (MIGRATE[1] does not run again)');
    T2.join(BOB, 'Bob', keyOf(DAVE));
    ok(T2.state.keys[BOB] === keyOf(BOB), "a later join doesn't rebind the seat");
    T2.apply(BOB, { t: 'chat', msg: 'hi' });
    const out = [JSON.stringify(T2.publicPlayers()), JSON.stringify(T2.snapContent()), JSON.stringify(T2.patchContent(T2.takeDirty())), JSON.stringify([...T2.pub])].join();
    ok(!out.includes('key-') && !/"keys?"/.test(out), 'no seat key in the public view, a snapshot, a patch or T.pub');
    const old = createTable({ items: { x1: { k: 'c', x: 5000, y: -900, rot: 0, z: 4, d: 'dd', i: 0, up: true } }, players: { [BOB]: { name: 'Bob', color: '#30bced', online: true, hand: [], key: keyOf(BOB) } } }, env(10));
    old.resume('Alice');
    const o = old.state, it = o.items.x1, r = playR(o.size);
    ok(o.v === 2 && o.keys[BOB] === keyOf(BOB) && o.zMax === 4, 'a save from before the round table lifts too');
    ok(o.size === 1300 && Array.isArray(o.log) && Number.isFinite(o.players[BOB].seat) && Math.hypot(it.x + CARD_W / 2 - o.size / 2, it.y + CARD_H / 2 - o.size / 2) <= r + 1e-9,
      'with its size defaulted, a log, a seat assigned and its stranded card pulled onto the felt');
    let newer;
    try { newer = createTable({ v: STATE_V + 1, items: {}, players: {} }, env(10)).state.v; } catch (e) { newer = `thrown: ${e.message}`; }
    ok(newer === STATE_V + 1 || /^thrown/.test(newer), `a save from a newer version is never downgraded (${newer})`);
  });

  section('(7) a veto or refusal re-sends what the action named, and the hand');
  await guard('vetoes', () => {
    const T = createTable({}, env(11)), s = T.state, t = T.api;
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    const P = pileOf(T);
    const c1 = t.deal(P, { x: 300, y: 300, up: true }).id, c2 = t.deal(P, { x: 500, y: 300 }).id;
    const Q = t.newPile([{ d: 'x', i: 0 }, { d: 'x', i: 1, up: true }], { x: 800, y: 300 });
    t.draw(BOB, P, 2);
    const h0 = s.players[BOB].hand[0];
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "No guests", validate: (t, a) => (a.p === t.hostId ? undefined : "no " + a.t) })' }); // a line per type: identical lines in a row collapse
    const W = wire(T, 'vetoes'), bob = W.add('peer-bob', BOB);
    W.add('peer-self', HOST);
    W.tick();
    const cases = [
      [{ t: 'move', id: c1, x: 900, y: 900 }, [c1]],
      [{ t: 'rot', id: c1, rot: 90 }, [c1]],
      [{ t: 'flip', id: c2 }, [c2]],
      [{ t: 'shuffle', id: P }, [P]],
      [{ t: 'draw', id: P }, [P], true],
      [{ t: 'deal', id: P, x: 300, y: 600, up: true }, [P]],
      [{ t: 'play', idx: 0, d: h0.d, i: h0.i, x: 400, y: 400, up: true }, [], true],
      [{ t: 'handPile', idx: 0, d: h0.d, i: h0.i, pile: Q }, [Q], true],
      [{ t: 'toHand', id: c1 }, [c1], true],
      [{ t: 'toPile', id: c1, pile: P }, [c1, P]],
      [{ t: 'stack', id: c1, onto: c2 }, [c1, c2]],
      [{ t: 'merge', id: Q, pile: P }, [Q, P]],
      [{ t: 'del', id: c2 }, [c2]],
      [{ t: 'peek', id: c2 }, [c2]],
      [{ t: 'addDeck', deck: { name: 'D', cards: [{ n: 'a' }] } }, []],
      [{ t: 'move', id: c1, ids: [c2, Q, 'nope'] }, [c1, c2, Q]],
      [{ t: 'stack', id: '__proto__', onto: 'nope', pile: c1 }, [c1], false, ['__proto__', 'nope']],
    ];
    /** Runs act (a refused action), ticks, and returns the first way it broke §1c, or '', and how many log lines it added. */
    const run = (act, named, handy, junk = []) => {
      const table = () => JSON.stringify({ items: s.items, players: s.players, decks: s.decks });
      const before = table(), seq = s.seq, logN = s.log.length;
      act();
      W.tick();
      const d = W.d, b = W.sent.has(bob) ? JSON.parse(W.sent.get(bob)) : {};
      const broke = [
        [table() !== before, 'the table changed'],
        [s.seq !== seq + 1, `seq ${seq} → ${s.seq}`],
        ...named.map((id) => [!d.items.has(id), `${id} not touched`]),
        ...named.map((id) => [canon(b.items?.[id]) !== canon(specItem(s.items[id])), `Bob's patch lacks the true ${id}`]),
        ...junk.map((id) => [d.items.has(id) || d.removed.has(id), `junk id ${id} touched`]),
        [handy && !(d.hands.has(BOB) && canon(b.hand) === canon(s.players[BOB].hand)), "Bob's hand not re-sent"],
      ].find(([bad]) => bad);
      return [broke?.[1] || '', s.log.length - logN];
    };
    const bad = [];
    for (const [a, named, handy, junk] of cases) {
      const [why, logged] = run(() => T.apply(BOB, a), named, handy, junk);
      if (why || logged !== 1) bad.push(`${JSON.stringify(a)}: ${why || `${logged} log lines`}`);
    }
    W.check('vetoes');
    ok(!bad.length, `each of ${cases.length} vetoed actions changes nothing but the log (its one line) and seq, touches every existing item it names (id, pile, onto, ids[]), ignores junk ids, and re-sends Bob's hand for draw, play, handPile and toHand ${bad.join('; ')}`);
    ok(!W.bad.wire.length && !W.bad.spec.length && !W.bad.impl.length, `Bob's view stays equal to the snapshot ${[...W.bad.wire, ...W.bad.spec, ...W.bad.impl].join('; ')}`);
    const [flood] = run(() => T.refreshFor(BOB, { t: 'play', idx: 0, d: h0.d, i: h0.i, pile: P }), [P], true);
    ok(!flood, `a flood refusal (T.refreshFor) re-sends the named pile and the hand, and renumbers ${flood}`);
    const [moved] = run(() => T.refreshFor(BOB, { t: 'move', id: c1, onto: '__proto__' }), [c1], false, ['__proto__']);
    ok(!moved, `and the named item of a refused move ${moved}`);
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Crash", validate: (t, a) => { if (a.p !== t.hostId) throw new Error("bug"); } })' });
    W.tick();
    const noise = quietly(() => { T.apply(BOB, { t: 'move', id: c1, x: 100, y: 900 }); });
    const before = specItem(s.items[c1]);
    W.tick();
    const b = W.sent.has(bob) ? JSON.parse(W.sent.get(bob)) : {};
    ok(!s.rules.enabled && W.d.items.has(c1) && canon(b.items?.[c1]) === canon(before) && canon(before) !== canon({ ...before, x: 100 }),
      `a validate() that throws fails closed: the move is refused, the rules disable, and the card's true spot goes out (${noise.length} console messages)`);
  });

  section('(8) one shared text, spliced per recipient, sealed as text');
  await guard('splice', async () => {
    const hand = [{ d: '0000000a', i: 3 }];
    const shared = ['{}', JSON.stringify({ v: PROTO, kind: 'patch', boot: 5, seq: 9, host: HOST, log: [{ p: BOB, txt: 'said "}{\\" , ]   😀', ts: 1 }] })];
    const mines = [{ to: BOB, tp: 'peer-1', base: 8 }, { to: BOB, tp: 'peer-1', base: 8, hand }, { to: null, tp: 'peer-2', base: 8 }, { to: BOB, tp: 'peer-1', hand }];
    const bad = [];
    for (const sh of shared) {
      for (const mine of mines) {
        const text = spliceBody(mine, sh);
        let body;
        try { body = JSON.parse(text); } catch (e) { bad.push(`${text}: ${e.message}`); continue; }
        if (!isDeepStrictEqual(body, { ...mine, ...JSON.parse(sh) })) bad.push(`${text} is not the two parts`);
        else if (text !== JSON.stringify(mine).slice(0, -1) + (sh === '{}' ? '}' : `,${sh.slice(1)}`)) bad.push(`${text} is not prefix + rest`);
      }
    }
    ok(!bad.length, `the body parses, and is the recipient's prefix {to, tp, base?, hand?} plus the shared rest, for an empty and a non-empty shared part, with and without a hand ${bad.join('; ')}`);
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64');
    const text = spliceBody(mines[1], shared[1]), sealed = await sealText(text, kp.privateKey, pub);
    const verify = (t) => crypto.subtle.verify(SIG, kp.publicKey, Buffer.from(sealed.s, 'base64'), new TextEncoder().encode(t));
    ok(sealed.b === text && sealed.k === pub && await verify(text), 'sealText signs the text itself: {b: the text, s, k: the public key}, and it verifies');
    ok(!(await verify(text.replace('"base":8', '"base":7'))), 'a changed body does not verify');
  });

  section('t.data has a size limit, checked once per job (§1e)');
  await guard('data cap', () => {
    const T = createTable({}, env(12));
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Hoard", validate() {}, onAction() {}, buttons: () => [{ id: "go", label: "Go" }], onButton(t) { t.data.big = "x".repeat(4e6); } })' });
    T.drain();
    const js = JSON.stringify, data = T.api.data;
    let n = 0;
    JSON.stringify = function (v, ...rest) { if (v === data) n++; return js.call(this, v, ...rest); };
    try { T.apply(BOB, { t: 'move', id: pileOf(T), x: 300, y: 300 }); } finally { JSON.stringify = js; }
    ok(n === 1, `a move runs validate, onAction and buttons, and measures t.data once (${n} times)`);
    const seq = T.state.seq;
    quietly(() => T.apply(BOB, { t: 'rulesBtn', id: 'go' }));
    ok(!T.state.rules.enabled && /^onButton\(\), onAction\(\), buttons\(\): t\.data is too large \(4,000,0\d\d chars, max 4,000,000\)$/.test(T.rulesError),
      `a hook that grows t.data past 4e6 chars disables the rules, naming the job's hooks ("${T.rulesError}")`);
    ok(T.drain().some((e) => e.t === 'toast' && /t\.data is too large/.test(e.msg)) && T.state.seq > seq, 'loudly, and the table is renumbered');
  });

  section('applyStatePatch mirrors a table (§1f: the seam for a rules Worker)');
  await guard('mirror', () => {
    const E = env(13), T = createTable({}, E);
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    const M = createTable(json(T.snapshot()), { ...env(13), pid: HOST });
    M.state.decks = json(T.state.decks);
    M.takeDirty();
    const pile = pileOf(T);
    T.takeDirty();
    T.apply(BOB, { t: 'draw', id: pile });
    T.apply(HOST, { t: 'deal', id: pile, x: 300, y: 300, up: true });
    T.apply(HOST, { t: 'addDeck', deck: { name: 'New', cards: [{ n: 'a' }] } });
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Mirror", setup(t) { t.public.x = 1; } })' });
    const d = T.takeDirty(), newDecks = T.drain().filter((e) => e.t === 'deck').map((e) => e.id);
    M.applyStatePatch(json({
      items: Object.fromEntries([...[...d.items].map((id) => [id, T.state.items[id]]), ...[...d.removed].map((id) => [id, null])]),
      players: Object.fromEntries([...d.players].map((p) => [p, T.state.players[p]])),
      decks: Object.fromEntries(newDecks.map((id) => [id, T.state.decks[id]])),
      rules: T.state.rules || undefined, log: d.log, zMax: T.state.zMax, refresh: [pile],
    }));
    const strip = (t) => canon({ ...t.snapshot(), seq: 0, decks: t.state.decks });
    ok(strip(M) === strip(T), 'the mirror equals the table after the patch');
    const md = M.takeDirty();
    ok(isDeepStrictEqual(Object.fromEntries(M.pub), M.publicItems()) && md.hands.has(BOB) && md.items.has(pile) && md.log.length === d.log.length,
      'its dirty sets and T.pub follow (the hand that changed, the items, the log)');
    ok(M.drain().some((e) => e.t === 'deck'), 'a new deck is announced for the decks channel');
  });

  section('regressions from the Phase 1A review');
  await guard('a draw by a player with no seat', () => {
    const T = createTable({}, env(14));
    T.open('Alice');
    const P = pileOf(T), before = canon(T.state.items[P]);
    T.takeDirty();
    quietly(() => T.apply(DAVE, { t: 'draw', id: P }));
    ok(canon(T.state.items[P]) === before && !own(T.state.players, DAVE) && isDeepStrictEqual(Object.fromEntries(T.pub), T.publicItems()),
      'takes nothing: the card stays on the pile, and T.pub still equals the table');
  });
  await guard('crafted keys', () => {
    const T = createTable({}, env(15));
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    const P = pileOf(T), evil = { toString: 1 }, threw = [];
    const tryIt = (what, fn) => { try { quietly(fn); } catch (e) { threw.push(`${what}: ${e.message}`); } };
    const hostile = [{ t: 'move', id: evil, x: 1, y: 1 }, { t: 'play', idx: 0, ids: [evil, P] }, { t: 'toPile', id: P, pile: evil, onto: [evil] },
      { t: 'chat', msg: evil }, { t: 'name', name: evil }, { t: 'rulesBtn', id: evil }, { t: 'size', size: evil }];
    for (const a of hostile) { tryIt(`apply ${a.t}`, () => T.apply(BOB, a)); tryIt(`refreshFor ${a.t}`, () => T.refreshFor(BOB, a)); }
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "No", validate: () => "no", buttons: () => [{ id: "x", label: "X" }] })' });
    for (const a of hostile) tryIt(`vetoed ${a.t}`, () => T.apply(BOB, a));
    tryIt('join', () => T.join(BOB, evil, keyOf(BOB)));
    ok(!threw.length, `peer values that can't be keys or text ({"toString": 1}) never throw out of apply, refreshFor or join ${threw.join('; ')}`);
  });
  await guard('a ruled action that does nothing', () => {
    const T = createTable({}, env(16)), t = T.api;
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    const P = pileOf(T), c1 = t.deal(P, { x: 300, y: 300 }).id;
    t.draw(BOB, P, 1);
    const W = wire(T, 'no-ops'), bob = W.add('peer-bob', BOB);
    W.tick();
    const bad = [];
    for (const [a, named, hand] of [[{ t: 'toPile', id: c1, pile: 'deadbeef' }, [c1]], [{ t: 'stack', id: c1, onto: 'deadbeef' }, [c1]], [{ t: 'merge', id: P, pile: 'deadbeef' }, [P]],
      [{ t: 'play', idx: 3, d: 'nope', i: 0, x: 400, y: 400 }, [], true], [{ t: 'draw', id: c1 }, [c1], true]]) {
      T.apply(BOB, a);
      W.tick();
      const b = W.sent.has(bob) ? JSON.parse(W.sent.get(bob)) : {};
      if (named.some((id) => canon(b.items?.[id]) !== canon(specItem(T.state.items[id]))) || (hand && canon(b.hand) !== canon(T.state.players[BOB].hand))) bad.push(a.t);
    }
    ok(!bad.length, `re-sends the items it named and the actor's hand, so an optimistic drop snaps back (toPile, stack and merge onto a vanished pile, a play of a card not in hand, a draw from a card) ${bad.join(', ')}`);
  });
  await guard('refusal re-sends are rate-limited', () => {
    const clock = { now: 1.7e12 }, T = createTable({}, { ...env(17), now: () => clock.now }), t = T.api;
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    for (let k = 0; k < 4; k++) t.addStandardDeck({ x: 300 + 100 * k, y: 300 });
    for (const P of t.piles().map((x) => x.id)) for (let k = 0; k < 52; k++) t.deal(P, { x: 200 + (k % 13) * 60, y: 200 + Math.floor(k / 13) * 80, up: true });
    const cards = Object.keys(T.state.items);
    T.takeDirty();
    const seq = T.state.seq;
    let any = 0;
    for (let k = 0; k < 400; k++) {
      const n = (i) => cards[(k * 11 + i) % cards.length];
      any += T.refreshFor(BOB, { t: 'play', id: n(0), pile: n(1), onto: n(2), ids: Array.from({ length: 50 }, (_, i) => n(3 + i)) });
    }
    const d = T.takeDirty();
    ok(cards.length >= 200 && any <= 10 && T.state.seq - seq === any && d.items.size <= 10 * 11,
      `400 flood refusals at once re-send at most a burst of 10, each naming at most 11 items (${any} re-sends, ${d.items.size} of ${cards.length} items, seq +${T.state.seq - seq})`);
    clock.now += 1000;
    const after = [T.refreshFor(BOB, { t: 'move', id: cards[0] }), T.refreshFor(BOB, { t: 'move', id: 'nope', ids: ['gone'] })];
    ok(after[0] === true && after[1] === false, 'the bucket refills (5 per second), and a refusal that names nothing on the table re-sends nothing and renumbers nothing');
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "No", validate: () => "no" })' });
    T.takeDirty();
    quietly(() => T.apply(BOB, { t: 'move', id: cards[0], x: 1, y: 1, ids: cards.slice(1, 201) }));
    ok(T.takeDirty().items.size <= 9, 'a vetoed action re-sends its id and at most 8 of its ids');
  });
  await guard('registration touches only what changed', () => {
    const T = createTable({}, env(18));
    T.open('Alice');
    T.join(BOB, 'Bob', keyOf(BOB));
    const P = pileOf(T);
    T.takeDirty();
    const seq = T.state.seq, again = T.join(BOB, 'Bob', keyOf(BOB)), d = T.takeDirty();
    ok(!again.changed && T.state.seq === seq && !d.players.size, `an action from a seated, online player registers nothing new: no player re-sent, no renumbering (seq ${seq} → ${T.state.seq})`);
    ok(!T.apply(BOB, { t: 'hello' }) && !T.apply(BOB, { t: 'snap' }) && T.state.seq === seq, 'a hello or a snapshot request changes nothing either');
    T.join(BOB, 'Bob', keyOf(BOB));
    T.apply(BOB, { t: 'move', id: P, x: 500, y: 500 });
    const c = T.patchContent(T.takeDirty());
    ok(Object.keys(c).sort().join() === 'items,log' && Object.keys(c.items).join() === P, `so a guest's move (registered on arrival) sends its item and its log line only (${Object.keys(c)})`);
    T.leave(BOB);
    T.takeDirty();
    const back = T.join(BOB, 'Bob', keyOf(BOB));
    ok(back.changed && back.back && T.takeDirty().players.has(BOB), 'one who comes back online is re-sent and renumbered');
    const old = createTable({ items: {}, players: { [CAROL]: { name: 'Carol', color: '#30bced', online: true, hand: [], seat: 90 } } }, env(18));
    const adopt = old.join(CAROL, 'Carol', keyOf(CAROL));
    ok(adopt.changed && old.state.keys[CAROL] === keyOf(CAROL), 'a seat without a key that adopts its first claimant changes the table (the save must keep the binding)');
  });
  await guard('the shared part never carries a recipient field', () => {
    const throwsOn = (k) => { try { sharedText({ v: PROTO, kind: 'patch', [k]: 1 }); return false; } catch (e) { return /may not carry/.test(e.message); } };
    ok(['to', 'tp', 'base', 'hand'].every(throwsOn) && sharedText({ v: PROTO, kind: 'patch', seq: 3 }) === '{"v":2,"kind":"patch","seq":3}'.replace('2', PROTO),
      'sharedText refuses to, tp, base and hand (JSON.parse keeps the last duplicate: a shared one would override the binding)');
  });
  await guard('an index the table does not match', () => {
    const T = createTable({}, env(19)), t = T.api;
    T.open('Alice');
    const id = t.deal(pileOf(T), { x: 300, y: 300 }).id;
    delete T.state.items[id]; // behind the table's back
    let found = null;
    const noise = quietly(() => { found = t.find({ kind: 'card' }); });
    ok(found.length === 0 && noise.some((m) => /index holds/.test(m)), `is said out loud (console.error), not trusted (${noise.join(' | ')})`);
  });

  report();
})().catch(crash);
