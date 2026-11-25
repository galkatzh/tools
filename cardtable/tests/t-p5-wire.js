// E2E: Phase 5's engine and wire (spec §5a–§5f, §5j) over a real room —
// the UI's buttons are Phase 5's part 2, so every action goes through
// __ct.act, a click's own path, or Mallory's raw sends. Alice hosts (south),
// Bob is a guest (north), Mallory a raw peer (east, then north).
//  1  Alice cups three dice and rolls them: her screen draws their faces
//     (the per-recipient `vis` override), Bob's and Mallory's their cup; the
//     log names no hidden value.
//  2  A gem drawn from the bag straight into Alice's rack lands hidden there
//     (a 'reveal' zone): hers in full, a back to the others; a tile played
//     off it is shown to all.
//  3  Mallory's attacks (§5j cases 4, 5, 6, 8): flip, roll and face of the
//     cupped dice — the uniform refusal; move, claim — Alice's; a hide of
//     Alice's pieces, or of a piece with no back — refused; a move with
//     forged vis and up — ignored; a peek at the rack's gem — answered to her
//     alone, loudly.
//  4  Seat refs follow the seat (case 3): Bob's unit behind north's screen;
//     Bob stands up, Mallory sits north: she sees it, Bob doesn't — and the
//     cup (Alice's id) she never sees.
//  5  Bob reloads: his snapshot carries his own full forms; a group hide.
//  6  The recursive scan: no body Mallory received carried a hidden piece's
//     identity — the gem's type ref and label never, the cupped dice's faces
//     never once cupped — and her folded view keeps in step.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section, logHas } = h;
const { mallory } = require('./final-lib');
const { boxFromDef } = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

const MAL = 'ffffffffffffffff';
const RECT = (w, h_) => [[0, 0], [w, 0], [w, h_], [0, h_]];
/** The test box: racks ('reveal', their board's owner's), north's screen
 *  ('keep'), tiles, gems (never shown: their label ZQXG and type ref are the
 *  scan's needles), dice under a cup back, units, a coin with no back. */
const PRIVY = boxFromDef({
  name: 'Privy wire', table: { shape: 'rect', w: 3000, h: 2000 },
  seats: [{ id: 'south', name: 'South', edge: 'bottom' }, { id: 'east', name: 'East', edge: 'right' }, { id: 'north', name: 'North', edge: 'top' }],
  backs: [{ id: 'tb', color: '#333' }, { id: 'cup', color: '#7c2d12' }, { id: 'ub', color: '#1e3a8a' }],
  pieces: [
    { id: 'rack', kind: 'board', w: 520, h: 140, zones: [{ id: 'r', poly: RECT(520, 140), owner: 'board', private: 'reveal' }] },
    { id: 'screen', kind: 'board', w: 600, h: 300, zones: [{ id: 's', poly: RECT(600, 300), owner: 'seat:north', private: 'keep' }] },
    { id: 'tile', kind: 'tile', w: 60, h: 120, back: 'tb', faces: [{ label: 'T1' }] },
    { id: 'gem', kind: 'tile', w: 60, h: 120, back: 'tb', faces: [{ label: 'ZQXG' }] },
    { id: 'd6', kind: 'die', back: 'cup' },
    { id: 'unit', kind: 'token', shape: 'rect', w: 60, back: 'ub', faces: [{ label: 'Crown' }] },
    { id: 'coin', kind: 'token', faces: ['C'] },
  ],
  setup: [
    { piece: 'rack', at: [200, 1750], owner: 'seat:south', id: 'aaaa0001' },
    { piece: 'screen', at: [1200, 200], id: 'aaaa0005' },
    { piece: 'tile', at: [100, 1000], id: 'bbbb0001' },
    { piece: 'd6', at: [600, 1000], id: 'bbbb0004' },
    { piece: 'd6', at: [680, 1000], id: 'bbbb0005' },
    { piece: 'd6', at: [760, 1000], id: 'bbbb0006' },
    { piece: 'unit', at: [2000, 1000], id: 'bbbb0008' },
    { piece: 'unit', at: [2100, 1000], id: 'bbbb0009' },
    { piece: 'unit', at: [2200, 1000], id: 'bbbb000a' },
    { piece: 'coin', at: [700, 1300], id: 'bbbb000c' },
    { bag: [{ t: 'gem', up: false, n: 4 }], name: 'Pool', at: [2600, 1500], id: 'bbbb000b' },
  ],
});
const DICE = ['bbbb0004', 'bbbb0005', 'bbbb0006'], RACK = 'aaaa0001', SCREEN = 'aaaa0005', TILE = 'bbbb0001', BAG = 'bbbb000b', UNIT = 'bbbb0008', COIN = 'bbbb000c';

