// E2E: Phase 5's private material on real screens (spec §5g, §5j, §5l
// t-p5-private): Alice hosts on a desktop (mouse and keys), Bob plays on an
// iPhone 13 (CDP touches; held upright, then sideways), Mallory is a raw peer.
//  1  The cup: 🙈 Hide on a die cups its handful; the 🙈 badge, the hatched
//     corner and the tooltip are Alice's alone; 🎲 Roll under the cup tumbles
//     the backs on Bob's screen, the faces on hers; a group roll of two
//     cupped and two shown dice says the shown values alone (case 11);
//     Mallory's flip, roll, face, move and claim of a cupped die are refused,
//     the first three uniformly (case 8); Reveal from the bar, and from the
//     group bar, shows them to both; H cups from the keyboard.
//  2  Racks: each rack hatched in its owner's colour, "🔒 Your rack" on its
//     owner's screen and "🔒 Alice's rack" on the other's, a rack nobody owns
//     "🔓 Nobody's rack"; a bag's "🔒 Draw to my rack" sets a piece down in the
//     first free slot, hidden there (Alice by mouse, Bob by touch); Bob drags
//     one out: face up for both; a group 🙈 Hide by Shift+click.
//  3  Peeks (case 4 and the overlay): Bob's Peek on Alice's rack tile shows
//     its face to him alone, captioned, logged loudly; Mallory's move and flip
//     of it refused, her peek answered to her alone; her hides of Alice's
//     pieces and of a piece with no back refused (case 5); a move with forged
//     vis and up ignored (case 6).
//  4  Seat refs (case 3): Bob's unit behind north's screen, his cupped die
//     (his id); Bob stands up, Mallory sits north: she gets the unit's full
//     form, not the die; Bob's screen draws the unit's back; the labels name
//     the seat's holder.
//  5  The phone held sideways: a rack tile's bar (Reveal, then 🙈 Hide) in
//     reach of a thumb, its buttons 44 px tall.
//  6  Rules (cases 7, 9, 11): a script's t.hide for seat:north with no
//     owner — Bob sees it, Mallory's flip and roll refused uniformly; t.roll
//     of a cupped die "📜 Rules rolled a hidden die"; a validate that vetoes
//     peek blocks Bob's Peek with its notice.
//  7  The recursive scan of every body Mallory got: no hidden identity, no
//     override but the unit's while she sat north; her view in step.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section, logHas } = h;
const M = require('./p4m-lib');
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const { mallory } = require('./final-lib');
const { boxFromDef, faceLabel, cleanBox } = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

