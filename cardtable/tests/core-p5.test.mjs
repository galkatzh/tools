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
//  (F) The fix-up's regressions (D277–D285): a zone never widens who sees a
//      piece; no laundering through a pile, a bag or a hand; a pull never
//      refused for what it draws; a hidden die and token alike on a spot;
//      a rules veto of one's own hidden piece quiet; exports that keep what
//      re-placing wouldn't; Dominoes by seat; Veiled Ranks' moves, combat,
//      draw and labels.
// Then the test author's own sections, (1′) to (CP′), written apart from the
// implementation (see their header below): §5l's items 1–8 again against an
// oracle read off the host state by §5a's rule, the setup grammar's vis and
// po laid out, checkPatch on honest and forged private material, B22, B23.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, core, ok, section, report, crash, guard, json, canon, rng, seeds, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

const { BOXES } = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));
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

// --- (F) the Phase 5 fix-up: what the reviewers found, closed -------------------------------------
/** Starts the rules a box's setup asked for (the app's `enable` effect, which this room's job leaves alone). */
function enabled(R, r) {
  for (const e of r.fx.filter((x) => x.t === 'enable')) {
    const box = R.H.state.boxes[e.box];
    R.job(HOST, { t: 'setRules', enabled: true, reset: true, code: box.rules, box: e.box, remap: e.remap, ...(box.rulesState && { state: box.rulesState }) });
  }
  return r;
}
/** A built-in box set up with its rules, Alice south and Bob north (Carol and Mallory watch). */
function demo(box, units) {
  const R = room({ box: false });
  if (units) box = { ...json(box), setup: [{ piece: 'field', at: 'center' }, ...Object.entries(units).map(([sq, k]) => ({ piece: k, at: sq, up: false, owner: `seat:${k[0] === 's' ? 'south' : 'north'}` }))] };
  enabled(R, R.job(HOST, { t: 'loadBox', box, setup: true, clear: true, rules: true }));
  for (const [p, id] of [[CAROL, null], [MAL, null], [HOST, 'south'], [BOB, 'north']]) R.job(HOST, id ? { t: 'seat', p, id } : { t: 'seat', p, watch: true });
  R.tick();
  return R;
}
/** Every body p got since index k, as one text. */
const since = (R, p, k) => R.peers.get(p).texts.slice(k).join('\n');
const SNAPBOX = {
  name: 'Snap', table: { shape: 'rect', w: 2000, h: 1400 }, backs: [{ id: 'cup', color: '#7c2d12' }],
  pieces: [{ id: 'grid', kind: 'board', w: 600, h: 600, grid: { type: 'square', cols: 6, rows: 6, cell: 100, x: 0, y: 0 } },
    { id: 'die', kind: 'die', back: 'cup' }, { id: 'gem', kind: 'token', shape: 'rect', w: 56, stack: 'none', back: 'cup', faces: ['ZQXJ'] }, { id: 'pawn', kind: 'token', shape: 'rect', w: 56, stack: 'none', back: 'cup', faces: ['ZQXW'] }],
  setup: [{ piece: 'grid', at: [100, 100], id: 'cccc0001' }, { piece: 'die', at: [1200, 1000], id: 'cccc0002' }, { piece: 'gem', at: [1300, 1000], id: 'cccc0003' }, { piece: 'pawn', at: [1400, 1000], id: 'cccc0004' }],
};
const QUIET = `({ name: 'Quiet', validate(t, a) {
  const it = t.item(a.id ?? a.ids?.[0]);
  if (a.t === 'move' && it?.k === 'g' && t.type(it.t)?.faces[it.f]?.label?.startsWith('ZQX')) return 'The ' + t.type(it.t).faces[it.f].label + ' never moves';
} })`;
function testFixup() {
  section('(F1) a private zone never widens who sees a piece (D277): a rack takes a private piece only from one who sees it; a screen never takes one over');
  {
    const R = room(), it = R.it, onRack = (id) => ({ x: it(id).x + 30, y: it(id).y + 10 });
    R.api((t) => { t.hide(ID.u1, ['seat:south']); t.hide(ID.t1, ['seat:south']); });
    R.tick();
    const k0 = R.peers.get(BOB).texts.length; // (from here: "hid ZQXK" named it as it showed a moment ago)
    const u0 = J(priv(it(ID.u1)));
    let r = R.job(BOB, { t: 'move', id: ID.u1, ...onRack(ID.rackN) });
    ok(r.notes.join() === '🚫 That piece is hidden' && J(priv(it(ID.u1))) === u0 && !r.lines.length, `Bob (north), not in its vis, drops South's unowned private unit on his rack: the uniform refusal, nothing changed (${J(r.notes)})`);
    r = R.job(BOB, { t: 'group', op: 'move', ids: [ID.u1], dx: onRack(ID.rackN).x - it(ID.u1).x, dy: onRack(ID.rackN).y - it(ID.u1).y });
    ok(r.notes.join() === '🚫 That piece is hidden' && J(priv(it(ID.u1))) === u0, `…as a group's move too (${J(r.notes)})`);
    R.tick();
    ok(!/ZQXK/.test(since(R, BOB, k0)) && !('t' in R.view(BOB).items[ID.u1]), `Bob was shown nothing of it (${since(R, BOB, k0).match(/.{0,80}ZQXK.{0,40}/)?.[0]})`);
    r = R.job(HOST, { t: 'move', id: ID.t1, ...onRack(ID.rackN) });
    ok(!r.notes.length && J(priv(it(ID.t1))) === J({ up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), `Alice, who sees South's tile, hands it to Bob's rack: his now (${J(priv(it(ID.t1)))})`);
    // a screen ('keep') hides what is shown, and never takes a private piece over: a person's move, a script's
    R.api((t) => t.hide(ID.u2, ['seat:south']));
    r = R.job(HOST, { t: 'move', id: ID.u2, x: it(ID.screen).x + 100, y: it(ID.screen).y + 100 });
    ok(!r.notes.length && J(priv(it(ID.u2))) === J({ up: false, vis: ['seat:south'], pv: null, po: null, owner: null }), `South's private unit dropped behind North's screen: still South's alone (${J(priv(it(ID.u2)))})`);
    R.api((t) => t.move(ID.u2, it(ID.screen).x + 300, it(ID.screen).y + 100));
    ok(J(it(ID.u2).vis) === J(['seat:south']), "…and a script's move there: the same");
    R.job(HOST, { t: 'move', id: ID.coin, x: 1500, y: 1300 });
    R.job(BOB, { t: 'move', id: ID.t2, x: it(ID.screen).x + 400, y: it(ID.screen).y + 100 });
    ok(J(priv(it(ID.t2))) === J({ up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), 'a shown tile set behind the screen: hidden for its seat, as before');
  }
  section('(F2) what strips a private piece of its vis asks the private-piece rule (D280): stack, toPile, toBag, a split onto a bag — no laundering into a hand or a rack');
  {
    const R = room(), it = R.it;
    R.api((t) => t.hide(ID.t2, ['seat:south']));
    R.tick();
    const k0 = R.peers.get(BOB).texts.length;
    const t0 = J(priv(it(ID.t2))), n0 = Object.keys(R.H.state.items).length;
    for (const [what, a] of [['stacks it onto a shown tile', { t: 'stack', id: ID.t2, onto: ID.t1 }], ['stacks a shown tile onto it', { t: 'stack', id: ID.t1, onto: ID.t2 }],
      ['puts it into the bag', { t: 'toBag', id: ID.t2, bag: ID.bag }], ['takes it into his hand', { t: 'toHand', id: ID.t2 }], ['claims it', { t: 'owner', id: ID.t2, to: BOB }]]) {
      const r = R.job(BOB, a);
      ok(r.notes.join() === '🚫 That piece is hidden' && J(priv(it(ID.t2))) === t0 && Object.keys(R.H.state.items).length === n0, `Bob ${what}: the uniform refusal, nothing changed (${J(r.notes)})`);
    }
    R.job(HOST, { t: 'stack', id: ID.u1, onto: ID.u2 }); // (two shown units, no pile: units don't pile — a split onto a bag instead)
    R.api((t) => t.hide(ID.stack, ['seat:south']));
    let r = R.job(BOB, { t: 'split', id: ID.stack, n: 1, onto: ID.bag });
    ok(r.notes.join() === '🚫 That piece is hidden' && it(ID.stack).n === 3, `Bob splits one of South's private stack onto the bag: refused (${J(r.notes)})`);
    R.tick();
    ok(!/ZQXB/.test(since(R, BOB, k0)) && !R.H.state.players[BOB].hand.length, 'Bob was shown nothing, his hand is empty');
    r = R.job(HOST, { t: 'toBag', id: ID.t2, bag: ID.bag });
    ok(!r.notes.length && !it(ID.t2), 'Alice, who sees it, may bag it');
  }
  section('(F3) a pull into a private zone never depends on what it draws (D278): a piece with no hidden side lands shown, untouched by the zone');
  {
    const R = room(), it = R.it, box = it(ID.t1).t.split('/')[0];
    const bag = R.api((t) => t.newBag([...Array(3)].flatMap(() => [{ t: `${box}/coin` }, { t: `${box}/tile`, up: false }]), { at: { x: 2600, y: 900 }, name: 'Mixed' }));
    const got = [], notes = [];
    for (let k = 0; k < 6; k++) {
      const before = new Set(Object.keys(R.H.state.items)), r = R.job(HOST, { t: 'pull', id: bag, x: it(ID.rackS).x + 6 + 80 * k, y: it(ID.rackS).y + 6 });
      notes.push(...r.notes);
      got.push(...Object.keys(R.H.state.items).filter((id) => !before.has(id)));
    }
    const coins = got.filter((id) => it(id).t.endsWith('/coin')), tiles = got.filter((id) => it(id).t.endsWith('/tile'));
    ok(!notes.length && coins.length === 3 && tiles.length === 3, `six pulls into Alice's rack, none refused (${J(notes)})`);
    ok(coins.every((id) => it(id).up !== false && !it(id).vis && !it(id).pv) && tiles.every((id) => J(priv(it(id))) === J({ up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' })),
      'the coins lie there shown; the tiles hidden for South');
  }
  section('(F4) where a hidden piece lands never tells a die from a token under one back (D279): a back a die wears never snaps');
  {
    const R = room({ def: SNAPBOX }), it = R.it, [grid, die, gem, pawn] = ['cccc0001', 'cccc0002', 'cccc0003', 'cccc0004'];
    R.job(HOST, { t: 'move', id: pawn, x: it(grid).x + 210, y: it(grid).y + 10 });
    ok(!!it(pawn).at, `a shown token set on a cell takes its address (${it(pawn).at})`);
    R.job(HOST, { t: 'hide', ids: [die, gem, pawn] });
    ok(!('at' in it(pawn)), 'hidden under the cup, it loses it');
    R.job(HOST, { t: 'move', id: die, x: it(grid).x + 15, y: it(grid).y + 15 });
    R.job(HOST, { t: 'move', id: gem, x: it(grid).x + 115, y: it(grid).y + 15 });
    R.tick();
    const m = R.view(MAL).items, shape = (o) => J(Object.keys(o).sort());
    ok(!('at' in it(die)) && !('at' in it(gem)) && shape(m[die]) === shape(m[gem]) && m[die].b === m[gem].b, `a hidden die and a hidden token set on cells: neither snaps, alike to Mallory (${J([m[die], m[gem]])})`);
    R.job(HOST, { t: 'flip', id: pawn });
    ok(it(pawn).up !== false && !!it(pawn).at, `turned over where it lies, the token has its cell's address again (${it(pawn).at})`);
  }
  section("(F5) the rules' refusal of a move of one's own hidden piece is that player's alone (D282): no \"blocked\" line, nothing re-sent to the others, no live drag");
  {
    const R = room(), it = R.it;
    R.job(HOST, { t: 'hide', ids: [ID.u1] });
    R.job(HOST, { t: 'setRules', enabled: true, code: QUIET });
    R.tick();
    const k = { b: R.peers.get(BOB).texts.length, m: R.peers.get(MAL).texts.length }, n0 = R.H.state.log.length;
    let r = R.job(HOST, { t: 'move', id: ID.u1, x: 1500, y: 600 });
    const back = r.fx.find((e) => e.t === 'back');
    ok(r.notes.join() === '🚫 The ZQXK never moves' && R.H.state.log.length === n0 && J(back) === J({ t: 'back', p: HOST, ids: [ID.u1] }), `Alice's move of her cupped unit, vetoed: the notice to her alone, no log line, drawn again on her screen alone (${J(r.notes)}, ${J(back)})`);
    r = R.job(HOST, { t: 'group', op: 'move', ids: [ID.u1], dx: 300, dy: 0 });
    ok(/ZQXK never moves/.test(r.notes.join()) && R.H.state.log.length === n0, `…a group's too (${J(r.notes)})`);
    ok(R.H.drag(HOST, { t: 'drag', id: ID.u1, x: 1400, y: 700 }) === false && R.H.drag(HOST, { t: 'drag', id: ID.t1, x: 1400, y: 700 }) === true, 'its live drag goes to nobody (a shown tile\'s does)');
    R.H.drain();
    R.tick();
    const bodies = since(R, BOB, k.b) + since(R, MAL, k.m);
    ok(!bodies.includes(ID.u1) && !/ZQX|blocked/.test(bodies) && R.same(), "Bob's and Mallory's bodies since: not its id, no reason, no blocked line");
    r = R.job(HOST, { t: 'move', id: ID.t1, x: 1500, y: 600 });
    ok(R.H.state.log.at(-1).txt === 'blocked Alice: The ZQXA never moves' && !r.fx.some((e) => e.t === 'back'), `a shown tile's veto is public, as before (${R.H.state.log.at(-1).txt})`);
  }
  section('(F6) export writes what re-placing would not give back (D283): a unit in the other side\'s screen, a revealed one in its own, a rack whose owner left');
  {
    const R = demo(BOXES.ranks), H = R.H, it = R.it, units = (side) => Object.keys(H.state.items).filter((id) => it(id).t?.includes(`/${side[0]}-`));
    const [deep, shown] = units('south');
    R.api((t) => { t.move(deep, 'e9', { unzoned: true }); t.reveal(shown); t.move(shown, 'a3', { unzoned: true }); });
    ok(J(it(deep).vis) === J(['seat:south']) && it(shown).up !== false, "a South unit among North's rows still South's alone; a revealed one shown in South's");
    const { box } = quietly(() => H.exportBox({ rules: true, state: true })).value, E = Object.fromEntries(box.setup.filter((e) => e.id).map((e) => [e.id, e]));
    ok(E[deep].unzoned === true && E[deep].up === false && J(E[deep].vis) === J(['seat:south']) && E[shown].unzoned === true && !('up' in E[shown]), `both written as they lie, unzoned (${J([E[deep], E[shown]])})`);
    const B = room({ box: false, prefix: 'c' }), U = B.H;
    quietly(() => U.apply(HOST, { t: 'addBox', box: json(box) }));
    const bid = U.drain().find((e) => e.t === 'added')?.id;
    for (const [p, id] of [[CAROL, null], [MAL, null], [HOST, 'south'], [BOB, 'north']]) quietly(() => U.apply(HOST, id ? { t: 'seat', p, id } : { t: 'seat', p, watch: true }));
    quietly(() => U.apply(HOST, { t: 'setup', box: bid }));
    U.drain();
    const diff = [...units('south'), ...units('north')].filter((id) => J(priv(it(id))) !== J(priv(U.state.items[id])));
    ok(!diff.length, `every unit set up again with the same up, vis, owner, pv and po (${J(diff.map((id) => [priv(it(id)), priv(U.state.items[id])]))})`);
    B.tick();
    ok(!('t' in B.view(BOB).items[deep]) && 't' in B.view(HOST).items[deep], 'after the import North still sees its back, South its face');
  }
  {
    const R = room(), H = R.H, it = R.it;
    R.set(HOST, { t: 'owner', id: ID.rackX, to: CAROL });
    R.job(CAROL, { t: 'move', id: ID.t1, x: it(ID.rackX).x + 30, y: it(ID.rackX).y + 10 });
    ok(J(it(ID.t1).vis) === J([CAROL]), "a tile on Carol's own rack: hers alone");
    R.job(HOST, { t: 'seat', p: CAROL, watch: true });
    const { box, warnings } = quietly(() => H.exportBox()).value, e = box.setup.find((x) => x.id === ID.t1);
    ok(e.up === false && !e.vis && !e.owner && e.unzoned === true && warnings.some((w) => /sees it isn't seated/.test(w)), `Carol stood up: the tile goes hidden from everyone, never shown (${J(e)})`);
  }
  section('(F7) Dominoes (D284): the turn is a seat\'s; a tile leaves a rack only as a play, and only its seat\'s; a round\'s end shows the racks');
  {
    const R = demo(BOXES.dominoes), H = R.H, it = R.it, D = () => H.state.rules.data, holder = (s) => Object.keys(H.state.players).find((p) => H.state.players[p].seatId === s);
    const rack = (s) => Object.values(H.state.items).find((x) => x.owner === `seat:${s}` && x.t.endsWith('/rack'));
    const on = (s) => Object.keys(H.state.items).filter((id) => /\/t\d\d$/.test(it(id).t) && it(id).x + 30 >= rack(s).x && it(id).x + 30 <= rack(s).x + 600 && it(id).y + 60 >= rack(s).y && it(id).y + 60 <= rack(s).y + 140);
    R.job(BOB, { t: 'rulesBtn', id: `deal-${BOB}` });
    const s = D().turn, o = s === 'south' ? 'north' : 'south', [tile] = on(s);
    ok(['south', 'north'].includes(s) && H.state.rules.public.turn === holder(s) && on('south').length === 7 && on('north').length === 7, `Draw 7: seven a rack, the lead a seat (${s}), its player the public turn`);
    for (const [what, a, want] of [['turns a rack tile over', { t: 'flip', id: tile }, 'Play a tile by moving it off your rack'], ['hides a tile', { t: 'hide', ids: [tile] }, 'Tiles hide in your rack'],
      ['draws onto the table', { t: 'pull', id: Object.keys(H.state.items).find((id) => it(id).k === 'b'), x: 450, y: 900 }, 'Draw into your rack (🔒 Draw to my rack)']]) {
      const r = R.job(holder(s), a);
      ok(r.notes.join() === `🚫 ${want}`, `the player to move ${what}: "${want}" (${J(r.notes)})`);
    }
    ok(R.job(holder(o), { t: 'move', id: tile, x: 450, y: 900 }).notes.join() === `🚫 That belongs to ${s === 'south' ? 'South' : 'North'}`, "the other player can't touch it (the engine's words)");
    const was = holder(s);
    R.job(HOST, { t: 'seat', p: was, watch: true });
    R.job(HOST, { t: 'seat', p: CAROL, id: s });
    ok(D().turn === s && H.state.rules.public.turn === CAROL, 'the player to move stands up and Carol takes the seat: the turn is hers');
    let r = R.job(CAROL, { t: 'move', id: tile, x: 450, y: 600 });
    ok(!r.notes.length && it(tile).up !== false && D().turn === o && J(D().played) === J([tile]), `Carol plays the tile: face up, the turn passes (${J(r.notes)})`);
    r = R.job(holder(o), { t: 'move', id: tile, x: 480, y: 640 });
    ok(D().turn === o && D().played.length === 1, 'nudging the line tile is no play');
    ok(R.job(holder(o), { t: 'move', id: tile, x: rack(o).x + 6 + 66 * 8, y: rack(o).y + 6 }).notes.join() === '🚫 That tile is played', 'a played tile never goes back onto a rack');
    for (let n = 0; D().turn && n < 30; n++) R.job(holder(D().turn), { t: 'move', id: on(D().turn)[0], x: 100 + 100 * (n % 8), y: 420 + 130 * Math.floor(n / 8) });
    const left = [...on('south'), ...on('north')];
    ok(!D().turn && H.state.rules.public.winners.length === 1 && left.length === 1 && left.every((id) => it(id).up !== false) && /domino!$/.test(H.state.log.at(-1).txt), `a rack emptied: domino, and the tile left on the other rack is shown (${H.state.log.at(-1).txt})`);
    ok(R.same(), "the mirror's digest equals the host's");
  }
  section("(F8) Veiled Ranks (D285): moves keep a unit as it was, combat is announced, a stalemate of both sides is a draw, each unit its own label and log name");
  {
    const R = demo(BOXES.ranks, { a1: 's-banner', d4: 's-pike', e3: 's-crown', a10: 'n-banner', d5: 'n-pike' }), H = R.H, it = R.it, d = () => H.state.rules.data;
    const at = (sq) => Object.keys(H.state.items).find((id) => it(id).at?.endsWith(`:${sq}`) && /\/[sn]-/.test(it(id).t)), field = () => Object.values(H.state.items).find((x) => x.t.endsWith('/field'));
    const mv = (p, a, b) => { const f = field(), c = 'abcdefghij'.indexOf(b[0]), r = +b.slice(1) - 1; return R.job(p, { t: 'move', id: at(a), x: f.x + 30 + c * 100, y: f.y + 30 + (9 - r) * 100 }); };
    R.job(HOST, { t: 'rulesBtn', id: 'ready-south' });
    R.job(BOB, { t: 'rulesBtn', id: 'ready-north' });
    const crown = at('e3'), banner = at('a1'), backs = (r) => J(r.fx.filter((e) => e.t === 'back'));
    let r = mv(HOST, 'a1', 'a2');
    ok(r.notes.length === 1 && it(banner).at.endsWith(':a1') && backs(r) === J([{ t: 'back', p: HOST, ids: [banner] }]), `the Banner's step, refused: drawn back on Alice's screen alone (${J(r.notes)}, ${backs(r)})`);
    r = mv(HOST, 'e3', 'e4');
    ok(r.lines.map((e) => e.txt).join() === 'moved a hidden piece e3 → e4' && J(it(crown).vis) === J(['seat:south']), `a hidden step: one line, the unit still South's alone (${J(r.lines.map((e) => e.txt))})`);
    ok(backs(r) === '[]', `…and no \`back\` for it: the patch carries the step, a \`back\` ahead of it would draw the unit on e3 again for a frame (D293) (${backs(r)})`);
    r = mv(BOB, 'd5', 'd4');
    ok(r.lines.some((e) => e.txt === '📣 North Pike (2) and South Pike (2) fall together at d4') && r.fx.some((e) => e.t === 'ann'), `an attack's outcome is announced on every screen (${J(r.lines.map((e) => e.txt))})`);
    ok(r.lines.some((e) => /^revealed (South|North) Pike/.test(e.txt)), 'a revealed unit is logged by its name');
    mv(HOST, 'e4', 'e5');
    ok(d().phase === 'over' && J(H.state.rules.public.winners) === J([HOST]), 'North has no unit that can move, South does: South wins');
    const D = demo(BOXES.ranks, { a1: 's-banner', d4: 's-pike', a10: 'n-banner', d5: 'n-pike' });
    D.job(HOST, { t: 'rulesBtn', id: 'ready-south' });
    D.job(BOB, { t: 'rulesBtn', id: 'ready-north' });
    const f = Object.values(D.H.state.items).find((x) => x.t.endsWith('/field')), pike = Object.keys(D.H.state.items).find((id) => D.it(id).at?.endsWith(':d4'));
    r = D.job(HOST, { t: 'move', id: pike, x: f.x + 330, y: f.y + 530 }); // (d4 → d5)
    ok(D.H.state.rules.data.phase === 'over' && !D.H.state.rules.public.winners.length && /a draw$/.test(D.H.state.log.at(-1).txt), `the last movers of both sides fall together: a draw, no 🏆 (${D.H.state.log.at(-1).txt})`);
    const labels = Object.values(BOXES.ranks.types).filter((ty) => ty.meta?.side === 'south').map((ty) => ty.faces[0].label);
    ok(new Set(labels).size === labels.length && Object.values(BOXES.ranks.types).every((ty) => !ty.meta || ty.faces[0].name === ty.name), `each unit its own label (${labels.join(' ')}), its face named as its type`);
  }
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

// =============================================================================
// The test author's own sections, (1′) to (CP′), written apart from the
// implementation, from spec §5 (and §0.1, §2c, §2d, §3a, §3f.6, §4a, §4c)
// and the decisions it records (D249–D262): §5l's core list again (items 1
// to 8), checkPatch on private material, B22 and B23. They share nothing
// with the sections above but node-lib, RECT and the console helpers:
//  - their own room, `stage()`: the host table, each peer's view folded from
//    the bodies app.js's broadcast() builds (one shared text, each peer's own
//    part spliced on), and while rules run a Worker-like mirror whose every
//    patch the host checks (a refused one is kept in S.refused);
//  - their own boxes: VAULT (racks — 'reveal' zones owned through their
//    board, one of them Bob's by his id —, north's 'keep' screen, a zone of a
//    seat the table lacks, a zone that isn't private, a grid board, tiles,
//    gems, dice under a cup back, units, a stack, a coin with no back, a bag,
//    supplies and a pile of hidden pieces) and MANY (the fuzz's: every piece
//    of a type of its own, every face labelled apart, so a label or a type
//    ref in a body names one piece);
//  - an oracle: what each viewer must hold, read off the host state by §5a's
//    rule (`expectView`), never off T.mine; `audit()` checks every body of a
//    tick against §5d's forms and every folded view against the oracle.
// =============================================================================
const { typeAt, liveFx, floodCost } = core;
const EVE = 'e'.repeat(16);
const PEERS = [HOST, BOB, CAROL, DAVE];
const NAME = { [HOST]: 'Alice', [BOB]: 'Bob', [CAROL]: 'Carol', [DAVE]: 'Dave', [EVE]: 'Eve' };
const nm = (p) => NAME[p] || String(p).slice(0, 6);
/** Whether fn throws a TypeError (a script's malformed call: spec §0.2). */
const typeErr = (fn) => { try { quietly(fn); return false; } catch (e) { return e instanceof TypeError; } };
/** A piece's private fields, for comparisons: {up, vis, pv, po, owner} (absent: true / null). */
const pf = (x) => (x ? { up: x.up ?? true, vis: x.vis ?? null, pv: x.pv ?? null, po: x.po ?? null, owner: x.owner ?? null } : null);
const txts = (r) => r.lines.map((e) => e.txt);

/** VAULT's fixed item ids. */
const VID = {
  rackS: 'e1000001', rackS2: 'e1000002', rackB: 'e1000003', rackX: 'e1000004', rackN: 'e1000005', screen: 'e1000006', mat: 'e1000007', plain: 'e1000008', field: 'e1000009',
  t1: 'e2000001', t2: 'e2000002', t3: 'e2000003', gem: 'e2000004', d1: 'e2000005', d2: 'e2000006', d3: 'e2000007', d4: 'e2000008',
  u1: 'e2000009', u2: 'e200000a', stk: 'e200000b', coin: 'e200000c', bag: 'e200000d', sup: 'e200000e', coins: 'e200000f', pile: 'e2000010',
};
const BOARD_TYPES = [
  { id: 'rack', kind: 'board', w: 500, h: 140, zones: [{ id: 'z', poly: RECT(500, 140), owner: 'board', private: 'reveal' }] },
  { id: 'screen', kind: 'board', w: 600, h: 300, zones: [{ id: 's', poly: RECT(600, 300), owner: 'seat:north', private: 'keep' }] },
  { id: 'mat', kind: 'board', w: 400, h: 200, zones: [{ id: 'm', poly: RECT(400, 200), owner: 'seat:west', private: 'keep' }] },
  { id: 'plain', kind: 'board', w: 400, h: 200, zones: [{ id: 'p', poly: RECT(400, 200), owner: 'seat:south' }] },
  { id: 'field', kind: 'board', w: 400, h: 400, primary: true, grid: { type: 'square', cols: 4, rows: 4, cell: 100 } },
];
const BOARD_SETUP = [
  { piece: 'rack', at: [300, 1820], owner: 'seat:south', id: VID.rackS },
  { piece: 'rack', at: [900, 1820], owner: 'seat:south', id: VID.rackS2 },
  { piece: 'rack', at: [1500, 1820], id: VID.rackB }, // (the host gives it to Bob, by his id: stage's prep)
  { piece: 'rack', at: [2100, 1820], id: VID.rackX }, // (nobody's: its zone does nothing)
  { piece: 'rack', at: [300, 40], owner: 'seat:north', id: VID.rackN },
  { piece: 'screen', at: [1200, 300], id: VID.screen },
  { piece: 'mat', at: [2300, 300], id: VID.mat }, // (its owner a seat the table lacks: nothing)
  { piece: 'plain', at: [2300, 600], id: VID.plain }, // (owned, but not private: nothing)
  { piece: 'field', at: [2400, 1100], id: VID.field },
];
const SEATS3 = [{ id: 'south', name: 'South', edge: 'bottom' }, { id: 'north', name: 'North', edge: 'top' }, { id: 'east', name: 'East', edge: 'right' }];
const BACKS3 = [{ id: 'bt', color: '#334155' }, { id: 'bc', color: '#7c2d12' }, { id: 'bu', color: '#1e3a8a' }];
const VAULT = {
  name: 'Vault', table: { shape: 'rect', w: 3000, h: 2000 }, seats: SEATS3, backs: BACKS3,
  pieces: [...BOARD_TYPES,
    { id: 'tile', kind: 'tile', w: 60, h: 120, back: 'bt', faces: ['Qx01a', 'Qx01b', 'Qx01c'] },
    { id: 'gem', kind: 'tile', w: 60, h: 120, back: 'bt', faces: ['Qx02a', 'Qx02b'] },
    { id: 'die', kind: 'die', back: 'bc', faces: ['Qx03a', 'Qx03b', 'Qx03c', 'Qx03d', 'Qx03e', 'Qx03f'] },
    { id: 'unit', kind: 'token', shape: 'rect', w: 60, back: 'bu', faces: ['Qx04a', 'Qx04b'] },
    { id: 'coin', kind: 'token', faces: ['C'] },
  ],
  setup: [...BOARD_SETUP,
    { piece: 'tile', at: [100, 1000], id: VID.t1 },
    { piece: 'tile', at: [180, 1000], f: 1, id: VID.t2 },
    { piece: 'tile', at: [260, 1000], f: 2, id: VID.t3 },
    { piece: 'gem', at: [340, 1000], up: false, id: VID.gem },
    { piece: 'die', at: [600, 1000], id: VID.d1 },
    { piece: 'die', at: [680, 1000], id: VID.d2 },
    { piece: 'die', at: [760, 1000], id: VID.d3 },
    { piece: 'die', at: [840, 1000], id: VID.d4 },
    { piece: 'unit', at: [1000, 1000], id: VID.u1 },
    { piece: 'unit', at: [1080, 1000], f: 1, id: VID.u2 },
    { piece: 'unit', at: [1160, 1000], n: 3, id: VID.stk },
    { piece: 'coin', at: [700, 1300], id: VID.coin },
    { bag: [{ t: 'gem', up: false, n: 6 }], name: 'Sack', at: [2700, 80], id: VID.bag },
    { supply: 'tile', at: [1400, 1300], id: VID.sup },
    { supply: 'coin', at: [1520, 1300], id: VID.coins },
    { pile: [{ piece: 'gem', f: 1, up: false }, { piece: 'tile', f: 0, up: false }], at: [1700, 1300], name: 'Tiles', id: VID.pile },
  ],
};
/** MANY's ids: VAULT's boards, then its own pieces. */
const MID = { bag: 'e3000100', sup: 'e3000101', stk: 'e3000102', coin: 'e3000103', pile: 'e3000104' };
const BOARDS = BOARD_SETUP.map((e) => e.id);
/** The fuzz's box: VAULT's boards, and 22 pieces each of a type of its own —
 *  tiles p00–p11 and p20–p21 (those two in a pile, face down), dice p12–p15,
 *  units p16–p19 —, every face labelled "Qx<nn><a–f>": no two faces alike,
 *  so a label or a type ref in a body names one piece. Gems ("Qy…", a bag
 *  and a supply of them, and what t.spawn makes), a stack and a coin share
 *  their types. */
const MANY = (() => {
  const pieces = [...BOARD_TYPES], setup = [...BOARD_SETUP], pad = (k) => String(k).padStart(2, '0');
  for (let k = 0; k < 22; k++) {
    const id = `p${pad(k)}`, L = (c) => `Qx${pad(k)}${c}`;
    if (k >= 12 && k < 16) pieces.push({ id, kind: 'die', back: 'bc', faces: [...'abcdef'].map(L) });
    else if (k >= 16 && k < 20) pieces.push({ id, kind: 'token', shape: 'rect', w: 60, back: 'bu', faces: [L('a'), L('b')] });
    else pieces.push({ id, kind: 'tile', w: 60, h: 120, back: 'bt', faces: [L('a'), L('b')] });
    if (k < 20) setup.push({ piece: id, at: [100 + 80 * k, 1000 + 150 * (k % 2)], id: `e30000${k.toString(16).padStart(2, '0')}` });
  }
  pieces.push({ id: 'gem', kind: 'tile', w: 60, h: 120, back: 'bt', faces: ['Qy01a', 'Qy01b'] }, { id: 'stk', kind: 'token', shape: 'rect', w: 60, back: 'bu', faces: ['Qy02a'] },
    { id: 'coin', kind: 'token', faces: ['C'] });
  setup.push({ bag: [{ t: 'gem', up: false, n: 8 }], name: 'Sack', at: [2700, 80], id: MID.bag }, { supply: 'gem', at: [1400, 1450], id: MID.sup },
    { piece: 'stk', n: 3, at: [1500, 1450], id: MID.stk }, { piece: 'coin', at: [700, 1450], id: MID.coin },
    { pile: [{ piece: 'p20', up: false }, { piece: 'p21', f: 1, up: false }], at: [1800, 1350], name: 'Duo', id: MID.pile });
  return { name: 'Many', table: { shape: 'rect', w: 3000, h: 2000 }, seats: SEATS3, backs: BACKS3, pieces, setup };
})();

/** A room as app.js runs one (built apart from room() above): the host
 *  table `H`, the `cast` ([pid, name], the host first) joined, box `o.def`
 *  (VAULT; null: none) set up and the players seated by the host as
 *  `o.seats` says (Alice south, Bob north, Carol east, Dave watching), then
 *  `o.prep` (VAULT's: the host gives rackB to Bob). Each peer's view folds
 *  its bodies (S.tick: app.js's broadcast()). While rules run, a Worker-like
 *  mirror built at each Enable, as rules-worker.js builds one, runs every job
 *  and the host checks and takes its patch (S.job; a refused one is kept in
 *  S.refused). `o.seed` drives every roll, pull and shuffle, `o.prefix` the
 *  ids it mints. */
function stage(o = {}) {
  const cast = o.cast || [[HOST, 'Alice'], [BOB, 'Bob'], [CAROL, 'Carol'], [DAVE, 'Dave']], host = cast[0][0], seed = o.seed ?? 5;
  let n = 0, ready = null;
  const clk = { t: 1.8e12 }, uid = () => (o.prefix || '9') + (++n).toString(16).padStart(7, '0');
  const pageHooks = { // (the page answers the rules view only: every hook runs in the mirror)
    load: () => '', has: (h) => h === 'onSelect' && !!ready?.wants.includes('select'),
    flag: (k) => (k === 'strict' ? ready?.strict : undefined), call(h) { throw new Error(`${h}() ran on the page`); },
  };
  const H = quietly(() => createTable({}, { pid: host, now: () => (clk.t += 1000), uid, random: rng(seed), hooks: pageHooks })).value;
  H.open(cast[0][1]);
  for (const [p, name] of cast.slice(1)) quietly(() => H.apply(p, { t: '_join', name }));
  H.drain();
  const S = { H, M: null, host, pending: [], refused: [], peers: new Map(cast.map(([p]) => [p, { view: null }])) };
  const start = (code) => {
    H.syncSpots();
    const { keys, decks, boxes, boxSrc, ...state } = H.state, m = structuredClone({ state, decks, boxes, boxSrc }), hk = scriptHooks();
    const name = hk.load(code);
    S.M = quietly(() => createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid: host, now: () => clk.t, uid, random: rng(seed + 1), hooks: hk, mirror: true })).value;
    ready = { name, wants: hk.has('onSelect') ? ['select'] : [], strict: hk.flag('strict') === true };
  };
  /** What the job since log entry `last` did, its effects queued for the next tick: {fx, notes (p's), peeks, lines, error}. */
  const took = (p, last, error) => {
    const fx = H.drain(), k = H.state.log.lastIndexOf(last);
    S.pending.push(...fx);
    if (!H.state.rules?.enabled) S.M = null;
    return { fx, notes: fx.filter((e) => e.t === 'note' && e.p === p).map((e) => e.msg), peeks: fx.filter((e) => e.t === 'peek'), lines: H.state.log.slice(k + 1), error };
  };
  /** Job (p, a) where app.js runs it: on the mirror while rules run (its patch checked and taken by the host), else on the host. */
  S.job = (p, a) => {
    if (a.t === 'setRules' && p === host) { if (a.enabled) start(a.code); else S.M = null; }
    const last = H.state.log.at(-1);
    let error;
    if (S.M) {
      const r = quietly(() => S.M.job(p, a)).value;
      if (r.fatal) throw new Error(`the mirror's ${a.t} job was fatal: ${r.fatal}`);
      try { quietly(() => H.applyStatePatch(structuredClone(r.patch), structuredClone(r.out), { p, a })); } catch (e) { S.refused.push(`${a.t}: ${e.message}`); }
      S.M.drain();
      error = r.out.error;
    } else quietly(() => H.apply(p, a));
    return took(p, last, error);
  };
  /** A facade call straight on the host's table, as a hook makes it (rules off): [its value, the lines it wrote]. */
  S.api = (fn) => {
    const last = H.state.log.at(-1), v = quietly(() => fn(H.api)).value;
    H.snapshot(); // (writes the rules' aggregated lines, as a job's end does)
    return [v, took(HOST, last).lines];
  };
  /** One broadcast tick as app.js's broadcast(): the dirty sets taken once
   *  (`d`), one shared patch (`patch`, with the tick's action markers and
   *  banners), each peer's body spliced from it with its own part (T.mine) —
   *  or a snapshot for a peer with no view yet — and folded into its view.
   *  {d, patch, out: {pid: {body, text}}}. */
  S.tick = () => {
    const fxs = S.pending.filter((e) => e.t === 'fx').map((e) => e.f), anns = S.pending.filter((e) => e.t === 'ann').map((e) => e.msg);
    S.pending = [];
    const seq = H.state.seq, d = H.takeDirty(), content = H.patchContent(d), fx = liveFx(fxs, d);
    if (fx.length) content.fx = fx;
    if (anns.length) content.ann = anns;
    const head = { v: PROTO, boot: 1, seq, host }, empty = !Object.keys(content).length, patch = sharedText({ ...head, kind: 'patch', ...content });
    let snap = '';
    const snapText = () => (snap ||= sharedText({ ...head, kind: 'snap', ...H.snapContent(), fx: content.fx || [], ann: content.ann || [] }));
    const out = {};
    for (const [p, P] of S.peers) {
      let text;
      if (!P.view) text = spliceBody({ to: p, tp: p, ...H.mine(p) }, snapText());
      else {
        const parts = H.mine(p, d);
        if (empty && !Object.keys(parts).length) continue;
        text = spliceBody({ to: p, tp: p, base: P.view.seq, ...parts }, patch);
      }
      const body = JSON.parse(text);
      if (body.kind === 'snap') P.view = viewFromSnap(body);
      else applyViewPatch(P.view, body);
      out[p] = { body, text };
    }
    return { d, patch, out };
  };
  /** Peer p's view from a full snapshot now (call it right after a tick: a snapshot resets what the host last sent, as app.js's does). */
  S.fresh = (p) => viewFromSnap(JSON.parse(spliceBody({ to: p, tp: p, ...H.mine(p) }, sharedText({ v: PROTO, boot: 1, seq: H.state.seq, host, kind: 'snap', ...H.snapContent(), fx: [], ann: [] }))));
  S.it = (id) => H.state.items[id];
  S.view = (p) => S.peers.get(p).view;
  S.same = () => !S.M || H.digest() === S.M.digest();
  if (o.def !== null) {
    const def = o.def || VAULT, r = quietly(() => H.apply(host, { t: 'loadBox', box: boxFromDef(def), setup: true, clear: true }));
    if (!r.value) throw new Error(`the stage's box didn't set up: ${J(H.drain())}`);
    H.drain();
    S.box = Object.keys(H.state.boxes).find((b) => H.state.boxes[b].name === def.name);
    const seats = o.seats || { [HOST]: 'south', [BOB]: 'north', [CAROL]: 'east' };
    for (const [p] of cast) if (H.state.players[p].seatId) quietly(() => H.apply(host, { t: 'seat', p, watch: true }));
    for (const [p, s] of Object.entries(seats)) quietly(() => H.apply(host, { t: 'seat', p, id: s }));
    H.drain();
    (o.prep ?? ((T) => T.H.state.items[VID.rackB] && T.job(host, { t: 'owner', id: VID.rackB, to: BOB })))(S);
  }
  S.tick();
  return S;
}

// --- the oracle: §5a's rule and §5d's forms, read off the host state ------------
/** Who sits in named seat s on table H, or null: a seat ref names whoever holds it now (D261). */
const sitter = (H, s) => Object.keys(H.state.players).find((q) => H.state.players[q].seatId === s) ?? null;
/** The players vis list `vis` names on table H now, seat refs resolved. */
const whoSee = (H, vis = []) => vis.map((r) => (r.startsWith('seat:') ? sitter(H, r.slice(5)) : r)).filter(Boolean);
/** §5a's visibility rule: piece or supply `it` is hidden from viewer V — face down, and (a piece) its vis doesn't name V. */
const veiled = (H, V, it) => (it.k === 'g' || it.k === 's') && it.up === false && !(it.k === 'g' && whoSee(H, it.vis).includes(V));
/** Whether V's bodies must bring piece `it` in full (§5b): it lies hidden, its vis names V, and its box is in the catalog (§5d: otherwise the host can build no full form). */
const privy = (H, V, it) => it.k === 'g' && it.up === false && whoSee(H, it.vis).includes(V) && !!typeAt(H.state.boxes, it.t);
/** What viewer V must hold of every item on table H (§5b, §5d): the shared
 *  public form (T.pub — its shape checked apart, formProblem), or for a
 *  piece V holds privately that form shown (its t and f in place of b),
 *  with up: false and its vis. */
function expectView(H, V) {
  const out = {};
  for (const [id, it] of Object.entries(H.state.items)) {
    const pub = H.pub.get(id);
    if (!privy(H, V, it)) { out[id] = pub; continue; }
    const { b, ...rest } = pub;
    out[id] = { ...rest, t: it.t, f: it.f, up: false, vis: [...it.vis] };
  }
  return out;
}
const REDUCED = ['k', 'b', 'x', 'y', 'rot', 'z', 'n', 'owner', 'lock', 'at'];
/** Why shared form `o` of host item `it` is not §5d's (and §2d's), or '':
 *  a hidden piece or supply {k, b, x, y, rot, z, n?, owner?, lock?, at?} —
 *  never t, f, up —; a shown one with its t and f; no item with vis, pv or
 *  po (who sees a piece travels only in its viewers' own parts); a bag
 *  without `of`. */
function formProblem(it, o) {
  if (!o) return 'no shared form';
  const priv = ['vis', 'pv', 'po'].filter((k) => k in o);
  if (priv.length) return `it carries ${priv}`;
  if (it.k === 'b' && 'of' in o) return 'a bag shows what it holds';
  if (it.k !== 'g' && it.k !== 's') return '';
  if (it.up !== false) return 't' in o && 'f' in o && !('b' in o) ? '' : 'shown, without its t and f';
  const extra = Object.keys(o).filter((k) => !REDUCED.includes(k));
  return extra.length ? `hidden, it carries ${extra}` : 'b' in o ? '' : 'hidden, without its back';
}
/** The problems of one tick's bodies (`out`) and of every folded view, or []:
 *  each body's items in §5d's shared forms (formProblem); an override (`vis`)
 *  only beside an id of the same body's items, only for a piece its viewer
 *  holds privately, and that viewer's expected form; a place (`pos`) only
 *  numbers and an address; a marker only {p, id, x, y, roll?}; then every
 *  viewer's view equal to expectView, and its hand to its own. */
function audit(S, out) {
  const H = S.H, bad = [];
  for (const [V, { body }] of Object.entries(out)) {
    const items = body.items || {};
    for (const [id, o] of Object.entries(items)) {
      const it = H.state.items[id], why = it ? formProblem(it, o) : 'is no item of the host';
      if (why) bad.push(`${nm(V)}'s body: ${id} ${why}`);
    }
    const want = Object.keys(body.vis || {}).length ? expectView(H, V) : {};
    for (const [id, o] of Object.entries(body.vis || {})) {
      const it = H.state.items[id];
      if (!(id in items)) bad.push(`${nm(V)}'s body: an override for ${id} beside no item of the body`);
      else if (!it || !privy(H, V, it)) bad.push(`${nm(V)}'s body: an override for ${id}, which ${nm(V)} may not hold in full`);
      else if (canon(o) !== canon(want[id])) bad.push(`${nm(V)}'s override of ${id}: ${J(o)} ≠ ${J(want[id])}`);
    }
    for (const [id, m] of Object.entries(body.pos || {})) {
      if (!Array.isArray(m) || m.length < 4 || m.length > 5 || !m.slice(0, 4).every(Number.isFinite) || (m.length === 5 && typeof m[4] !== 'string')) bad.push(`${nm(V)}'s body: ${id}'s place is ${J(m)}`);
    }
    for (const f of body.fx || []) if (Object.keys(f).some((k) => !['p', 'id', 'x', 'y', 'roll'].includes(k))) bad.push(`${nm(V)}'s body: a marker ${J(f)}`);
  }
  for (const [V, P] of S.peers) {
    if (!P.view) continue;
    const want = expectView(H, V), got = P.view.items, ids = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((id) => canon(want[id]) !== canon(got[id]));
    if (ids.length) bad.push(`${nm(V)}'s view of ${ids[0]}: ${J(got[ids[0]])} ≠ ${J(want[ids[0]])}${ids.length > 1 ? ` (and ${ids.length - 1} more)` : ''}`);
    if (H.state.players[V] && canon(P.view.hand) !== canon(H.state.players[V].hand)) bad.push(`${nm(V)}'s hand: ${J(P.view.hand)} ≠ ${J(H.state.players[V].hand)}`);
  }
  return bad;
}
/** A tick, audited: ok() on it, labelled `what`; returns the tick. */
function tickOK(S, what) {
  const t = S.tick(), bad = audit(S, t.out);
  ok(!bad.length, `${what} — every body as §5d says, every view as the rule says${bad.length ? `: ${bad.slice(0, 3).join('; ')}` : ''}`);
  return t;
}
/** The face labels and type refs viewer V may read on table H now: of the pieces and supplies not hidden from V, of shown pile tops, of V's own hand. */
function sight(H, V) {
  const labels = new Set(), types = new Set(), add = (t, f) => { types.add(t); const l = typeAt(H.state.boxes, t)?.faces[f]?.label; if (l) labels.add(l); };
  for (const it of Object.values(H.state.items)) {
    if ((it.k === 'g' || it.k === 's') && !veiled(H, V, it)) add(it.t, it.f);
    const top = it.k === 'p' && it.cards.at(-1);
    if (top && top.up && top.t) add(top.t, top.f);
  }
  for (const m of H.state.players[V]?.hand || []) if (m.t) add(m.t, m.f);
  return { labels, types };
}
/** The rules script the facade sections drive: each chat of the host's names
 *  a facade call, `[op, ...args]` — 'spawnLike' spawns a piece of item
 *  args[0]'s type with options args[1] (so no type ref goes into the log) —
 *  and its value or its TypeError's message goes to t.data.r / t.data.e. */
const VEX = `({ name: 'Vex',
  onChat(t, msg, p) {
    let c;
    try { c = JSON.parse(msg); } catch (e) { return; }
    if (!Array.isArray(c) || typeof c[0] !== 'string') return;
    const [op, ...args] = c;
    try {
      t.data.r = (op === 'spawnLike' ? t.spawn(t.item(args[0]).t, args[1]) : t[op](...args)) ?? null;
      t.data.e = null;
    } catch (e) { t.data.r = null; t.data.e = String(e.message).slice(0, 200); }
  },
})`;

// --- (1′) the reduction, every row of §5d ----------------------------------------
function indepReduction() {
  section("(1′) every row of §5d, for every viewer, against §5a's rule (spec §5a, §5b, §5d, §2d; D249, D250, D261)");
  const S = stage(), H = S.H, it = S.it, V = S.view, keys = (o) => Object.keys(o || {}).sort().join();
  ok(J(PEERS.map((p) => H.state.players[p].seatId ?? null)) === J(['south', 'north', 'east', null]), 'Alice sits south, Bob north, Carol east; Dave watches');
  tickOK(S, 'the box set up');
  // cards (no vis: as in Phase 1)
  const [pile] = S.api((t) => t.addStandardDeck({ x: 2000, y: 1450 }));
  S.job(HOST, { t: 'deal', id: pile, x: 2120, y: 1450, up: true });
  S.job(HOST, { t: 'deal', id: pile, x: 2240, y: 1450 });
  tickOK(S, 'two cards dealt, one face up');
  const cards = Object.keys(H.state.items).filter((k) => it(k).k === 'c'), cu = cards.find((k) => it(k).up), cd = cards.find((k) => !it(k).up);
  ok(cu && cd && PEERS.every((p) => canon(V(p).items[cd]) === canon(V(DAVE).items[cd]) && canon(V(p).items[cu]) === canon(V(DAVE).items[cu])) && !('i' in V(BOB).items[cd]) && V(BOB).items[cu].i === it(cu).i,
    'a card: one form for everyone — face down without its index, face up with it');
  ok(typeErr(() => H.api.hide(cd, [BOB])) && typeErr(() => H.api.setVis(cu, [BOB])) && !('vis' in it(cd)), 't.hide and t.setVis of a card: TypeErrors (vis is for pieces whose type has a back)');
  ok(H.api.canSee(BOB, cu) === true && H.api.canSee(BOB, cd) === false, 't.canSee: a face-up card yes, a face-down one no');
  H.drain();
  // a shown piece: public, whatever its vis
  S.api((t) => t.setVis(VID.t1, [BOB]));
  tickOK(S, 't.setVis on a tile face up');
  ok(J(it(VID.t1).vis) === J([BOB]) && PEERS.every((p) => canon(V(p).items[VID.t1]) === canon(H.pub.get(VID.t1)) && 't' in V(p).items[VID.t1] && !('vis' in V(p).items[VID.t1])),
    'a shown piece that has a vis: {k, t, f, …} for everyone, and no vis on anyone\'s screen');
  ok(H.api.canSee(CAROL, VID.t1) && H.api.canSee(DAVE, VID.t1), 't.canSee: a piece face up is seen by all, whatever its vis');
  S.api((t) => t.setVis(VID.t1, null));
  // hidden from everyone: the back, to everyone — its owner too
  S.job(HOST, { t: 'flip', id: VID.t2 });
  S.job(HOST, { t: 'owner', id: VID.t2, to: HOST });
  let t = tickOK(S, 'a tile turned face down, then given to Alice');
  ok(it(VID.t2).up === false && !it(VID.t2).vis && PEERS.every((p) => keys(V(p).items[VID.t2]) === 'b,k,owner,rot,x,y,z' && V(p).items[VID.t2].owner === HOST) && PEERS.every((p) => !t.out[p]?.body.vis),
    'a piece hidden from everyone: {k, b, x, y, rot, z, owner} for all — Alice, its owner, too (owning is not seeing)');
  // hidden with a vis: in full for those it names, by id or by seat; the reduced form for the rest
  S.api((t) => t.hide(VID.u1, [BOB]));
  t = tickOK(S, 't.hide(u1, [Bob])');
  ok(keys(V(BOB).items[VID.u1]) === 'f,k,rot,t,up,vis,x,y,z' && V(BOB).items[VID.u1].t === it(VID.u1).t && V(BOB).items[VID.u1].f === it(VID.u1).f && V(BOB).items[VID.u1].up === false && J(V(BOB).items[VID.u1].vis) === J([BOB]),
    `Bob, whom its vis names: {k, t, f, x, y, rot, z, up: false, vis} (${J(V(BOB).items[VID.u1])})`);
  ok([HOST, CAROL, DAVE].every((p) => keys(V(p).items[VID.u1]) === 'b,k,rot,x,y,z' && V(p).items[VID.u1].b === `${S.box}/bu`), 'Alice, Carol, Dave: {k, b: the units\' back, x, y, rot, z}');
  ok(!!t.out[BOB].body.vis?.[VID.u1] && [HOST, CAROL, DAVE].every((p) => !t.out[p].body.vis) && !('t' in t.out[BOB].body.items[VID.u1]), "the full form travels in Bob's own part alone; the shared items carry the reduced one");
  const mvd = S.job(BOB, { t: 'move', id: VID.u1, x: 1000, y: 1050 }), [, vl] = S.api((t) => t.setVis(VID.u1, [BOB, 'seat:east']));
  ok(txts(mvd).join() === 'moved a hidden piece' && J(vl.map((e) => e.txt)) === J(['changed who sees a hidden piece']), `Bob moves it, the script changes who sees it: "${txts(mvd)}", "${vl.map((e) => e.txt)}" — no line names it (§5d)`);
  tickOK(S, "t.setVis(u1, [Bob, 'seat:east'])");
  ok(['t', 'vis'].every((k) => k in V(BOB).items[VID.u1] && k in V(CAROL).items[VID.u1]) && !('t' in V(HOST).items[VID.u1]) && !('t' in V(DAVE).items[VID.u1]), 'by id and by seat: Bob and Carol (east) in full, Alice and Dave reduced');
  ok(H.api.canSee(BOB, VID.u1) && H.api.canSee(CAROL, VID.u1) && !H.api.canSee(HOST, VID.u1) && !H.api.canSee(DAVE, VID.u1), "t.canSee follows the rule: Bob and Carol (by east's seat) yes, Alice and Dave no");
  S.job(HOST, { t: 'lock', id: VID.u1, on: true });
  S.job(HOST, { t: 'owner', id: VID.u1, to: 'seat:south' });
  tickOK(S, 'u1 locked and given to south');
  ok(PEERS.every((p) => V(p).items[VID.u1].lock === true && V(p).items[VID.u1].owner === 'seat:south') && !('t' in V(HOST).items[VID.u1]),
    "a lock and an owner change show in the full form and in the reduced one; Alice, south's, owns it and still doesn't see it");
  S.api((t) => t.hide(VID.stk, ['seat:north']));
  S.job(HOST, { t: 'move', id: VID.u2, x: it(VID.field).x + 120, y: it(VID.field).y + 220 });
  S.api((t) => t.hide(VID.u2, [CAROL]));
  tickOK(S, "a ×3 stack hidden for north, a unit on the grid hidden for Carol");
  ok(V(BOB).items[VID.stk].n === 3 && 't' in V(BOB).items[VID.stk] && V(DAVE).items[VID.stk].n === 3 && !('t' in V(DAVE).items[VID.stk]), 'a stack: n in both forms');
  ok(typeof it(VID.u2).at === 'string' && V(CAROL).items[VID.u2].at === V(DAVE).items[VID.u2].at && typeof V(DAVE).items[VID.u2].at === 'string' && 't' in V(CAROL).items[VID.u2],
    `an address: the same display form in both (${V(DAVE).items[VID.u2].at})`);
  // per message, never sticky: dropped from the vis, Bob gets the reduced form and holds it
  S.api((t) => t.setVis(VID.u1, ['seat:east']));
  t = tickOK(S, "t.setVis(u1, ['seat:east'])");
  ok(!!t.out[BOB].body.items?.[VID.u1] && !t.out[BOB].body.vis?.[VID.u1] && !('t' in V(BOB).items[VID.u1]) && 't' in V(CAROL).items[VID.u1],
    "Bob, no longer in its vis: the next body brings u1 with no override, and his view holds the reduced form; Carol's the full one");
  S.api((t) => t.setVis(VID.u1, null));
  tickOK(S, 't.setVis(u1, null)');
  ok(PEERS.every((p) => !('t' in V(p).items[VID.u1])), 'vis null: hidden from everyone, reduced for all');
  const [sp] = S.api((t) => t.spawn(it(VID.u1).t, { at: { x: 1300, y: 700 }, up: false, vis: ['seat:north'] }));
  tickOK(S, "t.spawn(unit, {up: false, vis: ['seat:north']}) on the open felt");
  ok(J(pf(it(sp))) === J({ up: false, vis: ['seat:north'], pv: null, po: null, owner: null }) && 't' in V(BOB).items[sp] && [HOST, CAROL, DAVE].every((p) => !('t' in V(p).items[sp])), "t.spawn's vis: hidden for north, Bob sees it in full, the rest its back");
  // a die under a cup: hers in full, its result too; a back to the rest — before and after a roll
  S.job(HOST, { t: 'hide', ids: [VID.d1] });
  tickOK(S, 'Alice cups d1');
  ok(keys(V(HOST).items[VID.d1]) === 'f,k,owner,rot,t,up,vis,x,y,z' && V(HOST).items[VID.d1].f === it(VID.d1).f && [BOB, CAROL, DAVE].every((p) => keys(V(p).items[VID.d1]) === 'b,k,owner,rot,x,y,z' && V(p).items[VID.d1].b === `${S.box}/bc`),
    'the cupped die: Alice holds it whole, its result included; the others {k, b: the cup, x, y, rot, z, owner}');
  const f0 = it(VID.d1).f;
  for (let k = 0; k < 6 && it(VID.d1).f === f0; k++) S.job(HOST, { t: 'roll', ids: [VID.d1] });
  t = tickOK(S, 'Alice rolls under the cup');
  ok(it(VID.d1).f !== f0 && V(HOST).items[VID.d1].f === it(VID.d1).f && [BOB, CAROL, DAVE].every((p) => !('f' in V(p).items[VID.d1]) && (t.out[p].body.fx || []).some((f) => f.roll?.includes(VID.d1))),
    "rolled: Alice's view shows the new result; everyone gets the tumble's marker, and no result");
  // a supply: as in Phase 2 — no vis
  S.job(HOST, { t: 'flip', id: VID.sup });
  tickOK(S, 'the supply turned face down');
  ok(PEERS.every((p) => keys(V(p).items[VID.sup]) === 'b,k,rot,x,y,z') && typeErr(() => H.api.hide(VID.sup, [BOB])) && typeErr(() => H.api.setVis(VID.sup, [BOB])) && H.api.canSee(HOST, VID.sup) === false,
    "a supply face down: {k, b, x, y, rot, z} for all; t.hide and t.setVis on it are TypeErrors (vis is for pieces); nobody can see it");
  // a bag: its count, never what it holds
  ok(PEERS.every((p) => V(p).items[VID.bag].n === 6 && !('of' in V(p).items[VID.bag])) && H.api.canSee(HOST, VID.bag) === false, 'a bag: {…, n} for all, never `of`; t.canSee: a bag never');
  H.drain();
  // a pile: a hidden piece on top is {b, up: false} to everyone — one that had a vis too (it stays behind: D249)
  S.api((t) => t.hide(VID.t1, [HOST]));
  S.job(HOST, { t: 'toPile', id: VID.t1, pile: VID.pile });
  t = tickOK(S, "Alice's private tile put on the Tiles pile");
  const top = H.state.items[VID.pile].cards.at(-1);
  ok(top && !('vis' in top) && PEERS.every((p) => J(V(p).items[VID.pile].top) === J({ b: `${S.box}/bt`, up: false })) && PEERS.every((p) => !t.out[p].body.vis),
    `the pile's top for everyone, Alice included: {b, up: false}; the member carries no vis (${J(top)})`);
  S.job(HOST, { t: 'flip', id: VID.pile });
  tickOK(S, 'the pile turned over');
  ok(PEERS.every((p) => V(p).items[VID.pile].top?.up === true && 't' in V(p).items[VID.pile].top), 'turned over: a shown top {t, f, up: true} for everyone');
  // a hand: its holder's alone
  S.job(CAROL, { t: 'toHand', id: VID.gem });
  S.api((t) => t.hide(VID.t3, [BOB]));
  S.job(BOB, { t: 'toHand', id: VID.t3 });
  tickOK(S, 'Carol takes the hidden gem into her hand, Bob his private tile');
  ok(J(V(CAROL).hand) === J(H.state.players[CAROL].hand) && V(CAROL).hand.length === 1 && V(CAROL).hand[0].up === false && 't' in V(CAROL).hand[0] && J(V(BOB).hand.map((m) => m.t)) === J([`${S.box}/tile`]) && !V(DAVE).hand.length,
    `each hand its holder's alone ({t, f, up?} entries: ${J(V(CAROL).hand)})`);
  ok(PEERS.every((p) => V(p).players[CAROL].handCount === 1 && V(p).players[BOB].handCount === 1 && !('hand' in V(p).players[CAROL])) && !V(DAVE).items[VID.t3] && !V(DAVE).items[VID.gem], 'everyone else: a count; the pieces gone from the table');
  // a box missing: no full form can be built — {b: null} for everyone, the vis viewers too
  const T = quietly(() => createTable(structuredClone(H.snapshot()), { pid: HOST })).value;
  T.takeDirty();
  const hid = Object.entries(T.state.items).filter(([, x]) => x.k === 'g' && x.up === false), withVis = hid.filter(([, x]) => x.vis);
  ok(withVis.length >= 2 && hid.every(([id]) => T.pub.get(id).b === null && !('t' in T.pub.get(id)) && !('f' in T.pub.get(id))) && PEERS.every((p) => !T.mine(p).vis),
    `the same table loaded without its catalog: every hidden piece {b: null}, and no override for anyone — ${withVis.length} with a vis (§5d)`);
  // a peer that is no registered player: the shared form alone
  ok(!Object.keys(H.mine(null)).length && !Object.keys(H.mine('f'.repeat(16))).length, 'a peer that is no player at the table: no part of its own, no override');
  S.tick();
  ok(PEERS.every((p) => canon(S.fresh(p).items) === canon(V(p).items)), "each viewer's folded view equals its own snapshot");
}

// --- (2′) private zones ------------------------------------------------------------
function indepZones() {
  section("(2′) private zones (spec §5a, §3a; D252, D257): entering with and without a back, 'reveal' versus 'keep', one owner's zones, another owner's, po");
  const S = stage(), H = S.H, it = S.it, V = S.view;
  const at = (b, k = 0) => ({ x: it(b).x + 40 + 70 * k, y: it(b).y + 10 }), mv = (p, id, spot) => S.job(p, { t: 'move', id, ...spot });
  const is = (id, want) => J(pf(it(id))) === J({ up: true, vis: null, pv: null, po: null, owner: null, ...want });
  // entering, a piece nobody owns: hidden for the zone's owner, pv, and the owner the zone gave (po)
  mv(HOST, VID.t1, at(VID.rackS));
  ok(is(VID.t1, { up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }), `a tile Alice sets on her rack (its board south's): face down for seat:south, pv, owned by it through po (${J(pf(it(VID.t1)))})`);
  // a real owner is kept: no po
  S.job(HOST, { t: 'owner', id: VID.t2, to: HOST });
  mv(HOST, VID.t2, at(VID.rackS, 1));
  ok(is(VID.t2, { up: false, vis: ['seat:south'], pv: 1, owner: HOST }), `her own tile: hidden there, still hers, no po (${J(pf(it(VID.t2)))})`);
  // a 'board' zone whose board a player owns by id: Bob's rack
  mv(CAROL, VID.t3, at(VID.rackB));
  ok(is(VID.t3, { up: false, vis: [BOB], pv: 1, po: 1, owner: BOB }), `Carol's tile set on Bob's rack (the board his, by id): hidden for Bob, his (${J(pf(it(VID.t3)))})`);
  const t3 = J(it(VID.t3)), r0 = mv(CAROL, VID.t3, { x: 1000, y: 1500 });
  ok(r0.notes.join() === '🚫 That belongs to Bob' && J(it(VID.t3)) === t3, `Carol can't take it back off (${r0.notes})`);
  // a piece hidden from everyone enters: now its zone owner's
  mv(BOB, VID.gem, at(VID.rackN));
  ok(is(VID.gem, { up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), "the gem, hidden from everyone, set on north's rack: hidden for seat:north");
  tickOK(S, 'tiles on racks');
  ok('t' in V(HOST).items[VID.t1] && 't' in V(BOB).items[VID.t3] && 't' in V(BOB).items[VID.gem] && !('t' in V(BOB).items[VID.t1]) && !('t' in V(CAROL).items[VID.t3]) && !('t' in V(DAVE).items[VID.gem]),
    'each rack shows its tiles to its owner alone');
  // within a zone, and between two zones of one owner: nothing changes
  const was = J(pf(it(VID.t1))), along = mv(HOST, VID.t1, at(VID.rackS, 4));
  mv(HOST, VID.t1, at(VID.rackS2, 2));
  ok(J(pf(it(VID.t1))) === was && it(VID.t1).x >= it(VID.rackS2).x, 'moved along her rack, then onto her second rack: up, vis, pv, po and owner as they were');
  ok(txts(along).join() === 'moved a hidden piece', `the log names no piece hidden from anyone (§5d): "${txts(along)}"`);
  // leaving a rack ('reveal'): face up for everyone; the owner po gave goes with it — a real owner stays
  mv(HOST, VID.t1, { x: 1000, y: 1500 });
  ok(is(VID.t1, {}), `played off the rack: face up, its vis, pv, po and the zone's owner gone (${J(pf(it(VID.t1)))})`);
  mv(HOST, VID.t2, { x: 1100, y: 1500 });
  ok(is(VID.t2, { owner: HOST }), `Alice's own tile off the rack: face up, still hers (${J(pf(it(VID.t2)))})`);
  // into another owner's zone: the entering rule again — the owner po gave follows the zone (D252), a real one stays
  mv(HOST, VID.t1, at(VID.rackS));
  mv(HOST, VID.t1, at(VID.rackB, 2));
  ok(is(VID.t1, { up: false, vis: [BOB], pv: 1, po: 1, owner: BOB }), `from Alice's rack onto Bob's: hidden for Bob, his through po (${J(pf(it(VID.t1)))})`);
  mv(HOST, VID.t2, at(VID.rackS, 2));
  mv(HOST, VID.t2, at(VID.rackB, 3));
  ok(is(VID.t2, { up: false, vis: [BOB], pv: 1, owner: HOST }), `Alice's own tile onto Bob's rack: hidden for Bob, still Alice's (${J(pf(it(VID.t2)))})`);
  mv(HOST, VID.t2, { x: 1100, y: 1500 });
  ok(is(VID.t2, { owner: HOST }), 'she takes it off his rack (hers to move): face up again, still hers');
  // a screen ('keep'): leaving takes pv alone — hidden still, vis, owner and po kept; a flip reveals it and po's owner goes
  mv(BOB, VID.u2, { x: it(VID.screen).x + 200, y: it(VID.screen).y + 100 });
  ok(is(VID.u2, { up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), "a unit behind north's screen: hidden for north");
  mv(BOB, VID.u2, { x: 1700, y: 700 });
  ok(is(VID.u2, { up: false, vis: ['seat:north'], po: 1, owner: 'seat:north' }), `moved out from behind it: pv gone, hidden from the others still (${J(pf(it(VID.u2)))})`);
  tickOK(S, 'a unit out from behind the screen');
  ok('t' in V(BOB).items[VID.u2] && [HOST, CAROL, DAVE].every((p) => !('t' in V(p).items[VID.u2])), 'Bob alone sees it out there');
  S.job(BOB, { t: 'flip', id: VID.u2 });
  ok(is(VID.u2, {}), `Bob turns it over: public, vis, po and the owner po gave all gone (${J(pf(it(VID.u2)))})`);
  // a screen and a rack of one owner (north's): moving between them changes nothing; leaving the rack is leaving a rack
  mv(BOB, VID.u1, { x: it(VID.screen).x + 300, y: it(VID.screen).y + 100 });
  const u1 = J(pf(it(VID.u1)));
  mv(BOB, VID.u1, at(VID.rackN, 3));
  ok(J(pf(it(VID.u1))) === u1, "from north's screen onto north's rack: nothing changes");
  mv(BOB, VID.u1, { x: 1000, y: 700 });
  ok(is(VID.u1, {}), `then off the rack: a rack reveals what leaves it (${J(pf(it(VID.u1)))})`);
  // no hidden side: refused for a person before anything changes, a TypeError for a script
  const c0 = J(it(VID.coin)), n0 = Object.keys(H.state.items).length;
  const rc = mv(HOST, VID.coin, at(VID.rackS, 5)), rt = S.job(HOST, { t: 'take', id: VID.coins, ...at(VID.rackS, 5) });
  ok(rc.notes.join() === '🚫 That piece has no hidden side' && rt.notes.join() === '🚫 That piece has no hidden side' && J(it(VID.coin)) === c0 && Object.keys(H.state.items).length === n0,
    `the coin (no back) onto a rack, a coin taken from its supply onto one: "🚫 That piece has no hidden side", nothing changed (${rc.notes}; ${rt.notes})`);
  ok(typeErr(() => H.api.move(VID.coin, at(VID.rackS, 5).x, at(VID.rackS, 5).y)) && J(it(VID.coin)) === c0, 'a script moving it there: a TypeError, the coin where it was');
  H.drain();
  // zones that do nothing: a board nobody owns, a seat the table lacks, a zone that isn't private
  mv(HOST, VID.d1, at(VID.rackX));
  mv(HOST, VID.d2, { x: it(VID.mat).x + 100, y: it(VID.mat).y + 50 });
  mv(HOST, VID.d3, { x: it(VID.plain).x + 100, y: it(VID.plain).y + 50 });
  ok(is(VID.d1, {}) && is(VID.d2, {}) && is(VID.d3, {}), "a rack nobody owns, a zone of a seat the table lacks (seat:west), a zone that isn't private: nothing is hidden");
  // a zone becomes active when its board gets an owner — what lies there is untouched until it is placed again
  S.job(HOST, { t: 'owner', id: VID.rackX, to: CAROL });
  ok(is(VID.d1, {}), 'the host gives that rack to Carol: the die on it stays as it was (nothing was placed)');
  mv(HOST, VID.d1, at(VID.rackX, 2));
  ok(is(VID.d1, { up: false, vis: [CAROL], pv: 1, po: 1, owner: CAROL }), 'moved along it: hidden for Carol now');
  // a seat's zone is active whether or not the seat is held (D252): hidden for an empty north, then seen by whoever sits there
  S.job(HOST, { t: 'seat', p: BOB, watch: true });
  mv(CAROL, VID.u2, { x: it(VID.screen).x + 100, y: it(VID.screen).y + 100 });
  tickOK(S, 'north left empty; a unit set behind its screen');
  ok(is(VID.u2, { up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }) && PEERS.every((p) => !('t' in V(p).items[VID.u2])), "nobody holds north: the unit hidden for seat:north, seen by no one");
  S.job(HOST, { t: 'seat', p: DAVE, id: 'north' });
  tickOK(S, 'Dave sits north');
  ok('t' in V(DAVE).items[VID.u2] && !('t' in V(BOB).items[VID.u2]), 'Dave, now north, sees it; Bob, watching, does not');
  S.job(HOST, { t: 'seat', p: DAVE, watch: true });
  S.job(HOST, { t: 'seat', p: BOB, id: 'north' });
  // a board's move fires nothing: it leaves its tiles as they were, and a shown piece it slides under stays shown
  S.job(HOST, { t: 'pull', id: VID.bag, ...at(VID.rackS, 4) });
  const pulled = Object.keys(H.state.items).find((k) => it(k).k === 'g' && it(k).pv && it(k).vis?.[0] === 'seat:south' && !Object.values(VID).includes(k));
  ok(pulled && is(pulled, { up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }), 'a gem pulled from the bag straight onto her rack lands hidden there');
  S.job(HOST, { t: 'lock', id: VID.rackS, on: false });
  const pz = J(pf(it(pulled))), ry = it(VID.rackS).y;
  S.job(HOST, { t: 'move', id: VID.rackS, x: it(VID.rackS).x, y: ry - 400 });
  ok(it(VID.rackS).y < ry && J(pf(it(pulled))) === pz, `Alice moves her rack (south's) away from the gem: the gem stays as it was (${pz})`);
  S.job(HOST, { t: 'move', id: VID.rackS, x: it(VID.t2).x - 30, y: it(VID.t2).y - 10 });
  ok(is(VID.t2, { owner: HOST }), 'and slides it under her shown tile: the tile stays shown');
  mv(HOST, pulled, { x: 2000, y: 1000 });
  ok(is(pulled, { up: false, vis: ['seat:south'], po: 1, owner: 'seat:south' }), `the gem, its rack gone from under it, moved: it leaves as from a screen — hidden still, pv gone (D252) (${J(pf(it(pulled)))})`);
  // new pieces into a zone: a deal, a take, a split, a play, a group move, t.spawn, t.move
  const fresh = (before) => Object.keys(H.state.items).filter((k) => !before.has(k));
  let ids = new Set(Object.keys(H.state.items));
  let r = S.job(HOST, { t: 'deal', id: VID.pile, ...at(VID.rackS2, 5) });
  let nu = fresh(ids);
  ok(nu.length === 1 && is(nu[0], { up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }) && /^dealt a piece face down\b/.test(txts(r).join()), `a piece dealt from the pile onto her rack: hidden there; "${txts(r)}" (D257)`);
  S.job(HOST, { t: 'owner', id: VID.sup, to: HOST });
  ids = new Set(Object.keys(H.state.items));
  r = S.job(HOST, { t: 'take', id: VID.sup, ...at(VID.rackS2, 4) });
  nu = fresh(ids);
  ok(nu.length === 1 && is(nu[0], { up: false, vis: ['seat:south'], pv: 1, owner: HOST }), `a tile taken from her own supply onto her rack: hidden, hers (the supply's owner), no po (${J(nu.map((k) => pf(it(k))))})`);
  ids = new Set(Object.keys(H.state.items));
  S.job(BOB, { t: 'split', id: VID.stk, n: 1, x: it(VID.screen).x + 400, y: it(VID.screen).y + 100 });
  nu = fresh(ids);
  ok(nu.length === 1 && is(nu[0], { up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }) && is(VID.stk, {}) && it(VID.stk).n === 2, 'one split off the ×3 stack onto the screen: hidden for north; the stack (×2) shown');
  S.job(HOST, { t: 'toHand', id: VID.t2 });
  const h0 = H.state.players[HOST].hand[0];
  ids = new Set(Object.keys(H.state.items));
  r = S.job(HOST, { t: 'play', idx: 0, type: h0.t, f: h0.f, ...at(VID.rackS2, 3) });
  nu = fresh(ids);
  ok(nu.length === 1 && is(nu[0], { up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }) && /^played a piece face down/.test(txts(r).join()), `played from her hand onto her rack: hidden there; "${txts(r)}" (D257)`);
  mv(HOST, VID.d3, { x: it(VID.d4).x + 80, y: it(VID.d4).y });
  S.job(HOST, { t: 'group', op: 'move', ids: [VID.d3, VID.d4], dx: it(VID.rackN).x + 200 - it(VID.d4).x, dy: it(VID.rackN).y + 40 - it(VID.d4).y });
  ok(is(VID.d3, { up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }) && is(VID.d4, { up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }), "a group move of two dice onto north's rack: each placed, each hidden for north");
  const [sp] = S.api((t) => t.spawn(it(VID.t1).t, { at: { x: at(VID.rackS2, 1).x, y: at(VID.rackS2, 1).y } }));
  S.api((t) => t.move(VID.t3, at(VID.rackN, 5).x, at(VID.rackN, 5).y));
  ok(is(sp, { up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }) && is(VID.t3, { up: false, vis: ['seat:north'], pv: 1, po: 1, owner: 'seat:north' }),
    "t.spawn onto south's second rack and t.move from Bob's rack onto north's: each hidden for the zone it lands in");
  tickOK(S, 'every placement into a zone');
}

// --- (3′) peek -------------------------------------------------------------------
function indepPeek() {
  section('(3′) peek, the piece variant (spec §5c, §5j cases 4 and 7; D255): {t, f} to the peeker alone, loud, vetoable');
  const S = stage(), it = S.it, V = S.view;
  S.job(HOST, { t: 'move', id: VID.t1, x: it(VID.rackS).x + 40, y: it(VID.rackS).y + 10 });
  S.job(HOST, { t: 'hide', ids: [VID.d1] });
  tickOK(S, "a tile on Alice's rack, her die cupped");
  let r = S.job(DAVE, { t: 'peek', id: VID.t1 });
  ok(r.peeks.length === 1 && r.peeks[0].p === DAVE && J(r.peeks[0].c) === J({ t: it(VID.t1).t, f: it(VID.t1).f }), `Dave peeks at Alice's rack tile — owned through po, but a peek asks no owner: {t, f} to him alone (${J(r.peeks)})`);
  ok(J(r.lines.map((e) => [e.p, e.txt, e.k])) === J([[DAVE, 'peeked at a hidden piece', 1]]), `one line on the record, loud, naming nothing (${J(r.lines)})`);
  let t = tickOK(S, "after Dave's peek");
  ok(!('t' in V(DAVE).items[VID.t1]) && !Object.values(t.out).some(({ text }) => /"peek"/.test(text)), "his view still holds the back: the answer went in a note, in no body");
  r = S.job(CAROL, { t: 'peek', id: VID.d1 });
  ok(r.peeks.length === 1 && r.peeks[0].p === CAROL && r.peeks[0].c.f === it(VID.d1).f, "Carol peeks under Alice's cup: the die's value, to her alone");
  r = S.job(BOB, { t: 'peek', id: VID.gem });
  ok(r.peeks.length === 1 && J(r.peeks[0].c) === J({ t: it(VID.gem).t, f: it(VID.gem).f }) && r.lines.length === 1, 'a piece hidden from everyone: answered, loud');
  for (const [p, id, what] of [[HOST, VID.t1, 'Alice, her own rack tile'], [HOST, VID.d1, 'Alice, her cupped die'], [BOB, VID.t2, 'a piece face up']]) {
    r = S.job(p, { t: 'peek', id });
    ok(!r.peeks.length && !r.lines.length && r.notes.join() === 'You can already see it', `${what}: "You can already see it", no line, no answer (${r.notes})`);
  }
  // a pile whose top is a hidden piece: its top; an owned pile only for its owner (§2c: mayHandle on the pile)
  r = S.job(BOB, { t: 'peek', id: VID.pile });
  const top = it(VID.pile).cards.at(-1);
  ok(r.peeks.length === 1 && J(r.peeks[0].c) === J({ t: top.t, f: top.f }) && r.lines.length === 1 && r.lines[0].k === 1, `a pile whose top is a hidden piece: {t, f} of the top, loud (${J(r.lines.map((e) => e.txt))})`);
  S.job(HOST, { t: 'owner', id: VID.pile, to: HOST });
  r = S.job(BOB, { t: 'peek', id: VID.pile });
  ok(!r.peeks.length && r.notes.join() === '🚫 That belongs to Alice', `Alice's pile: refused to Bob (${r.notes})`);
  tickOK(S, 'after the peeks');
  // vetoable: a validate that refuses peeks blocks a piece peek, with the notice
  S.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Shut', validate(t, a) { if (a.t === 'peek') return 'No peeking'; } })" });
  r = S.job(DAVE, { t: 'peek', id: VID.t1 });
  ok(!r.peeks.length && /No peeking/.test(r.notes.join()) && !r.lines.some((e) => e.txt === 'peeked at a hidden piece'), `validate vetoes it: no answer, the notice (${r.notes})`);
  // strict refuses a peek unless it is allowed
  S.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Tight', strict: true })" });
  r = S.job(DAVE, { t: 'peek', id: VID.t1 });
  ok(!r.peeks.length && r.notes.length === 1, `strict: refused (${r.notes})`);
  S.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Tight', strict: true, allow: ['peek'] })" });
  r = S.job(DAVE, { t: 'peek', id: VID.t1 });
  ok(r.peeks.length === 1 && r.peeks[0].p === DAVE && J(r.peeks[0].c) === J({ t: it(VID.t1).t, f: it(VID.t1).f }) && r.lines.some((e) => e.txt === 'peeked at a hidden piece' && e.k === 1),
    'strict with allow: [\'peek\']: answered through the mirror, the host took its patch');
  ok(!S.refused.length && S.same(), `host and mirror agree, no patch refused (${S.refused.join('; ')})`);
  tickOK(S, 'with the rules on');
}

// --- (4′) hide, roll and flip of hidden dice; the private-piece rule ---------------------------
function indepHide() {
  section('(4′) hide, roll and flip of hidden dice; the private-piece rule (spec §5c, §5j cases 5, 6, 8, 9, 11; D253, D254, D256)');
  const S = stage(), H = S.H, it = S.it, V = S.view, is = (id, want) => J(pf(it(id))) === J({ up: true, vis: null, pv: null, po: null, owner: null, ...want });
  S.job(HOST, { t: 'owner', id: VID.d2, to: HOST });
  S.job(HOST, { t: 'owner', id: VID.d3, to: 'seat:south' });
  let r = S.job(HOST, { t: 'hide', ids: [VID.d1, VID.d2, VID.d3] });
  ok(is(VID.d1, { up: false, vis: [HOST], po: 1, owner: HOST }), `hide on a die nobody owned: hidden for Alice, hers, po (${J(pf(it(VID.d1)))})`);
  ok(is(VID.d2, { up: false, vis: [HOST], owner: HOST }), `on one she owned: no po (${J(pf(it(VID.d2)))})`);
  ok(is(VID.d3, { up: false, vis: [HOST], owner: 'seat:south' }), `on one her seat owns: vis is her id, not her seat (§5c's decision); the seat keeps it; no po (${J(pf(it(VID.d3)))})`);
  ok(txts(r).join() === 'hid 3 pieces', `"hid 3 pieces" (${txts(r)})`);
  r = S.job(BOB, { t: 'hide', ids: [VID.u1] });
  ok(txts(r).join() === 'hid Qx04a' && is(VID.u1, { up: false, vis: [BOB], po: 1, owner: BOB }), `one piece: "hid {label}", as it showed a moment ago (${txts(r)})`);
  tickOK(S, 'three dice cupped, a unit hidden');
  // flip (Reveal) clears both: the owner po gave and po; an owner of her own stays
  r = S.job(HOST, { t: 'flip', id: VID.d1 });
  ok(is(VID.d1, {}) && txts(r).join() === `turned over ${it(VID.d1) && H.state.boxes[S.box].types.die.faces[it(VID.d1).f].label}`, `Alice reveals d1: face up, vis, po and the owner po gave all gone; "${txts(r)}"`);
  S.job(HOST, { t: 'flip', id: VID.d2 });
  ok(is(VID.d2, { owner: HOST }), 'd2, which she owned before: face up, still hers');
  // the private-piece rule: whoever neither sees nor owns a private piece is refused flip, roll and face, uniformly, before any other check
  S.job(HOST, { t: 'hide', ids: [VID.d1] });
  const before = J(H.state.items);
  const tries = [[{ t: 'flip', id: VID.d1 }], [{ t: 'roll', ids: [VID.d1] }], [{ t: 'face', id: VID.d1, f: 1 }], [{ t: 'face', id: VID.d1, f: 99 }],
    [{ t: 'roll', ids: [VID.u1] }], [{ t: 'face', id: VID.u1, f: 1 }], [{ t: 'flip', id: VID.u1 }]].map(([a]) => [a.t, S.job(CAROL, a).notes.join()]);
  ok(tries.every(([, n]) => n === '🚫 That piece is hidden') && J(H.state.items) === before,
    `Carol on Alice's cupped die and Bob's hidden unit — flip, roll, face (a face out of range too), a roll of what isn't a die: each "🚫 That piece is hidden", nothing changed (${J(tries)})`);
  // a script's unit hidden for a seat, with no owner (case 9): refused uniformly to south; north rolls it
  S.api((t) => t.hide(VID.d4, ['seat:north']));
  const d4 = J(it(VID.d4)), nine = [{ t: 'flip', id: VID.d4 }, { t: 'roll', ids: [VID.d4] }, { t: 'face', id: VID.d4, f: 0 }].map((a) => S.job(HOST, a).notes.join());
  ok(!it(VID.d4).owner && nine.every((n) => n === '🚫 That piece is hidden') && J(it(VID.d4)) === d4, `t.hide(d4, ['seat:north']), no owner: Alice's flip, roll and face, "🚫 That piece is hidden" (${J(nine)})`);
  r = S.job(BOB, { t: 'roll', ids: [VID.d4] });
  ok(!r.notes.length && txts(r).join() === 'rolled a hidden die', `Bob, north, in its vis, rolls it: "${txts(r)}"`);
  // an owner its vis doesn't name may turn it over, roll it and set its face ("unless the actor owns it")
  S.job(HOST, { t: 'owner', id: VID.u2, to: HOST });
  S.api((t) => { t.hide(VID.u2, [BOB]); t.hide(VID.d2, [BOB]); });
  r = S.job(HOST, { t: 'face', id: VID.u2, f: 0 });
  ok(it(VID.u2).f === 0 && txts(r).join() === 'turned a hidden piece', `Alice owns u2, hidden for Bob alone: she sets its face — "${txts(r)}"`);
  r = S.job(HOST, { t: 'roll', ids: [VID.d2] });
  ok(!r.notes.length && txts(r).join() === 'rolled a hidden die', 'and rolls her die hidden for Bob');
  tickOK(S, 'an owner outside the vis acts');
  ok(!('t' in V(HOST).items[VID.u2]) && 't' in V(BOB).items[VID.u2] && V(BOB).items[VID.u2].f === 0, 'the face she set shows to Bob alone; she still sees the back');
  S.job(HOST, { t: 'flip', id: VID.u2 });
  ok(is(VID.u2, { owner: HOST }), 'and turns it over: public, still hers');
  // a piece hidden from everyone (no vis) is unaffected: anyone who may handle it turns it over; a roll is refused (§2c)
  S.job(HOST, { t: 'flip', id: VID.d2 }); // (Alice owns d2: revealed)
  S.job(HOST, { t: 'flip', id: VID.d2 }); // (face down again, for nobody)
  ok(is(VID.d2, { up: false, owner: HOST }), 'd2 turned face down: hidden from everyone, Alice its owner');
  ok(S.job(HOST, { t: 'roll', ids: [VID.d2] }).notes.join() === '🚫 That piece is hidden', 'its owner may not roll a die hidden from everyone (§2c: no vis, no exception)');
  r = S.job(DAVE, { t: 'flip', id: VID.gem });
  ok(is(VID.gem, {}) && !r.notes.length, 'anyone turns over a piece hidden from everyone that they may handle (the gem: Dave)');
  // rolls: everyone sees the tumble; the line names the shown dice's values alone
  S.job(HOST, { t: 'flip', id: VID.d2 });
  S.api((t) => t.reveal(VID.d4));
  S.job(HOST, { t: 'hide', ids: [VID.d2] }); // (d1 and d2 under Alice's cup; d3 hers, turned up; d4 shown)
  S.job(HOST, { t: 'flip', id: VID.d3 });
  tickOK(S, 'two dice cupped, two shown');
  const label = (id) => H.state.boxes[S.box].types.die.faces[it(id).f].label, four = [VID.d1, VID.d2, VID.d3, VID.d4];
  r = S.job(HOST, { t: 'roll', ids: four });
  let t = tickOK(S, 'a roll of two cupped and two shown dice');
  ok(txts(r).join() === `rolled 4 dice (2 hidden): ${label(VID.d3)} · ${label(VID.d4)}`, `"rolled 4 dice (2 hidden): a · b" — the shown dice's values in id order (${txts(r)})`);
  ok([BOB, CAROL, DAVE].every((p) => four.every((id) => (t.out[p].body.fx || []).some((f) => f.roll?.includes(id)))) && [VID.d1, VID.d2].every((id) => V(HOST).items[id].f === it(id).f),
    "every die tumbles on every screen; the cupped dice's results reach Alice alone");
  ok(txts(S.job(HOST, { t: 'roll', ids: [VID.d1, VID.d2] })).join() === 'rolled 2 hidden dice' && txts(S.job(HOST, { t: 'roll', ids: [VID.d1] })).join() === 'rolled a hidden die', '"rolled 2 hidden dice", "rolled a hidden die"');
  r = S.job(HOST, { t: 'group', op: 'roll', ids: four });
  ok(txts(r).join() === `rolled 4 dice (2 hidden): ${label(VID.d3)} · ${label(VID.d4)}`, `a group roll: the same line (${txts(r)})`);
  const [, ln] = S.api((t) => t.roll(VID.d1));
  ok(J(ln.map((e) => [e.p, e.txt])) === J([[RULES, 'rolled a hidden die']]), `t.roll of a cupped die: "📜 Rules rolled a hidden die" (${J(ln)})`);
  tickOK(S, 'after the rolls');
  // forged fields are ignored (case 6): no action sets anyone's vis but the actor's own hide
  const t1 = pf(it(VID.t1));
  S.job(DAVE, { t: 'move', id: VID.t1, x: 500, y: 600, vis: [DAVE], up: false, pv: 1, po: 1, owner: DAVE });
  ok(J(pf(it(VID.t1))) === J(t1) && it(VID.t1).x === 500, `Dave's move carrying vis, up, pv, po and owner: moved, nothing else (${J(pf(it(VID.t1)))})`);
  S.job(DAVE, { t: 'hide', ids: [VID.t3], vis: [DAVE, BOB], up: true, owner: BOB });
  ok(is(VID.t3, { up: false, vis: [DAVE], po: 1, owner: DAVE }), `his hide carrying vis [Dave, Bob] and up: hidden for Dave alone (${J(pf(it(VID.t3)))})`);
  // hide's own checks (§5j): a back, mayHandle, notLocked
  S.job(HOST, { t: 'lock', id: VID.t2, on: true });
  const five = [[VID.t2, 'locked'], [VID.d3, "Alice's (south's)"], [VID.coin, 'no back'], [VID.d1, 'cupped by Alice']].map(([id, what]) => [what, S.job(BOB, { t: 'hide', ids: [id] }).notes.join()]);
  ok(J(five) === J([['locked', '🔒 That is locked in place'], ["Alice's (south's)", '🚫 That belongs to South'], ['no back', '🚫 That piece has no hidden side'], ['cupped by Alice', '🚫 That piece is hidden']]),
    `Bob's hides refused: ${J(five)}`);
  // a group hide: each member as a hide, one line; the flood cost of a group
  r = S.job(CAROL, { t: 'group', op: 'hide', ids: [VID.u1, VID.stk, VID.coin] });
  ok(is(VID.stk, { up: false, vis: [CAROL], po: 1, owner: CAROL }) && txts(r).join() === 'hid 1 piece' && /^2 of 3 were skipped: /.test(r.notes.join()),
    `Carol's group hide of Bob's unit, the stack and the coin: the stack hidden for her, the rest skipped — one line, one notice (${txts(r)}; ${r.notes})`);
  ok(GROUP_OPS.includes('hide') && RULED_ACTIONS.includes('hide') && PUBLIC_ACTIONS.includes('hide') && floodCost({ t: 'group', op: 'hide', ids: Array.from({ length: 40 }, (_, k) => `x${k}`) }) === 3 && floodCost({ t: 'hide', ids: [VID.t1] }) === 1,
    'hide: a public, ruled action; a group op costing 1 + ⌊N/20⌋ (40 members: 3)');
  tickOK(S, 'the end of (4′)');
}

// --- (5′) a seat changes hands --------------------------------------------------------
function indepSeats() {
  section('(5′) byVis: a seat changing hands re-sends every piece seen by that seat (spec §5a, §5j case 3; D251)');
  const S = stage(), H = S.H, V = S.view;
  S.api((t) => { t.hide(VID.u1, ['seat:north']); t.hide(VID.u2, [BOB]); t.hide(VID.t1, ['seat:east']); t.hide(VID.t2, ['seat:north', 'seat:east']); });
  tickOK(S, "pieces seen by north, by Bob's id, by east, by both seats");
  const sees = (p, id) => 't' in V(p).items[id];
  ok(sees(BOB, VID.u1) && sees(BOB, VID.u2) && sees(CAROL, VID.t1) && sees(BOB, VID.t2) && sees(CAROL, VID.t2) && !sees(DAVE, VID.u1), 'Bob sees north\'s and his own, Carol east\'s, both the shared one, Dave none');
  // north changes hands in one tick: Bob to the watchers, Dave north
  S.job(HOST, { t: 'seat', p: BOB, watch: true });
  S.job(HOST, { t: 'seat', p: DAVE, id: 'north' });
  let t = tickOK(S, 'Bob stands up, Dave sits north');
  ok(t.d.items.has(VID.u1) && t.d.items.has(VID.t2), "the pieces north's seat sees are re-sent (touched)");
  ok(sees(DAVE, VID.u1) && !sees(BOB, VID.u1) && sees(BOB, VID.u2) && !sees(DAVE, VID.u2) && !!t.out[BOB].body.items?.[VID.u1] && !t.out[BOB].body.vis?.[VID.u1],
    "Dave gains north's piece; Bob is sent its reduced form, and keeps the one his id sees, which Dave never gets");
  // the seat left empty: nobody sees what it sees
  S.job(HOST, { t: 'seat', p: DAVE, watch: true });
  t = tickOK(S, 'Dave stands up: north is empty');
  ok(t.d.items.has(VID.u1) && PEERS.every((p) => !sees(p, VID.u1)) && sees(CAROL, VID.t2), "nobody sees north's piece; the one both seats see, east still sees");
  // a player sitting down by himself
  S.job(BOB, { t: 'seat', id: 'north' });
  tickOK(S, 'Bob sits north again');
  ok(sees(BOB, VID.u1) && sees(BOB, VID.t2), 'Bob sees north\'s pieces again');
  // two seats change hands in one tick
  S.job(HOST, { t: 'seat', p: CAROL, watch: true });
  S.job(HOST, { t: 'seat', p: BOB, id: 'east' });
  S.job(HOST, { t: 'seat', p: CAROL, id: 'north' });
  t = tickOK(S, 'Bob moves east, Carol north');
  ok(t.d.items.has(VID.u1) && t.d.items.has(VID.t1) && sees(CAROL, VID.u1) && !sees(CAROL, VID.t1) && sees(BOB, VID.t1) && sees(BOB, VID.u2) && !sees(BOB, VID.u1), 'each sees what their new seat sees, and Bob still what his id sees');
  // a newcomer who takes a free seat on joining (D251: whatever path)
  S.job(HOST, { t: 'seat', p: CAROL, watch: true });
  S.peers.set(EVE, { view: null });
  S.job(EVE, { t: '_join', name: 'Eve' });
  t = tickOK(S, 'Carol leaves north; Eve joins');
  ok(H.state.players[EVE].seatId === 'north' && sees(EVE, VID.u1) && !sees(CAROL, VID.u1) && t.d.items.has(VID.u1), `Eve, seated north as she joins, gets north's piece; Carol, watching, its back (Eve: ${H.state.players[EVE].seatId})`);
  // the rules re-seat everyone: t.setSeats
  S.api((t) => t.setSeats([{ id: 'east', name: 'East', edge: 'right' }, { id: 'north', name: 'North', edge: 'top' }, { id: 'south', name: 'South', edge: 'bottom' }]));
  t = tickOK(S, 't.setSeats re-seats the table');
  const north = sitter(H, 'north'), east = sitter(H, 'east');
  ok(PEERS.concat(EVE).every((p) => sees(p, VID.u1) === (p === north) && sees(p, VID.t1) === (p === east)), `after t.setSeats: north's piece to ${nm(north)}, east's to ${nm(east)}, and to no one else`);
}

// --- (6′) MIGRATE[5] -------------------------------------------------------------------
function indepMigrate() {
  section('(6′) MIGRATE[5]: a v5 save becomes v6 and nothing else changes; private fields are saved as they are (spec §5h; D262)');
  ok(STATE_V === 6 && PROTO === 6 && MAX_VIS === 8 && typeof MIGRATE[5] === 'function' && MIGRATE[6] === undefined, `STATE_V 6, PROTO 6, MAX_VIS 8, MIGRATE[5] the last step (${STATE_V}, ${PROTO}, ${MAX_VIS})`);
  const S = stage();
  S.job(HOST, { t: 'flip', id: VID.t1 }); // (a piece hidden from everyone: what a v5 table can hold)
  const save = (T) => structuredClone({ ...T.H.snapshot(), decks: T.H.state.decks, boxes: T.H.state.boxes, boxSrc: T.H.state.boxSrc });
  const v5 = { ...save(S), v: 5 };
  const m = MIGRATE[5](structuredClone(v5));
  ok(m.v === 6 && canon({ ...m, v: 5 }) === canon(v5), 'MIGRATE[5]: v 6, every other field as it was');
  ok(canon(migrate(structuredClone(v5))) === canon(m), 'migrate() of a v5 save stops at v6');
  const v1 = { seq: 3, size: 1800, items: { c1: { k: 'c', d: 'dd000001', i: 0, up: false, x: 10, y: 20, rot: 0, z: 1 } }, players: { [HOST]: { name: 'Alice', color: '#f00', online: true, hand: [], seat: 90, key: 'k1' } }, log: [] };
  ok(migrate(structuredClone(v1)).v === 6, 'a save from before Phase 1 runs the whole chain to v6');
  ok(/newer/.test(thrown(() => migrate({ v: 7 }))), 'a v7 save is refused, never downgraded');
  const T = quietly(() => createTable(structuredClone(v5), { pid: HOST })).value;
  T.takeDirty();
  const priv = Object.entries(T.state.items).filter(([, x]) => 'vis' in x || 'pv' in x || 'po' in x);
  ok(T.state.v === 6 && !priv.length && T.pub.get(VID.t1).b && !('t' in T.pub.get(VID.t1)) && PEERS.every((p) => !T.mine(p).vis && hiddenFrom(p, T.state.items[VID.t1], (s) => sitter({ state: T.state }, s))),
    'the v5 save loaded: v 6, no item given a vis, pv or po, the hidden tile hidden from everyone, no override');
  // a v6 save keeps what is private, as plain item fields
  S.job(HOST, { t: 'hide', ids: [VID.d1] });
  S.job(HOST, { t: 'move', id: VID.t2, x: S.it(VID.rackS).x + 40, y: S.it(VID.rackS).y + 10 });
  S.api((t) => t.hide(VID.u1, ['seat:north']));
  const v6 = save(S), U = quietly(() => createTable(structuredClone(v6), { pid: HOST })).value;
  U.takeDirty();
  ok(canon(U.state.items) === canon(S.H.state.items) && PEERS.every((p) => canon(U.mine(p).vis ?? null) === canon(S.H.mine(p).vis ?? null)) && !!U.mine(BOB).vis?.[VID.u1] && !!U.mine(HOST).vis?.[VID.d1],
    'a v6 save with a cup, a rack tile and a seat-ref unit: loaded with the same items, and each viewer gets the same full forms');
}

// --- (7′) a seeded random run of 500 ops --------------------------------------------
/** One seeded run of 500 ops on MANY by Alice, Bob, Carol and Dave (three
 *  seated, one watching, the seats changing hands as it goes), with the
 *  rules off (the facade called as a hook would) or on (every job in the
 *  mirror, its patch checked by the host; the facade through VEX). After
 *  every op one broadcast tick, and: every body audited (audit: §5d's
 *  shared forms, the overrides, every view equal to the oracle); no body's
 *  text, and no notice, names a face label or carries a type ref of a
 *  piece its viewer could not see before the op nor after it (sight) —
 *  every piece of MANY's own types is one of a kind, so either would be a
 *  hidden identity —; every peek answered to its asker alone, with what the
 *  piece is. At the end every folded view equals its own snapshot. */
function fuzzRun(seed, rules) {
  const S = stage({ def: MANY, seed, prefix: rules ? '7' : '8' }), H = S.H, it = S.it, rnd = rng(seed * 7919 + 1);
  if (rules) S.job(HOST, { t: 'setRules', enabled: true, code: VEX });
  for (const b of BOARDS) S.job(HOST, { t: 'lock', id: b, on: false }); // (boards may move: a move fires nothing, D252)
  S.tick();
  const TYPE_RE = new RegExp(`${S.box}/p\\d\\d`, 'g'), LABEL_RE = /Qx\d\d[a-f]/g;
  const stats = { ops: 0, overrides: 0, zoned: 0, seated: 0, peeks: 0, facade: 0 }, bad = [], leaks = [];
  const pieces = () => Object.keys(H.state.items).filter((k) => it(k).k === 'g' && !(it(k).z < 0));
  const dice = () => pieces().filter((k) => typeAt(H.state.boxes, it(k).t)?.kind === 'die');
  /** A random place: inside a board (a rack, a screen, a zone that does nothing, the grid) most of the time, else on the open felt. */
  const spot = () => {
    const b = it(rnd.pick(BOARDS)), ty = b && typeAt(H.state.boxes, b.t);
    if (ty && rnd() < 0.7) return { x: b.x + 10 + rnd.int(Math.max(1, ty.w - 80)), y: b.y + 5 + rnd.int(Math.max(1, ty.h - 130)) };
    return { x: 100 + rnd.int(2600), y: 620 + rnd.int(500) };
  };
  const refsFor = (p) => rnd.pick([[], [p], ['seat:north'], [BOB, 'seat:east'], ['seat:south', CAROL], [DAVE]]);
  const facade = (op, ...args) => {
    stats.facade++;
    if (rules) return S.job(HOST, { t: 'chat', msg: J([op, ...args]) });
    S.api((t) => { try { return op === 'spawnLike' ? t.spawn(t.item(args[0]).t, args[1]) : t[op](...args); } catch (e) { if (e instanceof TypeError) return null; throw e; } });
    return null;
  };
  for (let k = 0; k < 500; k++) {
    const before = new Map([...S.peers.keys()].map((V) => [V, sight(H, V)]));
    const p = rnd.pick(PEERS), id = rnd.pick(pieces()), r = rnd(), hand = H.state.players[p].hand, held = J(['south', 'north', 'east'].map((x) => sitter(H, x)));
    let res, asked = null;
    if (r < 0.27) res = S.job(p, { t: 'move', id, ...spot() });
    else if (r < 0.35) res = S.job(p, { t: 'hide', ids: [...new Set([id, ...(rnd() < 0.3 ? [rnd.pick(pieces())] : [])])] });
    else if (r < 0.42) res = S.job(p, { t: 'flip', id });
    else if (r < 0.47) res = S.job(p, { t: 'roll', ids: [...new Set([rnd.pick(dice()), rnd.pick(dice())])] });
    else if (r < 0.51) res = S.job(p, { t: 'face', id, f: rnd.int(2) });
    else if (r < 0.55) res = S.job(p, { t: 'peek', id: (asked = rnd() < 0.9 || !it(MID.pile) ? id : MID.pile) });
    else if (r < 0.59) res = S.job(p, { t: 'pull', id: MID.bag, ...spot() });
    else if (r < 0.62) res = S.job(p, { t: 'take', id: MID.sup, ...spot() });
    else if (r < 0.66) res = hand.length && rnd() < 0.6 ? S.job(p, { t: 'play', idx: 0, type: hand[0].t, f: hand[0].f, ...spot() }) : S.job(p, { t: 'toHand', id });
    else if (r < 0.70) res = S.job(p, { t: 'group', op: rnd.pick(['hide', 'move', 'flip', 'roll']), ids: [...new Set([id, rnd.pick(pieces()), rnd.pick(pieces())])], dx: 40, dy: 10 });
    else if (r < 0.74) res = S.job(rnd() < 0.5 ? p : HOST, { t: 'owner', id: rnd() < 0.2 ? rnd.pick(BOARDS) : id, to: rnd.pick([p, null, rnd.pick(PEERS), 'seat:south', 'seat:north']) });
    else if (r < 0.77) res = it(MID.pile) ? S.job(p, rnd() < 0.5 ? { t: 'deal', id: MID.pile, ...spot(), up: rnd() < 0.3 } : { t: 'toPile', id, pile: MID.pile }) : null;
    else if (r < 0.87) {
      const op = rnd.pick(['hide', 'setVis', 'reveal', 'spawnLike', 'move', 'roll']), refs = refsFor(p), at = spot();
      if (op === 'hide') res = facade('hide', id, refs);
      else if (op === 'setVis') res = facade('setVis', id, refs.length ? refs : null);
      else if (op === 'reveal') res = facade('reveal', id);
      else if (op === 'spawnLike') res = facade('spawnLike', MID.sup, { at, up: false, ...(refs.length && { vis: refs }) });
      else if (op === 'move') res = facade('move', id, at.x, at.y);
      else res = facade('roll', rnd.pick(dice()));
    } else if (r < 0.94) {
      const q = rnd.pick(PEERS), s = rnd.pick(['south', 'north', 'east', null]);
      res = S.job(HOST, s ? { t: 'seat', p: q, id: s } : { t: 'seat', p: q, watch: true });
    } else { const b = rnd.pick(BOARDS); res = it(b) && S.job(p, { t: 'move', id: b, x: it(b).x + rnd.pick([-120, 120]), y: it(b).y + rnd.pick([-60, 60]) }); }
    stats.ops++;
    // peeks: to the asker alone, what the piece is (a pile: its top), and only of what the asker didn't see
    for (const e of res?.peeks || []) {
      const x = it(asked), m = x?.k === 'p' ? x.cards.at(-1) : x;
      stats.peeks++;
      if (e.p !== p || !m || J(e.c) !== J({ t: m.t, f: m.f }) || (x.k === 'g' && !veiled(H, p, x))) leaks.push(`${k}: a peek ${J(e)} for ${nm(p)}, who asked about ${asked}`);
    }
    const t = S.tick();
    for (const why of audit(S, t.out)) bad.push(`${k}: ${why}`);
    const after = new Map([...S.peers.keys()].map((V) => [V, sight(H, V)]));
    for (const [V, { body, text }] of Object.entries(t.out)) {
      const a = before.get(V), z = after.get(V);
      const names = (text.match(LABEL_RE) || []).filter((l) => !a.labels.has(l) && !z.labels.has(l)), refs = (text.match(TYPE_RE) || []).filter((x) => !a.types.has(x) && !z.types.has(x));
      if (names.length || refs.length) leaks.push(`${k}: ${nm(V)}'s body names ${J([...new Set([...names, ...refs])])}: ${text.match(new RegExp(`.{0,80}(${[...names, ...refs][0].replace('/', '\\/')}).{0,40}`))?.[0]}`);
      if (body.vis) stats.overrides++;
    }
    for (const e of (res?.fx || []).filter((x) => x.t === 'note')) {
      const a = before.get(e.p), z = after.get(e.p), names = (e.msg.match(LABEL_RE) || []).filter((l) => !a?.labels.has(l) && !z?.labels.has(l));
      if (names.length) leaks.push(`${k}: a notice to ${nm(e.p)} names ${names}: ${e.msg}`);
    }
    if (pieces().some((x) => it(x).pv)) stats.zoned++;
    const moved = ['south', 'north', 'east'].filter((x, j) => JSON.parse(held)[j] !== sitter(H, x));
    if (moved.some((x) => (H.byVis.get(`seat:${x}`)?.size ?? 0) > 0)) stats.seated++; // (a seat changed hands while pieces were seen by it)
  }
  S.tick();
  const stale = [...S.peers.keys()].filter((V) => { const w = S.fresh(V), g = S.view(V); return ['items', 'players', 'hand', 'log', 'seats', 'table'].some((f) => canon(w[f]) !== canon(g[f])); });
  const tag = `seed ${seed}, rules ${rules ? 'on' : 'off'}`;
  ok(stats.ops === 500 && stats.overrides > 20 && stats.zoned > 50 && stats.peeks > 3 && stats.seated > 3 && stats.facade > 30, `${tag}: 500 ops, with what they must cover (${J(stats)})`);
  ok(!bad.length, `${tag}: every tick's bodies as §5d says, every viewer's folded view equal to what the rule says it holds (${bad.length} problems${bad.length ? `: ${bad.slice(0, 3).join('; ')}` : ''})`);
  ok(!leaks.length, `${tag}: no body and no notice gave a viewer a hidden piece's type, face or value; every peek its asker's alone (${leaks.length}${leaks.length ? `: ${leaks.slice(0, 3).join('; ')}` : ''})`);
  ok(!stale.length, `${tag}: each viewer's folded patches equal its own full snapshot — items, players, hand, log, seats, table (${stale.map(nm).join(', ') || 'all four'})`);
  if (rules) ok(!S.refused.length && S.same(), `${tag}: the host took every patch the mirror made, and both hold one table (${S.refused.slice(0, 2).join('; ') || 'digests equal'})`);
}
function indepFuzz() {
  section('(7′) seeded random runs of 500 ops with three viewers (and a watcher): folded patches equal each viewer\'s snapshot, and no body ever shows a viewer a hidden piece\'s type, face or value (spec §5l item 7, §0.1.3, §5b, §5d)');
  for (const seed of seeds([21, 22])) fuzzRun(seed, seed % 2 === 0); // (an odd seed with the rules off, an even one with them on)
}

// --- (8′) export round trip -------------------------------------------------------------
/** The rank of each seated player as an export writes it ("#k", clockwise from the bottom: §4a). */
const ranks = (H) => new Map(Object.entries(H.state.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360)).map(([q], k) => [q, `#${k + 1}`]));
function indepExport() {
  section("(8′) the setup grammar's vis and po, laid out (spec §5h, §4a): 'seat' in forEachSeat, a seat ref, \"#k\", po; a private zone hides what a setup places in it");
  const GRAM = { ...VAULT, name: 'Vault grammar', setup: [BOARD_SETUP[0],
    { forEachSeat: [{ piece: 'die', at: { seat: [300, 400] }, up: false, vis: 'seat', owner: 'seat', po: true }] },
    { piece: 'unit', at: [1000, 1000], up: false, vis: ['#2', 'seat:east'], owner: '#1', po: true, id: 'e2000099' },
    { piece: 'tile', at: [340, 1830], id: 'e2000098' }] };
  const G = stage({ def: GRAM, prefix: '3' });
  G.job(HOST, { t: 'setup', box: G.box }); // (again, now that everyone sits where the stage seats them: "#k" counts them)
  const dice = Object.entries(G.H.state.items).filter(([, x]) => x.t?.endsWith('/die')).map(([, x]) => pf(x)).sort((a, b) => (a.owner < b.owner ? -1 : 1));
  ok(J(dice) === J(['east', 'north', 'south'].map((s) => ({ up: false, vis: [`seat:${s}`], pv: null, po: 1, owner: `seat:${s}` }))), `forEachSeat's vis: 'seat' and owner: 'seat', po: each seat's die hidden for that seat, its owner through po (${J(dice)})`);
  ok(J(pf(G.it('e2000099'))) === J({ up: false, vis: [BOB, 'seat:east'], pv: null, po: 1, owner: HOST }), `vis ["#2", "seat:east"], owner "#1", po: Bob (north, the 2nd clockwise) and east's seat; Alice's through po (${J(pf(G.it('e2000099')))})`);
  ok(J(pf(G.it('e2000098'))) === J({ up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }), "a tile the setup places on south's rack: hidden there, as any placement would");
  tickOK(G, 'the grammar laid out');
  section('(8′) export round trip of private material into a fresh table (spec §5l item 8, §5h, §4c; D249, D259)');
  const A = stage(), H = A.H, it = A.it, at = (b, k = 0) => ({ x: it(b).x + 40 + 70 * k, y: it(b).y + 10 });
  // cupped dice: one nobody owned (po), one she owned
  A.job(HOST, { t: 'owner', id: VID.d2, to: HOST });
  A.job(HOST, { t: 'hide', ids: [VID.d1, VID.d2] });
  // rack tiles: one the rack made its seat's (pv, po), one of Alice's own (pv)
  A.job(HOST, { t: 'move', id: VID.t1, ...at(VID.rackS) });
  A.job(HOST, { t: 'owner', id: VID.t2, to: HOST });
  A.job(HOST, { t: 'move', id: VID.t2, ...at(VID.rackS, 1) });
  // a unit that left north's screen (vis, po, no pv)
  A.job(BOB, { t: 'move', id: VID.u2, x: it(VID.screen).x + 100, y: it(VID.screen).y + 50 });
  A.job(BOB, { t: 'move', id: VID.u2, x: 1700, y: 700 });
  // the script's: seat refs, no owner; a player and a seat
  A.api((t) => { t.hide(VID.u1, ['seat:north', 'seat:east']); t.hide(VID.t3, [CAROL, 'seat:south']); });
  // a gem on north's rack (the board's owner a seat)
  A.job(BOB, { t: 'move', id: VID.gem, ...at(VID.rackN) });
  // beyond §5l's list — what the export must not give away either: a tile its rack moved away from (pv, no zone under it), a tile on a rack given to someone else since
  A.job(HOST, { t: 'take', id: VID.sup, ...at(VID.rackS2, 2) });
  const away = Object.keys(H.state.items).find((k) => it(k).pv && it(k).x === at(VID.rackS2, 2).x);
  A.job(HOST, { t: 'lock', id: VID.rackS2, on: false });
  A.job(HOST, { t: 'move', id: VID.rackS2, x: 1900, y: 1300 });
  A.job(CAROL, { t: 'pull', id: VID.bag, ...at(VID.rackB, 1) });
  const given = Object.keys(H.state.items).find((k) => it(k).pv && J(it(k).vis) === J([BOB]));
  A.job(HOST, { t: 'owner', id: VID.rackB, to: CAROL });
  // and a tile on south's rack the script gave to north (t.setVis, as Veiled Ranks' step() does for a unit in the other side's rows, D273): pv, vis north
  A.job(HOST, { t: 'take', id: VID.sup, ...at(VID.rackS, 5) });
  const handed = Object.keys(H.state.items).find((k) => it(k).pv && it(k).x === at(VID.rackS, 5).x && it(k).y === at(VID.rackS, 5).y);
  A.api((t) => t.setVis(handed, ['seat:north']));
  A.tick();
  ok(away && given && handed && it(away).up === false && J(it(away).vis) === J(['seat:south']) && J(it(given).vis) === J([BOB]) && it(VID.rackB).owner === CAROL && it(handed).pv && J(it(handed).vis) === J(['seat:north']),
    "the scene: a tile its rack (south's) was moved away from, hidden for south; a gem on Bob's rack, hidden for Bob, the rack Carol's since; a tile on south's rack the script set for north");
  const K = ranks(H), { box, warnings } = quietly(() => H.exportBox()).value, E = Object.fromEntries(box.setup.filter((e) => e.id).map((e) => [e.id, e]));
  const pick = (e) => Object.fromEntries(['up', 'vis', 'owner', 'po'].filter((k) => k in e).map((k) => [k, e[k]]));
  ok(!warnings.length && J(pick(E[VID.d1])) === J({ up: false, vis: [K.get(HOST)], owner: K.get(HOST), po: true }) && J(pick(E[VID.d2])) === J({ up: false, vis: [K.get(HOST)], owner: K.get(HOST) }),
    `cupped dice: up false, vis and owner as "#k", po on the one the cup made hers (${J([pick(E[VID.d1]), pick(E[VID.d2])])})`);
  ok(J(pick(E[VID.t1])) === J({}) && J(pick(E[VID.t2])) === J({ owner: K.get(HOST) }) && J(pick(E[VID.gem])) === J({}),
    `rack tiles: no up, no vis, and no owner where the rack gave it — their racks hide them again (${J([pick(E[VID.t1]), pick(E[VID.t2]), pick(E[VID.gem])])})`);
  ok(J(pick(E[VID.u2])) === J({ up: false, vis: ['seat:north'], owner: 'seat:north', po: true }), `the unit out of its screen: up false, vis, owner, po (${J(pick(E[VID.u2]))})`);
  ok(J(pick(E[VID.u1])) === J({ up: false, vis: ['seat:north', 'seat:east'] }) && J(pick(E[VID.t3])) === J({ up: false, vis: [K.get(CAROL), 'seat:south'] }),
    `the script's: seat refs kept, a player as "#k", no owner (${J([pick(E[VID.u1]), pick(E[VID.t3])])})`);
  ok(![HOST, BOB, CAROL, DAVE].some((q) => JSON.stringify(box).includes(q)), 'no player id in the export: players travel as "#k"');
  // a fresh table: other players, the same seats filled
  const cast = [['1'.repeat(16), 'Ann'], ['2'.repeat(16), 'Ben'], ['3'.repeat(16), 'Cat'], ['4'.repeat(16), 'Dan']];
  const B = stage({ def: null, cast, prefix: '6', seed: 9 }), U = B.H;
  const added = B.job(cast[0][0], { t: 'addBox', box: json(box) }), bid = added.fx.find((e) => e.t === 'added')?.id;
  const set = B.job(cast[0][0], { t: 'setup', box: bid });
  B.tick();
  const filled = ['south', 'north', 'east'].every((s) => sitter(U, s));
  ok(!!bid && !set.notes.length && filled, `imported into a fresh room and set up, its three seats filled (${J(set.notes)})`);
  // the same up, vis, owner, pv and po — pids compared by rank ("#k", which follows the seats), seat refs as they are
  const KB = ranks(U), as = (Kx, r) => (r == null ? null : r.startsWith('seat:') ? r : Kx.get(r) ?? `unseated ${r}`);
  const form = (T, Kx, x) => x && { up: x.up ?? true, vis: x.vis ? x.vis.map((r) => as(Kx, r)) : null, owner: as(Kx, x.owner ?? null), pv: x.pv ?? null, po: x.po ?? null };
  const diff = [VID.d1, VID.d2, VID.t1, VID.t2, VID.u2, VID.u1, VID.t3, VID.gem].filter((id) => J(form(H, K, it(id))) !== J(form(U, KB, U.state.items[id])));
  ok(!diff.length, `cupped dice, rack tiles, the unit out of its screen, the script's seat refs: each with the same up, vis, owner, pv and po (${diff.map((id) => `${id}: ${J(form(H, K, it(id)))} ≠ ${J(form(U, KB, U.state.items[id]))}`).join('; ') || 'all'})`);
  // who sees what, by seat: the same in both rooms (every private piece, and the two beyond §5l's list)
  const sightBySeat = (T, id) => ['south', 'north', 'east'].map((s) => !veiled(T, sitter(T, s), T.state.items[id]));
  const seen = (id) => J(sightBySeat(H, id)) === J(sightBySeat(U, id));
  ok([VID.d1, VID.d2, VID.t1, VID.t2, VID.u2, VID.u1, VID.t3, VID.gem].every(seen), 'and each is seen from the same seats, and only from them');
  ok(!!U.state.items[away] && seen(away), `a tile its rack moved away from (pv, no zone under it) stays hidden through export and import, seen from south alone (before: ${J(sightBySeat(H, away))}, after: ${J(sightBySeat(U, away))}; spec §0.1.3, §5h)`);
  ok(!!U.state.items[given] && seen(given), `a gem on a rack given to someone else since: still seen by its seat's player alone (before: ${J(sightBySeat(H, given))}, after: ${J(sightBySeat(U, given))}; spec §0.1.3, §5l item 8)`);
  ok(!!U.state.items[handed] && seen(handed), `a rack tile the script set for another seat (t.setVis, pv kept): still seen from that seat alone (before: ${J(sightBySeat(H, handed))}, after: ${J(sightBySeat(U, handed))}; spec §0.1.3, §5e, §5l item 8)`);
  tickOK(B, 'the fresh room');
}

// --- (CP′) checkPatch with the rules on --------------------------------------------------
function indepCheckPatch() {
  section("(CP′) checkPatch (spec §3f.6, §5f; D260): an honest job that hides, reveals or changes who sees is taken; a forged one is refused whole");
  const S = stage({ prefix: '5' }), H = S.H, it = S.it, at = (b, k = 0) => ({ x: it(b).x + 40 + 70 * k, y: it(b).y + 10 });
  S.job(HOST, { t: 'setRules', enabled: true, code: VEX });
  const say = (...c) => { S.job(HOST, { t: 'chat', msg: J(c) }); return [H.state.rules.data.r, H.state.rules.data.e]; };
  // honest jobs, each through the mirror; the host checks and takes each patch
  S.job(HOST, { t: 'hide', ids: [VID.d1] });
  say('hide', VID.u1, ['seat:north', BOB]);
  say('setVis', VID.u1, ['seat:east']);
  S.job(HOST, { t: 'move', id: VID.t1, ...at(VID.rackS) });
  S.job(BOB, { t: 'move', id: VID.u2, x: it(VID.screen).x + 200, y: it(VID.screen).y + 100 });
  S.job(BOB, { t: 'move', id: VID.u2, x: 1700, y: 700 });
  const [sp] = say('spawnLike', VID.t2, { at: { x: at(VID.rackS, 3).x, y: at(VID.rackS, 3).y }, up: false, vis: [CAROL] });
  S.job(CAROL, { t: 'group', op: 'hide', ids: [VID.t3, VID.coin] });
  const pk = S.job(DAVE, { t: 'peek', id: VID.t1 });
  S.job(HOST, { t: 'roll', ids: [VID.d1, VID.d2] });
  S.job(CAROL, { t: 'split', id: VID.stk, n: 1, x: it(VID.screen).x + 400, y: it(VID.screen).y + 100 });
  const mid = { d1: pf(it(VID.d1)), u1: pf(it(VID.u1)), t1: pf(it(VID.t1)), u2: pf(it(VID.u2)), sp: pf(it(sp)), t3: pf(it(VID.t3)) };
  ok(!S.refused.length && S.same() && J(mid) === J({
    d1: { up: false, vis: [HOST], pv: null, po: 1, owner: HOST }, u1: { up: false, vis: ['seat:east'], pv: null, po: null, owner: null },
    t1: { up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }, u2: { up: false, vis: ['seat:north'], pv: null, po: 1, owner: 'seat:north' },
    sp: { up: false, vis: ['seat:south'], pv: 1, po: 1, owner: 'seat:south' }, t3: { up: false, vis: [CAROL], pv: null, po: 1, owner: CAROL },
  }) && pk.peeks.length === 1 && pk.peeks[0].p === DAVE, `hide, t.hide, t.setVis, a move into a rack and out of a screen, t.spawn with vis into a rack, a group hide, a peek, a roll under a cup, a split onto a screen: every patch taken, digests equal (${S.refused.join('; ') || J(mid)})`);
  say('reveal', VID.u1);
  S.job(HOST, { t: 'flip', id: VID.d1 });
  S.job(HOST, { t: 'move', id: VID.t1, x: 1000, y: 1500 });
  say('setVis', VID.t3, null);
  ok(!S.refused.length && S.same() && J([pf(it(VID.u1)), pf(it(VID.d1)), pf(it(VID.t1))].map((x) => x.up)) === J([true, true, true]) && !('vis' in it(VID.t3)),
    `t.reveal, a flip under the cup, a tile off its rack, t.setVis(…, null): taken (${S.refused.join('; ') || 'so'})`);
  S.tick();
  // forged: one field of an honest job's patch changed — refused, nothing applied; then the honest patch, so host and mirror stay one table
  const [deck] = say('addStandardDeck', { x: 2000, y: 1450 });
  S.job(HOST, { t: 'deal', id: deck, x: 2120, y: 1450 });
  const card = Object.keys(H.state.items).find((k) => it(k).k === 'c');
  const forge = (p, a, edit) => {
    const r = quietly(() => S.M.job(p, a)).value, honest = structuredClone(r.patch), out = structuredClone(r.out), patch = structuredClone(r.patch), d0 = H.digest();
    edit(patch, out);
    let why = '';
    try { quietly(() => H.applyStatePatch(patch, out, { p, a })); } catch (e) { why = e.message; }
    const kept = H.digest() === d0, fx = H.drain();
    quietly(() => H.applyStatePatch(honest, structuredClone(r.out), { p, a }));
    S.M.drain();
    H.drain();
    return { why, kept, fx };
  };
  const cases = [
    ['vis on a card', HOST, { t: 'move', id: card, x: 2200, y: 1450 }, (pt) => { pt.items[card].vis = [BOB]; }],
    ['pv set outside place() (a tile face up on the open felt)', HOST, { t: 'move', id: VID.t2, x: 1100, y: 1400 }, (pt) => { pt.items[VID.t2].pv = 1; }],
    ['po without hiding (a tile face up, owned)', HOST, { t: 'move', id: VID.t2, x: 1150, y: 1400 }, (pt) => { Object.assign(pt.items[VID.t2], { owner: HOST, po: 1 }); }],
    ['vis on a bag', HOST, { t: 'move', id: VID.bag, x: 2650, y: 100 }, (pt) => { pt.items[VID.bag].vis = [HOST]; }],
    ['vis empty', HOST, { t: 'move', id: VID.d2, x: 900, y: 1200 }, (pt) => { Object.assign(pt.items[VID.d2], { up: false, vis: [] }); }],
    ['vis naming one player twice', HOST, { t: 'move', id: VID.d2, x: 950, y: 1200 }, (pt) => { Object.assign(pt.items[VID.d2], { up: false, vis: [BOB, BOB] }); }],
    ['vis of 9 refs', HOST, { t: 'move', id: VID.d2, x: 900, y: 1250 }, (pt) => { Object.assign(pt.items[VID.d2], { up: false, vis: [HOST, BOB, CAROL, DAVE, EVE, 'seat:south', 'seat:north', 'seat:east', 'seat:west'] }); }],
    ['vis naming no player', HOST, { t: 'move', id: VID.d2, x: 950, y: 1250 }, (pt) => { Object.assign(pt.items[VID.d2], { up: false, vis: ['Mallory'] }); }],
    ['pv 2', HOST, { t: 'move', id: VID.d2, x: 900, y: 1300 }, (pt) => { Object.assign(pt.items[VID.d2], { up: false, vis: [HOST], pv: 2 }); }],
    ['po true', HOST, { t: 'move', id: VID.d2, x: 950, y: 1300 }, (pt) => { Object.assign(pt.items[VID.d2], { up: false, vis: [HOST], owner: HOST, po: true }); }],
    ["a piece's peek answer in a move", HOST, { t: 'move', id: VID.d2, x: 900, y: 1350 }, (pt, out) => { out.effects.push({ t: 'peek', p: DAVE, c: { t: it(VID.t1).t, f: it(VID.t1).f } }); }],
  ];
  for (const [what, p, a, edit] of cases) {
    const r = forge(p, a, edit);
    ok(!!r.why && r.kept && !r.fx.some((e) => e.t === 'peek'), `forged — ${what}: refused whole, nothing applied (${r.why || 'TAKEN'})`);
  }
  ok(!S.refused.length && S.same(), 'the honest patches after each: taken, host and mirror one table');
  tickOK(S, 'after the forgeries');
}

// --- (B22′), (B23′) ---------------------------------------------------------------------
function indepBudgets() {
  section('(B22′) 8 players with 20 vis tiles each: one tile\'s move adds ≤ 400 B to its viewer\'s patch, 0 B to the 7 others\' (spec §5k; D250)');
  const cast = [[HOST, 'P1'], ...Array.from({ length: 7 }, (_, k) => [String(k + 2).repeat(16), `P${k + 2}`])], ps = cast.map(([p]) => p);
  const TILES = { name: 'Tiles', table: { shape: 'rect', w: 3000, h: 2000 }, backs: [{ id: 'bt', color: '#333' }], pieces: [{ id: 'tile', kind: 'tile', w: 60, h: 120, back: 'bt', faces: ['Qx01a', 'Qx01b'] }], setup: [] };
  const S = stage({ def: TILES, cast, seats: {}, prep: () => {}, prefix: '4' }), H = S.H, type = `${S.box}/tile`;
  const [mine] = S.api((t) => Object.fromEntries(ps.map((p, k) => [p, Array.from({ length: 20 }, (_, j) => t.spawn(type, { at: { x: 100 + 70 * j, y: 100 + 160 * k, free: true }, up: false, vis: [p] }))])));
  S.tick();
  const p4 = ps[3], moved = mine[p4][7];
  S.job(p4, { t: 'move', id: moved, x: 2200, y: 1700 });
  const { patch, out } = S.tick(), bytes = (s) => Buffer.byteLength(s, 'utf8');
  const extra = ps.map((p) => (out[p] ? bytes(out[p].text) - bytes(spliceBody({ to: p, tp: p, base: out[p].body.base }, patch)) : NaN));
  ok(Object.values(mine).flat().length === 160 && extra[3] > 0 && extra[3] <= 400 && extra.every((n, k) => k === 3 || n === 0), `P4's body: the shared patch + ${extra[3]} B (≤ 400); the 7 others': + 0 B (${J(extra)})`);
  ok(J(Object.keys(out[p4].body.vis || {})) === J([moved]) && ps.every((p) => p === p4 || !out[p].body.vis) && !('t' in (out[ps[0]].body.items?.[moved] ?? { t: 1 })), "the extra is that tile's full form alone; the others hold its reduced form");
  section('(B23′) a snapshot for one recipient, 160 vis items on the table: built in ≤ 20 ms (spec §5k)');
  const time = (p) => {
    const ms = [];
    for (let k = 0; k < 15; k++) {
      const t0 = performance.now();
      spliceBody({ to: p, tp: p, ...H.mine(p) }, sharedText({ v: PROTO, boot: 1, seq: H.state.seq, host: HOST, kind: 'snap', ...H.snapContent(), fx: [], ann: [] }));
      ms.push(performance.now() - t0);
    }
    return ms.sort((a, b) => a - b)[7];
  };
  const m20 = time(ps[2]);
  S.api((t) => Object.values(mine).flat().forEach((id, k) => t.setVis(id, [...new Set([ps[2], ps[k % 8]])])));
  const n160 = Object.keys(H.mine(ps[2]).vis || {}).length, m160 = time(ps[2]);
  ok(m20 <= 20 && m160 <= 20 && n160 === 160, `P3's snapshot: ${m20.toFixed(2)} ms carrying its 20 tiles in full; ${m160.toFixed(2)} ms once it sees all 160 (median of 15; ≤ 20 ms)`);
}

try {
  for (const [what, fn] of [['reduction', testReduction], ['zones', testZones], ['peek', testPeek], ['hide', testHide], ['seats', testSeats], ['migrate', testMigrate], ['fuzz', testFuzz], ['export', testExport], ['facade', testFacade], ['budgets', testBudgets], ['fix-up', testFixup],
    ['(1′)', indepReduction], ['(2′)', indepZones], ['(3′)', indepPeek], ['(4′)', indepHide], ['(5′)', indepSeats], ['(6′)', indepMigrate],
    ['(7′)', indepFuzz], ['(8′)', indepExport], ['(CP′)', indepCheckPatch], ['(B22′, B23′)', indepBudgets]]) await guard(what, fn);
} catch (e) { crash(e); }
report();
