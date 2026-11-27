// Phase 4B, written from the spec (§4g multi-select, §4c `group`, §3c the
// group drag; §4l t-p4-select items 1–5), independent of the
// implementation's own t-p4-select.js — real gestures on real screens:
// Alice hosts on a desktop, Bob plays on a desktop (mouse and keyboard),
// Carol on an iPhone 13 (CDP touches).
//  1. selecting: a Shift+drag band on the felt and on the locked board (a
//     plain drag pans there), never a board, only what the player may
//     handle (the "N not selectable" chip), Shift+click in and out; Esc, a
//     click on the felt and ✕ clear; on the phone, ⬚ select mode: a
//     one-finger band, a tap in and out, ✕ and ⬚ off clear (a finger
//     drag without ⬚ pans), a finger drag carrying the group;
//  2. a group drag of 200 members by the mouse: every member moves on
//     every screen (the glide mid-drag, each piece snapping on its own at
//     the drop), the dragger sends at most 17 `drag` a second and no
//     `move`, gets no flood notice, and the drop's one `group` applies;
//  3. the group bar: ⟳ ⟲ by the largest rotStep (each member snapped to
//     its own), R and Shift+R, Flip and F, 🎲 Roll and Space, 🔒 / 🔓,
//     👜 Into bag ▸, 🗑 and Delete — each one `group` and one log line;
//  4. locked and someone else's items: never picked (the chip), and a
//     member locked or claimed by another player mid-drag stays put while
//     the rest move, with one notice;
//  5. a rules script vetoes one member in the middle of a group: only it
//     stays put (its own writes rolled back), the rest move, one notice
//     names one skip.
'use strict';
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const M = require('./p4m-lib');

const J = JSON.stringify;
// --- the box (original): a 22 × 10 yard of 100-unit cells and rows of pieces on the felt below it ---
const BX = 300, BY = 200; // the yard's top-left: its cell (c, r) is centred at cell(c, r)
const cell = (c, r) => ({ x: BX + 100 * c + 50, y: BY + 100 * r + 50 });
/** The top-left of an s × s piece centred at (x, y) (a setup's `at`). */
const TL = (x, y, s = 60) => [x - s / 2, y - s / 2];
const ROW = { A: 1300, B: 1500, C: 1750, D: 1950 }; // the felt's rows (centres' y)
const BOX = {
  name: 'Sorting yard', imgs: [], lockable: 'anyone', table: { shape: 'rect', w: 3000, h: 2400 },
  backs: { cb: { face: { color: '#1e3a8a', label: '?' } } },
  types: {
    yard: { kind: 'board', name: 'Yard', w: 2200, h: 1000, faces: [{ color: '#cbd5a0' }], board: { grid: { type: 'square', cols: 22, rows: 10, cell: 100, x: 0, y: 0, draw: 'lines' } } },
    peb: { kind: 'token', name: 'Pebble', faces: [{ color: '#f97316', label: 'o' }] },
    ctr: { kind: 'token', name: 'Counter', shape: 'rect', faces: [{ color: '#14b8a6', label: 'K' }] },
    hx: { kind: 'token', name: 'Sixer', shape: 'rect', rotStep: 60, faces: [{ color: '#eab308', label: '6' }] },
    sq: { kind: 'token', name: 'Eighter', shape: 'rect', rotStep: 45, faces: [{ color: '#8b5cf6', label: '8' }] },
    chit: { kind: 'token', name: 'Chit', shape: 'rect', back: 'cb', faces: [{ color: '#fde68a', label: 'C' }] },
    coin: { kind: 'token', name: 'Coin', shape: 'rect', faces: [{ color: '#fbbf24', label: 'Hd' }, { color: '#94a3b8', label: 'Tl' }] },
    flag: { kind: 'token', name: 'Flag', faces: [{ color: '#dc2626', label: 'F' }] },
    die: { kind: 'die', name: 'Die' },
  },
  setup: [
    { piece: 'yard', at: [BX, BY] },
    // 180 pebbles on the yard's columns 0–17 (18–21 stay free)
    ...Array.from({ length: 10 }, (_, r) => ({ piece: 'peb', count: 18, spread: [100, 0], at: TL(cell(0, r).x, cell(0, r).y) })),
    // row A: 10 dice and 10 counters (with the yard's 180: 200 to pick), one locked pebble, one to be Alice's
    { piece: 'die', count: 10, spread: [100, 0], at: TL(350, ROW.A, 56) },
    { piece: 'ctr', count: 10, spread: [100, 0], at: TL(1350, ROW.A) },
    { piece: 'peb', at: TL(2350, ROW.A), lock: true },
    { piece: 'peb', at: TL(2450, ROW.A) },
    // row B: Bob's band (four pebbles, a locked one, one to be Alice's) and two to Shift+click; Carol's corner on the right
    { piece: 'peb', count: 4, spread: [100, 0], at: TL(400, ROW.B) },
    { piece: 'peb', at: TL(800, ROW.B), lock: true },
    { piece: 'peb', at: TL(900, ROW.B) },
    { piece: 'peb', count: 2, spread: [100, 0], at: TL(1100, ROW.B) },
    { piece: 'peb', count: 4, spread: [100, 0], at: TL(1900, ROW.B) },
    { piece: 'peb', at: TL(2300, ROW.B), lock: true },
    { piece: 'peb', count: 2, spread: [100, 0], at: TL(1900, ROW.B + 150) },
    // row C: the group bar's workshop — two 60° turners, two 45° ones, two chits with a back, a two-faced coin, three dice; the bag
    { piece: 'hx', count: 2, spread: [100, 0], at: TL(350, ROW.C) },
    { piece: 'sq', count: 2, spread: [100, 0], at: TL(550, ROW.C) },
    { piece: 'chit', count: 2, spread: [100, 0], at: TL(750, ROW.C) },
    { piece: 'coin', at: TL(950, ROW.C) },
    { piece: 'die', count: 3, spread: [100, 0], at: TL(1050, ROW.C, 56) },
    { bag: ['peb'], name: 'Sack', at: [1600 - 45, ROW.C - 50] },
    // row D: the veto's five (the flag in the middle: z in setup order) and the race's four counters
    { piece: 'peb', count: 2, spread: [100, 0], at: TL(300, ROW.D) },
    { piece: 'flag', at: TL(500, ROW.D) },
    { piece: 'peb', count: 2, spread: [100, 0], at: TL(600, ROW.D) },
    { piece: 'ctr', count: 4, spread: [100, 0], at: TL(1600, ROW.D) },
  ],
};