const settle = (page) => page.waitForFunction(() => window.__ct.jobs() === 0, null, { timeout: 15000 });
const state = (page) => page.evaluate(() => window.__ct.hostState());
const viewOf = (page, id) => page.evaluate((i) => window.__ct.view().items[i] ?? null, id);
/** Waits until page's view of item `id` satisfies pred (a function source over `it`). */
const until = (page, id, pred) => page.waitForFunction(([i, p]) => { const it = window.__ct.view().items[i]; return !!it && new Function('it', `return ${p}`)(it); }, [id, pred], { timeout: 15000 });

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const M = await mallory(env, await host.evaluate(() => location.href));
  await M.act({ t: 'hello' });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3, null, { timeout: 15000 });
  const act = (page, a) => page.evaluate((x) => window.__ct.act(x), a);
  const malNotes = () => M.evaluate(() => window.M.notes());
  /** Mallory's raw state bodies so far, unwrapped. */
  const malBodies = () => M.evaluate(() => window.M.got.state.map(({ m }) => (typeof m.b === 'string' ? JSON.parse(m.b) : m)));
  /** Mallory's view as her bodies fold (h.viewFrom). */
  const malView = async () => h.viewFrom(await malBodies());

  section('0 the room: Alice south, Bob north, Mallory east; the test box set up');
  ok((await act(host, { t: 'loadBox', box: PRIVY, setup: true, clear: true })).ok, 'the host loads the box with its setup');
  await settle(host);
  let S = await state(host);
  const pid = Object.fromEntries(Object.entries(S.players).map(([p, pl]) => [pl.name, p])), ALICE = pid.Alice, BOB = pid.Bob;
  for (const a of [{ p: MAL, watch: true }, { p: BOB, watch: true }, { p: BOB, id: 'north' }, { p: MAL, id: 'east' }]) await act(host, { t: 'seat', ...a });
  await settle(host);
  S = await state(host);
  ok(S.players[ALICE].seatId === 'south' && S.players[BOB].seatId === 'north' && S.players[MAL]?.seatId === 'east', `seated: ${JSON.stringify(Object.fromEntries(Object.values(S.players).map((pl) => [pl.name, pl.seatId])))}`);
  const box = Object.keys(S.boxes).find((b) => S.boxes[b].name === 'Privy wire'), GEM_REF = `${box}/gem`;
  await guest.waitForFunction((i) => !!window.__ct.view().items[i], TILE, { timeout: 15000 });

  section('1 Alice cups three dice and rolls them: her faces, everyone else\'s cup');
  ok((await act(host, { t: 'hide', ids: DICE })).ok, 'hide {ids: 3 dice}');
  await until(guest, DICE[0], "'b' in it");
  const cupFrom = (await malBodies()).length;
  ok((await act(host, { t: 'roll', ids: DICE })).ok, 'Alice rolls them');
  await logHas(guest, 'rolled 3 hidden dice');
  S = await state(host);
  const mine = await viewOf(host, DICE[0]), bobs = await viewOf(guest, DICE[0]);
  ok(mine.up === false && mine.t === S.items[DICE[0]].t && mine.f === S.items[DICE[0]].f && JSON.stringify(mine.vis) === JSON.stringify([ALICE]) && mine.owner === ALICE,
    `Alice's screen holds the die in full: its face, up false, vis [Alice] (${JSON.stringify(mine)})`);
  ok(bobs.b && !('t' in bobs) && !('f' in bobs) && !('vis' in bobs) && bobs.owner === ALICE, `Bob's holds the cup (${JSON.stringify(bobs)})`);
  ok(await host.evaluate(() => document.getElementById('log').textContent.includes('hid 3 pieces')), 'the log: "hid 3 pieces", then "rolled 3 hidden dice"');

  section("2 a gem drawn from the bag straight into Alice's rack: hidden there, hers alone");
  S = await state(host);
  const rx = S.items[RACK].x + 120, ry = S.items[RACK].y + 10;
  ok((await act(host, { t: 'pull', id: BAG, x: rx, y: ry })).ok, "pull from the bag at a spot of Alice's rack");
  await settle(host);
  S = await state(host);
  const GEM = Object.keys(S.items).find((k) => S.items[k].t === GEM_REF);
  ok(GEM && S.items[GEM].up === false && JSON.stringify(S.items[GEM].vis) === JSON.stringify(['seat:south']) && S.items[GEM].pv === 1 && S.items[GEM].owner === 'seat:south' && S.items[GEM].po === 1,
    `the host's state: up false, vis [seat:south], pv, owner seat:south, po (${JSON.stringify(S.items[GEM])})`);
  await until(guest, GEM, "'b' in it");
  ok((await viewOf(host, GEM)).t === GEM_REF && !('t' in (await viewOf(guest, GEM))), "Alice's screen shows the gem; Bob's its back");
  ok(await guest.evaluate(() => document.getElementById('log').textContent.includes('drew a piece from the bag Pool')), 'the log: "drew a piece from the bag Pool" — never its name');
  ok((await act(host, { t: 'move', id: TILE, x: rx + 100, y: ry })).ok, 'Alice puts a tile on her rack');
  await until(guest, TILE, "'b' in it");
  ok((await act(host, { t: 'move', id: TILE, x: 1500, y: 1200 })).ok, '…and plays it off the rack');
  await until(guest, TILE, "'t' in it && it.y === 1200");
  S = await state(host);
  ok(S.items[TILE].up !== false && !S.items[TILE].vis && !S.items[TILE].owner, 'played off a rack: face up for everyone, its owner gone (po)');

  section("3 Mallory's attacks: the uniform refusals, ownership through po, forged fields, a loud peek");
  const before = JSON.stringify(DICE.map((d) => S.items[d]));
  for (const a of [{ t: 'flip', id: DICE[0] }, { t: 'roll', ids: [DICE[1]] }, { t: 'face', id: DICE[2], f: 3 }, { t: 'move', id: DICE[0], x: 50, y: 50 }, { t: 'owner', id: DICE[1], to: MAL },
    { t: 'flip', id: GEM }, { t: 'move', id: GEM, x: 40, y: 40 }, { t: 'hide', ids: [COIN] }, { t: 'hide', ids: [DICE[0]] }]) await M.act(a);
  await M.waitForFunction(() => window.M.notes().filter((n) => n.msg).length >= 9, null, { timeout: 15000 });
  const said = (await malNotes()).filter((n) => n.msg).map((n) => n.msg);
  ok(JSON.stringify(said.slice(0, 9)) === JSON.stringify(['🚫 That piece is hidden', '🚫 That piece is hidden', '🚫 That piece is hidden', '🚫 That belongs to Alice', '🚫 That belongs to Alice',
    '🚫 That piece is hidden', '🚫 That belongs to South', '🚫 That piece has no hidden side', '🚫 That piece is hidden']), `flip, roll, face of the cup: hidden; move, claim: Alice's; the gem: hidden, South's; hides refused (${JSON.stringify(said)})`);
  S = await state(host);
  ok(JSON.stringify(DICE.map((d) => S.items[d])) === before && S.items[GEM].x === rx, 'the dice, their values and the gem unchanged in the host state');
  await M.act({ t: 'move', id: UNIT, x: 1900, y: 1400, vis: [MAL], up: false, pv: 1, owner: MAL });
  await logHas(host, 'Mallory moved Crown');
  S = await state(host);
  ok(S.items[UNIT].x === 1900 && S.items[UNIT].up !== false && !S.items[UNIT].vis && !S.items[UNIT].owner, `a move with forged vis, up, pv and owner: moved, the rest ignored (${JSON.stringify(S.items[UNIT])})`);
  await M.act({ t: 'peek', id: GEM });
  await M.waitForFunction(() => window.M.notes().some((n) => n.peek), null, { timeout: 10000 });
  const peek = (await malNotes()).find((n) => n.peek);
  ok(peek.to === MAL && peek.peek.t === GEM_REF && peek.peek.f === 0, `Mallory's peek at the gem: {t, f} to her alone (${JSON.stringify(peek)})`);
  await logHas(guest, 'Mallory peeked at a hidden piece');
  ok(!(await guest.evaluate(() => document.getElementById('log').textContent.includes('ZQXG'))), 'on the record, naming nothing');

  section('4 seat refs follow the seat: Bob\'s unit behind north\'s screen; Mallory takes north');
  S = await state(host);
  ok((await act(guest, { t: 'move', id: 'bbbb0009', x: S.items[SCREEN].x + 200, y: S.items[SCREEN].y + 100 })).ok, "Bob puts a unit behind north's screen");
  await until(host, 'bbbb0009', "'b' in it");
  ok('t' in (await viewOf(guest, 'bbbb0009')) && !('t' in (await viewOf(host, 'bbbb0009'))), 'Bob sees it; Alice gets its back');
  await act(host, { t: 'seat', p: BOB, watch: true });
  await act(host, { t: 'seat', p: MAL, id: 'north' });
  await settle(host);
  await until(guest, 'bbbb0009', "'b' in it");
  let mv;
  for (let k = 0; k < 60 && !('t' in ((mv = await malView())?.items['bbbb0009'] || {})); k++) await h.sleep(250);
  ok('t' in mv.items['bbbb0009'] && JSON.stringify(mv.items['bbbb0009'].vis) === JSON.stringify(['seat:north']), "Mallory, now north, holds its full form (her override)");
  ok(!('t' in (await viewOf(guest, 'bbbb0009'))) && !('t' in mv.items[DICE[0]]), "Bob, a watcher now, its back — and Alice's cup Mallory never sees (vis is Alice's id)");
  await act(host, { t: 'seat', p: MAL, id: 'east' });
  await act(host, { t: 'seat', p: BOB, id: 'north' });
  await settle(host);

  section('5 Bob reloads: his snapshot carries his own full forms; a group hide');
  await guest.reload();
  ok(await guest.waitForFunction((i) => 't' in (window.__ct?.view().items[i] || {}), 'bbbb0009', { timeout: 30000 }).then(() => true, () => false),
    "after a reload, Bob's first snapshot holds north's unit in full");
  ok((await act(guest, { t: 'group', op: 'hide', ids: ['bbbb000a', COIN, UNIT] })).ok, 'Bob hides a group of three');
  await logHas(host, 'Bob hid 2 pieces');
  S = await state(host);
  ok(JSON.stringify(S.items.bbbb000a.vis) === JSON.stringify([BOB]) && S.items[COIN].up !== false && S.items[UNIT].owner === BOB, "each member as a single hide (the coin skipped: no back): Bob's alone, his through po");

  section('6 the recursive scan: nothing Mallory received names a hidden identity');
  await settle(host);
  await h.sleep(500);
  const all = await malBodies(), texts = all.map((b) => JSON.stringify(b));
  ok(all.length > 10 && !texts.some((t) => t.includes(GEM_REF) || t.includes('ZQXG')), `no body of ${all.length} carries the gem's type ref or label`);
  const cupped = all.slice(cupFrom).flatMap((b) => [...Object.entries(b.items || {}), ...Object.entries(b.vis || {})]).filter(([id]) => DICE.includes(id));
  ok(cupped.length && cupped.every(([, it]) => !('t' in it) && !('f' in it) && !('vis' in it)), `once cupped, every form of the dice she got is the cup's (${cupped.length} forms)`);
  ok(all.every((b) => !b.vis || Object.keys(b.vis).every((id) => id === 'bbbb0009')), 'her only overrides: north\'s unit, while she sat north');
  const scan = (v, at = '') => (Array.isArray(v) ? v.flatMap((x, k) => scan(x, `${at}[${k}]`)) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => (k === 't' && x === GEM_REF ? [at] : scan(x, `${at}.${k}`))) : []);
  ok(!scan(all).length, 'a recursive walk of every body finds no `t` naming a gem');
  ok((await malView()).seq === (await host.evaluate(() => window.__ct.view().seq)), "Mallory's folded view is in step with the host's");
  await env.done();
})().catch(h.crash);
