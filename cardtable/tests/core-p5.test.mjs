// Phase 5 (private material) in plain Node (spec §5l, core-p5.test.mjs), on
// the state core as app.js runs it: a host table whose broadcast ticks build
// every peer's body as app.js's broadcast() does (takeDirty, patchContent,
// mine, spliceBody) and fold it as a guest does (viewFromSnap,
// applyViewPatch) — and, while rules run, a Worker-like mirror whose every
// job's patch the host checks and takes (checkPatch). Sections follow §5l:
//  (1) The per-viewer reduction, every row of §5d: cards, piles, shown and
//      hidden pieces, `vis` pieces by pid and by seat, cupped dice, a box
//      missing, supplies, bags, hands — what each viewer folds, and that
//      overrides are per message, never sticky.
//  (2) Private zones: entering (a back; none: refused, or a TypeError),
//      'reveal' versus 'keep' on leaving, between zones of one owner, into
//      another owner's, po cleanup, a board's move firing nothing, a zone
//      with no owner, pulls, deals, takes, plays and splits into one.
//  (3) Peek of pieces (loud, vetoable, "You can already see it").
//  (4) hide and roll of hidden dice; flip, face; the private-piece rule;
//      roll lines; group hide; claims, toHand; forged fields.
//  (5) byVis touches on a seat change.
//  (6) MIGRATE[5].
//  (7) A random run of 500 ops with three viewers: each viewer's folded
//      patches equal its own full snapshot, and Mallory — a fourth peer,
//      never shown anything private — never receives a hidden identity
//      (a recursive scan of every body, and the per-item check).
//  (8) Export round trip of private material.
//  (9) The facade (t.hide, t.reveal, t.setVis, t.canSee, t.spawn's vis) on
//      the Worker path: the mirror's patches taken by the host, digests
//      equal; the setup grammar's vis and po; checkPatch's gates.
// (B22, B23) The budgets: a vis tile's move per recipient; a snapshot with
//      160 vis items for one recipient.
import { core, ok, section, report, crash, guard, json, canon, rng, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

const {
  createTable, boxFromDef, boxOfDef, cleanBox, scriptHooks, spliceBody, sharedText, viewFromSnap, applyViewPatch, hiddenFrom,
  PROTO, STATE_V, MIGRATE, migrate, MAX_VIS, RULED_ACTIONS, GROUP_OPS, PUBLIC_ACTIONS, RULES,
} = core;

// --- tools ------------------------------------------------------------------------
const J = (v) => JSON.stringify(v);
const MAL = DAVE; // Mallory: seated nowhere she sees anything private (a peer like the others)
/** Runs fn with console.warn / console.error collected, not printed: {value, warn, error}. */
function quietly(fn) {
  const got = { warn: [], error: [] }, keep = [console.warn, console.error];
  console.warn = (...a) => got.warn.push(a.map(String).join(' '));
  console.error = (...a) => got.error.push(a.map(String).join(' '));
  try { got.value = fn(); } finally { [console.warn, console.error] = keep; }
  return got;
}
/** The message fn throws, or ''. */
const thrown = (fn) => { try { quietly(fn); return ''; } catch (e) { return e.message; } };
const RECT = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
/** Face labels no shown piece ever carries in these tests: any of them in a body Mallory gets is a leak. */
const SECRET = /ZQX/;

/** The test box (the game.json authoring format): racks ('reveal', owned by
 *  their board's owner), a screen ('keep', north's), tiles and units with
 *  backs, a die under a cup back, a coin with no back, a bag of tiles. */
const PRIVY = {
  name: 'Privy', table: { shape: 'rect', w: 3000, h: 2000 },
  seats: [{ id: 'south', name: 'South', edge: 'bottom' }, { id: 'east', name: 'East', edge: 'right' }, { id: 'north', name: 'North', edge: 'top' }],
  backs: [{ id: 'tb', color: '#333' }, { id: 'cup', color: '#7c2d12' }, { id: 'ub', color: '#1e3a8a' }],
  pieces: [
    { id: 'rack', kind: 'board', w: 520, h: 140, zones: [{ id: 'r', poly: RECT(520, 140), owner: 'board', private: 'reveal' }] },
    { id: 'screen', kind: 'board', w: 600, h: 300, zones: [{ id: 's', poly: RECT(600, 300), owner: 'seat:north', private: 'keep' }] },
    { id: 'mat', kind: 'board', w: 400, h: 200, zones: [{ id: 'm', poly: RECT(400, 200), owner: 'seat:nowhere', private: 'keep' }] },
    { id: 'tile', kind: 'tile', w: 60, h: 120, back: 'tb', hand: true, faces: [{ label: 'ZQXA' }, { label: 'ZQXB' }, { label: 'ZQXC' }] },
    { id: 'gem', kind: 'tile', w: 60, h: 120, back: 'tb', hand: true, faces: [{ label: 'ZQXG' }] },
    { id: 'd6', kind: 'die', back: 'cup' },
    { id: 'unit', kind: 'token', shape: 'rect', w: 60, back: 'ub', faces: [{ label: 'ZQXK' }, { label: 'ZQXP' }] },
    { id: 'coin', kind: 'token', faces: ['C'] },
  ],
  setup: [
    { piece: 'rack', at: [200, 1750], owner: 'seat:south', id: 'aaaa0001' },
    { piece: 'rack', at: [800, 1750], owner: 'seat:south', id: 'aaaa0002' },
    { piece: 'rack', at: [200, 100], owner: 'seat:north', id: 'aaaa0003' },
    { piece: 'rack', at: [1400, 1750], id: 'aaaa0004' }, // (no owner: its zone does nothing)
    { piece: 'screen', at: [1200, 800], id: 'aaaa0005' },
    { piece: 'mat', at: [2400, 1500], id: 'aaaa0006' }, // (its owner's seat doesn't exist: nothing)
    { piece: 'tile', at: [100, 1000], id: 'bbbb0001' },
    { piece: 'tile', at: [180, 1000], f: 1, id: 'bbbb0002' },
    { piece: 'gem', at: [260, 1000], up: false, id: 'bbbb0003' },
    { piece: 'd6', at: [600, 1000], id: 'bbbb0004' },
    { piece: 'd6', at: [680, 1000], id: 'bbbb0005' },
    { piece: 'd6', at: [760, 1000], id: 'bbbb0006' },
    { piece: 'd6', at: [840, 1000], id: 'bbbb0007' },
    { piece: 'unit', at: [2000, 1000], id: 'bbbb0008' },
    { piece: 'unit', at: [2080, 1000], f: 1, id: 'bbbb0009' },
    { piece: 'coin', at: [700, 1300], id: 'bbbb000a' },
    { bag: [{ t: 'tile', up: false, n: 5 }], name: 'Pool', at: [2600, 300], id: 'bbbb000b' },
    { piece: 'unit', at: [2200, 1000], n: 3, id: 'bbbb000c' },
  ],
};
const ID = { rackS: 'aaaa0001', rackS2: 'aaaa0002', rackN: 'aaaa0003', rackX: 'aaaa0004', screen: 'aaaa0005', mat: 'aaaa0006',
  t1: 'bbbb0001', t2: 'bbbb0002', gem: 'bbbb0003', d1: 'bbbb0004', d2: 'bbbb0005', d3: 'bbbb0006', d4: 'bbbb0007', u1: 'bbbb0008', u2: 'bbbb0009', coin: 'bbbb000a', bag: 'bbbb000b', stack: 'bbbb000c' };

/** A room as app.js runs one: the host table `H` (Alice, south), Bob (north),
 *  Carol (east), Mallory (watching), the PRIVY box set up; `peers`: each
 *  player's view as their bodies fold (broadcast()); a mirror `M` while
 *  rules run, as core-p4's room(): job(p, a) runs a job where it runs and
 *  returns {notes, lines, fx, error?}. `prefix`: the room's ids. */
function room(o = {}) {
  let n = 0, ready = null;
  const clk = { t: 1.7e12 }, uid = () => (o.prefix || 'f') + (++n).toString(16).padStart(7, '0');
  const pageHooks = {
    load: () => '', has: (h) => h === 'onSelect' && !!ready?.wants.includes('select'),
    flag: (k) => (k === 'strict' ? ready?.strict : undefined), call(h) { throw new Error(`${h}() ran on the page`); },
  };
  const H = quietly(() => createTable({}, { pid: HOST, now: () => (clk.t += 250), uid, hooks: pageHooks })).value;
  H.open('Alice');
  for (const [p, nm] of [[BOB, 'Bob'], [CAROL, 'Carol'], [MAL, 'Mallory']]) quietly(() => H.apply(p, { t: '_join', name: nm }));
  const R = { H, M: null, clk, peers: new Map([HOST, BOB, CAROL, MAL].map((p) => [p, { view: null, bodies: [], texts: [] }])) };
  const start = (code) => {
    H.syncSpots();
    const { keys, decks, boxes, boxSrc, ...state } = H.state, m = structuredClone({ state, decks, boxes, boxSrc }), hk = scriptHooks();
    const nm = hk.load(code);
    R.M = quietly(() => createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid: HOST, now: () => clk.t, uid: () => 'e' + (++n).toString(16).padStart(7, '0'), hooks: hk, mirror: true })).value;
    ready = { name: nm, wants: hk.has('onSelect') ? ['select'] : [], strict: hk.flag('strict') === true };
  };
  R.job = (p, a) => {
    const n0 = H.state.log.length;
    let error;
    if (a.t === 'setRules' && p === HOST && a.enabled) start(a.code);
    else if (a.t === 'setRules' && p === HOST) R.M = null;
    if (R.M) {
      const r = quietly(() => R.M.job(p, a)).value;
      if (r.fatal) throw new Error(`fatal: ${r.fatal}`);
      quietly(() => H.applyStatePatch(structuredClone(r.patch), structuredClone(r.out), { p, a }));
      R.M.drain();
      error = r.out.error;
    } else quietly(() => H.apply(p, a));
    const fx = H.drain();
    if (!H.state.rules?.enabled) R.M = null;
    return { fx, notes: fx.filter((e) => e.t === 'note' && e.p === p).map((e) => e.msg), peeks: fx.filter((e) => e.t === 'peek'), lines: H.state.log.slice(n0), error };
  };
  R.same = () => !R.M || H.digest() === R.M.digest();
  /** One broadcast tick as app.js's broadcast(): every peer's body built from
   *  one shared text, spliced with its own part, then folded into its view.
   *  {pid: [body, its text]}. */
  R.tick = () => {
    const d = H.takeDirty(), content = H.patchContent(d), seq = H.state.seq, head = { v: PROTO, boot: 1, seq, host: HOST };
    const patch = sharedText({ ...head, kind: 'patch', ...content }), empty = !Object.keys(content).length;
    let snap = '';
    const snapText = () => (snap ||= sharedText({ ...head, kind: 'snap', ...H.snapContent(), fx: [], ann: [] }));
    const out = {};
    for (const [p, P] of R.peers) {
      let text;
      if (!P.view) text = spliceBody({ to: p, tp: p, ...H.mine(p) }, snapText());
      else {
        const parts = H.mine(p, d);
        if (empty && !Object.keys(parts).length) continue;
        text = spliceBody({ to: p, tp: p, base: P.view.seq, ...parts }, patch);
      }
      const body = JSON.parse(text);
      P.bodies.push(body);
      P.texts.push(text);
      if (body.kind === 'snap') P.view = viewFromSnap(body);
      else applyViewPatch(P.view, body);
      out[p] = [body, text];
    }
    return out;
  };
  /** What player p's full snapshot would show now (call right after a tick: it resets what the host last sent). */
  R.fresh = (p) => viewFromSnap(JSON.parse(spliceBody({ to: p, tp: p, ...H.mine(p) }, sharedText({ v: PROTO, boot: 1, seq: H.state.seq, host: HOST, kind: 'snap', ...H.snapContent(), fx: [], ann: [] }))));
  R.it = (id) => H.state.items[id];
  /** A host action outside a job's checks here (setting the scene): applied, its effects dropped. */
  R.set = (p, a) => { quietly(() => H.apply(p, a)); H.drain(); };
  /** A facade call made straight on the host's table (no hook): its value, with the rules' lines it queued written (as a job's end writes them) and its effects dropped. */
  R.api = (fn) => { const v = fn(H.api); H.snapshot(); H.drain(); return v; };
  R.view = (p) => R.peers.get(p).view;
  if (o.box !== false) {
    const r = quietly(() => H.apply(HOST, { t: 'loadBox', box: boxFromDef(o.def || PRIVY), setup: true, clear: true }));
    if (!r.value) throw new Error(`the test box didn't set up: ${J(H.drain())}`);
    H.drain();
  }
  R.tick();
  return R;
}
/** The fields a piece's private state carries, for comparisons. */
const priv = (it) => (it ? { up: it.up ?? true, vis: it.vis ?? null, pv: it.pv ?? null, po: it.po ?? null, owner: it.owner ?? null } : null);
/** Every item hidden from player p on host table H, with what each is. */
const hiddenTo = (H, p) => {
  const holder = (s) => Object.keys(H.state.players).find((q) => H.state.players[q].seatId === s) || null;
  return new Set(Object.entries(H.state.items).filter(([, it]) => hiddenFrom(p, it, holder)).map(([id]) => id));
};
/** Why body `b` (received by p, while `hid` were hidden from p) carries a hidden identity, or '': the
 *  items, overrides and places of hidden ids carry no t, f, vis, up, pv or po; no `vis`
 *  override for a hidden id; and no SECRET label in the text but those `shown` (the labels
 *  of the faces p's view showed before or after it: a log line may name what was public). */
