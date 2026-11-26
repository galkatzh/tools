// E2E: Phase 5's two demos played on real screens (spec §5l t-p5-demos, §5g,
// D269–D273), and §5j's attacker case 10 in Node — written from the spec,
// apart from the implementation's own drivers. Alice hosts on a desktop
// (mouse), Bob plays on an iPhone 13 (CDP finger drags and taps; upright,
// and sideways for two of his moves).
//  10  Order reveals nothing (Node, through core.js): over 20 fresh Veiled
//      Ranks tables, Mallory (seated South) reads her first snapshot — the
//      very text a host sends her — and guesses each hidden North unit's rank
//      from its place in z order, in key order, its id and its square, by the
//      box's own declaration and by guessers trained on half the tables: none
//      does better than the best constant guess (3 of 12), within a binomial
//      99 % bound (Bonferroni over the guessers, so a sound engine fails less
//      than once in a hundred samples); seeded, so every run draws the same
//      tables. A planted leak (z in declaration order) is caught.
//  D   Dominoes, from 🎲: the racks hatched and named on each screen; Draw 7
//      (Bob's tap) fills both racks, seven tiles each, hidden for the rack's
//      seat (vis, pv, the owner by po); each player sees only their own pips
//      (the view, the drawn tiles, and every body Bob received); the boneyard
//      drops 28 → 14; the player to move drags a tile out of the rack onto the
//      table — face up for both, nothing private left on it — and the turn
//      passes; the other draws into the rack (🔒 Draw to my rack: 14 → 13,
//      hidden for him alone) and plays too; out of turn, a tile off the rack
//      and a draw are refused (D271).
//  V   Veiled Ranks, from 📦's Built in: both armies hidden behind their
//      screens; deploying inside the zone (a move, a swap) on both devices, a
//      deploy outside refused; ✓ Ready (a side's deployment locked once ready,
//      D273); then play: a move out of turn, a diagonal step, two squares for a
//      non-Lancer, the Banner, and a Lancer whose first square is blocked —
//      each refused, nothing changed; a legal step (the unit stays hidden off
//      its screen); a Lancer's two-square move (on Bob's phone held sideways
//      too); a Herald's parley (both revealed on both screens, neither
//      removed); an attack (both revealed, the lower removed); a hidden unit
//      stepping into the other side's rows stays hidden from that side; a
//      Trap attacked (both removed); the Banner captured (🏆 on both
//      screens, every unit revealed, D273); and every body Bob got never
//      carried a South unit's face while it was hidden.
'use strict';
const path = require('path');
const crypto = require('crypto');
const h = require('./h');
const { ok, section } = h;
const M = require('./p4m-lib');
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const ST = require('./stones-lib');
const core = require(path.join(h.APP_ROOT, 'cardtable/core.js'));
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const J = JSON.stringify;

// --- §5j case 10, in Node ----------------------------------------------------------
/** Runs fn with console.warn / console.error held back (core's own chatter on a table built in Node); its value. */
function quietly(fn) {
  const keep = [console.warn, console.error];
  console.warn = console.error = () => {};
  try { return fn(); } finally { [console.warn, console.error] = keep; }
}
/** A seeded stream of random numbers (sha256 in counter mode): random() in [0, 1), hex8() eight hex digits. */
function stream(seed) {
  let n = 0, buf = Buffer.alloc(0);
  const u32 = () => {
    if (buf.length < 4) buf = crypto.createHash('sha256').update(`${seed}:${n++}`).digest();
    const v = buf.readUInt32BE(0);
    buf = buf.subarray(4);
    return v;
  };
  return { random: () => u32() / 2 ** 32, hex8: () => u32().toString(16).padStart(8, '0') };
}
/** P(X ≥ k) for X ~ Binomial(n, p). */
function tail(n, p, k) {
  let pmf = (1 - p) ** n, s = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) s += pmf;
    pmf *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, s);
}
/** Case 10: the sample and the guessers (see the header). */
function orderCase() {
  const HOST = 'a'.repeat(16), MAL = 'f'.repeat(16), RANKS = BOXES.ranks;
  /** A unit type's rank as a guess's label ('T' for a Trap: it has none). */
  const rankOf = (typeId) => { const r = RANKS.types[typeId]?.meta?.rank; return r === null ? 'T' : String(r); };
  // what the box declares (every browser holds it): North's group, in declaration order
  const north = (typeId) => RANKS.types[typeId]?.meta?.side === 'north';
  const decl = RANKS.setup.find((e) => e.group?.some((x) => north(x.piece))).group;
  const DECL = decl.map((x) => rankOf(x.piece)), AT = Object.fromEntries(decl.map((x) => [x.at, rankOf(x.piece)]));
  const counts = {};
  for (const r of DECL) counts[r] = (counts[r] || 0) + 1;
  const p0 = Math.max(...Object.values(counts)) / DECL.length;
  const tables = [];
  let seated = true, sorted = true, hidden = true;
  for (let s = 1; s <= 20; s++) {
    const R = stream(`veiled-ranks-${s}`), uid = () => { let id; do id = R.hex8(); while (/^\d+$/.test(id)); return id; }; // (as core's uid: 8 hex, never all digits)
    let clock = 1.7e12;
    const T = quietly(() => core.createTable({}, { pid: HOST, now: () => (clock += 250), random: R.random, uid }));
    quietly(() => {
      T.open('Host');
      T.apply(MAL, { t: '_join', name: 'Mallory' });
      if (!T.apply(HOST, { t: 'loadBox', box: RANKS, setup: true, clear: true })) throw new Error('case 10: Veiled Ranks did not set up');
      // (the box seats people in its own order: both stand, then each takes a side)
      for (const a of [{ p: HOST, watch: true }, { p: MAL, watch: true }, { p: HOST, id: 'north' }, { p: MAL, id: 'south' }]) T.apply(HOST, { t: 'seat', ...a });
      T.drain();
      T.takeDirty();
    });
    seated &&= T.state.players[HOST].seatId === 'north' && T.state.players[MAL].seatId === 'south';
    // her first snapshot: the shared text spliced with her own part, as the host's broadcast sends it
    const text = core.spliceBody({ to: MAL, tp: MAL, ...T.mine(MAL) }, core.sharedText({ v: core.PROTO, boot: 1, seq: T.state.seq, host: HOST, kind: 'snap', ...T.snapContent(), fx: [], ann: [] }));
    const body = JSON.parse(text), keys = Object.keys(body.items);
    sorted &&= keys.every((k, i) => !i || keys[i - 1] < k);
    const ids = keys.filter((id) => north(T.state.items[id]?.t.split('/')[1]));
    hidden &&= ids.length === 12 && ids.every((id) => !('t' in body.items[id]) && !('f' in body.items[id]) && body.items[id].b && !body.vis?.[id]);
    const byZ = [...ids].sort((a, b) => body.items[a].z - body.items[b].z);
    tables.push(ids.map((id, k) => ({ id, kr: k, zr: byZ.indexOf(id), ir: keys.indexOf(id), sq: body.items[id].at, hx: id[0], z: body.items[id].z, rank: rankOf(T.state.items[id].t.split('/')[1]) })));
  }
  ok(seated, 'case 10: in each table the host sits North, Mallory South');
  ok(sorted, 'case 10: every snapshot lists its items in sorted-id order (§0.2)');
  ok(hidden, "case 10: in each, Mallory's 12 North units are their back alone — no t, no f, no override");
  const all = tables.flat(), train = tables.slice(0, 10).flat(), test = tables.slice(10).flat();
  /** A guesser trained on `units`: the commonest rank for each value of feature f, else the commonest of all. */
  function trained(units, f) {
    const by = {}, overall = {};
    for (const u of units) { (by[u[f]] ||= {})[u.rank] = (by[u[f]][u.rank] || 0) + 1; overall[u.rank] = (overall[u.rank] || 0) + 1; }
    const best = (c) => Object.keys(c).sort((a, b) => c[b] - c[a] || (a < b ? -1 : 1))[0];
    return (u) => best(by[u[f]] || overall);
  }
  const guessers = [
    ['z order → the declaration order', all, (u) => DECL[u.zr]],
    ['key order → the declaration order', all, (u) => DECL[u.kr]],
    ['square → the unit declared there', all, (u) => AT[u.sq]],
    ...[['z order', 'zr'], ['key order', 'kr'], ['id among all keys', 'ir'], ['square', 'sq'], ['id\'s first digit', 'hx']].map(([what, f]) => [`${what} (trained on 10 tables)`, test, trained(train, f)]),
  ];
  const alpha = 0.01 / guessers.length;
  for (const [what, units, g] of guessers) {
    const hits = units.filter((u) => g(u) === u.rank).length, pv = tail(units.length, p0, hits);
    ok(pv > alpha, `case 10: ${what}: ${hits}/${units.length} = ${(hits / units.length).toFixed(3)}, the best constant guess ${p0.toFixed(3)} (P(≥ ${hits}) = ${pv.toPrecision(3)} > ${alpha.toPrecision(3)})`);
  }
  // the guessers would see a leak: z in declaration order (each unit's z its place among the declared, duplicates by id)
  const leaky = tables.map((units) => {
    const used = new Set();
    return units.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((u) => {
      const k = DECL.findIndex((r, i) => r === u.rank && !used.has(i));
      used.add(k);
      return { ...u, zr: k };
    });
  }).flat();
  const caught = leaky.filter((u) => DECL[u.zr] === u.rank).length;
  ok(caught === leaky.length && tail(leaky.length, p0, caught) < alpha, `case 10: the test sees a leak — planted (z in declaration order), the z guesser scores ${caught}/${leaky.length}`);
}

