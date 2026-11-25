// Phase 4B fix-up regressions (the reviewers' findings), on real screens —
// a desktop guest (mouse and keyboard), an iPhone 13 (CDP touches), host:
//  1. a selection built by Shift+clicks: its bar docks at the table area's
//     top edge, off the pieces still to pick, so the next click picks (D236,
//     D240); a Shift+click on the bar selects no page text;
//  2. Shift+double-click picks and puts back: nothing flips, rolls or draws;
//  3. 👜 Into bag ▸ with a bag among the picks sends only what a bag takes
//     (no "skipped" notice); 🎲 Roll of 22 dice rolls 20 and says so;
//  4. a piece chosen in the inspector (a crowded spot's member, Take all)
//     ends the group picked before: its own bar, ✥ armed;
//  5. on the phone, ⬚: its chip stands above ⬚, no seat label under ⬚; a
//     tap-tap only picks; a drag that starts on a piece draws a box (D237);
//     a pinch that began as a band leaves no band;
//  6. strict rules that take selections (chess): no group bar either;
//  7. (fix-up 2) picks in the TOP row of the screen — a desktop, and a
//     phone zoomed in: with pieces along the table area's top the bar takes
//     the toolbar's place, else it docks there and the toolbar stays; no
//     piece is ever under it, every click and tap reaches its piece; its
//     buttons wait 400 ms; 🗑 of more than five asks first; a host alone
//     keeps the game strip (D240).
'use strict';
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const { until, view, act } = require('./p1-lib');
const { pickGame } = require('./stones-lib');
const { shown, box, overlap, toasts, shot, tap, press, pinch, badgeAt } = require('./p4s-lib');

const J = JSON.stringify;
/** The test box (original): a 12 × 6 yard of 100-unit cells with two rows of
 *  eight tokens and three pegs crowding one cell; below it a ×6 stack and
 *  22 dice; beside it two bags. */
const BOX = {
  name: 'Corner yard', imgs: [], lockable: 'anyone', table: { shape: 'rect', w: 2000, h: 1400 },
  types: {
    yard: { kind: 'board', name: 'Yard', w: 1200, h: 600, faces: [{ color: '#a3b18a' }], board: { grid: { type: 'square', cols: 12, rows: 6, cell: 100, x: 0, y: 0, draw: 'lines' } } },
    tok: { kind: 'token', name: 'Token', w: 60, faces: [{ color: '#f59e0b', label: 'T' }, { color: '#0ea5e9', label: 'U' }] },
    peg: { kind: 'token', name: 'Peg', shape: 'rect', w: 60, faces: [{ color: '#a855f7', label: 'P' }] },
    die: { kind: 'die', name: 'Die' },
  },
  setup: [
    { piece: 'yard', at: 'center' },
    { piece: 'tok', count: 8, spread: [100, 0], at: [420, 420] }, { piece: 'tok', count: 8, spread: [100, 0], at: [420, 520] },
    { piece: 'peg', count: 3, at: [1420, 420] },
    { piece: 'tok', n: 6, at: [600, 1150] },
    { piece: 'die', count: 22, spread: [70, 0], at: [250, 1280] },
    { bag: ['tok'], name: 'Sack', at: [1700, 300] }, { bag: ['tok'], name: 'Pouch', at: [1700, 560] },
  ],
};
/** The table point at the centre of the yard's cell (c, r). */
const cell = (c, r) => ({ x: 450 + 100 * c, y: 450 + 100 * r });
/** What page p's top element at client point q is: an item's id, 'bar', or another tag. */
const hitAt = (p, q) => p.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el?.closest('#action-bar') ? 'bar' : el?.closest('.item')?.dataset.id || el?.tagName || null; }, [q.x, q.y]);
/** Page p's log lines by player `who` from entry n on. */
const linesBy = async (p, who, n) => (await view(p)).log.slice(n).filter((e) => e.p === who).map((e) => e.txt);

