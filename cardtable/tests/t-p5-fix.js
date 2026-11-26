// Phase 5's fix-up, on the screen (D282–D291): what the reviewers found
// there, closed — on a desktop host (Alice, 1280 × 800, the mouse) and an
// iPhone 13 guest (Bob, held upright; sideways for a shot).
//   1  Dominoes: each half of a tile draws its own pips in its own half (the
//      two cells of .pips2, D291), on both screens; with nine tiles on the
//      rack, 🔒 Draw to my rack sets the tenth and eleventh down half a slot
//      on, every tile still in sight (D287).
//   2  Veiled Ranks: Alice's refused move of a hidden unit is hers alone —
//      the notice on her screen and the unit back on its square at once
//      (core's `back`), while Bob gets no line, no live drag and no body
//      naming it (D282); a unit's name reads along the top of its face while
//      🙈 holds its corner (D291); each kind its own label, the Lancer's 1»
//      and the Herald's 1✉ (D285).
//   3  Backgammon: its dice wear a cup (D286); 🙈 Hide on a die cups its
//      handful but a locked die, with no refusal (D290).
//   4  A wheel over the 🔒 For you card scrolls the card and zooms nothing (D289).
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const M = require('./p4m-lib');
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const ST = require('./stones-lib');
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const J = JSON.stringify;
const settle = (p) => p.waitForFunction(() => window.__ct.jobs() === 0, null, { timeout: 15000 });
const state = (p) => p.evaluate(() => window.__ct.hostState());
const act = (p, a) => p.evaluate((x) => window.__ct.act(x), a);
const deselect = (p) => (p.touch ? p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))) : p.keyboard.press('Escape'));
const touch = async (p, id) => { const c = await M.centre(p, id); if (p.touch) await M.tap(p, c); else await M.click(p, c); };
/** The client rect of item `id`'s element on page p, and of its parts matching `sel` inside it. */
const rects = (p, id, sel) => p.evaluate(([id, sel]) => {
  const el = document.querySelector(`#table .item[data-id="${id}"]`), r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  return el && { el: r(el), parts: [...el.querySelectorAll(sel)].map(r) };
}, [id, sel]);
const area = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));

