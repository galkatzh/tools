// Phase 5, private material on real screens, written from the spec apart
// from the implementation's own t-p5-private.js (§5l t-p5-private items 1–4;
// §5j attacker cases 1–9 and 11; §5a, §5c, §5d, §5g, §5h; D249–D268). Bob
// hosts on a desktop (mouse, Shift+click), Alice plays on an iPhone 13 (CDP
// taps and finger drags; held upright, and sideways for a while), Mallory is
// a raw peer (final-lib), seated east. The box, "Veil test", is original:
// a rack per seat south and north (`private: 'reveal'`), South's screen
// (`'keep'`), dice under one cup back — Alice's three (faces Qa1–Qa6), Bob's
// one (Qb1–Qb6), two plain ones (Sd1–Sd6) —, tiles under one back (Amber's
// Qt…, Blue's Bt…, loose ones), units, a coin with no back, two bags.
// Every face of what Mallory must never learn carries a token found nowhere
// else (Qa…, Qb…, Qt…, Qu7x, Qf9z): every body she gets is scanned for those
// tokens and their type refs, recursively, and every record of those pieces
// for any field beyond the reduced form (§5d), before and after the rolls,
// the seat changes, a host reload, a demotion and an export/import.
//   1  Alice's cup (case 1, items 2–4): 🙈 Hide on her phone cups the dice;
//      the 🙈 badge, the hatched corner and the tooltip on her screen alone;
//      🎲 Roll under the cup tumbles the backs on Bob's screen, the faces on
//      hers; the bars (Reveal and 🎲 Roll for her, Peek for Bob).
//   2  Bob's cup on the desktop (item 3): cupped, rolled, revealed — the
//      face on both screens; his 🙈 for him alone.
//   3  A group roll of two cupped and two shown dice (case 11) and a group
//      🙈 Hide on the phone held sideways (⬚ and taps), then Reveal from its
//      bar; Bob's group 🙈 Hide by Shift+click never sends the coin.
//   4  Racks and a screen (case 2): 🔒 Draw to my rack on both screens, a
//      tile dragged off Bob's rack face up for all; Alice's unit behind her
//      screen and out again, still hers alone; Bob's Peek (the overlay, its
//      caption, the loud line).
//   5  Mallory's own tries (cases 4, 5, 6, 8): refused — uniformly where the
//      spec says so —, her peek answered to her alone, forged fields ignored.
//   6  A seat change, a host reload, a demotion: Alice's faces are still
//      hers alone after each; Mallory still gets nothing.
//   7  Export and import (📦, §5h): the file writes `#k` and no pid, no pv;
//      set up again, every private piece is as it was.
//   8  Alice leaves; Mallory takes South (case 3): South's rack tiles and
//      unit are hers to see now (seat refs), Alice's cup never (her pid).
//   9  A script (cases 9, 11, 7): t.hide for seat:north with no owner,
//      refused to Mallory uniformly; t.roll of a cupped die logged without
//      its value; a validate vetoing peek blocks Bob's Peek with its notice.
//  10  Mallory moved off South: the reduced forms again (overrides are per
//      message, never sticky); the whole scan over every body she got.
// Screenshots: shots/p5v-*.png.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section, logHas } = h;
const M = require('./p4m-lib');
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const { openBoxes, closeBoxes, upload, asked, reply, settle } = require('./p4-lib');
const V = require('./p5v-lib');
const { boxFromDef } = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

const J = JSON.stringify;
const MAL = V.MAL;
const RECT = (w, ht) => [[0, 0], [w, 0], [w, ht], [0, ht]];
const hex = (p, k) => `${p}${k.toString(16).padStart(4, '0')}`;
/** The items' ids (8 hex digits, kept by an export and an import). */
const ID = {
  rackS: hex('e5a0', 1), rackN: hex('e5a0', 2), scr: hex('e5a0', 3), amber: hex('e5a0', 4), blue: hex('e5a0', 5),
  a1: hex('e5b0', 1), a2: hex('e5b0', 2), a3: hex('e5b0', 3), s1: hex('e5b0', 4), s2: hex('e5b0', 5), b1: hex('e5b0', 6),
  g1: hex('e5c0', 1), g2: hex('e5c0', 2), coin: hex('e5c0', 3), ft: hex('e5c0', 4), au: hex('e5c0', 5), nu: hex('e5c0', 6), ao: hex('e5c0', 7),
};
/** Six die faces whose labels are the token `p` and 1–6 (≤ 8 chars), each with its own text. */
const dieFaces = (p) => [1, 2, 3, 4, 5, 6].map((k) => ({ label: `${p}${k}`, text: `${p}-pip-${k}` }));
/** Six tile faces of pips, each named with token `p` (its log name). */
const tileFaces = (p, color) => [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]].map(([a, b]) => ({ pips: [a, b], name: `${p}${a}${b}`, text: `${p}-face-${a}${b}`, color }));
/** "Veil test": original. */
const DEF = {
  name: 'Veil test', table: { shape: 'rect', w: 1400, h: 1000, felt: '#1f3b2d' },
  seats: [{ id: 'south', name: 'South', edge: 'bottom', color: '#f59e0b' }, { id: 'north', name: 'North', edge: 'top', color: '#38bdf8' }, { id: 'east', name: 'East', edge: 'right', color: '#a78bfa' }],
  backs: [{ id: 'cup', color: '#7c2d12', label: '?' }, { id: 'bb', color: '#334155' }, { id: 'ub', color: '#1e3a8a' }],
  pieces: [
    { id: 'rack', kind: 'board', w: 440, h: 140, faces: [{ color: '#8a5a2b' }], zones: [{ id: 'r', poly: RECT(440, 140), owner: 'board', private: 'reveal' }] },
    { id: 'scr', kind: 'board', w: 300, h: 180, faces: [{ color: '#475569' }], zones: [{ id: 's', poly: RECT(300, 180), owner: 'seat:south', private: 'keep' }] },
    { id: 'acup', kind: 'die', back: 'cup', faces: dieFaces('Qa') },
    { id: 'bcup', kind: 'die', back: 'cup', faces: dieFaces('Qb') },
    { id: 'sdie', kind: 'die', back: 'cup', faces: dieFaces('Sd') },
    { id: 'atile', kind: 'tile', w: 60, h: 120, back: 'bb', stack: 'none', hand: false, faces: tileFaces('Qt', '#fef3c7') },
    { id: 'btile', kind: 'tile', w: 60, h: 120, back: 'bb', stack: 'none', hand: false, faces: tileFaces('Bt', '#dbeafe') },
    { id: 'gtile', kind: 'tile', w: 60, h: 120, back: 'bb', stack: 'none', hand: false, faces: [{ label: 'Gt', text: 'a loose tile', color: '#e2e8f0' }] },
    { id: 'ftile', kind: 'tile', w: 60, h: 120, back: 'bb', stack: 'none', hand: false, faces: [{ label: 'Qf9z', text: 'Qf9z-never-shown', color: '#fecaca' }] },
    { id: 'otile', kind: 'tile', w: 60, h: 120, back: 'bb', stack: 'none', hand: false, faces: [{ label: 'Ot', text: 'South owns it', color: '#bbf7d0' }] },
    { id: 'aunit', kind: 'token', shape: 'rect', w: 60, back: 'ub', stack: 'none', faces: [{ label: 'Qu7x', text: 'Qu7x-behind-the-screen', color: '#fde68a' }] },
    { id: 'nunit', kind: 'token', shape: 'rect', w: 60, back: 'ub', stack: 'none', faces: [{ label: 'Nu', text: 'a unit for north', color: '#bfdbfe' }] },
    { id: 'coin', kind: 'token', faces: ['C'] },
  ],
  setup: [
    { piece: 'rack', at: [480, 840], owner: 'seat:south', id: ID.rackS },
    { piece: 'rack', at: [480, 20], rot: 180, owner: 'seat:north', id: ID.rackN },
    { piece: 'scr', at: [40, 780], id: ID.scr },
    { bag: [0, 1, 2, 3, 4, 5].map((f) => ({ t: 'atile', f, up: false })), name: 'Amber', at: [960, 860], id: ID.amber },
    { bag: [0, 1, 2, 3, 4, 5].map((f) => ({ t: 'btile', f, up: false })), name: 'Blue', at: [960, 40], id: ID.blue },
    { piece: 'acup', at: [420, 560], f: 0, id: ID.a1 }, { piece: 'acup', at: [490, 560], f: 1, id: ID.a2 }, { piece: 'acup', at: [560, 560], f: 2, id: ID.a3 },
    { piece: 'sdie', at: [760, 560], id: ID.s1 }, { piece: 'sdie', at: [830, 560], f: 3, id: ID.s2 },
    { piece: 'bcup', at: [1100, 300], id: ID.b1 },
    { piece: 'gtile', at: [1040, 480], id: ID.g1 }, { piece: 'gtile', at: [1120, 480], id: ID.g2 }, { piece: 'coin', at: [1210, 510], id: ID.coin },
    { piece: 'ftile', at: [700, 300], up: false, id: ID.ft },
    { piece: 'aunit', at: [380, 700], id: ID.au },
    { piece: 'nunit', at: [1100, 700], id: ID.nu },
    { piece: 'otile', at: [640, 700], owner: 'seat:south', id: ID.ao },
  ],
};
const BOX = boxFromDef(DEF);
const TYPES = Object.fromEntries(DEF.pieces.map((p) => [p.id, p]));
/** The label (or log name) of face f of type `ty`. */
const faceOf = (ty, f) => { const x = TYPES[ty].faces[f]; return x.label || x.name; };
/** Every token on the faces of types `tys` (labels, names, texts). */
const tokensOf = (...tys) => tys.flatMap((ty) => TYPES[ty].faces.flatMap((x) => [x.label, x.name, x.text].filter(Boolean)));

