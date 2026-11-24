// Phase 3C, reversi (spec §3l t-p3-reversi; §3g "The demos"). Alice hosts on
// a desktop, Bob plays on an iPhone 13 — held upright, then sideways for the
// last game; every move is a real drag out of the player's own pile (the
// mouse for Alice, a finger for Bob). Every expectation comes from a referee
// written here from the rules of reversi (a disc must outflank: every line
// of the other colour it closes turns over; a side with no such square
// passes; when neither can play, the most discs win), never from the
// template. Which side a player plays is read from the public box: the
// pile showing the dark face belongs to Dark's seat.
//   🎲 Reversi: an 8 × 8 board drawn in green cells, a disc with a dark and a
//   light face, a pile per seat showing its own face; the starting position
//   (light on d4 and e5, dark on d5 and e4) and Dark to move, on both
//   screens (the views, and the discs drawn centred in their colour);
//   refusals — a square that outflanks nothing, a taken square, a play out
//   of turn — each with a toast and nothing changed; legal placements that
//   turn exactly the bracketed lines on both screens, through a forced pass
//   (d3 c3 b3 b2 f5 a3 a1 c1: Dark has no move), announced on both screens,
//   Light playing again; then a near-end position planted by a test script
//   (the template wrapped with a host-only "Plant" button: the same lockdown
//   as any script), played out — a5 closes four lines at once — to the full
//   board: t.win, 🏆 for the winner and the count announced.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const L = require('./p1-lib');
const G = require('./stones-lib');
const { shot } = require('./fun-lib');
const { RULES_TEMPLATES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const J = JSON.stringify;
const FILES = 'abcdefgh', DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** A reversi referee from the rules: a board is {square: 'D' | 'L'}, squares
 *  'a1'…'h8' as the board labels them (rank 1 at Dark's edge). */
const R = {
  /** The lines a disc of side c on square a would close: each the run of the other side's discs it turns. */
  lines(b, a, c) {
    if (b[a]) return [];
    const out = [], f0 = FILES.indexOf(a[0]), r0 = +a.slice(1) - 1, sq = (f, r) => FILES[f] + (r + 1), on = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
    for (const [dx, dy] of DIRS) {
      const run = [];
      let f = f0 + dx, r = r0 + dy;
      while (on(f, r) && b[sq(f, r)] && b[sq(f, r)] !== c) { run.push(sq(f, r)); f += dx; r += dy; }
      if (run.length && on(f, r) && b[sq(f, r)] === c) out.push(run);
    }
    return out;
  },
  legal: (b, c) => [...FILES].flatMap((f) => [1, 2, 3, 4, 5, 6, 7, 8].map((r) => f + r)).filter((a) => R.lines(b, a, c).length),
  other: (c) => (c === 'D' ? 'L' : 'D'),
  /** Plays c on a: {b: the new board, lines, next: who plays next — the other side, c again (a forced pass) or null (game over)}. */
  play(b, a, c) {
    const lines = R.lines(b, a, c), n = { ...b, [a]: c };
    for (const x of lines.flat()) n[x] = c;
    return { b: n, lines, next: R.legal(n, R.other(c)).length ? R.other(c) : R.legal(n, c).length ? c : null };
  },
  key: (b) => Object.entries(b).map(([a, c]) => `${a}:${c}`).sort().join(' '),
  count: (b, c) => Object.values(b).filter((x) => x === c).length,
};
/** The near-end position (a legal game's 54th move to come; Dark to play;
 *  a8 h8 a7 h6 a5 a4 empty), rank 8 first. */
const NEAR_END = ['.DLLLLD.', '.DLLLLLL', 'DDDLDLL.', '.DLLLLDL', '.LDLLLDL', 'LLLDLLDD', 'DLLLLLDD', 'LLLLLLLD'];
const nearEnd = () => Object.fromEntries(NEAR_END.flatMap((row, k) => [...row].map((c, f) => [FILES[f] + (8 - k), c])).filter(([, c]) => c !== '.'));
/** The reversi template, wrapped with a "Plant" button for the host that sets
 *  out `board` (dark discs on face `dark`, light on `light`) with Dark to
 *  play: the README's way to plant a position ("Planting a position"). */
const planter = (board, dark, light) => `(() => {
  const r = ${RULES_TEMPLATES.reversi};
  const BOARD = ${J(board)};
  return { ...r,
    buttons: (t) => [...r.buttons(t), { id: 'plant', label: 'Plant', pid: t.hostId }],
    onButton(t, id, p) {
      if (id !== 'plant') return r.onButton(t, id, p);
      for (const it of t.find({ type: t.data.box + '/disc' })) if (it.k === 'g') t.remove(it.id);
      for (const [at, c] of Object.entries(BOARD)) t.spawn(t.data.box + '/disc', { at, f: c === 'D' ? ${dark} : ${light}, lock: true });
      Object.assign(t.data, { turn: ${dark}, over: null });
      t.public.winners = [];
    },
  };
})()`;

(async () => {
  const env = await h.start();
  const alice = await P.join(env, 'Alice', env.url);
  const bob = await P.join(env, 'Bob', alice.url(), { ctx: P.PHONE });
  const both = [alice, bob], who = (p) => (p === alice ? 'Alice' : 'Bob');
  for (const p of both) await G.record(p);

  section('Reversi from 🎲: a green 8 × 8 board of cells, a two-faced disc, a pile per seat showing its own face');
  const asked = await G.pickGame(alice, 'reversi');
  ok(/Reversi/.test(asked || ''), `picking it over a table with a deck asks first ("${asked}")`);
  ok(await G.everywhere(both, "v.rules?.enabled && Object.values(v.items).filter((it) => it.k === 's').length === 2 && Object.values(v.items).filter((it) => it.k === 'g' && it.at).length === 4", null, 30000), 'both screens show the game: two piles, four discs');
  const v0 = await P.viewOf(alice, 'v'), boxes = await alice.evaluate(() => window.__ct.boxes());
  const type = (ref) => boxes[ref.split('/')[0]]?.types[ref.split('/')[1]];
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const boards = Object.values(v0.items).filter((it) => type(it.t)?.kind === 'board'), board = boards[0] && type(boards[0].t), grid = board?.board?.grid;
  ok(boards.length === 1 && grid?.type === 'square' && grid.cols === 8 && grid.rows === 8 && grid.draw === 'cells' && grid.snap !== 'point', `one board: 8 × 8 square cells, drawn as cells (${J(grid && { type: grid.type, cols: grid.cols, rows: grid.rows, draw: grid.draw })})`);
  const green = (hex) => { const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)); return g > r && g > b; };
  ok(board && [board.faces?.[0]?.color, ...(grid?.colors || [])].filter(Boolean).every(green), `it is green (${J([board?.faces?.[0]?.color, ...(grid?.colors || [])])})`);
  const piles = Object.entries(v0.items).filter(([, it]) => it.k === 's'), disc = piles[0] && type(piles[0][1].t);
  ok(piles.every(([, it]) => it.t === piles[0][1].t) && disc?.faces?.length === 2, `both piles hold the one disc type, with two faces (${disc?.faces?.length})`);
  const faceLum = (disc?.faces || []).map((f) => lum(f.color || '#808080')), DARK = faceLum[0] < faceLum[1] ? 0 : 1, LIGHT = 1 - DARK;
  ok(faceLum[DARK] < 0.3 && faceLum[LIGHT] > 0.7, `one face dark, the other light (luminance ${faceLum.map((x) => x.toFixed(2)).join(' / ')})`);
  const pile = { D: piles.find(([, it]) => it.f === DARK)?.[0], L: piles.find(([, it]) => it.f === LIGHT)?.[0] };
  const seatOf = (id) => /^seat:(.+)$/.exec(v0.items[id]?.owner || '')?.[1];
  ok(pile.D && pile.L && seatOf(pile.D) && seatOf(pile.L) && seatOf(pile.D) !== seatOf(pile.L), `each seat owns a pile showing its own face (dark: seat:${seatOf(pile.D)}, light: seat:${seatOf(pile.L)})`);
  const pidAt = (seat) => Object.keys(v0.players).find((p) => v0.players[p].seatId === seat);
  const pid = { D: pidAt(seatOf(pile.D)), L: pidAt(seatOf(pile.L)) }, page = { D: pid.D === alice.pid ? alice : bob, L: pid.L === alice.pid ? alice : bob };
  ok(pid.D && pid.L && pid.D !== pid.L, `the two players hold the two seats (Dark: ${who(page.D)}, Light: ${who(page.L)})`);
  const seatName = (id) => v0.seats?.find((s) => s.id === id)?.name;
  for (const p of both) {
    const seats = await G.seatTexts(p);
    ok(/dark/i.test(seatName(seatOf(pile.D)) || '') && /light/i.test(seatName(seatOf(pile.L)) || '') && seats.some((x) => x.includes(`${seatName(seatOf(pile.D))} — ${who(page.D)}`)) && seats.some((x) => x.includes(`${seatName(seatOf(pile.L))} — ${who(page.L)}`)),
      `${who(p)}'s seat labels name the game's seats (${J(seats)})`);
  }
  ok(await G.playing(alice) === 'reversi', 'the 🎲 dialog marks Reversi as playing');

  /** Waits until both screens show board b: in their views, then drawn (each disc centred on its square, ≤ 3 px, in its colour). */
  async function agree(b, what) {
    const want = R.key(b);
    ok(await G.everywhere(both, "Object.values(v.items).filter((it) => it.k === 'g' && it.at).map((it) => it.at + ':' + (it.f === a.dark ? 'D' : 'L')).sort().join(' ') === a.want", { want, dark: DARK }),
      `${what}: both views hold the referee's board (${R.count(b, 'D')} dark, ${R.count(b, 'L')} light)`);
    for (const p of both) {
      let d = [];
      const key = () => d.map((x) => `${x.at}:${x.lum < 0.5 ? 'D' : 'L'}`).sort().join(' ');
      const same = await L.until(async () => { d = await G.drawn(p); return key() === want; }, 10000, 100);
      const off = Math.max(0, ...d.map((x) => x.off));
      ok(same && off <= 3, `${what}: ${who(p)}'s screen draws those discs, each in its colour and centred on its square (max ${off.toFixed(1)} px off${same ? '' : `; drawn: ${key()}`})`);
    }
  }
  let b = { d4: 'L', e5: 'L', d5: 'D', e4: 'D' }, turn = 'D';
  /** A move by real drag: side c's player drags out of their own pile onto
   *  `at`. When the rules allow it, both screens must show the referee's
   *  board after it; else the mover is refused with a toast and nothing changes. */
  async function move(c, at) {
    const p = page[c], t0 = await G.mark(p), legal = c === turn && R.lines(b, at, c).length > 0;
    if (c === turn) ok(await P.waitView(p, 'v.rules.public.turn === me'), `${who(p)} sees it is their turn`);
    await G.place(p, pile[c], at, p === bob);
    if (!legal) {
      const toast = await G.waitSeen(p, 'toast', /🚫/, t0);
      ok(!!toast, `${c === 'D' ? 'Dark' : 'Light'} on ${at} (${b[at] ? 'taken' : c !== turn ? 'out of turn' : 'outflanks nothing'}) is refused with a toast ("${toast}")`);
      await agree(b, `after the refused ${at}`);
      ok(await G.everywhere(both, 'v.rules.public.turn === a', pid[turn]), `still ${turn === 'D' ? 'Dark' : 'Light'}'s turn`);
      ok(await p.evaluate(() => document.querySelectorAll('#table .item[data-id]').length === Object.keys(window.__ct.view().items).length), `no disc left behind on ${who(p)}'s screen`);
      return null;
    }
    const r = R.play(b, at, c);
    b = r.b;
    await agree(b, `${c === 'D' ? 'Dark' : 'Light'} ${at} closing ${r.lines.length} line(s): ${r.lines.map((x) => x.join(' ')).join(' | ')}`);
    if (r.next) ok(await G.everywhere(both, 'v.rules.public.turn === a', pid[r.next]), `then ${r.next === 'D' ? 'Dark' : 'Light'} is to play, on both screens`);
    turn = r.next;
    return r;
  }

  section('The starting position: light on d4 and e5, dark on d5 and e4; Dark to move');
  await agree(b, 'the start');
  ok(await G.everywhere(both, 'v.rules.strict === true && v.rules.public.turn === a', pid.D), 'strict rules, and Dark to move, on both screens');
  await shot(alice, 'p3-rev-start-desk');
  await shot(bob, 'p3-rev-start-phone');

  section('An illegal placement is refused: a square that outflanks nothing, a taken square, a play out of turn');
  ok(R.lines(b, 'c5', 'D').length === 0 && !b.c5, 'c5 is empty and closes no line for Dark (referee)');
  await move('D', 'c5');
  await move('D', 'e4');
  await move('L', 'c4');

  section('A legal placement turns the bracketed lines, on both screens — to a forced pass');
  await move('D', 'd3');
  await move('L', 'c3');
  await move('D', 'b3');
  await move('L', 'b2');
  await move('D', 'f5');
  await move('L', 'a3');
  const a1 = await move('D', 'a1');
  ok(J(a1?.lines) === J([['b2', 'c3', 'd4']]), `a1 turns the three light discs b2 c3 d4 between it and e5 (${J(a1?.lines)})`);
  const marks = await Promise.all(both.map((p) => G.mark(p)));
  const c1 = await move('L', 'c1');
  ok(c1?.next === 'L' && R.legal(b, 'D').length === 0, `after c1 Dark has no square that outflanks (referee: ${J(R.legal(b, 'D'))})`);

  section('A forced pass is announced, and Light plays again');
  for (const [k, p] of both.entries()) {
    const ann = await G.waitSeen(p, 'ann', /pass/i, marks[k], 10000);
    ok(!!ann && /dark/i.test(ann), `${who(p)}'s screen announces that Dark passes ("${ann}")`);
  }
  ok(await G.everywhere(both, 'v.rules.public.turn === a', pid.L), 'Light is to play again, on both screens');
  ok((await alice.evaluate(() => window.__ct.log())).some((l) => /pass/i.test(l.txt) && l.txt.startsWith('📣')), 'the announcement is in the log');
  await shot(alice, 'p3-rev-pass-desk');
  await shot(bob, 'p3-rev-pass-phone');
  await move('L', 'e3');
  ok(turn === 'D', 'and after Light\'s e3 Dark plays on');

  section('A near-end position planted by a test script, played out to the end: t.win');
  await h.enableRules(alice, { code: planter(nearEnd(), DARK, LIGHT) });
  ok(await P.waitView(alice, "(v.rules?.public?.buttons || []).some((x) => x.id === 'plant')"), 'the wrapped template runs, with a Plant button for the host');
  ok(await G.press(alice, /Plant/), 'Alice presses Plant');
  b = nearEnd();
  turn = 'D';
  await agree(b, 'the planted position');
  ok(await G.everywhere(both, 'v.rules.public.turn === a', pid.D), 'Dark to play');
  await bob.setViewportSize({ width: 844, height: 390 }); // (Bob turns his phone sideways)
  await h.sleep(500);
  await shot(bob, 'p3-rev-planted-phone-landscape');
  const end = Object.fromEntries(both.map((p) => [who(p), 0]));
  for (const [c, at] of [['D', 'h6'], ['L', 'a8'], ['D', 'a4']]) await move(c, at);
  const a5 = await move('L', 'a5');
  ok(a5?.lines.length === 4, `a5 closes four lines at once, every disc in them turned on both screens (${J(a5?.lines)})`);
  await move('D', 'h8');
  for (const p of both) end[who(p)] = await G.mark(p);
  const last = await move('L', 'a7');
  ok(last && last.next === null && Object.keys(b).length === 64, 'a7 fills the board: neither side can play (referee)');
  const n = { D: R.count(b, 'D'), L: R.count(b, 'L') }, win = n.D > n.L ? 'D' : 'L';
  for (const p of both) {
    const ann = await G.waitSeen(p, 'ann', new RegExp(`\\b${n[win]}\\b`), end[who(p)], 10000);
    ok(!!ann && new RegExp(`\\b${n.D}\\b`).test(ann) && new RegExp(`\\b${n.L}\\b`).test(ann), `${who(p)}'s screen announces the count, ${n.D} dark to ${n.L} light ("${ann}")`);
  }
  ok(await G.everywhere(both, 'JSON.stringify(v.rules.public.winners) === a', J([pid[win]])), `t.win: ${win === 'D' ? 'Dark' : 'Light'} (${who(page[win])}) wins, on both screens`);
  for (const p of both) {
    const seats = await G.seatTexts(p);
    ok(seats.some((x) => x.includes('🏆') && x.includes(who(page[win]))) && !seats.some((x) => x.includes('🏆') && !x.includes(who(page[win]))), `${who(p)}'s screen puts 🏆 on ${who(page[win])}'s seat alone (${J(seats)})`);
  }
  await shot(alice, 'p3-rev-end-desk');
  await shot(bob, 'p3-rev-end-phone-landscape');

  await env.done();
})().catch(h.crash);