const J = JSON.stringify;
const MAL = 'ffffffffffffffff';
const RECT = (w, ht) => [[0, 0], [w, 0], [w, ht], [0, ht]];
const ID = {
  rackS: 'aaaa0001', rackN: 'aaaa0002', rackX: 'aaaa0003', screen: 'aaaa0004',
  a1: 'bbbb0001', a2: 'bbbb0002', a3: 'bbbb0003', s1: 'bbbb0004', s2: 'bbbb0005', b1: 'bbbb0006',
  u1: 'cccc0001', u2: 'cccc0002', t1: 'cccc0003', t2: 'cccc0004', coin: 'cccc0005', bag: 'cccc0006',
};
/** The test box (original): three racks (south's, north's, nobody's), north's screen ('keep'), bones (domino-like tiles under one back), dice under a cup, units, a coin with no back, a boneyard bag. */
const DEF = {
  name: 'Privy table', table: { shape: 'rect', w: 2400, h: 1600 },
  seats: [{ id: 'south', name: 'South', edge: 'bottom', color: '#f59e0b' }, { id: 'north', name: 'North', edge: 'top', color: '#38bdf8' }, { id: 'east', name: 'East', edge: 'right', color: '#a78bfa' }],
  backs: [{ id: 'bb', color: '#334155' }, { id: 'cup', color: '#7c2d12', label: '?' }, { id: 'ub', color: '#1e3a8a' }],
  pieces: [
    { id: 'rack', kind: 'board', w: 520, h: 140, faces: [{ color: '#a16207' }], zones: [{ id: 'r', poly: RECT(520, 140), owner: 'board', private: 'reveal' }] },
    { id: 'screen', kind: 'board', w: 500, h: 260, faces: [{ color: '#475569' }], zones: [{ id: 's', poly: RECT(500, 260), owner: 'seat:north', private: 'keep' }] },
    { id: 'bone', kind: 'tile', w: 60, h: 120, back: 'bb', faces: [0, 1, 2, 3, 4, 5].map((k) => ({ pips: [k, k + 1], color: '#f8fafc' })) },
    { id: 'd6', kind: 'die', back: 'cup' },
    { id: 'unit', kind: 'token', shape: 'rect', w: 60, back: 'ub', faces: [{ label: 'Crown' }] },
    { id: 'coin', kind: 'token', faces: ['C'] },
  ],
  setup: [
    { piece: 'rack', at: [940, 1380], owner: 'seat:south', id: ID.rackS },
    { piece: 'rack', at: [940, 80], rot: 180, owner: 'seat:north', id: ID.rackN },
    { piece: 'rack', at: [100, 700], id: ID.rackX },
    { piece: 'screen', at: [1750, 160], id: ID.screen },
    { piece: 'd6', at: [700, 760], id: ID.a1 }, { piece: 'd6', at: [780, 760], id: ID.a2 }, { piece: 'd6', at: [860, 760], id: ID.a3 },
    { piece: 'd6', at: [1150, 760], id: ID.s1 }, { piece: 'd6', at: [1230, 760], id: ID.s2 },
    { piece: 'd6', at: [1500, 1000], id: ID.b1 },
    { piece: 'unit', at: [1600, 600], id: ID.u1 }, { piece: 'unit', at: [1450, 600], id: ID.u2 },
    { piece: 'bone', at: [700, 1050], f: 0, id: ID.t1 }, { piece: 'bone', at: [800, 1050], f: 1, id: ID.t2 },
    { piece: 'coin', at: [900, 1080], id: ID.coin },
    { bag: [0, 1, 2, 3, 4, 5].map((f) => ({ t: 'bone', f, up: false })), name: 'Boneyard', at: [2050, 1050], id: ID.bag },
  ],
};
const BOX = boxFromDef(DEF), CLEAN = cleanBox(BOX);
/** A d6 face's label, as the log says it. */
const dieLabel = (f) => faceLabel(CLEAN.types.d6.faces[f], f);
/** A rules script for section 6: buttons the host presses — veil (t.hide of u2 for seat:north, no owner), shake (t.roll of a cupped die), nopeek (validate vetoes every peek from then on). */
const RULES = `({ name: 'Privy rules',
  buttons: (t) => [{ id: 'veil', label: 'Veil' }, { id: 'shake', label: 'Shake' }, { id: 'nopeek', label: 'No peeking' }],
  onButton(t, id) {
    if (id === 'veil') t.hide('${ID.u2}', ['seat:north']);
    if (id === 'shake') t.roll('${ID.a1}');
    if (id === 'nopeek') t.data.noPeek = true;
  },
  validate(t, a) { if (a.t === 'peek' && t.data.noPeek) return 'No peeking in this game'; },
})`;

const settle = (page) => page.waitForFunction(() => window.__ct.jobs() === 0, null, { timeout: 15000 });
const state = (page) => page.evaluate(() => window.__ct.hostState());
const act = (page, a) => page.evaluate((x) => window.__ct.act(x), a);
/** Waits until page p's view of item `id` satisfies `pred` (an expression over `it`); false after 15 s. */
const until = (p, id, pred) => P.waitView(p, `(it => !!it && (${pred}))(v.items[a])`, id, 15000);
/** What page p draws of item `id`: {badge (a 🙈 shows), veiled (the hatched corner's class), title, face (its face, not a back)}. */
const drawn = async (p, id) => (await p.waitForSelector(`#table .item[data-id="${id}"]`, { state: 'attached', timeout: 5000 }).catch(() => null)) && p.evaluate((i) => {
  const el = document.querySelector(`#table .item[data-id="${i}"]`);
  return el && { badge: !!el.querySelector(':scope > .visb') && getComputedStyle(el.querySelector(':scope > .visb')).display !== 'none', veiled: el.classList.contains('veiled'), title: el.title, face: !el.querySelector('.pback') };
}, id);
/** The private zone labels page p draws on board `id`, and the colour of its hatch (a <pattern>'s first fill), or null. */
const zoneOf = (p, id) => p.evaluate((i) => {
  const el = document.querySelector(`#table .item[data-id="${i}"]`);
  return el && { texts: [...el.querySelectorAll('.psvg text.slabel')].map((t) => t.textContent), hatch: el.querySelector('.psvg pattern rect')?.getAttribute('fill') || null };
}, id);
/** Clears page p's selection (Esc; a phone has no key: the same keydown, dispatched). */
const deselect = (p) => (p.touch ? p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))) : p.keyboard.press('Escape'));
/** Presses item `id` on page p: a click (Shift: picks it), or a tap on a touch screen. */
async function touch(p, id, shift = false) {
  const c = await M.centre(p, id);
  if (p.touch) await M.tap(p, c);
  else await M.click(p, c, shift);
}
/** Selects item `id` on page p alone (Esc first) and returns its bar's buttons. */
async function barOn(p, id) {
  await deselect(p);
  await touch(p, id);
  await M.until(async () => (await M.bar(p)).on, 3000, 50);
  return (await M.bar(p)).btns;
}

