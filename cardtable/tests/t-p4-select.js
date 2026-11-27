// Phase 4B part 2 (spec §4g, §4l t-p4-select): multi-select, the group
// drag, the group bar and its keys, and the stack inspector, on real
// screens with real gestures — a desktop (mouse and keyboard) and an iPhone
// 13 (CDP touches), upright and held sideways — host + guests:
//  1. the rubber band (Shift+drag on the felt and on a locked board; ⬚
//     select mode's plain drag, one finger on the phone), Shift+click and a
//     tap in ⬚ mode, the "N not selectable" chip, clearing (Esc, a click on
//     the felt, ✕, ⬚ off); boards never picked;
//  2. a group drag of 200 members: every one moved on both screens, at most
//     17 `drag` messages a second from the dragger, no flood notice, the
//     drop's one `group` applied (and B19's browser figures: the host's
//     apply, the patch each peer receives);
//  3. the group bar (⟲ ⟳ by the largest rotStep, Flip, 🎲 Roll, 🔒 / 🔓, 👜
//     Into bag ▸, 🗑, ✕) and the keys R, F, Space and Delete;
//  4. locked and someone else's items: not picked (the chip), and a forged
//     group naming them skipped, said once;
//  5. a rules script vetoing one member mid-group: that one stays, the rest
//     move, one notice names one skip;
//  6. the stack inspector: Take k, Take all, a hidden stack's back, a
//     crowded spot's members (a tap selects, a drag carries one out), and it
//     follows the stack it shows; never over what it shows, nor the group
//     bar over its group.
'use strict';
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const { until, view, act } = require('./p1-lib');
const { shown, box, itemsBox, overlap, inside, toasts, said, shot, tap, press, pinch, outside, hold, badgeAt, inspector } = require('./p4s-lib');

const J = JSON.stringify;
/** The test box (original): a 22 × 12 board of 100-unit cells, 200 tokens on
 *  its first 20 columns of rows 0–9, and on row 10 a crowded cell (three
 *  pegs), a flag (which the rules below won't let move) and two tokens (one
 *  to be someone else's, one locked); below the board a ×10 stack, a hidden
 *  ×5 stack of chits, three dice, a bag and four chits. */
const BOX = (() => {
  const setup = [{ piece: 'field', at: 'center' }];
  for (let r = 0; r < 10; r++) setup.push({ piece: 'tok', count: 20, spread: [100, 0], at: [120, 270 + 100 * r] });
  setup.push(
    { piece: 'peg', count: 3, at: [320, 1270] }, { piece: 'flag', at: [620, 1270] }, { piece: 'tok', count: 2, spread: [100, 0], at: [920, 1270] },
    { piece: 'tok', n: 10, at: [200, 1520] }, { piece: 'chit', n: 5, up: false, at: [540, 1515] },
    { piece: 'die', count: 3, spread: [80, 0], at: [780, 1520] }, { bag: ['tok'], name: 'Sack', at: [1100, 1500] },
    { piece: 'chit', count: 4, spread: [100, 0], at: [1400, 1515] },
  );
  return {
    name: 'Picking ground', imgs: [], lockable: 'anyone', table: { shape: 'rect', w: 2400, h: 1700 },
    backs: { b: { face: { color: '#334155', label: '?' } } },
    types: {
      field: { kind: 'board', name: 'Field', w: 2200, h: 1200, faces: [{ color: '#a3b18a' }], board: { grid: { type: 'square', cols: 22, rows: 12, cell: 100, x: 0, y: 0, draw: 'lines' } } },
      tok: { kind: 'token', name: 'Token', w: 60, faces: [{ color: '#f59e0b', label: 'T' }, { color: '#0ea5e9', label: 'U' }] },
      peg: { kind: 'token', name: 'Peg', shape: 'rect', w: 60, faces: [{ color: '#a855f7', label: 'P' }] },
      flag: { kind: 'token', name: 'Flag', w: 60, faces: [{ color: '#dc2626', label: 'F' }] },
      chit: { kind: 'tile', name: 'Chit', w: 70, h: 70, stack: 'count', back: 'b', faces: [{ color: '#fde68a', label: 'C' }] },
      die: { kind: 'die', name: 'Die' },
    },
    setup,
  };
})();
/** The rules of section 5: the flag never moves. */
const RULES = "({ name: 'Flag guard', validate(t, a) { if (a.t === 'move' && /\\/flag$/.test(t.item(a.id)?.t || '')) return 'The flag stays put'; } })";
/** The table point at the centre of the board's cell (c, r). */
const cell = (c, r) => ({ x: 150 + 100 * c, y: 300 + 100 * r });