/** Whether point [x, y] lies inside polygon `poly` (ray casting). */
const inPoly = ([x, y], poly) => poly.reduce((inside, [ax, ay], i) => {
  const [bx, by] = poly[(i + 1) % poly.length];
  return (ay > y) !== (by > y) && x < ax + ((y - ay) * (bx - ax)) / (by - ay) ? !inside : inside;
}, false);
/** The two boxes as §5g describes them (cleanBox's form: what a table holds). */
function boxChecks() {
  const D = core.cleanBox(BOXES.dominoes), V = core.cleanBox(BOXES.ranks);
  const tiles = Object.entries(D.types).filter(([, ty]) => ty.kind === 'tile'), pairs = tiles.map(([, ty]) => J(ty.faces[0]?.pips)).sort();
  const all = [];
  for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) all.push(J([a, b]));
  ok(tiles.length === 28 && J(pairs) === J(all.sort()) && tiles.every(([, ty]) => ty.faces.length === 1 && ty.w === 60 && ty.h === 120 && ty.back === tiles[0][1].back && ty.rotStep === 90 && ty.hand === false),
    `Dominoes: a double-six set — 28 tiles, one face each with the pips of its pair, 60 × 120, one shared back, quarter turns, not held in a hand (${tiles.length} tiles)`);
  const bagE = BOXES.dominoes.setup.find((e) => e.bag);
  ok(bagE?.bag.length === 28 && bagE.bag.every((m) => m.up === false) && new Set(bagE.bag.map((m) => m.t)).size === 28, 'the boneyard: a bag of the 28, face down');
  const rack = Object.values(D.types).find((ty) => ty.kind === 'board'), rz = rack?.board?.zones || [];
  const corners = [[1, 1], [rack.w - 1, 1], [rack.w - 1, rack.h - 1], [1, rack.h - 1], [rack.w / 2, rack.h / 2]];
  ok(rz.length === 1 && rz[0].private === 'reveal' && rz[0].owner === 'board' && corners.every((c) => inPoly(c, rz[0].poly)), `the rack: a board whose one private zone ('reveal', its board's owner's) covers it (${J(rz)})`);
  const each = BOXES.dominoes.setup.find((e) => e.forEachSeat)?.forEachSeat;
  ok(each?.some((e) => D.types[e.piece]?.kind === 'board' && e.owner === 'seat'), 'forEachSeat places a rack for each seat, owned by it');

  const field = Object.values(V.types).find((ty) => ty.kind === 'board'), g = field?.board?.grid, zs = field?.board?.zones || [];
  ok(field?.board.primary && g?.type === 'square' && g.cols === 10 && g.rows === 10 && g.labels === 'chess', `Veiled Ranks: the field is the primary board, a 10 × 10 square grid with chess labels (${J(g)})`);
  /** Rows 1–10 whose cells' centres lie in zone z (row 1 at the bottom: chess labels). */
  const rowsIn = (z) => [...Array(10).keys()].map((k) => k + 1).filter((r) => [...Array(10).keys()].every((c) => inPoly([g.x + (c + 0.5) * g.cell, g.y + (10 - r + 0.5) * g.cell], z.poly)));
  const zone = (seat) => zs.find((z) => z.owner === `seat:${seat}`);
  ok(zs.length === 2 && zone('south')?.private === 'keep' && zone('north')?.private === 'keep' && J(rowsIn(zone('south'))) === J([1, 2, 3]) && J(rowsIn(zone('north'))) === J([8, 9, 10]),
    `two screens ('keep'): rows ${J(rowsIn(zone('south') || { poly: [] }))} South's, rows ${J(rowsIn(zone('north') || { poly: [] }))} North's`);
  const TABLE = { banner: [1, 0], crown: [1, 4], blade: [2, 3], pike: [3, 2], lancer: [2, 1], herald: [1, 1], trap: [2, null] };
  for (const side of ['south', 'north']) {
    const group = BOXES.ranks.setup.find((e) => e.group?.some((x) => V.types[x.piece]?.meta?.side === side));
    const got = {};
    for (const x of group?.group || []) { const m = V.types[x.piece].meta; got[m.unit] = [(got[m.unit]?.[0] || 0) + 1, m.rank]; }
    const tys = (group?.group || []).map((x) => V.types[x.piece]);
    ok(group?.shuffle === true && group.group.every((x) => x.up === false && V.types[x.piece].meta.side === side) && J(got) === J(Object.fromEntries(Object.keys(got).map((u) => [u, TABLE[u]]))) && Object.keys(got).length === 7,
      `${side}: a shuffled group of 12 face-down units — ${Object.entries(got).map(([u, [n, r]]) => `${u} ×${n} (${r})`).join(', ')} — as §5g's table`);
    ok(tys.every((ty) => ty.kind === 'token' && ty.back === tys[0].back) && tys[0].back !== undefined, `…each a token under its side's back (${tys[0]?.back})`);
  }
  const north = Object.values(V.types).filter((ty) => ty.meta?.side === 'north'), south = Object.values(V.types).filter((ty) => ty.meta?.side === 'south');
  ok(north[0]?.back !== south[0]?.back, 'the two sides\' backs differ (a faction back each)');
  // the content rule (D42, §5g's decision): no commercial game's rank names or signature units, in the box or its script
  const words = /\b(marshal|general|colonel|major|captain|lieutenant|sergeant|miner|scout|spy|bomb)s?\b/i;
  const text = [...Object.values(V.types).flatMap((ty) => [ty.name, ...ty.faces.flatMap((f) => [f.label, f.text, f.name])]), BOXES.ranks.rules].filter(Boolean);
  ok(!text.some((t) => words.test(t)), `Veiled Ranks is its own: no Marshal, General, …, Scout, Miner, Spy or Bomb in its names or script (${text.filter((t) => words.test(t)).map((t) => words.exec(t)[0]).join(', ') || 'none'})`);
}

