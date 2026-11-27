// Phase 3C, go (spec §3l t-p3-go; §3g "The demos"; B13, B16, B17 of §3k).
// Alice hosts on a desktop and Bob plays on an iPhone 13 held upright; Alice
// picks each game from 🎲. Every expectation comes from a referee written
// here from the rules of go (simple ko: a move may not bring back the
// position before the opponent's last move; no suicide; area scoring, komi
// 6.5), never from the template.
//   9 × 9, every move a real drag out of the player's own bowl (the mouse
//   for Alice, a finger for Bob): a stone placed from the bowl onto a point,
//   on both screens (the view, and the stone drawn centred on its point in
//   its colour); a single capture; a group capture of two stones (one log
//   line for it: the task's "a capture of N stones is ONE log line"); a
//   play onto a taken point, a play out of turn and a suicide refused, with
//   a toast and nothing changed; ko refused, then allowed after a move
//   elsewhere by each; Pass, Pass (Count is offered only then), Count → the
//   score and the winner (🏆 on both screens).
//   19 × 19, driven through __ct.act as both players (the spec says so): a
//   scripted fill of 361 alternating legal placements — White builds a
//   30-stone group that Black takes in one move (#61: B16, one log line),
//   each side then fills its own half but its eyes, and #300 is White taking
//   a stone Black threw in (B13: ≤ 10 ms of Worker time, done.ms) — after
//   which both screens agree with the referee stone for stone, and a third
//   player's snapshot of the 330 stones left (and that size carried on to
//   361 stones) is at most 70 KB (B17). B13 is a timing budget, so this
//   suite runs in run-all.sh's serial batch.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const L = require('./p1-lib');
const G = require('./stones-lib');
const { shot } = require('./fun-lib');
const { RULES_TEMPLATES, goTemplate } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const J = JSON.stringify;
const LETTERS = 'ABCDEFGHJKLMNOPQRST'; // go's columns skip I
const STARS = { 9: ['C3', 'C7', 'E5', 'G3', 'G7'], 19: ['D4', 'D10', 'D16', 'K4', 'K10', 'K16', 'Q4', 'Q10', 'Q16'] }; // (the standard star points)

/** A go referee from the rules, on an N × N board: points 'A1'… (row 1 at
 *  the bottom). try() and play() return {err: 'taken' | 'suicide' | 'ko' |
 *  'turn'} or {taken: the points captured}. Ko is the simple positional rule:
 *  no move may bring back the position before the opponent's last move. */
function Go(N) {
  const cells = Array(N * N).fill('.');
  const idx = (a) => LETTERS.indexOf(a[0]) + N * (+a.slice(1) - 1), name = (s) => LETTERS[s % N] + (Math.floor(s / N) + 1);
  const around = (s) => { const x = s % N, y = Math.floor(s / N), o = []; if (x) o.push(s - 1); if (x < N - 1) o.push(s + 1); if (y) o.push(s - N); if (y < N - 1) o.push(s + N); return o; };
  const group = (c, s) => { const st = new Set([s]), lib = new Set(); for (const x of st) for (const q of around(x)) { if (c[q] === '.') lib.add(q); else if (c[q] === c[s]) st.add(q); } return { st: [...st], lib }; };
  const g = { turn: 'b', prev: null };
  g.try = (color, a) => {
    const s = idx(a), c = cells.slice(), taken = [];
    if (c[s] !== '.') return { err: 'taken' };
    c[s] = color;
    for (const q of around(s)) if (c[q] !== '.' && c[q] !== color) { const gr = group(c, q); if (!gr.lib.size) for (const x of gr.st) { c[x] = '.'; taken.push(name(x)); } }
    if (!group(c, s).lib.size) return { err: 'suicide' };
    if (c.join('') === g.prev) return { err: 'ko' };
    return { c, taken };
  };
  g.play = (color, a) => {
    const r = color === g.turn ? g.try(color, a) : { err: 'turn' };
    if (r.err) return r;
    g.prev = cells.join('');
    r.c.forEach((v, k) => (cells[k] = v));
    g.turn = color === 'b' ? 'w' : 'b';
    return r;
  };
  g.pass = () => { g.prev = cells.join(''); g.turn = g.turn === 'b' ? 'w' : 'b'; };
  /** Area scoring: stones, plus the empty regions only one colour borders; komi 6.5 to White. */
  g.score = () => {
    const n = { b: 0, w: 6.5 }, seen = new Set();
    cells.forEach((c, s) => {
      if (c !== '.') { n[c]++; return; }
      if (seen.has(s)) return;
      const reg = new Set([s]), by = new Set();
      for (const x of reg) for (const q of around(x)) { if (cells[q] === '.') reg.add(q); else by.add(cells[q]); }
      for (const x of reg) seen.add(x);
      if (by.size === 1) n[[...by][0]] += reg.size;
    });
    return n;
  };
  /** The position as the suites compare it: "A2:b B7:w …", sorted. */
  g.key = () => cells.map((c, s) => (c === '.' ? null : `${name(s)}:${c}`)).filter(Boolean).sort().join(' ');
  g.count = (c) => cells.filter((x) => x === c).length;
  return g;
}

