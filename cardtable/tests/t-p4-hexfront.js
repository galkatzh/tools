// Phase 4B, Hexfront played on screens (spec §4's demo, §4l t-p4-hexfront,
// §4k B18 and B21): Alice hosts on a desktop, Bob plays on an iPhone 13
// held upright, Carol watches from a desktop (a third player: no seat left).
//  1. Hexfront set up from 📦's Built-in section (its turn script at once).
//  2. 400 counters in 40 stacks on every screen.
//  3. The turn script: the side out of turn is refused (its counter goes
//     back), the side to play moves a group of its stacks; ⚔ To combat and
//     ⏭ End turn, the page's own buttons, move the phase and the turn on.
//  4. A stack split with the inspector (Take 3) and joined again (Take all,
//     then a drag onto it).
//  5. The dice rolled as a group in combat; a loss taken (a stack flipped).
//  6. An event card drawn into a hand; a second is refused.
//  7. B18: a guest's cold render of the game — ≤ 600 ms on the desktop, ≤
//     2 s on the phone at 2× CPU throttle — and its snapshot and boxes ≤
//     120 KB; B21: the game exported from 📦 ≤ 5 s.
// Every move is a real gesture: a mouse and keys on the desktop, fingers on
// the phone (a pinch to zoom in, ⬚ and taps to pick, a long press for the
// inspector). Run alone (run-all.sh SERIAL: wall clocks and a throttled CPU).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const { until, view } = require('./p1-lib');
const { shown, toasts, said, shot, tap, press, pinch, hold, badgeAt, inspector } = require('./p4s-lib');

const R = 100 / Math.sqrt(3); // (Hexfront's hex: cell 100, pointy; a row is 1.5 R down, half a cell aside)