(async () => {
  const env = await h.start();
  const alice = await P3.join(env, 'Alice', env.url);
  const bob = await P3.join(env, 'Bob', alice.url());
  for (const p of [alice, bob]) await toasts(p);
  const r0 = await act(alice, { t: 'loadBox', box: BOX, setup: true, clear: true });
  ok(r0?.ok && await until(async () => Object.keys((await view(bob)).items).length === 45, 15000), `the box is set up on both screens (${J(r0)})`);
  const v = await view(bob), ITEMS = Object.entries(v.items);
  const tokAt = (c, r) => ITEMS.find(([, it]) => it.t?.endsWith('/tok') && !(it.n >= 2) && Math.abs(it.x + 30 - cell(c, r).x) < 1 && Math.abs(it.y + 30 - cell(c, r).y) < 1)?.[0];
  const ROWS = [0, 1].flatMap((r) => Array.from({ length: 8 }, (_, c) => tokAt(c, r)));
  const pegs = ITEMS.filter(([, it]) => it.t?.endsWith('/peg')).map(([id]) => id), stack = ITEMS.find(([, it]) => it.n === 6)[0];
  const dice = ITEMS.filter(([, it]) => it.t?.endsWith('/die')).map(([id]) => id), bag = (n) => ITEMS.find(([, it]) => it.name === n)[0];
  ok(ROWS.every(Boolean) && pegs.length === 3 && dice.length === 22, `found the pieces (16 tokens, ${pegs.length} pegs, ${dice.length} dice)`);
  const XY = (p, id) => P.itemXY(p, id), shift = async (p, fn) => { await p.keyboard.down('Shift'); try { await fn(); } finally { await p.keyboard.up('Shift'); } };

  section('1. desktop: Shift+clicks build a selection; its bar docks at the table area\'s top edge, clear of every piece, and the next click picks (D236, D240)');
  await shift(bob, async () => { await tap(bob, await XY(bob, tokAt(0, 1))); await tap(bob, await XY(bob, tokAt(1, 1))); });
  let s = await shown(bob);
  const bar = await box(bob, '#action-bar'), wrap = await box(bob, '#table-wrap');
  ok(J(s.ids.sort()) === J([tokAt(0, 1), tokAt(1, 1)].sort()) && /^2 selected/.test(s.bar), `two picked, the group bar ("${s.bar.slice(0, 30)}")`);
  ok(bar && bar.t - wrap.t < 12, `the bar stands at the table area's top edge (${Math.round(bar.t - wrap.t)} px below it), no piece drawn there`);
  const under = [];
  for (const id of ROWS) if ((await hitAt(bob, await XY(bob, id))) !== id) under.push(id);
  ok(!under.length, `no token is under the bar: a click on each reaches it (${under.length} covered)`);
  await shift(bob, async () => tap(bob, await XY(bob, tokAt(1, 0))));
  s = await shown(bob);
  ok(s.ids.length === 3 && s.ids.includes(tokAt(1, 0)), `the token above the picks is picked by the next click, not a button (${s.ids.length} picked)`);
  const gn = await bob.evaluate(() => { const r = document.querySelector('#action-bar .gn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await shift(bob, async () => bob.mouse.click(gn.x, gn.y));
  ok((await bob.evaluate(() => String(getSelection()))) === '', 'a Shift+click on the bar selects no text of the page');
  await shot(bob, 'p4-fix-desktop-dock');

  section('2. desktop: Shift+double-click picks and puts back — no flip, no roll');
  await bob.keyboard.press('Escape');
  let n0 = (await view(alice)).log.length;
  const t2 = tokAt(2, 0), f0 = (await view(alice)).items[t2].f;
  await shift(bob, async () => { const q = await XY(bob, t2); await bob.mouse.dblclick(q.x, q.y); const d = await XY(bob, dice[0]); await bob.mouse.dblclick(d.x, d.y); });
  await h.sleep(1200);
  ok((await view(alice)).items[t2].f === f0 && !(await linesBy(alice, bob.pid, n0)).some((l) => /^(flipped|rolled)/.test(l)), `nothing flipped or rolled (${J(await linesBy(alice, bob.pid, n0))})`);
  ok((await shown(bob)).ids.length === 0, 'each was picked and put back');

  section('3. desktop: 👜 Into bag ▸ with a bag among the picks; 🎲 Roll of 22 dice');
  n0 = (await view(alice)).log.length;
  await shift(bob, async () => { for (const id of [tokAt(3, 1), tokAt(4, 1), bag('Sack')]) await tap(bob, await XY(bob, id)); });
  ok((await shown(bob)).ids.length === 3, 'two tokens and the bag Sack picked');
  await bob.click('#action-bar [data-cmd="bag"]');
  await bob.click(`#action-bar [data-cmd="bagTo"][data-to="${bag('Pouch')}"]`);
  ok(await until(async () => (await linesBy(alice, bob.pid, n0)).includes('put 2 items into the bag Pouch'), 8000), `"put 2 items into the bag Pouch" (${J(await linesBy(alice, bob.pid, n0))})`);
  await h.sleep(500);
  ok(!(await bob.evaluate(() => window.__toasts.some((t) => /skipped/.test(t)))), 'and no "skipped" notice: the bag itself was never sent');
  await bob.keyboard.press('Escape');
  const [d0, d1] = await Promise.all([P3.screenOf(bob, 200, 1240), P3.screenOf(bob, 1800, 1370)]);
  await P.mouseDrag(bob, d0, d1, { shift: true });
  s = await shown(bob);
  ok(s.ids.length === 22 && /🎲 Roll/.test(s.bar), `a band picks the 22 dice (${s.ids.length})`);
  n0 = (await view(alice)).log.length;
  await bob.click('#action-bar [data-cmd="roll"]');
  ok(/^20 dice at most: 2 left out$/.test((await shown(bob)).chip), `the chip: "${(await shown(bob)).chip}"`);
  ok(await until(async () => (await linesBy(alice, bob.pid, n0)).some((l) => /^rolled 20 dice: /.test(l)), 8000), 'twenty rolled, in one line');
  await h.sleep(500);
  ok(!(await bob.evaluate(() => window.__toasts.some((t) => /Roll 1 to/.test(t)))), 'no refusal');

  section('4. desktop: a piece chosen in the inspector ends the group picked before');
  await bob.keyboard.press('Escape');
  const pick2 = () => shift(bob, async () => { await tap(bob, await XY(bob, tokAt(5, 1))); await tap(bob, await XY(bob, tokAt(6, 1))); });
  await pick2();
  ok((await shown(bob)).ids.length === 2, 'two tokens picked');
  await bob.evaluate(() => { const r = document.querySelector('#table .item .fanb').getBoundingClientRect(); window.__fanb = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await tap(bob, await bob.evaluate(() => window.__fanb));
  ok(await until(() => bob.evaluate(() => document.querySelectorAll('#inspector li[data-id]').length === 3), 5000), "the crowded cell's three pegs are listed");
  const row = await bob.evaluate(() => document.querySelector('#inspector li[data-id]').dataset.id);
  await bob.click('#inspector li[data-id]');
  s = await shown(bob);
  ok(J(s.ids) === J([row]) && s.bar && !/selected/.test(s.bar), `that peg is the selection, with its own bar ("${s.bar.slice(0, 30)}")`);
  await bob.keyboard.press('Escape');
  await pick2();
  await tap(bob, await badgeAt(bob, stack, 'count'));
  ok(await until(() => bob.evaluate(() => !!document.querySelector('#inspector [data-ins="all"]')), 5000), 'the ×6 stack\'s inspector');
  await bob.click('#inspector [data-ins="all"]');
  s = await shown(bob);
  ok(J(s.ids) === J([stack]) && await bob.evaluate(() => !!document.querySelector('#action-bar button.on[data-cmd="all"]')), `Take all: the stack is the selection, ✥ armed ("${s.bar.slice(0, 30)}")`);
  await bob.keyboard.press('Escape');

  section('5. the phone: ⬚ — the chip above it, no seat label under it; a tap-tap picks only; a drag from a piece draws a box (D237); a pinch leaves no band');
  const carol = await P3.join(env, 'Carol', alice.url(), { ctx: P.PHONE });
  ok(await until(async () => Object.keys((await view(carol)).items).length > 40, 15000), 'Carol (an iPhone, upright) sees the table');
  await pinch(carol, await P3.screenOf(carol, cell(3, 0).x, cell(3, 0).y), 60, 260);
  await h.sleep(400);
  await carol.tap('#sel-mode');
  const [chipB, modeB] = [await box(carol, '#sel-chip'), await box(carol, '#sel-mode')];
  ok(chipB && chipB.b <= modeB.t && /drag a box/.test((await shown(carol)).chip), `the chip stands above ⬚ ("${(await shown(carol)).chip}")`);
  const labels = await carol.evaluate(() => [...document.querySelectorAll('.seat')].map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, text: el.textContent }; }));
  ok(labels.length && !labels.some((l) => overlap(l, modeB)), `no seat label under ⬚ (${J(labels.map((l) => l.text))})`);
  await shot(carol, 'p4-fix-iphone-corner');
  n0 = (await view(alice)).log.length;
  const t21 = tokAt(2, 1), q21 = await XY(carol, t21), g0 = (await view(alice)).items[t21].f;
  await carol.touchscreen.tap(q21.x, q21.y);
  await carol.touchscreen.tap(q21.x, q21.y);
  await h.sleep(1200);
  ok((await view(alice)).items[t21].f === g0 && !(await linesBy(alice, carol.pid, n0)).length && !(await shown(carol)).ids.includes(t21), `a tap-tap picks and puts back, and flips nothing (${J(await linesBy(alice, carol.pid, n0))})`);
  // (Carol's view is turned — her seat at the bottom — by no right angle: the box is drawn on the screen around the four
  // as they are drawn, from a point on the first one, away from the other three, to as far beyond them)
  // (cells (3, 1) and (4, 1) went into the Pouch)
  const box4 = [tokAt(5, 0), tokAt(6, 0), tokAt(5, 1), tokAt(6, 1)], c4 = await Promise.all(box4.map((id) => XY(carol, id)));
  const t40 = box4[0], at40 = (await view(alice)).items[t40], mid3 = { x: (c4[1].x + c4[2].x + c4[3].x) / 3, y: (c4[1].y + c4[2].y + c4[3].y) / 3 };
  const away = { x: Math.sign(c4[0].x - mid3.x), y: Math.sign(c4[0].y - mid3.y) }, xs = c4.map((q) => q.x), ys = c4.map((q) => q.y);
  const from = { x: c4[0].x + 12 * away.x, y: c4[0].y + 12 * away.y }, to = { x: (away.x > 0 ? Math.min(...xs) : Math.max(...xs)) - 30 * away.x, y: (away.y > 0 ? Math.min(...ys) : Math.max(...ys)) - 30 * away.y };
  ok((await hitAt(carol, from)) === t40, 'the drag starts on the token');
  await P.touchDrag(carol, from, to);
  s = await shown(carol);
  ok(box4.every((id) => s.ids.includes(id)), `a drag that starts on a token draws a box: the four in it picked (${s.ids.length})`);
  await h.sleep(500);
  const now40 = (await view(alice)).items[t40];
  ok(now40.x === at40.x && now40.y === at40.y && (await view(alice)).items[t40].n === undefined, 'and that token never moved, nor was split');
  // (the felt in the middle of the screen: one finger draws a band from it, then a second lands — a pinch)
  await carol.tap('#action-bar [data-cmd="none"]');
  const cdp = await carol.context().newCDPSession(carol), felt = await P.feltPoint(carol, { band: [0.35, 0.6] });
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  await touch('touchStart', [{ x: felt.x, y: felt.y, id: 1 }]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [{ x: felt.x - 5 * k, y: felt.y + 5 * k, id: 1 }]);
  const mid = await carol.evaluate(() => !document.getElementById('band').classList.contains('hidden'));
  await touch('touchStart', [{ x: felt.x - 30, y: felt.y + 30, id: 1 }, { x: felt.x - 90, y: felt.y + 100, id: 2 }]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [{ x: felt.x - 30 + 3 * k, y: felt.y + 30 - 3 * k, id: 1 }, { x: felt.x - 90 - 3 * k, y: felt.y + 100 + 3 * k, id: 2 }]);
  await touch('touchEnd', []);
  await cdp.detach();
  await h.sleep(300);
  ok(mid && await carol.evaluate(() => document.getElementById('band').classList.contains('hidden')), `a band drawn by one finger (${mid}) is gone once a second finger made it a pinch`);
  await carol.tap('#sel-mode');

  section('6. chess (strict, it takes selections): Shift+clicks pick, and no group bar offers what it would refuse');
  await pickGame(alice, 'chess');
  await until(async () => Object.values((await view(alice)).items).filter((it) => it.at).length === 32, 20000);
  const seated = await P.viewOf(alice, 'Object.fromEntries(Object.entries(v.players).map(([p, pl]) => [p, pl.seatId ?? null]))');
  const W = [alice, bob, carol].find((p) => seated[p.pid]), who = W === alice ? 'Alice' : W === bob ? 'Bob' : 'Carol';
  ok(!!W && await until(async () => Object.values((await view(W)).items).filter((it) => it.at).length === 32, 20000), `chess runs; ${who} sits as ${seated[W?.pid]}`);
  const mine = Object.entries((await view(W)).items).filter(([, it]) => it.owner === `seat:${seated[W.pid]}`).map(([id]) => id).slice(0, 2);
  if (W === carol) { // (the phone picks with ⬚ and taps)
    await carol.tap('#sel-mode');
    for (const id of mine) await tap(carol, await XY(carol, id), true);
  } else await shift(W, async () => { for (const id of mine) await tap(W, await XY(W, id)); });
  s = await shown(W);
  ok(s.ids.length === 2 && s.bar === '', `${who} picks two of ${seated[W.pid]}'s pieces; no bar (${J(s.bar)})`);

  section('7. picks in the top row of the screen, on a desktop and a zoomed phone: no piece under the docked bar (over the toolbar when pieces line the top), every click and tap reaches its piece; its buttons wait 400 ms; 🗑 of six asks first (D240)');
  // (a game laid out to the table's rim: six rows of nine tokens from its top edge)
  const RIM = {
    name: 'Rim rows', imgs: [], table: { shape: 'rect', w: 1300, h: 1000 },
    types: { tok: { kind: 'token', name: 'Token', w: 60, faces: [{ color: '#f59e0b', label: 'T' }, { color: '#0ea5e9', label: 'U' }] } },
    setup: Array.from({ length: 6 }, (_, r) => ({ piece: 'tok', count: 9, spread: [120, 0], at: [70, 30 + 100 * r] })),
  };
  await act(alice, { t: 'setRules', enabled: false });
  await act(alice, { t: 'loadBox', box: RIM, setup: true, clear: true });
  ok(await until(async () => (await Promise.all([alice, bob, carol].map(view))).every((w) => !w.rules?.enabled && Object.keys(w.items).length === 54), 15000), 'the rim rows are set up on every screen, chess off');
  /** Page p's items drawn in its table area (clear of its edges, ⬚'s corner and the bottom label): {id: {x, y}} (client px). */
  const onScreen = (p) => p.evaluate(() => {
    const w = document.getElementById('table-wrap').getBoundingClientRect(), out = {};
    for (const el of document.querySelectorAll('#table .item')) {
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x > w.left + 20 && x < w.right - 20 && y > w.top + 10 && y < w.bottom - 70) out[el.dataset.id] = { x, y };
    }
    return out;
  });
  /** Items `c` (onScreen's) in rows as drawn, top first, each left to right: [[{id, x, y}]]. */
  const rowsOf = (c) => {
    const rr = [];
    for (const [id, q] of Object.entries(c).sort((a, b) => a[1].y - b[1].y)) {
      const row = rr.find((r) => Math.abs(r[0].y - q.y) < 15);
      if (row) row.push({ id, ...q }); else rr.push([{ id, ...q }]);
    }
    return rr.map((r) => r.sort((a, b) => a.x - b.x));
  };
  /** The items on page p's screen whose centre lies under the action bar (a click there would press it). */
  const underBar = (p) => p.evaluate(() => [...document.querySelectorAll('#table .item')].filter((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#action-bar');
  }).map((el) => el.dataset.id));
  /** Whether page p's action bar is docked over the toolbar: inside its box, off the table area. */
  const overToolbar = async (p) => { const [b, t, w] = [await box(p, '#action-bar'), await box(p, '#toolbar'), await box(p, '#table-wrap')]; return !!b && b.t >= t.t - 1 && b.b <= t.b + 1 && b.b <= w.t + 1; };
  /** Whether page p's action bar stands at the table area's top edge. */
  const atTop = async (p) => { const [b, w] = [await box(p, '#action-bar'), await box(p, '#table-wrap')]; return !!b && b.t >= w.t && b.t - w.t < 70; };
  /** The toolbar's buttons on page p that a click at their centre doesn't reach. */
  const toolbarBlocked = (p) => p.evaluate(() => [...document.querySelectorAll('#toolbar > button:not(.hidden)')].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== b && !b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }).map((b) => b.id));
  // Alice (the host, seated at the bottom): the rows reach her screen's top edge — the bar takes the toolbar's place
  await alice.evaluate(() => { // (the bar's buttons, as they turn off and on: [performance.now(), disabled])
    window.__arm = [];
    new MutationObserver((ms) => { for (const m of ms) window.__arm.push([performance.now(), m.target.disabled]); })
      .observe(document.getElementById('action-bar'), { subtree: true, attributes: true, attributeFilter: ['disabled'] });
  });
  const rr = rowsOf(await onScreen(alice)), top = rr[0], mc = Math.floor(top.length / 2), aw = await box(alice, '#table-wrap');
  ok(rr.length >= 6 && top.length >= 6 && top[0].y - aw.t < 90, `Alice's screen shows the rows, the top one ${Math.round(top[0].y - aw.t)} px below the table area's top (${rr.map((r) => r.length)})`);
  await alice.keyboard.down('Shift');
  await tap(alice, top[mc - 1]);
  await until(() => alice.evaluate(() => window.__arm.length > 0 && [...document.querySelectorAll('#action-bar button')].every((b) => !b.disabled)), 3000, 50);
  const arm = await alice.evaluate(() => window.__arm), off = arm.find((e) => e[1]), on = off && arm.findLast((e) => !e[1]);
  ok(await overToolbar(alice) && off && on && on[0] - off[0] >= 390, `one Shift+click: tokens lie along the table area's top, so the bar docks over the toolbar, its buttons held off ${on && off ? Math.round(on[0] - off[0]) : '?'} ms, then live`);
  await tap(alice, top[mc]);
  await tap(alice, top[mc + 1]);
  s = await shown(alice);
  ok(s.ids.length === 3 && await overToolbar(alice), `three picked in the top row of the screen; the bar still over the toolbar ("${s.bar.slice(0, 30)}")`);
  ok(!(await underBar(alice)).length, `no token lies under it (${J(await underBar(alice))})`);
  await tap(alice, top[mc + 2]);
  await tap(alice, rr[1][mc]);
  s = await shown(alice);
  ok(s.ids.length === 5 && s.ids.includes(top[mc + 2].id) && s.ids.includes(rr[1][mc].id), `the next Shift+clicks — in the top row, and in the row below — each pick their token (${s.ids.length} picked)`);
  await shot(alice, 'p4-fix2-desktop-toolbar');
  await tap(alice, rr[1][mc + 1]);
  await alice.keyboard.up('Shift');
  const six = (await shown(alice)).ids;
  n0 = (await view(alice)).log.length;
  await alice.click('#action-bar [data-cmd="del"]');
  await h.sleep(700);
  const still = (await view(alice)).items;
  ok(six.length === 6 && /🗑 Remove 6\?/.test((await shown(alice)).bar) && six.every((id) => !!still[id]), `🗑 of six picked asks first: "${(await shown(alice)).bar.slice(-12)}"; nothing removed`);
  await alice.click('#action-bar [data-cmd="del"]');
  ok(await until(async () => { const w = await view(alice); return six.every((id) => !w.items[id]); }, 8000) && (await linesBy(alice, alice.pid, n0)).includes('removed 6 items'), `its second press removes them: ${J(await linesBy(alice, alice.pid, n0))}`);
  ok(!(await toolbarBlocked(alice)).length, `the selection gone, the toolbar is back (${J(await toolbarBlocked(alice))} covered)`);

  // Bob (seated at a side: his view turns the table, its rim along his screen's top): the bar docks there, the toolbar stays his
  const br = rowsOf(await onScreen(bob)), bw = await box(bob, '#table-wrap');
  ok(br[0][0].y - bw.t > 90, `Bob's top row is ${Math.round(br[0][0].y - bw.t)} px below the table area's top`);
  await shift(bob, async () => { await tap(bob, br[0][1]); await tap(bob, br[0][2]); });
  s = await shown(bob);
  ok(s.ids.length === 2 && await atTop(bob) && !(await underBar(bob)).length, `two picked: the bar stands at the table area's top edge, over no token ("${s.bar.slice(0, 30)}")`);
  ok(!(await toolbarBlocked(bob)).length, `and every toolbar button is still his to click (${J(await toolbarBlocked(bob))} covered)`);
  await shot(bob, 'p4-fix2-desktop-top');
  await shift(bob, async () => tap(bob, br[1][1]));
  ok((await shown(bob)).ids.length === 3 && await atTop(bob), 'the next Shift+click picks a third; the bar has not moved');
  await bob.keyboard.press('Escape');

  // Carol's phone, zoomed in on the rows (a finger's size) and panned to bring them to the top of her screen: ⬚, two
  // picks in the middle, then taps on the token highest on the screen and on the lowest
  await carol.tap('#view-btn'); // (🧭: her seat's view, the whole table)
  await h.sleep(400);
  const cw = await box(carol, '#table-wrap'), c0 = Object.values(await onScreen(carol));
  await pinch(carol, { x: c0.reduce((t, q) => t + q.x, 0) / c0.length, y: c0.reduce((t, q) => t + q.y, 0) / c0.length }, 60, 160);
  await h.sleep(400);
  const hi = await carol.evaluate(() => Math.min(...[...document.querySelectorAll('#table .item')].map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; })));
  const fp = await P.feltPoint(carol, { band: [0.05, 0.45] });
  await P.touchDrag(carol, fp, { x: fp.x, y: fp.y - (hi - cw.t - 35) }, 12); // (a finger on the felt pans: the rows rise to the top edge)
  await h.sleep(400);
  await carol.tap('#sel-mode');
  const cs = Object.entries(await onScreen(carol)).map(([id, q]) => ({ id, ...q })), cy = (cw.t + cw.b) / 2;
  const near = [...cs].sort((a, b) => Math.hypot(a.x - (cw.l + cw.r) / 2, a.y - cy) - Math.hypot(b.x - (cw.l + cw.r) / 2, b.y - cy)).slice(0, 2);
  for (const q of near) await tap(carol, q, true);
  ok((await shown(carol)).ids.length === 2 && await overToolbar(carol), `Carol taps two tokens in the middle of her screen (${cs.length} on it): the bar docks over the toolbar`);
  ok(!(await underBar(carol)).length, `no token on her screen lies under it (${J(await underBar(carol))})`);
  const highest = cs.filter((q) => !near.includes(q)).sort((a, b) => a.y - b.y)[0], lowest = cs.filter((q) => !near.includes(q)).sort((a, b) => b.y - a.y)[0];
  await tap(carol, highest, true);
  await tap(carol, lowest, true);
  s = await shown(carol);
  ok(highest.y - cw.t < 80 && s.ids.length === 4 && s.ids.includes(highest.id) && s.ids.includes(lowest.id), `a tap on the token highest on her screen (${Math.round(highest.y - cw.t)} px below the table area's top) and on the lowest each pick theirs (${s.ids.length})`);
  await shot(carol, 'p4-fix2-iphone-toolbar');
  await press(carol, '#action-bar [data-cmd="none"]', true);
  ok((await shown(carol)).ids.length === 0 && await carol.evaluate(() => document.getElementById('action-bar').classList.contains('hidden')), '✕ (first in the docked bar) clears them: the toolbar is back');
  await carol.tap('#sel-mode');

  // a host alone at a fresh table has the "What are we playing?" strip at the table's top: picking never covers it
  const dan = await P3.join(env, 'Dan', env.url);
  await act(dan, { t: 'loadBox', box: RIM, setup: true, clear: true });
  ok(await until(async () => Object.keys((await view(dan)).items).length === 54 && await dan.evaluate(() => !document.getElementById('game-strip').classList.contains('hidden')), 15000), 'Dan, alone at a table of his own, has its game strip');
  const dr = rowsOf(await onScreen(dan));
  await shift(dan, async () => { await tap(dan, dr[1][3]); await tap(dan, dr[1][4]); });
  const blocked = await dan.evaluate(() => {
    const sr = document.getElementById('game-strip').getBoundingClientRect();
    return [...document.querySelectorAll('#game-strip button')].map((b) => { const r = b.getBoundingClientRect(); return [b.textContent.trim(), r.left + r.width / 2, r.top + r.height / 2]; })
      .filter(([, x]) => x > sr.left && x < sr.right).filter(([, x, y]) => !document.elementFromPoint(x, y)?.closest('#game-strip')).map(([t]) => t);
  });
  ok((await shown(dan)).ids.length === 2 && !(await underBar(dan)).length && !blocked.length, `two picked: the bar (${await overToolbar(dan) ? 'over the toolbar' : 'below the strip'}) covers no token, and a click on each of the strip's buttons still reaches it (${J(blocked)} covered)`);
  await env.done();
})().catch(h.crash);