/** The 361 placements of the 19 × 19 fill, alternating from Black: [colour, point][]. */
function fill19() {
  const A = (c, r) => LETTERS[c] + r, rng = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  // White's 30-stone group: row 1, and row 2 from A to L. Black plays 12
  // stones beside it, then fills its 19 liberties; the last one (L3, #61) takes all 30.
  const w1 = [...rng(0, 18).map((c) => A(c, 1)), ...rng(0, 10).map((c) => A(c, 2))];
  const b1 = [...rng(11, 18).map((c) => A(c, 3)), ...rng(0, 3).map((c) => A(c, 4)), ...rng(11, 18).map((c) => A(c, 2)), ...rng(0, 10).map((c) => A(c, 3))];
  // Then White fills rows 11–19 but 21 eyes, holding C19 back for its 120th
  // stone (#300); Black fills rows 1–10 but 10 eyes, and throws a stone in at
  // B19 as its 119th (#299), between White's A19 and B18: C19 takes it.
  const wEye = new Set([...[1, 3, 5, 7, 9, 11, 13, 15, 17].flatMap((c) => [A(c, 19), A(c, 17)]), 'B15', 'D15', 'F15']);
  const bEye = new Set([...[1, 3, 5, 7, 9, 11, 13, 15, 17].map((c) => A(c, 1)), 'K5']);
  const w2 = [];
  for (let r = 19; r >= 11; r--) for (let c = 0; c < 19; c++) if (!wEye.has(A(c, r)) && A(c, r) !== 'C19') w2.push(A(c, r));
  w2.splice(119, 0, 'C19');
  const b2 = [...rng(0, 10).map((c) => A(c, 2)), ...[0, 2, 4, 6, 8, 10, 12, 14, 16, 18].map((c) => A(c, 1)), ...rng(4, 18).map((c) => A(c, 4))];
  for (let r = 5; r <= 10; r++) for (let c = 0; c < 19; c++) if (!bEye.has(A(c, r))) b2.push(A(c, r));
  b2.splice(118, 0, 'B19');
  const out = [];
  for (let k = 0; k < 31; k++) { out.push(['b', b1[k]]); if (k < 30) out.push(['w', w1[k]]); }
  for (let k = 0; k < 150; k++) out.push(['w', w2[k]], ['b', b2[k]]);
  return out;
}

/** A view's stones as the referee keys them: an expression over `v` (P.waitView / viewOf). */
const STONES = "Object.values(v.items).filter((it) => it.k === 'g' && it.at && /\\/[bw]$/.test(it.t)).map((it) => it.at + ':' + it.t.slice(-1)).sort().join(' ')";
/** The stones page p draws, keyed as the referee keys them, by the colour drawn ('b' for a dark face). */
const drawnKey = (d) => d.filter((x) => /\/[bw]$/.test(x.t)).map((x) => `${x.at}:${x.lum < 0.5 ? 'b' : 'w'}`).sort().join(' ');