// --- the screens --------------------------------------------------------------------
const settle = (p) => p.waitForFunction(() => window.__ct.jobs() === 0, null, { timeout: 15000 });
const state = (p) => p.evaluate(() => window.__ct.hostState());
const act = (p, a) => p.evaluate((x) => window.__ct.act(x), a);
/** A host item's square (its address's local part), or undefined. */
const sqOf = (it) => it?.at?.split(':').pop();
/** Clears page p's selection and bar (Esc; on a phone, the same keydown dispatched). */
const deselect = (p) => (p.touch ? p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))) : p.keyboard.press('Escape'));
/** What page p's view holds of item `id`: 'face' (shown), 'mine' (its face, hidden from the others), 'back', or null (absent). */
const sight = (v, id) => { const it = v.items[id]; return !it ? null : 'b' in it || !('t' in it) ? 'back' : it.up === false ? 'mine' : 'face'; };
/** Page p's view, as plain JSON. */
const viewOf = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__ct.view())));
/** What page p draws of items `ids`: {id: {back (a back is drawn), badge (🙈 shows), pips (the lit pips of a two-pip face, or null)} | null}. */
const looks = (p, ids) => p.evaluate((ids) => Object.fromEntries(ids.map((id) => {
  const el = document.querySelector(`#table .item[data-id="${id}"]`);
  if (!el) return [id, null];
  const b = el.querySelector(':scope > .visb');
  return [id, { back: !!el.querySelector('.pback'), badge: !!b && getComputedStyle(b).display !== 'none', pips: el.querySelector('.pips2') ? el.querySelectorAll('.pips2 .pip.on').length : null }];
})), ids);
/** Polls looks(p, ids) until pred holds (5 s at most); the last reading. */
async function lookUntil(p, ids, pred) {
  let l;
  await M.until(async () => pred((l = await looks(p, ids))), 5000, 100);
  return l;
}
/** The private zone labels page p draws on board `id`, and its hatch's colour (a <pattern>'s fill). */
const zoneOf = (p, id) => p.evaluate((i) => {
  const el = document.querySelector(`#table .item[data-id="${i}"]`);
  return el && { texts: [...el.querySelectorAll('.btexts .slabel')].map((t) => t.textContent).sort(), hatch: [...el.querySelectorAll('.psvg pattern rect')].map((r) => r.getAttribute('fill')).sort() };
}, id);
/** The first notice reading 🚫… that page p shows since `t0` (Date.now()); null after 8 s. */
async function refusal(p, t0) {
  let m = null;
  await M.until(async () => (m = (await M.notes(p, t0)).find((x) => x.startsWith('🚫'))), 8000, 100);
  return m || null;
}
/** The log texts page p holds, written since `t0` (host clock: one machine). */
const logSince = (p, t0) => p.evaluate((t0) => window.__ct.log().filter((e) => (e.ts ?? 0) >= t0).map((e) => e.txt), t0);
/** Drags item `id` on page p — the mouse, or a finger on a touch screen — so its centre lets go over table point (x, y). */
async function dragTo(p, id, x, y) {
  await deselect(p);
  const pts = P3.steps(await M.centre(p, id), await P3.screenOf(p, x, y), 10, 30);
  if (p.touch) await M.fingerDrag(p, pts);
  else await M.mouseDrag(p, pts);
}
/** Waits until fn(host state) holds — a guest's action reaches the host a
 *  moment after its gesture ends — then for the host's queue to empty;
 *  whether it held (10 s at most). */
async function hostSees(host, fn) {
  const held = await M.until(async () => fn(await state(host)), 10000, 50);
  await settle(host);
  return held;
}
/** Every body page p received over the wire so far (p1-lib's RTC hook). */
const bodies = (p) => p.evaluate(() => window.__rtc.bodies.map((b) => b.body));
/** Every form of item `id` in `list`: its shared record and any override. */
const forms = (list, id) => list.flatMap((b) => [b.items?.[id], b.vis?.[id]].filter(Boolean));
/** Every key of every object anywhere in v (a recursive scan). */
const keysIn = (v) => (Array.isArray(v) ? v.flatMap(keysIn) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysIn(x)]) : []);
/** Every string anywhere in v. */
const stringsIn = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsIn) : v && typeof v === 'object' ? Object.values(v).flatMap(stringsIn) : []);