(async () => {
  const env = await h.start();
  const alice = await M.join(env, 'Alice', env.url);
  const bob = await M.join(env, 'Bob', alice.url(), { ctx: P.PHONE });
  await alice.waitForFunction(() => document.querySelectorAll('.seat').length >= 2, null, { timeout: 15000 });
  const ALICE = alice.pid, BOB = bob.pid, page = { [ALICE]: alice, [BOB]: bob };
  async function seatUs() {
    for (const a of [{ p: BOB, watch: true }, { p: ALICE, watch: true }, { p: ALICE, id: 'south' }, { p: BOB, id: 'north' }]) await act(alice, { t: 'seat', ...a });
    await settle(alice);
  }

  section('1 Dominoes: a tile\'s two halves in their own halves; the tenth and eleventh tile on a full rack land half a slot on, all in sight');
  await ST.pickGame(alice, 'dominoes');
  await settle(alice);
  await seatUs();
  ok(await M.until(async () => (await ST.buttons(bob)).includes('Draw 7'), 8000, 100), 'Bob\'s phone offers Draw 7');
  await ST.press(bob, /^Draw 7$/, true);
  const tileIds = (S) => Object.keys(S.items).filter((k) => /\/t\d\d$/.test(S.items[k].t)).sort();
  ok(await M.until(async () => tileIds(await state(alice)).length === 14, 10000, 100), 'fourteen tiles dealt');
  await settle(alice);
  let S = await state(alice);
  const rackOf = (seat) => S.items[Object.keys(S.items).find((k) => /\/rack$/.test(S.items[k].t) && S.items[k].owner === `seat:${seat}`)];
  const onRack = (S, it, seat) => { const r = Object.values(S.items).find((x) => /\/rack$/.test(x.t) && x.owner === `seat:${seat}`); return it.x + 30 >= r.x && it.x + 30 <= r.x + 600 && it.y + 60 >= r.y && it.y + 60 <= r.y + 140; };
  for (const [p, seat] of [[alice, 'south'], [bob, 'north']]) {
    const mine = tileIds(S).filter((k) => onRack(S, S.items[k], seat));
    await M.until(async () => (await rects(p, mine[0], '.pips2 > .pips'))?.parts.length === 2, 5000, 100);
    const halves = [];
    for (const id of mine) halves.push((await rects(p, id, '.pips2 > .pips')).parts);
    ok(mine.length === 7 && halves.every(([a, b]) => a && b && a.b - a.t > 4 && b.b - b.t > 4 && area(a, b) < 1),
      `${p === alice ? 'Alice' : 'Bob'}'s seven tiles: each half's pips in its own half of the tile, apart (${J(halves[0].map((r) => [Math.round(r.t), Math.round(r.b)]))})`);
  }
  await M.shot(alice, 'p5fix-dominoes-desk');
  await M.shot(bob, 'p5fix-dominoes-phone');
  const lead = S.rules.public.turn, q = page[lead], seat = S.players[lead].seatId, bag = Object.keys(S.items).find((k) => S.items[k].k === 'b');
  for (let k = 0; k < 4; k++) {
    const n0 = (await state(alice)).items[bag].of.length;
    await deselect(q);
    await touch(q, bag);
    ok(await M.until(async () => (await M.bar(q)).btns.includes('🔒 Draw to my rack'), 5000, 100), `draw ${k + 1}: the bag's bar offers 🔒 Draw to my rack`);
    await M.barPress(q, '🔒 Draw to my rack');
    ok(await M.until(async () => (await state(alice)).items[bag].of.length === n0 - 1, 8000, 100), `…a tile drawn (${n0} → ${n0 - 1})`);
    await settle(alice);
  }
  S = await state(alice);
  const held = tileIds(S).filter((k) => onRack(S, S.items[k], seat)).map((k) => S.items[k]);
  const box = (it) => ({ l: it.x, t: it.y, r: it.x + 60, b: it.y + 120 });
  const worst = Math.max(...held.flatMap((a, i) => held.slice(i + 1).map((b) => area(box(a), box(b)) / 7200)));
  ok(held.length === 11 && new Set(held.map((it) => Math.round(it.x))).size === 11 && worst <= 0.5,
    `eleven tiles on the rack, at eleven places, none covering more than half another (${held.map((it) => Math.round(it.x - rackOf(seat).x)).sort((a, b) => a - b).join(', ')}; the most covered ${(worst * 100).toFixed(0)}%)`);
  await M.shot(q, 'p5fix-dominoes-full-rack');

  section('2 Veiled Ranks: a refused move of a hidden unit is its player\'s alone; the name along the top of a 🙈 face; a label for each kind');
  ok((await act(alice, { t: 'loadBox', box: BOXES.ranks, setup: true, clear: true, rules: true })).ok, 'the host sets up Veiled Ranks with its rules');
  await M.until(async () => (await state(alice)).rules?.name === 'Veiled Ranks', 10000, 100);
  await settle(alice);
  await seatUs();
  S = await state(alice);
  const mineV = Object.keys(S.items).filter((k) => S.items[k].t?.includes('/s-')), sqOf = (it) => it.at?.split(':').pop();
  ok(await M.until(async () => { const v = await M.items(alice); return mineV.every((k) => 't' in v[k] && v[k].up === false); }, 8000, 100), "Alice's twelve units: her faces, hidden from Bob");
  const labels = await alice.evaluate((ids) => ids.map((id) => document.querySelector(`#table .item[data-id="${id}"] .plabel`)?.textContent), mineV);
  ok(new Set(labels).size === 7 && labels.includes('1»') && labels.includes('1✉'), `each kind of unit its own label on Alice's screen (${[...new Set(labels)].join(' ')})`);
  const [u] = mineV, face = await rects(alice, u, '.pface, .ptext');
  ok(face && face.parts[1].b <= (face.parts[0].t + face.parts[0].b) / 2 + 1, `a 🙈 unit's name reads along the top of its face, clear of the badge (face ${Math.round(face.parts[0].t)}–${Math.round(face.parts[0].b)}, name ${Math.round(face.parts[1].t)}–${Math.round(face.parts[1].b)})`);
  await bob.evaluate(() => { window.__rtc.keep = true; window.__rtc.bodies.length = 0; });
  const t0 = Date.now(), home = await M.centre(alice, u), from = sqOf(S.items[u]);
  const to = await P3.screenOf(alice, S.items[u].x + 40, S.items[u].y - 360); // (four rows up: outside her three)
  await deselect(alice);
  await M.mouseDrag(alice, P3.steps(home, to, 10, 30));
  let said = null;
  await M.until(async () => (said = (await M.notes(alice, t0)).find((x) => x.startsWith('🚫'))), 5000, 50);
  const back = await M.until(async () => { const c = await M.centre(alice, u); return Math.hypot(c.x - home.x, c.y - home.y) < 2; }, 1000, 25);
  ok(said === '🚫 Deploy inside your three rows' && back, `Alice drags her unit out of her rows: refused ("${said}"), and it is back on ${from} within a second (before the 1.5 s hold lets go)`);
  await settle(alice);
  await h.sleep(800);
  const bodies = await bob.evaluate(() => window.__rtc.bodies.map((b) => JSON.stringify(b.body)));
  const blines = await bob.evaluate((t0) => window.__ct.log().filter((e) => (e.ts ?? 0) >= t0).map((e) => e.txt), t0);
  ok(!bodies.some((b) => b.includes(u)) && !blines.some((l) => /blocked/.test(l)), `Bob got no body naming the unit (${bodies.length} bodies), no live drag of it, no "blocked" line (${J(blines)})`);
  const other = mineV.find((k) => k !== u && sqOf(S.items[k])?.endsWith(from.slice(1)));
  await act(alice, { t: 'move', id: u, x: S.items[other].x, y: S.items[other].y }); // (a legal swap within her rows: the control)
  ok(await M.until(async () => (await bob.evaluate(() => window.__rtc.bodies.map((b) => JSON.stringify(b.body)))).some((b) => b.includes(u)), 5000, 100), 'a legal swap of it then reaches Bob (its back): what he receives is being recorded');
  await M.shot(alice, 'p5fix-ranks-desk');
  await M.shot(bob, 'p5fix-ranks-phone');
  await bob.setViewportSize({ width: 844, height: 390 });
  await h.sleep(800);
  await M.shot(bob, 'p5fix-ranks-phone-sideways');
  await bob.setViewportSize({ width: 390, height: 664 });

  section('3 Backgammon: the dice wear a cup; 🙈 Hide cups the handful but a locked die');
  await ST.pickGame(alice, 'backgammon');
  await settle(alice);
  S = await state(alice);
  const dice = Object.keys(S.items).filter((k) => S.items[k].t?.endsWith('/die')).sort((a, b) => S.items[a].x - S.items[b].x);
  ok(dice.length === 2 && S.boxes[S.items[dice[0]].t.split('/')[0]].types.die.back === 'cup', 'two dice, under a cup back');
  await act(alice, { t: 'lock', id: dice[1], on: true });
  await settle(alice);
  const t1 = Date.now();
  await deselect(alice);
  await touch(alice, dice[0]);
  ok(await M.until(async () => (await M.bar(alice)).btns.includes('🙈 Hide'), 5000, 100), `the die's bar offers 🙈 Hide (${J((await M.bar(alice)).btns)})`);
  await M.barPress(alice, '🙈 Hide');
  await settle(alice);
  S = await state(alice);
  ok(S.items[dice[0]].up === false && J(S.items[dice[0]].vis) === J([ALICE]) && S.items[dice[1]].up !== false && !(await M.notes(alice, t1)).some((x) => x.startsWith('🚫') || x.startsWith('🔒')),
    `the unlocked die cupped, the locked one left out, no refusal (${J(await M.notes(alice, t1))})`);

  section('4 a wheel over the 🔒 For you card scrolls it and zooms nothing');
  const code = "({ name: 'Long secret', setup(t) { for (const p of t.players({ all: true })) t.secret[p.id] = { text: Array.from({ length: 80 }, (_, k) => 'line ' + k).join('\\n') }; } })";
  ok((await act(alice, { t: 'setRules', code, enabled: true })).ok, 'the host enables a script with an 80-line secret');
  ok(await alice.waitForFunction(() => !document.getElementById('secret').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false), 'Alice\'s 🔒 For you card shows');
  const sc = await alice.evaluate(() => { const el = document.getElementById('secret-text'), r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: el.scrollTop, more: el.scrollHeight > el.clientHeight, tf: document.getElementById('table').style.transform }; });
  await alice.mouse.move(sc.x, sc.y);
  await alice.mouse.wheel(0, 200);
  await h.sleep(400);
  const sa = await alice.evaluate(() => ({ top: document.getElementById('secret-text').scrollTop, tf: document.getElementById('table').style.transform }));
  ok(sc.more && sa.top > sc.top && sa.tf === sc.tf, `the card scrolls (${sc.top} → ${sa.top}), the view keeps still`);
  await M.shot(alice, 'p5fix-secret-wheel');

  await env.done();
})().catch(h.crash);