/** Where each of `ids` (in view `its`) lands when a group moves them by (dx, dy), as the spec has it (§4c, §3a): a
 *  piece on the yard snaps on its own to the cell its centre falls in (centred there); one on the felt moves by the shift. */
function landing(its, ids, dx, dy) {
  const out = {};
  for (const id of ids) {
    const it = its[id], s = it.t?.endsWith('/die') ? 56 : 60, cx = it.x + s / 2 + dx, cy = it.y + s / 2 + dy;
    const c = Math.floor((cx - BX) / 100), r = Math.floor((cy - BY) / 100), on = c >= 0 && c < 22 && r >= 0 && r < 10 && !it.t?.endsWith('/die');
    out[id] = on ? { x: cell(c, r).x - s / 2, y: cell(c, r).y - s / 2 } : { x: it.x + dx, y: it.y + dy };
  }
  return out;
}
/** The ids of `want` whose place in view `its` differs from want[id] by more than 0.5. */
const astray = (its, want) => Object.keys(want).filter((id) => !its[id] || Math.abs(its[id].x - want[id].x) > 0.5 || Math.abs(its[id].y - want[id].y) > 0.5);
/** A rotation `d` more than r0, snapped to `step` (0: free), as §2c snaps a piece's rot. */
const snapRot = (r0, d, step) => { const r = r0 + d, s = step ? Math.round(r / step) * step : r; return Math.round((((s % 360) + 360) % 360) * 1000) / 1000; };
/** A script for section 5: a flag never moves, and its attempt (a counter, a line) is undone with it; each member moved is counted. */
const PICKET = `({ name: 'Picket',
  handle(t, a) {
    if (a.t !== 'move' || !String(t.item(a.id)?.t || '').endsWith('/flag')) return;
    t.data.tries = (t.data.tries || 0) + 1;
    t.say('picket: the flag tried to go');
    return 'The flag holds its ground';
  },
  onAction(t, a) { if (a.t === 'move' && a.group) t.data.moved = (t.data.moved || 0) + 1; } })`;