(async () => {
  const env = await h.start();
  const alice = await P.join(env, 'Alice', env.url);
  const bob = await P.join(env, 'Bob', alice.url(), { ctx: P.PHONE });
  const both = [alice, bob], who = (p) => (p === alice ? 'Alice' : 'Bob');
  for (const p of both) await G.record(p);

  /** Waits until both screens show the referee's position g: in their views,
   *  then drawn (each stone centred on its point, ≤ 3 px, in its colour). */
  async function agree(g, what) {
    const want = g.key();
    ok(await G.everywhere(both, `${STONES} === a`, want), `${what}: both views hold the referee's position (${want.split(' ').length} stones)`);
    for (const p of both) {
      let d = [];
      const same = await L.until(async () => drawnKey(d = await G.drawn(p)) === want, 10000, 100);
      const off = Math.max(0, ...d.map((x) => x.off));
      ok(same && off <= 3, `${what}: ${who(p)}'s screen draws those stones, each in its colour and centred on its point (max ${off.toFixed(1)} px off${same ? '' : `; drawn: ${drawnKey(d)}`})`);
    }
  }
  /** The seated pages by colour, and each colour's bowl (from Alice's view). */
  async function sides() {
    const v = await P.viewOf(alice, 'v');
    const seat = (id) => Object.keys(v.players).find((p) => v.players[p].seatId === id);
    const bowl = (c) => Object.keys(v.items).find((id) => v.items[id].k === 's' && v.items[id].t.endsWith('/' + c));
    return { page: { b: seat('black') === alice.pid ? alice : bob, w: seat('white') === alice.pid ? alice : bob }, pid: { b: seat('black'), w: seat('white') }, bowl: { b: bowl('b'), w: bowl('w') }, v };
  }
  /** Checks the board and bowls of the game just set up (spec §3g "Go"): an N × N point grid of `cell`, drawn in lines, go labels, the star points marked; a bowl per seat. */
  async function setUp(N, cell) {
    const s = await sides(), v = s.v, boxes = await alice.evaluate(() => window.__ct.boxes());
    const type = (ref) => boxes[ref.split('/')[0]]?.types[ref.split('/')[1]];
    const boards = Object.values(v.items).filter((it) => type(it.t)?.kind === 'board'), grid = boards[0] && type(boards[0].t).board?.grid;
    ok(boards.length === 1 && grid && grid.cols === N && grid.rows === N && grid.cell === cell && grid.snap === 'point' && grid.draw === 'lines' && grid.labels === 'go',
      `one go board: ${N} × ${N} points ${cell} apart, drawn in lines, go's labels (${J(grid && { cols: grid.cols, rows: grid.rows, cell: grid.cell, snap: grid.snap, draw: grid.draw, labels: grid.labels })})`);
    ok(J([...(grid?.marks || [])].sort()) === J([...STARS[N]].sort()), `its star points are marked: ${(grid?.marks || []).join(', ')}`);
    ok(s.bowl.b && s.bowl.w && v.items[s.bowl.b].owner === 'seat:black' && v.items[s.bowl.w].owner === 'seat:white',
      `two bowls (supplies), owned by seat:black and seat:white (${J([s.bowl.b, s.bowl.w].map((id) => id && v.items[id].owner))})`);
    const lum = (c) => { const hex = type(v.items[s.bowl[c]].t)?.faces?.[0]?.color || '#808080'; const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    ok(lum('b') < 0.3 && lum('w') > 0.7, `Black's bowl holds dark stones, White's light ones (luminance ${lum('b').toFixed(2)} / ${lum('w').toFixed(2)})`);
    ok(s.pid.b && s.pid.w && s.pid.b !== s.pid.w, `the two players sit at Black and White (Black: ${who(s.page.b)}, White: ${who(s.page.w)})`);
    for (const p of both) {
      const seats = await G.seatTexts(p);
      ok(seats.some((x) => x.includes(`Black — ${who(s.page.b)}`)) && seats.some((x) => x.includes(`White — ${who(s.page.w)}`)), `${who(p)}'s seat labels name the game's seats (${J(seats)})`);
    }
    ok(await G.everywhere(both, `v.rules?.strict === true && v.rules.public?.turn === a && !(${STONES})`, s.pid.b), 'strict rules, an empty board, Black to play, on both screens');
    ok(Object.values(v.items).every((it) => it.k !== 'c' && it.k !== 'p'), 'the table was cleared for it (no cards or piles left)');
    return s;
  }

  // ------------------------------------------------------------------------------------------------
  section('Go 9 × 9 from 🎲: the table cleared after a confirm, a 9 × 9 board of points, a bowl per seat');
  const asked = await G.pickGame(alice, 'go9');
  ok(/Go 9/.test(asked || ''), `picking it over a table with a deck asks first ("${asked}")`);
  ok(await G.everywhere(both, "v.rules?.enabled && Object.values(v.items).filter((it) => it.k === 's').length === 2", null, 30000), 'both screens show the game, with two bowls');
  const s9 = await setUp(9, 100);
  ok(goTemplate(9) === goTemplate(9) && RULES_TEMPLATES.go9 === goTemplate(9) && RULES_TEMPLATES.go19 === goTemplate(19) && goTemplate(9) !== goTemplate(19), 'goTemplate(n) is deterministic: the same text for the same n, the 🎲 entries are those texts');
  ok(await G.playing(alice) === 'go9', 'so the 🎲 dialog knows the game running: Go 9 × 9 is marked as playing');
  await shot(alice, 'p3-go9-start-desk');
  await shot(bob, 'p3-go9-start-phone');

  const g9 = Go(9);
  /** A move by real drag: colour c's player drags out of their own bowl onto
   *  `at`. When the referee allows it, both screens must show the result;
   *  else the mover must be refused with a toast (matching `why`, by default any "🚫") and
   *  nothing may change. Returns {lines: the log lines the move wrote, taken, toast}. */
  async function move(c, at, why = /🚫/) {
    const p = s9.page[c], touch = p === bob, t0 = await G.mark(p), log0 = await alice.evaluate(() => window.__ct.log());
    ok(await P.waitView(p, 'v.rules.public.turn === me'), `${who(p)} sees it is their turn`);
    const want = g9.try(c, at);
    await G.place(p, s9.bowl[c], at, touch);
    if (want.err) {
      const toast = await G.waitSeen(p, 'toast', why, t0);
      ok(!!toast && toast.startsWith('🚫'), `${who(p)}'s ${c === 'b' ? 'Black' : 'White'} stone on ${at} (${want.err}) is refused with a toast ("${toast}")`);
      await agree(g9, `after the refused ${at}`);
      ok(await G.everywhere(both, 'v.rules.public.turn === a', s9.pid[c]), `still ${who(p)}'s turn`);
      ok(await p.evaluate(() => document.querySelectorAll('#table .item[data-id]').length === Object.keys(window.__ct.view().items).length), `no stone left behind on ${who(p)}'s screen`);
      return { toast };
    }
    const r = g9.play(c, at);
    await agree(g9, `${who(p)}'s ${c === 'b' ? 'Black' : 'White'} ${at}${r.taken.length ? ` (takes ${r.taken.join(', ')})` : ''}`);
    ok(await G.everywhere(both, 'v.rules.public.turn === a', s9.pid[g9.turn]), `then it is ${g9.turn === 'b' ? 'Black' : 'White'}'s turn on both screens`);
    await L.until(async () => G.newLines(log0, await alice.evaluate(() => window.__ct.log())).length > 0, 5000, 100);
    return { ...r, lines: G.newLines(log0, await alice.evaluate(() => window.__ct.log())).map((l) => l.txt) };
  }
  const b = (at, why) => move('b', at, why), w = (at, why) => move('w', at, why);

  section('9 × 9: a stone dragged out of the bowl lands on the point, on both screens');
  const first = await b('D5');
  ok(first.lines.some((x) => /D5/.test(x)), `the log names the point (${J(first.lines)})`);
  ok(await P.viewOf(alice, 'v.items[a]?.k', s9.bowl.b) === 's', 'the bowl is still there (it never runs out)');
  await w('E5');
  await b('F5');

  section('9 × 9: refusals — a taken point, a play out of turn');
  await w('D5');
  {
    const t0 = await G.mark(alice);
    await G.place(alice, s9.bowl.b, 'J9'); // (White to play)
    const toast = await G.waitSeen(alice, 'toast', /🚫/, t0);
    ok(!!toast, `Black playing out of turn is refused with a toast ("${toast}")`);
    await agree(g9, 'after the play out of turn');
  }
  await w('A1');
  await b('E4');
  await w('B1');

  section('9 × 9: a single capture');
  const single = await b('E6');
  ok(J(single.taken) === J(['E5']), `E6 takes the White stone on E5 (referee: ${J(single.taken)})`);
  ok(single.lines.some((x) => /removed/.test(x) && /E5/.test(x)), `the log says the stone on E5 was removed (${J(single.lines)})`);

  section('9 × 9: suicide refused');
  await w('E5', /suicide/i);
  await w('G7');
  await b('A2');
  await w('H8');
  await b('B2');
  await w('H6');

  section('9 × 9: a group capture (two stones)');
  const group = await b('C1');
  ok(J([...group.taken].sort()) === J(['A1', 'B1']), `C1 takes the two-stone group A1–B1 (referee: ${J(group.taken)})`);
  const removals = group.lines.filter((x) => /removed/.test(x));
  ok(['A1', 'B1'].every((a) => removals.some((x) => x.includes(a))), `the log names both stones taken (${J(removals)})`);
  ok(removals.length === 1, `a capture of N stones is ONE log line (task brief, "THE DEMOS: Go"; B16): ${removals.length} line(s) for this two-stone capture (${J(removals)})`);

  section('9 × 9: ko — refused at once, allowed after a move elsewhere by each');
  for (const [c, at] of [['w', 'J7'], ['b', 'F7'], ['w', 'C8'], ['b', 'G8'], ['w', 'C7'], ['b', 'G6'], ['w', 'B7']]) await move(c, at);
  const ko = await b('H7');
  ok(J(ko.taken) === J(['G7']), `H7 takes G7, leaving a ko (referee: ${J(ko.taken)})`);
  await w('G7', /ko/i);
  await w('D2');
  await b('F3');
  const back = await w('G7');
  ok(J(back.taken) === J(['H7']), `after White D2 and Black F3, White takes back at G7 (H7 captured; referee: ${J(back.taken)})`);

  section('9 × 9: Pass, Pass — only then Count — and Count gives the score and the winner');
  for (const p of both) ok(!(await G.buttons(p)).some((x) => /Count/.test(x)), `no Count before two passes on ${who(p)}'s screen (${J(await G.buttons(p))})`);
  ok(await P.waitView(s9.page.b, 'v.rules.public.turn === me'), 'Black to play');
  ok(await G.press(s9.page.b, /Pass/, s9.page.b === bob), `${who(s9.page.b)} presses Pass`);
  g9.pass();
  ok(await G.everywhere(both, 'v.rules.public.turn === a', s9.pid.w), 'White to play after Black passes');
  for (const p of both) ok(!(await G.buttons(p)).some((x) => /Count/.test(x)), `still no Count after one pass on ${who(p)}'s screen`);
  ok(await P.waitView(s9.page.w, "(v.rules.public.buttons || []).some((x) => x.id && x.pid === me && /pass/i.test(x.label))"), 'White is offered Pass');
  ok(await G.press(s9.page.w, /Pass/, s9.page.w === bob), `${who(s9.page.w)} presses Pass`);
  g9.pass();
  for (const p of both) {
    const shown = await L.until(async () => (await G.buttons(p)).some((x) => /Count/.test(x)), 10000, 100);
    ok(shown, `after two passes ${who(p)} is offered Count (${J(await G.buttons(p))})`);
  }
  await agree(g9, 'after the two passes');
  const score = g9.score(), winner = score.b > score.w ? 'b' : 'w';
  const marks = await Promise.all(both.map((p) => G.mark(p)));
  ok(await G.press(bob, /Count/, true), 'Bob taps Count');
  for (const [k, p] of both.entries()) {
    const ann = await G.waitSeen(p, 'ann', /\d/, marks[k], 10000);
    ok(!!ann && new RegExp(`Black\\D{0,6}${score.b}(?![.\\d])`).test(ann) && new RegExp(`White\\D{0,6}${String(score.w).replace('.', '\\.')}(?!\\d)`).test(ann),
      `${who(p)}'s screen announces the area score with komi, Black ${score.b} – White ${score.w} ("${ann}")`);
  }
  ok(await G.everywhere(both, 'JSON.stringify(v.rules.public.winners) === a', J([s9.pid[winner]])), `the winner is ${winner === 'b' ? 'Black' : 'White'} (${who(s9.page[winner])}) on both screens`);
  for (const p of both) {
    const seats = await G.seatTexts(p);
    ok(seats.some((x) => x.includes('🏆') && x.includes(who(s9.page[winner]))) && !seats.some((x) => x.includes('🏆') && !x.includes(who(s9.page[winner]))), `${who(p)}'s screen puts 🏆 on ${who(s9.page[winner])}'s seat alone (${J(seats)})`);
  }
  await shot(alice, 'p3-go9-count-desk');
  await shot(bob, 'p3-go9-count-phone');

  // ------------------------------------------------------------------------------------------------
  section('Go 19 × 19 from 🎲: a 19 × 19 board of points 60 apart');
  const asked19 = await G.pickGame(alice, 'go19');
  ok(/Go 19/.test(asked19 || ''), `picking it over the 9 × 9 game asks first ("${asked19}")`);
  ok(await G.everywhere(both, "v.rules?.enabled && !Object.values(v.items).some((it) => it.k === 'g' && it.at) && Object.values(v.items).filter((it) => it.k === 's').length === 2 && v.table.w > 1180", null, 30000), 'both screens show the new game, its board empty');
  const s19 = await setUp(19, 60);
  ok(await G.playing(alice) === 'go19', 'the 🎲 dialog marks Go 19 × 19 as playing');

  section('19 × 19: a scripted fill of 361 alternating legal placements, __ct.act as both players (B16 at #61, B13 at #300)');
  const moves = fill19(), g19 = Go(19);
  const boxes = await alice.evaluate(() => window.__ct.boxes());
  const size = (c) => { const ref = (s19.v.items[s19.bowl[c]].t).split('/'); return boxes[ref[0]].types[ref[1]]; };
  const spots = await alice.evaluate((as) => Object.fromEntries(as.map((a) => [a, window.__ct.resolve(a)])), [...new Set(moves.map((m) => m[1]))]);
  let bobSent = 0, stopped = null, b16 = null, b13 = null;
  for (const [k, [c, at]] of moves.entries()) {
    const n = k + 1, p = s19.page[c], ty = size(c), s = spots[at];
    const r = g19.play(c, at);
    if (r.err) throw new Error(`the fill's plan is wrong: #${n} ${c} ${at} is ${r.err}`);
    const act = { t: 'take', id: s19.bowl[c], x: s.x - ty.w / 2, y: s.y - (ty.h || ty.w) / 2 };
    const log0 = n === 61 ? await alice.evaluate(() => window.__ct.log()) : null;
    const jobs0 = n === 300 ? await alice.evaluate(() => window.__ct.perf.workerJobs) : null;
    if (p === alice) {
      const res = await alice.evaluate((a) => window.__ct.act(a), act);
      if (!res?.ok) { stopped = `#${n} Alice's ${at}: ${J(res)}`; break; }
    } else {
      await h.sleep(Math.max(0, bobSent + 70 - Date.now())); // (≤ 15 a second: well under a guest's flood limit of 20)
      bobSent = Date.now();
      await bob.evaluate((a) => { window.__ct.act(a); }, act);
    }
    const done = await alice.waitForFunction(([at, c, next]) => {
      const v = window.__ct.view();
      return v.rules.public.turn === next && Object.values(v.items).some((it) => it.k === 'g' && it.at === at && it.t.endsWith('/' + c));
    }, [at, c, s19.pid[g19.turn]], { timeout: 10000, polling: 10 }).then(() => true, () => false);
    if (!done) { stopped = `#${n} ${c === 'b' ? 'Black' : 'White'} ${at} never showed on the host (toasts: ${J(await G.seen(p, 'toast'))})`; break; }
    if (n === 61) {
      await L.until(async () => G.newLines(log0, await alice.evaluate(() => window.__ct.log())).some((l) => /removed/.test(l.txt)), 5000, 50);
      b16 = { taken: r.taken.length, lines: G.newLines(log0, await alice.evaluate(() => window.__ct.log())).map((l) => l.txt) };
    }
    if (n === 300) b13 = { taken: r.taken, ...(await alice.evaluate(() => ({ jobs: window.__ct.perf.workerJobs, ms: window.__ct.perf.lastRulesWorkerMs }))), jobs0 };
  }
  ok(!stopped, `all 361 placements were played (${stopped || `${g19.count('b')} Black and ${g19.count('w')} White stones stand, 31 points empty`})`);
  if (b16) {
    const rm = b16.lines.filter((x) => /removed/.test(x));
    ok(b16.taken === 30 && rm.length === 1 && /\b30\b/.test(rm[0]), `B16: Black's L3 (#61) takes the 30-stone group and the capture writes 1 log line (${rm.length}: ${J(rm.map((x) => x.slice(0, 80)))})`);
  } else ok(false, 'B16: the fill never reached #61');
  if (b13) {
    ok(J(b13.taken) === J(['B19']), `#300 is White's C19 taking the stone thrown in at B19 (referee: ${J(b13.taken)})`);
    ok(b13.jobs === b13.jobs0 + 1, `the Worker ran exactly that one job (${b13.jobs0} → ${b13.jobs}), so done.ms is stone #300's`);
    ok(b13.ms <= 10, `B13: placing stone #300 (capture and ko checks) took ${b13.ms?.toFixed(2)} ms of Worker time (≤ 10)`);
  } else ok(false, 'B13: the fill never reached #300');

  section('19 × 19: both screens agree with the referee, stone for stone');
  await agree(g19, 'after the fill');
  await shot(alice, 'p3-go19-fill-desk');
  await shot(bob, 'p3-go19-fill-phone');

  section('19 × 19: B17 — the snapshot a newcomer receives is at most 70 KB');
  {
    const carol = await env.page('Carol');
    await carol.addInitScript(L.rtcHook);
    await carol.addInitScript(() => { window.__rtc.keep = true; });
    await carol.goto(alice.url());
    await h.joinAs(carol, 'Carol');
    ok(await P.waitView(carol, `!!v.players[me] && ${STONES} === a`, g19.key(), 30000), 'Carol, a watcher, sees the same 330 stones');
    const snaps = await carol.evaluate(() => window.__rtc.bodies.filter((b) => b.body.kind === 'snap').map((b) => {
      const text = JSON.stringify(b.body), bytes = new TextEncoder().encode(text).length;
      const stones = Object.values(b.body.items || {}).filter((it) => it.k === 'g' && it.at && /\/[bw]$/.test(it.t));
      return { bytes, stones: stones.length, per: stones.length ? Math.max(...stones.map((it) => new TextEncoder().encode(JSON.stringify(it)).length + 13)) : 0 };
    }));
    const big = snaps.sort((x, y) => y.bytes - x.bytes)[0];
    ok(big && big.stones === 330, `her snapshot holds the 330 stones (${big?.stones})`);
    ok(big && big.bytes <= 70000, `B17: that snapshot is ${big?.bytes} bytes (≤ 70,000)`);
    const at361 = big && big.bytes + (361 - big.stones) * big.per;
    ok(big && at361 <= 70000, `B17 carried on to 361 stones (31 more, ${big?.per} bytes each at most, id and comma included): ${at361} bytes (≤ 70,000)`);
    await shot(carol, 'p3-go19-carol');
  }

  await env.done();
})().catch(h.crash);