(async () => {
  const env = await h.start();
  const alice = await M.join(env, 'Alice', env.url);
  const bob = await M.join(env, 'Bob', alice.url(), { ctx: P.PHONE });
  const Mal = await mallory(env, alice.url());
  await Mal.act({ t: 'hello' });
  await alice.waitForFunction(() => document.querySelectorAll('.seat').length >= 3, null, { timeout: 15000 });
  const malBodies = () => Mal.evaluate(() => window.M.got.state.map(({ m }) => (typeof m.b === 'string' ? JSON.parse(m.b) : m)));
  const malNotes = () => Mal.evaluate(() => window.M.notes());
  /** The notices Mallory got (texts), from the `from`-th on. */
  const malSaid = async (from = 0) => (await malNotes()).filter((x) => x.msg).map((x) => x.msg).slice(from);
  /** Sends Mallory's actions `as` and returns the `k` notices they bring her. */
  async function malTries(as, k = as.length) {
    const n0 = (await malSaid()).length;
    for (const a of as) await Mal.act(a);
    await Mal.waitForFunction((n) => window.M.notes().filter((x) => x.msg).length >= n, n0 + k, { timeout: 15000 });
    return (await malSaid()).slice(n0);
  }
  const ALICE = alice.pid, BOB = bob.pid;

  section('0 the room: Alice south (desktop), Bob north (iPhone 13), Mallory east; the test box set up');
  ok((await act(alice, { t: 'loadBox', box: BOX, setup: true, clear: true })).ok, 'the host loads the box with its setup');
  await settle(alice);
  for (const a of [{ p: MAL, watch: true }, { p: BOB, watch: true }, { p: ALICE, id: 'south' }, { p: BOB, id: 'north' }, { p: MAL, id: 'east' }]) await act(alice, { t: 'seat', ...a });
  await settle(alice);
  let S = await state(alice);
  ok(S.players[ALICE].seatId === 'south' && S.players[BOB].seatId === 'north' && S.players[MAL]?.seatId === 'east', `seated: ${J(Object.fromEntries(Object.values(S.players).map((pl) => [pl.name, pl.seatId])))}`);
  ok(await P.waitView(bob, 'a.every((i) => !!v.items[i]) && v.players[me]?.seatId === "north"', Object.values(ID)), "Bob's phone shows the table, Bob north");
  await bob.evaluate(() => { // every tumble this screen plays (pieces.js tumble: the .tumble class, added in a frame)
    window.__tumbles = [];
    new MutationObserver((ms) => { for (const m of ms) if (m.target.classList?.contains('tumble')) window.__tumbles.push(m.target.dataset.id); })
      .observe(document.getElementById('table'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  });

  section('1 the cup: 🙈 Hide on a die cups its handful — the badge, the corner and the tooltip Alice\'s alone');
  let btns = await barOn(alice, ID.a1);
  ok(btns.includes('🙈 Hide') && btns.includes('🎲 Roll') && !btns.includes('Reveal') && !btns.includes('Peek'), `a shown die's bar offers 🙈 Hide and 🎲 Roll (${J(btns)})`);
  const cupFrom = (await malBodies()).length;
  await M.barPress(alice, '🙈 Hide');
  ok(await until(bob, ID.a3, "'b' in it"), "Bob's screen draws the three dice as the cup's back");
  await logHas(alice, 'Alice hid 3 pieces');
  S = await state(alice);
  ok([ID.a1, ID.a2, ID.a3].every((d) => S.items[d].up === false && J(S.items[d].vis) === J([ALICE]) && S.items[d].owner === ALICE && S.items[d].po === 1) && S.items[ID.s1].up !== false,
    'the host state: the handful (three touching dice) face down for Alice alone, hers through po; the dice apart untouched');
  for (const d of [ID.a1, ID.a2, ID.a3]) {
    const [a, b] = [await drawn(alice, d), await drawn(bob, d)];
    ok(a.badge && a.veiled && a.face && a.title === 'Hidden from the others: only you can see it', `Alice's screen: ${d} face up with 🙈, the hatched corner, "${a.title}"`);
    ok(!b.badge && !b.veiled && !b.face && !b.title, `Bob's screen: ${d} its back, no badge (${J(b)})`);
  }
  await M.shot(alice, 'p5-cup-desk');
  btns = await barOn(alice, ID.a1);
  ok(btns.includes('Reveal') && btns.includes('🎲 Roll') && !btns.includes('🙈 Hide') && !btns.includes('Flip'), `a cupped die's bar: Reveal, 🎲 Roll (${J(btns)})`);
  btns = await barOn(bob, ID.a1);
  ok(J(btns) === J(['Peek']), `Bob's bar on Alice's cupped die: Peek alone (${J(btns)})`);
  await deselect(bob);
  await bob.evaluate(() => { window.__tumbles.length = 0; });
  await barOn(alice, ID.a1);
  await M.barPress(alice, '🎲 Roll');
  await logHas(bob, 'Alice rolled 3 hidden dice');
  ok(await M.until(() => bob.evaluate(() => window.__tumbles.length >= 3), 5000, 100), `Bob's screen tumbles the three backs (${J(await bob.evaluate(() => window.__tumbles))})`);
  S = await state(alice);
  const av = await M.items(alice), bv = await M.items(bob);
  ok([ID.a1, ID.a2, ID.a3].every((d) => av[d].f === S.items[d].f && !('f' in bv[d])), "Alice's screen shows each new face; Bob's none");

  section('1′ a group roll of two cupped and two shown dice says the shown values alone (case 11)');
  await alice.keyboard.press('Escape');
  for (const d of [ID.a1, ID.a2, ID.s1, ID.s2]) await touch(alice, d, true);
  ok(J(await M.selected(alice)) === J([ID.a1, ID.a2, ID.s1, ID.s2].sort()), 'Alice picks four dice by Shift+click');
  const gb = (await M.bar(alice)).btns;
  ok(gb.includes('🎲 Roll') && gb.includes('🙈 Hide') && gb.includes('Reveal'), `the group bar: 🎲 Roll, 🙈 Hide (the shown dice), Reveal (the cupped ones: a shown die doesn't turn over) (${J(gb)})`);
  await M.barPress(alice, '🎲 Roll');
  await logHas(bob, 'Alice rolled 4 dice (2 hidden)');
  S = await state(alice);
  const rollLine = (await M.lines(bob, ALICE)).filter((l) => l.startsWith('rolled 4 dice')).at(-1);
  const shown = rollLine.replace(/^rolled 4 dice \(2 hidden\): /, '').split(' · ');
  ok(shown.length === 2 && J([...shown].sort()) === J([dieLabel(S.items[ID.s1].f), dieLabel(S.items[ID.s2].f)].sort()), `"${rollLine}": the two shown dice's values, nothing of the cupped ones`);
  await alice.keyboard.press('Escape');

  section("1″ Mallory's flip, roll, face, move and claim of a cupped die: refused, the dice unchanged (case 8)");
  S = await state(alice);
  const cupped = J([ID.a1, ID.a2, ID.a3].map((d) => S.items[d]));
  let said = await malTries([{ t: 'flip', id: ID.a1 }, { t: 'roll', ids: [ID.a2] }, { t: 'face', id: ID.a3, f: 3 }, { t: 'move', id: ID.a1, x: 40, y: 40 }, { t: 'owner', id: ID.a2, to: MAL }]);
  ok(J(said) === J(['🚫 That piece is hidden', '🚫 That piece is hidden', '🚫 That piece is hidden', '🚫 That belongs to Alice', '🚫 That belongs to Alice']), `flip, roll, face: the uniform refusal; move, claim: Alice's (${J(said)})`);
  S = await state(alice);
  ok(J([ID.a1, ID.a2, ID.a3].map((d) => S.items[d])) === cupped, 'the host state after them: the dice, their values and their owner unchanged');

  section('1‴ Reveal from the bar, then from the group bar: the faces on both screens; H cups from the keyboard');
  const revealFrom = (await malBodies()).length;
  await barOn(alice, ID.a1);
  await M.barPress(alice, 'Reveal');
  ok(await until(bob, ID.a1, "'t' in it && it.up !== false"), "Reveal: Bob's screen shows the die's face");
  S = await state(alice);
  ok((await M.items(bob))[ID.a1].f === S.items[ID.a1].f && !S.items[ID.a1].owner && !S.items[ID.a1].vis && !(await drawn(alice, ID.a1)).badge, 'the value the host holds, public; its owner from the cup gone; no 🙈 on Alice\'s screen');
  await alice.keyboard.press('Escape');
  for (const d of [ID.a2, ID.a3]) await touch(alice, d, true);
  const gr = (await M.bar(alice)).btns;
  ok(gr.includes('Reveal') && !gr.includes('Flip'), `two cupped dice picked: the group bar says Reveal (${J(gr)})`);
  await M.barPress(alice, 'Reveal');
  ok(await until(bob, ID.a3, "'t' in it") && await until(bob, ID.a2, "'t' in it"), 'the group Reveal: both faces on Bob\'s screen');
  await alice.keyboard.press('Escape');
  await barOn(alice, ID.s1);
  await alice.keyboard.press('h');
  ok(await until(bob, ID.s2, "'b' in it") && await until(bob, ID.s1, "'b' in it"), 'H on a die: its handful cupped');
  await alice.keyboard.press('Escape');

  section('2 racks: hatched in their owner\'s colour, named for each screen; 🔒 Draw to my rack');
  const zs = { a: await zoneOf(alice, ID.rackS), aN: await zoneOf(alice, ID.rackN), aX: await zoneOf(alice, ID.rackX), aSc: await zoneOf(alice, ID.screen), b: await zoneOf(bob, ID.rackS), bN: await zoneOf(bob, ID.rackN), bSc: await zoneOf(bob, ID.screen) };
  ok(J(zs.a.texts) === J(['🔒 Your rack']) && J(zs.aN.texts) === J(["🔒 Bob's rack"]) && J(zs.aSc.texts) === J(["🔒 Bob's screen"]), `Alice's screen: ${J([zs.a.texts, zs.aN.texts, zs.aSc.texts])}`);
  ok(J(zs.b.texts) === J(["🔒 Alice's rack"]) && J(zs.bN.texts) === J(['🔒 Your rack']) && J(zs.bSc.texts) === J(['🔒 Your screen']), `Bob's screen: ${J([zs.b.texts, zs.bN.texts, zs.bSc.texts])}`);
  ok(zs.a.hatch === '#f59e0b' && zs.aN.hatch === '#38bdf8' && zs.b.hatch === '#f59e0b' && zs.bSc.hatch === '#38bdf8', `hatched in the owner's colour: South's amber, North's blue (${zs.a.hatch}, ${zs.aN.hatch})`);
  ok(J(zs.aX.texts) === J(["🔓 Nobody's rack"]) && zs.aX.hatch === null, `the rack nobody owns: plain, "${zs.aX.texts}"`);
  btns = await barOn(alice, ID.bag);
  ok(btns.includes('Draw') && btns.includes('🔒 Draw to my rack'), `the bag's bar offers 🔒 Draw to my rack (${J(btns)})`);
  for (let k = 0; k < 2; k++) {
    await barOn(alice, ID.bag);
    await M.barPress(alice, '🔒 Draw to my rack');
    await M.until(async () => Object.values((await state(alice)).items).filter((it) => it.pv && it.vis?.[0] === 'seat:south').length === k + 1, 8000, 100);
  }
  await alice.keyboard.press('Escape');
  S = await state(alice);
  const mineA = Object.keys(S.items).filter((k) => S.items[k].pv && S.items[k].vis?.[0] === 'seat:south').sort(), rk = S.items[ID.rackS];
  ok(mineA.length === 2 && mineA.every((k) => S.items[k].up === false && S.items[k].owner === 'seat:south' && S.items[k].po === 1), `two bones drawn hidden into Alice's rack: up false, vis [seat:south], pv, owner and po (${J(mineA.map((k) => S.items[k]))})`);
  const [g1, g2] = mineA.map((k) => S.items[k]);
  ok(mineA.every((k) => S.items[k].x >= rk.x && S.items[k].x + 60 <= rk.x + 520 && S.items[k].y >= rk.y && S.items[k].y + 120 <= rk.y + 140) && Math.abs(g1.x - g2.x) >= 60,
    `each in a slot of its own inside the rack (x ${g1.x}, ${g2.x}; the rack's ${rk.x}–${rk.x + 520})`);
  for (const k of mineA) {
    ok((await drawn(alice, k)).badge && (await drawn(alice, k)).face && !(await drawn(bob, k)).face && !(await drawn(bob, k)).badge, `${k}: Alice sees its pips (🙈), Bob its back`);
  }
  btns = await barOn(bob, ID.bag);
  ok(btns.includes('🔒 Draw to my rack'), `Bob's phone: the bag's bar offers it too (${J(btns)})`);
  for (let k = 0; k < 2; k++) {
    if (k) await barOn(bob, ID.bag);
    await M.barPress(bob, '🔒 Draw to my rack');
    await M.until(async () => Object.values((await state(alice)).items).filter((it) => it.pv && it.vis?.[0] === 'seat:north').length === k + 1, 8000, 100);
    await deselect(bob);
  }
  S = await state(alice);
  const mineB = Object.keys(S.items).filter((k) => S.items[k].pv && S.items[k].vis?.[0] === 'seat:north').sort();
  ok(mineB.length === 2 && await until(bob, mineB[1], "'t' in it") && !(await drawn(alice, mineB[0])).face, "Bob draws two into his rack: his faces, Alice's backs");
  ok(J((await M.items(alice))[ID.bag].n) === '2', 'the bag holds 2 now');
  await M.shot(bob, 'p5-racks-phone');
  await M.shot(alice, 'p5-racks-desk');
  // Bob drags one out of his rack: face up for everyone (a rack is 'reveal')
  const out = mineB[0];
  await M.fingerDrag(bob, P3.steps(await M.centre(bob, out), await M.pt(bob, 1300, 500), 10));
  ok(await until(alice, out, "'t' in it && it.up !== false"), "Bob drags a bone off his rack: Alice's screen shows its face");
  S = await state(alice);
  ok(!S.items[out].vis && !S.items[out].owner && !S.items[out].pv, 'its vis, pv and the owner the rack gave it gone');
  // a group 🙈 Hide by Shift+click: the coin (no back) is not sent
  for (const k of [ID.t1, ID.t2, ID.coin]) await touch(alice, k, true);
  const gh = (await M.bar(alice)).btns;
  ok(gh.includes('🙈 Hide'), `two bones and a coin picked: the group bar offers 🙈 Hide (${J(gh)})`);
  await M.barPress(alice, '🙈 Hide');
  await logHas(bob, 'Alice hid 2 pieces');
  S = await state(alice);
  ok([ID.t1, ID.t2].every((k) => J(S.items[k].vis) === J([ALICE])) && S.items[ID.coin].up !== false && !(await M.notes(alice)).some((m) => /skipped/.test(m)), 'one group hide of the two bones alone: the coin never sent (no "skipped" notice)');
  ok(await until(bob, ID.t2, "'b' in it") && (await drawn(alice, ID.t1)).badge, "the bones hidden: Bob's backs, Alice's 🙈");
  await alice.keyboard.press('Escape');

  section("3 peeks (case 4): Bob's Peek on Alice's rack tile — his alone, on the record; Mallory's attempts (cases 4, 5, 6)");
  const [rt] = mineA;
  btns = await barOn(bob, rt);
  ok(J(btns) === J(['Peek']), `Bob's bar on Alice's rack tile: Peek alone (${J(btns)})`);
  await M.barPress(bob, 'Peek');
  ok(await M.until(() => bob.evaluate(() => !document.getElementById('peek').classList.contains('hidden')), 8000, 100), "Bob's screen opens the peek overlay");
  const cap = await bob.evaluate(() => document.getElementById('peek-cap').textContent);
  ok(cap.startsWith('Only you can see this — everyone knows you peeked'), `captioned "${cap}"`);
  ok(await bob.evaluate(() => document.querySelectorAll('#peek-inner .pips2 .pip.on').length) === S.items[rt].f * 2 + 1, `it shows the tile's pips (${S.items[rt].f}|${S.items[rt].f + 1})`);
  await logHas(alice, 'Bob peeked at a hidden piece');
  ok(!('t' in (await M.items(bob))[rt]), "Bob's view still holds its back: the peek is his overlay alone");
  await bob.evaluate(() => document.getElementById('peek').click());
  await deselect(bob);
  said = await malTries([{ t: 'move', id: rt, x: 40, y: 40 }, { t: 'flip', id: rt }, { t: 'hide', ids: [ID.coin] }, { t: 'hide', ids: [ID.s1] }, { t: 'hide', ids: [ID.t1] }]);
  ok(J(said) === J(['🚫 That belongs to South', '🚫 That piece is hidden', '🚫 That piece has no hidden side', '🚫 That piece is hidden', '🚫 That piece is hidden']),
    `Mallory: a move of the rack tile is South's, its flip hidden; her hides of a coin (no back), of Alice's cupped die and hidden bone, refused (${J(said)})`);
  await Mal.act({ t: 'peek', id: rt });
  await Mal.waitForFunction(() => window.M.notes().some((x) => x.peek), null, { timeout: 10000 });
  const pk = (await malNotes()).find((x) => x.peek);
  S = await state(alice);
  ok(pk.to === MAL && pk.peek.t === S.items[rt].t && pk.peek.f === S.items[rt].f, `her peek: {t, f} to her alone (${J(pk)})`);
  await logHas(bob, 'Mallory peeked at a hidden piece');
  await Mal.act({ t: 'move', id: ID.u2, x: 1450, y: 650, vis: [MAL], up: false, pv: 1, owner: MAL });
  await logHas(alice, 'Mallory moved Crown');
  S = await state(alice);
  ok(S.items[ID.u2].y === 650 && S.items[ID.u2].up !== false && !S.items[ID.u2].vis && !S.items[ID.u2].owner && !S.items[ID.u2].pv, `a move with forged vis, up, pv and owner: moved, the rest ignored (${J(S.items[ID.u2])})`);

  section("4 seat refs (case 3): Bob's unit behind north's screen, his cupped die; Mallory takes north");
  btns = await barOn(bob, ID.b1);
  ok(btns.includes('🙈 Hide'), `Bob's die: 🙈 Hide on his phone (${J(btns)})`);
  const bobCupFrom = (await malBodies()).length;
  await M.barPress(bob, '🙈 Hide');
  ok(await until(alice, ID.b1, "'b' in it"), "Bob cups his die: Alice's screen draws the cup");
  await deselect(bob);
  S = await state(alice);
  await M.fingerDrag(bob, P3.steps(await M.centre(bob, ID.u1), await M.pt(bob, S.items[ID.screen].x + 250, S.items[ID.screen].y + 130), 10));
  ok(await until(alice, ID.u1, "'b' in it"), "Bob drags his unit behind north's screen: hidden from Alice");
  S = await state(alice);
  ok(J(S.items[ID.u1].vis) === J(['seat:north']) && S.items[ID.u1].pv === 1 && S.items[ID.u1].owner === 'seat:north', `the host state: vis [seat:north], pv, owned by the seat (${J(S.items[ID.u1])})`);
  ok((await drawn(bob, ID.u1)).badge && (await drawn(bob, ID.u1)).face, "Bob's screen: its face, with 🙈");
  const seatFrom = (await malBodies()).length;
  await act(bob, { t: 'seat', watch: true });
  await act(alice, { t: 'seat', p: MAL, id: 'north' });
  await settle(alice);
  ok(await until(bob, ID.u1, "'b' in it"), "Bob stands up: his screen draws the unit's back");
  ok(!(await drawn(bob, ID.u1)).badge && (await drawn(bob, ID.b1)).badge, "…no 🙈 on it; his cupped die (his id, not the seat's) still his, with 🙈");
  ok(await M.until(async () => J((await zoneOf(alice, ID.screen)).texts) === J(["🔒 Mallory's screen"]), 8000, 100), `the screen's label follows the seat: "${(await zoneOf(alice, ID.screen)).texts}"`);
  let mv;
  ok(await M.until(async () => 't' in ((mv = h.viewFrom(await malBodies()))?.items[ID.u1] || {}), 10000, 200), "Mallory, north now, gets the unit's full form (by design)");
  const nb = mineB.find((k) => k !== out);
  ok(await M.until(async () => 't' in ((mv = h.viewFrom(await malBodies()))?.items[nb] || {}), 10000, 200) && !('t' in (await M.items(bob))[nb]), "…and the bone in north's rack, which Bob, standing, no longer sees");
  ok(!('t' in mv.items[ID.b1]) && !('t' in mv.items[mineA[0]]), "…but not Bob's cupped die (his id), nor Alice's rack tile");
  const seatBack = (await malBodies()).length;
  await act(alice, { t: 'seat', p: MAL, id: 'east' });
  await act(bob, { t: 'seat', id: 'north' });
  await settle(alice);
  ok(await until(bob, ID.u1, "'t' in it") && (await drawn(bob, ID.u1)).badge, 'Bob sits north again: the unit is his to see');
  ok(await M.until(async () => J((await zoneOf(alice, ID.screen)).texts) === J(["🔒 Bob's screen"]), 8000, 100), "…and the label Bob's again");

  section('5 the phone held sideways: a rack tile\'s bar in reach, 44 px buttons; Reveal, then 🙈 Hide');
  await bob.setViewportSize({ width: 844, height: 390 });
  await h.sleep(600);
  const [mt] = mineB.filter((k) => k !== out);
  btns = await barOn(bob, mt);
  ok(btns.includes('Reveal') && !btns.includes('🙈 Hide'), `Bob's own rack tile: Reveal (${J(btns)})`);
  const geo = await bob.evaluate(() => [...document.querySelectorAll('#action-bar button')].map((b) => { const r = b.getBoundingClientRect(); return { h: r.height, in: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; }));
  ok(geo.length && geo.every((x) => x.h >= 43.5 && x.in), `every button in view and at least 44 px tall (${J(geo)})`);
  await M.shot(bob, 'p5-bar-landscape');
  await M.barPress(bob, 'Reveal');
  ok(await until(alice, mt, "'t' in it"), 'Reveal: the tile face up in his rack, for Alice too');
  await deselect(bob);
  btns = await barOn(bob, mt);
  ok(btns.includes('🙈 Hide'), `face up, its bar offers 🙈 Hide (${J(btns)})`);
  await M.barPress(bob, '🙈 Hide');
  ok(await until(alice, mt, "'b' in it"), 'hidden again, for Bob alone');
  S = await state(alice);
  ok(J(S.items[mt].vis) === J([BOB]) && S.items[mt].owner === BOB, `a hide is the hider's: vis [Bob], his (${J(S.items[mt])})`);
  await deselect(bob);
  await bob.setViewportSize({ width: P.PHONE.viewport.width, height: P.PHONE.viewport.height });

  section('6 rules (cases 9, 11, 7): a script\'s hide for seat:north, t.roll of a cupped die, a validate that vetoes peek');
  await h.enableRules(alice, { code: RULES });
  await settle(alice);
  await barOn(alice, ID.a1);
  await alice.keyboard.press('h');
  ok(await until(bob, ID.a1, "'b' in it"), 'Alice cups a1 again (H)');
  await alice.keyboard.press('Escape');
  await act(alice, { t: 'rulesBtn', id: 'veil' });
  ok(await until(alice, ID.u2, "'b' in it") && await until(bob, ID.u2, "'t' in it && it.up === false"), "t.hide(u2, ['seat:north']): Alice gets its back, Bob its face");
  S = await state(alice);
  ok(!S.items[ID.u2].owner && (await drawn(bob, ID.u2)).badge, `no owner; Bob's screen marks it 🙈 (${J(S.items[ID.u2])})`);
  said = await malTries([{ t: 'flip', id: ID.u2 }, { t: 'roll', ids: [ID.u2] }]);
  ok(J(said) === J(['🚫 That piece is hidden', '🚫 That piece is hidden']), `Mallory's flip and roll of the script's unit: the uniform refusal (case 9: ${J(said)})`);
  await act(alice, { t: 'rulesBtn', id: 'shake' });
  await logHas(bob, 'rolled a hidden die');
  ok((await M.lines(bob, 'rules')).includes('rolled a hidden die'), '"📜 Rules rolled a hidden die" (case 11)');
  await act(alice, { t: 'rulesBtn', id: 'nopeek' });
  await settle(alice);
  const t0 = Date.now();
  await barOn(bob, rt);
  await M.barPress(bob, 'Peek');
  ok(await M.until(async () => (await M.notes(bob, t0)).some((m) => m.includes('No peeking in this game')), 8000, 100), `the veto's notice on Bob's screen (${J(await M.notes(bob, t0))})`);
  ok(await bob.evaluate(() => document.getElementById('peek').classList.contains('hidden')) && !(await M.lines(alice, BOB, t0)).some((l) => l.includes('peeked')), 'no overlay, no line (case 7)');
  await deselect(bob);

  section('7 the recursive scan: no body Mallory got names a hidden identity');
  await settle(alice);
  await h.sleep(500);
  const all = await malBodies();
  /** Every form of item `id` in bodies `list`: its shared record and any override. */
  const forms = (list, id) => list.flatMap((b) => [b.items?.[id], b.vis?.[id]].filter(Boolean));
  const never = [...mineA.map((id) => forms(all, id)), forms(all.slice(bobCupFrom), ID.b1)];
  ok(never.every((f) => f.length && f.every((it) => !('t' in it) && !('f' in it))), `Alice's rack tiles, and Bob's die once cupped: ${never.map((f) => f.length).join(', ')} forms, never a t or an f`);
  const cups = [ID.a1, ID.a2, ID.a3].flatMap((id) => forms(all.slice(cupFrom, revealFrom), id));
  ok(cups.length && cups.every((it) => !('t' in it) && !('f' in it)), `the cupped dice, while cupped: ${cups.length} forms, the cup's back alone`);
  const ovr = all.map((b, k) => [k, b.kind, Object.keys(b.vis || {})]).filter(([, , v]) => v.length);
  const north = [ID.u1, ...mineB.filter((k) => k !== out)]; // (what seat:north saw while she held it: the unit behind its screen, the bone left in its rack)
  ok(ovr.length && ovr.every(([k, , v]) => k >= seatFrom && k <= seatBack && v.every((id) => north.includes(id))), `her only overrides: north's — the unit behind its screen, the bone in its rack — while she held north (${J(ovr)}, bodies ${seatFrom}–${seatBack})`);
  const keys = (v) => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  ok(!keys(all).includes('pips'), 'no body carries pips (a piece type travels in the boxes channel, never with a hidden piece)');
  const notes = await malNotes();
  ok(notes.filter((n) => n.peek).length === 1, 'the one peek answer she got is her own');
  ok(h.viewFrom(all).seq === (await alice.evaluate(() => window.__ct.view().seq)), "Mallory's folded view is in step with the host's");
  await env.done();
})().catch(h.crash);
