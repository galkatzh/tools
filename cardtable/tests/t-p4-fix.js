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
//     keeps the game strip (D240);
//  8. (fix-up 3) the bar docked in the table area is one row, never deeper
//     than the strip found clear (a phone's wide group bar, a ⬚ single
//     pick); "🗑 Remove 8?" whole on the screen; another player's move of a
//     piece into the strip or out of it re-docks the bar, held off as it
//     jumps (D245);
//  9. (fix-up 4) the row keeps what it shows in sight: an opened 👜 Into
//     bag ▸ list; "🗑 Remove 8?" as the bar re-docks; then back where the
//     player left it, its scrolled-off start faded; on a desktop a wheel over
//     the bar scrolls it (no zoom), over the inspector zooms nothing, and a
//     wheel zoom with a piece's bar open lays the page out only at its rest;
//     other players' moves away from the strip don't make the bar look over
//     the whole table (perf.dockScans) (D247, D248).
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

  section('8. (fix-up 3) the bar docked in the table area is ONE row, never deeper than the strip found clear: a phone\'s wide group bar and a piece\'s bar picked by ⬚ cover no token of the row below; "🗑 Remove 8?" in sight; a piece another player moves into the strip, or out, re-docks the bar, held off as it jumps (D245)');
  // (Eve, a host alone on an iPhone 13 held upright: a table seen whole, its top rim clear; a row of eight tokens drawn
  // just below the strip the bar docks in, three tokens, two dice and a bag lower down)
  const WRAP = {
    name: 'Wrap rows', imgs: [], lockable: 'anyone', table: { shape: 'rect', w: 1300, h: 1000 },
    types: { tok: { kind: 'token', name: 'Token', w: 60, faces: [{ color: '#f59e0b', label: 'T' }, { color: '#0ea5e9', label: 'U' }] }, die: { kind: 'die', name: 'Die' } },
    setup: [
      { piece: 'tok', count: 8, spread: [150, 0], at: [60, 500] }, { piece: 'tok', count: 3, spread: [100, 0], at: [450, 700] },
      { piece: 'die', count: 2, spread: [100, 0], at: [450, 820] }, { bag: ['tok'], name: 'Sack', at: [1100, 850] },
    ],
  };
  const eve = await P3.join(env, 'Eve', env.url, { ctx: P.PHONE });
  await act(eve, { t: 'loadBox', box: WRAP, setup: true, clear: true });
  ok(await until(async () => Object.keys((await view(eve)).items).length === 14, 15000), 'Eve (a phone, upright, alone) sets up the box');
  const ev = Object.entries((await view(eve)).items).map(([id, it]) => ({ id, ...it }));
  const erow = ev.filter((it) => it.y === 500), etok = ev.filter((it) => it.y === 700).map((it) => it.id), epick = [...etok, ...ev.filter((it) => it.t?.endsWith('/die')).map((it) => it.id)];
  // (the row's screen boxes as placeBar sees them — centre ± 0.6 × 60 units — wholly below the strip: their tops 3 px under it)
  const ew = await box(eve, '#table-wrap'), stripTop = await eve.evaluate(() => { const s = document.getElementById('game-strip'); return s.classList.contains('hidden') ? 4 : s.offsetTop + s.offsetHeight + 4; });
  const [o0, o1] = [await P3.screenOf(eve, 0, 0), await P3.screenOf(eve, 0, 1000)], sc = (o1.y - o0.y) / 1000;
  const rowY = Math.round((ew.t + stripTop + 63 + 36 * sc - o0.y) / sc - 30);
  for (const t of erow) await act(eve, { t: 'move', id: t.id, x: t.x, y: rowY });
  await until(async () => { const w = await view(eve); return erow.every((t) => w.items[t.id].y === rowY); }, 8000);
  await h.sleep(400);
  const rowAt = await Promise.all(erow.map((t) => P3.centreOf(eve, t.id)));
  ok(Math.abs(o1.x - o0.x) < 1 && rowAt.every((q) => q.y - ew.t > stripTop + 60 && q.y - ew.t < stripTop + 110), `the row is drawn ${Math.round(rowAt[0].y - ew.t)} px below the table area's top, under the strip the bar docks in (${stripTop}–${stripTop + 60} px)`);
  /** Whether page p's bar is one row in the table area, at most the strip deep: {ok, h, t} (px, from the table area's top). */
  const oneRow = async (p, top) => { const [b, w] = [await box(p, '#action-bar'), await box(p, '#table-wrap')]; return { ok: !!b && b.t >= w.t && b.b - w.t <= top + 60, h: b && Math.round(b.b - b.t), t: b && Math.round(b.t - w.t) }; };
  const rowHits = async () => { const out = []; for (const [k, t] of erow.entries()) out.push((await hitAt(eve, rowAt[k])) === t.id); return out; };
  await eve.tap('#sel-mode');
  for (const id of epick) await tap(eve, await P3.centreOf(eve, id), true);
  s = await shown(eve);
  let r1 = await oneRow(eve, stripTop);
  ok(s.ids.length === 5 && /🎲 Roll/.test(s.bar) && /Into bag/.test(s.bar) && !(await overToolbar(eve)), `five picked with ⬚ (dice, a bag on the table): the bar docks in the table area ("${s.bar.slice(0, 60)}")`);
  ok(r1.ok && r1.h <= 54, `in one row, ${r1.h} px tall at ${r1.t} px: within the strip found clear (it wrapped into two rows, 102 px, before)`);
  ok(await eve.evaluate(() => { const b = document.getElementById('action-bar'); return b.scrollWidth > b.clientWidth && b.classList.contains('more'); }), 'wider than the screen: it scrolls sideways, its end faded');
  ok(!(await underBar(eve)).length && (await rowHits()).every(Boolean), `no token under it: a tap on each of the row reaches it (${J(await underBar(eve))} covered)`);
  await shot(eve, 'p4-fix3-iphone-row');
  await press(eve, '#action-bar [data-cmd="bag"]', true);
  r1 = await oneRow(eve, stripTop);
  ok(/👜 Sack/.test((await shown(eve)).bar) && r1.ok && !(await underBar(eve)).length, `👜 Into bag ▸ opens its list in the same row (${r1.h} px tall), over no token`);
  // three of the row join: eight picked, 🗑 asks — the question scrolled into sight, unfaded
  for (const k of [0, 1, 2]) await tap(eve, rowAt[k], true);
  s = await shown(eve);
  ok(s.ids.length === 8, `three of the row picked by their taps: eight (${s.ids.length})`);
  await press(eve, '#action-bar [data-cmd="del"]', true);
  const ask = await eve.evaluate(() => { const b = document.getElementById('action-bar'), d = b.querySelector('[data-cmd="del"]').getBoundingClientRect(); return { text: b.querySelector('[data-cmd="del"]').textContent, l: d.left, r: d.right, vw: innerWidth, more: b.classList.contains('more'), n: Object.keys(window.__ct.view().items).length }; });
  ok(ask.text === '🗑 Remove 8?' && ask.l >= 0 && ask.r <= ask.vw - 4 && !ask.more && ask.n === 14, `🗑 asks "${ask.text}", the whole of it on the screen (x ${Math.round(ask.l)}–${Math.round(ask.r)} of ${ask.vw}), not faded; nothing removed`);
  await shot(eve, 'p4-fix3-iphone-ask');
  await press(eve, '#action-bar [data-cmd="none"]', true);
  // one token of a lockable box picked with ⬚: its own bar (Flip ⟲ ⟳ 🔒 Lock 👤 Claim 🗑 ✕) docks in one row too
  await tap(eve, await P3.centreOf(eve, etok[1]), true);
  s = await shown(eve);
  r1 = await oneRow(eve, stripTop);
  ok(s.ids.length === 1 && /Flip/.test(s.bar) && /Claim/.test(s.bar) && /✕/.test(s.bar) && r1.ok && r1.h <= 54 && !(await underBar(eve)).length, `one token picked with ⬚: its bar ("${s.bar}") is one row, ${r1.h} px tall, over no token`);
  await tap(eve, rowAt[4], true);
  ok((await shown(eve)).ids.length === 2, 'and a tap on the row below it picks that token');
  await eve.tap('#sel-mode');

  // Bob (desktop guest, the rim rows table): his bar docks at his table area's top; Alice moves pieces into that strip and out
  const bw8 = await box(bob, '#table-wrap'), b8 = rowsOf(await onScreen(bob));
  await bob.evaluate(() => { // (each time the bar is put in another parent: where, and how many of its buttons are held off then)
    const bar = document.getElementById('action-bar'), docks = (window.__docks = [{ at: bar.parentNode.id }]);
    const mo = new MutationObserver(() => { if (docks.at(-1).at !== bar.parentNode.id) docks.push({ at: bar.parentNode.id, off: [...bar.querySelectorAll('button')].filter((b) => b.disabled).length, n: bar.querySelectorAll('button').length }); });
    for (const id of ['toolbar', 'table-wrap']) mo.observe(document.getElementById(id), { childList: true });
  });
  const jumped = async (k, where) => { await until(() => bob.evaluate(([k, w]) => window.__docks.length > k && window.__docks.at(-1).at === w, [k, where]), 8000, 50); return bob.evaluate(() => window.__docks.at(-1)); };
  const [m1, m2] = [b8[1][2], b8[1][3]], other = b8[2][2];
  await shift(bob, async () => { await tap(bob, m1); await tap(bob, m2); });
  ok((await shown(bob)).ids.length === 2 && await atTop(bob), 'Bob picks two: his bar docks at the table area\'s top');
  const strip8 = await P3.tableOf(bob, { x: (bw8.l + bw8.r) / 2, y: bw8.t + 34 }), was8 = (await view(alice)).items[other.id];
  let k8 = await bob.evaluate(() => window.__docks.length);
  await act(alice, { t: 'move', id: other.id, x: Math.round(strip8.x - 30), y: Math.round(strip8.y - 30) });
  let j8 = await jumped(k8, 'toolbar');
  const q8 = await P3.centreOf(bob, other.id);
  ok(j8.at === 'toolbar' && q8.y - bw8.t < 64, `Alice moves a token into Bob's strip (${Math.round(q8.y - bw8.t)} px below his table area's top): his bar leaves it for the toolbar`);
  ok(j8.n > 0 && j8.off === j8.n, `held off as it jumps (${j8.off} of ${j8.n} buttons)`);
  ok(!(await underBar(bob)).length && (await hitAt(bob, q8)) === other.id, `no token under it: a click at the moved token reaches it (${await hitAt(bob, q8)})`);
  await shift(bob, async () => tap(bob, q8));
  ok((await shown(bob)).ids.length === 3, 'Bob\'s Shift+click picks it: three');
  k8 = await bob.evaluate(() => window.__docks.length);
  await act(alice, { t: 'move', id: other.id, x: was8.x, y: was8.y });
  j8 = await jumped(k8, 'table-wrap');
  ok(j8.at === 'table-wrap' && await atTop(bob) && j8.n > 0 && j8.off === j8.n, `Alice moves it back (a member, out of the strip): the bar docks at the top again, held off as it comes (${j8.off} of ${j8.n})`);
  k8 = await bob.evaluate(() => window.__docks.length);
  await act(alice, { t: 'move', id: m1.id, x: Math.round(strip8.x - 30), y: Math.round(strip8.y - 30) });
  j8 = await jumped(k8, 'toolbar');
  ok(j8.at === 'toolbar' && j8.n > 0 && j8.off === j8.n && !(await underBar(bob)).length, `Alice moves one of Bob's picks into his strip: the bar jumps over the toolbar, held off (${j8.off} of ${j8.n}), over no token`);
  await bob.keyboard.press('Escape');

  section('9. (fix-up 4) the one-row bar keeps what it shows in sight and goes back where it was: 👜 Into bag ▸ opens its list in sight; "🗑 Remove 8?" stays whole as the bar re-docks, and once it lapses the row is back where the player left it; a wheel over the bar scrolls it, over the bar or the inspector zooms nothing; a wheel zoom lays the page out only at its rest; other players\' moves away from the strip don\'t make the bar look over the whole table (D247, D248)');
  /** Page p's bar: its box, scroll (x of max), fades, parent, and the box of its first `cmd` button (client px). */
  const rowOf = (p, cmd) => p.evaluate((cmd) => {
    const b = document.getElementById('action-bar'), r = b.getBoundingClientRect(), q = cmd && b.querySelector(cmd)?.getBoundingClientRect();
    return { l: r.left, r: r.right, w: r.width, y: r.top + r.height / 2, x: b.scrollLeft, max: b.scrollWidth - b.clientWidth, more: b.classList.contains('more'), less: b.classList.contains('less'),
      at: b.parentNode.id, text: b.textContent, vw: innerWidth, q: q && { l: q.left, r: q.right, x: q.left + q.width / 2, y: q.top + q.height / 2 } };
  }, cmd);
  /** Whether box q lies wholly in row R's unfaded part (a faded end: 15% of its width). */
  const clear = (R, q) => !!q && q.l >= Math.max(0, R.l + (R.less ? 0.15 * R.w : 0)) - 1 && q.r <= Math.min(R.vw, R.r - (R.more ? 0.15 * R.w : 0)) + 1;
  /** Page p's row scrolled to x, as a swipe would leave it: its scroll then. */
  const swipeTo = async (p, x) => { const at = await p.evaluate((x) => { const b = document.getElementById('action-bar'); b.scrollLeft = x; return b.scrollLeft; }, x); await h.sleep(150); return at; };
  const BAG = '[data-cmd="bag"]', DEL = '[data-cmd="del"]';

  // Eve's phone (section 8's table): five picked, the row starting at ✕
  await eve.tap('#sel-mode');
  for (const id of epick) await tap(eve, await P3.centreOf(eve, id), true);
  await h.sleep(500); // (the bar's hold)
  let R = await rowOf(eve, BAG);
  ok(R.at === 'table-wrap' && R.x === 0 && R.max > 0 && !clear(R, R.q), `five picked: the row starts at ✕, 👜 Into bag ▸ beyond its faded end (x ${Math.round(R.q.l)}–${Math.round(R.q.r)} of ${R.vw})`);
  // a swipe just far enough to show the toggle whole; a tap on it opens the list — in sight
  const x1 = await swipeTo(eve, Math.ceil(R.q.r - (R.r - 0.15 * R.w)) + 4);
  R = await rowOf(eve, BAG);
  ok(clear(R, R.q), `swiped to ${x1}: the toggle in sight`);
  await tap(eve, R.q, true);
  await until(() => eve.evaluate(() => !!document.querySelector('#action-bar [data-cmd="bagTo"]')), 3000, 50);
  await h.sleep(500);
  R = await rowOf(eve, BAG);
  const sack = await rowOf(eve, '[data-cmd="bagTo"]');
  ok(clear(R, R.q) && clear(sack, sack.q), `👜 Into bag ▸ opens its list in sight: the toggle at x ${Math.round(R.q.l)}–${Math.round(R.q.r)} and "👜 Sack" at ${Math.round(sack.q.l)}–${Math.round(sack.q.r)} of ${R.vw}, out of the faded ends (scrolled ${x1} → ${R.x})`);
  await shot(eve, 'p4-fix4-iphone-list');
  await tap(eve, R.q, true);
  await until(() => eve.evaluate(() => !document.querySelector('#action-bar [data-cmd="bagTo"]')), 3000, 50);
  R = await rowOf(eve, BAG);
  ok(Math.abs(R.x - x1) <= 1 && R.less, `closed again: the row is back where the swipe left it (${R.x}, it was ${x1}), its scrolled-off start faded`);
  // three of the row join (eight); a swipe to the end shows 🗑; its tap asks — and the ask stays whole as the bar re-docks
  await h.sleep(500);
  for (const k of [0, 1, 2]) await tap(eve, rowAt[k], true);
  await h.sleep(500);
  R = await rowOf(eve, DEL);
  const x2 = await swipeTo(eve, R.max);
  R = await rowOf(eve, DEL);
  ok((await shown(eve)).ids.length === 8 && clear(R, R.q), `eight picked; swiped to the row's end (${x2}): 🗑 in sight`);
  await tap(eve, R.q, true);
  await until(() => eve.evaluate(() => /Remove 8\?/.test(document.getElementById('action-bar').textContent)), 3000, 50);
  R = await rowOf(eve, DEL);
  ok(clear(R, R.q) && R.q.r <= R.vw - 4, `"🗑 Remove 8?" in sight (x ${Math.round(R.q.l)}–${Math.round(R.q.r)} of ${R.vw})`);
  // (her table seen whole lies below the strip, its top row just under it: a pinch zooming in by 1.4 about the table's middle brings that row up into it)
  const mid9 = await P3.screenOf(eve, 650, 500);
  await pinch(eve, mid9, 100, 140);
  ok(await until(async () => (await rowOf(eve)).at === 'toolbar', 5000, 50), 'a pinch brings the top row into the strip the bar docked in: the bar jumps over the toolbar');
  await h.sleep(500);
  R = await rowOf(eve, DEL);
  ok(/Remove 8\?/.test(R.text) && clear(R, R.q) && R.q.r <= R.vw - 4, `"🗑 Remove 8?" is still whole in sight there (x ${Math.round(R.q.l)}–${Math.round(R.q.r)} of ${R.vw}; scroll ${R.x} of ${R.max}): a new parent's scroll of 0 no longer pushes it off the edge`);
  await shot(eve, 'p4-fix4-iphone-ask-jump');
  ok(await until(async () => !/Remove/.test((await rowOf(eve)).text), 8000, 100), 'the ask lapses unanswered');
  await h.sleep(300);
  R = await rowOf(eve, DEL);
  ok(Math.abs(R.x - Math.min(x2, R.max)) <= 2 && R.less === R.x > 1 && Object.keys((await view(eve)).items).length === 14,
    `then the row is back where the player left it (${R.x}; the swipe left ${x2}, the ask had it at its end), its start faded while scrolled off; nothing removed`);
  await press(eve, '#action-bar [data-cmd="none"]', true);
  await eve.tap('#sel-mode');
  await eve.tap('#view-btn'); // (🧭: the whole table again)

  // Dan's desktop (a host alone): fourteen bags, a ×5 stack
  const BAGS = {
    name: 'Many bags', imgs: [], table: { shape: 'rect', w: 1300, h: 1000 },
    types: { tok: { kind: 'token', name: 'Token', w: 60, faces: [{ color: '#f59e0b', label: 'T' }, { color: '#0ea5e9', label: 'U' }] } },
    setup: [{ piece: 'tok', count: 6, spread: [120, 0], at: [300, 450] }, { piece: 'tok', n: 5, at: [620, 640] },
      ...Array.from({ length: 14 }, (_, k) => ({ bag: ['tok'], name: `Bag ${k + 1}`, at: [70 + 85 * k, 860] }))],
  };
  await act(dan, { t: 'loadBox', box: BAGS, setup: true, clear: true });
  ok(await until(async () => Object.keys((await view(dan)).items).length === 21, 15000), 'Dan sets up six tokens, a ×5 stack and fourteen bags');
  await h.sleep(400);
  const dv = Object.entries((await view(dan)).items).map(([id, it]) => ({ id, ...it })), drow = dv.filter((it) => it.y === 450 && it.k === 'g' && !(it.n >= 2)).sort((a, b) => a.x - b.x);
  const dstack = dv.find((it) => it.n === 5).id, tf = () => dan.evaluate(() => document.getElementById('table').style.transform);
  await shift(dan, async () => { await tap(dan, await P3.centreOf(dan, drow[1].id)); await tap(dan, await P3.centreOf(dan, drow[2].id)); });
  await h.sleep(500);
  await dan.click(`#action-bar ${BAG}`);
  await until(() => dan.evaluate(() => !!document.querySelector('#action-bar [data-cmd="bagTo"]')), 3000, 50);
  await h.sleep(500);
  let D = await rowOf(dan, DEL);
  const tf0 = await tf();
  ok(drow.length === 6 && D.max > 0 && D.more && !clear(D, D.q), `two picked, 👜 Into bag ▸ open on fourteen bags: the row is wider than the screen, 🗑 beyond its faded end (scroll ${D.x} of ${D.max}: the list brought into sight)`);
  await dan.mouse.move((D.l + D.r) / 2, D.y);
  await dan.mouse.wheel(0, 240);
  await h.sleep(200);
  const D1 = await rowOf(dan, DEL);
  await dan.mouse.wheel(240, 0);
  await h.sleep(200);
  const D2 = await rowOf(dan, DEL);
  ok(D1.x > D.x && D2.x > D1.x && (await tf()) === tf0, `a wheel over the bar scrolls it sideways (${D.x} → ${D1.x}), and so does a sideways one (→ ${D2.x}); the view does not zoom`);
  for (let k = 0; k < 20 && (await rowOf(dan)).x < D.max - 1; k++) { await dan.mouse.wheel(0, 240); await h.sleep(60); }
  D = await rowOf(dan, DEL);
  ok(clear(D, D.q) && (await tf()) === tf0, `wheeled on to its end: 🗑 in sight (x ${Math.round(D.q.l)}–${Math.round(D.q.r)} of ${D.vw})`);
  await shot(dan, 'p4-fix4-desktop-wheel');
  await dan.mouse.click(D.q.x, D.q.y);
  ok(await until(async () => { const w = await view(dan); return !w.items[drow[1].id] && !w.items[drow[2].id]; }, 8000), 'and a click on it removes the two');
  // the inspector: a wheel over it zooms nothing either
  await P.clickItem(dan, dstack);
  await h.sleep(300);
  if (!(await box(dan, '#inspector'))) await dan.click('#action-bar [data-cmd="inspect"]'); // (a click on its ×5 opens it at once)
  const ib = await box(dan, '#inspector');
  await dan.mouse.move((ib.l + ib.r) / 2, (ib.t + ib.b) / 2);
  await dan.mouse.wheel(0, 300);
  await h.sleep(200);
  ok(!!ib && (await tf()) === tf0 && !!(await box(dan, '#inspector')), 'a wheel over the open inspector zooms nothing; it stays open');
  await dan.keyboard.press('Escape');
  // a wheel zoom with a token's own bar open: the page is laid out at its rest, not at every turn; the bar follows its token
  await P.clickItem(dan, drow[4].id);
  await h.sleep(300);
  const at9 = await P3.centreOf(dan, drow[4].id);
  await dan.mouse.move(at9.x, at9.y); // (the zoom keeps the point under the cursor: the token stays there)
  const cdp9 = await dan.context().newCDPSession(dan);
  await cdp9.send('Performance.enable');
  const lay = async () => (await cdp9.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount').value, l0 = await lay();
  for (let k = 0; k < 16; k++) { await dan.mouse.wheel(0, -40); await h.sleep(30); }
  await h.sleep(600);
  const laid = (await lay()) - l0;
  await cdp9.detach();
  const bar9 = await box(dan, '#action-bar'), tok9 = await P3.centreOf(dan, drow[4].id);
  ok((await tf()) !== tf0 && laid <= 6, `sixteen turns of the wheel zoom the view and lay the page out ${laid} times (≤ 6: the sizes wait for the wheel's rest, the bar moves by translate)`);
  ok(!!bar9 && Math.abs((bar9.l + bar9.r) / 2 - tok9.x) < 60 && bar9.b <= tok9.y, `the token's bar still stands just above it (bar ${Math.round(bar9.l)}–${Math.round(bar9.r)}, token at ${Math.round(tok9.x)})`);
  await dan.keyboard.press('Escape');

  // Bob (a desktop guest): his bar docked at his table area's top; Alice's moves elsewhere don't make him look over the whole table
  const home9 = await P3.tableOf(bob, { x: (bw8.l + bw8.r) / 2, y: (bw8.t + bw8.b) / 2 });
  await act(alice, { t: 'move', id: m1.id, x: Math.round(home9.x - 30), y: Math.round(home9.y - 30) }); // (section 8 left it in his strip)
  await h.sleep(400);
  const b9 = rowsOf(await onScreen(bob));
  await shift(bob, async () => { await tap(bob, b9[2][1]); await tap(bob, b9[2][2]); });
  ok(await until(async () => await atTop(bob), 3000, 100), 'Bob picks two: his bar docks at the table area\'s top');
  const scans = () => bob.evaluate(() => window.__ct.perf.dockScans), sc0 = await scans(), far = b9.at(-1).slice(0, 4);
  const to9 = {};
  for (const [k, t] of far.entries()) {
    const it = (await view(alice)).items[t.id];
    to9[t.id] = { x: it.x + 10, y: it.y + 10 * (k + 1) };
    await act(alice, { t: 'move', id: t.id, ...to9[t.id] });
  }
  await until(async () => { const w = await view(bob); return far.every((t) => w.items[t.id]?.x === to9[t.id].x && w.items[t.id].y === to9[t.id].y); }, 5000);
  await h.sleep(500);
  ok(typeof sc0 === 'number' && (await scans()) === sc0 && await atTop(bob), `Alice moves four tokens far from his strip: his bar stays, and he looks over the whole table no more (${sc0} → ${await scans()} looks)`);
  await act(alice, { t: 'move', id: m1.id, x: Math.round(strip8.x - 30), y: Math.round(strip8.y - 30) });
  ok(await until(async () => await overToolbar(bob), 5000, 50), 'one moved into his strip: his bar leaves it for the toolbar');
  await act(alice, { t: 'move', id: m1.id, x: Math.round(home9.x - 30), y: Math.round(home9.y - 30) });
  ok(await until(async () => await atTop(bob), 5000, 50), 'and moved out again: back at the top');
  await bob.keyboard.press('Escape');
  await env.done();
})().catch(h.crash);