/** A rules script for section 9 (original): host buttons — veil (t.hide of the north unit for seat:north, no owner), shake (t.roll of a cupped die), nopeek (validate refuses every peek from then on). */
const SCRIPT = `({ name: 'Veil rules',
  buttons: () => [{ id: 'veil', label: 'Veil' }, { id: 'shake', label: 'Shake' }, { id: 'nopeek', label: 'No peeking' }],
  onButton(t, id) {
    if (id === 'veil') t.hide('${ID.nu}', ['seat:north']);
    if (id === 'shake') t.roll('${ID.a1}');
    if (id === 'nopeek') t.data.noPeek = true;
  },
  validate(t, a) { if (a.t === 'peek' && t.data.noPeek) return 'This table forbids peeking'; },
})`;

const UPTO = +(process.env.UPTO || 99); // (to develop: stop after section UPTO)

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-veil-'));
  let bob = await M.join(env, 'Bob', env.url);
  const alice = await M.join(env, 'Alice', bob.url(), { ctx: P.PHONE });
  const Mal = await V.spy(env, bob.url());
  await Mal.hello(0);
  const BOB = bob.pid, ALICE = alice.pid;
  const S = () => bob.evaluate(() => window.__ct.hostState());
  const act = (a) => bob.evaluate((x) => window.__ct.act(x), a);
  const done = () => bob.waitForFunction(() => window.__ct.jobs() === 0, null, { timeout: 15000 });
  /** Waits until page p's view of item `id` satisfies `pred` (an expression over `it`); false after 15 s. */
  const until = (p, id, pred, ms = 15000) => P.waitView(p, `(it => !!it && (${pred}))(v.items[a])`, id, ms);
  /** Presses item `id` on page p: a tap on the phone, a click on the desktop (Shift held: picks it into a group). */
  const touch = async (p, id, shift = false) => { const c = await M.centre(p, id); if (p.touch) await M.tap(p, c); else await M.click(p, c, shift); };
  /** Clears page p's selection: Esc (the same keydown on the phone, which has no key). */
  const deselect = (p) => (p.touch ? p.evaluate(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))) : p.keyboard.press('Escape'));
  /** Selects item `id` alone on page p and returns its bar's buttons (once the bar shows). */
  const barOn = async (p, id) => {
    await deselect(p);
    await touch(p, id);
    await M.until(async () => (await M.bar(p)).on, 4000, 50);
    return (await M.bar(p)).btns;
  };
  /** The box id the table's pieces come from now, and every type ref of `tys` in it and in the boxes before. */
  const boxIds = new Set();
  const refsOf = async (...tys) => { const s = await S(); if (s.lastSetup) boxIds.add(s.lastSetup); return [...boxIds].flatMap((b) => tys.map((ty) => `${b}/${ty}`)); };
  /** Mallory's bodies from index `from` (to `to`). */
  const bodies = async (from = 0, to) => (await Mal.bodies()).slice(from, to);
  /** The scan of bodies `list` for tokens and for the records of `ids`: [{what, at}] for every finding. */
  const leaks = (list, tokens, ids) => [...V.scan(list, tokens).map(([at, tok]) => ({ what: tok, at })), ...V.told(list, ids).map((x) => ({ what: `record of ${x.id}`, at: `${x.where} of body ${x.k}: ${J(x.f)}` }))];
  const say = (ls) => J(ls.slice(0, 3));

  section('0 the room: Bob hosts (desktop), Alice (iPhone 13) sits south, Mallory (raw) east; «Veil test» set up');
  ok((await act({ t: 'loadBox', box: BOX, setup: true, clear: true })).ok, 'the host lays out the test box');
  await done();
  for (const a of [{ p: MAL, watch: true }, { p: ALICE, watch: true }, { p: BOB, watch: true }, { p: ALICE, id: 'south' }, { p: BOB, id: 'north' }, { p: MAL, id: 'east' }]) await act({ t: 'seat', ...a });
  await done();
  let st = await S();
  ok(st.players[ALICE].seatId === 'south' && st.players[BOB].seatId === 'north' && st.players[MAL]?.seatId === 'east', `seated: Alice south, Bob north, Mallory east (${J(Object.values(st.players).map((pl) => [pl.name, pl.seatId ?? null]))})`);
  ok(await P.waitView(alice, 'a.every((i) => !!v.items[i]) && v.players[me]?.seatId === "south"', Object.values(ID)), "Alice's phone shows the whole table, Alice south");
  await refsOf();
  for (const p of [alice, bob]) await V.watchTumbles(p);
  await M.shot(alice, 'p5v-0-phone');
  await M.shot(bob, 'p5v-0-desk');

  section("1 Alice's cup (case 1): 🙈 Hide on her phone — the badge, the corner and the tooltip are hers alone");
  let btns = await barOn(alice, ID.a1);
  ok(btns.includes('🙈 Hide') && btns.includes('🎲 Roll') && !btns.includes('Peek') && !btns.includes('Reveal'), `a shown die's bar on the phone: 🙈 Hide and 🎲 Roll, no Peek, no Reveal (${J(btns)})`);
  const cupAt = await Mal.count();
  await M.barPress(alice, '🙈 Hide');
  ok(await until(bob, ID.a1, "'b' in it && !('t' in it)") && await until(bob, ID.a3, "'b' in it && !('t' in it)"), "Bob's screen gets the cup's back for the dice (§5d: no t, no f)");
  st = await S();
  ok([ID.a1, ID.a2, ID.a3].every((d) => st.items[d].up === false && J(st.items[d].vis) === J([ALICE]) && st.items[d].owner === ALICE && st.items[d].po === 1),
    `the host: the handful under the cup — up false, vis [Alice's id], hers through po (§5c hide, D264) (${J([ID.a1, ID.a2, ID.a3].map((d) => st.items[d]))})`);
  ok(st.items[ID.s1].up !== false && !st.items[ID.s1].vis, 'the dice apart (another handful) stay shown');
  ok(await logHas(bob, 'Alice hid 3 pieces').then(() => true, () => false), '"Alice hid 3 pieces" in the log (§5c)');
  for (const d of [ID.a1, ID.a2, ID.a3]) {
    const [a, b] = [await V.drawn(alice, d), await V.drawn(bob, d)], f = st.items[d].f;
    ok(a?.badge && a.veiled && /only you can see/i.test(a.title) && a.text.includes(faceOf('acup', f)), `Alice's phone: ${d} shows its face ${faceOf('acup', f)}, 🙈, the hatched corner, "${a?.title}" (§5g)`);
    ok(b && !b.badge && !b.veiled && !b.title && !/Qa/.test(b.text), `Bob's screen: ${d} the cup's back alone, no 🙈 (${J(b)})`);
  }
  btns = await barOn(alice, ID.a1);
  ok(btns.includes('Reveal') && btns.includes('🎲 Roll') && !btns.includes('Peek') && !btns.includes('🙈 Hide'), `her cupped die's bar: Reveal and 🎲 Roll — no Peek: she sees it (§5g) (${J(btns)})`);
  btns = await barOn(bob, ID.a1);
  ok(btns.includes('Peek') && !btns.some((b) => ['Reveal', 'Flip', '🙈 Hide', '🎲 Roll'].includes(b)), `Bob's bar on Alice's cupped die: Peek, and no Reveal, 🙈 Hide or 🎲 Roll — hidden from him, not his to handle (the host's own lock and owner buttons aside) (${J(btns)})`);
  await deselect(bob);
  await M.shot(alice, 'p5v-1-cup-phone');

  section('1′ 🎲 Roll under the cup, twice: Bob\'s screen tumbles the backs, Alice\'s shows the new faces; the line says no value');
  for (let k = 1; k <= 2; k++) {
    await bob.evaluate(() => { window.__tumbles.length = 0; });
    await barOn(alice, ID.a1);
    await M.barPress(alice, '🎲 Roll');
    // (the second roll's line is the first's word for word: the log keeps one of two such lines in a row)
    ok(await M.until(async () => (await M.lines(bob, ALICE)).at(-1) === 'rolled 3 hidden dice', 10000, 100), `roll ${k}: "Alice rolled 3 hidden dice" (§5c: no value) (${J((await M.lines(bob, ALICE)).slice(-2))})`);
    ok(await M.until(() => bob.evaluate((ids) => ids.every((i) => window.__tumbles.includes(i)), [ID.a1, ID.a2, ID.a3]), 5000, 100), `roll ${k}: Bob's screen tumbles the three backs (§5g) (${J(await bob.evaluate(() => window.__tumbles))})`);
    st = await S();
    const want = [ID.a1, ID.a2, ID.a3].map((d) => st.items[d].f);
    ok(await M.until(async () => { const v = await M.items(alice); return J([ID.a1, ID.a2, ID.a3].map((d) => v[d]?.f)) === J(want); }, 8000, 100)
      && (await Promise.all([ID.a1, ID.a2, ID.a3].map((d, j) => V.drawn(alice, d).then((x) => x.badge && x.text.includes(faceOf('acup', want[j])))))).every(Boolean),
    `roll ${k}: Alice's screen shows the faces the host rolled, under 🙈 (${want.map((f) => faceOf('acup', f))})`);
    const bv = await M.items(bob);
    ok([ID.a1, ID.a2, ID.a3].every((d) => !('f' in bv[d]) && !('t' in bv[d])), `roll ${k}: Bob's view holds no face of them`);
  }
  await deselect(alice);
  if (UPTO < 2) { await env.done(); return; }
  section("2 Bob's cup on the desktop (item 3): cupped, rolled under the cup, revealed — the face on both screens");
  btns = await barOn(bob, ID.b1);
  ok(btns.includes('🙈 Hide') && btns.includes('🎲 Roll'), `his shown die's bar: 🙈 Hide, 🎲 Roll (${J(btns)})`);
  const cupB = await Mal.count();
  await M.barPress(bob, '🙈 Hide');
  ok(await until(alice, ID.b1, "'b' in it && !('t' in it)"), "Alice's phone gets the cup's back");
  st = await S();
  ok(st.items[ID.b1].up === false && J(st.items[ID.b1].vis) === J([BOB]) && st.items[ID.b1].owner === BOB && st.items[ID.b1].po === 1, `the host: vis [Bob's id], his through po (${J(st.items[ID.b1])})`);
  let [db, da] = [await V.drawn(bob, ID.b1), await V.drawn(alice, ID.b1)];
  ok(db?.badge && db.veiled && /only you can see/i.test(db.title) && db.text.includes(faceOf('bcup', st.items[ID.b1].f)), `Bob's screen: its face, 🙈, the corner, "${db?.title}"`);
  ok(da && !da.badge && !da.veiled && !da.title && !/Qb/.test(da.text), `Alice's phone: the back alone, no 🙈 (${J(da)})`);
  btns = await barOn(alice, ID.b1);
  ok(J(btns) === J(['Peek']), `Alice's bar on Bob's cupped die: Peek alone — hidden from her, his to handle (§5g) (${J(btns)})`);
  await deselect(alice);
  await alice.evaluate(() => { window.__tumbles.length = 0; });
  let t0 = Date.now();
  const rollB = await Mal.count();
  await barOn(bob, ID.b1);
  await M.barPress(bob, '🎲 Roll');
  ok(await M.until(async () => (await M.lines(alice, BOB, t0)).includes('rolled a hidden die'), 10000, 100), `"Bob rolled a hidden die" (${J(await M.lines(alice, BOB, t0))})`);
  ok(await M.until(() => alice.evaluate((i) => window.__tumbles.includes(i), ID.b1), 5000, 100), "Alice's phone tumbles the cup's back");
  st = await S();
  const fB = st.items[ID.b1].f;
  ok(await until(bob, ID.b1, `it.f === ${fB}`), "Bob's screen shows the face the host rolled");
  ok(!/Qb/.test(await V.screenText(alice, ['table'])) && !(await M.lines(alice, BOB, t0)).some((l) => /Qb/.test(l)), "Alice's screen shows no face of it: not on the table, not in a line since the roll");
  btns = await barOn(bob, ID.b1);
  ok(btns.includes('Reveal') && !btns.includes('Peek') && !btns.includes('🙈 Hide'), `his cupped die's bar: Reveal (${J(btns)})`);
  const revB = await Mal.count();
  await M.barPress(bob, 'Reveal');
  ok(await until(alice, ID.b1, `'t' in it && it.f === ${fB} && it.up !== false`), `Reveal: Alice's phone shows the face the host holds (${faceOf('bcup', fB)})`);
  [db, da] = [await V.drawn(bob, ID.b1), await V.drawn(alice, ID.b1)];
  ok(da?.text.includes(faceOf('bcup', fB)) && db?.text.includes(faceOf('bcup', fB)) && !db.badge && !da.badge, 'both screens draw that face, with no 🙈 (it is public now)');
  st = await S();
  ok(!st.items[ID.b1].vis && !st.items[ID.b1].owner && !st.items[ID.b1].po && st.items[ID.b1].up !== false, `the host: vis, po and the owner po gave are gone (§5c flip) (${J(st.items[ID.b1])})`);
  ok(await M.until(async () => (await M.lines(alice, BOB)).at(-1) === `turned over ${faceOf('bcup', fB)}`, 8000, 100), `"Bob turned over ${faceOf('bcup', fB)}": its label once public (§5c) (${J((await M.lines(alice, BOB)).slice(-1))})`);
  await deselect(bob);
  // (the hide's own line may name the face it showed a moment before, public then: the values are scanned from the roll on)
  const lB = [...leaks(await bodies(cupB, revB), [], [ID.b1]), ...leaks(await bodies(rollB, revB), [...tokensOf('bcup'), ...(await refsOf('bcup'))], [])];
  ok(!lB.length, `Mallory, while Bob's die was cupped: its records reduced, no value or type ref of it once rolled (${revB - cupB} bodies) ${say(lB)}`);
  if (UPTO < 3) { await env.done(); return; }

  section('3 the phone held sideways: a group roll of two cupped and two shown dice says the shown values alone (case 11); a group 🙈 Hide; Reveal');
  await alice.setViewportSize({ width: 844, height: 390 });
  await h.sleep(700);
  for (const d of [ID.a1, ID.a2, ID.a3]) ok((await V.drawn(alice, d))?.badge, `sideways, ${d} still shows 🙈`);
  await deselect(alice);
  await alice.locator('#sel-mode').tap();
  for (const d of [ID.a1, ID.a2, ID.s1, ID.s2]) await touch(alice, d);
  ok(J(await M.selected(alice)) === J([ID.a1, ID.a2, ID.s1, ID.s2].sort()), `⬚ and four taps pick two cupped dice and two shown ones (${J(await M.selected(alice))})`);
  let gb = (await M.bar(alice)).btns;
  ok(gb.includes('🎲 Roll'), `the group bar offers 🎲 Roll (${J(gb)})`);
  t0 = Date.now();
  await M.barPress(alice, '🎲 Roll');
  ok(await M.until(async () => (await M.lines(bob, ALICE, t0)).some((l) => l.startsWith('rolled 4 dice')), 10000, 100), 'the group roll is logged');
  st = await S();
  const line = (await M.lines(bob, ALICE, t0)).find((l) => l.startsWith('rolled 4 dice'));
  const shownVals = [ID.s1, ID.s2].sort().map((d) => faceOf('sdie', st.items[d].f));
  ok(line === `rolled 4 dice (2 hidden): ${shownVals.join(' · ')}`, `"${line}": the shown dice's values in id order, nothing of the cupped ones (§5c, §5j case 11; want "rolled 4 dice (2 hidden): ${shownVals.join(' · ')}")`);
  ok(!/Qa/.test(line), 'no cupped value in the line');
  await alice.locator('#sel-mode').tap();
  await deselect(alice);
  await alice.locator('#sel-mode').tap();
  for (const d of [ID.s1, ID.s2]) await touch(alice, d);
  gb = (await M.bar(alice)).btns;
  ok(gb.includes('🙈 Hide'), `two shown dice picked: the group bar offers 🙈 Hide — the cup (§5g) (${J(gb)})`);
  await M.barPress(alice, '🙈 Hide');
  ok(await until(bob, ID.s2, "'b' in it") && await until(bob, ID.s1, "'b' in it"), "group 🙈 Hide: both dice cupped — Bob's screen the backs");
  st = await S();
  ok([ID.s1, ID.s2].every((d) => J(st.items[d].vis) === J([ALICE]) && st.items[d].owner === ALICE && st.items[d].po === 1), `the host: Alice's alone, hers through po (${J([ID.s1, ID.s2].map((d) => st.items[d]))})`);
  ok(await M.until(async () => (await M.lines(bob, ALICE)).at(-1) === 'hid 2 pieces', 8000, 100), `"Alice hid 2 pieces" (§5c group) (${J((await M.lines(bob, ALICE)).slice(-1))})`);
  await alice.locator('#sel-mode').tap();
  await deselect(alice);
  btns = await barOn(alice, ID.s1);
  const inView = await alice.evaluate(() => [...document.querySelectorAll('#action-bar button')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight; }));
  ok(btns.includes('Reveal') && inView, `sideways, her cupped die's bar offers Reveal, every button on the screen (${J(btns)})`);
  await M.barPress(alice, 'Reveal');
  st = await S();
  ok(await until(bob, ID.s1, `'t' in it && it.f === ${st.items[ID.s1].f}`), "Reveal from the phone's bar: Bob's screen shows its face");
  await deselect(alice);
  await M.shot(alice, 'p5v-3-sideways');
  await alice.setViewportSize({ width: P.PHONE.viewport.width, height: P.PHONE.viewport.height });
  await h.sleep(700);
  // Bob's group 🙈 Hide by Shift+click: two loose tiles and the coin (no back)
  const ghAt = await Mal.count();
  for (const id of [ID.g1, ID.g2, ID.coin]) await touch(bob, id, true);
  ok(J(await M.selected(bob)) === J([ID.g1, ID.g2, ID.coin].sort()), 'Bob picks two tiles and the coin by Shift+click');
  gb = (await M.bar(bob)).btns;
  ok(gb.includes('🙈 Hide'), `the group bar offers 🙈 Hide (${J(gb)})`);
  t0 = Date.now();
  await M.barPress(bob, '🙈 Hide');
  ok(await until(alice, ID.g2, "'b' in it") && await until(alice, ID.g1, "'b' in it"), "group 🙈 Hide: the two tiles' backs on Alice's phone");
  st = await S();
  ok([ID.g1, ID.g2].every((d) => J(st.items[d].vis) === J([BOB])) && st.items[ID.coin].up !== false && !st.items[ID.coin].vis, 'the tiles Bob\'s alone; the coin untouched');
  ok(await M.until(async () => (await M.lines(alice, BOB)).at(-1) === 'hid 2 pieces', 8000, 100) && !(await M.notes(bob, t0)).some((m) => /skipped/.test(m)), `"Bob hid 2 pieces", no "skipped" notice: the coin was never sent (D264) (${J(await M.notes(bob, t0))})`);
  for (const d of [ID.g1, ID.g2]) ok((await V.drawn(bob, d))?.badge && !(await V.drawn(alice, d))?.badge, `${d}: 🙈 on Bob's screen alone`);
  await bob.keyboard.press('Escape');
  if (UPTO < 4) { await env.done(); return; }

  section('4 racks and a screen (case 2): 🔒 Draw to my rack on both screens; a tile off a rack is face up; a unit behind a screen and out again; Bob\'s Peek');
  /** The 🔒/🔓 labels page p draws on board `id`, and its hatch's colour (D265). */
  const zoneOf = (p, id) => p.evaluate((i) => {
    const el = document.querySelector(`#table .item[data-id="${i}"]`);
    return el && { texts: [...el.querySelectorAll('.btexts .btext')].map((t) => t.textContent).filter((t) => /^[🔒🔓]/u.test(t)), hatch: el.querySelector('svg pattern rect')?.getAttribute('fill') || null };
  }, id);
  const zA = await zoneOf(alice, ID.rackS), zB = await zoneOf(bob, ID.rackS), zN = await zoneOf(alice, ID.rackN), zS = await zoneOf(bob, ID.scr);
  ok(J(zB.texts) === J(["🔒 Alice's rack"]) && J(zN.texts) === J(["🔒 Bob's rack"]) && J(zS.texts) === J(["🔒 Alice's screen"]), `"🔒 {name}'s rack" on the other's screen (§5g; D265's "screen" for 'keep'): ${J([zB.texts, zN.texts, zS.texts])}`);
  ok(J(zA.texts) === J(['🔒 Your rack']), `"🔒 Your rack" on its owner's (D265): ${J(zA.texts)}`);
  ok(zA.hatch === '#f59e0b' && zB.hatch === '#f59e0b' && zN.hatch === '#38bdf8', `hatched in the owner's colour: South's amber, North's blue (${zA.hatch}, ${zN.hatch})`);
  const inRack = (s, r) => Object.keys(s.items).filter((k) => s.items[k].k === 'g' && s.items[k].pv && s.items[k].x >= s.items[r].x - 1 && s.items[k].x + 60 <= s.items[r].x + 441 && s.items[k].y >= s.items[r].y - 1 && s.items[k].y + 120 <= s.items[r].y + 141).sort();
  for (const [p, bag, rack, n] of [[alice, ID.amber, ID.rackS, 'Alice'], [bob, ID.blue, ID.rackN, 'Bob']]) {
    for (let k = 1; k <= 2; k++) {
      btns = await barOn(p, bag);
      const b = btns.find((x) => /Draw to my rack/.test(x));
      if (k === 1) ok(!!b, `${n}: the bag's bar offers "Draw to my rack" (§5g) (${J(btns)})`);
      if (!b) break;
      await M.barPress(p, b);
      ok(await M.until(async () => inRack(await S(), rack).length === k, 8000, 100), `${n}: tile ${k} lands in a slot of the rack`);
      await deselect(p);
    }
  }
  st = await S();
  const AT = inRack(st, ID.rackS), BT = inRack(st, ID.rackN);
  ok(AT.length === 2 && AT.every((k) => st.items[k].t.endsWith('/atile') && st.items[k].up === false && J(st.items[k].vis) === J(['seat:south']) && st.items[k].owner === 'seat:south' && st.items[k].po === 1),
    `Alice's two: up false, vis [seat:south], pv, owned by the seat through po (§5a) (${J(AT.map((k) => st.items[k]))})`);
  ok(BT.length === 2 && BT.every((k) => J(st.items[k].vis) === J(['seat:north'])), "Bob's two: vis [seat:north]");
  ok(AT.length === 2 && Math.abs(st.items[AT[0]].x - st.items[AT[1]].x) >= 60, `each in a free slot of its own (x ${AT.map((k) => st.items[k].x)})`);
  for (const k of AT) {
    const [a, b] = [await V.drawn(alice, k), await V.drawn(bob, k)];
    ok(a?.badge && a.text.includes(TYPES.atile.faces[st.items[k].f].text) && b && !b.badge && !/Qt/.test(b.text), `${k}: its face and 🙈 on Alice's phone, the back on Bob's screen`);
  }
  ok(!(await M.lines(bob, ALICE)).some((l) => /Qt/.test(l)) && (await M.lines(bob, ALICE)).at(-1) === 'drew a piece from the bag Amber', `the log names no tile: "${(await M.lines(bob, ALICE)).at(-1)}" (D257)`);
  await M.shot(alice, 'p5v-4-rack-phone');
  // Bob drags one of his tiles off his rack: a rack reveals (§5a 'reveal')
  const out = BT[0];
  await P3.gesture(bob, P3.steps(await M.centre(bob, out), await M.pt(bob, 760, 420), 12));
  ok(await until(alice, out, "'t' in it && it.up !== false"), "Bob's tile set down off his rack: face up on Alice's phone");
  st = await S();
  ok(!st.items[out].vis && !st.items[out].pv && !st.items[out].owner && !st.items[out].po, `its vis, pv, po and the owner po gave are gone (${J(st.items[out])})`);
  // Alice's unit behind her screen, then out again: a screen keeps it hidden (§5a 'keep')
  const auAt = await Mal.count();
  await M.fingerDrag(alice, P3.steps(await M.centre(alice, ID.au), await M.pt(alice, 190, 870), 10));
  ok(await until(bob, ID.au, "'b' in it && !('t' in it)"), "Alice's unit behind her screen: its back on Bob's screen");
  const auIn = await Mal.count(); // (its face was public until then: its name is scanned for from now on)
  st = await S();
  ok(st.items[ID.au].up === false && J(st.items[ID.au].vis) === J(['seat:south']) && st.items[ID.au].pv === 1 && st.items[ID.au].owner === 'seat:south' && st.items[ID.au].po === 1, `the host: hidden for seat:south, pv, owned through po (${J(st.items[ID.au])})`);
  ok((await V.drawn(alice, ID.au))?.badge, "its face and 🙈 on Alice's phone");
  await M.fingerDrag(alice, P3.steps(await M.centre(alice, ID.au), await M.pt(alice, 400, 690), 10));
  ok(await M.until(async () => !(await S()).items[ID.au].pv, 8000, 100), 'moved out of the screen (pv gone)');
  st = await S();
  ok(st.items[ID.au].up === false && J(st.items[ID.au].vis) === J(['seat:south']) && st.items[ID.au].owner === 'seat:south', `…it stays hidden, with its vis and owner (§5a 'keep') (${J(st.items[ID.au])})`);
  ok((await V.drawn(alice, ID.au))?.badge && !('t' in (await M.items(bob))[ID.au]), "Alice's phone still shows its face with 🙈; Bob's view its back");
  // Bob's Peek at one of Alice's rack tiles: his alone, on the record
  const pk = AT[0];
  btns = await barOn(bob, pk);
  ok(btns.includes('Peek') && !btns.includes('Reveal'), `Bob's bar on Alice's rack tile: Peek, no Reveal (${J(btns)})`);
  t0 = Date.now();
  await M.barPress(bob, 'Peek');
  ok(await M.until(() => bob.evaluate(() => !document.getElementById('peek').classList.contains('hidden')), 8000, 100), "Bob's screen opens the peek overlay");
  const peekView = await bob.evaluate(() => ({ cap: document.getElementById('peek-cap').textContent, inner: document.getElementById('peek-inner').innerText }));
  ok(peekView.cap.startsWith('Only you can see this — everyone knows you peeked'), `captioned "${peekView.cap}" (§5g)`);
  ok(peekView.inner.includes(TYPES.atile.faces[st.items[pk].f].text), `it shows the tile's face (${J(peekView.inner)})`);
  ok(await M.until(async () => (await M.lines(alice, BOB, t0)).includes('peeked at a hidden piece'), 8000, 100), '"Bob peeked at a hidden piece" on Alice\'s phone (§5c)');
  const pl = (await alice.evaluate(() => window.__ct.log())).filter((e) => e.txt === 'peeked at a hidden piece').at(-1);
  ok(pl?.k === 1, `…a loud line (k: 1) (${J(pl)})`);
  ok(!('t' in (await M.items(bob))[pk]), "Bob's view still holds the back: the face was his overlay's alone");
  await bob.evaluate(() => document.getElementById('peek').click());
  await deselect(bob);
  await M.shot(bob, 'p5v-4-desk');
  // Alice's Peek on the phone at one of Bob's hidden tiles
  btns = await barOn(alice, ID.g1);
  ok(btns.includes('Peek') && !btns.includes('Reveal'), `Alice's bar on Bob's hidden tile: Peek (${J(btns)})`);
  t0 = Date.now();
  await M.barPress(alice, 'Peek');
  ok(await M.until(() => alice.evaluate(() => !document.getElementById('peek').classList.contains('hidden')), 8000, 100), "Alice's phone opens the peek overlay");
  const capA = await alice.evaluate(() => ({ cap: document.getElementById('peek-cap').textContent, inner: document.getElementById('peek-inner').innerText }));
  ok(capA.cap.startsWith('Only you can see this — everyone knows you peeked') && capA.inner.includes('Gt'), `on the phone too: "${capA.cap}", the tile's face (${J(capA.inner)})`);
  ok(await M.until(async () => (await M.lines(bob, ALICE, t0)).includes('peeked at a hidden piece'), 8000, 100), '"Alice peeked at a hidden piece" on Bob\'s screen');
  await M.shot(alice, 'p5v-4-peek-phone');
  await M.tap(alice, await alice.evaluate(() => { const r = document.getElementById('peek-cap').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
  ok(await M.until(() => alice.evaluate(() => document.getElementById('peek').classList.contains('hidden')), 5000, 100), 'a tap closes it');
  await deselect(alice);
  // the face-down tile, hidden from everyone (no vis): not private — anyone who may handle it may turn it over (§5c), and peek
  btns = await barOn(bob, ID.ft);
  ok(btns.includes('Reveal') && btns.includes('Peek'), `Bob's bar on the face-down tile nobody sees: Reveal and Peek (§5g) (${J(btns)})`);
  await deselect(bob);
  if (UPTO < 5) { await env.done(); return; }

  section("5 Mallory's tries: Alice's rack tile (case 4), hides (case 5), forged fields (case 6), Alice's cupped dice (case 8)");
  let before = await S();
  let said = await Mal.tries([{ t: 'move', id: pk, x: 40, y: 40 }, { t: 'flip', id: pk }]);
  st = await S();
  ok(said.length === 2 && said.every((m) => m.startsWith('🚫')) && J(st.items[pk]) === J(before.items[pk]), `case 4: her move and flip of Alice's rack tile refused, the tile as it was (${J(said)})`);
  ok(said[1] === '🚫 That piece is hidden', `…the flip with the uniform "🚫 That piece is hidden" (§5c) (${J(said[1])})`);
  const peeksBefore = (await Mal.notes()).filter((n) => n.peek).length;
  t0 = Date.now();
  await Mal.act({ t: 'peek', id: pk });
  ok(await M.until(async () => (await Mal.notes()).filter((n) => n.peek).length === peeksBefore + 1, 10000, 100), 'case 4: her peek is answered');
  const mp = (await Mal.notes()).filter((n) => n.peek).at(-1);
  ok(mp.to === MAL && mp.peek.t === st.items[pk].t && mp.peek.f === st.items[pk].f, `…to her alone, {t, f} (§5b) (${J(mp)})`);
  ok(await M.until(async () => (await M.lines(alice, MAL, t0)).includes('peeked at a hidden piece') && (await M.lines(bob, MAL, t0)).includes('peeked at a hidden piece'), 8000, 100), '…and logged loudly on both screens: "Mallory peeked at a hidden piece"');
  ok(await alice.evaluate(() => document.getElementById('peek').classList.contains('hidden')) && await bob.evaluate(() => document.getElementById('peek').classList.contains('hidden')), "…no overlay on anyone else's screen");
  before = await S();
  said = await Mal.tries([{ t: 'hide', ids: [ID.a1] }, { t: 'hide', ids: [ID.ao] }, { t: 'hide', ids: [ID.coin] }, { t: 'hide', ids: [pk] }]);
  st = await S();
  ok(said.length === 4 && said.every((m) => m.startsWith('🚫')), `case 5: her hides of Alice's cupped die, South's tile, the coin and the rack tile are refused (${J(said)})`);
  ok(said[2] === '🚫 That piece has no hidden side', `…the coin, which has no back: "${said[2]}"`);
  ok([ID.a1, ID.ao, ID.coin, pk].every((k) => J(st.items[k]) === J(before.items[k])), '…every piece as it was (no vis of hers anywhere)');
  const ftBefore = st.items[ID.ft];
  await Mal.act({ t: 'move', id: ID.ft, x: 760, y: 330, vis: [MAL], up: true, pv: 1, po: 1, owner: MAL });
  await Mal.act({ t: 'move', id: ID.nu, x: 1110, y: 720, vis: [MAL], up: false, pv: 1 });
  ok(await M.until(async () => (await S()).items[ID.nu].x === 1110, 8000, 100), 'case 6: her moves are taken…');
  st = await S();
  ok(st.items[ID.ft].x === 760 && st.items[ID.ft].up === false && !st.items[ID.ft].vis && !st.items[ID.ft].owner && !st.items[ID.ft].pv && !st.items[ID.ft].po && st.items[ID.ft].f === ftBefore.f, `…the face-down tile moved, still hidden from everyone: vis, up, pv, po and owner ignored (${J(st.items[ID.ft])})`);
  ok(st.items[ID.nu].up !== false && !st.items[ID.nu].vis && !st.items[ID.nu].pv, `…the shown unit moved, still shown, no vis (${J(st.items[ID.nu])})`);
  before = await S();
  const cupFields = (s) => J([ID.a1, ID.a2, ID.a3].map((d) => s.items[d]));
  said = await Mal.tries([{ t: 'flip', id: ID.a1 }, { t: 'roll', ids: [ID.a2] }, { t: 'face', id: ID.a3, f: 5 }, { t: 'move', id: ID.a1, x: 900, y: 900 }, { t: 'owner', id: ID.a2, to: MAL }]);
  ok(J(said.slice(0, 3)) === J(['🚫 That piece is hidden', '🚫 That piece is hidden', '🚫 That piece is hidden']) && said.length === 5 && said.slice(3).every((m) => m.startsWith('🚫')),
    `case 8: flip, roll and face of Alice's cupped dice refused with the uniform "🚫 That piece is hidden"; the move and the claim refused too (${J(said)})`);
  st = await S();
  ok(cupFields(st) === cupFields(before), 'case 8: the host state — the dice, their values, their owner and vis — unchanged');
  // the same words whatever the hidden piece is: a die, a tile (no die), a unit — nothing tells them apart (§2c)
  said = await Mal.tries([{ t: 'roll', ids: [pk] }, { t: 'face', id: pk, f: 0 }, { t: 'roll', ids: [ID.au] }, { t: 'face', id: ID.g1, f: 0 }]);
  ok(J(said) === J(Array(4).fill('🚫 That piece is hidden')), `a roll or a face of a hidden tile or unit: the very same words (${J(said)})`);
  if (UPTO < 6) { await env.done(); return; }

  section('6 a seat change, a host reload and a demotion: Alice\'s faces stay hers; Mallory gets nothing');
  // Bob stands up and sits again: north's rack tile is his only while he sits north (§5j: the byVis touch)
  const nb = BT.find((k) => k !== out);
  await act({ t: 'seat', p: BOB, watch: true });
  ok(await until(bob, nb, "'b' in it && !('t' in it)"), "Bob stands up: his screen gets north's rack tile's back");
  await act({ t: 'seat', p: BOB, id: 'north' });
  ok(await until(bob, nb, "'t' in it"), '…and sits north again: its face');
  await act({ t: 'seat', p: MAL, watch: true });
  await act({ t: 'seat', p: MAL, id: 'east' });
  await done();
  // the host reloads
  const rel = await Mal.count();
  const boot0 = await bob.evaluate(() => window.__ct.view().boot);
  await bob.reload();
  ok(await bob.waitForFunction(() => window.__ct?.hostState()?.items && window.__ct.view().seq > 0, null, { timeout: 30000 }).then(() => true, () => false), 'the host reloads and resumes its table');
  const boot1 = await bob.evaluate(() => window.__ct.view().boot);
  ok(await P.waitView(alice, 'v.boot === a', boot1, 30000), `Alice's phone follows the resumed host (boot ${boot0} → ${boot1})`);
  ok(await until(alice, ID.a1, "'t' in it && it.up === false") && await until(alice, AT[1], "'t' in it"), "…her cupped dice and her rack tiles are hers to see again (her own forms, §5b)");
  ok((await V.drawn(alice, ID.a2))?.badge && (await V.drawn(alice, AT[1]))?.badge, '…with 🙈');
  ok(await until(bob, ID.g1, "'t' in it && it.up === false") && (await V.drawn(bob, ID.g2))?.badge, "the resumed host's own screen: Bob's hidden tiles his to see, with 🙈");
  ok(await Mal.hello(rel), 'Mallory, registered again, gets a snapshot addressed to her');
  await V.watchTumbles(bob);
  // a demotion: the invite opened again in the host's browser — one tab hosts, the other becomes a viewer
  const dem = await Mal.count();
  const twin = await bob.context().newPage();
  for (const s of [require('./p1-lib').rtcHook, P3.actTap, require('./p4-lib').watchers]) await twin.addInitScript(s);
  // The second tab's Trystero id starts with "z" (the page's first Math.random() makes its first character, as
  // t-p2-link's idFirst): it sorts last, so a tie of the two tabs' seq goes the same way every run (§1b.4).
  await twin.addInitScript(() => { const A = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz', rnd = Math.random; let n = 0; Math.random = () => (n++ === 0 ? (A.indexOf('z') + 0.5) / A.length : rnd()); });
  await twin.goto(bob.url());
  const ids = await Promise.all([bob, twin].map((p) => p.evaluate(() => import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm').then((m) => m.selfId))));
  console.log(`  (the tabs' Trystero ids: ${ids.join(', ')})`);
  // one tab hosts (it holds the table), the other is a viewer (a demoted tab drops it) that took a snapshot — for 2 s on end
  const role = (p) => p.evaluate(() => (window.__ct?.hostState() ? 'host' : (window.__ct?.view().seq || 0) > 0 ? 'viewer' : 'booting')).catch(() => 'gone');
  let roles = '', since = 0;
  ok(await M.until(async () => {
    const r = `${await role(bob)}/${await role(twin)}`;
    if (r !== roles) [roles, since] = [r, Date.now()];
    return (r === 'host/viewer' || r === 'viewer/host') && Date.now() - since >= 2000;
  }, 30000, 200), `one tab hosts, the other is a viewer (${roles})`);
  const [winner, loser] = roles === 'host/viewer' ? [bob, twin] : [twin, bob];
  console.log(`  (the ${winner === bob ? 'first' : 'second'} tab kept hosting)`);
  await loser.close();
  Object.assign(winner, { pid: BOB, touch: false, label: 'Bob' });
  bob = winner;
  await bob.waitForFunction(() => window.__ct.hostState()?.items, null, { timeout: 15000 });
  const boot2 = await bob.evaluate(() => window.__ct.view().boot);
  const followed = await P.waitView(alice, 'v.boot === a', boot2, 30000) && await until(alice, ID.a3, "'t' in it && it.up === false");
  ok(followed, `after the demotion, Alice's phone follows the host that stayed, her cup hers to see${followed ? '' : ` (host boot ${boot2} seq ${await bob.evaluate(() => window.__ct.view().seq)}; Alice's view boot ${await P.viewOf(alice, 'v.boot')} seq ${await P.viewOf(alice, 'v.seq')}, ${J(await P.viewOf(alice, 'v.items[a]', ID.a3))})`}`);
  ok(await Mal.hello(dem), 'Mallory gets a snapshot addressed to her from the host that stayed');
  await V.watchTumbles(bob);
  const l6 = leaks(await bodies(rel), [...tokensOf('acup', 'atile', 'aunit', 'ftile'), ...(await refsOf('acup', 'atile', 'aunit', 'ftile')), 'pips'], [ID.a1, ID.a2, ID.a3, ...AT, ID.au, ID.ft, ID.s2, ID.g1, ID.g2, nb]);
  ok(!l6.length, `Mallory across the reload and the demotion (${(await Mal.count()) - rel} bodies): nothing hidden from her, in any record ${say(l6)}`);
  if (UPTO < 7) { await env.done(); return; }

  section('7 export and import (📦, §5h): #k for players, no pv; set up again, every private piece as it was');
  const PRIV = [ID.a1, ID.a2, ID.a3, ID.s2, ID.g1, ID.g2, ...AT, nb, ID.au, ID.ft];
  const fields = (s) => Object.fromEntries(PRIV.map((k) => [k, { t: s.items[k]?.t.split('/')[1], f: s.items[k]?.f, up: s.items[k]?.up, vis: s.items[k]?.vis, owner: s.items[k]?.owner, pv: s.items[k]?.pv, po: s.items[k]?.po }]));
  const pre = await S(), want = fields(pre);
  const order = Object.entries(pre.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360)).map(([q]) => q);
  const kOf = (q) => `#${order.indexOf(q) + 1}`;
  await openBoxes(bob);
  if (await bob.isVisible('#box-x-rules') && await bob.isChecked('#box-x-rules')) await bob.click('#box-x-rules');
  const [dl] = await Promise.all([bob.waitForEvent('download', { timeout: 30000 }), bob.click('#box-x-go')]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  await closeBoxes(bob);
  const text = fs.readFileSync(file, 'utf8');
  let gj = null;
  try { gj = JSON.parse(text); } catch (err) { console.error('the export is not JSON', err); }
  ok(!!gj && Array.isArray(gj.setup), `the export is a game.json with a setup (${dl.suggestedFilename()})`);
  const entry = (id) => (gj?.setup || []).flatMap((e) => (e.group ? e.group : [e])).find((e) => e.id === id);
  ok(![ALICE, BOB, MAL].some((q) => text.includes(q)), 'no player id anywhere in it: players travel as #k (§4c, §5h)');
  ok(!/"pv"/.test(text), 'no pv in it: a private zone hides its pieces again on import (§5h)');
  ok([ID.a1, ID.a2, ID.a3].every((d) => { const e = entry(d); return e?.up === false && J(e.vis) === J([kOf(ALICE)]) && e.owner === kOf(ALICE) && e.po === true; }), `Alice's cupped dice: up false, vis ["${kOf(ALICE)}"], owner "${kOf(ALICE)}", po true (${J(entry(ID.a1))})`);
  ok([ID.g1, ID.g2].every((d) => { const e = entry(d); return e?.up === false && J(e.vis) === J([kOf(BOB)]) && e.owner === kOf(BOB) && e.po === true; }), `Bob's hidden tiles: vis ["${kOf(BOB)}"] (${J(entry(ID.g1))})`);
  ok(AT.every((d) => { const e = entry(d); return e && !('up' in e) && !('vis' in e) && !('owner' in e) && !('po' in e); }), `Alice's rack tiles: no up, vis, owner or po — her rack hides them again (${J(entry(AT[0]))})`);
  ok(entry(ID.au)?.up === false && J(entry(ID.au)?.vis) === J(['seat:south']), `the unit that left the screen: up false, vis ["seat:south"] (${J(entry(ID.au))})`);
  const imp = await Mal.count();
  const up = await upload(bob, file, { now: true });
  const q = await asked(bob, 'setup');
  ok(!up.err && !!q, `📦 takes the file and asks to set it up (${J(up.err || q?.title)})`);
  if (q) await reply(bob, 'Set up');
  await settle(bob);
  await done();
  const post = await S();
  ok(post.lastSetup && post.lastSetup !== pre.lastSetup, `a new box set up (${pre.lastSetup} → ${post.lastSetup})`);
  await refsOf();
  const got = fields(post);
  const diff = PRIV.filter((k) => J(got[k]) !== J(want[k]));
  ok(!diff.length, `every private piece set up again with the same type, face, up, vis, owner, pv and po (§5l item 8) ${diff.length ? J(diff.map((k) => [k, want[k], got[k]])) : ''}`);
  ok(await until(alice, ID.a1, "'t' in it && it.up === false") && await until(alice, AT[0], "'t' in it") && (await V.drawn(alice, ID.a3))?.badge && (await V.drawn(alice, AT[1]))?.badge, "Alice's phone: her cup and her rack tiles hers to see, with 🙈");
  ok(await until(bob, ID.g1, "'t' in it && it.up === false") && !('t' in (await M.items(bob))[ID.a1]), "Bob's screen: his tiles his, Alice's cup its back");
  const l7 = leaks(await bodies(imp), [...tokensOf('acup', 'atile', 'aunit', 'ftile'), ...(await refsOf('acup', 'atile', 'aunit', 'ftile')), 'pips'], PRIV);
  ok(!l7.length, `Mallory through the import (${(await Mal.count()) - imp} bodies): nothing hidden from her ${say(l7)}`);
  if (UPTO < 8) { await env.done(); return; }

  section('8 Alice leaves; Mallory takes South (case 3): what South sees is hers now, Alice\'s own cup never');
  await alice.context().close();
  ok(await M.until(async () => (await S()).players[ALICE]?.online === false, 15000, 200), 'the host sees Alice leave (her seat kept)');
  await act({ t: 'seat', p: ALICE, watch: true });
  await done();
  const south = await Mal.count();
  said = await Mal.tries([{ t: 'seat', id: 'south' }], 0);
  ok(await M.until(async () => (await S()).players[MAL]?.seatId === 'south', 10000, 100), `Mallory sits in Alice's former seat (${J(said)})`);
  const seen = async (id) => 't' in ((h.viewFrom(await Mal.bodies()))?.items[id] || {});
  ok(await M.until(async () => (await seen(AT[0])) && (await seen(AT[1])) && (await seen(ID.au)), 10000, 200), "South's rack tiles and the unit that left South's screen (vis seat:south) are hers to see now — by design (§5j case 3)");
  const mv = h.viewFrom(await Mal.bodies());
  ok([ID.a1, ID.a2, ID.a3, ID.s2].every((d) => !('t' in mv.items[d]) && !('f' in mv.items[d])), "Alice's cup (vis: her id) she never sees (§5j case 3)");
  ok(await M.until(async () => J((await zoneOf(bob, ID.rackS)).texts) === J(["🔒 Mallory's rack"]), 8000, 100), `the rack's label follows the seat: "${(await zoneOf(bob, ID.rackS)).texts}"`);
  if (UPTO < 9) { await env.done(); return; }

  section('9 a script (cases 9, 11, 7): t.hide for seat:north with no owner; t.roll of a cupped die; validate vetoes peek');
  await h.enableRules(bob, { code: SCRIPT });
  await done();
  const rbtn = async (id) => { await bob.locator(`#rules-btns button[data-rbtn="${id}"]`).click(); await done(); };
  await rbtn('veil');
  st = await S();
  ok(st.items[ID.nu].up === false && J(st.items[ID.nu].vis) === J(['seat:north']) && !st.items[ID.nu].owner, `t.hide(nu, ['seat:north']): hidden for North, no owner (${J(st.items[ID.nu])})`);
  ok(await until(bob, ID.nu, "'t' in it && it.up === false") && (await V.drawn(bob, ID.nu))?.badge, "Bob (North) sees it, with 🙈");
  said = await Mal.tries([{ t: 'flip', id: ID.nu }, { t: 'roll', ids: [ID.nu] }]);
  ok(J(said) === J(['🚫 That piece is hidden', '🚫 That piece is hidden']), `case 9: Mallory (South) flips and rolls it — refused, uniformly (${J(said)})`);
  ok(J((await S()).items[ID.nu]) === J(st.items[ID.nu]), '…the unit as it was');
  const f1 = (await S()).items[ID.a1].f;
  t0 = Date.now();
  await rbtn('shake');
  ok(await M.until(async () => (await M.lines(bob, 'rules', t0)).includes('rolled a hidden die'), 8000, 100), `case 11: "📜 Rules rolled a hidden die" (${J(await M.lines(bob, 'rules', t0))})`);
  console.log(`  (the cupped die went ${faceOf('acup', f1)} → ${faceOf('acup', (await S()).items[ID.a1].f)})`);
  await rbtn('nopeek');
  btns = await barOn(bob, ID.a2);
  t0 = Date.now();
  await M.barPress(bob, 'Peek');
  ok(await M.until(async () => (await M.notes(bob, t0)).some((m) => m.includes('This table forbids peeking')), 8000, 100), `case 7: Bob's Peek is vetoed with the script's notice (${J(await M.notes(bob, t0))})`);
  await h.sleep(500);
  ok(await bob.evaluate(() => document.getElementById('peek').classList.contains('hidden')) && !(await M.lines(bob, BOB, t0)).includes('peeked at a hidden piece'), '…no overlay, no line');
  const np = (await Mal.notes()).filter((n) => n.peek).length;
  said = await Mal.tries([{ t: 'peek', id: ID.a2 }]);
  ok(said.length === 1 && said[0].includes('This table forbids peeking') && (await Mal.notes()).filter((n) => n.peek).length === np, `…Mallory's too, with no answer (${J(said)})`);
  await deselect(bob);
  if (UPTO < 10) { await env.done(); return; }

  section('10 Mallory off South: the reduced forms again; the whole scan of every body she got');
  const east = await Mal.count();
  await act({ t: 'seat', p: MAL, id: 'east' });
  await done();
  ok(await M.until(async () => { const v = h.viewFrom(await Mal.bodies()); return [...AT, ID.au].every((k) => 'b' in v.items[k] && !('t' in v.items[k])); }, 10000, 200), 'moved to East, she gets South\'s pieces as backs again: an override lasts one message (§5b)');
  await h.sleep(800);
  const all = await Mal.bodies(), notes = await Mal.notes(), others = await Mal.others();
  const refsA = await refsOf('acup'), refsF = await refsOf('ftile'), refsT = await refsOf('atile'), refsU = await refsOf('aunit');
  const scanBody = (from, to, toks, ids) => leaks(all.slice(from, to), toks, ids);
  const fin = [
    ['Alice\'s cupped dice, from the cup on', scanBody(cupAt, undefined, [...tokensOf('acup'), ...refsA], [ID.a1, ID.a2, ID.a3])],
    ['the face-down tile, all along (hidden from everyone)', scanBody(0, undefined, [...tokensOf('ftile'), ...refsF], [ID.ft])],
    ['Alice\'s rack tiles, but while Mallory sat South', [...scanBody(0, south, [...tokensOf('atile'), ...refsT], AT), ...scanBody(east, undefined, [...tokensOf('atile'), ...refsT], AT)]],
    ['the unit behind South\'s screen, from the screen on, but while she sat South', [...scanBody(auAt, south, [], [ID.au]), ...scanBody(auIn, south, [...tokensOf('aunit'), ...refsU], []), ...scanBody(east, undefined, [...tokensOf('aunit'), ...refsU], [ID.au])]],
    ['north\'s rack tile, all along', scanBody(0, undefined, [TYPES.btile.faces[(await S()).items[nb].f].name], [nb])],
    ['Bob\'s two tiles, from his hide on', scanBody(ghAt, undefined, [], [ID.g1, ID.g2])],
    ['the key "pips" in any body', scanBody(0, undefined, ['pips'], [])],
  ];
  for (const [what, l] of fin) ok(!l.length, `the scan of ${all.length} bodies — ${what}: nothing ${say(l)}`);
  const ovr = all.map((b, k) => [k, Object.keys(b.vis || {})]).filter(([k, v]) => v.length && !(k >= south && k < east));
  ok(!ovr.length, `no body she got carries a per-recipient form but while she sat South (§5j case 2: no vis override) ${J(ovr.slice(0, 3))}`);
  const myPeeks = notes.filter((n) => n.peek);
  ok(myPeeks.length === 1 && myPeeks[0].peek.t === mp.peek.t, `her notes carry one peek answer, her own (case 4) (${myPeeks.length})`);
  const ln = leaks(notes.map(({ peek, ...n }) => n), [...tokensOf('acup', 'atile', 'aunit', 'ftile'), ...refsA, ...refsF, ...refsT, ...refsU, 'pips'], []);
  ok(!ln.length, `her ${notes.length} notices (her peek answer aside) name nothing hidden ${say(ln)}`);
  const lo = leaks(others, [...tokensOf('acup', 'atile', 'aunit', 'ftile'), ...refsA, ...refsF, ...refsT, ...refsU], []);
  ok(!lo.length, `her ${others.length} other messages (rules, acts…) name nothing hidden ${say(lo)}`);
  const lines = all.flatMap((b) => b.log || []).map((e) => e.txt);
  ok(!lines.some((l) => /Q[atuf]/.test(l)), 'no log line she got names a hidden piece (§5d)');
  ok(h.viewFrom(all).seq === (await bob.evaluate(() => window.__ct.view().seq)), "her folded view is in step with the host's");
  const dom = await V.screenText(bob);
  const domL = tokensOf('acup', 'aunit', 'ftile').filter((tok) => dom.includes(tok));
  ok(!domL.length, `the host's own screen (table, log, notices, bar) shows no face of Alice's cup, of South's unit or of the face-down tile ${J(domL)}`);
  await M.shot(bob, 'p5v-10-desk');
  await env.done();
})().catch(h.crash);
