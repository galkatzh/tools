// Phase 2 demos, played by hand (spec §2l "t-p2-demos.js"; §2g "The 🎲
// picker" and "The built-in boxes"). Alice hosts on a desktop, Bob plays on
// an iPhone 13; every move is a real drag, click, double-click or tap.
//   Draughts: picked from 🎲 (the confirm on a table that isn't empty; rules
//   switched off), 24 men on the dark squares, owned by the Light and Dark
//   seats; Light moves a light man; Dark's drag on a light man pans and
//   sends nothing; a jump, and the captured man removed by its owner (the
//   capturer is never offered 🗑 on it); crowning by double-click (and by
//   the phone's Flip) shows ♛ on both screens. The board's coordinates
//   read upright on both screens, Dark's turned 180° (D91).
//   Backgammon: picked from 🎲; 15 + 15 checkers in the standard start,
//   seat-bound; a double-click on one of the two adjacent dice rolls both
//   (one roll, one "rolled a · b" line, the tumble and the faces on both
//   screens), the phone's 🎲 Roll does too; the doubling cube is turned (a
//   double-click, then `face`) to read 2; a checker goes to the bar.
// Screenshots: shots/demo-*.png (desktop and phone), for review only.
const path = require('path');
const h = require('./h');
const L = require('./p1-lib');
const P = require('./p2t-lib');
const { shot } = require('./fun-lib');
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));
const { ok, section } = h;

const CONFIRM = (title) => `Clear the table and set up ${title}? The current game is discarded.`;