/** The ids of view `v`'s items whose type is `ty`, by their centre: cell(c, r) → id. */
function byCell(v, ty) {
  const out = {};
  for (const [id, it] of Object.entries(v.items)) {
    if (!it.t?.endsWith(`/${ty}`) || it.n >= 2) continue;
    const c = Math.round((it.x + 30 - 150) / 100), r = Math.round((it.y + 30 - 300) / 100);
    if (Math.abs(it.x + 30 - cell(c, r).x) < 0.5 && Math.abs(it.y + 30 - cell(c, r).y) < 0.5) (out[`${c},${r}`] ||= []).push(id);
  }
  return out;
}
(async () => {
  const env = await h.start();
  const alice = await P3.join(env, 'Alice', env.url);
  const bob = await P3.join(env, 'Bob', alice.url());
  for (const p of [alice, bob]) await toasts(p);
  alice.on('dialog', (d) => d.accept());

  section('the test box: 200 tokens on a board, a crowded cell, a flag, stacks, dice, a bag');
  const r0 = await act(alice, { t: 'loadBox', box: BOX, setup: true, clear: true });
  ok(r0?.ok, `the box is set up (${J(r0)})`);
  ok(await until(async () => Object.keys((await view(bob)).items).length === 217, 15000), 'both screens: 217 items');
  let v = await view(bob);
  const toks = byCell(v, 'tok'), pegs = byCell(v, 'peg')['2,10'] || [], flag = byCell(v, 'flag')['5,10'][0];
  const at = (c, r) => toks[`${c},${r}`][0], ITEMS = Object.entries(v.items);
  const theirs = at(8, 10), locked = at(9, 10);
  const stack = ITEMS.find(([, it]) => it.t?.endsWith('/tok') && it.n === 10)[0], hidden = ITEMS.find(([, it]) => it.k === 'g' && it.n === 5)[0];
  const dice = ITEMS.filter(([, it]) => it.t?.endsWith('/die')).map(([id]) => id), bag = ITEMS.find(([, it]) => it.k === 'b')[0];
  const chits = ITEMS.filter(([, it]) => it.t?.endsWith('/chit') && !(it.n >= 2)).map(([id]) => id), board = ITEMS.find(([, it]) => it.z < 0)[0];
  const ALL = Array.from({ length: 200 }, (_, k) => at(k % 20, Math.floor(k / 20)));
  ok(pegs.length === 3 && flag && ALL.every(Boolean) && new Set(ALL).size === 200 && dice.length === 3 && chits.length === 4, `found the pieces (pegs ${pegs.length}, flag ${!!flag}, 200 tokens, dice ${dice.length}, chits ${chits.length})`);
  await act(alice, { t: 'owner', id: theirs, to: alice.pid });
  await act(alice, { t: 'lock', id: locked, on: true });
  ok(await until(async () => { const w = await view(bob); return w.items[theirs].owner === alice.pid && w.items[locked].lock; }, 10000), "Alice owns one token and has locked another");
  ok(await until(async () => (await bob.evaluate(() => document.querySelector(`#table .item .fanb`)?.textContent)) === '×3', 5000), 'the crowded cell shows ×3');

  section('1. desktop: a Shift+drag band on the (locked) board, the chip, Shift+click, Esc, a click on the felt');
  const B = (p, c, r) => P3.screenOf(p, cell(c, r).x, cell(c, r).y);
  const corner = async (p, c, r, dx, dy) => P3.screenOf(p, cell(c, r).x + dx, cell(c, r).y + dy);
  // from the board's corner of cell (0,0) (no piece there: the board, locked, is felt) over six tokens
  await P.mouseDrag(bob, await corner(bob, 0, 0, -45, -45), await corner(bob, 2, 1, 45, 45), { shift: true });
  let s = await shown(bob);
  const six = [at(0, 0), at(1, 0), at(2, 0), at(0, 1), at(1, 1), at(2, 1)];
  ok(J([...s.ids].sort()) === J([...six].sort()), `the band picks the six tokens it covers (${s.ids.length}), never the board`);
  ok(/^6 selected/.test(s.bar) && /⟲/.test(s.bar) && /Flip/.test(s.bar) && /🔒 Lock/.test(s.bar) && /👜 Into bag ▸/.test(s.bar) && /🗑/.test(s.bar) && /✕/.test(s.bar) && !/🎲/.test(s.bar),
    `the group bar: "${s.bar}" (no 🎲: no die among them)`);
  const gb = await box(bob, '#action-bar'), gi = await itemsBox(bob, six);
  ok(gb && !overlap(gb, gi), 'the group bar stands beside the group, not over it');
  await P.mouseDrag(bob, await corner(bob, 4, 10, -45, -45), await corner(bob, 9, 10, 45, 45), { shift: true });
  s = await shown(bob);
  ok(s.ids.length === 7 && s.ids.includes(flag) && !s.ids.includes(theirs) && !s.ids.includes(locked), `a second band adds the flag alone (${s.ids.length} picked)`);
  ok(/^2 not selectable \(locked or someone else's\)$/.test(s.chip), `the chip: "${s.chip}"`);
  await bob.keyboard.down('Shift');
  await tap(bob, await B(bob, 3, 0));
  await tap(bob, await B(bob, 0, 0));
  await bob.keyboard.up('Shift');
  s = await shown(bob);
  ok(s.ids.length === 7 && s.ids.includes(at(3, 0)) && !s.ids.includes(at(0, 0)), 'Shift+click adds a token, and takes a picked one out');
  await bob.keyboard.press('Escape');
  ok((await shown(bob)).ids.length === 0 && !(await shown(bob)).bar, 'Esc clears the selection and the bar');
  await P.mouseDrag(bob, await corner(bob, 0, 0, -45, -45), await corner(bob, 2, 1, 45, 45), { shift: true });
  await tap(bob, await P.feltPoint(bob, { band: [0.02, 0.12] }));
  ok((await shown(bob)).ids.length === 0, 'a click on the felt clears it');
  await bob.keyboard.down('Shift');
  await tap(bob, await B(bob, 1, 1));
  await bob.keyboard.up('Shift');
  s = await shown(bob);
  ok(J(s.ids) === J([at(1, 1)]) && /⋯|Flip/.test(s.bar) && !/selected/.test(s.bar), 'one item picked is just selected: its own bar');

  section('1. desktop: ⬚ select mode — a plain drag draws a band, a click picks; ⬚ off clears');
  await bob.click('#sel-mode');
  ok(await bob.evaluate(() => document.getElementById('sel-mode').classList.contains('on')) && /drag a box/.test((await shown(bob)).chip), '⬚ is on, and says how to select');
  await P.mouseDrag(bob, await corner(bob, 10, 2, -45, -45), await corner(bob, 11, 3, 45, 45));
  await tap(bob, await B(bob, 12, 2));
  s = await shown(bob);
  ok(s.ids.length === 6 && s.ids.includes(at(1, 1)) && s.ids.includes(at(12, 2)), `the band adds four, the click one more (${s.ids.length})`);
  await tap(bob, await B(bob, 12, 2));
  ok((await shown(bob)).ids.length === 5, 'a click on a picked one puts it back');
  await bob.click('#sel-mode');
  ok((await shown(bob)).ids.length === 0, '⬚ off clears the selection');

  section('3. the group bar and the keys: ⟲ ⟳, Flip, 🎲 Roll, 🔒 / 🔓, 👜 Into bag ▸, 🗑, ✕');
  const pickAll = async (ids) => { await bob.keyboard.down('Shift'); for (const id of ids) await tap(bob, await P3.centreOf(bob, id)); await bob.keyboard.up('Shift'); };
  await pickAll([...chits, ...dice]);
  s = await shown(bob);
  ok(s.ids.length === 7 && /🎲 Roll/.test(s.bar), `four chits and three dice picked: "${s.bar}"`);
  await bob.keyboard.press('r');
  ok(await until(async () => { const w = await view(alice); return chits.every((id) => w.items[id].rot === 90) && dice.every((id) => !w.items[id].rot); }, 10000), 'R turns the chits by their rotStep (90), the dice not (they look the same at any angle)');
  await bob.click('#action-bar [data-cmd="rl"]');
  ok(await until(async () => chits.every(async () => true) && (await view(alice)).items[chits[0]].rot === 0, 10000), '⟲ turns them back');
  await bob.keyboard.press('f');
  ok(await until(async () => { const w = await view(alice); return chits.every((id) => !('t' in w.items[id]) && 'b' in w.items[id]); }, 10000), 'F turns the chits face down (the public view shows their backs)');
  ok(await until(async () => (await view(bob)).log.some((e) => e.txt === 'flipped 4 items'), 10000), 'one line in the log: "flipped 4 items"');
  await bob.keyboard.press(' ');
  ok(await until(async () => (await view(alice)).log.some((e) => /^rolled 3 dice: \d · \d · \d$/.test(e.txt)), 10000), 'Space rolls the three dice as one: "rolled 3 dice: a · b · c"');
  await bob.click('#action-bar [data-cmd="lock"]');
  ok(await until(async () => { const w = await view(bob); return [...chits, ...dice].every((id) => w.items[id].lock); }, 10000), '🔒 Lock locks the seven');
  ok(await until(async () => /🔓 Unlock/.test((await shown(bob)).bar) && (await shown(bob)).ids.length === 7, 5000), 'they stay picked, and the bar offers 🔓 Unlock');
  await bob.click('#action-bar [data-cmd="lock"]');
  ok(await until(async () => { const w = await view(bob); return [...chits, ...dice].every((id) => !w.items[id].lock); }, 10000), '🔓 Unlock unlocks them');
  await bob.click('#action-bar [data-cmd="none"]');
  ok((await shown(bob)).ids.length === 0, '✕ clears the selection');
  const two = [at(15, 9), at(16, 9)];
  await pickAll(two);
  await bob.click('#action-bar [data-cmd="bag"]');
  ok(await bob.evaluate(() => [...document.querySelectorAll('#action-bar [data-cmd="bagTo"]')].map((b) => b.textContent).join()) === '👜 Sack', '👜 Into bag ▸ lists the bags on the table');
  await bob.click('#action-bar [data-cmd="bagTo"]');
  ok(await until(async () => { const w = await view(alice); return two.every((id) => !w.items[id]) && w.items[bag].n === 3; }, 10000), 'the two tokens go into the Sack (3 in it)');
  ok(await until(async () => (await shown(bob)).ids.length === 0 && !(await shown(bob)).bar, 5000), 'gone into the bag, they leave the selection');
  const three = [at(17, 9), at(18, 9), at(19, 9)];
  await pickAll(three);
  await bob.keyboard.press('Delete');
  ok(await until(async () => { const w = await view(alice); return three.every((id) => !w.items[id]); }, 10000) && (await view(bob)).log.some((e) => e.txt === 'removed 3 items'), 'Delete removes the three: "removed 3 items"');

  section('4. locked and someone else\'s: never picked; a forged group of them is skipped, said once');
  const r4 = await bob.evaluate(([ids]) => window.__ct.act({ t: 'group', op: 'move', ids, dx: 0, dy: -100 }), [[at(6, 9), theirs, locked]]);
  ok(r4, 'Bob sends a group move naming his token, Alice\'s and the locked one');
  ok(await said(bob, /^2 of 3 were skipped: /), 'one notice: "2 of 3 were skipped: …"');
  ok(await until(async () => { const w = await view(alice); return w.items[at(6, 9)].y === v.items[at(6, 9)].y - 100 && w.items[theirs].y === v.items[theirs].y && w.items[locked].y === v.items[locked].y; }, 10000), 'his moved; the other two stayed');

  section('5. a rules script vetoes one member mid-group: that one stays, the rest move, one notice');
  ok((await act(alice, { t: 'setRules', code: RULES, enabled: true }))?.ok, 'the rules «Flag guard» on (the flag never moves)');
  await until(async () => (await view(bob)).rules?.enabled, 10000);
  const vf = await view(bob), four = [flag, at(4, 9), at(5, 9), at(7, 9)];
  await pickAll(four);
  await P3.gesture(bob, P3.steps(await P3.centreOf(bob, at(4, 9)), await P3.screenOf(bob, cell(4, 9).x, cell(4, 9).y - 200), 10));
  ok(await said(bob, /^1 of 4 was skipped: The flag stays put$/), 'one notice: "1 of 4 was skipped: The flag stays put"');
  ok(await until(async () => { const w = await view(alice); return w.items[flag].y === vf.items[flag].y && four.slice(1).every((id) => w.items[id].y === vf.items[id].y - 200); }, 10000), 'the flag stayed; the three tokens moved two rows up (on the host\'s screen)');
  ok(await until(async () => { const d = await bob.evaluate((id) => window.__ct.drawn(id), flag); return Math.abs(d.y - vf.items[flag].y) < 0.5; }, 5000), 'on Bob\'s screen the flag is back where it was');
  ok(await until(async () => (await view(alice)).log.some((e) => /^blocked Bob: The flag stays put \(1 of 4\)$/.test(e.txt)), 5000), 'the log: "blocked Bob: The flag stays put (1 of 4)"');
  await bob.keyboard.press('Escape');
  await act(alice, { t: 'setRules', enabled: false });
  await until(async () => !(await view(bob)).rules?.enabled, 10000);

  section('2. a group drag of 200: ≤ 17 `drag` a second, no flood notice, the drop applied on both screens (B19 in the browser)');
  v = await view(bob);
  const g200 = Object.entries(v.items).filter(([, it]) => it.t?.endsWith('/tok') && !(it.n >= 2) && !it.owner && !it.lock && it.y < 1250).map(([id]) => id);
  await bob.keyboard.down('Shift');
  await P.mouseDrag(bob, await corner(bob, 0, 0, -45, -60), await corner(bob, 19, 9, 45, 45));
  await bob.keyboard.up('Shift');
  s = await shown(bob);
  ok(g200.length === 195 && s.ids.length === 195, `the band picks the board's ${s.ids.length} tokens (${g200.length} there)`);
  // the five tokens of the pile ×10, the hidden stack… are below the board: add the ×10 stack and four of the chits' neighbours to reach 200
  await pickAll([stack, ...chits]); // (the ×10 stack and the four chits below the board make 200)
  s = await shown(bob);
  ok(s.ids.length === 200 && /^200 selected/.test(s.bar), `200 picked: "${s.bar.slice(0, 13)}"`);
  await pickAll([dice[0]]);
  ok(/^200 at most$/.test((await shown(bob)).chip) && (await shown(bob)).ids.length === 200, 'a 201st is refused: "200 at most"');
  const sel200 = (await shown(bob)).ids, v0 = await view(alice);
  await bob.evaluate(() => { window.__acts.length = 0; });
  const from = await P3.centreOf(bob, at(10, 5)), to = await P3.screenOf(bob, cell(10, 5).x + 100, cell(10, 5).y);
  const path0 = Array.from({ length: 120 }, (_, k) => { const a = (k / 120) * 2 * Math.PI, f = k / 119; return { x: from.x + (to.x - from.x) * f + 25 * Math.sin(a), y: from.y + (to.y - from.y) * f + 25 * Math.sin(2 * a), wait: 16 }; });
  let midLives = 0, bodies0 = 0;
  await P3.gesture(bob, [from, ...path0, { ...to, wait: 100 }], { mid: async () => {
    midLives = Object.keys(await alice.evaluate(() => window.__ct.lives())).length;
    bodies0 = await bob.evaluate(() => window.__rtc.bodies.length);
  } });
  const acts = await bob.evaluate(() => window.__acts.map(({ at, a }) => ({ at, t: a.t, n: a.ids?.length, op: a.op })));
  const drags = acts.filter((a) => a.t === 'drag'), groups = acts.filter((a) => a.t === 'group');
  const perSec = Math.max(0, ...drags.map((d) => drags.filter((e) => e.at >= d.at && e.at < d.at + 1000).length));
  ok(drags.length >= 10 && drags.every((d) => d.n === 200), `${drags.length} drags of 200 ids each over ${Math.round(drags.at(-1).at - drags[0].at)} ms`);
  ok(perSec <= 17, `at most ${perSec} drags in any second (≤ 17)`);
  ok(groups.length === 1 && groups[0].op === 'move' && groups[0].n === 200, `the drop: one group move of 200 (${J(groups)})`);
  ok(midLives === 200, `mid-drag, Alice's screen glides all 200 (${midLives})`);
  // (the board's tokens snap a whole cell right; the stack and chits off the board move by the drag's own shift, a pixel's worth from 100)
  const moved = async (p) => { const w = await view(p); return sel200.every((id) => Math.abs(w.items[id].x - v0.items[id].x - 100) < (v0.items[id].y < 1250 ? 0.5 : 4) && Math.abs(w.items[id].y - v0.items[id].y) < 4); };
  ok(await until(() => moved(alice), 15000) && await until(() => moved(bob), 15000), 'every member moved one cell right, on both screens (each board token snapped on its own)');
  ok(!(await bob.evaluate(() => window.__toasts.some((t) => /slow down/.test(t)))), 'no flood notice');
  ok(await until(async () => (await view(alice)).log.some((e) => e.txt === 'moved 200 items'), 5000), 'one line: "moved 200 items"');
  const job = await alice.evaluate(() => window.__ct.perf.lastJobMs);
  const patch = await bob.evaluate((k) => Math.max(0, ...window.__rtc.bodies.slice(k).filter((b) => Object.keys({ ...b.body.items, ...b.body.pos }).length >= 200).map((b) => JSON.stringify(b.body).length)), bodies0);
  console.log(`  B19 (browser): the host's apply of the 200-member group ${job.toFixed(2)} ms; the patch that brought it to Bob ${(patch / 1024).toFixed(1)} KB`);
  ok(job <= 15, `B19: the host's apply ≤ 15 ms (${job.toFixed(2)})`);
  ok(patch > 0 && patch <= 30 * 1024, `B19: the patch to Bob ≤ 30 KB (${(patch / 1024).toFixed(1)} KB)`);
  await shot(bob, 'p4-select-desktop');
  await bob.keyboard.press('Escape');

  section('6. desktop: the stack inspector — Take k, Take all, a hidden stack\'s back, a crowded cell\'s members');
  await tap(bob, await badgeAt(bob, stack, 'count'));
  let I = await inspector(bob);
  ok(I && /×10 in this stack/.test(I.text) && /Take/.test(I.text) && /Take all/.test(I.text), `a click on the ×10 badge opens the inspector: "${I?.text}"`);
  ok(!overlap(await box(bob, '#inspector'), await itemsBox(bob, [stack])), 'beside the stack, not over it');
  await bob.click('#inspector [data-ins="more"]');
  await bob.click('#inspector [data-ins="more"]');
  ok((await inspector(bob)).k === 3, 'the stepper: Take 3');
  await bob.click('#inspector [data-ins="take"]');
  ok(await until(async () => { const w = await view(alice); return w.items[stack]?.n === 7 && Object.values(w.items).some((it) => it.t?.endsWith('/tok') && it.n === 3); }, 10000), 'Take 3: the stack ×7, and a ×3 beside it');
  ok(await until(async () => /×7 in this stack/.test((await inspector(bob))?.text || ''), 5000), 'the inspector follows the stack: ×7');
  await act(alice, { t: 'split', id: stack, n: 1, x: 300, y: 1450 });
  ok(await until(async () => /×6 in this stack/.test((await inspector(bob))?.text || ''), 10000), "Alice takes one: Bob's inspector shows ×6");
  await bob.click('#inspector [data-ins="all"]');
  ok(!(await inspector(bob)) && await bob.evaluate(() => !!document.querySelector('#action-bar [data-cmd="all"].on')), 'Take all: the inspector closes, ✥ Move all armed in the bar');
  const st0 = (await view(bob)).items[stack];
  await P3.dragTo(bob, stack, { x: st0.x + 30 - 100, y: st0.y + 30 }); // (left, off the board: nothing snaps)
  ok(await until(async () => { const w = await view(alice); return w.items[stack]?.n === 6 && Math.abs(w.items[stack].x - st0.x + 100) < 2; }, 10000), 'the next drag carries the whole stack (×6)');
  await tap(bob, await badgeAt(bob, hidden, 'count'));
  I = await inspector(bob);
  ok(I && I.back && /A hidden piece/.test(I.text) && /×5/.test(I.text), `a hidden stack shows its back: "${I?.text}"`);
  await bob.keyboard.press('Escape');
  ok(!(await inspector(bob)), 'Esc closes it');
  const top = (await view(bob)).items, topPeg = pegs.reduce((a, b) => (top[a].z > top[b].z ? a : b));
  await tap(bob, await badgeAt(bob, topPeg, 'fanb'));
  I = await inspector(bob);
  ok(I && I.rows.length === 3 && I.rows[0] === topPeg && /3 pieces here/.test(I.text), `a click on the ×3 opens the cell's members, the top one first (${I?.rows.length})`);
  await shot(bob, 'p4-inspector-desktop');
  await tap(bob, await outside(bob));
  ok(!(await inspector(bob)), 'a click outside closes it');
  await tap(bob, await badgeAt(bob, topPeg, 'fanb'));
  await bob.click(`#inspector li[data-id="${pegs.find((id) => id !== topPeg)}"]`);
  ok(!(await inspector(bob)) && (await shown(bob)).ids[0] === pegs.find((id) => id !== topPeg) && /Claim/.test((await shown(bob)).bar), 'a click on a member selects it: its bar');
  await bob.keyboard.press('Escape');
  await tap(bob, await badgeAt(bob, topPeg, 'fanb'));
  const out = pegs.find((id) => id !== topPeg), li = await bob.evaluate((id) => { const r = document.querySelector(`#inspector li[data-id="${id}"]`).getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; }, out);
  const dest = await P3.screenOf(bob, cell(14, 10).x, cell(14, 10).y);
  await P3.gesture(bob, P3.steps(li, dest, 14));
  ok(await until(async () => { const w = await view(alice); return Math.abs(w.items[out].x + 30 - cell(14, 10).x) < 0.5 && Math.abs(w.items[out].y + 30 - cell(14, 10).y) < 0.5; }, 10000), 'a drag out of the list carries that peg to the cell it is dropped on');
  ok(await until(async () => !(await bob.evaluate(() => document.querySelector('#table .item .fanb')?.textContent === '×3')), 5000), 'the cell holds two now (×2)');

  section('iPhone 13 upright: ⬚ select mode, a one-finger band, taps, a finger drags the group, the bar beside it, ✕');
  const carol = await P3.join(env, 'Carol', alice.url(), { ctx: P.PHONE });
  await toasts(carol);
  ok(await until(async () => Object.keys((await view(carol)).items).length > 200, 15000), 'Carol (an iPhone, held upright) sees the table');
  // two fingers spread over the board's middle: zoomed in, the tokens are a fingertip wide
  await pinch(carol, await P3.screenOf(carol, cell(12, 4).x, cell(12, 4).y), 60, 300);
  await h.sleep(400);
  await carol.tap('#sel-mode');
  const CB = (c, r, dx = 0, dy = 0) => P3.screenOf(carol, cell(c, r).x + dx, cell(c, r).y + dy);
  await P.touchDrag(carol, await CB(11, 3, -45, -45), await CB(12, 4, 45, 45));
  s = await shown(carol);
  const here = byCell(await view(carol), 'tok'), four2 = ['11,3', '12,3', '11,4', '12,4'].map((k) => here[k]?.[0]); // (the tokens moved a cell right in section 2)
  ok(s.ids.length === 4 && four2.every((id) => s.ids.includes(id)), `one finger draws a band: the four tokens it covers (${s.ids.length})`);
  // (a neighbour the group bar doesn't cover: it stands beside the group, maybe over the next piece)
  const nb = await box(carol, '#action-bar'), fifth = [];
  for (const k of ['13,4', '13,3', '10,4', '10,3']) { const q = await CB(...k.split(',').map(Number)); if (!(q.x > nb.l && q.x < nb.r && q.y > nb.t && q.y < nb.b)) { fifth.push(q); break; } }
  await tap(carol, fifth[0], true);
  ok((await shown(carol)).ids.length === 5, 'a tap picks a fifth');
  const cb = await box(carol, '#action-bar'), W = await carol.evaluate(() => [innerWidth, innerHeight]);
  ok(cb && inside(cb, ...W) && !overlap(cb, await itemsBox(carol, (await shown(carol)).ids)), 'the group bar is on the screen, beside the group');
  ok(await carol.evaluate(() => [...document.querySelectorAll('#action-bar button')].every((b) => b.getBoundingClientRect().height >= 40)), 'its buttons are a fingertip tall');
  await shot(carol, 'p4-select-iphone');
  const cv0 = await view(alice), cg = (await shown(carol)).ids;
  await P3.gesture(carol, [...P3.steps(await P3.centreOf(carol, cg[0]), await P3.screenOf(carol, cv0.items[cg[0]].x + 30, cv0.items[cg[0]].y + 30 + 300), 12, 20), { ...(await P3.screenOf(carol, cv0.items[cg[0]].x + 30, cv0.items[cg[0]].y + 30 + 300)), wait: 150 }], { touch: true });
  ok(await until(async () => { const w = await view(alice); return cg.every((id) => Math.abs(w.items[id].y - cv0.items[id].y - 300) < 0.5); }, 10000), 'a finger drags the five three rows down, on the host\'s screen too');
  await press(carol, '#action-bar [data-cmd="none"]', true);
  ok((await shown(carol)).ids.length === 0, '✕ clears them');
  await carol.tap('#sel-mode');

  section('iPhone 13: a long press on a ×N stack opens the inspector (the zoom stays the single pieces\'); Take k by taps');
  await carol.tap('#view-btn'); // (🧭: the whole table again)
  await pinch(carol, await P3.centreOf(carol, stack), 60, 260);
  await h.sleep(400);
  await hold(carol, await P3.centreOf(carol, stack));
  I = await inspector(carol);
  ok(I && /×6 in this stack/.test(I.text), `a long press on the ×6 stack: the inspector ("${I?.text}")`);
  ok(!overlap(await box(carol, '#inspector'), await itemsBox(carol, [stack])) && inside(await box(carol, '#inspector'), ...W), 'on the screen, beside the stack');
  ok(await carol.evaluate(() => [...document.querySelectorAll('#inspector button')].every((b) => b.getBoundingClientRect().height >= 44)), 'its buttons are 44 px tall');
  await press(carol, '#inspector [data-ins="more"]', true);
  await press(carol, '#inspector [data-ins="take"]', true);
  ok(await until(async () => (await view(alice)).items[stack]?.n === 4, 10000), 'Take 2 by taps: ×4 left');
  await shot(carol, 'p4-inspector-iphone');
  await tap(carol, await outside(carol), true);
  ok(!(await inspector(carol)), 'a tap outside closes it');

  section('iPhone 13 held sideways: a band, the bar and the inspector stay on the screen, beside what they act on');
  await carol.setViewportSize({ width: 844, height: 390 });
  await carol.reload(); // (a page loaded sideways: its hand bar sized for a short screen)
  await carol.waitForFunction(() => Object.keys(window.__ct?.view().items || {}).length > 200, null, { timeout: 20000 });
  await toasts(carol);
  await h.sleep(500);
  await carol.tap('#sel-mode');
  await P.touchDrag(carol, await CB(0, 0, -45, -45), await CB(3, 1, 45, 45));
  s = await shown(carol);
  const L = await carol.evaluate(() => [innerWidth, innerHeight]), lb = await box(carol, '#action-bar');
  ok(s.ids.length >= 6 && lb && inside(lb, ...L) && !overlap(lb, await itemsBox(carol, s.ids)), `${s.ids.length} picked; the bar on the screen, beside them`);
  await shot(carol, 'p4-select-iphone-land');
  await carol.tap('#sel-mode');
  await tap(carol, await badgeAt(carol, stack, 'count'), true);
  await until(async () => !!(await inspector(carol)), 5000); // (the tap is handled a moment after it returns: under run-all's load its box was read before it opened)
  const ib = await box(carol, '#inspector');
  ok(ib && inside(ib, ...L), 'the inspector, opened by a tap on the ×4 badge, fits the short screen');
  await shot(carol, 'p4-inspector-iphone-land');
  await env.done();
})().catch(h.crash);