function leak(b, text, hid, shown = new Set()) {
  for (const [k, m] of [['items', b.items], ['vis', b.vis]]) {
    for (const [id, it] of Object.entries(m || {})) {
      if (!hid.has(id)) continue;
      if (k === 'vis') return `a vis override for ${id}`;
      const bad = ['t', 'f', 'vis', 'up', 'pv', 'po'].find((f) => f in it);
      if (bad) return `${id} carries ${bad}`;
    }
  }
  for (const [id, m] of Object.entries(b.pos || {})) if (hid.has(id) && m.length > 5) return `${id}'s place carries more`;
  const bad = (text.match(/ZQX[A-Z]/g) || []).find((l) => !shown.has(l));
  return bad ? `a secret label in ${text.match(new RegExp(`.{0,60}${bad}.{0,20}`))[0]}` : '';
}
/** The face labels view V shows (shown pieces, and pile tops), by box map `boxes`. */
function labelsShown(V, boxes) {
  const out = new Set(), add = (m) => { const [b, ty] = m.t.split('/'), l = boxes[b]?.types[ty]?.faces[m.f]?.label; if (l) out.add(l); };
  for (const it of Object.values(V.items)) {
    if (it.k === 'g' && 't' in it) add(it);
    if (it.k === 'p' && it.top?.t && it.top.up) add(it.top);
  }
  return out;
}
/** A recursive scan of JSON `v` for a type ref of the hidden `types` (object values under a `t` key) — '' or the path. */
function scanT(v, types, at = '') {
  if (Array.isArray(v)) { for (let k = 0; k < v.length; k++) { const f = scanT(v[k], types, `${at}[${k}]`); if (f) return f; } return ''; }
  if (!v || typeof v !== 'object') return '';
  for (const [k, x] of Object.entries(v)) {
    if (k === 't' && types.has(x)) return `${at}.t = ${x}`;
    const f = scanT(x, types, `${at}.${k}`);
    if (f) return f;
  }
  return '';
}