(async () => {
  const env = await h.start();
  const alice = await M.join(env, 'Alice', env.url);
  const bob = await M.join(env, 'Bob', alice.url());
  const carol = await M.join(env, 'Carol', alice.url(), { ctx: P.PHONE });
  const all = [alice, bob, carol];
  alice.on('dialog', (d) => d.accept());
  const r0 = await alice.evaluate((box) => window.__ct.act({ t: 'loadBox', box, setup: true, clear: true }), BOX);
  ok(r0?.ok, `(Alice sets up the test box: ${J(r0)})`);
  for (const p of all) ok(await P.waitView(p, 'Object.keys(v.items).length === 238', null, 30000), `(${p.label} sees its 238 items)`);
  let its = await M.items(alice);
  const at = (x, y, s) => M.idAt(its, x, y, s);
  // Alice owns two pebbles (the host gives them to herself: setup)
  const mineA = [at(2450, ROW.A), at(900, ROW.B)];
  for (const id of mineA) await alice.evaluate(([id, to]) => window.__ct.act({ t: 'owner', id, to }), [id, alice.pid]);
  for (const p of all) await P.waitView(p, 'a.every((id) => v.items[id]?.owner)', mineA);
  its = await M.items(alice);
  const yard = M.ofType(its, 'yard')[0];
  const lockedA = at(2350, ROW.A), lockedB = at(800, ROW.B), lockedC = at(2300, ROW.B);
  ok(its[lockedA]?.lock && its[lockedB]?.lock && its[lockedC]?.lock && its[yard]?.lock, '(the yard and three pebbles are locked; two pebbles are Alice\'s)');
  const P_ = (p, x, y) => M.pt(p, x, y);
  /** A rubber band on page p from table point a to b (a press where a plain drag would pan): a Shift+drag of
   *  the mouse, or one finger on a touch screen (in ⬚ select mode); whether the band showed before the release. */
  const band = async (p, a, b) => {
    const pts = P3.steps(await P_(p, a.x, a.y), await P_(p, b.x, b.y), 10);
    let seen = false;
    const mid = async () => { seen = await M.bandShown(p); };
    if (p.touch) await M.fingerDrag(p, pts, { mid });
    else await M.mouseDrag(p, pts, { shift: true, mid });
    return seen;
  };
  const sameSet = (a, b) => J([...a].sort()) === J([...b].sort());

  // ===========================================================================
  section('1. selecting on a desktop (Bob): a band, Shift+click, the chip, clearing; a plain drag pans');
  {
    const felt = { x: 2750, y: 700 }, fq = await P_(bob, felt.x, felt.y);
    ok((await M.hit(bob, fq)) === 'table', `(table point ${J(felt)} is bare felt on Bob's screen)`);
    const v0 = await P.tf(bob);
    let mid = null;
    await M.mouseDrag(bob, P3.steps(fq, { x: fq.x + 60, y: fq.y + 40 }, 8), { mid: async () => { mid = { band: await M.bandShown(bob), tf: await P.tf(bob) }; } });
    ok(Math.abs(mid.tf.px - v0.px - 60) < 2 && Math.abs(mid.tf.py - v0.py - 40) < 2 && !mid.band, `a plain drag on the felt pans the view (by ${(mid.tf.px - v0.px).toFixed(1)}, ${(mid.tf.py - v0.py).toFixed(1)} px) and draws no band`);
    ok((await M.selected(bob)).length === 0, 'and selects nothing');
    await M.mouseDrag(bob, P3.steps({ x: fq.x + 60, y: fq.y + 40 }, fq, 8)); // (and back)
    // a plain drag on the locked yard pans too
    const free = cell(20, 5), yq = await P_(bob, free.x, free.y), yb0 = its[yard];
    ok((await M.hit(bob, yq)) === yard, '(a free cell of the yard is the locked yard on Bob\'s screen)');
    await M.mouseDrag(bob, P3.steps(yq, { x: yq.x - 50, y: yq.y }, 8), { mid: async () => { mid = { band: await M.bandShown(bob), tf: await P.tf(bob) }; } });
    ok(Math.abs(mid.tf.px - v0.px + 50) < 2 && !mid.band, `a plain drag on the locked yard pans the view (by ${(mid.tf.px - v0.px).toFixed(1)} px), no band`);
    await M.mouseDrag(bob, P3.steps({ x: yq.x - 50, y: yq.y }, yq, 8));
    const v1 = await P.tf(bob), yb1 = (await M.items(alice))[yard];
    ok(Math.abs(v1.px - v0.px) < 2 && Math.abs(v1.py - v0.py) < 2 && yb1.x === yb0.x && yb1.y === yb0.y && !(await M.selected(bob)).length, '(panned back; the yard never moved, nothing selected)');

    // a Shift+drag on the felt: a band
    const four = [400, 500, 600, 700].map((x) => at(x, ROW.B));
    const sawBand = await band(bob, { x: 340, y: ROW.B - 60 }, { x: 960, y: ROW.B + 60 });
    const chip1 = await M.chip(bob), s1 = await M.selected(bob), b1 = await M.bar(bob), v2 = await P.tf(bob);
    ok(sawBand, 'a Shift+drag on the felt draws a rubber band while it goes');
    ok(sameSet(s1, four), `on release the band picks the four pebbles inside it, each .selected (${s1.length} selected)`);
    ok(!s1.includes(lockedB) && !s1.includes(mineA[1]), 'not the locked pebble, nor Alice\'s');
    ok(chip1 === "2 not selectable (locked or someone else's)", `the chip counts them: "${chip1}"`);
    ok(b1.on && b1.btns.includes('✕') && /\b4 selected\b/.test(b1.text), `the group bar shows (“${b1.text.trim()}”)`);
    ok(Math.abs(v2.px - v0.px) < 2 && Math.abs(v2.py - v0.py) < 2, 'and the band did not pan the view');
    // Shift+click in and out
    const t1 = at(1100, ROW.B), t2 = at(1200, ROW.B);
    await M.click(bob, await M.centre(bob, t1), true);
    ok(sameSet(await M.selected(bob), [...four, t1]), 'Shift+click adds a pebble');
    await M.click(bob, await M.centre(bob, four[0]), true);
    ok(sameSet(await M.selected(bob), [...four.slice(1), t1]), 'Shift+click on a member takes it out');
    await M.click(bob, await M.centre(bob, lockedB), true);
    const chip2 = await M.chip(bob);
    ok(sameSet(await M.selected(bob), [...four.slice(1), t1]) && /not selectable/.test(chip2), `Shift+click on a locked pebble picks nothing ("${chip2}")`);
    await M.click(bob, await M.centre(bob, mineA[1]), true);
    ok(sameSet(await M.selected(bob), [...four.slice(1), t1]), 'nor on Alice\'s');
    const myBar = await M.bar(bob);
    ok(myBar.on && /\b4 selected\b/.test(myBar.text), `the bar follows: "${myBar.text.trim()}"`);
    // clearing: Esc, a click on the felt, ✕
    await bob.keyboard.press('Escape');
    ok(!(await M.selected(bob)).length && !(await M.bar(bob)).on, 'Esc clears the selection and its bar');
    await band(bob, { x: 340, y: ROW.B - 60 }, { x: 960, y: ROW.B + 60 });
    ok((await M.selected(bob)).length === 4, '(picked again)');
    await M.click(bob, await P_(bob, felt.x, felt.y));
    ok(!(await M.selected(bob)).length && !(await M.bar(bob)).on, 'a click on the felt clears it');
    await band(bob, { x: 340, y: ROW.B - 60 }, { x: 960, y: ROW.B + 60 });
    await M.click(bob, await M.centre(bob, t2), true);
    ok((await M.selected(bob)).length === 5, '(picked again, five)');
    await M.barPress(bob, '✕');
    ok(!(await M.selected(bob)).length && !(await M.bar(bob)).on, '✕ clears it');
    // a Shift+drag that starts on the locked yard draws a band too; the yard itself is never picked
    const six = [15, 16, 17].flatMap((c) => [1, 2].map((r) => at(cell(c, r).x, cell(c, r).y)));
    const fromYard = await P_(bob, cell(19, 1).x + 30, cell(19, 1).y - 40);
    ok((await M.hit(bob, fromYard)) === yard, '(the band below starts on the locked yard, at a free cell)');
    const saw2 = await band(bob, { x: cell(19, 1).x + 30, y: cell(19, 1).y - 40 }, { x: cell(15, 2).x - 40, y: cell(15, 2).y + 40 });
    const s3 = await M.selected(bob), v3 = await P.tf(bob);
    ok(saw2 && sameSet(s3, six), `a Shift+drag from the locked yard draws a band and picks the six pebbles inside it (${s3.length})`);
    ok(!s3.includes(yard) && Math.abs(v3.px - v0.px) < 2, 'never the yard; no pan');
    await bob.keyboard.press('Escape');
    // a band that holds the yard's centre: the yard isn't picked either
    await band(bob, { x: BX - 40, y: BY - 40 }, { x: BX + 2240, y: BY + 1040 });
    const s4 = await M.selected(bob);
    ok(s4.length === 180 && !s4.includes(yard), `a band around the whole yard picks its 180 pebbles, never the yard (${s4.length} picked, yard ${s4.includes(yard) ? '' : 'not '}among them)`);
    await bob.keyboard.press('Escape');
  }

  // ===========================================================================
  section('1′. selecting on a phone (Carol, iPhone 13): ⬚ select mode, a one-finger band, taps in and out, ✕ and ⬚ off');
  {
    const ten = await M.selMode(carol);
    ok(ten.shown && !ten.on, '⬚ shows, off');
    const W = ten.wrap;
    ok(ten.box.x < W.l + (W.r - W.l) * 0.25 && ten.box.y > W.b - (W.b - W.t) * 0.25, `⬚ floats at the bottom left of the table (${J(ten.box)} in ${J(W)})`);
    // two fingers spread over Carol's corner: the view zooms in there
    const s0 = (await P.tf(carol)).s;
    await M.spread(carol, await P_(carol, 2100, ROW.B + 75), 60, 260);
    const s1 = (await P.tf(carol)).s;
    ok(s1 > s0 * 2.5, `(Carol spreads two fingers: the view zooms from ${s0.toFixed(3)} to ${s1.toFixed(3)})`);
    const four = [1900, 2000, 2100, 2200].map((x) => at(x, ROW.B)), tgt = [at(1900, ROW.B + 150), at(2000, ROW.B + 150)];
    const off = [];
    for (const id of [...four, ...tgt, lockedC]) {
      const c = await M.centre(carol, id);
      if (!(c && (await M.inViewport(carol, { l: c.x, t: c.y, r: c.x, b: c.y })) && (await M.hit(carol, c)) === id)) off.push({ id, c, hit: c && (await M.hit(carol, c)) });
    }
    ok(!off.length, `(Carol's corner is on her screen, each piece under her finger: ${J(off)})`);
    // a finger drag on the felt without ⬚ pans
    const felt = { x: 2100, y: ROW.B - 120 }, fq = await P_(carol, felt.x, felt.y), v0 = await P.tf(carol);
    ok((await M.hit(carol, fq)) === 'table', '(a felt point beside Carol\'s corner)');
    let seen = null;
    await M.fingerDrag(carol, P3.steps(fq, { x: fq.x + 30, y: fq.y + 30 }, 8), { mid: async () => { seen = { band: await M.bandShown(carol), tf: await P.tf(carol) }; } });
    ok(seen && !seen.band && Math.hypot(seen.tf.px - v0.px, seen.tf.py - v0.py) > 20, `without ⬚ a one-finger drag on the felt pans (by ${(seen.tf.px - v0.px).toFixed(0)}, ${(seen.tf.py - v0.py).toFixed(0)} px), no band`);
    ok(!(await M.selected(carol)).length, 'and picks nothing');
    await M.fingerDrag(carol, P3.steps({ x: fq.x + 30, y: fq.y + 30 }, fq, 8));
    // ⬚ on: a one-finger band
    await M.tap(carol, ten.box);
    ok((await M.selMode(carol)).on, 'a tap on ⬚ turns select mode on');
    const v1 = await P.tf(carol);
    const sawBand = await band(carol, { x: 1840, y: ROW.B - 60 }, { x: 2360, y: ROW.B + 60 });
    const c1 = await M.chip(carol), sel1 = await M.selected(carol), v2 = await P.tf(carol);
    ok(sawBand && sameSet(sel1, four), `in select mode a one-finger drag on the felt draws a band and picks the four pebbles (${sel1.length})`);
    ok(c1 === "1 not selectable (locked or someone else's)", `the locked one is counted in the chip: "${c1}"`);
    ok(Math.abs(v2.px - v1.px) < 2 && Math.abs(v2.py - v1.py) < 2, 'the band did not pan');
    const gb = await M.bar(carol);
    ok(gb.on && (await M.inViewport(carol, gb.box)), `the group bar shows on the phone's screen (${J(gb.box)})`);
    const under = [];
    for (const id of four) { const c = await M.centre(carol, id); if (c.x > gb.box.l && c.x < gb.box.r && c.y > gb.box.t && c.y < gb.box.b) under.push(id); }
    ok(!under.length, `and covers none of the four (${under.length} under it)`);
    await M.shot(carol, 'p4m-iphone-band');
    await M.tap(carol, await M.centre(carol, tgt[0]));
    ok(sameSet(await M.selected(carol), [...four, tgt[0]]), 'a tap on another pebble adds it');
    await M.tap(carol, await M.centre(carol, four[1]));
    ok(sameSet(await M.selected(carol), [four[0], ...four.slice(2), tgt[0]]), 'a tap on a member takes it out');
    await M.tap(carol, await M.centre(carol, lockedC));
    ok((await M.selected(carol)).length === 4, 'a tap on the locked pebble picks nothing');
    await M.barPress(carol, '✕');
    ok(!(await M.selected(carol)).length && !(await M.bar(carol)).on, '✕ clears the selection');
    // a finger carries the group
    await band(carol, { x: 1840, y: ROW.B - 60 }, { x: 2360, y: ROW.B + 60 });
    ok(sameSet(await M.selected(carol), four), '(the four picked again)');
    const before = await M.items(alice), n0 = await M.nSent(carol);
    const from = await M.centre(carol, four[0]), to = await P_(carol, 1900, ROW.B + 300); // (down, to clear row D's counters)
    await M.fingerDrag(carol, P3.steps(from, to, 14), { pause: 30 });
    await M.until(async () => (await M.sent(carol, n0)).some((x) => x.a.t === 'group'), 5000, 50);
    const g = (await M.sent(carol, n0)).map((x) => x.a).filter((a) => a.t === 'group');
    const live = (await M.sent(carol, n0)).map((x) => x.a).filter((a) => a.t !== 'group');
    ok(live.length > 0 && live.every((a) => a.t === 'drag' && sameSet(a.ids, four)), `a finger drag of one member relays the four as drag {ids, dx, dy}, never a move (${J([...new Set(live.map((a) => a.t))])} ×${live.length})`);
    ok(g.length === 1 && g[0].op === 'move' && sameSet(g[0].ids, four), `and its lift sends one group move of the four (${J(g.map((a) => ({ op: a.op, n: a.ids?.length })))})`);
    if (g[0]) {
      const want = landing(before, four, g[0].dx, g[0].dy);
      ok(await P.waitView(alice, 'a.every(([id, w]) => Math.abs(v.items[id].x - w.x) < 0.5 && Math.abs(v.items[id].y - w.y) < 0.5)', Object.entries(want)), `every member moved by its shift (${g[0].dx.toFixed(1)}, ${g[0].dy.toFixed(1)}) on the host`);
    }
    // the group bar by taps: 🔒 then 🔓
    await M.barPress(carol, '🔒 Lock');
    ok(await P.waitView(alice, 'a.every((id) => v.items[id].lock)', four), 'the group bar\'s 🔒 locks the four');
    ok(sameSet(await M.selected(carol), four) && (await M.bar(carol)).btns.some((b) => b.startsWith('🔓')), 'they stay picked, and the bar offers 🔓');
    await M.barPress(carol, '🔓 Unlock');
    ok(await P.waitView(alice, 'a.every((id) => !v.items[id].lock)', four), '🔓 unlocks them');
    await M.tap(carol, (await M.selMode(carol)).box);
    ok(!(await M.selMode(carol)).on && !(await M.selected(carol)).length && !(await M.bar(carol)).on, '⬚ off clears the selection');
  }

  // ===========================================================================
  section('2. a group drag of 200 members (Bob, a mouse): every member moves on every screen');
  its = await M.items(alice);
  const yardPebs = Object.keys(its).filter((id) => its[id].t?.endsWith('/peb') && its[id].y < BY + 1000);
  const rowA = [...M.ofType(its, 'die').filter((id) => Math.abs(its[id].y + 28 - ROW.A) < 1), ...M.ofType(its, 'ctr').filter((id) => Math.abs(its[id].y + 30 - ROW.A) < 1)];
  const two = [...yardPebs, ...rowA];
  {
    ok(yardPebs.length === 180 && rowA.length === 20, `(the 200: 180 pebbles on the yard, 10 dice and 10 counters on the felt: ${yardPebs.length} + ${rowA.length})`);
    const start = await P_(bob, BX - 40, BY - 40);
    ok((await M.hit(bob, start)) === 'table', '(the band starts on the felt)');
    await band(bob, { x: BX - 40, y: BY - 40 }, { x: 2540, y: ROW.A + 50 });
    const c = await M.chip(bob), s = await M.selected(bob);
    ok(sameSet(s, two), `one band picks the 200 (${s.length}), never the yard`);
    ok(/\b2 not selectable\b/.test(c) && !s.includes(lockedA) && !s.includes(mineA[0]), `the locked pebble and Alice's are left out: "${c}"`);
    await M.shot(bob, 'p4m-desktop-200');
    const n0 = await M.nSent(bob), t0 = Date.now() - 5, before = await M.items(alice);
    const S = cell(9, 4), path = [];
    const way = [[S.x, S.y], [S.x + 250, S.y + 80], [S.x + 100, S.y]];
    for (let k = 0; k < 2; k++) for (let j = 0; j < 60; j++) path.push([way[k][0] + ((way[k + 1][0] - way[k][0]) * j) / 60, way[k][1] + ((way[k + 1][1] - way[k][1]) * j) / 60]);
    path.push(way[2]);
    const pts = [];
    for (const [x, y] of path) pts.push({ ...(await P_(bob, x, y)), wait: 0 });
    await bob.evaluate(() => { window.__pm = []; window.addEventListener('pointermove', (e) => window.__pm.push(e.timeStamp), true); });
    ok((await M.hit(bob, pts[0])) === at(S.x, S.y), '(Bob presses on a pebble of the 200)');
    let mid = null;
    const glide = (p) => p.waitForFunction((ids) => { const L = window.__ct.lives(); return ids.every((id) => L[id]); }, two, { timeout: 6000, polling: 50 }).then(() => true, () => false);
    const [, aGlide, cGlide] = await Promise.all([
      M.mouseDrag(bob, pts, { mid: async () => { mid = await bob.evaluate((ids) => ids.map((id) => window.__ct.drawn(id)), two); } }),
      glide(alice), glide(carol),
    ]);
    ok(aGlide && cGlide, `mid-drag, Alice's and Carol's screens glide all 200 (Alice ${aGlide}, Carol ${cGlide})`);
    const tx = mid?.[0]?.tx, ty = mid?.[0]?.ty;
    ok(mid && mid.every((d) => d && Math.abs(d.tx - tx) < 0.01 && Math.abs(d.ty - ty) < 0.01) && Math.abs(tx - 100) < 2 && Math.abs(ty) < 2, `on Bob's screen the 200 follow the pointer together, each shifted by (${tx?.toFixed(1)}, ${ty?.toFixed(1)})`);
    await M.until(async () => (await M.sent(bob, n0)).some((x) => x.a.t === 'group'), 5000, 50);
    const acts = await M.sent(bob, n0), drags = acts.filter((x) => x.a.t === 'drag'), groups = acts.filter((x) => x.a.t === 'group').map((x) => x.a);
    const span = drags.length > 1 ? drags.at(-1).at - drags[0].at : 0, peak = M.peakRate(drags);
    ok(drags.length >= 20 && drags.every((x) => Array.isArray(x.a.ids) && x.a.ids.length === 200 && new Set(x.a.ids).size === 200 && sameSet(x.a.ids, two) && Number.isFinite(x.a.dx) && Number.isFinite(x.a.dy) && !('id' in x.a)),
      `the live drag goes out as one drag {ids, dx, dy} naming the 200 (${drags.length} over ${(span / 1000).toFixed(1)} s)`);
    const pm = M.peakRate(await bob.evaluate(() => window.__pm.map((at) => ({ at }))));
    ok(peak <= 17, `at most 17 drag messages in any second (the most in one: ${peak}; the pointer moved up to ${pm} times in one)`);
    ok(!acts.some((x) => x.a.t === 'move'), 'no `move` while dragging (live positions travel as `drag`)');
    ok(groups.length === 1 && groups[0].op === 'move' && groups[0].ids.length === 200 && sameSet(groups[0].ids, two), `the drop sends one group move of the 200 (${J(groups.map((a) => ({ op: a.op, n: a.ids?.length, dx: a.dx, dy: a.dy })))})`);
    const g = groups[0] || { dx: 0, dy: 0 }, want = landing(before, two, g.dx, g.dy);
    const yardWant = yardPebs.every((id) => Math.abs(want[id].x - before[id].x - 100) < 0.5 && Math.abs(want[id].y - before[id].y) < 0.5);
    ok(yardWant, '(by the spec\'s snapping, each yard pebble lands on the cell to its right; the dice and counters move by the shift)');
    for (const p of all) {
      const done = await P.waitView(p, 'a.every(([id, w]) => v.items[id] && Math.abs(v.items[id].x - w.x) < 0.5 && Math.abs(v.items[id].y - w.y) < 0.5)', Object.entries(want), 15000);
      ok(done, `${p.label}'s screen shows every one of the 200 where the group put it${done ? '' : `: ${astray(await M.items(p), want).length} astray`}`);
    }
    const drawnOk = await M.until(() => bob.evaluate(([want]) => Object.entries(want).every(([id, w]) => { const d = window.__ct.drawn(id); return d && Math.abs(d.x - w.x) < 0.5 && Math.abs(d.y - w.y) < 0.5 && !d.tx && !d.ty; }), [want]), 5000, 100);
    ok(drawnOk, 'and Bob\'s screen draws each there, no shift left on it');
    const after = await M.items(alice);
    ok(after[lockedA].x === before[lockedA].x && after[mineA[0]].x === before[mineA[0]].x, 'the locked pebble and Alice\'s stayed put');
    await h.sleep(500);
    const said = await M.notes(bob, t0), ln = await M.lines(alice, bob.pid, t0);
    ok(!said.some((m) => /slow down|too many|🚫|skipped/i.test(m)), `Bob got no flood notice, no refusal (${J(said)})`);
    ok(ln.length === 1 && ln[0] === 'moved 200 items', `one log line: ${J(ln)}`);
    // the same relay when the pointer outruns it: a small group shaken fast (cheap frames: many pointer moves a second)
    await M.click(bob, await P_(bob, 2750, 700)); // (a click on the felt clears the 200)
    its = await M.items(alice);
    const quad = [1900, 2000, 2100, 2200].map((x) => at(x, ROW.B + 300));
    await band(bob, { x: 1840, y: ROW.B + 240 }, { x: 2260, y: ROW.B + 360 });
    ok(sameSet(await M.selected(bob), quad), '(Bob picks the four pebbles Carol moved)');
    const n1 = await M.nSent(bob), c0 = await M.centre(bob, quad[0]), c1 = await P_(bob, 1900 + 100, ROW.B + 300);
    const shake = [];
    for (let k = 0; k <= 80; k++) { const e = 25 * Math.sin((Math.PI * k) / 80); shake.push({ x: c0.x + (c1.x - c0.x) * (k / 80) + e * Math.sin(k / 3), y: c0.y + (c1.y - c0.y) * (k / 80) + e * Math.cos(k / 3), wait: 0 }); }
    shake.push({ x: c1.x, y: c1.y, wait: 0 });
    await bob.evaluate(() => { window.__pm = []; });
    await M.mouseDrag(bob, shake);
    await M.until(async () => (await M.sent(bob, n1)).some((x) => x.a.t === 'group'), 5000, 50);
    const a2 = await M.sent(bob, n1), d2 = a2.filter((x) => x.a.t === 'drag'), pm2 = M.peakRate(await bob.evaluate(() => window.__pm.map((at) => ({ at }))));
    ok(M.peakRate(d2) <= 17 && d2.length >= 5, `shaken fast, the relay still sends at most 17 a second (${d2.length} drags for ${shake.length} pointer moves, the most in one second ${M.peakRate(d2)} drags against ${pm2} moves)`);
    ok(a2.filter((x) => x.a.t === 'group').length === 1 && !a2.some((x) => x.a.t === 'move'), '(one group on the drop, no move)');
    await bob.keyboard.press('Escape');
    // the cap: a 201st is never picked
    await band(bob, { x: BX - 40, y: BY - 40 }, { x: 2540, y: ROW.A + 50 });
    await M.click(bob, await M.centre(bob, at(500, ROW.B)), true);
    const s201 = await M.selected(bob);
    ok(s201.length === 200 && sameSet(s201, two), `Shift+click on a 201st picks nothing more (${s201.length} picked; "${await M.chip(bob)}")`);
    await bob.keyboard.press('Escape');
  }

  // ===========================================================================
  section('3. the group bar and its keys (Bob): ⟳ ⟲ R Shift+R, Flip F, 🎲 Roll Space, 🔒 🔓, 👜 Into bag ▸, 🗑 Delete');
  its = await M.items(alice);
  const hx = M.ofType(its, 'hx'), sq = M.ofType(its, 'sq'), chits = M.ofType(its, 'chit'), coin = M.ofType(its, 'coin');
  const dice3 = M.ofType(its, 'die').filter((id) => Math.abs(its[id].y + 28 - ROW.C) < 1), sack = Object.keys(its).find((id) => its[id].k === 'b');
  const shop = [...hx, ...sq, ...chits, ...coin, ...dice3];
  {
    await band(bob, { x: 290, y: ROW.C - 60 }, { x: 1300, y: ROW.C + 60 });
    ok(sameSet(await M.selected(bob), shop), `a band picks the workshop's ten (${(await M.selected(bob)).length}), not the bag`);
    const b0 = await M.bar(bob);
    const has = (pre) => b0.btns.some((b) => b.startsWith(pre));
    ok(['⟲', '⟳', 'Flip', '🎲 Roll', '🔒', '👜 Into bag ▸', '🗑', '✕'].every(has), `the group bar: ${J(b0.btns)}`);
    const under = [];
    for (const id of shop) { const c = await M.centre(bob, id); if (c.x > b0.box.l && c.x < b0.box.r && c.y > b0.box.t && c.y < b0.box.b) under.push(id); }
    ok(!under.length, `it covers none of the ten (${under.length} under it)`);
    /** Runs gesture fn by Bob and returns what it sent, what the log says in his name and what he was told. */
    const step = async (fn, expr, arg) => {
      const n = await M.nSent(bob), t = Date.now() - 5;
      await fn();
      await M.until(async () => (await M.sent(bob, n)).some((x) => x.a.t === 'group'), 5000, 50);
      const applied = expr ? await P.waitView(alice, expr, arg) : true;
      await M.until(async () => (await M.lines(alice, bob.pid, t)).length > 0, 5000, 50);
      await h.sleep(300);
      return { applied, acts: (await M.sent(bob, n)).map((x) => x.a), lines: await M.lines(alice, bob.pid, t), notes: await M.notes(bob, t) };
    };
    const one = (r, op, re, what) => {
      const g = r.acts.filter((a) => a.t === 'group');
      ok(r.applied && g.length === 1 && g[0].op === op && r.acts.length === 1, `${what}: one group ${op} sent (${J(r.acts.map((a) => `${a.t}:${a.op}`))})`);
      ok(r.lines.length === 1 && re.test(r.lines[0]), `  one log line: ${J(r.lines)}`);
      ok(!r.notes.some((m) => /skipped|🚫/.test(m)), `  no skip nor refusal (${J(r.notes)})`);
    };
    // turns: by the largest rotStep among the members (60), each snapped to its own step
    const steps = Object.fromEntries([...hx.map((id) => [id, 60]), ...sq.map((id) => [id, 45]), ...chits.map((id) => [id, 0]), ...coin.map((id) => [id, 0])]);
    let rot = Object.fromEntries(Object.keys(steps).map((id) => [id, its[id].rot || 0]));
    const turn = async (what, fn, d) => {
      const want = Object.fromEntries(Object.keys(rot).map((id) => [id, snapRot(rot[id], d, steps[id])]));
      const r = await step(fn, 'Object.entries(a).every(([id, r]) => Math.abs(((((v.items[id].rot || 0) - r) % 360) + 540) % 360 - 180) < 0.01)', want);
      const now = await M.items(alice);
      ok(Object.keys(want).every((id) => Math.abs(((now[id].rot || 0) - want[id] + 540) % 360 - 180) < 0.01) && dice3.every((id) => !now[id].rot),
        `${what} turns each member by 60° snapped to its own step: ${J(Object.fromEntries(Object.keys(want).map((id) => [its[id].t.split('/')[1] + id.slice(0, 2), now[id].rot || 0])))} (the dice not at all)`);
      one(r, 'rot', /^rotated 7 items$/, what);
      rot = want;
    };
    await turn('⟳', () => M.barPress(bob, '⟳'), 60);
    await turn('R', () => bob.keyboard.press('r'), 60);
    await turn('Shift+R', () => bob.keyboard.press('Shift+R'), -60);
    await turn('⟲', () => M.barPress(bob, '⟲'), -60);
    // Flip: what turns over (the chits, by their back; the coin, to its other face), never a die
    let r = await step(() => M.barPress(bob, 'Flip'), 'a.chits.every((id) => !v.items[id].t && v.items[id].b) && v.items[a.coin].f === 1', { chits, coin: coin[0] });
    let now = await M.items(alice);
    ok(r.applied && dice3.every((id) => now[id].f === its[id].f) && [...hx, ...sq].every((id) => now[id].f === its[id].f), 'Flip turns the chits face down and the coin over; the dice and one-faced pieces stay as they were');
    one(r, 'flip', /^flipped 3 items$/, 'Flip');
    ok(sameSet(await M.selected(bob), shop), 'the face-down chits stay picked');
    r = await step(() => bob.keyboard.press('f'), 'a.chits.every((id) => v.items[id].t) && v.items[a.coin].f === 0', { chits, coin: coin[0] });
    one(r, 'flip', /^flipped 3 items$/, 'F');
    // 🎲 Roll and Space: one roll of the three dice, one line with their faces (in id order)
    for (const [what, fn] of [['🎲 Roll', () => M.barPress(bob, '🎲 Roll')], ['Space', () => bob.keyboard.press('Space')]]) {
      r = await step(fn);
      now = await M.items(alice);
      const faces = [...dice3].sort().map((id) => String(now[id].f + 1));
      one(r, 'roll', /^rolled 3 dice: /, what);
      ok(r.lines[0] === `rolled 3 dice: ${faces.join(' · ')}`, `  the line names the dice's new faces: "${r.lines[0]}" (${faces.join(' · ')})`);
    }
    // 🔒 then 🔓: the members stay picked while locked
    r = await step(() => M.barPress(bob, '🔒 Lock'), 'a.every((id) => v.items[id].lock)', shop);
    one(r, 'lock', /^locked 10 items$/, '🔒 Lock');
    ok(sameSet(await M.selected(bob), shop) && (await M.bar(bob)).btns.some((b) => b.startsWith('🔓')), 'the locked members stay picked; the bar offers 🔓');
    r = await step(() => M.barPress(bob, '🔓 Unlock'), 'a.every((id) => !v.items[id].lock)', shop);
    one(r, 'lock', /^unlocked 10 items$/, '🔓 Unlock');
    // 👜 Into bag ▸ Sack: the chits, the coin and the dice
    for (const id of [...hx, ...sq]) await M.click(bob, await M.centre(bob, id), true);
    const six = [...chits, ...coin, ...dice3];
    ok(sameSet(await M.selected(bob), six), '(Shift+clicks leave six picked)');
    await M.barPress(bob, '👜 Into bag ▸');
    const lst = await M.bar(bob);
    ok(lst.btns.includes('👜 Sack'), `👜 Into bag ▸ lists the bags on the table: ${J(lst.btns)}`);
    const n0 = its[sack].n;
    r = await step(() => M.barPress(bob, '👜 Sack'), 'a.ids.every((id) => !v.items[id]) && v.items[a.sack].n === a.n', { ids: six, sack, n: n0 + 6 });
    one(r, 'toBag', /^put 6 items into the bag Sack$/, '👜 Sack');
    ok(r.applied, `the six went into the bag: it holds ${n0} + 6`);
    ok(!(await M.selected(bob)).length, '(nothing left picked)');
    // 🗑: the turners
    await band(bob, { x: 290, y: ROW.C - 60 }, { x: 710, y: ROW.C + 60 });
    ok(sameSet(await M.selected(bob), [...hx, ...sq]), '(the four turners picked)');
    r = await step(() => M.barPress(bob, '🗑'), 'a.every((id) => !v.items[id])', [...hx, ...sq]);
    one(r, 'del', /^removed 4 items$/, '🗑');
    // Delete: what is left of row B (four pebbles and the two Shift+click targets)
    its = await M.items(alice);
    const rest = [400, 500, 600, 700, 1100, 1200].map((x) => at(x, ROW.B));
    await band(bob, { x: 340, y: ROW.B - 60 }, { x: 960, y: ROW.B + 60 });
    for (const id of rest.slice(4)) await M.click(bob, await M.centre(bob, id), true);
    ok(sameSet(await M.selected(bob), rest), `(${(await M.selected(bob)).length} picked in row B)`);
    const rot0 = Object.fromEntries(rest.map((id) => [id, its[id].rot || 0]));
    r = await step(() => M.barPress(bob, '⟳'), 'a.every(([id, r]) => Math.abs((((v.items[id].rot || 0) - r) % 360 + 540) % 360 - 180) < 0.01)', rest.map((id) => [id, snapRot(rot0[id], 90, 0)]));
    one(r, 'rot', /^rotated 6 items$/, '⟳ of pebbles (no member with a rotStep: 90°)');
    r = await step(() => bob.keyboard.press('Delete'), 'a.every((id) => !v.items[id])', rest);
    one(r, 'del', /^removed 6 items$/, 'Delete');
  }

  // ===========================================================================
  section('4. a member locked, and one claimed, by Alice in the middle of Bob\'s drag: they stay put, the rest move, one notice');
  its = await M.items(alice);
  const race = [1600, 1700, 1800, 1900].map((x) => at(x, ROW.D));
  {
    await band(bob, { x: 1540, y: ROW.D - 60 }, { x: 1960, y: ROW.D + 60 });
    ok(sameSet(await M.selected(bob), race), '(Bob picks the four counters)');
    const n0 = await M.nSent(bob), t0 = Date.now() - 5;
    const S = { x: 1600, y: ROW.D }, pts = [];
    for (let k = 0; k <= 6; k++) pts.push({ ...(await P_(bob, S.x + 10 * k, S.y)), wait: 30 });
    await bob.mouse.move(pts[0].x, pts[0].y);
    await bob.mouse.down();
    for (const q of pts.slice(1)) { await bob.mouse.move(q.x, q.y); await h.sleep(30); }
    // Alice: a click on the second, 🔒 Lock; a click on the third, 👤 Claim — each just after Bob's pointer moved
    // again (where Alice's screen draws a counter while it glides holds for 1.5 s after the last drag it saw)
    let nudge = 60;
    for (const [id, cmd] of [[race[1], '🔒 Lock'], [race[2], '👤 Claim']]) {
      const q = await P_(bob, S.x + (nudge += 6), S.y);
      await bob.mouse.move(q.x, q.y);
      await h.sleep(150);
      await M.click(alice, await M.centre(alice, id));
      ok(J(await M.selected(alice)) === J([id]), `(Alice's click selects the counter gliding under Bob's drag: ${J(await M.selected(alice))})`);
      await M.barPress(alice, cmd);
      await alice.keyboard.press('Escape');
    }
    ok(await P.waitView(bob, 'v.items[a[0]].lock && v.items[a[1]].owner === a[2]', [race[1], race[2], alice.pid]), '(Bob\'s screen shows the second locked and the third Alice\'s, his mouse still down)');
    for (let k = 1; k <= 10; k++) { const q = await P_(bob, S.x + nudge + ((200 - nudge) * k) / 10, S.y); await bob.mouse.move(q.x, q.y); await h.sleep(30); }
    await bob.mouse.up();
    await M.until(async () => (await M.sent(bob, n0)).some((x) => x.a.t === 'group'), 5000, 50);
    const g = (await M.sent(bob, n0)).map((x) => x.a).filter((a) => a.t === 'group');
    ok(g.length === 1 && g[0].op === 'move', `the drop sends one group move (${J(g.map((a) => ({ op: a.op, n: a.ids?.length })))})`);
    const dx = g[0]?.dx ?? 0, dy = g[0]?.dy ?? 0;
    const want = { [race[0]]: { x: its[race[0]].x + dx, y: its[race[0]].y + dy }, [race[3]]: { x: its[race[3]].x + dx, y: its[race[3]].y + dy }, [race[1]]: its[race[1]], [race[2]]: its[race[2]] };
    for (const p of all) ok(await P.waitView(p, 'a.every(([id, w]) => Math.abs(v.items[id].x - w.x) < 0.5 && Math.abs(v.items[id].y - w.y) < 0.5)', Object.entries(want)), `${p.label}: the first and fourth moved by (${dx.toFixed(1)}, ${dy.toFixed(1)}), the locked and the claimed stayed put`);
    const back = await M.until(() => bob.evaluate((ids) => ids.every((id) => { const d = window.__ct.drawn(id), it = window.__ct.view().items[id]; return d && Math.abs(d.x - it.x) < 0.5 && Math.abs(d.y - it.y) < 0.5 && !d.tx && !d.ty; }), [race[1], race[2]]), 4000, 100);
    ok(back, 'Bob\'s screen draws those two back where they are');
    await h.sleep(500);
    const said = await M.notes(bob, t0), ln = await M.lines(alice, bob.pid, t0);
    ok(said.filter((m) => /skipped/.test(m)).length === 1 && said.some((m) => /\b2 of 4 were skipped: \S/.test(m)), `Bob is told once: ${J(said)}`);
    ok(ln.length === 1 && ln[0] === 'moved 2 items', `one line: ${J(ln)}`);
    await bob.keyboard.press('Escape');
  }

  // ===========================================================================
  section('5. rules that veto one member in the middle of a group: only it stays put, one notice names one skip');
  its = await M.items(alice);
  const five = [300, 400, 500, 600, 700].map((x) => at(x, ROW.D)), flag = M.ofType(its, 'flag')[0];
  {
    await h.enableRules(alice, { code: PICKET });
    ok(await P.waitView(bob, 'v.rules?.enabled && v.rules.name === "Picket"'), '(Alice enables the «Picket» rules from 📜)');
    const byZ = [...five].sort((a, b) => its[a].z - its[b].z);
    ok(five.includes(flag) && byZ.indexOf(flag) > 0 && byZ.indexOf(flag) < 4, `(the flag is in the middle of the five by z: ${byZ.indexOf(flag) + 1} of 5)`);
    await band(bob, { x: 240, y: ROW.D - 60 }, { x: 760, y: ROW.D + 60 });
    ok(sameSet(await M.selected(bob), five), '(Bob picks the five)');
    const n0 = await M.nSent(bob), t0 = Date.now() - 5;
    const from = await M.centre(bob, five[0]), to = await P_(bob, 300 + 150, ROW.D - 120);
    await M.mouseDrag(bob, P3.steps(from, to, 14), { pause: 25 });
    await M.until(async () => (await M.sent(bob, n0)).some((x) => x.a.t === 'group'), 5000, 50);
    const g = (await M.sent(bob, n0)).map((x) => x.a).filter((a) => a.t === 'group');
    ok(g.length === 1 && g[0].op === 'move' && sameSet(g[0].ids, five), `one group move of the five sent (${J(g.map((a) => ({ op: a.op, n: a.ids?.length })))})`);
    const dx = g[0]?.dx ?? 0, dy = g[0]?.dy ?? 0;
    const want = Object.fromEntries(five.map((id) => [id, id === flag ? its[id] : { x: its[id].x + dx, y: its[id].y + dy }]));
    for (const p of all) ok(await P.waitView(p, 'a.every(([id, w]) => Math.abs(v.items[id].x - w.x) < 0.5 && Math.abs(v.items[id].y - w.y) < 0.5)', Object.entries(want)), `${p.label}: the four pebbles moved by (${dx.toFixed(1)}, ${dy.toFixed(1)}), the flag stayed put`);
    const back = await M.until(() => bob.evaluate((id) => { const d = window.__ct.drawn(id), it = window.__ct.view().items[id]; return d && Math.abs(d.x - it.x) < 0.5 && Math.abs(d.y - it.y) < 0.5 && !d.tx && !d.ty; }, flag), 4000, 100);
    ok(back, 'Bob\'s screen draws the flag back where it was');
    await h.sleep(600);
    const said = await M.notes(bob, t0), mine = await M.lines(alice, bob.pid, t0), rules = await M.lines(alice, 'rules', t0);
    ok(said.filter((m) => /skipped/.test(m)).length === 1 && said.some((m) => /\b1 of 5 (was|were) skipped: The flag holds its ground/.test(m)), `the notice names one skip and its reason: ${J(said)}`);
    ok(mine.length === 1 && mine[0] === 'moved 4 items', `one line in Bob's name: ${J(mine)}`);
    ok(!rules.some((l) => /picket: the flag tried/.test(l)), `the vetoed member's own line was rolled back with it (rules lines: ${J(rules)})`);
    ok(rules.filter((l) => /^blocked Bob: The flag holds its ground/.test(l)).length === 1, '  and the rules say once whom they blocked, and why');
    const data = await alice.evaluate(() => window.__ct.hostState().rules.data);
    ok(!data.tries && data.moved === 4, `and its write to t.data too; onAction ran for the four that moved (t.data ${J(data)})`);
  }

  await env.done();
})().catch(h.crash);