(async () => {
  section('0 the two boxes as §5g describes them');
  boxChecks();
  section('10 order reveals nothing (§5j case 10): 20 fresh Veiled Ranks tables in Node, Mallory\'s first snapshot');
  orderCase();

  const env = await h.start();
  const alice = await M.join(env, 'Alice', env.url);
  const bob = await M.join(env, 'Bob', alice.url(), { ctx: P.PHONE });
  await bob.evaluate(() => { window.__rtc.keep = true; }); // (every body Bob gets from now on: the scans)
  await alice.waitForFunction(() => document.querySelectorAll('.seat').length >= 2, null, { timeout: 15000 });
  const ALICE = alice.pid, BOB = bob.pid, page = { [ALICE]: alice, [BOB]: bob }, NAME = { [ALICE]: 'Alice', [BOB]: 'Bob' };
  /** Seats Alice south and Bob north (the host's seat actions; the box seats people in its own order). */
  async function seatUs() {
    for (const a of [{ p: BOB, watch: true }, { p: ALICE, watch: true }, { p: ALICE, id: 'south' }, { p: BOB, id: 'north' }]) await act(alice, { t: 'seat', ...a });
    await settle(alice);
    const S = await state(alice);
    return S.players[ALICE].seatId === 'south' && S.players[BOB].seatId === 'north';
  }

  // ================================= Dominoes =================================
  section('D1 Dominoes from 🎲: Alice south (desktop), Bob north (iPhone 13); the racks on each screen');
  await ST.pickGame(alice, 'dominoes');
  await settle(alice);
  ok(await seatUs(), 'Alice sits South, Bob North');
  let S = await state(alice);
  const domBox = Object.keys(S.boxes).find((k) => S.boxes[k].name === 'Dominoes');
  ok(S.rules?.enabled && S.rules.name === 'Dominoes' && S.rules.box === domBox, `the box's own rules run (${S.rules?.name}, its box ${S.rules?.box})`);
  ok(await ST.playing(alice) === 'dominoes', '🎲 marks Dominoes playing (D269)');
  const RACK = S.boxes[domBox].types.rack, rackOf = (seat) => Object.keys(S.items).find((k) => /\/rack$/.test(S.items[k].t) && S.items[k].owner === `seat:${seat}`);
  const racks = { south: rackOf('south'), north: rackOf('north') }, bag = Object.keys(S.items).find((k) => S.items[k].k === 'b');
  ok(racks.south && racks.north && S.items[bag]?.of.length === 28 && !Object.values(S.items).some((it) => /\/t\d\d$/.test(it.t || '')), `a rack for each seat, and the boneyard holds all 28 tiles (${S.items[bag]?.of.length})`);
  const seatColor = Object.fromEntries((await viewOf(alice)).seats.map((s) => [s.id, s.color]));
  for (const [p, mine, theirs] of [[alice, 'south', 'north'], [bob, 'north', 'south']]) {
    const [z1, z2] = [await zoneOf(p, racks[mine]), await zoneOf(p, racks[theirs])], other = p === alice ? 'Bob' : 'Alice';
    ok(J(z1?.texts) === J(['🔒 Your rack']) && J(z2?.texts) === J([`🔒 ${other}'s rack`]), `${NAME[p.pid]}'s screen: "${z1?.texts}" on the own rack, "${z2?.texts}" on the other`);
    ok(z1?.hatch.includes(seatColor[mine]) && z2?.hatch.includes(seatColor[theirs]), `…each hatched in its owner's colour (${z1?.hatch}, ${z2?.hatch})`);
  }

  section('D2 Draw 7 (Bob\'s tap): both racks filled, seven tiles each, hidden for the rack\'s seat');
  ok(await M.until(async () => (await ST.buttons(bob)).includes('Draw 7'), 8000, 100), `Bob's phone offers Draw 7 (${J(await ST.buttons(bob))})`);
  await ST.press(bob, /^Draw 7$/, true);
  const isTile = (it) => /\/t\d\d$/.test(it.t || '');
  ok(await hostSees(alice, (S) => Object.values(S.items).filter(isTile).length === 14), 'the host deals: 14 tiles out of the boneyard');
  S = await state(alice);
  const tileIds = Object.keys(S.items).filter((k) => /\/t\d\d$/.test(S.items[k].t));
  const pipsOf = (id) => { const [, a, b] = /\/t(\d)(\d)$/.exec(S.items[id].t); return +a + +b; };
  const inRack = (it, r) => it.x + 30 >= S.items[r].x && it.x + 30 <= S.items[r].x + RACK.w && it.y + 60 >= S.items[r].y && it.y + 60 <= S.items[r].y + RACK.h;
  const held = {};
  for (const seat of ['south', 'north']) {
    held[seat] = tileIds.filter((k) => inRack(S.items[k], racks[seat])).sort((a, b) => S.items[a].x - S.items[b].x);
    const its = held[seat].map((k) => S.items[k]);
    ok(its.length === 7 && its.every((it) => it.up === false && J(it.vis) === J([`seat:${seat}`]) && it.pv === 1 && it.owner === `seat:${seat}` && it.po === 1),
      `${seat}'s rack: 7 tiles, each face down, vis [seat:${seat}], pv, owned by the seat through po (${J(its.map((it) => [it.up, it.vis, it.pv, it.owner, it.po]))})`);
    const rk = S.items[racks[seat]];
    ok(its.every((it, i) => it.x >= rk.x && it.x + 60 <= rk.x + RACK.w && it.y >= rk.y && it.y + 120 <= rk.y + RACK.h && (!i || it.x >= its[i - 1].x + 60)), `…each wholly on the rack, none over another (x ${its.map((it) => it.x).join(', ')})`);
  }
  ok(tileIds.length === 14 && S.items[bag].of.length === 14, `the boneyard drops 28 → ${S.items[bag].of.length}`);
  for (const p of [alice, bob]) {
    ok(await P.waitView(p, 'v.items[a]?.n === 14', bag, 10000), `${NAME[p.pid]}'s screen: the boneyard holds 14`);
    ok(await M.until(() => p.evaluate((id) => document.querySelector(`#table .item[data-id="${id}"] .bn`)?.textContent === '14', bag), 5000, 100), '…and says 14 on the bag');
  }

  section('D3 each player sees only their own pips: the view, the drawn tiles, every body Bob got');
  for (const [p, mine, theirs] of [[alice, 'south', 'north'], [bob, 'north', 'south']]) {
    ok(await P.waitView(p, 'a.every((id) => !!v.items[id])', tileIds, 10000), `${NAME[p.pid]}'s screen holds the 14 tiles`);
    const v = await viewOf(p);
    ok(held[mine].every((k) => sight(v, k) === 'mine' && v.items[k].t === S.items[k].t && v.items[k].f === S.items[k].f) && held[theirs].every((k) => sight(v, k) === 'back' && !('f' in v.items[k])),
      `${NAME[p.pid]}'s view: the 7 of the own rack in full (hidden from the other), the other's 7 their back, no t, no f`);
    const l = await lookUntil(p, tileIds, (l) => held[mine].every((k) => l[k]?.pips === pipsOf(k)));
    ok(held[mine].every((k) => !l[k].back && l[k].badge && l[k].pips === pipsOf(k)), `${NAME[p.pid]}'s screen draws the own tiles' pips (${held[mine].map((k) => l[k]?.pips).join(' ')}), each with 🙈`);
    ok(held[theirs].every((k) => l[k] && l[k].back && l[k].pips === null && !l[k].badge), `…and the other rack's tiles as backs, no pips, no 🙈 (${J(held[theirs].map((k) => l[k]))})`);
  }
  await M.shot(alice, 'p5d-dominoes-desk');
  await M.shot(bob, 'p5d-dominoes-phone');

  section('D4 the player to move drags a tile out of the rack onto the table: face up for both; the turn passes');
  const turn = async () => (await state(alice)).rules?.public?.turn ?? null;
  const lead = await turn();
  ok(lead === ALICE || lead === BOB, `a player leads (${NAME[lead]})`);
  const seatOf = { [ALICE]: 'south', [BOB]: 'north' };
  /** Player q drags the first tile of its rack so its centre lets go over table point (x, y), and the checks of a play follow; the tile's id. */
  async function playTile(q, x, y) {
    const p = page[q], id = held[seatOf[q]][0];
    await dragTo(p, id, x, y);
    await hostSees(alice, (S) => S.items[id]?.up !== false);
    S = await state(alice);
    const it = S.items[id];
    ok(it && it.up !== false && !it.vis && !it.pv && !it.po && !it.owner && !inRack(it, racks[seatOf[q]]), `${NAME[q]} (${p.touch ? 'a finger' : 'the mouse'}) drags ${id} off the rack: on the table face up, no vis, pv, po or owner (${J(it)})`);
    for (const r of [alice, bob]) {
      ok(await P.waitView(r, '!!v.items[a] && "t" in v.items[a] && v.items[a].up !== false', id, 10000), `${NAME[r.pid]}'s view: the tile face up`);
      const l = await lookUntil(r, [id], (l) => l[id]?.pips === pipsOf(id));
      ok(l[id] && !l[id].back && !l[id].badge && l[id].pips === pipsOf(id), `${NAME[r.pid]}'s screen draws its ${pipsOf(id)} pips, no 🙈 (${J(l[id])})`);
    }
    held[seatOf[q]].shift();
    return id;
  }
  const other = lead === ALICE ? BOB : ALICE;
  await playTile(lead, 440, 650);
  ok(await turn() === other, `the turn passes to ${NAME[other]}`);

  section('D5 the other player draws into the rack (🔒 Draw to my rack): the boneyard 14 → 13, the tile his alone; then plays');
  const q = page[other], before = new Set(tileIds);
  await deselect(q);
  const c = await M.centre(q, bag);
  if (q.touch) await M.tap(q, c); else await M.click(q, c);
  ok(await M.until(async () => (await M.bar(q)).btns.includes('🔒 Draw to my rack'), 5000, 100), `${NAME[other]}'s bag bar offers 🔒 Draw to my rack (${J((await M.bar(q)).btns)})`);
  await M.barPress(q, '🔒 Draw to my rack');
  await hostSees(alice, (S) => S.items[bag].of.length !== 14);
  await deselect(q);
  S = await state(alice);
  const drawn = Object.keys(S.items).filter((k) => /\/t\d\d$/.test(S.items[k].t) && !before.has(k));
  const dt = S.items[drawn[0]];
  ok(drawn.length === 1 && S.items[bag].of.length === 13, `one tile drawn: the boneyard holds ${S.items[bag].of.length}`);
  ok(dt && inRack(dt, racks[seatOf[other]]) && dt.up === false && J(dt.vis) === J([`seat:${seatOf[other]}`]) && dt.pv === 1 && held[seatOf[other]].every((k) => Math.abs(S.items[k].x - dt.x) >= 60),
    `…into ${NAME[other]}'s rack, face down for that seat alone, in a free slot (${J(dt)})`);
  for (const r of [alice, bob]) ok(await P.waitView(r, 'v.items[a[0]]?.n === 13 && !!v.items[a[1]]', [bag, drawn[0]], 10000), `${NAME[r.pid]}'s screen: the boneyard holds 13`);
  ok(sight(await viewOf(q), drawn[0]) === 'mine' && sight(await viewOf(page[lead]), drawn[0]) === 'back', `${NAME[other]} sees its face, ${NAME[lead]} its back`);
  held[seatOf[other]].push(drawn[0]);
  await playTile(other, 560, 650);
  ok(await turn() === lead, `the turn passes back to ${NAME[lead]}`);

  section('D6 out of turn (D271): a tile off the rack, and a draw — refused, nothing shown');
  const tile = held[seatOf[other]][0], was = J((await state(alice)).items[tile]);
  let t0 = Date.now();
  await dragTo(q, tile, 700, 650);
  const no1 = await refusal(q, t0);
  await settle(alice);
  S = await state(alice);
  ok(no1 && J(S.items[tile]) === was, `${NAME[other]}'s tile off the rack out of turn: refused ("${no1}"), still hidden in the rack`);
  ok(await P.waitView(page[lead], 'v.items[a] && "b" in v.items[a]', tile, 5000), `${NAME[lead]}'s view: still its back`);
  t0 = Date.now();
  await deselect(q);
  if (q.touch) await M.tap(q, await M.centre(q, bag)); else await M.click(q, await M.centre(q, bag));
  await M.until(async () => (await M.bar(q)).btns.includes('🔒 Draw to my rack'), 5000, 100);
  await M.barPress(q, '🔒 Draw to my rack');
  const no2 = await refusal(q, t0);
  await settle(alice);
  await deselect(q);
  ok(no2 && (await state(alice)).items[bag].of.length === 13, `…and a draw out of turn: refused ("${no2}"), the boneyard still 13`);
  // every body Bob got: Alice's tiles still in her rack never came with a face, and nothing anywhere names pips or their types
  S = await state(alice);
  const aliceHidden = held.south.filter((k) => S.items[k]?.up === false), all = await bodies(bob);
  const leaks = aliceHidden.flatMap((k) => forms(all, k).filter((f) => 't' in f || 'f' in f).map(() => k));
  const types = aliceHidden.map((k) => S.items[k].t), strs = stringsIn(all), names = aliceHidden.map((k) => { const [, a, b] = /\/t(\d)(\d)$/.exec(S.items[k].t); return `${a}|${b}`; });
  ok(aliceHidden.length >= 5 && all.length > 5 && !leaks.length && !all.some((b) => aliceHidden.some((k) => b.vis?.[k])), `the ${all.length} bodies Bob got: Alice's ${aliceHidden.length} hidden tiles never with a t or an f, never an override (${J(leaks)})`);
  ok(!keysIn(all).includes('pips') && !strs.some((s) => types.includes(s)) && !strs.some((s) => names.some((n) => s.includes(` ${n}`))), "…and no body carries pips, one of those tiles' type refs, or their face names");

  // ================================ Veiled Ranks ================================
  section('V1 Veiled Ranks from 📦\'s Built in: each army hidden behind its screen');
  const accept = (d) => d.accept().catch((err) => console.error('confirm accept failed', err));
  alice.on('dialog', accept);
  await alice.click('#box-btn');
  await alice.waitForSelector('#box-dialog[open]');
  await alice.click('#box-builtins [data-builtin="ranks"]');
  await alice.waitForFunction(() => !document.querySelector('#box-dialog[open]'), null, { timeout: 15000 });
  alice.off('dialog', accept);
  await settle(alice);
  ok(await seatUs(), 'Alice sits South, Bob North');
  S = await state(alice);
  const vrBox = Object.keys(S.boxes).find((k) => S.boxes[k].name === 'Veiled Ranks');
  ok(S.rules?.enabled && S.rules.name === 'Veiled Ranks' && S.rules.box === vrBox, `the box's rules run (${S.rules?.name})`);
  /** Every unit on the host: {id: {side, unit, rank}}. */
  const unitsOf = (S) => Object.fromEntries(Object.keys(S.items).filter((k) => S.boxes[vrBox]?.types[S.items[k].t?.split('/')[1]]?.meta?.unit).map((k) => [k, S.boxes[vrBox].types[S.items[k].t.split('/')[1]].meta]));
  const U = unitsOf(S), side = (s) => Object.keys(U).filter((k) => U[k].side === s).sort(), SOUTH = side('south'), NORTH = side('north');
  const row = (k) => Number(sqOf(S.items[k]).slice(1));
  ok(SOUTH.length === 12 && NORTH.length === 12, `12 units a side (${SOUTH.length}, ${NORTH.length})`);
  ok(SOUTH.every((k) => row(k) <= 3 && S.items[k].up === false && J(S.items[k].vis) === J(['seat:south']) && S.items[k].pv === 1)
    && NORTH.every((k) => row(k) >= 8 && S.items[k].up === false && J(S.items[k].vis) === J(['seat:north']) && S.items[k].pv === 1),
  'each side\'s units in its three rows, face down behind its screen: vis its seat, pv');
  for (const [p, mine, theirs] of [[alice, SOUTH, NORTH], [bob, NORTH, SOUTH]]) {
    ok(await P.waitView(p, 'a.every((id) => !!v.items[id])', [...mine, ...theirs], 10000), `${NAME[p.pid]}'s screen holds the 24 units`);
    const v = await viewOf(p), l = await lookUntil(p, [...mine, ...theirs], (l) => mine.every((k) => l[k] && !l[k].back));
    ok(mine.every((k) => sight(v, k) === 'mine') && theirs.every((k) => sight(v, k) === 'back'), `${NAME[p.pid]}'s view: the own 12 in full, the other 12 their back`);
    ok(mine.every((k) => !l[k].back && l[k].badge) && theirs.every((k) => l[k]?.back && !l[k].badge), `${NAME[p.pid]}'s screen: the own faces with 🙈, the other's backs`);
  }
  const field = Object.keys(S.items).find((k) => /\/field$/.test(S.items[k].t));
  ok(J((await zoneOf(alice, field))?.texts) === J(["🔒 Bob's screen", '🔒 Your screen']) && J((await zoneOf(bob, field))?.texts) === J(["🔒 Alice's screen", '🔒 Your screen']), `the screens named on each (${J((await zoneOf(alice, field))?.texts)}, ${J((await zoneOf(bob, field))?.texts)})`);

  /** The squares of every unit on the host, the turn and each unit's private fields, as one text: what a refusal must leave alone. */
  const board = async () => { const S = await state(alice); return J([S.rules?.public?.turn, Object.keys(unitsOf(S)).sort().map((k) => [k, sqOf(S.items[k]), S.items[k].up, S.items[k].vis, S.items[k].owner])]); };
  /** Waits until both screens hold the host's units on the host's squares (true), 10 s at most. */
  async function synced() {
    const S = await state(alice), want = J(Object.keys(unitsOf(S)).sort().map((k) => [k, sqOf(S.items[k])]));
    const expr = 'JSON.stringify(Object.keys(v.items).filter((k) => v.items[k].k === "g" && v.items[k].at).sort().map((k) => [k, v.items[k].at])) === a';
    return (await Promise.all([alice, bob].map((p) => P.waitView(p, expr, want, 10000)))).every(Boolean);
  }
  /** The table point at the centre of square `sq` (as page p resolves it). */
  const centreOf = (p, sq) => p.evaluate((a) => window.__ct.resolve(a), sq);
  /** Drags unit `id` on page p onto square `sq`. */
  const moveTo = async (p, id, sq) => { const r = await centreOf(p, sq); await dragTo(p, id, r.x, r.y); };
  /** The unit on square sq on the host now, or undefined. */
  const at = (S, sq) => Object.keys(unitsOf(S)).find((k) => sqOf(S.items[k]) === sq);
  /** p's drag of `id` onto `sq` must be refused: a 🚫 notice, nothing changed. */
  async function refused(p, id, sq, what) {
    const b0 = await board(), t0 = Date.now();
    await moveTo(p, id, sq);
    const said = await refusal(p, t0);
    await settle(alice);
    ok(said && (await board()) === b0, `${what}: refused ("${said}"), nothing changed`);
    await synced();
  }
  /** Deploys: p drags `id` onto `sq` in its own rows; a unit of its own there swaps with it. */
  async function deploy(p, id, sq) {
    let S = await state(alice);
    const from = sqOf(S.items[id]), there = at(S, sq);
    if (from === sq) return;
    await moveTo(p, id, sq);
    await hostSees(alice, (S) => sqOf(S.items[id]) === sq);
    S = await state(alice);
    const it = S.items[id], s = U[id].side;
    ok(sqOf(it) === sq && it.up === false && J(it.vis) === J([`seat:${s}`]) && it.pv === 1 && (!there || sqOf(S.items[there]) === from),
      `${NAME[p.pid]} deploys ${U[id].unit} ${from} → ${sq}${there ? ` (its ${U[there].unit} goes to ${from})` : ''}: still face down behind the screen`);
    ok(await synced(), '…both screens agree');
  }

  section('V2 deployment: inside the zone (a move, a swap) on both devices; outside refused');
  const by = (ids, unit) => ids.filter((k) => U[k].unit === unit);
  const [LA, LB] = by(SOUTH, 'lancer'), [SP] = by(SOUTH, 'pike'), [H] = by(SOUTH, 'herald'), [CR] = by(SOUTH, 'crown'), [SB] = by(SOUTH, 'banner');
  const [NL] = by(NORTH, 'lancer'), [NT] = by(NORTH, 'trap'), [NB] = by(NORTH, 'blade');
  // a swap first: the first two South units by square (two of the setup's places) trade them
  const bySq = (ids) => [...ids].sort((a, b) => row(a) - row(b) || sqOf(S.items[a]).localeCompare(sqOf(S.items[b])));
  const [w1, w2] = bySq(SOUTH);
  await deploy(alice, w1, sqOf(S.items[w2]));
  for (const [id, sq] of [[H, 'e3'], [SP, 'c3'], [LA, 'c2'], [LB, 'g3'], [CR, 'i3'], [SB, 'f3']]) await deploy(alice, id, sq);
  const spare = SOUTH.find((k) => ![LA, LB, SP, H, CR, SB].includes(k));
  await refused(alice, spare, 'e5', 'Alice deploys a unit on e5, outside her rows');
  for (const [id, sq] of [[NL, 'e8'], [NT, 'h8'], [NB, 'i8']]) await deploy(bob, id, sq);
  const nspare = NORTH.find((k) => ![NL, NT, NB].includes(k) && !['banner', 'trap'].includes(U[k].unit));
  await refused(bob, nspare, 'e6', 'Bob (his phone) deploys a unit on e6, outside his rows');
  const va = await viewOf(alice), vb = await viewOf(bob);
  ok(NORTH.every((k) => sight(va, k) === 'back') && SOUTH.every((k) => sight(vb, k) === 'back'), 'deployed, each army is still its back on the other\'s screen');
  await M.shot(alice, 'p5d-ranks-deploy-desk');
  await M.shot(bob, 'p5d-ranks-deploy-phone');

  section('V3 ✓ Ready: Alice first (her deployment locked, D273), then Bob — play begins');
  ok(await M.until(async () => (await ST.buttons(alice)).includes('✓ Ready') && (await ST.buttons(bob)).includes('✓ Ready'), 8000, 100), 'both players are offered ✓ Ready');
  await ST.press(alice, /✓ Ready/, false);
  await settle(alice);
  ok(await M.until(async () => !(await ST.buttons(alice)).includes('✓ Ready'), 5000, 100) && (await ST.buttons(bob)).includes('✓ Ready'), 'Alice ready: her button gone, Bob\'s still there');
  S = await state(alice);
  const [d1, d2] = bySq(SOUTH.filter((k) => row(k) <= 2 && k !== LA));
  await refused(alice, d1, sqOf((await state(alice)).items[d2]), 'Alice, ready, rearranges two of her units');
  await ST.press(bob, /✓ Ready/, true);
  await settle(alice);
  ok(await M.until(async () => !(await ST.buttons(alice)).includes('✓ Ready') && !(await ST.buttons(bob)).includes('✓ Ready'), 5000, 100), 'both ready: no ✓ Ready left on either screen');

  section('V4 play: a move out of turn, a diagonal, two squares, the Banner, a Lancer through a blocked square — refused; a legal step');
  const turnSide = async () => { const t = (await state(alice)).rules?.public?.turn; return t === ALICE ? 'south' : t === BOB ? 'north' : null; };
  const first = await turnSide();
  ok(first === 'south' || first === 'north', `a side is to move (${first})`);
  // North's spare moves (a unit away from every square in play: there and back), so South leads the plan whoever moves first
  S = await state(alice);
  const busy = new Set(['e8', 'e7', 'e6', 'e5', 'e4', 'f4', 'f3', 'g8', 'g7', 'h8', 'i8', 'i7', 'i6', 'i5']);
  const step = (sq, dc, dr) => { const c = 'abcdefghij'.indexOf(sq[0]) + dc, r = Number(sq.slice(1)) + dr; return c >= 0 && c < 10 && r >= 1 && r <= 10 ? 'abcdefghij'[c] + r : null; };
  let filler = null;
  for (const k of NORTH.filter((k) => ![NL, NT, NB].includes(k) && !['banner', 'trap'].includes(U[k].unit))) {
    const s = sqOf(S.items[k]), to = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => step(s, dc, dr)).find((x) => x && Number(x.slice(1)) >= 8 && !busy.has(x) && !busy.has(s) && !at(S, x));
    if (to) { filler = { id: k, a: s, b: to }; break; }
  }
  ok(!!filler, `a North unit to mark time with (${J(filler)})`);
  /** A move meant to be legal: p drags `id` onto `sq`; {S: the host state after, passed: the turn went to the other side}. */
  async function play(p, id, sq, what) {
    const s0 = await turnSide();
    await moveTo(p, id, sq);
    await hostSees(alice, (S) => S.rules?.public?.turn !== { south: ALICE, north: BOB }[s0]);
    ok(await synced(), `${what}: both screens agree`);
    const s1 = await turnSide(), S = await state(alice);
    return { S, passed: s0 !== s1 && !!s1 };
  }
  /** North marks time: the filler unit to its other square. */
  const markTime = async () => {
    const to = sqOf((await state(alice)).items[filler.id]) === filler.a ? filler.b : filler.a, r = await play(bob, filler.id, to, `North marks time: ${U[filler.id].unit} to ${to}`);
    ok(sqOf(r.S.items[filler.id]) === to && r.passed, '…its turn spent');
  };
  if (first === 'north') await markTime();
  ok(await turnSide() === 'south', 'South to move');
  await refused(bob, NB, 'i7', 'Bob moves while it is South\'s turn');
  await refused(alice, CR, 'h4', 'a diagonal step (the Crown i3 → h4)');
  await refused(alice, CR, 'i5', 'two squares for a Crown (i3 → i5)');
  await refused(alice, SB, 'f4', 'the Banner moves (f3 → f4)');
  await refused(alice, LB, 'g6', 'a Lancer three squares (g3 → g6, a clear file: no unit moves any distance)');
  await refused(alice, LA, 'c4', "a Lancer's two squares through its own Pike (c2 → c4, c3 blocked)");
  let r = await play(alice, CR, 'i4', 'the Crown steps i3 → i4');
  ok(sqOf(r.S.items[CR]) === 'i4' && r.passed, 'a legal step: the Crown on i4, North to move');
  ok(r.S.items[CR].up === false && J(r.S.items[CR].vis) === J(['seat:south']) && !r.S.items[CR].pv, `out from behind its screen it stays hidden (keep): up false, vis [seat:south], no pv (${J(r.S.items[CR])})`);
  ok(sight(await viewOf(alice), CR) === 'mine' && sight(await viewOf(bob), CR) === 'back' && (await lookUntil(bob, [CR], (l) => l[CR]?.back))[CR]?.back, "Alice sees its face, Bob's phone its back");

  section("V5 a Lancer's two-square move — North's on Bob's phone held sideways, South's on the desktop");
  await bob.setViewportSize({ width: 844, height: 390 });
  await h.sleep(800);
  r = await play(bob, NL, 'e6', 'North\'s Lancer e8 → e6 (sideways)');
  ok(sqOf(r.S.items[NL]) === 'e6' && r.passed && sight(await viewOf(alice), NL) === 'back', 'two squares, its first one empty: on e6, still hidden from Alice; South to move');
  await M.shot(bob, 'p5d-ranks-phone-sideways');
  await bob.setViewportSize({ width: P.PHONE.viewport.width, height: P.PHONE.viewport.height });
  await h.sleep(800);
  r = await play(alice, LB, 'g5', 'South\'s Lancer g3 → g5');
  ok(sqOf(r.S.items[LB]) === 'g5' && r.passed && sight(await viewOf(bob), LB) === 'back', "South's Lancer two squares: on g5, still hidden from Bob");
  r = await play(bob, NL, 'e4', "North's Lancer e6 → e4");
  ok(sqOf(r.S.items[NL]) === 'e4' && r.passed, 'North\'s Lancer two squares again: on e4, face to face with the Herald');

  section("V6 a Herald's parley: both units revealed on both screens, neither removed, the Herald where it was");
  t0 = Date.now();
  r = await play(alice, H, 'e4', 'the Herald e3 attacks e4');
  ok(sqOf(r.S.items[H]) === 'e3' && sqOf(r.S.items[NL]) === 'e4' && r.S.items[H].up !== false && r.S.items[NL].up !== false && !r.S.items[H].vis && !r.S.items[NL].vis && r.passed,
    `both still there — the Herald on e3, the Lancer on e4 — both face up, no vis (${J([r.S.items[H], r.S.items[NL]])})`);
  for (const p of [alice, bob]) {
    ok(await P.waitView(p, 'a.every((k) => v.items[k] && "t" in v.items[k] && v.items[k].up !== false)', [H, NL], 10000), `${NAME[p.pid]}'s view: both face up`);
    const l = await lookUntil(p, [H, NL], (l) => !l[H]?.back && !l[NL]?.back);
    ok(!l[H].back && !l[NL].back && !l[H].badge && !l[NL].badge, `${NAME[p.pid]}'s screen draws both faces, no 🙈`);
    ok((await logSince(p, t0)).some((x) => /Herald/.test(x) && /Lancer/.test(x)), `${NAME[p.pid]}'s log names both (${J(await logSince(p, t0))})`);
  }

  section('V7 an attack: both revealed, the lower removed');
  r = await play(bob, NB, 'i7', "North's Blade i8 → i7");
  r = await play(alice, CR, 'i5', 'the Crown i4 → i5');
  r = await play(bob, NB, 'i6', "North's Blade i7 → i6");
  ok(sqOf(r.S.items[NB]) === 'i6' && sqOf(r.S.items[CR]) === 'i5', 'the Crown (4) on i5 faces the Blade (3) on i6, both hidden from the other side');
  t0 = Date.now();
  r = await play(alice, CR, 'i6', 'the Crown attacks i6');
  ok(!r.S.items[NB] && sqOf(r.S.items[CR]) === 'i6' && r.S.items[CR].up !== false && !r.S.items[CR].vis && r.passed, `the Blade (the lower) removed; the Crown face up on i6 (${J(r.S.items[CR])})`);
  for (const p of [alice, bob]) {
    ok(await P.waitView(p, '!v.items[a[0]] && v.items[a[1]] && "t" in v.items[a[1]] && v.items[a[1]].up !== false', [NB, CR], 10000), `${NAME[p.pid]}'s view: the Blade gone, the Crown face up`);
    ok(!(await lookUntil(p, [CR], (l) => l[CR] && !l[CR].back))[CR].back, `${NAME[p.pid]}'s screen draws the Crown's face`);
    ok((await logSince(p, t0)).some((x) => /Crown/.test(x) && /Blade/.test(x)), `${NAME[p.pid]}'s log names both, the Blade revealed in its fall (${J(await logSince(p, t0))})`);
  }

  section("V8 a hidden unit steps into the other side's rows: it stays hidden from that side");
  r = await play(bob, NL, 'f4', "North's Lancer (revealed) e4 → f4");
  ok(r.S.items[NL].up !== false && sight(await viewOf(alice), NL) === 'face', 'a unit combat revealed stays revealed as it moves on');
  r = await play(alice, LB, 'g7', "South's Lancer g5 → g7");
  await markTime();
  const lbFrom = (await bodies(bob)).length;
  r = await play(alice, LB, 'g8', "South's Lancer g7 → g8, into North's rows");
  ok(sqOf(r.S.items[LB]) === 'g8' && r.S.items[LB].up === false && J(r.S.items[LB].vis) === J(['seat:south']) && r.passed, `on g8 behind North's screen it is still South's alone: vis [seat:south] (${J(r.S.items[LB])})`);
  ok(sight(await viewOf(bob), LB) === 'back' && (await lookUntil(bob, [LB], (l) => l[LB]?.back))[LB]?.back && sight(await viewOf(alice), LB) === 'mine', "Bob's phone: its back; Alice: its face");
  const since = (await bodies(bob)).slice(lbFrom);
  ok(since.length && forms(since, LB).every((f) => !('t' in f) && !('f' in f)) && !since.some((b) => b.vis?.[LB]), `no body of that move gave Bob its face or an override (${since.length} bodies)`);
  await markTime();

  section('V9 a Trap attacked: both removed');
  const toTrap = await bodies(bob);
  ok(forms(toTrap, LB).length && forms(toTrap, LB).every((f) => !('t' in f) && !('f' in f)) && !toTrap.some((b) => b.vis?.[LB]), `all the way from its screen, through the field and into North's rows, no body gave Bob the Lancer's face (${forms(toTrap, LB).length} forms in ${toTrap.length} bodies)`);
  t0 = Date.now();
  r = await play(alice, LB, 'h8', "South's Lancer attacks h8");
  ok(!r.S.items[LB] && !r.S.items[NT] && r.passed, 'the Lancer and the Trap both removed');
  for (const p of [alice, bob]) {
    ok(await P.waitView(p, '!v.items[a[0]] && !v.items[a[1]]', [LB, NT], 10000), `${NAME[p.pid]}'s view: both gone`);
    ok((await logSince(p, t0)).some((x) => /Trap/.test(x) && /Lancer/.test(x)), `${NAME[p.pid]}'s log names both (${J(await logSince(p, t0))})`);
  }

  section('V10 the Banner captured: 🏆 on both screens, every unit revealed');
  S = await state(alice);
  const stillHidden = SOUTH.filter((k) => S.items[k]?.up === false), scanTo = (await bodies(bob)).length;
  r = await play(bob, NL, 'f3', "North's Lancer takes f3, South's Banner");
  ok(!r.S.items[SB] && r.S.rules?.public?.winners?.includes(BOB), `the Banner taken: Bob (North) wins (${J(r.S.rules?.public?.winners)})`);
  for (const p of [alice, bob]) {
    const l = await P.label(p, /^🏆/, 10000);
    ok(l && /Bob/.test(l.text) && !(await P.labels(p)).some((x) => /^🏆/.test(x.text) && /Alice/.test(x.text)), `${NAME[p.pid]}'s screen: 🏆 on Bob's seat ("${l?.text}")`);
    ok(await P.waitView(p, 'Object.values(v.items).filter((it) => it.at).every((it) => "t" in it && it.up !== false)', null, 10000), `${NAME[p.pid]}'s view: every unit left face up (the game over, D273)`);
  }
  await M.shot(alice, 'p5d-ranks-end-desk');
  await M.shot(bob, 'p5d-ranks-end-phone');
  const vr = (await bodies(bob)).slice(0, scanTo);
  const shown = stillHidden.filter((k) => forms(vr, k).some((f) => 't' in f || 'f' in f));
  ok(stillHidden.length >= 6 && !shown.length && !vr.some((b) => Object.keys(b.vis || {}).some((k) => U[k]?.side === 'south')),
    `every body Bob got before the end: the ${stillHidden.length} South units still hidden then never with a t or an f, no override of a South unit (${J(shown)})`);
  await env.done();
})().catch(h.crash);