// --- (1) the reduction -------------------------------------------------------------------
function testReduction() {
  section('(1) the per-viewer reduction, every row of §5d (spec §5b, §5d)');
  const R = room(), H = R.H, it = R.it;
  ok(H.state.v === STATE_V && STATE_V === 6 && PROTO === 6 && MAX_VIS === 8, `PROTO 6, STATE_V 6, MAX_VIS 8 (${PROTO}, ${STATE_V}, ${MAX_VIS})`);
  ok(J(Object.fromEntries(Object.entries(H.state.players).map(([p, pl]) => [pl.name, pl.seatId ?? null]))) === J({ Alice: 'south', Bob: 'north', Carol: 'east', Mallory: null }),
    'Alice sits south, Bob north, Carol east, Mallory watches');
  // a shown piece, a piece hidden from everyone, a card, a bag: the same to everyone, no override
  const same = (id) => [HOST, BOB, CAROL, MAL].every((p) => J(R.view(p).items[id]) === J(H.pub.get(id)));
  ok([ID.t1, ID.gem, ID.bag, ID.rackS].every(same) && R.view(MAL).items[ID.gem].b && !('t' in R.view(HOST).items[ID.gem]), 'shown pieces, a piece hidden from everyone ({b}), a bag, a board: one form for all');
  // Alice cups a die: hers in full, a back to everyone else
  let r = R.job(HOST, { t: 'hide', ids: [ID.d1] });
  let b = R.tick();
  const full = R.view(HOST).items[ID.d1], red = R.view(BOB).items[ID.d1];
  ok(J(Object.keys(full)) === J(['k', 't', 'f', 'x', 'y', 'rot', 'z', 'owner', 'up', 'vis']) && full.up === false && J(full.vis) === J([HOST]) && full.f === it(ID.d1).f && full.owner === HOST,
    `the cupped die to Alice: {k, t, f, x, y, rot, z, owner, up: false, vis} (${J(full)})`);
  ok(J(Object.keys(red)) === J(['k', 'b', 'x', 'y', 'rot', 'z', 'owner']) && red.b.endsWith('/cup') && J(R.view(CAROL).items[ID.d1]) === J(red) && J(R.view(MAL).items[ID.d1]) === J(red),
    `to Bob, Carol and Mallory: {k, b: the cup, x, y, rot, z, owner} (${J(red)})`);
  ok(!!b[HOST][0].vis?.[ID.d1] && !b[BOB][0].vis && !b[CAROL][0].vis && !b[MAL][0].vis && b[BOB][0].items[ID.d1] && J(b[BOB][0].items[ID.d1]) === J(red),
    "the override travels in Alice's body alone; the shared items carry the reduced form");
  ok(r.lines.map((e) => e.txt).join() === 'hid d6', `the line: "hid d6" (${J(r.lines.map((e) => e.txt))})`);
  // per message, never sticky: a reveal re-sends the shown form, which replaces Alice's
  R.job(HOST, { t: 'flip', id: ID.d1 });
  b = R.tick();
  ok(!b[HOST][0].vis && J(R.view(HOST).items[ID.d1]) === J(H.pub.get(ID.d1)) && 't' in R.view(BOB).items[ID.d1] && !('vis' in R.view(HOST).items[ID.d1]),
    'revealed: everyone holds the shown form, the override gone with the message that carried it');
  // a seat-ref vis: Bob (north) sees it; the others don't
  R.api((t) => t.hide(ID.u1, ['seat:north']));
  R.tick();
  ok('t' in R.view(BOB).items[ID.u1] && J(R.view(BOB).items[ID.u1].vis) === J(['seat:north']) && !('t' in R.view(HOST).items[ID.u1]) && !('t' in R.view(CAROL).items[ID.u1]) && !('owner' in R.view(BOB).items[ID.u1]),
    "t.hide(id, ['seat:north']): north's occupant sees it in full; nobody owns it");
  // owner changes show in both forms
  R.set(HOST, { t: 'owner', id: ID.u1, to: 'seat:east' });
  R.tick();
  ok(R.view(BOB).items[ID.u1].owner === 'seat:east' && R.view(MAL).items[ID.u1].owner === 'seat:east' && 't' in R.view(BOB).items[ID.u1], 'an owner change shows in the full form and in the reduced one');
  // a pile whose top is a hidden piece: {b, up: false} to everyone
  R.set(HOST, { t: 'stack', id: ID.t2, onto: ID.t1 });
  R.set(HOST, { t: 'flip', id: Object.keys(H.state.items).find((k) => it(k).k === 'p') });
  R.tick();
  const pile = Object.keys(H.state.items).find((k) => it(k).k === 'p');
  ok([HOST, BOB, MAL].every((p) => J(R.view(p).items[pile].top) === J({ b: it(pile).cards.at(-1).t.split('/')[0] + '/tb', up: false })), 'a pile whose top is a hidden piece: {b, up: false} to everyone');
  // a box missing: no override can be built — {b: null} for everyone, Alice too
  const T = quietly(() => createTable({ items: { x1: { k: 'g', t: 'dead0001/a', f: 0, up: false, vis: [HOST], owner: HOST, po: 1, x: 10, y: 10, rot: 0, z: 1 } }, players: {} }, { pid: HOST })).value;
  T.open('Alice');
  T.takeDirty();
  ok(T.pub.get('x1').b === null && !('t' in T.pub.get('x1')) && !T.mine(HOST).vis, 'a hidden piece whose box is missing: {b: null} for everyone, and no override (the host can build none)');
  // a hand: its owner's alone
  R.set(CAROL, { t: 'toHand', id: ID.gem });
  R.tick();
  ok(J(R.view(CAROL).hand) === J([{ t: it(ID.stack).t.replace('unit', 'gem'), f: 0, up: false }]) && !R.view(MAL).hand.length && R.view(MAL).players[CAROL].handCount === 1,
    "a piece hidden from everyone taken into Carol's hand: hers ({t, f, up: false}); Mallory sees a count");
  // an unregistered peer gets no override
  ok(!Object.keys(H.mine(null)).length && !Object.keys(H.mine('ffffffffffffffff')).length, 'a peer that is no registered player gets no part of its own (no vis)');
}