(async () => {
  const env = await h.start();
  const alice = await P3.join(env, 'Alice', env.url);
  const bob = await P3.join(env, 'Bob', alice.url(), { ctx: P.PHONE });
  const touch = new Map([[alice, false], [bob, true]]);
  for (const p of [alice, bob]) await toasts(p);
  alice.on('dialog', (d) => d.accept());

  section('1–2. Hexfront from 📦\'s Built-in section: 400 counters in 40 stacks on every screen');
  await alice.click('#box-btn');
  await alice.waitForSelector('#box-dialog[open]');
  await alice.click('#box-builtins [data-builtin="hexfront"]');
  ok(await until(async () => { const v = await view(bob); return Object.keys(v.items).length === 44 && v.rules?.enabled && v.rules.name === 'Hexfront'; }, 20000), "Bob's phone: Hexfront's 44 items, its rules on");
  const carol = await P3.join(env, 'Carol', alice.url());
  touch.set(carol, false);
  await carol.addInitScript(() => { window.__rtc.keep = true; }); // (the bodies a reload brings: B18's snapshot)
  const v0 = await view(carol), seat = (p) => v0.players[p.pid]?.seatId;
  const its = Object.entries(v0.items), stacks = its.filter(([, it]) => it.k === 'g' && it.n === 10);
  ok(stacks.length === 40 && stacks.reduce((n, [, it]) => n + it.n, 0) === 400, `Carol sees 400 counters in 40 stacks (${stacks.length})`);
  ok(!seat(carol) && seat(alice) && seat(bob) && seat(alice) !== seat(bob), `Alice and Bob hold the two seats (${seat(alice)}, ${seat(bob)}); Carol watches`);
  const az = seat(alice) === 'azure' ? alice : bob, em = az === alice ? bob : alice, NAME = new Map([[alice, 'Alice'], [bob, 'Bob'], [carol, 'Carol']]);
  const fwd = (p) => (p === az ? -1 : 1); // (Azure's rows are at the bottom, Ember's at the top)
  // (each side's stacks, its front row first — the one nearest the middle of the map — then by x)
  const own = (side) => stacks.filter(([, it]) => it.owner === `seat:${side}`).map(([id]) => id)
    .sort((a, b) => (v0.items[a].y - v0.items[b].y) * (side === 'azure' ? 1 : -1) || v0.items[a].x - v0.items[b].x);
  const AZ = own('azure'), EM = own('ember');
  const dice = its.filter(([, it]) => /\/d6$/.test(it.t)).map(([id]) => id), events = its.find(([, it]) => it.name === 'Events')[0];
  ok(AZ.length === 20 && EM.length === 20 && dice.length === 2 && events, `each side's 20 stacks (${AZ.length}, ${EM.length}), two dice, the Events pile`);

  /** Zooms phone page p in on table point c (🧭 first: the whole table; then two fingers spread there). Nothing on a desktop. */
  async function zoomTo(p, c) {
    if (!touch.get(p)) return;
    await p.tap('#view-btn');
    await h.sleep(300);
    await pinch(p, await P3.screenOf(p, c.x, c.y), 50, 180);
    await h.sleep(500);
  }
  const centre = (id) => ({ x: v0.items[id].x + 28, y: v0.items[id].y + 28 });
  /** Picks items `ids` on page p: Shift+clicks on a desktop, ⬚ and taps on the phone (⬚ left on). */
  async function pickAll(p, ids) {
    if (touch.get(p)) { if (!(await p.evaluate(() => document.getElementById('sel-mode').classList.contains('on')))) await p.tap('#sel-mode'); }
    else await p.keyboard.down('Shift');
    for (const id of ids) await tap(p, await P3.centreOf(p, id), touch.get(p));
    if (!touch.get(p)) await p.keyboard.up('Shift');
  }
  /** Puts page p's selection away: Esc on a desktop; on the phone ⬚ off, and a second tap on an item selected alone. */
  async function putAway(p) {
    if (!touch.get(p)) { await p.keyboard.press('Escape'); return; }
    if (await p.evaluate(() => document.getElementById('sel-mode').classList.contains('on'))) await p.tap('#sel-mode');
    const id = await p.evaluate(() => document.querySelector('#table .item.selected')?.dataset.id);
    if (id) await tap(p, await P3.centreOf(p, id), true);
    ok(!(await shown(p)).bar, `${NAME.get(p)}: the bar put away`);
  }
  /** Drags item `id` on page p by table vector (dx, dy), pressed at its drawn centre (a group's member carries the group). */
  async function dragBy(p, id, dx, dy) {
    const a = await P3.centreOf(p, id), it = (await view(p)).items[id], b = await P3.screenOf(p, it.x + 28 + dx, it.y + 28 + dy);
    await P3.gesture(p, [...P3.steps(a, b, 12, 20), { ...b, wait: 150 }], { touch: touch.get(p) });
  }

  /** One full turn of the player on page p (side `side`, its front row `mine`; `other`: the other player, `theirs` their front row):
   *  the other side refused out of turn; a group of three moved a hex forward; a stack split with the inspector and joined again;
   *  an event drawn (a second refused); ⚔ To combat; the dice rolled as a group; the other side takes a loss; ⏭ End turn. */
  async function turn(p, side, mine, other, theirs) {
    const who = NAME.get(p), Side = side === 'azure' ? 'Azure' : 'Ember';
    section(`3. turn 1, ${Side} (${who}${touch.get(p) ? ', on the phone' : ''}): the other side out of turn is refused; a group of three moves a hex forward`);
    await zoomTo(other, centre(theirs[0]));
    await dragBy(other, theirs[0], 50, 1.5 * R * fwd(other));
    ok(await said(other, new RegExp(`🚫 It's ${Side}'s turn`)), `${NAME.get(other)}'s drag out of turn: "It's ${Side}'s turn"`);
    ok(await until(async () => (await view(carol)).items[theirs[0]].n === 10 && !Object.values((await view(carol)).items).some((it) => it.n === 1 && it.owner === `seat:${seat(other)}`), 5000), 'the counter went back: no counter of theirs left on its own');
    const g3 = mine.slice(0, 3), v1 = await view(carol);
    await zoomTo(p, centre(g3[1]));
    await pickAll(p, g3);
    ok(/^3 selected/.test((await shown(p)).bar), `${who} picks three stacks: "${(await shown(p)).bar}"`);
    if (touch.get(p)) await shot(p, 'p4-hexfront-iphone');
    await dragBy(p, g3[1], 50, 1.5 * R * fwd(p));
    ok(await until(async () => { const v = await view(carol); return g3.every((id) => v.items[id].at && v.items[id].at !== v1.items[id].at && v.items[id].n === v1.items[id].n); }, 10000), 'all three, whole, stand on new hexes (Carol\'s screen)');
    ok(await until(async () => (await view(carol)).log.some((e) => e.txt === 'moved 3 items' && e.p === p.pid), 5000), `one line: "${who} moved 3 items"`);
    await putAway(p);

    section(`4. ${who} splits a stack with the inspector (Take 3) and joins it again (Take all, a drag onto it)`);
    const s4 = mine[5];
    await zoomTo(p, centre(s4));
    if (touch.get(p)) await hold(p, await P3.centreOf(p, s4));
    else await tap(p, await badgeAt(p, s4, 'count'));
    ok(/×10 in this stack/.test((await inspector(p))?.text || ''), `${touch.get(p) ? 'a long press' : 'a click on its ×10'}: the inspector ("${(await inspector(p))?.text}")`);
    await press(p, '#inspector [data-ins="more"]', touch.get(p));
    await press(p, '#inspector [data-ins="more"]', touch.get(p));
    await press(p, '#inspector [data-ins="take"]', touch.get(p));
    let three = null;
    ok(await until(async () => { const v = await view(carol); three = Object.keys(v.items).find((id) => v.items[id].n === 3 && v.items[id].t === v0.items[s4].t); return v.items[s4].n === 7 && three; }, 10000), 'Take 3: ×7 stays, a ×3 beside it, on its own hex');
    if (touch.get(p)) await tap(p, await P3.screenOf(p, centre(s4).x, centre(s4).y - 4 * R * fwd(p)), true); // (a tap outside closes it)
    else await p.keyboard.press('Escape');
    ok(await until(async () => !(await inspector(p)), 3000), 'the inspector closes');
    if (touch.get(p)) await hold(p, await P3.centreOf(p, three));
    else await tap(p, await badgeAt(p, three, 'count'));
    await press(p, '#inspector [data-ins="all"]', touch.get(p));
    const c7 = await P3.centreOf(p, s4);
    await P3.gesture(p, [...P3.steps(await P3.centreOf(p, three), c7, 12, 20), { ...c7, wait: 150 }], { touch: touch.get(p) });
    ok(await until(async () => { const v = await view(carol); return v.items[s4].n === 10 && !v.items[three]; }, 10000), 'Take all, then a drag onto the ×7: joined, ×10 again');
    await putAway(p);

    section(`6. ${who} draws an event into the hand; a second is refused`);
    await zoomTo(p, { x: v0.items[events].x + 50, y: v0.items[events].y + 70 });
    const draw = async () => { if (touch.get(p)) { await tap(p, await P3.centreOf(p, events), true); await press(p, '#action-bar [data-cmd="draw"]', true); } else await p.dblclick(`.item[data-id="${events}"]`); };
    await draw();
    ok(await until(async () => (await p.locator('#hand .hcard').count()) === 1, 10000) && /\S/.test(await p.locator('#hand .hcard').first().textContent()), 'an event card in the hand bar, its text showing');
    await putAway(p);
    await draw();
    ok(await said(p, /🚫 One event a turn/), 'a second draw: "One event a turn"');
    await putAway(p);

    section(`3, 5. ${who}: ⚔ To combat; the dice rolled as a group; ${NAME.get(other)} takes a loss; ⏭ End turn`);
    await press(p, '#rules-btns button[data-rbtn="combat"]', touch.get(p));
    ok(await until(async () => (await view(carol)).rules.public?.badges?.[p.pid] === '⚔ Combat', 10000), '⚔ To combat (the page\'s own button): the phase badge on every screen');
    await zoomTo(p, centre(dice[0]));
    await pickAll(p, dice);
    ok(/^2 selected.*🎲 Roll/.test((await shown(p)).bar), `the two dice picked: "${(await shown(p)).bar}"`);
    if (touch.get(p)) await press(p, '#action-bar [data-cmd="roll"]', true);
    else await p.keyboard.press(' ');
    ok(await until(async () => (await view(carol)).log.some((e) => /^rolled 2 dice: \d · \d$/.test(e.txt) && e.p === p.pid), 10000), `one roll of both: "${who} rolled 2 dice: a · b"`);
    await putAway(p);
    const loss = theirs[6];
    await zoomTo(other, centre(loss));
    await tap(other, await P3.centreOf(other, loss), touch.get(other));
    if (touch.get(other)) await press(other, '#action-bar [data-cmd="flip"]', true);
    else await other.keyboard.press('f');
    ok(await until(async () => (await view(carol)).items[loss].f === 1, 10000), `${NAME.get(other)} takes a loss: the stack turned to its reduced face`);
    await putAway(other);
    await press(p, '#rules-btns button[data-rbtn="end"]', touch.get(p));
    ok(await until(async () => (await view(carol)).rules.public?.turn === other.pid, 10000), `⏭ End turn: ${NAME.get(other)}'s turn on every screen`);
  }
  await turn(az, 'azure', AZ, em, EM);
  await turn(em, 'ember', EM, az, AZ);
  ok(await until(async () => (await view(carol)).log.some((e) => /Turn 2 — Azure moves/.test(e.txt)), 10000), '"Turn 2 — Azure moves"');
  const sameAs = async () => JSON.stringify((await view(carol)).items) === JSON.stringify((await view(alice)).items);
  ok(await until(sameAs, 5000), "the watcher's table is the host's, item for item");
  await carol.evaluate(() => { window.__acts.length = 0; });
  const cs = await P3.centreOf(carol, AZ[6]);
  await P3.gesture(carol, P3.steps(cs, { x: cs.x + 40, y: cs.y - 40 }, 8));
  ok(!(await carol.evaluate(() => window.__acts.some((x) => x.a.t !== 'drag' && x.a.t !== 'select' && x.a.t !== 'snap'))), "the watcher's drag on a stack pans: nothing sent");
  await shot(carol, 'p4-hexfront-watcher');

  section('7. B18: a guest\'s cold render — the desktop ≤ 600 ms, the phone at 2× CPU throttle ≤ 2 s; the snapshot and boxes ≤ 120 KB');
  await carol.reload();
  await carol.waitForFunction(() => Object.keys(window.__ct?.view().items || {}).length === 44 && window.__ct.perf.lastSnapRenderMs > 0, null, { timeout: 30000 });
  const dk = await carol.evaluate(() => ({ ms: window.__ct.perf.lastSnapRenderMs, snap: Math.max(0, ...window.__rtc.bodies.filter((b) => b.body.kind === 'snap').map((b) => JSON.stringify(b.body).length)), boxes: window.__rtc.recv.boxes || 0 }));
  const cdp = await bob.context().newCDPSession(bob);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
  await bob.reload();
  await bob.waitForFunction(() => Object.keys(window.__ct?.view().items || {}).length === 44 && window.__ct.perf.lastSnapRenderMs > 0, null, { timeout: 30000 });
  const ph = await bob.evaluate(() => window.__ct.perf.lastSnapRenderMs);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  console.log(`  B18 (browser): a guest's cold render ${dk.ms.toFixed(0)} ms on the desktop, ${ph.toFixed(0)} ms on the iPhone 13 at 2× throttle; the snapshot ${(dk.snap / 1024).toFixed(1)} KB, the boxes channel ${(dk.boxes / 1024).toFixed(1)} KB`);
  ok(dk.ms <= 600, `B18: the desktop guest's render ≤ 600 ms (${dk.ms.toFixed(0)})`);
  ok(ph <= 2000, `B18: the phone's render at 2× throttle ≤ 2 s (${ph.toFixed(0)})`);
  ok(dk.snap > 0 && dk.snap + dk.boxes <= 120 * 1024, `B18: the snapshot and the box ≤ 120 KB (${((dk.snap + dk.boxes) / 1024).toFixed(1)} KB)`);

  section('7. B21: Hexfront exported from 📦 (its rules and state) ≤ 5 s');
  await alice.click('#box-btn');
  await alice.waitForSelector('#box-dialog[open]');
  const t0 = Date.now(), [dl] = await Promise.all([alice.waitForEvent('download', { timeout: 30000 }), alice.click('#box-x-go')]), ms = Date.now() - t0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-hexfront-')), file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  let g = null;
  try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.error('the exported Hexfront does not parse', err); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  B21 (browser): Hexfront exported in ${ms} ms (${dl.suggestedFilename()}, no images: a .json)`);
  ok(dl.suggestedFilename() === 'Hexfront.json' && g?.rules && g.rulesState?.data?.turn === 2 && g.setup.filter((e) => e.n === 10).length >= 39, `«${dl.suggestedFilename()}»: the rules, turn 2 in its state, the stacks in its setup`);
  ok(ms <= 5000, `B21: ${ms} ms from the press of Export… to the download (≤ 5,000)`);
  await env.done();
})().catch(h.crash);