(async () => {
  const env = await h.start();
  const host = await P.join(env, 'Alice', env.url);
  await host.waitForSelector('.item.pile .count');
  const bob = await P.join(env, 'Bob', host.url(), { rtc: true, ctx: P.PHONE });
  const both = [[host, 'Alice'], [bob, 'Bob']];
  const items = (p = host) => P.viewOf(p, 'v.items');
  /** The screen vector of table vector (dx, dy) on page p (its view's turn and scale). */
  const onScreen = async (p, dx, dy) => {
    const t = await P.tf(p), a = (t.rot * Math.PI) / 180;
    return { x: (dx * Math.cos(a) - dy * Math.sin(a)) * t.s, y: (dx * Math.sin(a) + dy * Math.cos(a)) * t.s };
  };
  /** Drags item `id` on page p by table vector (dx, dy): a mouse on the desktop, a finger on the phone. */
  async function dragBy(p, id, dx, dy) {
    const a = await P.itemXY(p, id), d = await onScreen(p, dx, dy);
    await P.dragOn(p, a, { x: a.x + d.x, y: a.y + d.y }, p === bob);
  }
  /** Waits until item `id` rests on the host (a guest's drag sends live moves, then its drop). */
  const settled = (id) => L.until(async () => {
    const a = (await items())[id];
    await h.sleep(500);
    const b = (await items())[id];
    return a && b && a.x === b.x && a.y === b.y;
  }, 10000, 0);
  /** Opens 🎲 Games on the host and picks game `k`; `answer` the confirm (true: accept). Returns the confirm's text, or null when none was asked. */
  async function pickGame(k, answer) {
    let asked = null;
    const onDialog = (d) => { asked = d.message(); if (answer) d.accept(); else d.dismiss(); };
    host.once('dialog', onDialog);
    await host.click('#games-btn');
    await host.waitForSelector('#games-dialog[open]');
    await host.click(`#games-list [data-game="${k}"]`);
    await h.sleep(500);
    host.off('dialog', onDialog);
    if (await host.$('#games-dialog[open]')) await host.click('#games-dialog form button');
    return asked;
  }

  section('Draughts: picked from 🎲 on a table that isn\'t empty');
  ok((await L.act(host, { t: 'setRules', code: "({ name: 'Warm-up', setup(t) { t.public.n = 1; } })", enabled: true })).ok, '(a script is running, and the default deck is on the table)');
  let asked = await pickGame('draughts', false);
  ok(asked === CONFIRM('Draughts'), `the host is asked first: "${asked}"`);
  ok(await P.viewOf(host, "Object.values(v.items).some((it) => it.k === 'p') && v.rules?.enabled === true"), 'declined: the deck and the script stay');
  asked = await pickGame('draughts', true);
  ok(asked === CONFIRM('Draughts'), 'asked again, and accepted');
  const draughtsOn = "v.table.shape === 'rect' && v.table.w === 1400 && v.table.h === 1200 && Object.values(v.items).filter((it) => it.k === 'g').length === 25";
  for (const [p, n] of both) ok(await P.waitView(p, draughtsOn, null, 30000), `${n}'s screen: a 1400 × 1200 table with a board and 24 men`);
  ok(await P.viewOf(host, "!Object.values(v.items).some((it) => it.k === 'p' || it.k === 'c') && v.rules?.enabled !== true"), 'the table was cleared, and the script switched off');
  ok(await P.waitView(host, `v.players[me].seatId === 'light' && v.players[a].seatId === 'dark'`, bob.pid), 'Alice sits Light, Bob Dark');
  for (const [p, n] of both) ok(!!(await P.label(p, 'Light — Alice')) && !!(await P.label(p, 'Dark — Bob')), `${n}'s screen labels the seats "Light — Alice" and "Dark — Bob"`);

  // Squares (spec §2g): the 840 × 840 board, an 8 × 8 grid of cell 100 from (20, 20); a man is an 80 × 80 disc.
  let its = await items();
  const boardId = Object.keys(its).find((id) => its[id].z < 0), board = its[boardId];
  const square = (it) => ({ c: Math.floor((it.x + 40 - board.x - 20) / 100), r: Math.floor((it.y + 40 - board.y - 20) / 100) });
  const men = () => Object.entries(its).filter(([, it]) => it.k === 'g' && it.z >= 0);
  const at = (c, r) => men().find(([, it]) => { const s = square(it); return s.c === c && s.r === r; })?.[0];
  const placed = men().map(([, it]) => ({ ...square(it), o: it.owner }));
  const light = placed.filter((m) => m.o === 'seat:light'), dark = placed.filter((m) => m.o === 'seat:dark');
  ok(board.lock && light.length === 12 && dark.length === 12, `the board is locked; 12 men are Light's (seat:light), 12 Dark's (seat:dark) — ${light.length} + ${dark.length}`);
  ok(placed.every((m) => (m.c + m.r) % 2 === 1 && m.c >= 0 && m.c < 8) && new Set(placed.map((m) => `${m.c},${m.r}`)).size === 24,
    'each man is centred on its own dark square');
  ok(light.every((m) => m.r >= 5) && dark.every((m) => m.r <= 2), 'Light\'s men fill the three rows nearest the bottom, Dark\'s the three nearest the top');
  const svg = await host.evaluate((id) => { const s = document.querySelector(`.item[data-id="${id}"] svg.psvg`); return s && { box: s.getAttribute('viewBox'), labels: [...s.querySelectorAll('text')].map((t) => t.textContent).join('') }; }, boardId);
  ok(svg?.box === '0 0 840 840' && [...svg.labels].sort().join('') === '12345678abcdefgh', `the board draws its grid as an SVG, with a–h and 1–8 (${JSON.stringify(svg)})`);

  section('Draughts: the coordinates read upright from both seats (D91)');
  ok(await L.until(async () => P.angDiff((await P.tf(bob)).rot, 180) < 0.01, 10000, 100), 'Bob sits Dark, at the top: his phone\'s view is turned 180°');
  await P.upright(host, boardId, 0, 'Alice (Light, desktop)');
  await P.upright(bob, boardId, 180, 'Bob (Dark, iPhone)');
  {
    const fs = async (p) => Math.min(...(await P.boardTexts(p, boardId)).texts.map((x) => x.fs));
    const grow = await bob.evaluate((id) => getComputedStyle(document.querySelector(`.item[data-id="${id}"] .blabels text`)).scale, boardId);
    const [fa, fb] = [await fs(host), await fs(bob)];
    ok(fb >= 6.5 && +grow > 1, `on Bob's phone the coordinates grow with the badges (scale ${grow}): ${fb.toFixed(1)} px, against ${fa.toFixed(1)} px on Alice's desktop`);
  }

  section('Draughts: Light moves, Dark can\'t touch Light\'s men');
  const m1 = at(2, 5);
  await dragBy(host, m1, 100, -100);
  await L.until(async () => square((await items())[m1]).r !== 5, 10000);
  its = await items();
  ok(square(its[m1]).c === 3 && square(its[m1]).r === 4, `Alice drags her man c3 → d4: it moves one square diagonally (now ${JSON.stringify(square(its[m1]))})`);
  ok(await P.waitView(bob, 'v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id: m1, x: its[m1].x, y: its[m1].y }), 'Bob\'s phone shows it there');
  {
    const victim = at(4, 5), before = its[victim], sent = await P.sentActs(bob), log0 = (await P.viewOf(host, 'v.log.length')), t0 = await P.tf(bob);
    const a = await P.itemXY(bob, victim);
    await P.touchDrag(bob, a, { x: a.x + 30, y: a.y - 36 });
    await h.sleep(800);
    const t1 = await P.tf(bob), now = (await items())[victim];
    ok(Math.abs(t1.px - t0.px - 30) < 2.5 && Math.abs(t1.py - t0.py + 36) < 2.5, `Bob's finger on a light man pans his view (by ${(t1.px - t0.px).toFixed(1)}, ${(t1.py - t0.py).toFixed(1)})`);
    ok(await P.sentActs(bob) === sent && now.x === before.x && now.y === before.y && (await P.viewOf(host, 'v.log.length')) === log0 && !(await P.shows(bob, '#toast')),
      'and sends nothing: the man stays, no log line, no notice');
    await P.clickItem(bob, victim, true);
    await h.sleep(300);
    const cmds = await bob.evaluate(() => [...document.querySelectorAll('#action-bar:not(.hidden) [data-cmd]')].map((b) => b.dataset.cmd));
    ok(await bob.evaluate((id) => document.querySelector(`.item[data-id="${id}"]`).classList.contains('selected'), victim), 'a tap still selects it');
    ok(!cmds.some((c) => ['flip', 'del', 'rl', 'rr', 'hand', 'claim', 'release', 'lock'].includes(c)), `and its bar offers Bob nothing he may not do (${cmds.join(', ') || 'nothing at all: no bar'})`);
    await bob.tap('#view-btn');
  }

  section('Draughts: a jump, and the captured man removed');
  const m2 = at(5, 2);
  await dragBy(bob, m2, -100, 100);
  await settled(m2);
  its = await items();
  ok(square(its[m2]).c === 4 && square(its[m2]).r === 3, `Bob drags his man f6 → e5 on the phone (now ${JSON.stringify(square(its[m2]))})`);
  await P.waitView(host, 'v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id: m2, x: its[m2].x, y: its[m2].y });
  await dragBy(host, m1, 200, -200);
  ok(await L.until(async () => { const s = square((await items())[m1]); return s.c === 5 && s.r === 2; }, 10000), 'Alice jumps d4 → f6 over it');
  await P.clickItem(host, m2);
  await host.waitForSelector('#action-bar:not(.hidden)').catch(() => {});
  const hostCmds = await host.evaluate(() => [...document.querySelectorAll('#action-bar:not(.hidden) [data-cmd]')].map((b) => b.dataset.cmd));
  ok(!hostCmds.includes('del') && !hostCmds.includes('flip'), `the capturer's bar on Dark's man offers no 🗑 (the host is not exempt from the owner check: ${hostCmds.join(', ')})`);
  const logN = await P.viewOf(host, 'v.log.length');
  await host.keyboard.press('Delete');
  await h.sleep(500);
  ok((await items())[m2] && (await P.viewOf(host, 'v.log.length')) === logN, 'and Delete does nothing');
  await host.keyboard.press('Escape');
  await P.clickItem(bob, m2, true);
  await bob.waitForSelector('#action-bar:not(.hidden) [data-cmd="del"]');
  await bob.tap('#action-bar [data-cmd="del"]');
  for (const [p, n] of both) ok(await P.waitView(p, '!v.items[a] && Object.values(v.items).filter((it) => it.k === "g").length === 24', m2), `the captured man is gone from ${n}'s screen (Bob's 🗑): 23 men left`);
  ok(await P.waitView(host, 'v.log.some((e) => e.p === a && /^removed \\S/.test(e.txt))', bob.pid), `logged as Bob's "removed …" (${(await P.viewOf(host, 'v.log.filter((e) => /^removed /.test(e.txt)).map((e) => e.txt)')).join(', ')})`);

  section('Draughts: crowning');
  await P.clickItem(host, m1); // (a double-click toggles the selection twice: start from none)
  await host.keyboard.press('Escape');
  const c1 = await P.itemXY(host, m1);
  await host.mouse.dblclick(c1.x, c1.y);
  for (const [p, n] of both) {
    ok(await p.waitForFunction((id) => document.querySelector(`.item[data-id="${id}"] .plabel`)?.textContent === '♛', m1, { timeout: 15000 }).then(() => true, () => false),
      `Alice double-clicks her man on f6: ${n}'s screen shows it crowned ♛`);
  }
  ok(await P.waitView(bob, 'v.items[a].f === 1', m1), 'its face is the second one (a flip)');
  const m3 = at(3, 2);
  await P.clickItem(bob, m3, true);
  await bob.waitForSelector('#action-bar:not(.hidden) [data-cmd="flip"]');
  await bob.tap('#action-bar [data-cmd="flip"]');
  for (const [p, n] of both) {
    ok(await p.waitForFunction((id) => document.querySelector(`.item[data-id="${id}"] .plabel`)?.textContent === '♛', m3, { timeout: 15000 }).then(() => true, () => false),
      `Bob crowns one of his with the phone's Flip: ♛ on ${n}'s screen`);
  }
  await bob.tap('#view-btn');
  await shot(host, 'demo-draughts-desk');
  await shot(bob, 'demo-draughts-phone');

  section('Backgammon: picked from 🎲, the standard start');
  asked = await pickGame('backgammon', true);
  ok(asked === CONFIRM('Backgammon'), `the host confirms "${asked}"`);
  const bgOn = "v.table.shape === 'rect' && v.table.w === 1800 && v.table.h === 1300 && Object.values(v.items).filter((it) => it.k === 'g').length === 34";
  for (const [p, n] of both) ok(await P.waitView(p, bgOn, null, 30000), `${n}'s screen: a 1800 × 1300 table with a board, 30 checkers, two dice and the cube`);
  ok(await P.waitView(host, `v.players[me].seatId === 'light' && v.players[a].seatId === 'dark'`, bob.pid), 'Alice sits Light (the bottom), Bob Dark');
  its = await items();
  const boxes = await host.evaluate(() => JSON.parse(JSON.stringify(window.__ct.boxes())));
  const typeOf = (it) => { const [b, t] = it.t.split('/'); return boxes[b]?.types[t]; };
  const bg = Object.values(its).find((it) => it.z < 0), bgType = typeOf(bg);
  const tris = bgType.board.spaces.filter((s) => s.mark === 'tri');
  const barSp = bgType.board.spaces.find((s) => s.id === 'bar');
  ok(tris.length === 24 && tris.every((s) => s.w === 100 && s.h === 420) && !!barSp && barSp.mark === 'rect'
    && ['off-light', 'off-dark'].every((id) => bgType.board.spaces.find((s) => s.id === id)?.mark === 'rect'),
  'the 1400 × 1000 board has 24 triangular points (100 × 420), the bar and two trays');
  // The points by place: a row (top or bottom of the board) and a column (0–11, left to right, the bar skipped).
  const rows = { top: tris.filter((s) => s.y < bgType.h / 2).sort((a, b) => a.x - b.x), bottom: tris.filter((s) => s.y > bgType.h / 2).sort((a, b) => a.x - b.x) };
  ok(rows.top.length === 12 && rows.bottom.length === 12 && rows.top.every((s) => s.dir === 'down') && rows.bottom.every((s) => s.dir === 'up'), 'twelve points along each long side, pointing inward');
  ok([...rows.top, ...rows.bottom].every((s, k, a) => k % 12 === 0 || s.color !== a[k - 1].color), 'neighbouring points alternate colours');
  const pointOf = (it) => {
    const cx = it.x + 40 - bg.x, cy = it.y + 40 - bg.y;
    for (const [row, list] of Object.entries(rows)) {
      const k = list.findIndex((s) => Math.abs(cx - s.x) <= s.w / 2 && Math.abs(cy - s.y) <= s.h / 2);
      if (k >= 0) return `${row}${k}`;
    }
    return '?';
  };
  const checkers = Object.values(its).filter((it) => it.owner === 'seat:light' || it.owner === 'seat:dark');
  const count = {};
  for (const it of checkers) { const k = `${it.owner.slice(5)} ${pointOf(it)}`; count[k] = (count[k] || 0) + 1; }
  // The standard start (TABLETOP's demo; the usual layout): each side 2 on its 24-point, 5 on its 13, 3 on its 8 and 5 on its 6,
  // the two sides mirrored. With Light's home board on the right: Light's 24 is the top right point, 13 the top left,
  // 8 the fifth from the left at the bottom, 6 the seventh (by the bar); Dark the same, top and bottom swapped.
  const start = (m) => ({ [`light top${m(11)}`]: 2, [`light top${m(0)}`]: 5, [`light bottom${m(4)}`]: 3, [`light bottom${m(6)}`]: 5,
    [`dark bottom${m(11)}`]: 2, [`dark bottom${m(0)}`]: 5, [`dark top${m(4)}`]: 3, [`dark top${m(6)}`]: 5 });
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  ok(checkers.length === 30 && checkers.filter((c) => c.owner === 'seat:light').length === 15 && (same(count, start((c) => c)) || same(count, start((c) => 11 - c))),
    `15 + 15 checkers, seat-bound, in the standard start (${JSON.stringify(count)})`);
  const dice = Object.keys(its).filter((id) => typeOf(its[id])?.kind === 'die').sort();
  const [d0, d1] = dice.map((id) => its[id]);
  ok(dice.length === 2 && Math.abs(d0.y - d1.y) < 1 && Math.abs(d0.x - d1.x) <= 56 * 2, `two dice side by side (${d0 && `${d0.x},${d0.y}`} and ${d1 && `${d1.x},${d1.y}`})`);
  const CUBE = '["64","2","4","8","16","32"]', cubeId = Object.keys(its).find((id) => JSON.stringify(typeOf(its[id])?.faces.map((f) => f.label)) === CUBE), cubeType = cubeId && typeOf(its[cubeId]);
  ok(cubeType?.kind === 'token' && its[cubeId].f === 0,
    `the doubling cube is a token with the faces 64, 2, 4, 8, 16, 32 (${JSON.stringify(cubeType && { kind: cubeType.kind, faces: cubeType.faces.map((f) => f.label) })})`);
  await shot(host, 'demo-backgammon-start-desk');

  section('Backgammon: a double-click on one die rolls both');
  /** Records, on page p, the item ids that get the .tumble class from now on. */
  const watchTumble = (p) => p.evaluate(() => {
    window.__tumbled = new Set();
    new MutationObserver((ms) => { for (const m of ms) if (m.target.classList?.contains('tumble')) window.__tumbled.add(m.target.closest('.item')?.dataset.id); })
      .observe(document.getElementById('table'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  for (const [p] of both) await watchTumble(p);
  const rolls = async () => (await P.viewOf(host, 'v.log')).filter((e) => /^rolled /.test(e.txt));
  const r0 = (await rolls()).length;
  await P.clickItem(host, dice[0]);
  await host.keyboard.press('Escape');
  const dc = await P.itemXY(host, dice[0]);
  await host.mouse.dblclick(dc.x, dc.y);
  ok(await L.until(async () => (await rolls()).length === r0 + 1, 10000), 'Alice double-clicks one die: one roll');
  await h.sleep(600);
  let line = (await rolls()).pop(), faces = await P.viewOf(host, 'a.map((id) => v.items[id].f + 1)', dice);
  ok(new RegExp(`^rolled ${faces[0]} · ${faces[1]}$`).test(line.txt) && line.p === host.pid && (await rolls()).length === r0 + 1,
    `logged once, "${line.txt}": both dice, in id order (faces ${faces.join(', ')})`);
  for (const [p, n] of both) {
    ok(await P.waitView(p, 'a.f.every((f, k) => v.items[a.ids[k]].f === f - 1)', { ids: dice, f: faces }), `${n}'s screen shows the same faces`);
    const tumbled = await p.evaluate(() => [...window.__tumbled]);
    ok(dice.every((id) => tumbled.includes(id)), `both dice tumble on ${n}'s screen (${tumbled.length} items)`);
  }
  for (const [p] of both) await watchTumble(p);
  await P.clickItem(bob, dice[1], true);
  await bob.waitForSelector('#action-bar:not(.hidden) [data-cmd="roll"]');
  await bob.tap('#action-bar [data-cmd="roll"]');
  ok(await L.until(async () => (await rolls()).length === r0 + 2, 10000), 'Bob taps the other die and 🎲 Roll on his phone: one more roll');
  await h.sleep(600);
  line = (await rolls()).pop();
  faces = await P.viewOf(host, 'a.map((id) => v.items[id].f + 1)', dice);
  ok(line.p === bob.pid && line.txt === `rolled ${faces[0]} · ${faces[1]}`, `logged as Bob's: "${line.txt}"`);
  for (const [p, n] of both) {
    const tumbled = await p.evaluate(() => [...window.__tumbled]);
    ok(dice.every((id) => tumbled.includes(id)), `both dice tumble on ${n}'s screen again`);
  }
  await bob.tap('#view-btn');

  section('Backgammon: the doubling cube is turned, not rolled');
  const cubeLabel = (p) => p.evaluate((id) => document.querySelector(`.item[data-id="${id}"] .plabel`)?.textContent, cubeId);
  ok(await cubeLabel(host) === '64' && await cubeLabel(bob) === '64', 'the cube starts at 64 (centred: nobody has doubled)');
  await P.clickItem(host, cubeId);
  const cubeCmds = await host.evaluate(() => [...document.querySelectorAll('#action-bar [data-cmd]')].map((b) => b.dataset.cmd));
  ok(!cubeCmds.includes('roll'), `its bar offers no 🎲 Roll (${cubeCmds.join(', ')})`);
  await host.keyboard.press('Escape');
  const cc = await P.itemXY(host, cubeId);
  await host.mouse.dblclick(cc.x, cc.y);
  for (const [p, n] of both) {
    ok(await p.waitForFunction((id) => document.querySelector(`.item[data-id="${id}"] .plabel`)?.textContent === '2', cubeId, { timeout: 15000 }).then(() => true, () => false),
      `a double-click turns it: it reads 2 on ${n}'s screen`);
  }
  ok(await P.waitView(host, 'v.log.some((e) => e.txt === "turned 64 to 2")'), 'logged "turned 64 to 2"');
  // `face` sets a face directly (the CLI's `face`; the bar has no face picker): Bob's own click path.
  ok((await L.act(bob, { t: 'face', id: cubeId, f: 3 })).ok !== false, 'Bob turns it to 8 with `face` {f: 3}');
  for (const [p, n] of both) ok(await p.waitForFunction((id) => document.querySelector(`.item[data-id="${id}"] .plabel`)?.textContent === '8', cubeId, { timeout: 15000 }).then(() => true, () => false), `it reads 8 on ${n}'s screen`);
  await L.act(bob, { t: 'face', id: cubeId, f: 1 });
  for (const [p, n] of both) ok(await p.waitForFunction((id) => document.querySelector(`.item[data-id="${id}"] .plabel`)?.textContent === '2', cubeId, { timeout: 15000 }).then(() => true, () => false), `and back to 2 with {f: 1} on ${n}'s screen`);
  ok(await P.waitView(host, 'v.items[a].f === 1 && v.log.some((e) => e.txt === "turned 8 to 2")', cubeId), 'its face is 1 ("2"), logged "turned 8 to 2"');

  section('Backgammon: a checker to the bar');
  its = await items();
  const darkOn = (pt) => Object.keys(its).filter((id) => its[id].owner === 'seat:dark' && pointOf(its[id]) === pt).sort((a, b) => its[b].z - its[a].z);
  const from = darkOn(count['dark top6'] ? 'top6' : 'top5')[0], it0 = its[from];
  const bx = bg.x + barSp.x, by = bg.y + barSp.y - 220; // on the bar, above the cube
  await dragBy(bob, from, bx - (it0.x + 40), by - (it0.y + 40));
  await settled(from);
  const on = (await items())[from], ccx = on.x + 40 - bg.x, ccy = on.y + 40 - bg.y;
  ok(Math.abs(ccx - barSp.x) <= barSp.w / 2 && Math.abs(ccy - barSp.y) <= barSp.h / 2, `Bob drags a dark checker onto the bar on his phone (its centre at ${ccx.toFixed(0)}, ${ccy.toFixed(0)} on the board)`);
  ok(await host.waitForFunction(([id, x, y]) => { const el = document.querySelector(`.item[data-id="${id}"]`); return !!el && Math.abs(parseFloat(el.style.left) - x) < 0.01 && Math.abs(parseFloat(el.style.top) - y) < 0.01; }, [from, on.x, on.y], { timeout: 10000 }).then(() => true, () => false),
    'Alice\'s screen draws it there');
  await shot(host, 'demo-backgammon-desk');
  await shot(bob, 'demo-backgammon-phone');

  await env.done();
})().catch(h.crash);