// --- (2) private zones ------------------------------------------------------------------------
function testZones() {
  section('(2) private zones: entering, reveal vs keep, same owner, another owner, po, board moves (spec §5a)');
  const R = room(), H = R.H, it = R.it, rack = (id) => it(id), at = (id, dx = 0) => ({ x: rack(id).x + 100 + dx, y: rack(id).y + 10 });
  // entering Alice's rack (owner 'seat:south'): hidden for that seat, pv, owned (po)
  let r = R.job(HOST, { t: 'move', id: ID.t1, ...at(ID.rackS) });
  ok(J(priv(it(ID.t1))) === J({ up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }), `a tile placed on Alice's rack: up false, vis [seat:south], pv, owner seat:south, po (${J(priv(it(ID.t1)))})`);
  ok(r.lines.map((e) => e.txt).join() === 'moved a hidden piece', `logged without its name (${J(r.lines.map((e) => e.txt))})`);
  R.tick();
  ok('t' in R.view(HOST).items[ID.t1] && !('t' in R.view(BOB).items[ID.t1]), 'Alice sees it; Bob gets its back');
  // between zones of the same owner: nothing changes
  const z0 = J(priv(it(ID.t1)));
  R.job(HOST, { t: 'move', id: ID.t1, ...at(ID.rackS2) });
  ok(J(priv(it(ID.t1))) === z0 && it(ID.t1).x > rack(ID.rackS2).x, 'moved to her second rack: nothing else changes');
  // leaving a 'reveal' zone: face up, vis, pv, owner and po gone
  r = R.job(HOST, { t: 'move', id: ID.t1, x: 1000, y: 1200 });
  ok(J(priv(it(ID.t1))) === J({ up: true, vis: null, pv: null, po: null, owner: null }), `played off the rack: face up for everyone, its owner gone (${J(priv(it(ID.t1)))})`);
  // a real owner is kept: entering doesn't set po, leaving doesn't take it
  R.set(HOST, { t: 'owner', id: ID.t2, to: HOST });
  R.job(HOST, { t: 'move', id: ID.t2, ...at(ID.rackS) });
  ok(J(priv(it(ID.t2))) === J({ up: false, vis: ['seat:south'], pv: 1, po: null, owner: HOST }), `Alice's own tile on her rack: hidden, no po, her owner kept (${J(priv(it(ID.t2)))})`);
  R.job(HOST, { t: 'move', id: ID.t2, x: 1000, y: 1300 });
  ok(J(priv(it(ID.t2))) === J({ up: true, vis: null, pv: null, po: null, owner: HOST }), 'taken off: shown, still hers');
  // into another owner's zone: re-applied for the new owner (a po owner follows the zone)
  R.job(HOST, { t: 'move', id: ID.t1, ...at(ID.rackS) });
  r = R.job(HOST, { t: 'move', id: ID.t1, ...at(ID.rackN) });
  ok(J(priv(it(ID.t1))) === J({ up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), `from Alice's rack onto Bob's: his now, hidden from her (${J(priv(it(ID.t1)))})`);
  r = R.job(HOST, { t: 'move', id: ID.t1, x: 900, y: 900 });
  ok(r.notes.join() === '🚫 That belongs to North' && it(ID.t1).vis[0] === 'seat:north', `Alice can't take it back (${r.notes})`);
  // a 'keep' zone (the screen, north's): leaving keeps it hidden, pv goes
  r = R.job(BOB, { t: 'move', id: ID.u2, x: it(ID.screen).x + 200, y: it(ID.screen).y + 100 });
  ok(J(priv(it(ID.u2))) === J({ up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), `a unit behind north's screen: hidden for north (${J(priv(it(ID.u2)))})`);
  R.job(BOB, { t: 'move', id: ID.u2, x: 1500, y: 300 });
  ok(J(priv(it(ID.u2))) === J({ up: false, vis: ['seat:north'], pv: null, po: 1, owner: 'seat:north' }), `moved out from behind it: still hidden from the others, pv gone (${J(priv(it(ID.u2)))})`);
  R.job(BOB, { t: 'move', id: ID.u2, x: it(ID.screen).x + 300, y: it(ID.screen).y + 100 });
  ok(it(ID.u2).pv === 1, 'back behind its screen: pv again');
  // a piece with no hidden side: refused for a person, before anything changed
  const c0 = J(it(ID.coin));
  r = R.job(HOST, { t: 'move', id: ID.coin, ...at(ID.rackS) });
  ok(r.notes.join() === '🚫 That piece has no hidden side' && J(it(ID.coin)) === c0, `the coin (no back) onto a rack: refused, unmoved (${r.notes})`);
  ok(/no hidden side/.test(thrown(() => H.api.move(ID.coin, at(ID.rackS).x, at(ID.rackS).y))), 'a script moving it there: a TypeError');
  H.drain();
  // zones that resolve to nobody do nothing
  R.job(HOST, { t: 'move', id: ID.t2, ...at(ID.rackX) });
  R.job(HOST, { t: 'move', id: ID.d2, x: it(ID.mat).x + 100, y: it(ID.mat).y + 50 });
  ok(it(ID.t2).up !== false && it(ID.d2).up !== false && !it(ID.t2).vis && !it(ID.d2).vis, 'a rack nobody owns, a zone of a seat the table lacks: nothing hidden');
  // a board's move fires nothing: the rack moved away from its tile, or onto another
  const t1 = priv(it(ID.t1));
  R.set(HOST, { t: 'lock', id: ID.rackN, on: false }); // (boards spawn locked; the host unlocks)
  ok(R.job(HOST, { t: 'move', id: ID.rackN, x: 2400, y: 100 }).notes.join() === '🚫 That belongs to North' && it(ID.rackN).x === 200, "the host may not move Bob's rack: it is North's (D17)");
  r = R.job(BOB, { t: 'move', id: ID.rackN, x: 2400, y: 100 });
  ok(!r.notes.length && it(ID.rackN).x === 2400 && J(priv(it(ID.t1))) === J(t1), "Bob moves his rack out from under his tile: the tile stays as it was");
  R.set(HOST, { t: 'lock', id: ID.rackS2, on: false });
  const t3 = J(priv(it(ID.t2)));
  R.job(HOST, { t: 'move', id: ID.rackS2, x: it(ID.t2).x - 100, y: it(ID.t2).y });
  ok(J(priv(it(ID.t2))) === t3 && it(ID.t2).up !== false, 'a rack moved under a shown tile: it stays shown');
  // leaving where the zone no longer lies (moved away): 'keep' — it stays hidden
  R.job(BOB, { t: 'move', id: ID.t1, x: 1700, y: 600 });
  ok(J(priv(it(ID.t1))) === J({ up: false, vis: ['seat:north'], pv: null, po: 1, owner: 'seat:north' }), `a rack tile whose rack moved away, then moved: stays hidden (the zone it left is no longer under it: 'keep') (${J(priv(it(ID.t1)))})`);
  // new pieces into a zone: pull, deal, take, play, split
  const pz = { x: it(ID.rackS).x + 300, y: it(ID.rackS).y + 10 };
  r = R.job(HOST, { t: 'pull', id: ID.bag, ...pz });
  const pulled = Object.keys(H.state.items).find((k) => it(k).k === 'g' && it(k).pv && it(k).x === pz.x + 0 && !Object.values(ID).includes(k)) || Object.keys(H.state.items).find((k) => !Object.values(ID).includes(k) && it(k).pv);
  ok(pulled && J(priv(it(pulled))) === J({ up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }) && r.lines.map((e) => e.txt).join() === 'drew a piece from the bag Pool',
    `a pull straight into Alice's rack lands hidden there (${J(priv(it(pulled)))}; ${J(r.lines.map((e) => e.txt))})`);
  r = R.job(HOST, { t: 'split', id: ID.stack, n: 1, x: it(ID.screen).x + 100, y: it(ID.screen).y + 100 });
  const sp = Object.keys(H.state.items).find((k) => it(k).k === 'g' && it(k).t.endsWith('/unit') && it(k).pv && k !== ID.u2);
  ok(sp && J(priv(it(sp))) === J({ up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), `a unit split off a stack onto north's screen: hidden for north (${J(priv(it(sp)))})`);
  R.set(HOST, { t: 'toHand', id: ID.gem });
  r = R.job(HOST, { t: 'play', idx: 0, type: it(ID.t2).t.replace('tile', 'gem'), f: 0, ...pz });
  const played = r.fx.find((e) => e.t === 'fx')?.f.id;
  ok(played && J(priv(it(played))) === J({ up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }) && /^played a piece face down from hand/.test(r.lines.at(-1)?.txt), `played from hand onto the rack: hidden there, "played a piece face down" (${J(r.lines.map((e) => e.txt))})`);
  // a split off a rack's stack, onto the table: revealed (the rack it left, read where the stack lies)
  const st = R.api((t) => t.spawn(it(ID.stack).t, { at: { x: it(ID.rackS).x + 400, y: it(ID.rackS).y + 20, free: true }, n: 3 }));
  ok(it(st).pv === 1 && it(st).n === 3, 'a ×3 stack spawned on the rack: hidden there');
  R.job(HOST, { t: 'split', id: st, n: 1, x: 1600, y: 1500 });
  const off = Object.keys(H.state.items).find((k) => it(k).k === 'g' && it(k).x === 1600 && it(k).y === 1500);
  ok(off && it(off).up !== false && !it(off).vis && !it(off).owner && it(st).pv === 1 && it(st).n === 2, `one split off it onto the table: shown, the stack still hidden ×2 (${J(off && priv(it(off)))})`);
}

// --- (3) peek -------------------------------------------------------------------------------
function testPeek() {
  section('(3) peek, the piece variant (spec §5c): loud, vetoable; "You can already see it"');
  const R = room(), H = R.H, it = R.it;
  R.job(HOST, { t: 'move', id: ID.t1, x: it(ID.rackS).x + 100, y: it(ID.rackS).y + 10 });
  let r = R.job(MAL, { t: 'peek', id: ID.t1 });
  ok(r.peeks.length === 1 && r.peeks[0].p === MAL && J(r.peeks[0].c) === J({ t: it(ID.t1).t, f: it(ID.t1).f }), `Mallory peeks at Alice's rack tile: {t, f} to her alone (${J(r.peeks)})`);
  ok(J(r.lines.map((e) => [e.p, e.txt, e.k])) === J([[MAL, 'peeked at a hidden piece', 1]]), 'on the record, loud (k: 1), naming nothing');
  r = R.job(HOST, { t: 'peek', id: ID.t1 });
  ok(!r.peeks.length && !r.lines.length && r.notes.join() === 'You can already see it', 'Alice peeking at her own: "You can already see it", no line');
  r = R.job(BOB, { t: 'peek', id: ID.u1 });
  ok(!r.peeks.length && r.notes.join() === 'You can already see it', 'a shown piece: the same');
  r = R.job(BOB, { t: 'peek', id: ID.gem });
  ok(r.peeks.length === 1 && r.lines.length === 1, 'a piece hidden from everyone: peeked');
  // vetoable: a validate that refuses peeks
  R.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'NoPeek', validate(t, a) { if (a.t === 'peek') return 'No peeking'; } })" });
  r = R.job(MAL, { t: 'peek', id: ID.t1 });
  ok(!r.peeks.length && r.notes.join() === '🚫 No peeking' && r.lines.some((e) => e.txt === 'blocked Mallory: No peeking'), `vetoed by validate: refused with the notice (${r.notes})`);
  ok(R.same(), 'host and mirror agree');
}

// --- (4) hide, roll, flip, face, the private-piece rule -----------------------------------------------
function testHide() {
  section('(4) hide and roll of hidden dice; flip, face; the private-piece rule (spec §5c, §5j cases 5, 6, 8, 9, 11)');
  const R = room(), H = R.H, it = R.it;
  // hide sets owner and po on an unowned die, not on an owned one
  R.set(HOST, { t: 'owner', id: ID.d2, to: HOST });
  let r = R.job(HOST, { t: 'hide', ids: [ID.d1, ID.d2] });
  ok(J(priv(it(ID.d1))) === J({ up: false, vis: [HOST], pv: null, po: 1, owner: HOST }) && J(priv(it(ID.d2))) === J({ up: false, vis: [HOST], pv: null, po: null, owner: HOST }),
    `hide: the unowned die becomes Alice's (po); the one she owned has no po (${J([priv(it(ID.d1)), priv(it(ID.d2))])})`);
  ok(r.lines.map((e) => e.txt).join() === 'hid 2 pieces' && r.fx.filter((e) => e.t === 'fx').length === 1, `"hid 2 pieces", one bulb (${J(r.lines.map((e) => e.txt))})`);
  // case 8: Mallory's flip, roll, face, move and claim on Alice's cupped dice
  const before = J([it(ID.d1), it(ID.d2)]);
  const tries = [['flip', { t: 'flip', id: ID.d1 }], ['roll', { t: 'roll', ids: [ID.d1] }], ['face', { t: 'face', id: ID.d1, f: 2 }], ['move', { t: 'move', id: ID.d1, x: 50, y: 50 }],
    ['owner', { t: 'owner', id: ID.d1, to: MAL }], ['toHand', { t: 'toHand', id: ID.d1 }], ['hide', { t: 'hide', ids: [ID.d1] }], ['del', { t: 'del', id: ID.d1 }]];
  const said = tries.map(([k, a]) => [k, R.job(MAL, a).notes.join()]);
  ok(said.slice(0, 3).every(([, n]) => n === '🚫 That piece is hidden') && said.slice(3).every(([k, n]) => n === (k === 'toHand' || k === 'hide' ? '🚫 That piece is hidden' : '🚫 That belongs to Alice')),
    `flip, roll and face: the uniform "🚫 That piece is hidden"; move, claim, del: "That belongs to Alice"; toHand and hide: hidden (${J(said)})`);
  ok(J([it(ID.d1), it(ID.d2)]) === before, 'the dice and their values unchanged in the host state');
  // the owner rolls: everyone sees the tumble, the log names no value
  r = R.job(HOST, { t: 'roll', ids: [ID.d1, ID.d2, ID.d3, ID.d4] });
  ok(r.lines.map((e) => e.txt).join() === `rolled 4 dice (2 hidden): ${[ID.d3, ID.d4].map((k) => it(k).f + 1).join(' · ')}` && J(r.fx.find((e) => e.t === 'fx').f.roll) === J([ID.d1, ID.d2, ID.d3, ID.d4]),
    `a roll of 2 shown and 2 cupped dice: "rolled 4 dice (2 hidden): a · b", every die tumbles (${J(r.lines.map((e) => e.txt))})`);
  r = R.job(HOST, { t: 'roll', ids: [ID.d1] });
  ok(r.lines.map((e) => e.txt).join() === 'rolled a hidden die', `one cupped die: "rolled a hidden die" (${J(r.lines.map((e) => e.txt))})`);
  r = R.job(HOST, { t: 'group', op: 'roll', ids: [ID.d1, ID.d2, ID.d3, ID.d4] });
  ok(r.lines.map((e) => e.txt).join() === `rolled 4 dice (2 hidden): ${[ID.d3, ID.d4].map((k) => it(k).f + 1).join(' · ')}`, `a group roll: the same line (${J(r.lines.map((e) => e.txt))})`);
  r = R.job(HOST, { t: 'group', op: 'roll', ids: [ID.d1, ID.d2] });
  ok(r.lines.map((e) => e.txt).join() === 'rolled 2 hidden dice', `a group of two cupped dice: "rolled 2 hidden dice" (${J(r.lines.map((e) => e.txt))})`);
  // face of a private piece: hers to set, "turned a hidden piece"
  R.api((t) => t.hide(ID.u1, [HOST]));
  r = R.job(HOST, { t: 'face', id: ID.u1, f: 1 });
  ok(it(ID.u1).f === 1 && r.lines.map((e) => e.txt).join() === 'turned a hidden piece', `face of a piece she sees: set, "turned a hidden piece" (${J(r.lines.map((e) => e.txt))})`);
  // flip (Reveal) by the owner: up, vis, pv, po and the po owner cleared; an owned one keeps its owner
  R.job(HOST, { t: 'flip', id: ID.d1 });
  R.job(HOST, { t: 'flip', id: ID.d2 });
  ok(J(priv(it(ID.d1))) === J({ up: true, vis: null, pv: null, po: null, owner: null }) && J(priv(it(ID.d2))) === J({ up: true, vis: null, pv: null, po: null, owner: HOST }),
    `revealed: the cup's owner gone (po), the owner she had kept (${J([priv(it(ID.d1)), priv(it(ID.d2))])})`);
  // case 9: a script-hidden unit with no owner, hidden for north: south's flip and roll refused uniformly; north's taken
  R.api((t) => t.hide(ID.d3, ['seat:north']));
  const s9 = ['flip', 'roll', 'face'].map((k) => R.job(HOST, k === 'roll' ? { t: 'roll', ids: [ID.d3] } : { t: k, id: ID.d3, f: 0 }).notes.join());
  ok(s9.every((n) => n === '🚫 That piece is hidden') && it(ID.d3).up === false, `t.hide(id, ['seat:north']), no owner: Alice (south) flips, rolls, sets its face — each "🚫 That piece is hidden" (${J(s9)})`);
  ok(R.job(HOST, { t: 'owner', id: ID.d3, to: HOST }).notes.join() === '' && it(ID.d3).owner === HOST, 'the host may still give it to herself (the host reassigns owners: D17), on the record');
  R.set(HOST, { t: 'owner', id: ID.d3, to: null });
  ok(R.job(CAROL, { t: 'owner', id: ID.d3, to: CAROL }).notes.join() === '🚫 That piece is hidden' && !it(ID.d3).owner, 'Carol may not claim it: claimed, it would be hers to turn over');
  r = R.job(BOB, { t: 'roll', ids: [ID.d3] });
  ok(!r.notes.length && r.lines.map((e) => e.txt).join() === 'rolled a hidden die', 'Bob (north, in its vis) rolls it');
  // case 5: hide of Alice's pieces, of pieces with no back, of a hidden one, of a non-piece
  const h5 = [[ID.d4, 'owned by Alice'], [ID.coin, 'no back'], [ID.gem, 'hidden from everyone'], [ID.bag, 'a bag']].map(([id, what]) => (id === ID.d4 && R.set(HOST, { t: 'owner', id: ID.d4, to: HOST }), [what, R.job(MAL, { t: 'hide', ids: [id] }).notes.join()]));
  ok(J(h5) === J([['owned by Alice', '🚫 That belongs to Alice'], ['no back', '🚫 That piece has no hidden side'], ['hidden from everyone', '🚫 That piece is hidden'], ['a bag', '🚫 Only pieces can be hidden']]),
    `Mallory's hides refused: ${J(h5)}`);
  ok(R.job(MAL, { t: 'hide', ids: [ID.t1, ID.t1] }).notes.join() === '🚫 Hide 1 to 20 different pieces' && R.job(MAL, { t: 'hide', ids: Array.from({ length: 21 }, (_, k) => `x${k}`) }).notes.join() === '🚫 Hide 1 to 20 different pieces', 'ids: 1 to 20, all different');
  // case 6: forged fields ignored
  const t0 = priv(it(ID.t1));
  R.job(MAL, { t: 'move', id: ID.t1, x: 400, y: 400, vis: [MAL], up: false, pv: 1, po: 1, owner: MAL });
  R.job(MAL, { t: 'hide', ids: [ID.t2], vis: [MAL, BOB], up: true });
  ok(J(priv(it(ID.t1))) === J(t0) && it(ID.t1).x === 400 && J(it(ID.t2).vis) === J([MAL]), `forged vis, up, pv, po, owner on move and hide: ignored (${J([priv(it(ID.t1)), it(ID.t2).vis])})`);
  // group hide: one line, each for the actor alone
  R.job(HOST, { t: 'flip', id: ID.d3 }); // (Alice doesn't see it: refused)
  r = R.job(CAROL, { t: 'group', op: 'hide', ids: [ID.u2, ID.d3, ID.coin, 'gone0001'] });
  ok(J(priv(it(ID.u2))) === J({ up: false, vis: [CAROL], pv: null, po: 1, owner: CAROL }) && J(r.lines.map((e) => e.txt)) === J(['hid 1 piece']) && /^3 of 4 were skipped: That piece is hidden$/.test(r.notes.join()),
    `group hide: each member as a single hide — the one she may hides, the rest skipped once (${J(r.lines.map((e) => e.txt))}; ${r.notes})`);
  ok(GROUP_OPS.includes('hide') && RULED_ACTIONS.includes('hide') && PUBLIC_ACTIONS.includes('hide'), 'hide: a public, ruled action and a group op');
}

// --- (5) seat changes -------------------------------------------------------------------------
function testSeats() {
  section('(5) byVis: a seat change re-sends every seat-ref vis piece (spec §5a, §5j case 3)');
  const R = room(), H = R.H, it = R.it;
  R.api((t) => { t.hide(ID.u1, ['seat:north']); t.hide(ID.u2, [BOB]); });
  R.tick();
  ok('t' in R.view(BOB).items[ID.u1] && 't' in R.view(BOB).items[ID.u2], 'Bob (north) sees both: one by his seat, one by his id');
  // Bob leaves and is moved to the watchers; Mallory takes north
  R.set(BOB, { t: '_leave' });
  R.set(HOST, { t: 'seat', p: BOB, watch: true });
  R.set(HOST, { t: 'seat', p: MAL, id: 'north' });
  const d = H.takeDirty();
  ok(d.items.has(ID.u1) && !d.items.has(ID.u2), "the seat's occupant changed: the piece seen by the seat is touched, the one seen by Bob's id isn't");
  // (put the tick together by hand from d, as app.js's broadcast would)
  const c = H.patchContent(d), patch = sharedText({ v: PROTO, boot: 1, seq: H.state.seq, host: HOST, kind: 'patch', ...c });
  for (const p of [BOB, MAL]) applyViewPatch(R.view(p), JSON.parse(spliceBody({ to: p, tp: p, base: R.view(p).seq, ...H.mine(p, d) }, patch)));
  ok('t' in R.view(MAL).items[ID.u1] && !('t' in R.view(BOB).items[ID.u1]) && 't' in R.view(BOB).items[ID.u2] && !('t' in R.view(MAL).items[ID.u2]),
    "Mallory, now north, sees the seat's piece; Bob gets its reduced form — and keeps the one his id sees, which Mallory never gets");
  ok(c.items?.[ID.u1] && !c.pos?.[ID.u1] && !('t' in c.items[ID.u1]), 'the shared patch carries it whole, reduced');
  // a seat change by setSeats (the rules) too
  R.tick();
  R.api((t) => t.setSeats([{ id: 'north', name: 'North', edge: 'top' }, { id: 'south', name: 'South' }])); // (Alice, seated first, takes north)
  const d2 = H.takeDirty();
  ok(H.state.players[HOST].seatId === 'north' && d2.items.has(ID.u1) && !d2.items.has(ID.u2), 'setSeats re-seats everyone: north changed hands, its piece is touched again');
}

// --- (6) MIGRATE[5] ---------------------------------------------------------------------------
function testMigrate() {
  section('(6) MIGRATE[5]: v5 → v6, nothing else changes (spec §5h)');
  const v5 = { v: 5, seq: 4, table: { shape: 'round', w: 1300, h: 1300 }, seats: null, boardSeq: 0, zMax: 2, items: { a: { k: 'g', t: 'x/y', f: 0, up: false, x: 1, y: 2, rot: 0, z: 1 } }, players: {}, keys: {}, log: [], guestDeckChars: 0, lastSetup: 'abcd0001' };
  const m = MIGRATE[5](json(v5));
  ok(m.v === 6 && canon({ ...m, v: 5 }) === canon(v5) && canon(migrate(json(v5))) === canon(m), `v 6, every other field as it was; migrate() ends there (${m.v})`);
  const q = quietly(() => createTable({ ...json(v5), v: 6, items: { a: { ...v5.items.a, vis: ['nope'], pv: 2, po: 1 }, b: { k: 'c', d: 'x', i: 0, up: false, x: 0, y: 0, rot: 0, z: 2, vis: [HOST] } } }, { pid: HOST }));
  const S = q.value.state.items;
  ok(!('vis' in S.a) && !('pv' in S.a) && !('po' in S.a) && S.a.up === false && !('vis' in S.b) && q.error.length === 2, `a save's malformed vis, pv or po (or one on a card) is dropped loudly, the item kept, still hidden (${q.error.length} errors)`);
}

// --- (7) a random run, three viewers, and Mallory ------------------------------------------------
function testFuzz() {
  section('(7) a random run of 500 ops: each viewer\'s folded patches equal its own snapshot; Mallory receives no hidden identity');
  for (const seed of [11, 12]) {
    const R = room(), H = R.H, it = R.it, rnd = rng(seed), P3 = [HOST, BOB, CAROL];
    const pieces = () => Object.keys(H.state.items).filter((k) => it(k).k === 'g' && !(it(k).z < 0));
    const spots = () => [it(ID.rackS), it(ID.rackS2), it(ID.rackN), it(ID.screen), { x: 1500, y: 1000 }, { x: 900, y: 500 }].map((b) => ({ x: b.x + 40 + rnd.int(120), y: b.y + 10 }));
    let leaks = [], mism = [], ops = 0;
    const types = new Set(['tile', 'gem', 'unit'].map((ty) => it(ID.t1).t.replace('tile', ty))); // (no shown piece of these types ever reaches Mallory?)
    for (let k = 0; k < 500; k++) {
      const p = rnd.pick(P3), id = rnd.pick(pieces()), sp = rnd.pick(spots()), r = rnd();
      const a = r < 0.35 ? { t: 'move', id, ...sp } : r < 0.45 ? { t: 'hide', ids: [id] } : r < 0.55 ? { t: 'flip', id } : r < 0.62 ? { t: 'roll', ids: [rnd.pick([ID.d1, ID.d2, ID.d3, ID.d4])] }
        : r < 0.67 ? { t: 'face', id, f: rnd.int(2) } : r < 0.72 ? { t: 'group', op: rnd.pick(['hide', 'move', 'flip']), ids: [id, rnd.pick(pieces())], dx: 40, dy: 0 } : r < 0.76 ? { t: 'peek', id }
          : r < 0.8 ? { t: 'pull', id: ID.bag, ...sp } : r < 0.84 ? { t: 'owner', id, to: rnd() < 0.5 ? p : null } : null;
      if (a) { R.job(p, a); ops++; } else if (r < 0.9) { // the rules' calls
        const ref = rnd.pick([[HOST], ['seat:north'], [BOB, 'seat:east'], []]), call = H.api.type(it(id).t)?.back ? rnd.int(3) : 2; // (only a piece with a back may lie hidden)
        quietly(() => (call === 0 ? H.api.hide(id, ref) : call === 1 ? H.api.setVis(id, ref.length ? ref : null) : H.api.reveal(id)));
      } else { // seats change hands
        const q = rnd.pick(P3), s = rnd.pick(['south', 'north', 'east']);
        quietly(() => H.apply(HOST, rnd() < 0.3 ? { t: 'seat', p: q, watch: true } : { t: 'seat', p: q, id: s }));
      }
      H.drain();
      if (rnd() < 0.5) {
        const hid = hiddenTo(H, MAL), before = labelsShown(R.view(MAL), H.state.boxes), out = R.tick();
        if (out[MAL]) { const why = leak(out[MAL][0], out[MAL][1], hid, new Set([...before, ...labelsShown(R.view(MAL), H.state.boxes)])); if (why) leaks.push(`${k}: ${why}`); }
        // every viewer holds the full form of what it sees, the reduced one of the rest
        for (const q of [...P3, MAL]) {
          const hq = hiddenTo(H, q);
          for (const [i, v] of Object.entries(R.view(q).items)) {
            const host = it(i);
            if (hq.has(i) ? 't' in v || 'vis' in v : host.k === 'g' && host.up === false && host.vis && v.t !== host.t) mism.push(`${k}: ${q.slice(0, 2)} ${i} ${J(v)}`);
          }
        }
      }
    }
    R.tick();
    for (const q of [...P3, MAL]) {
      const want = R.fresh(q), got = R.view(q);
      if (canon(got.items) !== canon(want.items) || canon(got.hand) !== canon(want.hand) || canon(got.players) !== canon(want.players)) mism.push(`end: ${q.slice(0, 2)}'s view ≠ its snapshot`);
    }
    ok(!mism.length, `seed ${seed}: ${ops} actions — every viewer's folded view equals its own snapshot, and each holds the full form of exactly what it sees (${mism.slice(0, 3).join('; ') || 'none'})`);
    ok(!leaks.length, `seed ${seed}: no body Mallory received carried a hidden identity, an override or a secret label (${R.peers.get(MAL).bodies.length} bodies; ${leaks.slice(0, 3).join('; ') || 'none'})`);
    ok(!R.peers.get(MAL).bodies.some((b) => b.vis) && !scanT(R.peers.get(MAL).bodies.map((b) => b.log || []), types), 'Mallory never got a vis override, and no log line carries a type ref');
  }
}

// --- (8) export round trip --------------------------------------------------------------------------
function testExport() {
  section('(8) export round trip of private material (spec §5h): cupped dice (po), rack tiles (pv, po), a unit out of its screen, a t.hide with seat refs');
  const A = room(), H = A.H, it = A.it;
  A.job(HOST, { t: 'hide', ids: [ID.d1] }); // cupped: Alice's (po)
  A.job(HOST, { t: 'move', id: ID.t1, x: it(ID.rackS).x + 100, y: it(ID.rackS).y + 10 }); // rack tile: pv, po
  A.job(BOB, { t: 'move', id: ID.u2, x: it(ID.screen).x + 100, y: it(ID.screen).y + 50 });
  A.job(BOB, { t: 'move', id: ID.u2, x: 1600, y: 400 }); // left its screen: vis, po, no pv
  A.api((t) => { t.hide(ID.u1, ['seat:north']); t.hide(ID.t2, [CAROL, 'seat:south']); }); // the script's: seat refs, no owner; a pid and a seat
  const { box, warnings } = quietly(() => H.exportBox()).value;
  const E = Object.fromEntries(box.setup.filter((e) => e.id).map((e) => [e.id, e]));
  ok(!warnings.length && E[ID.d1].up === false && J(E[ID.d1].vis) === J(['#1']) && E[ID.d1].owner === '#1' && E[ID.d1].po === true, `the cupped die: up false, vis ["#1"], owner "#1", po (${J(E[ID.d1])})`);
  ok(!('up' in E[ID.t1]) && !('vis' in E[ID.t1]) && !('owner' in E[ID.t1]) && !('po' in E[ID.t1]), `the rack tile: none of up, vis, owner, po — its rack hides it again (${J(E[ID.t1])})`);
  ok(E[ID.u2].up === false && J(E[ID.u2].vis) === J(['seat:north']) && E[ID.u2].owner === 'seat:north' && E[ID.u2].po === true, `the unit out of its screen: up false, vis, owner, po (${J(E[ID.u2])})`);
  ok(E[ID.u1].up === false && J(E[ID.u1].vis) === J(['seat:north']) && !('owner' in E[ID.u1]) && J(E[ID.t2].vis) === J(['#3', 'seat:south']), `the script's: seat refs and "#k" (${J([E[ID.u1], E[ID.t2]])})`);
  // a fresh room: other players, the same seats
  const B = room({ box: false, prefix: 'c' }), U = B.H;
  const def = boxOfDef(json(box)).box && json(box), add = quietly(() => U.apply(HOST, { t: 'addBox', box: def }));
  const bid = U.drain().find((e) => e.t === 'added')?.id;
  quietly(() => U.apply(HOST, { t: 'setup', box: bid }));
  const fx = U.drain();
  ok(add.value && !fx.some((e) => e.t === 'note'), `imported and set up (${J(fx.filter((e) => e.t === 'note'))})`);
  const pids = (q) => { const k = [HOST, CAROL, BOB].indexOf(q); return k < 0 ? q : [HOST, CAROL, BOB][k]; }; // (both rooms seat Alice, Carol, Bob as #1, #2, #3)
  const same = [ID.d1, ID.t1, ID.u2, ID.u1, ID.t2].map((id) => [id, J(priv(it(id))), J(priv(U.state.items[id]))]);
  ok(same.every(([, a, b]) => a === b), `each comes back with the same up, vis, owner, pv and po (${J(same.filter(([, a, b]) => a !== b))})`);
  ok(pids(HOST) === HOST && cleanBox(boxFromDef(json(box))).setup.length === box.setup.length, 'the export passes the gate whole');
}

// --- (9) the facade on the Worker path, the grammar, checkPatch ---------------------------------------
const VEIL = `({ name: 'Veil',
  onChat(t, msg, p) {
    const [op, ...args] = JSON.parse(msg);
    try { t.data.ret = t[op](...args); t.data.err = null; } catch (e) { t.data.err = e.message; }
  },
})`;
function testFacade() {
  section('(9) t.hide, t.reveal, t.setVis, t.canSee, t.spawn\'s vis — run in a Worker mirror, its patches taken by the host (spec §5e, §5f)');
  const R = room(), H = R.H, it = R.it;
  R.job(HOST, { t: 'setRules', enabled: true, code: VEIL });
  const call = (...c) => { const r = R.job(HOST, { t: 'chat', msg: J(c) }); return { ret: H.state.rules.data.ret, err: H.state.rules.data.err, r }; };
  let c = call('hide', ID.u1, ['seat:north', BOB]);
  ok(c.ret === true && J(priv(it(ID.u1))) === J({ up: false, vis: ['seat:north', BOB], pv: null, po: null, owner: null }) && R.same(), `t.hide(id, ['seat:north', Bob]): up false, vis, no owner — the host took the mirror's patch (${J(priv(it(ID.u1)))})`);
  ok(c.r.lines.some((e) => e.p === RULES && e.txt === 'hid ZQXK'.replace('ZQXK', it(ID.u1).up === false ? 'ZQXK' : '')) || c.r.lines.some((e) => /^hid /.test(e.txt)), 'logged as the rules\' op');
  c = call('canSee', BOB, ID.u1);
  ok(c.ret === true && call('canSee', CAROL, ID.u1).ret === false && call('canSee', HOST, ID.bag).ret === false && call('canSee', HOST, ID.t1).ret === true, 't.canSee: Bob yes, Carol no; a bag never; a shown piece yes');
  c = call('setVis', ID.u1, null);
  ok(c.ret === true && !('vis' in it(ID.u1)) && it(ID.u1).up === false && call('canSee', BOB, ID.u1).ret === false, 't.setVis(id, null): hidden from everyone, still face down');
  c = call('setVis', ID.u1, ['seat:east']);
  ok(J(it(ID.u1).vis) === J(['seat:east']) && c.r.lines.some((e) => e.txt === 'changed who sees a hidden piece'), `t.setVis(id, ['seat:east']): "changed who sees a hidden piece" (${J(c.r.lines.map((e) => e.txt))})`);
  c = call('reveal', ID.u1);
  ok(c.ret === true && J(priv(it(ID.u1))) === J({ up: true, vis: null, pv: null, po: null, owner: null }) && c.r.lines.some((e) => /^revealed ZQX/.test(e.txt)), `t.reveal: public, "revealed {label}" (${J(c.r.lines.map((e) => e.txt))})`);
  c = call('spawn', it(ID.u1).t, { at: { x: 1900, y: 1300 }, up: false, vis: ['seat:south'] });
  ok(typeof c.ret === 'string' && J(priv(it(c.ret))) === J({ up: false, vis: ['seat:south'], pv: null, po: null, owner: null }) && c.r.lines.some((e) => e.txt === 'placed a hidden piece'), `t.spawn(type, {up: false, vis}) (${J(c.r.lines.map((e) => e.txt))})`);
  for (const [args, re] of [[['hide', ID.coin, []], /can't lie hidden/], [['hide', ID.u2, ['nobody']], /no player at the table/], [['hide', ID.u2, Array(9).fill(BOB)], /at most 8/],
    [['setVis', ID.coin, [BOB]], /can't lie hidden/], [['spawn', it(ID.u2).t, { vis: [BOB] }], /vis is for a piece with up: false/], [['hide', ID.u2, 'seat:north'], /a list/]]) {
    c = call(...args);
    ok(re.test(c.err ?? '') && H.state.rules.enabled, `t.${args[0]}(${J(args.slice(1)).slice(1, -1)}): a TypeError (${c.err})`);
  }
  // aggregation: four or more of one op in an action are one line
  call('remove', 'nothing'); // (resets ret)
  const ids = [ID.d1, ID.d2, ID.d3, ID.d4];
  const run = R.job(HOST, { t: 'chat', msg: J(['hide', ids[0], [HOST]]) });
  ok(run.lines.some((e) => /^hid /.test(e.txt)), 'one hide: one line');
  ok(R.same(), 'the host and the mirror agree (digests)');
  section('(9) the setup grammar\'s vis and po (spec §5h)');
  const grammar = (setup) => thrown(() => cleanBox(boxFromDef({ ...PRIVY, setup })));
  ok(!grammar([{ piece: 'd6', at: [1, 1], up: false, vis: ['#1', 'seat:north'], owner: '#1', po: true }]) && !grammar([{ forEachSeat: [{ piece: 'd6', at: 'seat', up: false, vis: 'seat' }] }]), 'vis on a hidden piece: seat refs, "#k", or "seat" in forEachSeat; po with an owner');
  for (const [s, re] of [[[{ piece: 'd6', at: [1, 1], vis: ['#1'] }], /vis is only for a piece entry with up: false/], [[{ piece: 'd6', at: [1, 1], up: false, vis: 'seat' }], /vis must be 1 to 8 of/],
    [[{ piece: 'd6', at: [1, 1], up: false, vis: Array.from({ length: 9 }, (_, k) => `#${k + 1}`) }], /vis must be 1 to 8/], [[{ piece: 'd6', at: [1, 1], up: false, po: true }], /po must be true, on a piece entry with up: false and an owner/],
    [[{ supply: 'd6', at: [1, 1], up: false, vis: ['#1'] }], /vis is only for a piece entry/], [[{ piece: 'd6', at: [1, 1], up: false, vis: ['seat:west'] }], /vis must be/]]) {
    ok(re.test(grammar(s)), `refused: ${J(s[0])} (${grammar(s)})`);
  }
  ok(J(cleanBox(boxFromDef({ ...PRIVY, setup: [{ piece: 'd6', at: [1, 1], up: false, vis: '#2' }] })).setup[0].vis) === J(['#2']), 'one ref is a list of one (cleanBox(cleanBox(b)) is cleanBox(b))');
  section('(9) checkPatch: a patch\'s vis, pv and po pass the gate, or the patch is refused (spec §3f.6, §5f)');
  const base = it(ID.t1), forge = (o) => thrown(() => H.applyStatePatch({ items: { [ID.t1]: { ...base, ...o } } }, { effects: [] }, { p: RULES, a: { t: '_tick' } }));
  for (const [o, ok_] of [[{ up: false, vis: [BOB, 'seat:north'], pv: 1, po: 1, owner: BOB }, true], [{ vis: ['nope'] }, false], [{ vis: [] }, false], [{ vis: [BOB, BOB] }, false], [{ vis: Array(9).fill(0).map((_, k) => `seat:s${k}`) }, false], [{ pv: 2 }, false], [{ po: true }, false]]) {
    const why = forge(o);
    ok(ok_ ? !why : /malformed: its (vis|pv)/.test(why), `${J(o)}: ${ok_ ? 'taken' : `refused (${why})`}`);
  }
  ok(/vis, pv and po are for pieces alone/.test(thrown(() => H.applyStatePatch({ items: { zz000001: { k: 'c', d: 'x', i: 0, up: false, x: 0, y: 0, rot: 0, z: 9, vis: [BOB] } } }, { effects: [] }, { p: RULES, a: { t: '_tick' } }))), 'vis on a card: refused');
}

// --- B22, B23 ---------------------------------------------------------------------------------------
function testBudgets() {
  section('(B22) 8 players, 20 vis tiles each: a vis tile\'s move adds ≤ 400 B to its viewer\'s patch, 0 B to the others\' (spec §5k)');
  const ps = Array.from({ length: 8 }, (_, k) => (k ? (k + 10).toString(16).repeat(16).slice(0, 16) : HOST));
  const R = room({ box: false });
  const H = R.H;
  R.set(HOST, { t: 'loadBox', box: boxFromDef({ ...PRIVY, setup: [] }), setup: false });
  const box = Object.keys(H.state.boxes).find((b) => H.state.boxes[b].name === 'Privy');
  for (const p of ps.slice(1)) quietly(() => H.apply(p, { t: '_join', name: `P${p.slice(0, 2)}` }));
  const type = `${box}/tile`, mine = {};
  for (const [k, p] of ps.entries()) mine[p] = Array.from({ length: 20 }, (_, j) => H.api.spawn(type, { at: { x: 100 + j * 70, y: 100 + k * 150, free: true }, up: false, vis: [p] }));
  H.drain();
  H.takeDirty();
  H.snapContent();
  const moved = mine[ps[3]][7];
  quietly(() => H.apply(ps[3], { t: 'move', id: moved, x: 2000, y: 1500 }));
  const d = H.takeDirty(), c = H.patchContent(d), patch = sharedText({ v: PROTO, boot: 1, seq: H.state.seq, host: HOST, kind: 'patch', ...c });
  const size = (p) => spliceBody({ to: p, tp: 'peer-' + p, base: 1, ...H.mine(p, d) }, patch).length - spliceBody({ to: p, tp: 'peer-' + p, base: 1 }, patch).length;
  const adds = ps.map(size);
  ok(adds[3] > 0 && adds[3] <= 400 && adds.every((n, k) => k === 3 || n === 0), `its viewer's body grows by ${adds[3]} B (≤ 400), every other's by 0 (${J(adds)})`);
  ok(J(Object.keys(H.mine(ps[3], d).vis)) === J([moved]) && !c.pos?.[moved] && c.items?.[moved] && !('t' in c.items[moved]), 'the override is that tile alone; the shared patch carries it whole, reduced');
  section('(B23) a snapshot for one recipient with 160 vis items: built in ≤ 20 ms (spec §5k)');
  const times = [];
  for (let k = 0; k < 15; k++) {
    const t0 = performance.now();
    spliceBody({ to: ps[2], tp: 'p', ...H.mine(ps[2]) }, sharedText({ v: PROTO, boot: 1, seq: H.state.seq, host: HOST, kind: 'snap', ...H.snapContent(), fx: [], ann: [] }));
    times.push(performance.now() - t0);
  }
  const med = [...times].sort((a, b) => a - b)[7];
  ok(Object.values(mine).flat().length === 160 && Object.keys(H.mine(ps[2]).vis).length === 20 && med <= 20, `160 vis items; P3's snapshot carries its 20 in full, built in ${med.toFixed(2)} ms median of 15 (≤ 20)`);
}

try {
  for (const [what, fn] of [['reduction', testReduction], ['zones', testZones], ['peek', testPeek], ['hide', testHide], ['seats', testSeats], ['migrate', testMigrate], ['fuzz', testFuzz], ['export', testExport], ['facade', testFacade], ['budgets', testBudgets]]) await guard(what, fn);
} catch (e) { crash(e); }
report();
