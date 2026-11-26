// Phase 3A, space (spec §3l "t-p3-space.js" items 1, 2, 7, 8, 10 and 11,
// and §3j attacker cases 4 and 7), by hand on real screens: Alice hosts on a
// desktop, Bob plays on an iPhone 13 (portrait), Carol on an iPhone 13 in
// landscape; Mallory is a raw peer. Every interaction is a real drag or tap
// (a mouse, or CDP touches); __ct.act only sets a table up, or sends what a
// tampered client would.
//   Draughts (square cells): a drop near a square snaps to it, centred, `at`
//   on both screens, the log "moved Light man c3 → d4", "… to …", "… from
//   …"; the snap preview (.snap-ghost on the spot, the address chip by the
//   pointer, nothing over felt or the margin) is where the drop lands, on
//   the desktop and the phone, and stays readable when another player's
//   name bulb comes over it; live drags (spec §3c `drag`): a guest's drag
//   sends `drag` (60 ms apart), never `move`, until the one drop, the host's
//   state stays put meanwhile, the other screen glides (fx.live) and ends at
//   the committed position; the host's own drags too; a locked piece's drag
//   is never relayed.
//   Backgammon (item 11): t-p2-demos's script again under snapping — the
//   standard start on the points, fanned along each point's dir inside its
//   triangle with "×k" on the top checker (readable, upright, on the phone),
//   a tap on a crowd selects its top checker and a drag takes it, 15 on one
//   point stay inside it on both screens, the dice, the cube, the bar.
//   A script's table (t.newBox, t.spawn): square points, pointy and flat
//   hexes and spaces snap (three screens); validate and onAction see a.to
//   and a.from (item 2), a pull's a.pick is the member taken, a lying `to`
//   is overwritten; several boards (item 8: bare on the primary board when
//   a rack and a second map come, "map:c3", t.move(id, 'map:c3')); moving
//   and turning a board (item 10: nothing else moves, addresses follow by
//   containment); 250 spawns in one hook log one aggregated line (§3e).
//   Mallory: drags of what she may not move are never relayed (case 4); a
//   drag's numbers are clamped and finite, a group's at most 200 ids, all
//   hers to move (case 7).
// Phase 3C, play (items 3, 4, 6 and 9), on a strict "Play test" enabled from
// the 📜 dialog (whose button then says strict on every screen):
//   Item 3: a tap sends `select`; the hint shows on that player's screen
//   alone (outlined piece, marks on the very squares, a numbers-only layer of
//   its own over the board); Mallory's select hints her alone, and no body of
//   hers, Bob's or Carol's carries another player's hint; a refused card play
//   and a vetoed drop keep the hint, a played move clears it.
//   Item 9: handle takes a drop of the glue stone and leaves it: on the
//   dropping guest's screen (iPhone upright and sideways) it is back with the
//   first patch that names it, not after the 1.5 s hold.
//   Item 6: t.secret on Bob's "🔒 For you" card, markup as text, line breaks
//   kept; on no other screen, in no other body.
//   Item 4: every ask form through the panel (§3g's table, §3c's answer
//   values) by mouse on the desktop and by taps on the iPhone; "1 of N"; what
//   isn't offered is said and not sent; Confirm only at exactly `count`; a
//   number out of range never sent; a prompt and labels of markup shown as
//   text (sideways iPhone); the panel's place on all three screens (inside
//   the viewport, never over the table, the turn cue, the watchers or a seat
//   label; a sheet above the hand bar on phones, 44 px buttons; a centred
//   card on the desktop); forged answers of every form, an unknown id and
//   Mallory's answer to Bob's ask refused by the host, no hook run; a host
//   reload mid-ask brings both prompts back, Bob's hint gone, his secret kept.
// Screenshots: shots/p3-*.png, for review only.
'use strict';
const path = require('path');
const h = require('./h');
const L = require('./p1-lib');
const P = require('./p2t-lib');
const S = require('./p3-lib');
const { shot } = require('./fun-lib');
const { mallory, overlapPast1px: overlap } = require('./final-lib'); // (contact within 1 px is no overlap here)
const { record, mark, waitSeen } = require('./stones-lib');
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));
const { ok, section } = h;

/** The script of the script-built table: five boards from t.newBox — the
 *  primary one (the oldest with a grid: an 8 × 8 of cell 100, chess
 *  labels), go's 9 × 9 points (cell 60), pointy and flat hexes (cell 80,
 *  axial), a yard of spaces (a ring, a rectangle, a lane with a dir) — and
 *  stones: five on the primary board, eight loose, Alice's, a locked one, a
 *  supply and a bag of three (faces A, B, C). validate and onAction echo
 *  what they see of a placement (a.from, a.to, a pull's a.pick and the face
 *  of the member it names); chat drives the rest: "add" brings a rack (zones
 *  only) and a second map, "go <id> <addr>" is t.move, "many" spawns 250
 *  loose stones. */
const SPACE = `({ name: 'Space test',
  setup(t) {
    t.setTable({ shape: 'rect', w: 3000, h: 2000 });
    t.setSeats(null);
    const box = t.newBox({ name: 'Space', pieces: [
      { id: 'board', kind: 'board', w: 840, h: 840, faces: [{ color: '#5c3a1e' }], grid: { type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, draw: 'checker', colors: ['#f0d9b5', '#b58863'], labels: 'chess' } },
      { id: 'go', kind: 'board', w: 560, h: 560, faces: [{ color: '#d6b98c' }], grid: { type: 'square', snap: 'point', cols: 9, rows: 9, cell: 60, x: 40, y: 40, draw: 'lines', labels: 'go' } },
      { id: 'hexp', kind: 'board', w: 560, h: 420, faces: [{ color: '#2f4f2f' }], grid: { type: 'hex', hex: 'pointy', cols: 6, rows: 5, cell: 80, x: 20, y: 20, draw: 'cells', labels: 'axial' } },
      { id: 'hexf', kind: 'board', w: 480, h: 480, faces: [{ color: '#333344' }], grid: { type: 'hex', hex: 'flat', cols: 6, rows: 5, cell: 80, x: 10, y: 10, draw: 'cells', labels: 'axial' } },
      { id: 'yard', kind: 'board', w: 600, h: 400, faces: [{ color: '#4a2e17' }], spaces: [
        { id: 'home', x: 100, y: 100, r: 70, mark: 'ring' },
        { id: 'tower', x: 300, y: 110, r: 60, w: 140, h: 140, mark: 'rect' },
        { id: 'lane', x: 330, y: 300, r: 60, w: 480, h: 100, mark: 'rect', dir: 'right' }],
        links: [['home', 'tower'], ['tower', 'lane']] },
      { id: 'rack', kind: 'board', w: 600, h: 150, faces: [{ color: '#665544' }], zones: [{ id: 'shelf', poly: [[0, 0], [600, 0], [600, 150], [0, 150]] }] },
      { id: 'map', kind: 'board', w: 540, h: 540, faces: [{ color: '#226644' }], grid: { type: 'square', cols: 5, rows: 5, cell: 100, x: 20, y: 20, draw: 'checker', labels: 'chess' } },
      { id: 'stone', kind: 'token', w: 50, stack: 'none', faces: ['A', 'B', 'C'] },
    ] });
    t.data.box = box;
    t.spawn(box + '/board', { at: { x: 100, y: 100 } });
    t.spawn(box + '/go', { at: { x: 1000, y: 100 } });
    t.spawn(box + '/hexp', { at: { x: 1620, y: 100 } });
    t.spawn(box + '/hexf', { at: { x: 2250, y: 100 } });
    t.spawn(box + '/yard', { at: { x: 1000, y: 750 } });
    for (const a of ['e4', 'f5', 'b2', 'h7', 'g1']) t.spawn(box + '/stone', { at: a });
    for (let k = 0; k < 8; k++) t.spawn(box + '/stone', { at: { x: 1700 + 70 * k, y: 1000 }, f: k % 3 });
    t.spawn(box + '/stone', { at: { x: 2300, y: 1200 }, owner: t.hostId });
    t.spawn(box + '/stone', { at: { x: 2400, y: 1200 }, lock: true });
    t.spawn(box + '/stone', { at: { x: 1700, y: 1200 }, as: 'supply' });
    t.newBag([{ t: box + '/stone', f: 0 }, { t: box + '/stone', f: 1 }, { t: box + '/stone', f: 2 }], { at: { x: 1850, y: 1200 }, name: 'Pouch' });
  },
  echo(t, a, hook) {
    if (!['move', 'take', 'pull', 'split', 'play'].includes(a.t)) return;
    const pick = hook === 'validate' && a.pick !== undefined ? ' pick ' + a.pick + ' f' + t.item(a.id).of[a.pick].f : '';
    t.say(hook + ' ' + a.t + ' ' + (a.from ?? '-') + ' > ' + (a.to ?? '-') + pick);
  },
  validate(t, a) { this.echo(t, a, 'validate'); },
  onAction(t, a) { this.echo(t, a, 'onAction'); },
  onChat(t, text) {
    const [cmd, id, addr] = text.split(' ');
    if (cmd === 'add') { t.spawn(t.data.box + '/rack', { at: { x: 100, y: 1100 } }); t.spawn(t.data.box + '/map', { at: { x: 2300, y: 1300 } }); }
    if (cmd === 'go') t.say('moved? ' + t.move(id, addr) + ', where ' + t.where(id));
    if (cmd === 'where') t.say('where ' + t.where(id));
    if (cmd === 'many') for (let k = 0; k < 250; k++) t.spawn(t.data.box + '/stone', { at: { x: 100 + (k % 50) * 50, y: 1900 - Math.floor(k / 50) * 55, free: true } });
  } })`;

/** The script of the 3C sections (strict; the default effect kept for moves
 *  alone): an 8 × 8 board (cell 100, chess labels) with five stones (c3, d4,
 *  e5, f6, b7), a glue stone on g2 and a deck. onSelect hints the selected
 *  piece and every square around it; handle takes a move of the glue stone
 *  and leaves it where it is (true), and vetoes a move to h8; onAnswer
 *  records each answer in t.public.ans; a host press of "run" carries code
 *  that onAction runs (the asks, the secret, the deal: the test's game master). */
const PLAY = `({ name: 'Play test', strict: true, allow: ['move'],
  setup(t) {
    t.setTable({ shape: 'rect', w: 1200, h: 1200 });
    t.setSeats(null);
    const box = t.newBox({ name: 'Play', pieces: [
      { id: 'board', kind: 'board', w: 840, h: 840, faces: [{ color: '#5c3a1e' }], grid: { type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, draw: 'checker', colors: ['#f0d9b5', '#b58863'], labels: 'chess' } },
      { id: 'stone', kind: 'token', w: 64, stack: 'none', faces: [{ label: 'S', color: '#f8fafc' }] },
      { id: 'glue', kind: 'token', w: 64, stack: 'none', faces: [{ label: 'G', color: '#fbbf24' }] },
    ] });
    t.spawn(box + '/board', { at: { x: 180, y: 120 } });
    for (const a of ['c3', 'd4', 'e5', 'f6', 'b7']) t.spawn(box + '/stone', { at: a });
    t.spawn(box + '/glue', { at: 'g2' });
    t.addStandardDeck({ x: 40, y: 1000 });
  },
  handle(t, a) {
    if (a.t !== 'move') return undefined;
    if (t.item(a.id)?.t.endsWith('/glue')) { t.say('the glue holds, not to ' + (a.to || 'the felt')); return true; } // (a line of its own each time: the log drops a repeat)
    if (a.to === 'h8') return 'h8 is out of bounds';
    return undefined;
  },
  onSelect(t, p, id) { const w = t.where(id); t.hint(p, { items: [id], spaces: w ? t.neighbors(w, { diag: true }) : [] }); },
  onAnswer(t, p, id, v) { t.public.ans = (t.public.ans || []).concat([{ p, id, v }]).slice(-60); },
  onAction(t, a) { if (a.t === 'rulesBtn' && a.id === 'run') new Function('t', 'a', '"use strict";\\n' + a.code)(t, a); },
  buttons: (t) => [{ id: 'run', label: 'Run', pid: t.hostId }],
})`;

(async () => {
  const env = await h.start();
  const host = await S.join(env, 'Alice', env.url);
  await host.waitForSelector('.item.pile .count');
  const bob = await S.join(env, 'Bob', host.url(), { ctx: P.PHONE });
  bob.touch = true;
  const items = (p = host) => P.viewOf(p, 'v.items');
  const acts = (p) => p.evaluate(() => window.__acts.map((x) => ({ ...x.a, at_: x.at })));
  /** The (one) board item on page p's view: {id, ...item}. */
  const boardOf = async (p) => { const its = await items(p); const id = Object.keys(its).find((k) => its[k].z < 0); return { id, ...its[id] }; };
  /** Board item b's type (from page p's boxes): {w, h, B (its structure)}. */
  const typeOf = async (p, t) => p.evaluate((t) => { const [b, k] = t.split('/'), ty = window.__ct.boxes()[b].types[k]; return { w: ty.w, h: ty.h, B: ty.board }; }, t);
  /** Waits until item `id` is at `at` (a display address, or null: none) on page p. */
  const atOn = (p, id, at, ms = 15000) => P.waitView(p, at === null ? '!!v.items[a.id] && v.items[a.id].at === undefined' : 'v.items[a.id]?.at === a.at', { id, at }, ms);
  const logOn = (p, txt, by, ms = 15000) => P.waitView(p, 'v.log.some((e) => e.txt === a.txt && (!a.by || e.p === a.by))', { txt, by }, ms);

  // ===========================================================================
  section('Draughts: every man is on its square (snapped by the setup), on both screens');
  ok((await L.act(host, { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true })).ok, '(Alice sets up Draughts)');
  for (const p of [host, bob]) await P.waitView(p, "Object.values(v.items).filter((it) => it.k === 'g' && it.z >= 0).length === 24", null, 30000);
  await P.waitView(host, `v.players[me].seatId === 'light' && v.players[a].seatId === 'dark'`, bob.pid);
  const db = await boardOf(host), dt = await typeOf(host, db.t), g8 = dt.B.grid;
  /** Square (c, r)'s centre on the table (the draughts board is not turned). */
  const sq = (c, r) => S.onTable({ ...db, ...dt }, S.spotXY(g8, c, r));
  const name = (s) => ({ c: 'abcdefgh'.indexOf(s[0]), r: 8 - +s[1] });
  const sqOf = (s) => { const { c, r } = name(s); return sq(c, r); };
  for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
    const its = await items(p), men = Object.values(its).filter((it) => it.k === 'g' && it.z >= 0);
    const wrong = men.filter((it) => { const s = S.expectSpot(dt.B, it.x + 40 - db.x, it.y + 40 - db.y); return !s || it.at !== s.local || it.x + 40 - db.x !== s.x || it.y + 40 - db.y !== s.y; });
    ok(men.length === 24 && !wrong.length, `${who}'s view: each of the 24 men is centred on its square and carries its address (${men.slice(0, 3).map((it) => it.at).join(', ')}, …${wrong.length ? `; wrong: ${JSON.stringify(wrong.slice(0, 2))}` : ''})`);
    ok(its[db.id].at === undefined, `${who}'s view: the board itself has no address (boards never snap)`);
  }
  const manAt = async (s, p = host) => { const its = await items(p); return Object.keys(its).find((k) => its[k].at === s); };
  /** Item `id` on page p is drawn at its committed top-left, with no live glide left. */
  const settledAt = (p, id) => p.waitForFunction((id) => {
    const it = window.__ct.view().items[id], d = window.__ct.drawn(id);
    return it && d && d.x === it.x && d.y === it.y && !d.tx && !d.ty && !window.__ct.lives()[id];
  }, id, { timeout: 8000 }).then(() => true, () => false);
  /** The centre of item `id`'s element on page p (client px), once it is within 1.5 px of `pt` (or after 5 s: the last one read). */
  async function drawnAt(p, id, pt) {
    let c = null;
    await L.until(async () => (c = await S.centreOf(p, id)) && pt && S.dist(c, pt) < 1.5, 5000, 100);
    return c;
  }
  /** Item `id`'s live spot on page p (__ct.lives), once its centre is within 3 units of table point `to` (or after 5 s: the last one read). */
  async function liveNear(p, id, to, w) {
    let lv;
    await L.until(async () => (lv = (await p.evaluate(() => window.__ct.lives()))[id]) && Math.abs(lv.x + w / 2 - to.x) < 3 && Math.abs(lv.y + w / 2 - to.y) < 3, 5000, 50);
    return lv;
  }

  section('Draughts: Alice drops a man near d4 — the preview shows d4, it lands centred there, logged "c3 → d4"');
  {
    const id = await manAt('c3'), d4 = sqOf('d4'), want = await S.screenOf(host, d4.x, d4.y);
    let pv = null;
    await S.dragTo(host, id, { x: d4.x + 22, y: d4.y - 18 }, { mid: async () => { pv = await S.preview(host); } });
    ok(pv?.ghost && S.dist(pv.ghost, want) < 1, `mid-drag, .snap-ghost outlines d4 (its centre ${pv?.ghost && `${S.dist(pv.ghost, want).toFixed(2)} px`} from d4's)`);
    ok(pv?.chip?.text === 'd4', `the chip by the pointer reads "${pv?.chip?.text}"`);
    ok(pv?.spot?.to === 'd4' && pv.spot.x === d4.x - 40 && pv.spot.y === d4.y - 40, `__ct.spot() is d4's top-left for a man (${JSON.stringify(pv?.spot)})`);
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      ok(await atOn(p, id, 'd4'), `${who}'s view: the man is at d4`);
      ok(await P.waitView(p, 'v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id, x: d4.x - 40, y: d4.y - 40 }), `${who}'s view: centred on d4 (top-left ${d4.x - 40}, ${d4.y - 40}), though dropped 22, −18 off`);
      ok(await logOn(p, 'moved Light man c3 → d4', host.pid), `${who}'s log: Alice's "moved Light man c3 → d4"`);
    }
    const c = await drawnAt(host, id, pv?.ghost);
    ok(pv?.ghost && S.dist(c, pv.ghost) < 1.5, `the man is drawn where the ghost was (${pv?.ghost && S.dist(c, pv.ghost).toFixed(2)} px off)`);
    ok(!(await S.preview(host)).ghost && !(await S.preview(host)).chip, 'the preview is gone after the drop');
  }

  section('Draughts: Bob drops a man near e5 on his phone — the preview, then e5 on both screens, "f6 → e5"');
  {
    const id = await manAt('f6'), e5 = sqOf('e5'), want = await S.screenOf(bob, e5.x, e5.y);
    let pv = null;
    await S.dragTo(bob, id, { x: e5.x - 25, y: e5.y + 20 }, { touch: true, mid: async () => { pv = await S.preview(bob); await shot(bob, 'p3-snap-phone'); } });
    ok(pv?.ghost && S.dist(pv.ghost, want) < 1, `on the phone, mid-drag, .snap-ghost outlines e5 (${pv?.ghost && S.dist(pv.ghost, want).toFixed(2)} px off)`);
    ok(pv?.chip?.text === 'e5' && pv.chip.l >= 0 && pv.chip.t >= 0 && pv.chip.r <= pv.vw && pv.chip.b <= pv.vh, `the chip reads "${pv?.chip?.text}", inside the phone's screen (${pv?.chip && [pv.chip.l, pv.chip.t, pv.chip.r, pv.chip.b].map(Math.round).join(', ')})`);
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      ok(await atOn(p, id, 'e5'), `${who}'s view: Bob's man is at e5`);
      ok(await P.waitView(p, 'v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id, x: e5.x - 40, y: e5.y - 40 }), `${who}'s view: centred on e5`);
      ok(await logOn(p, 'moved Dark man f6 → e5', bob.pid), `${who}'s log: Bob's "moved Dark man f6 → e5"`);
    }
    const c = await drawnAt(bob, id, pv?.ghost);
    ok(pv?.ghost && S.dist(c, pv.ghost) < 1.5, `on the phone the man lands where the ghost was (${pv?.ghost && S.dist(c, pv.ghost).toFixed(2)} px off)`);
    const sent = (await acts(bob)).filter((a) => a.id === id && a.t === 'move');
    ok(sent.length === 1 && sent[0].x === e5.x - 40 && sent[0].y === e5.y - 40 && sent[0].to === 'e5', `the drop sent one move with the snapped x, y and the advisory to (${JSON.stringify(sent.map(({ at_, ...a }) => a))})`);
  }

  section('Draughts: the address chip stays readable when another player\'s name bulb comes over it');
  {
    // Bob holds a man over a5; meanwhile Alice drags one of hers (live) so that,
    // on Bob's phone, her name bulb — which follows her piece — sits on his chip.
    const id = await manAt('b6'), a5 = sqOf('a5'), hers = await manAt('d4');
    let pv = null, bulb = null, top = null;
    await S.dragTo(bob, id, { x: a5.x + 15, y: a5.y + 10 }, {
      touch: true, mid: async () => {
        pv = await S.preview(bob);
        if (!pv?.chip) return;
        const chip = { x: (pv.chip.l + pv.chip.r) / 2, y: (pv.chip.t + pv.chip.b) / 2 };
        let aim = await S.tableOf(bob, { x: chip.x, y: chip.y + 40 }); // (a first guess: a bulb sits just above its piece)
        for (let k = 0; k < 6 && !(bulb && bulb.l < chip.x && bulb.r > chip.x && bulb.t < chip.y && bulb.b > chip.y); k++) {
          await L.act(host, { t: 'drag', id: hers, x: aim.x - 40, y: aim.y - 40 });
          await h.sleep(400);
          bulb = await bob.evaluate(() => [...document.querySelectorAll('.fx-bulb')].map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, text: el.textContent }; }).find((b) => b.text === 'Alice'));
          if (bulb) { const c = await S.tableOf(bob, { x: (bulb.l + bulb.r) / 2, y: (bulb.t + bulb.b) / 2 }), want = await S.tableOf(bob, chip); aim = { x: aim.x + want.x - c.x, y: aim.y + want.y - c.y }; }
        }
        top = { ...(await S.topAt(bob, chip)), over: !!bulb && bulb.l < chip.x && bulb.r > chip.x && bulb.t < chip.y && bulb.b > chip.y };
        await shot(bob, 'p3-chip-bulb-phone');
      },
    });
    ok(pv?.chip?.text === 'a5', `Bob's phone previews "${pv?.chip?.text}"`);
    ok(top?.over, `(Alice's live drag brings her name bulb over the chip on Bob's screen: ${JSON.stringify(bulb)})`);
    ok(top?.chip, `the chip is drawn on top of it, still showing "a5" (on top at its centre: ${top?.cls})`);
    ok(await atOn(host, id, 'a5'), '(Bob\'s man lands on a5)');
    ok(await settledAt(bob, hers), '(and Alice\'s man, never dropped, glides home on Bob\'s phone)');
  }

  section('Draughts: off the squares — the margin and the felt show no preview; "from e3", "moved Light man", "to f4"');
  {
    const id = await manAt('e3');
    const margin = { x: db.x + 10, y: sqOf('a4').y }, felt = { x: db.x + 140, y: db.y - 120 }; // (bare felt: the band above the board — its sides are 80 units wide, D314)
    let pv = null;
    await S.dragTo(host, id, margin, { mid: async () => { pv = await S.preview(host); } });
    ok(pv && !pv.ghost && !pv.chip && pv.spot === null, `over the board's margin (no square there) no ghost, no chip (${JSON.stringify(pv && { g: !!pv.ghost, c: pv.chip?.text, s: pv.spot })})`);
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      ok(await atOn(p, id, null), `${who}'s view: the man has no address`);
      ok(await logOn(p, 'moved Light man from e3', host.pid), `${who}'s log: "moved Light man from e3"`);
    }
    await S.dragTo(host, id, felt, { mid: async () => { pv = await S.preview(host); } });
    ok(pv && !pv.ghost && !pv.chip && pv.spot === null, 'over bare felt, nothing either');
    ok(await P.waitView(bob, 'Math.abs(v.items[a.id].x + 40 - a.x) < 3 && Math.abs(v.items[a.id].y + 40 - a.y) < 3 && v.items[a.id].at === undefined', { id, ...felt }), 'on the felt it lies where it was dropped, unsnapped');
    ok(await logOn(bob, 'moved Light man', host.pid), 'Bob\'s log: plain "moved Light man" (no address either side)');
    await S.dragTo(host, id, sqOf('f4'));
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      ok(await atOn(p, id, 'f4'), `${who}'s view: back on the board, at f4`);
      ok(await logOn(p, 'moved Light man to f4', host.pid), `${who}'s log: "moved Light man to f4"`);
    }
  }

  // Live drags (spec §3c `drag`, §3g, item 7).
  /** On page p, from now on: when item `id` is first shown committed at top-left
   *  (x, y), and when its live position is first gone (performance.now()). */
  const watchEnd = (p, id, x, y) => p.evaluate(([id, x, y]) => {
    const w = (window.__end = { commit: 0, gone: 0 });
    const t = setInterval(() => {
      const it = window.__ct.view().items[id], now = performance.now();
      if (!w.commit && it && it.x === x && it.y === y) w.commit = now;
      if (!w.gone && !window.__ct.lives()[id]) w.gone = now;
      if (w.commit && w.gone) clearInterval(t);
    }, 5);
  }, [id, x, y]);
  const seqs = async () => [await P.viewOf(host, 'v.seq'), await P.viewOf(bob, 'v.seq')];

  section('Live drags: Bob drags on his phone — `drag` every 60 ms, the host\'s state unmoved, Alice\'s screen glides, then the one move');
  {
    const id = await manAt('d6'), to = sqOf('c5'), its0 = await items(), s0 = await seqs(), n0 = (await acts(bob)).length;
    const a = await S.centreOf(bob, id), b = await S.screenOf(bob, to.x, to.y);
    let mid = null;
    const half = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; // (a burst of 20 moves, then 10 at 80 ms)
    await S.gesture(bob, [...S.steps(a, half, 20), ...S.steps(half, b, 10, 80).slice(1)], {
      touch: true, mid: async () => {
        const lv = await liveNear(host, id, to, 80), d = await host.evaluate((id) => window.__ct.drawn(id), id); // (the last live drags reach Alice)
        mid = { lv, d, seqs: await seqs(), host: (await items())[id], bob: (await items(bob))[id], c: await S.centreOf(host, id), at: lv && await S.screenOf(host, lv.x + 40, lv.y + 40) };
        await watchEnd(host, id, to.x - 40, to.y - 40);
      },
    });
    ok(mid.seqs[0] === s0[0] && mid.seqs[1] === s0[1], `mid-drag the table's seq has not moved (Alice's view ${s0[0]} → ${mid.seqs[0]}, Bob's ${s0[1]} → ${mid.seqs[1]}): a live drag changes no state`);
    ok(mid.host.x === its0[id].x && mid.host.y === its0[id].y && mid.bob.x === its0[id].x && mid.bob.y === its0[id].y && mid.host.at === 'd6', `and the man is still on d6 in both views (${mid.host.x}, ${mid.host.y}, at ${mid.host.at})`);
    ok(!!mid.lv && Math.abs(mid.lv.x + 40 - to.x) < 3 && Math.abs(mid.lv.y + 40 - to.y) < 3, `Alice's screen shows the man live under Bob's finger, over c5 (${JSON.stringify(mid.lv)}; c5's top-left is ${to.x - 40}, ${to.y - 40})`);
    ok(mid.d && (mid.d.tx || mid.d.ty) && mid.at && S.dist(mid.c, mid.at) < 1, `drawn there by a translation (${mid.d && `${mid.d.tx}, ${mid.d.ty}`}), its element ${mid.at && S.dist(mid.c, mid.at).toFixed(2)} px from the live spot`);
    const sent = (await acts(bob)).slice(n0).filter((x) => x.id === id), drags = sent.filter((x) => x.t === 'drag'), gaps = drags.slice(1).map((x, k) => x.at_ - drags[k].at_);
    ok(drags.length >= 3 && drags.every((x) => Number.isFinite(x.x) && Number.isFinite(x.y) && !('to' in x)), `Bob's phone sent ${drags.length} live \`drag\`s {id, x, y}`);
    ok(gaps.length > 0 && Math.min(...gaps) >= 50, `at most one per 60 ms, though his finger sent 30 moves at once (the shortest gap ${Math.min(...gaps).toFixed(0)} ms)`);
    ok(sent.filter((x) => x.t === 'move').length === 1 && sent.at(-1).t === 'move' && sent.at(-1).to === 'c5' && sent.at(-1).x === to.x - 40,
      `and one \`move\`, on the drop, last: ${JSON.stringify(sent.filter((x) => x.t !== 'drag').map(({ t, x, y, to }) => ({ t, x, y, to })))}`);
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) ok(await atOn(p, id, 'c5') && await logOn(p, 'moved Dark man d6 → c5', bob.pid), `${who}'s view: at c5, logged "moved Dark man d6 → c5"`);
    ok(await settledAt(host, id), 'on Alice\'s screen the glide ends at the committed position (left/top its x, y, no translation)');
    const end = await host.evaluate(() => window.__end);
    ok(end.commit > 0 && end.gone > 0 && end.gone - end.commit < 100, `the live position goes with the committed update, not after the 1.5 s hold (${(end.gone - end.commit).toFixed(0)} ms apart)`);
  }

  section('Live drags: the host\'s own drag shows on Bob\'s phone too, and changes nothing until the drop');
  {
    const id = await manAt('f4'), to = sqOf('g5'), its0 = await items(), s0 = await seqs(), f0 = (await S.liveFx(bob)).length;
    let mid = null;
    await S.dragTo(host, id, to, {
      n: 14, pause: 70, mid: async () => {
        mid = { lv: await liveNear(bob, id, to, 80), seqs: await seqs(), host: (await items())[id], fx: (await S.liveFx(bob)).slice(f0).filter((f) => f.id === id) };
        await watchEnd(bob, id, to.x - 40, to.y - 40);
      },
    });
    ok(mid.seqs[0] === s0[0] && mid.seqs[1] === s0[1] && mid.host.x === its0[id].x && mid.host.at === 'f4', `mid-drag nothing changed: seq ${s0.join('/')} → ${mid.seqs.join('/')}, the man still on f4`);
    ok(!!mid.lv && Math.abs(mid.lv.x + 40 - to.x) < 3 && Math.abs(mid.lv.y + 40 - to.y) < 3, `Bob's phone shows it live over g5 (${JSON.stringify(mid.lv)})`);
    ok(mid.fx.length >= 3 && mid.fx.every((f) => f.p === host.pid && f.live === 1 && Number.isFinite(f.x) && Number.isFinite(f.y)), `the fx Bob received: ${mid.fx.length} × {p: Alice, id, x, y, live: 1}`);
    ok(await atOn(bob, id, 'g5') && await logOn(bob, 'moved Light man f4 → g5', host.pid), 'the drop: g5 on Bob\'s view, "moved Light man f4 → g5"');
    ok(await settledAt(bob, id), 'and on his phone the glide ends at the committed position');
    const end = await bob.evaluate(() => window.__end);
    ok(end.commit > 0 && end.gone > 0 && end.gone - end.commit < 100, `its live position went with the commit (${(end.gone - end.commit).toFixed(0)} ms apart)`);
  }

  section('Live drags: a locked piece is never relayed');
  {
    const id = await manAt('h8'), mine = await manAt('b8'), hers = await manAt('g5');
    ok((await L.act(host, { t: 'lock', id, on: true })).ok && await P.waitView(bob, 'v.items[a].lock === true', id), '(Alice locks Bob\'s man on h8)');
    const t0 = await P.tf(bob), n0 = (await acts(bob)).length, f0 = (await S.liveFx(bob)).length;
    const a = await S.centreOf(bob, id);
    await S.gesture(bob, S.steps(a, { x: a.x + 40, y: a.y - 30 }, 10), { touch: true, pause: 20 });
    await h.sleep(500);
    const t1 = await P.tf(bob), sent = (await acts(bob)).slice(n0);
    ok(Math.abs(t1.px - t0.px - 40) < 2.5 && Math.abs(t1.py - t0.py + 30) < 2.5, `Bob's finger on it pans his view (by ${(t1.px - t0.px).toFixed(1)}, ${(t1.py - t0.py).toFixed(1)})`);
    ok(!sent.some((x) => x.id === id), `and sends nothing about it (${JSON.stringify(sent.map((x) => x.t))})`);
    await bob.tap('#view-btn');
    // A tampered client sends the drags anyway: of the locked man, of Alice's, and (the control) of his own.
    await L.act(bob, { t: 'drag', id, x: 500, y: 500 });
    await L.act(bob, { t: 'drag', id: hers, x: 500, y: 600 });
    const seen = await L.until(async () => !!(await host.evaluate(() => window.__ct.lives()))[mine] || (await L.act(bob, { t: 'drag', id: mine, x: 300, y: 600 }), false), 5000, 100);
    ok(seen, 'the control: Bob\'s raw drag of his own man shows live on Alice\'s screen');
    await h.sleep(800);
    const fx = (await S.liveFx(bob)).slice(f0), lv = await host.evaluate(() => window.__ct.lives());
    ok(!fx.some((f) => f.id === id || f.id === hers) && !lv[id] && !lv[hers], `the drags of the locked man and of Alice's are relayed to nobody (Bob received ${fx.length} live fx, all of ${[...new Set(fx.map((f) => f.id))].join(', ')})`);
    ok((await items())[id].x === (await items(bob))[id].x && (await P.viewOf(host, 'v.items[a].at', id)) === 'h8', 'and the locked man stays on h8');
    await L.act(host, { t: 'lock', id, on: false });
  }

  // ===========================================================================
  // Backgammon under snapping (item 11): t-p2-demos.js's script, with Phase 3.
  /** Opens 🎲 Games on the host and picks game `k`, accepting the confirm; returns the confirm's text. */
  async function pickGame(k) {
    let asked = null;
    const onDialog = (d) => { asked = d.message(); d.accept(); };
    host.once('dialog', onDialog);
    await host.click('#games-btn');
    await host.waitForSelector('#games-dialog[open]');
    await host.click(`#games-list [data-game="${k}"]`);
    await h.sleep(500);
    host.off('dialog', onDialog);
    if (await host.$('#games-dialog[open]')) await host.click('#games-dialog form button');
    return asked;
  }
  /** Item `id`'s "×k" badge on page p: {text, h (px tall), a (its on-screen angle, degrees: 0 upright)}, or null. */
  const fanb = (p, id) => p.evaluate((id) => {
    const el = document.querySelector(`.item[data-id="${id}"] > .fanb`);
    if (!el || !el.getClientRects().length) return null;
    const pr = (left) => { const i = document.createElement('i'); i.style.cssText = `position:absolute;top:0;left:${left};width:0;height:0`; el.appendChild(i); const r = i.getBoundingClientRect(); i.remove(); return r; };
    const [a, b] = [pr('0'), pr('100%')], cls = getComputedStyle(el);
    return { text: el.textContent, h: el.getBoundingClientRect().height, a: Math.round((Math.atan2(b.top - a.top, b.left - a.left) * 1800) / Math.PI) / 10, bg: cls.backgroundColor };
  }, id);
  /** The pieces on page p's view at address `at`, bottom to top (by z). */
  const crowd = (p, at) => P.viewOf(p, 'Object.keys(v.items).filter((k) => v.items[k].at === a).sort((x, y) => v.items[x].z - v.items[y].z)', at);

  section('Backgammon: picked from 🎲 — the standard start, every checker centred on its point');
  ok(await pickGame('backgammon') === 'Clear the table and set up Backgammon? The current game is discarded.', 'Alice confirms "Clear the table and set up Backgammon?"');
  const bgOn = "v.table.w === 1480 && v.table.h === 1520 && Object.values(v.items).filter((it) => it.k === 'g').length === 34";
  for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) ok(await P.waitView(p, bgOn, null, 30000), `${who}'s screen: the board, 30 checkers, two dice and the cube`);
  await P.waitView(host, `v.players[me].seatId === 'light' && v.players[a].seatId === 'dark'`, bob.pid);
  const bg = await boardOf(host), bgt = await typeOf(host, bg.t), SP = Object.fromEntries(bgt.B.spaces.map((s) => [s.id, s]));
  const tris = bgt.B.spaces.filter((s) => s.mark === 'tri');
  ok(tris.length === 24 && tris.every((s) => (s.dir === 'down') === (s.y < bgt.h / 2) && (s.dir === 'up') === (s.y > bgt.h / 2)), 'every point has a dir: down along the top, up along the bottom (toward the middle)');
  {
    // The standard start, read by place as t-p2-demos does: a row (top, bottom) and a column (0–11, left to right).
    const rows = { top: tris.filter((s) => s.y < bgt.h / 2).sort((a, b) => a.x - b.x), bottom: tris.filter((s) => s.y > bgt.h / 2).sort((a, b) => a.x - b.x) };
    const place = (id) => Object.entries(rows).map(([row, list]) => { const k = list.findIndex((s) => s.id === id); return k >= 0 && `${row}${k}`; }).find(Boolean);
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      const its = await items(p), checkers = Object.values(its).filter((it) => /^seat:(light|dark)$/.test(it.owner)), count = {};
      for (const it of checkers) { const k = `${it.owner.slice(5)} ${place(it.at)}`; count[k] = (count[k] || 0) + 1; }
      const start = (m) => ({ [`light top${m(11)}`]: 2, [`light top${m(0)}`]: 5, [`light bottom${m(4)}`]: 3, [`light bottom${m(6)}`]: 5,
        [`dark bottom${m(11)}`]: 2, [`dark bottom${m(0)}`]: 5, [`dark top${m(4)}`]: 3, [`dark top${m(6)}`]: 5 });
      const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
      ok(checkers.length === 30 && (same(count, start((c) => c)) || same(count, start((c) => 11 - c))), `${who}'s view: 15 + 15 checkers on their points, by address, in the standard start (${JSON.stringify(count)})`);
      const off = checkers.filter((it) => !SP[it.at] || it.x + 40 !== bg.x + SP[it.at].x || it.y + 40 !== bg.y + SP[it.at].y);
      ok(!off.length, `${who}'s view: each is centred on its point in the state (the fan is drawn, not stored)${off.length ? `: ${JSON.stringify(off[0])}` : ''}`);
      ok(Object.values(its).filter((it) => it.k === 'g' && it.z >= 0 && !/^seat:/.test(it.owner || '')).every((it) => it.at === undefined), `${who}'s view: the dice and the cube, beside the points, have no address`);
    }
  }
  /** Checks (ok) that the pieces at point `at` are drawn fanned on page p
   *  (`who`) as spec §3g has it: in z order along the point's dir, a
   *  checker's height apart, squeezed to (L − 80)/(k − 1) when k would
   *  overflow its length L (D108: the first at its base), inside its
   *  triangle — in table units and on the screen — the top one alone with "×k". */
  /** The pieces at address `at` on page p, bottom to top: {id, d (__ct.drawn), r (its client rect), badge ("×k" text, or null)}. */
  const fanState = (p, at) => p.evaluate((at) => {
    const v = window.__ct.view(), ids = Object.keys(v.items).filter((k) => v.items[k].at === at).sort((a, b) => v.items[a].z - v.items[b].z);
    return ids.map((id) => {
      const el = document.querySelector(`.item[data-id="${id}"]`), r = el?.getBoundingClientRect(), b = el?.querySelector(':scope > .fanb');
      return { id, d: window.__ct.drawn(id), r: r && { l: r.left, r: r.right, t: r.top, b: r.bottom }, badge: b?.getClientRects().length ? b.textContent : null };
    });
  }, at);
  async function fanned(p, who, at) {
    const s = SP[at], len = s.h, box0 = await Promise.all([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([u, v]) => S.screenOf(p, bg.x + s.x + (u * s.w) / 2, bg.y + s.y + (v * len) / 2)));
    const box = { l: Math.min(...box0.map((c) => c.x)), r: Math.max(...box0.map((c) => c.x)), t: Math.min(...box0.map((c) => c.y)), b: Math.max(...box0.map((c) => c.y)) };
    let f, step, bad, inside, out, badges;
    const judge = (st) => {
      f = st;
      const k = f.length;
      step = k > 1 ? Math.min(80, (len - 80) / (k - 1)) : 0;
      const want = (j) => ({ x: bg.x + s.x - 40, y: s.dir === 'down' ? bg.y + s.y - len / 2 + j * step : bg.y + s.y + len / 2 - 80 - j * step });
      bad = f.map((m, j) => ({ d: m.d, w: want(j) })).filter(({ d, w }) => !d || Math.abs(d.x - w.x) > 0.01 || Math.abs(d.y - w.y) > 0.01);
      inside = f.every(({ d }) => d && d.x >= bg.x + s.x - s.w / 2 && d.x + 80 <= bg.x + s.x + s.w / 2 && d.y >= bg.y + s.y - len / 2 - 0.01 && d.y + 80 <= bg.y + s.y + len / 2 + 0.01);
      out = f.filter(({ r }) => !r || r.l < box.l - 0.5 || r.r > box.r + 0.5 || r.t < box.t - 0.5 || r.b > box.b + 0.5);
      badges = f.map((m) => m.badge);
      return k > 0 && !bad.length && inside && !out.length && badges.slice(0, -1).every((b) => !b) && badges.at(-1) === (k < 2 ? null : `×${k}`);
    };
    await L.until(async () => judge(await fanState(p, at)), 8000, 150); // (a commit's redraw may still be on its way)
    const k = f.length;
    ok(k > 0 && !bad.length, `${who}: ${k > 1 ? `the ${k} on ${at} are drawn ${step.toFixed(2)} apart from its base, ${s.dir}, in z order` : `the one on ${at} is drawn at its base`}${bad.length ? ` — ${JSON.stringify(bad[0])}` : ''}`);
    ok(inside && !out.length, `${who}: all inside the triangle's ${s.w} × ${len} — in table units, and on the screen (${out.length} of ${k} out)`);
    ok(badges.slice(0, -1).every((b) => !b) && badges.at(-1) === (k < 2 ? null : `×${k}`), k < 2 ? `${who}: a lone checker carries no "×k"` : `${who}: the top one alone carries "${badges.at(-1)}"`);
    return f.map((m) => m.id);
  }

  section('Backgammon: crowded points fan along their dir inside the triangle, "×k" on the top checker');
  {
    const its = await items(), byAt = {};
    for (const [id, it] of Object.entries(its)) if (it.at) (byAt[it.at] ||= []).push(id);
    const pts = Object.keys(byAt).sort(), owner = (at) => its[byAt[at][0]].owner;
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) for (const at of pts) await fanned(p, who, at);
    const five = pts.find((at) => byAt[at].length === 5 && owner(at) === 'seat:dark'), lightPt = pts.find((at) => byAt[at].length >= 3 && owner(at) === 'seat:light');
    const b = await fanb(bob, (await crowd(bob, five)).at(-1));
    ok(b && b.h >= 10 && Math.abs(b.a) < 0.5, `on Bob's phone (his view turned 180°) the "${b?.text}" on ${five} reads upright (${b?.a}°) and ${b?.h.toFixed(1)} px tall: readable`);
    ok(b && b.bg !== 'rgb(14, 165, 233)', `the "×k" badge is not a stack's blue ×N (${b?.bg})`);
    await shot(host, 'p3-bg-fan-desk');
    await shot(bob, 'p3-bg-fan-phone');

    section('Backgammon: a tap on a crowded point selects its top checker; a drag from it takes the top one');
    const ids = await crowd(bob, five), bottom = ids[0], c0 = await S.centreOf(bob, bottom);
    await bob.touchscreen.tap(c0.x, c0.y);
    ok(await bob.waitForFunction((id) => document.querySelector('.item.selected')?.dataset.id === id, ids.at(-1), { timeout: 5000 }).then(() => true, () => false),
      `Bob taps the bottom checker of ${five} (drawn at its base): the top one is selected (${await bob.evaluate(() => document.querySelector('.item.selected')?.dataset.id)} of ${ids.length})`);
    await bob.touchscreen.tap(c0.x, c0.y);
    const lids = await crowd(host, lightPt);
    const lc = await S.centreOf(host, lids[0]);
    await host.mouse.click(lc.x, lc.y);
    ok(await host.waitForFunction((id) => document.querySelector('.item.selected')?.dataset.id === id, lids.at(-1), { timeout: 5000 }).then(() => true, () => false), `Alice clicks the bottom checker of ${lightPt}: its top one is selected`);
    await host.keyboard.press('Escape');
    const dest = tris.find((s) => s.dir === SP[five].dir && !Object.values(its).some((it) => it.at === s.id)).id;
    const d = SP[dest], dc = { x: bg.x + d.x, y: bg.y + d.y };
    await S.gesture(bob, S.steps(c0, await S.screenOf(bob, dc.x, dc.y), 12), { touch: true });
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      ok(await atOn(p, ids.at(-1), dest), `${who}'s view: the top checker of ${five} went to ${dest}, though Bob's finger pressed the bottom one`);
      ok(await P.waitView(p, 'a.ids.every((id) => v.items[id].at === a.at)', { ids: ids.slice(0, -1), at: five }), `${who}'s view: the other ${ids.length - 1} stayed on ${five}`);
      ok(await logOn(p, `moved Dark checker ${five} → ${dest}`, bob.pid), `${who}'s log: "moved Dark checker ${five} → ${dest}"`);
    }
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) { await fanned(p, who, five); await fanned(p, who, dest); }
  }

  section('Backgammon: all 15 dark checkers on one point stay inside its triangle, on both screens');
  {
    const its = await items(), dark = Object.keys(its).filter((k) => its[k].owner === 'seat:dark').sort((a, b) => its[a].z - its[b].z);
    const pt = tris.find((s) => s.dir === 'up' && !Object.values(its).some((it) => it.at === s.id)), c = { x: bg.x + pt.x, y: bg.y + pt.y };
    for (const id of dark.slice(0, 13)) await L.act(bob, { t: 'move', id, x: c.x - 40 + 7, y: c.y - 40 - 9 }); // (raw, off-centre: the host snaps them)
    ok(await P.waitView(host, 'a.ids.every((id) => v.items[id].at === a.at)', { ids: dark.slice(0, 13), at: pt.id }), `(13 of them moved to ${pt.id} by Bob's client)`);
    for (const id of dark.slice(13)) { await S.dragTo(bob, id, c, { touch: true }); await atOn(host, id, pt.id); }
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      ok(await P.waitView(p, 'a.ids.every((id) => v.items[id].at === a.at && v.items[id].x === a.x && v.items[id].y === a.y)', { ids: dark, at: pt.id, x: c.x - 40, y: c.y - 40 }), `${who}'s view: all 15 at ${pt.id}, each centred on it`);
      await fanned(p, who, pt.id);
    }
    await shot(host, 'p3-bg-15-desk');
    await shot(bob, 'p3-bg-15-phone');
  }

  section('Backgammon: the dice roll together, the cube turns, a checker goes to the bar');
  {
    const its = await items(), dice = Object.keys(its).filter((k) => its[k].k === 'g' && !its[k].owner && its[k].z >= 0 && !(its[k].t || '').endsWith('/cube')).sort();
    const cube = Object.keys(its).find((k) => (its[k].t || '').endsWith('/cube'));
    const rolls = async () => (await P.viewOf(host, 'v.log')).filter((e) => /^rolled /.test(e.txt)).length, r0 = await rolls();
    const dc = await S.centreOf(host, dice[0]);
    await host.mouse.dblclick(dc.x, dc.y);
    ok(await L.until(async () => (await rolls()) === r0 + 1, 10000), 'Alice double-clicks one die: one roll, "rolled a · b"');
    ok(await P.waitView(host, 'a.every((id) => v.items[id].at === undefined)', dice), 'the dice still have no address');
    const cc = await S.centreOf(host, cube);
    await host.mouse.dblclick(cc.x, cc.y);
    ok(await logOn(bob, 'turned 64 to 2', host.pid), 'a double-click turns the cube: "turned 64 to 2"');
    const from = Object.values(its).find((it) => it.owner === 'seat:dark').at, top = (await crowd(host, from)).at(-1), bar = SP.bar;
    await S.dragTo(bob, top, { x: bg.x + bar.x, y: bg.y + bar.y - 250 }, { touch: true });
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      ok(await atOn(p, top, 'bar'), `${who}'s view: Bob's top checker is on the bar (dropped on its upper part: inside its rectangle, D104)`);
      ok(await logOn(p, `moved Dark checker ${from} → bar`, bob.pid), `${who}'s log: "moved Dark checker ${from} → bar"`);
    }
    ok(await P.waitView(host, 'v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id: top, x: bg.x + bar.x - 40, y: bg.y + bar.y - 40 }), 'centred on the bar');
    // (the bar fans its checkers from its top end down since the 3A fix-up, D115:
    // a lone one is drawn at its base, as on a point)
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) await fanned(p, who, 'bar');
    await shot(bob, 'p3-bg-bar-phone');
  }

  // ===========================================================================
  // A script's table: square points, hexes, spaces, several boards (items 1, 2, 8, 10).
  section('A script builds its table (t.newBox, t.spawn); Carol joins on a phone in landscape');
  const carol = await S.join(env, 'Carol', host.url(), { ctx: h.playwright.devices['iPhone 13 landscape'] });
  carol.touch = true;
  const all = [[host, 'Alice'], [bob, 'Bob'], [carol, 'Carol']];
  ok((await L.act(host, { t: 'clear' })).ok && (await L.act(host, { t: 'setRules', code: SPACE, enabled: true })).ok, '(Alice clears the table and enables the script)');
  for (const [p, who] of all) ok(await P.waitView(p, "Object.values(v.items).length === 22 && v.table.w === 3000", null, 30000), `${who}'s screen: five boards, 15 stones, a supply and a bag on a 3000 × 2000 table`);
  const its0 = await items(), byType = (k) => Object.keys(its0).filter((id) => its0[id].t?.endsWith(`/${k}`));
  const B = {};
  for (const k of ['board', 'go', 'hexp', 'hexf', 'yard']) { const id = byType(k)[0]; B[k] = { id, ...its0[id], ...(await typeOf(host, its0[id].t)) }; }
  /** Board k's spot `local` (or board-local point l) on the table. */
  const spotOn = (k, local) => { const b = B[k], g = b.B.grid; if (typeof local !== 'string') return S.onTable(b, local); for (let r = 0; r < (g?.rows || 0); r++) for (let c = 0; c < g.cols; c++) if (S.addrOf(g, c, r) === local) return S.onTable(b, S.spotXY(g, c, r)); const sp = b.B.spaces.find((x) => x.id === local); return S.onTable(b, sp); };
  const stoneAt = async (at, p = host) => { const v = await items(p); return Object.keys(v).find((k) => v[k].at === at && v[k].t?.endsWith('/stone')); };
  const loose = async () => { const v = await items(); return Object.keys(v).filter((k) => v[k].k === 'g' && v[k].t.endsWith('/stone') && !v[k].at && !v[k].owner && !v[k].lock).sort((a, b) => v[a].x - v[b].x); };
  const LBL = ['A', 'B', 'C'], lbl = async (id) => LBL[(await items())[id].f];
  /** Checks (ok) on every screen that stone `id` is at `at`, centred on spot `c` (table point), and logged `txt` by `by`. */
  async function landed(id, at, c, txt, by) {
    for (const [p, who] of all) {
      ok(await P.waitView(p, 'v.items[a.id]?.at === a.at && v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id, at, x: c.x - 25, y: c.y - 25 }), `${who}'s view: at ${at}, centred on it`);
      if (txt) ok(await logOn(p, txt, by), `${who}'s log: "${txt}"`);
    }
  }
  /** Drags stone `id` on page p to table point `to`, reading the preview mid-drag (and
   *  screenshotting it as shots/<snap>.png); returns the preview (S.preview). */
  async function dropAt(p, id, to, snap) {
    let pv = null;
    await S.dragTo(p, id, to, { touch: p.touch, mid: async () => { pv = await S.preview(p); if (snap) await shot(p, snap); } });
    return pv;
  }

  section('Display forms: the primary board\'s addresses are bare, the others\' carry their type');
  {
    const v = await items(), on = Object.values(v).filter((it) => it.at).map((it) => it.at).sort();
    ok(JSON.stringify(on) === JSON.stringify(['b2', 'e4', 'f5', 'g1', 'h7']), `the five stones spawned on the board (the oldest with a grid: primary) read b2, e4, f5, g1, h7 (${on.join(', ')})`);
    for (const [p, who] of all.slice(1)) ok(JSON.stringify((await P.viewOf(p, 'Object.values(v.items).map((it) => it.at).filter(Boolean).sort()'))) === JSON.stringify(on), `${who}'s view reads the same`);
  }

  section('Snapping on square points (go): a drop near E5 lands on it; between four points, nowhere');
  {
    const id = (await loose())[0], E5 = spotOn('go', 'E5'), L0 = await lbl(id);
    const pv = await dropAt(host, id, { x: E5.x + 18, y: E5.y - 12 }, 'p3-go-desk');
    ok(pv?.chip?.text === 'go:E5' && pv.ghost && S.dist(pv.ghost, await S.screenOf(host, E5.x, E5.y)) < 1, `mid-drag the preview is on the point, the chip "${pv?.chip?.text}"`);
    await landed(id, 'go:E5', E5, `moved ${L0} to go:E5`, host.pid);
    const F6 = spotOn('go', 'F6');
    await dropAt(host, id, { x: F6.x - 12, y: F6.y + 14 });
    await landed(id, 'go:F6', F6, `moved ${L0} go:E5 → go:F6`, host.pid);
    const mid = spotOn('go', { x: B.go.B.grid.x + 4.5 * 60, y: B.go.B.grid.y + 4.5 * 60 });
    const pv2 = await dropAt(host, id, mid);
    ok(pv2 && !pv2.ghost && !pv2.chip, 'in the middle of a square (42 units from each point, beyond cell/2 = 30) no preview');
    for (const [p, who] of all) ok(await atOn(p, id, null), `${who}'s view: no address there`);
    ok(await logOn(bob, `moved ${L0} from go:F6`, host.pid), `the log: "moved ${L0} from go:F6"`);
  }

  section('Snapping on pointy hexes (Bob\'s phone) and flat hexes (Carol\'s phone, landscape)');
  {
    const [b1, c1] = (await loose()).slice(1, 3), R = 80 / S.R3;
    let to = spotOn('hexp', '2,2');
    let pv = await dropAt(bob, b1, { x: to.x + 0.35 * R, y: to.y - 0.25 * R }, 'p3-hex-phone');
    ok(pv?.chip?.text === 'hexp:2,2', `Bob's phone previews "${pv?.chip?.text}" (cell (3, 2): axial 2,2)`);
    await landed(b1, 'hexp:2,2', to, `moved ${await lbl(b1)} to hexp:2,2`, bob.pid);
    to = spotOn('hexp', '1,3');
    pv = await dropAt(bob, b1, { x: to.x - 0.3 * R, y: to.y + 0.3 * R });
    ok(pv?.chip?.text === 'hexp:1,3', `an odd row: "${pv?.chip?.text}" (cell (2, 3): axial 1,3, shifted half a hex)`);
    await landed(b1, 'hexp:1,3', to, `moved ${await lbl(b1)} hexp:2,2 → hexp:1,3`, bob.pid);
    to = spotOn('hexf', '3,0');
    pv = await dropAt(carol, c1, { x: to.x + 0.3 * R, y: to.y + 0.3 * R }, 'p3-hex-landscape');
    ok(pv?.chip?.text === 'hexf:3,0' && pv.chip.l >= 0 && pv.chip.r <= pv.vw && pv.chip.t >= 0 && pv.chip.b <= pv.vh, `Carol's landscape phone previews "${pv?.chip?.text}" (cell (3, 1): axial 3,0), the chip on her screen`);
    await landed(c1, 'hexf:3,0', to, `moved ${await lbl(c1)} to hexf:3,0`, carol.pid);
    to = spotOn('hexf', '2,2');
    pv = await dropAt(carol, c1, { x: to.x - 0.3 * R, y: to.y - 0.35 * R });
    await landed(c1, 'hexf:2,2', to, `moved ${await lbl(c1)} hexf:3,0 → hexf:2,2`, carol.pid);
    for (const [k, id] of [['hexp', b1], ['hexf', c1]]) {
      const c = await S.centreOf(host, id), l = await S.svgLocal(host, B[k].id, c), s = S.expectSpot(B[k].B, l.x, l.y);
      ok(s && Math.hypot(l.x - s.x, l.y - s.y) < 0.5, `on Alice's screen the stone sits on the ${k} hex as drawn (${Math.hypot(l.x - (s?.x ?? 0), l.y - (s?.y ?? 0)).toFixed(2)} units from its centre in the board's SVG)`);
    }
  }

  section('Snapping on spaces: inside a space\'s rectangle (D104), within a ring\'s reach, and out of reach');
  {
    const [s1, s2] = (await loose()).slice(0, 2), Y = B.yard.B.spaces, tower = Y.find((x) => x.id === 'tower');
    let pv = await dropAt(host, s1, spotOn('yard', { x: tower.x + 58, y: tower.y + 58 }));
    ok(pv?.chip?.text === 'yard:tower', `a drop in the corner of tower's 140 × 140 rectangle (82 from its centre, beyond its r ${tower.r}) previews "${pv?.chip?.text}"`);
    await landed(s1, 'yard:tower', spotOn('yard', 'tower'), `moved ${await lbl(s1)} to yard:tower`, host.pid);
    pv = await dropAt(carol, s2, spotOn('yard', { x: 100 + 40, y: 100 - 30 }), 'p3-space-landscape');
    ok(pv?.chip?.text === 'yard:home', `Carol drops 50 from home's centre (its reach 70): "${pv?.chip?.text}"`);
    await landed(s2, 'yard:home', spotOn('yard', 'home'), `moved ${await lbl(s2)} to yard:home`, carol.pid);
    pv = await dropAt(host, s1, spotOn('yard', { x: 50, y: 220 }));
    ok(pv && !pv.ghost && !pv.chip, 'on the yard but out of every space\'s reach: no preview');
    ok(await atOn(bob, s1, null) && await logOn(bob, `moved ${await lbl(s1)} from yard:tower`, host.pid), 'no address, "… from yard:tower"');
    await dropAt(carol, s2, spotOn('yard', { x: tower.x - 45, y: tower.y + 40 }));
    await landed(s2, 'yard:tower', spotOn('yard', 'tower'), `moved ${await lbl(s2)} yard:home → yard:tower`, carol.pid);
  }

  section('Stacking on a space with a dir (the lane, right) and on a cell: fanned at render time, "×k"');
  {
    const ids = (await loose()).slice(0, 3), lane = B.yard.B.spaces.find((x) => x.id === 'lane'), c = spotOn('yard', 'lane');
    for (const id of ids) { await dropAt(host, id, { x: c.x + 100, y: c.y + 20 }); await atOn(host, id, 'yard:lane'); }
    for (const [p, who] of all) {
      ok(await P.waitView(p, 'a.ids.every((id) => v.items[id].at === "yard:lane" && v.items[id].x === a.x && v.items[id].y === a.y)', { ids, x: c.x - 25, y: c.y - 25 }), `${who}'s view: the three on yard:lane, all centred on it in the state`);
      const want = (j) => ({ x: B.yard.x + lane.x - lane.w / 2 + 50 * j, y: c.y - 25 }), fits = (q, j) => q && Math.abs(q.x - want(j).x) < 0.01 && Math.abs(q.y - want(j).y) < 0.01;
      let order, d;
      await L.until(async () => { order = await crowd(p, 'yard:lane'); d = await p.evaluate((ids) => ids.map((id) => window.__ct.drawn(id)), order); return d.length === 3 && d.every(fits); }, 5000, 100);
      ok(d.length === 3 && d.every(fits), `${who}: drawn a stone's width (50) apart, rightward from the lane's far end, in z order (${d.map((q) => q.x).join(', ')})`);
      ok(d.every((q) => q.x >= B.yard.x + lane.x - lane.w / 2 && q.x + 50 <= B.yard.x + lane.x + lane.w / 2), `${who}: inside the lane`);
      ok((await fanb(p, order.at(-1)))?.text === '×3' && !(await fanb(p, order[0])), `${who}: "×3" on the top one only`);
    }
    const e4 = await stoneAt('e4'), id = (await loose())[0], E4 = spotOn('board', 'e4');
    await dropAt(bob, id, { x: E4.x - 20, y: E4.y + 15 });
    for (const [p, who] of all) {
      ok(await atOn(p, id, 'e4'), `${who}'s view: Bob put a second stone on e4`);
      let d0, d1;
      const six = () => Math.abs(Math.hypot(d1.x - d0.x, d1.y - d0.y) - 6) < 0.01;
      await L.until(async () => { [d0, d1] = await p.evaluate((ids) => ids.map((id) => window.__ct.drawn(id)), [e4, id]); return six(); }, 5000, 100);
      ok(six(), `${who}: on a cell (no dir) the two are drawn 6 table units apart (${d0.x},${d0.y} and ${d1.x},${d1.y})`);
      ok((await fanb(p, id))?.text === '×2', `${who}: "×2" on the newer one`);
    }
    await shot(host, 'p3-space-desk');
  }

  section('Item 2: validate and onAction see a.to and a.from; a pull\'s a.pick is the member taken; a lying `to` is overwritten');
  /** The script's echo lines ("validate …", "onAction …") in page p's log, from index `from` on. */
  const echoes = async (p, from = 0) => (await P.viewOf(p, 'v.log')).slice(from).filter((e) => e.p === 'RULES' && /^(validate|onAction) /.test(e.txt)).map((e) => e.txt);
  {
    let n0 = (await P.viewOf(host, 'v.log')).length;
    const id = await stoneAt('f5'), D3 = spotOn('board', 'd3');
    await dropAt(bob, id, { x: D3.x + 20, y: D3.y + 20 });
    ok(await atOn(host, id, 'd3'), '(Bob moves the stone on f5 to d3)');
    for (const [p, who] of all) ok(await L.until(async () => JSON.stringify(await echoes(p, n0)) === JSON.stringify(['validate move f5 > d3', 'onAction move f5 > d3']), 8000), `${who}'s log: validate, then onAction, saw "move f5 > d3" (${JSON.stringify(await echoes(p, n0))})`);
    // take: a drag out of the supply; a.to is where the PROSPECTIVE stone (50 × 50) snaps
    n0 = (await P.viewOf(host, 'v.log')).length;
    const sup = Object.entries(await items()).find(([, it]) => it.k === 's')[0], C6 = spotOn('board', 'c6');
    const before = new Set(Object.keys(await items())), c0 = (await acts(carol)).length;
    await S.dragTo(carol, sup, { x: C6.x - 30, y: C6.y + 25 }, { touch: true });
    ok(await L.until(async () => (await echoes(host, n0)).length >= 2, 8000), '(Carol drags a stone out of the supply onto c6)');
    const made = Object.keys(await items()).find((k) => !before.has(k));
    ok(JSON.stringify(await echoes(host, n0)) === JSON.stringify(['validate take - > c6', 'onAction take - > c6']), `take: validate and onAction saw "- > c6" (${JSON.stringify(await echoes(host, n0))})`);
    const took = (await acts(carol)).slice(c0).filter((x) => x.t === 'take');
    ok(took.length === 1 && took[0].x === C6.x - 25 && took[0].y === C6.y - 25 && took[0].to === 'c6', `Carol's drop sent one take with the new stone's snapped x, y and an advisory to (${JSON.stringify(took.map(({ t, x, y, to }) => ({ t, x, y, to })))})`);
    if (made) await landed(made, 'c6', C6);
    // pull: Alice double-clicks the bag; validate is told the member it draws (a.pick) and where it lands
    n0 = (await P.viewOf(host, 'v.log')).length;
    const bag = Object.entries(await items()).find(([, it]) => it.k === 'b')[0], before2 = new Set(Object.keys(await items()));
    const bc = await S.centreOf(host, bag);
    await host.mouse.dblclick(bc.x, bc.y);
    ok(await L.until(async () => (await echoes(host, n0)).length >= 2, 8000), '(Alice double-clicks the bag: a pull)');
    const pulled = Object.keys(await items()).find((k) => !before2.has(k)), e = await echoes(host, n0), m = /^validate pull - > (\S+) pick (\d) f(\d)$/.exec(e[0] || '');
    ok(!!m && e[1] === `onAction pull - > ${m[1]}`, `validate saw the draw (a.pick) before it happened, onAction the same pull (${JSON.stringify(e)})`);
    ok(!!pulled && !!m && (await items())[pulled].f === +m[3] && ((await items())[pulled].at ?? '-') === m[1], `the stone pulled is exactly of[a.pick] (face ${m && LBL[+m[3]]}), where a.to said (${m?.[1]})`);
    // and a pull placed on a cell, from the client's own act() (the CLI's path): a.to is that cell
    n0 = (await P.viewOf(host, 'v.log')).length;
    const G1 = spotOn('board', 'g2');
    await L.act(bob, { t: 'pull', id: bag, x: G1.x - 25 + 9, y: G1.y - 25 - 14, to: 'a1', pick: 0 });
    ok(await L.until(async () => (await echoes(host, n0)).length >= 2, 8000) && /^validate pull - > g2 pick [01] f\d$/.test((await echoes(host, n0))[0]),
      `a pull at g2 (sent with a lying to: 'a1' and pick: 0): validate saw "${(await echoes(host, n0))[0]}" — the host's to, and its own draw of the 2 left`);
    // move with a lying to (and from, pick): the host snaps, and overwrites them
    n0 = (await P.viewOf(host, 'v.log')).length;
    const B7 = spotOn('board', 'b7');
    await L.act(bob, { t: 'move', id, x: B7.x - 25 + 13, y: B7.y - 25 - 11, to: 'h8', from: 'a1', pick: 2 });
    await landed(id, 'b7', B7, `moved ${await lbl(id)} d3 → b7`, bob.pid);
    ok(JSON.stringify(await echoes(host, n0)) === JSON.stringify(['validate move d3 > b7', 'onAction move d3 > b7']), `Bob's client says to: 'h8', from: 'a1': the hooks saw "d3 > b7" (${JSON.stringify(await echoes(host, n0))})`);
    n0 = (await P.viewOf(host, 'v.log')).length;
    await L.act(bob, { t: 'move', id, x: 2600, y: 1000, to: 'e4' });
    ok(await atOn(carol, id, null) && JSON.stringify(await echoes(host, n0)) === JSON.stringify(['validate move b7 > -', 'onAction move b7 > -']), `a move onto bare felt claiming to: 'e4' has no address, and the hooks saw none (${JSON.stringify(await echoes(host, n0))})`);
  }

  section('Item 8: a rack (zones only) and a second map arrive — the primary board stays bare, the map reads "map:c3"');
  /** Says `msg` in the chat on page p (the chat box: a script's command). */
  async function say(p, msg) {
    if (!(await P.shows(p, '#chat-input'))) await p.click('#log-btn');
    await p.fill('#chat-input', msg);
    await p.press('#chat-input', 'Enter');
  }
  const ruled = (p, txt) => P.waitView(p, 'v.log.some((e) => e.p === "RULES" && e.txt === a)', txt);
  {
    const ats0 = await P.viewOf(host, 'Object.fromEntries(Object.entries(v.items).filter(([, it]) => it.at).map(([k, it]) => [k, it.at]))');
    await say(host, 'add');
    for (const [p, who] of all) ok(await P.waitView(p, "Object.values(v.items).some((it) => it.t?.endsWith('/map')) && Object.values(v.items).some((it) => it.t?.endsWith('/rack'))", null, 15000), `${who}'s screen: the rack and the map are on the table`);
    for (const [p, who] of all) {
      const ats = await P.viewOf(p, 'Object.fromEntries(Object.entries(v.items).filter(([, it]) => it.at).map(([k, it]) => [k, it.at]))');
      ok(JSON.stringify(ats) === JSON.stringify(ats0), `${who}'s view: every address reads as before — the primary board's still bare (${Object.values(ats).filter((x) => !x.includes(':')).sort().join(', ')})`);
    }
    const h7 = await stoneAt('h7'), G8 = spotOn('board', 'g8');
    await say(host, `where ${h7}`);
    ok(await ruled(host, 'where h7'), 't.where says "h7"');
    await dropAt(bob, h7, { x: G8.x + 10, y: G8.y + 25 });
    await landed(h7, 'g8', G8, `moved ${await lbl(h7)} h7 → g8`, bob.pid);
    const mp = Object.entries(await items()).find(([, it]) => it.t?.endsWith('/map')), map = { id: mp[0], ...mp[1], ...(await typeOf(host, mp[1].t)) };
    const mapAt = (a) => { const g = map.B.grid; for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) if (S.addrOf(g, c, r) === a) return S.onTable(map, S.spotXY(g, c, r)); return null; };
    await say(host, `go ${h7} map:c3`);
    ok(await ruled(host, 'moved? true, where map:c3'), 't.move(id, "map:c3") returns true, and t.where then says "map:c3"');
    await landed(h7, 'map:c3', mapAt('c3'), `moved ${await lbl(h7)} g8 → map:c3`, 'RULES');
    const id = (await loose())[0];
    const pv = await dropAt(carol, id, { x: mapAt('b4').x - 30, y: mapAt('b4').y + 20 }, 'p3-map-landscape');
    ok(pv?.chip?.text === 'map:b4', `Carol drags a stone onto the map: the chip reads "${pv?.chip?.text}"`);
    await landed(id, 'map:b4', mapAt('b4'), `moved ${await lbl(id)} to map:b4`, carol.pid);
    const rk = Object.entries(await items()).find(([, it]) => it.t?.endsWith('/rack'))[1];
    const pv2 = await dropAt(host, id, { x: rk.x + 300, y: rk.y + 75 });
    ok(pv2 && !pv2.ghost && !pv2.chip, 'over the rack (zones only: no spot) no preview');
    for (const [p, who] of all) ok(await atOn(p, id, null), `${who}'s view: a stone on the rack has no address`);
    ok(await logOn(carol, `moved ${await lbl(id)} from map:b4`, host.pid), `the log: "moved ${await lbl(id)} from map:b4"`);
  }

  section('Item 10: Alice moves the primary board a square to the right — nothing else moves, addresses follow by containment');
  /** Board-local point of table point q on board b (the inverse of onTable). */
  const local = (b, q) => { const a = (-b.rot * Math.PI) / 180, dx = q.x - b.x - b.w / 2, dy = q.y - b.y - b.h / 2; return { x: b.w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: b.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) }; };
  /** Checks (ok) on every screen that no item but board `bid` moved from `before` ({id: {x, y}}), and that each stone's address is what
   *  its centre lies on, by containment (expectSpot on the board as it now lies) — and, on Alice's screen, by the board's SVG as drawn. */
  async function contained(before, bid, what) {
    const b = { ...(await items())[bid], ...(await typeOf(host, (await items())[bid].t)) };
    for (const [p, who] of all) {
      let v, wrong;
      const judge = async () => {
        v = await items(p);
        wrong = [];
        if (v[bid].x !== b.x || v[bid].y !== b.y || v[bid].rot !== b.rot) wrong.push(`the board at ${v[bid].x}, ${v[bid].y}, ${v[bid].rot}° yet`);
        for (const [k, it] of Object.entries(v)) {
          if (!it.t?.endsWith('/stone') || it.k !== 'g') continue;
          const l = local(b, { x: it.x + 25, y: it.y + 25 }), on = l.x >= 0 && l.y >= 0 && l.x <= b.w && l.y <= b.h, s = on && S.expectSpot(b.B, l.x, l.y);
          if (!on && it.at && !it.at.includes(':')) wrong.push(`${k}: ${it.at}, off the board`);
          if (on && (s?.local ?? undefined) !== it.at) wrong.push(`${k}: ${it.at} for ${s?.local}`);
        }
        return !wrong.length;
      };
      await L.until(judge, 8000, 150); // (that view's patch may still be on its way)
      const moved = Object.keys(before).filter((k) => k !== bid && (v[k].x !== before[k].x || v[k].y !== before[k].y));
      ok(!moved.length, `${who}'s view: ${what}, nothing else moved (${Object.keys(before).length - 1} items still where they were)`);
      ok(!wrong.length, `${who}'s view: each stone's address is the square its centre is on now, or none (${wrong.join('; ') || 'all'})`);
    }
    const v = await items(), on = Object.entries(v).filter(([, it]) => it.t?.endsWith('/stone') && it.at && !it.at.includes(':'));
    const drawn = await Promise.all(on.map(async ([k, it]) => { const l = await S.svgLocal(host, bid, await S.screenOf(host, it.x + 25, it.y + 25)); return [k, S.expectSpot(b.B, l.x, l.y)?.local, it.at]; }));
    const off = drawn.filter(([, a, at]) => a !== at);
    ok(on.length > 0 && !off.length, `on Alice's screen each of the ${on.length} stones on the board lies on the square its address names, as the board's SVG draws it${off.length ? `: ${JSON.stringify(off)}` : ''}`);
    return b;
  }
  {
    const bid = B.board.id;
    ok((await L.act(host, { t: 'lock', id: bid, on: false })).ok, '(Alice unlocks the board)');
    const before = await P.viewOf(host, 'Object.fromEntries(Object.entries(v.items).map(([k, it]) => [k, { x: it.x, y: it.y }]))');
    const A8 = spotOn('board', 'a8'), a = await S.screenOf(host, A8.x, A8.y), b = await S.screenOf(host, A8.x + 100, A8.y);
    await S.gesture(host, S.steps(a, b, 10));
    ok(await P.waitView(host, 'Math.abs(v.items[a.id].x - a.x) < 1.5 && Math.abs(v.items[a.id].y - a.y) < 1.5', { id: bid, x: before[bid].x + 100, y: before[bid].y }), 'Alice drags the board by a square\'s width');
    await contained(before, bid, 'the board moved');
    const crowd4 = await crowd(host, 'd4');
    ok(crowd4.length === 2, `the two stones that were on e4 now read d4 (${crowd4.length} there)`);
    const C5 = (await items())[bid], to = S.onTable({ ...C5, ...(await typeOf(host, C5.t)) }, S.spotXY(B.board.B.grid, 2, 3));
    await dropAt(bob, crowd4.at(-1), { x: to.x + 12, y: to.y - 20 });
    await landed(crowd4.at(-1), 'c5', to, `moved ${await lbl(crowd4.at(-1))} d4 → c5`, bob.pid);

    section('Item 10: Alice turns the board a quarter — nothing else moves; addresses follow; a drop snaps to a square as drawn');
    const before2 = await P.viewOf(host, 'Object.fromEntries(Object.entries(v.items).map(([k, it]) => [k, { x: it.x, y: it.y }]))');
    const empty = S.onTable({ ...C5, ...(await typeOf(host, C5.t)) }, S.spotXY(B.board.B.grid, 0, 0)), ec = await S.screenOf(host, empty.x, empty.y);
    await host.mouse.click(ec.x, ec.y);
    ok(await host.waitForFunction((id) => document.querySelector('.item.selected')?.dataset.id === id, bid, { timeout: 5000 }).then(() => true, () => false), '(a click on an empty square selects the board)');
    await host.keyboard.press('r');
    for (const [p, who] of all) ok(await P.waitView(p, 'v.items[a].rot === 90', bid), `${who}'s view: the board is turned 90°`);
    await host.keyboard.press('Escape');
    const tb = await contained(before2, bid, 'the board turned');
    const id = (await loose())[0], f3 = S.onTable(tb, S.spotXY(tb.B.grid, 5, 5));
    const pv = await dropAt(carol, id, { x: f3.x + 20, y: f3.y - 15 }, 'p3-turned-landscape');
    ok(pv?.chip?.text === 'f3', `Carol drags a stone over the turned board's f3: the chip reads "${pv?.chip?.text}"`);
    for (const [p, who] of all) ok(await P.waitView(p, 'v.items[a.id]?.at === "f3" && Math.abs(v.items[a.id].x + 25 - a.x) < 0.01 && Math.abs(v.items[a.id].y + 25 - a.y) < 0.01', { id, x: f3.x, y: f3.y }), `${who}'s view: at f3, centred on the turned square`);
    for (const [p, who] of all) {
      const want = await S.svgScreen(p, bid, S.spotXY(tb.B.grid, 5, 5)), c = await drawnAt(p, id, want);
      ok(S.dist(c, want) < 1, `${who}'s screen: the stone is drawn on f3 as the turned board's SVG draws it (${S.dist(c, want).toFixed(2)} px off)`);
    }
    await shot(host, 'p3-turned-desk');
  }

  section('Rules log lines aggregate: 250 stones spawned in one hook make one line');
  {
    const n0 = (await P.viewOf(host, 'v.log')).length;
    await say(host, 'many');
    for (const [p, who] of all) ok(await P.waitView(p, 'Object.values(v.items).filter((it) => it.t?.endsWith("/stone")).length >= 265', null, 20000), `${who}'s screen: 250 more stones`);
    await h.sleep(500);
    const lines = (await P.viewOf(host, 'v.log')).slice(n0).filter((e) => e.p === 'RULES');
    const m = lines.length === 1 && /^placed 250 pieces: (.*)$/.exec(lines[0].txt);
    ok(!!m && m[1].split(', ').filter((x) => x !== '…').length <= 8, `one Rules line: "${lines.map((e) => e.txt).join(' | ').slice(0, 120)}" (at most 8 names)`);
  }

  // ===========================================================================
  section('Attacker case 4: Mallory drags pieces she may not move — nothing is relayed');
  const M = await mallory(env, host.url(), 3), MP = 'ffffffffffffffff';
  await M.act({ t: 'hello' });
  ok(await P.waitView(host, `!!v.players['${MP}']`, null, 15000), '(Mallory, a raw peer, is at the table)');
  const v0 = await items(), stones = Object.keys(v0).filter((k) => v0[k].t?.endsWith('/stone') && v0[k].k === 'g');
  const hers = stones.filter((k) => !v0[k].owner && !v0[k].lock).sort(), alices = stones.find((k) => v0[k].owner === host.pid), locked = stones.find((k) => v0[k].lock);
  const seq0 = await P.viewOf(host, 'v.seq'), mf0 = await M.evaluate(() => window.M.got.state.length), bf0 = await bob.evaluate(() => window.__rtc.bodies.length);
  await M.act({ t: 'drag', id: alices, x: 400, y: 400 });
  await M.act({ t: 'drag', id: locked, x: 400, y: 500 });
  await M.act({ t: 'drag', ids: [alices, locked], dx: 30, dy: 30 });
  await M.act({ t: 'drag', id: hers[0], x: 444, y: 555 }); // (the control: hers to move)
  /** The live fx Mallory sent that reached the screens (Bob's bodies) and Mallory herself, since the start of the case. */
  const malFx = async () => [...S.scanLive(await bob.evaluate((n) => window.__rtc.bodies.slice(n).map((b) => b.body), bf0)), ...S.scanLive(h.bodies(await M.evaluate((n) => window.M.got.state.slice(n).map((x) => x.m), mf0)))].filter((f) => f.p === MP);
  ok(await L.until(async () => (await malFx()).some((f) => f.id === hers[0]), 8000), 'the control: her drag of a loose stone (anyone\'s to move) is relayed');
  await h.sleep(500);
  let fx = await malFx();
  ok(!fx.some((f) => f.id === alices || f.id === locked || (f.ids || []).some((x) => x === alices || x === locked)), `her drags of Alice's stone and of the locked one reach nobody, alone or as a group (${fx.length} relayed, all of ${[...new Set(fx.map((f) => f.id || f.ids.join()))].join(', ')})`);
  ok(!(await host.evaluate((ids) => ids.some((id) => window.__ct.lives()[id]), [alices, locked])), 'Alice\'s screen shows neither moving');

  section('Attacker case 7: Mallory\'s drags with wild numbers, and a group of 500 ids');
  await M.act({ t: 'drag', id: hers[1], x: 1e308, y: NaN });
  await M.act({ t: 'drag', id: hers[2], x: 'far away', y: -1e308 });
  await M.act({ t: 'drag', id: hers[3], x: -50, y: 9e9 });
  const group = [alices, locked, 'nosuchid', ...hers, ...hers].slice(0, 500);
  await M.act({ t: 'drag', ids: group, dx: 1e308, dy: 'x' });
  ok(await L.until(async () => (await malFx()).some((f) => f.ids), 8000), `(her group drag of ${group.length} ids went out)`);
  await h.sleep(800);
  fx = await malFx();
  const singles = fx.filter((f) => f.id), groups = fx.filter((f) => f.ids), TW = 3000 - 50, TH = 2000 - 50;
  ok(singles.length >= 4 && singles.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y) && f.x >= 0 && f.x <= TW && f.y >= 0 && f.y <= TH),
    `every single drag relayed carries finite numbers on the table (${singles.map((f) => `${Math.round(f.x)},${Math.round(f.y)}`).join(' ')})`);
  ok(groups.length > 0 && groups.every((f) => f.ids.length <= 200 && f.ids.every((x) => hers.includes(x)) && Number.isFinite(f.dx) && Number.isFinite(f.dy) && Math.abs(f.dx) <= 3000 && Math.abs(f.dy) <= 2000),
    `the group relayed: ${groups.map((f) => `${f.ids.length} ids (≤ 200), all hers to move, dx ${f.dx}, dy ${f.dy}`).join('; ')}`);
  // §3c: "the resulting positions [go] through clampToTable" — a group's too: every member it moves stays on the table.
  const g0 = groups[0], off = groups.length ? g0.ids.filter((x) => { const nx = v0[x].x + g0.dx, ny = v0[x].y + g0.dy; return !(nx >= 0 && nx <= TW && ny >= 0 && ny <= TH); }) : [];
  ok(groups.length > 0 && !off.length, `and the positions it gives its members are on the table (${off.length} of ${g0?.ids.length} would be off it${off.length ? `, e.g. ${off[0]} at ${v0[off[0]].x + g0.dx}, ${v0[off[0]].y + g0.dy}` : ''})`);
  ok((await P.viewOf(host, 'v.seq')) === seq0 && await P.viewOf(host, 'a.ids.every((id) => v.items[id].x === a.v[id].x && v.items[id].y === a.v[id].y)', { ids: stones, v: v0 }),
    `and the table's state never changed: the seq stands (${seq0}), every stone where it was`);

  // ===========================================================================
  // Phase 3C, play (items 3, 4, 6 and 9; spec §3g, §3b, §3c, §3h): the rules'
  // own parts on the screens of the same four players.
  const J = JSON.stringify;
  const run = (code) => L.act(host, { t: 'rulesBtn', id: 'run', code });
  for (const p of [host, bob, carol]) await record(p);

  section('3C: Alice clears the table and enables the strict "Play test" from the 📜 dialog (Reset ticked); the 📜 button says strict on every screen');
  ok((await L.act(host, { t: 'clear' })).ok, '(Alice clears the table)');
  await host.click('#rules-btn');
  await host.waitForSelector('#rules-dialog[open]');
  await host.fill('#rules-code', PLAY);
  await host.check('#rules-reset');
  await host.click('#rules-enable');
  ok(await host.waitForFunction(() => !document.querySelector('#rules-dialog[open]'), null, { timeout: 20000 }).then(() => true, () => false), `Enable closes the dialog once the rules run (${await host.textContent('#rules-err').catch(() => '')})`);
  const PLAYING = "v.rules?.enabled && v.rules.name === 'Play test' && v.table.w === 1200 && Object.values(v.items).filter((it) => it.at).length === 6 && Object.values(v.items).some((it) => it.k === 'p')";
  for (const [p, who] of all) ok(await P.waitView(p, PLAYING, null, 30000), `${who}'s screen: the board, five stones and the glue stone on their squares, and the deck`);
  for (const [p, who] of all) ok(await p.waitForFunction(() => /strict/i.test(document.getElementById('rules-btn').title), null, { timeout: 10000 }).then(() => true, () => false), `${who}'s 📜 button says the rules are strict ("${await p.getAttribute('#rules-btn', 'title')}")`);
  const pb = await boardOf(host), pt = await typeOf(host, pb.t), PB = { ...pb, ...pt };
  /** The centre of square `a` (a1 … h8) of the Play board, on the table (spec §2a's geometry, the board unturned). */
  const sqC = (a) => S.onTable(PB, S.spotXY(PB.B.grid, 'abcdefgh'.indexOf(a[0]), 8 - +a.slice(1)));
  /** The stone (or glue) standing on square `a` in page p's view. */
  const onSq = async (a, p = host) => { const v = await items(p); return Object.keys(v).find((k) => v[k].at === a && v[k].k === 'g'); };
  const ids0 = Object.fromEntries(await Promise.all(['c3', 'd4', 'e5', 'f6', 'b7', 'g2'].map(async (a) => [a, await onSq(a)])));
  ok(Object.values(ids0).every(Boolean), `the six stones stand on c3, d4, e5, f6, b7 and g2 (the glue) (${J(ids0)})`);
  ok((await run(`for (const p of [t.hostId, ${J(bob.pid)}, ${J(carol.pid)}]) t.draw(p, t.piles()[0].id, 3);`)).ok, '(the script deals three cards each to Alice, Bob and Carol)');
  for (const [p, who] of all) ok(await P.waitView(p, 'v.hand.length === 3', null, 15000), `${who} holds three cards`);

  /** What page p shows of the rules' hint: the items outlined (.hint), and the
   *  hint layers' marks — {n: how many, at: their centres (client px)}, their
   *  markup's tags and attributes (numbers only), and any text in them. */
  const hintShown = (p) => p.evaluate(() => {
    const layers = [...document.querySelectorAll('#table .hint-layer')], marks = layers.flatMap((l) => [...l.querySelectorAll('circle')]);
    const els = layers.flatMap((l) => [...l.querySelectorAll('*')]);
    return {
      items: [...document.querySelectorAll('.item.hint')].map((el) => el.dataset.id).sort(),
      layers: layers.length, inBoard: layers.some((l) => !!l.closest('.item')),
      n: marks.length, at: marks.map((c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }),
      tags: [...new Set(els.map((e) => e.tagName.toLowerCase()))].sort(),
      attrs: els.flatMap((e) => [...e.attributes].map((a) => [a.name, a.value])), text: layers.map((l) => l.textContent).join(''),
    };
  });
  /** Checks (ok) that page p (`who`) draws a hint on exactly the squares `sqs` (each mark within 2 px of its square's centre) and outlines exactly `its`. */
  async function hintOn(p, who, its, sqs) {
    let s;
    await L.until(async () => (s = await hintShown(p)).n === sqs.length && J(s.items) === J([...its].sort()), 8000, 100);
    const want = await Promise.all(sqs.map((a) => { const c = sqC(a); return S.screenOf(p, c.x, c.y); }));
    const missed = sqs.filter((a, k) => !s.at.some((m) => S.dist(m, want[k]) < 2));
    ok(s.n === sqs.length && !missed.length, `${who}: ${s.n} hint marks, on ${sqs.join(' ')}${missed.length ? ` — none on ${missed.join(' ')}` : ''}`);
    ok(J(s.items) === J([...its].sort()), `${who}: the hinted piece is outlined (.hint: ${J(s.items)})`);
    const nums = s.attrs.every(([k, v]) => (k === 'class' ? /^[a-z ]*$/.test(v) : k === 'viewBox' ? /^[-\d. ]+$/.test(v) : k === 'aria-hidden' || k === 'xmlns' || /^-?[\d.]+(e-?\d+)?$/.test(v)));
    ok(s.layers > 0 && !s.inBoard && !s.text.trim() && s.tags.every((t) => ['svg', 'circle', 'g'].includes(t)) && nums,
      `${who}: the marks are a layer of their own over the board (not in its cached SVG), numbers-only SVG (${s.tags.join(', ')}; no text)`);
  }
  /** The log lines on page p since `before` (its log as read earlier): the log keeps only its last lines, so they are what follows the line `before` ended with. */
  async function logAfter(p, before) {
    const now = await P.viewOf(p, 'v.log'), last = J(before.at(-1));
    for (let k = now.length - 1; k >= 0; k--) if (J(now[k]) === last) return now.slice(k + 1);
    return now;
  }
  const noHint = async (p) => { let s; await L.until(async () => !(s = await hintShown(p)).n && !s.items.length, 8000, 100); return !s.n && !s.items.length && !s.layers; };
  /** Every per-recipient part (hint, ask, sec) anywhere in a list of bodies (a recursive scan): [{k, v, to}]. */
  function partsIn(bodies) {
    const out = [];
    const walk = (v, to) => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, to));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (['hint', 'ask', 'sec'].includes(k) && x != null && !(Array.isArray(x) && !x.length)) out.push({ k, v: x, to }); walk(x, to); }
    };
    for (const b of bodies) walk(b, b?.to);
    return out;
  }
  const bodiesOf = (p, n) => p.evaluate((n) => window.__rtc.bodies.slice(n).map((b) => b.body), n);
  const nBodies = (p) => p.evaluate(() => window.__rtc.bodies.length);
  const malBodies = async (n) => h.bodies(await M.evaluate((n) => window.M.got.state.slice(n).map((x) => x.m), n));
  const nMal = () => M.evaluate(() => window.M.got.state.length);

  section('Item 3: Bob taps the d4 stone — `select` goes out, and his screen alone draws the hint on its eight neighbours');
  const marks0 = { bob: await nBodies(bob), carol: await nBodies(carol), mal: await nMal() }, a0 = (await acts(bob)).length;
  const D4N = ['c5', 'd5', 'e5', 'c4', 'e4', 'c3', 'd3', 'e3'], E5N = ['d6', 'e6', 'f6', 'd5', 'f5', 'd4', 'e4', 'f4'];
  await P.clickItem(bob, ids0.d4, true);
  ok(await L.until(async () => (await acts(bob)).slice(a0).some((x) => x.t === 'select' && x.id === ids0.d4), 5000), `the tap sent {t: 'select', id} (${J((await acts(bob)).slice(a0).map(({ at_, ...x }) => x))})`);
  ok(await P.waitView(bob, 'v.hint && v.hint.items.includes(a)', ids0.d4), `Bob's view holds his hint (${J(await P.viewOf(bob, 'v.hint'))})`);
  await hintOn(bob, 'Bob\'s screen', [ids0.d4], D4N);
  await shot(bob, 'p3-play-hint-phone');
  for (const [p, who] of [[host, 'Alice'], [carol, 'Carol']]) ok(await noHint(p) && (await P.viewOf(p, 'v.hint')) === null, `${who}'s screen has no .hint and no hint layer`);

  section('Item 3: Alice clicks the e5 stone — her own hint; Bob\'s stays his; Mallory\'s select hints her alone; nobody\'s body carries another\'s hint');
  await P.clickItem(host, ids0.e5);
  await hintOn(host, 'Alice\'s screen', [ids0.e5], E5N);
  ok(J(await P.viewOf(bob, 'v.hint.items')) === J([ids0.d4]), 'Bob\'s hint is still his d4 stone\'s');
  ok(await noHint(carol), 'Carol\'s screen still has none');
  await M.act({ t: 'select', id: ids0.b7 });
  ok(await L.until(async () => partsIn(await malBodies(marks0.mal)).some((x) => x.k === 'hint'), 8000), 'Mallory\'s select of the b7 stone brings her own hint, in a body bound to her');
  await h.sleep(800);
  {
    const mal = partsIn(await malBodies(marks0.mal)), bobs = partsIn(await bodiesOf(bob, marks0.bob)), carols = partsIn(await bodiesOf(carol, marks0.carol));
    ok(mal.every((x) => x.k === 'hint' && x.to === MP && J(x.v.items) === J([ids0.b7])), `Mallory's bodies carry no part but her own hint (${J(mal.map((x) => ({ k: x.k, items: x.v.items, to: x.to })))})`);
    ok(bobs.length > 0 && bobs.every((x) => x.k === 'hint' && x.to === bob.pid && J(x.v.items) === J([ids0.d4])), `Bob's bodies carry his own hint only — never Alice's e5 nor Mallory's b7 (${J(bobs.map((x) => x.v.items))})`);
    ok(!carols.length, `Carol's bodies carry no hint at all (${carols.length})`);
    const sa = await hintShown(host), sb = await hintShown(bob);
    ok(J(sa.items) === J([ids0.e5]) && sa.n === 8 && J(sb.items) === J([ids0.d4]) && sb.n === 8 && await noHint(carol), `Mallory's hint shows on no screen: Alice's outlines only her e5 stone, Bob's his d4 one, Carol's nothing (${J([sa.items, sb.items])})`);
  }

  section('Hints are cleared and restored as the engine says: a refused card play keeps Bob\'s hint, a vetoed drop too; a move clears it');
  {
    const card = await bob.evaluate(() => { const r = document.querySelector('.hcard').getBoundingClientRect(); return { x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2 }; });
    const felt = await P.feltPoint(bob, { band: [0.35, 0.75] }), m0 = await mark(bob);
    await S.gesture(bob, [card, { x: card.x, y: card.y - 30 }, { x: card.x, y: card.y - 60 }, ...S.steps({ x: card.x, y: card.y - 60 }, felt, 8), { ...felt, wait: 150 }], { touch: true, pause: 16 });
    ok(!!await waitSeen(bob, 'toast', /Not a move in this game/, m0), 'Bob drags a hand card onto the felt: strict refuses the play ("🚫 Not a move in this game")');
    ok(await P.waitView(bob, 'v.hand.length === 3', null, 8000), 'the card is back in his hand');
    await hintOn(bob, 'Bob\'s screen after the refused play', [ids0.d4], D4N);
    const m1 = await mark(bob);
    await S.dragTo(bob, ids0.d4, sqC('h8'), { touch: true, pause: 16 });
    ok(!!await waitSeen(bob, 'toast', /h8 is out of bounds/, m1), 'Bob drags the d4 stone to h8: the script\'s handle vetoes it ("🚫 h8 is out of bounds")');
    ok(await atOn(host, ids0.d4, 'd4') && await atOn(bob, ids0.d4, 'd4'), 'the stone stays on d4');
    await hintOn(bob, 'Bob\'s screen after the vetoed drop', [ids0.d4], D4N);
    await S.dragTo(bob, ids0.d4, sqC('d5'), { touch: true, pause: 16 });
    ok(await atOn(host, ids0.d4, 'd5') && await atOn(bob, ids0.d4, 'd5'), 'Bob drags it to d5: the move is played');
    ok(await noHint(bob) && (await P.viewOf(bob, 'v.hint')) === null, 'his move cleared his hint: no .hint, no layer, view.hint null');
  }

  section('Item 9: handle returns true for a drop of the glue stone and leaves it on g2 — the dropping guest sees it back within one patch, not after 1.5 s');
  /** On page p from now on, every frame for `ms`: the centre (client px) of item `id`'s element, in window.__trace as {at, x, y}. */
  const traceItem = (p, id, ms) => p.evaluate(([id, ms]) => {
    const tr = (window.__trace = []), end = performance.now() + ms;
    const f = () => {
      const r = document.querySelector(`.item[data-id="${id}"]`)?.getBoundingClientRect();
      if (r) tr.push({ at: performance.now(), x: r.left + r.width / 2, y: r.top + r.height / 2 });
      if (performance.now() < end) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }, [id, ms]);
  for (const [p, who, to] of [[bob, 'Bob (iPhone, upright)', 'g4'], [carol, 'Carol (iPhone, sideways)', 'e2']]) {
    const glue = ids0.g2, it0 = (await items())[glue], n0 = await nBodies(p), log0 = await P.viewOf(host, 'v.log');
    const home = await S.screenOf(p, it0.x + 32, it0.y + 32), T = sqC(to), drop = await S.screenOf(p, T.x, T.y), a = await S.centreOf(p, glue);
    let up = 0;
    await S.gesture(p, [...S.steps(a, drop, 10), { ...drop, wait: 150 }], { touch: true, pause: 16, mid: async () => { await traceItem(p, glue, 2600); up = await p.evaluate(() => performance.now()); } });
    await h.sleep(2800);
    const tr = (await p.evaluate(() => window.__trace)).filter((f) => f.at >= up);
    const got = await p.evaluate(([n, id]) => window.__rtc.bodies.slice(n).filter((b) => b.body.items && id in b.body.items).map((b) => ({ at: b.at, it: b.body.items[id] })), [n0, glue]);
    const patch = got.find((b) => b.at >= up), k = tr.findIndex((f, j) => tr.slice(j).every((g) => S.dist(g, home) < 1.5)), back = k >= 0 ? tr[k].at : Infinity;
    ok(tr.length > 0 && S.dist(tr[0], home) > 20, `${who}: right after the drop the glue stone is drawn where the finger let it go (${tr[0] && S.dist(tr[0], home).toFixed(0)} px from g2)`);
    ok(!!patch && patch.it.x === it0.x && patch.it.y === it0.y && patch.it.at === 'g2', `${who}: the first patch naming it after the drop (${patch ? `${(patch.at - up).toFixed(0)} ms after it` : 'none'}) has it where the script left it: g2 (${J(patch?.it && { x: patch.it.x, y: patch.it.y, at: patch.it.at })})`);
    ok(back - up < 1200, `${who}: it is drawn back on g2 ${(back - up).toFixed(0)} ms after the drop — not after the 1.5 s hold`);
    ok(!!patch && back <= patch.at + 200, `${who}: within one patch: ${(back - (patch?.at ?? 0)).toFixed(0)} ms after that patch arrived`);
    ok(await atOn(host, glue, 'g2') && (await items())[glue].x === it0.x && (await items())[glue].y === it0.y, `${who}: the host's state never moved it`);
    const lines = await logAfter(host, log0);
    ok(lines.some((e) => e.p === 'RULES' && e.txt === `the glue holds, not to ${to}`) && !lines.some((e) => /^moved /.test(e.txt)), `${who}: the log has the script's "the glue holds, not to ${to}" and no "moved" line (${J(lines.map((e) => e.txt))})`);
  }

  section('Item 6: t.secret — Bob\'s "🔒 For you" card shows his text, as text; nobody else sees it, in any body');
  const SECRET = 'Zebra-7731: you are the spy.\n<b>Trust</b> <img src=x onerror="window.__pwned=1"> no one.';
  const sm = { carol: await nBodies(carol), mal: await nMal(), bob: await nBodies(bob) };
  ok((await run(`t.secret[${J(bob.pid)}] = { text: ${J(SECRET)}, role: 'spy' };`)).ok, '(the script sets t.secret for Bob)');
  /** Page p's secret card ({head, text, tags: elements inside its text, ws, r, vw, vh}), or null while it is hidden. */
  const secretCard = (p) => p.evaluate(() => {
    const el = document.getElementById('secret'), tx = document.getElementById('secret-text');
    if (!el || el.classList.contains('hidden') || getComputedStyle(el).display === 'none' || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    return { all: el.textContent, text: tx.textContent, tags: el.querySelectorAll('#secret-text *').length, ws: getComputedStyle(tx).whiteSpace, r: { l: r.left, t: r.top, r: r.right, b: r.bottom }, vw: innerWidth, vh: innerHeight, pwned: window.__pwned ?? null };
  });
  let sc = null;
  await L.until(async () => (sc = await secretCard(bob)), 10000, 100);
  ok(sc && sc.all.includes('🔒 For you') && sc.text === SECRET, `Bob's card shows "🔒 For you" and his text exactly (${J(sc?.text)})`);
  ok(sc && !sc.tags && sc.ws === 'pre-wrap' && sc.pwned === null, `the markup in it is text (no element made of it, nothing ran), and it keeps its line break (white-space ${sc?.ws})`);
  ok(sc && sc.r.l >= 0 && sc.r.t >= 0 && sc.r.r <= sc.vw + 0.5 && sc.r.b <= sc.vh + 0.5, `the card is inside his screen (${sc && J(sc.r)})`);
  await shot(bob, 'p3-play-secret-phone');
  for (const [p, who] of [[host, 'Alice'], [carol, 'Carol']]) ok(!(await secretCard(p)) && (await P.viewOf(p, 'v.sec')) === null, `${who} has no card and no secret`);
  await h.sleep(500);
  ok((await bodiesOf(bob, sm.bob)).some((b) => b.to === bob.pid && J(b.sec || null).includes('Zebra-7731')), '(the scan\'s control: Bob\'s own bodies carry it, as `sec`)');
  ok(!J(await bodiesOf(carol, sm.carol)).includes('Zebra-7731') && !J(await malBodies(sm.mal)).includes('Zebra-7731'), 'neither Carol\'s bodies nor Mallory\'s ever carry it');

  // Item 4: every ask form, through the panel (§3g's table), on each screen.
  /** The five forms of spec §3a, for player p (one each, pending together). */
  const FIVE = (p) => `t.ask(${J(p)}, { id: 'colour', prompt: 'Pick a colour', options: ['Red', { label: 'Blue', value: { c: 'blue', n: 2 } }, 'Green'] });
    t.ask(${J(p)}, { id: 'which', prompt: 'Which stone?', pick: 'item', among: [${J(ids0.c3)}, ${J(ids0.f6)}] });
    t.ask(${J(p)}, { id: 'where', prompt: 'Where to?', pick: 'space', among: ['a1', 'h1', 'e4'] });
    t.ask(${J(p)}, { id: 'pass', prompt: 'Pass two cards', pick: 'hand', count: 2 });
    t.ask(${J(p)}, { id: 'bid', prompt: 'Your bid?', pick: 'number', min: -3, max: 3 });`;
  /** Page p's ask panel: null while hidden; else its prompt, all its text, the buttons of its form ({text, off, w, h}) and its number field's value. */
  const askPanel = (p) => p.evaluate(() => {
    const el = document.getElementById('ask'), vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
    if (!vis(el) || el.classList.contains('hidden')) return null;
    return { prompt: document.getElementById('ask-prompt').textContent, text: el.textContent, input: el.querySelector('#ask-body input')?.value ?? null,
      btns: [...el.querySelectorAll('#ask-body button')].filter(vis).map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent, off: b.disabled, w: r.width, h: r.height }; }) };
  });
  const asking = async (p, prompt, ms = 10000) => { let q = null; await L.until(async () => (q = await askPanel(p))?.prompt === prompt, ms, 100); return q?.prompt === prompt ? q : null; };
  /** Waits until onAnswer recorded player `pid`'s answer to `id` (t.public.ans); its value, or undefined. */
  async function answer(id, pid, ms = 10000) { let a; await L.until(async () => (a = (await P.viewOf(host, '(v.rules.public.ans || []).find((x) => x.id === a.id && x.p === a.p)', { id, p: pid }))), ms, 100); return a ? a.v : undefined; }
  const nAns = () => P.viewOf(host, '(v.rules.public.ans || []).length');
  /** Presses the panel's button whose text is `text` (or matches it) on page p: a click, or a tap on a touch screen. */
  async function press(p, text, touch) {
    const k = (await askPanel(p)).btns.findIndex((b) => (text instanceof RegExp ? text.test(b.text) : b.text === text));
    const b = p.locator('#ask-body button').filter({ visible: true }).nth(k);
    if (touch) await b.tap(); else await b.click();
  }
  /** Presses hand card `k` on page p by its left edge (the part a fanned hand shows). */
  async function handCard(p, k, touch) {
    const c = await p.evaluate((k) => { const el = document.querySelector(`#hand .hcard[data-idx="${k}"]`); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2 }; }, k);
    if (touch) await p.touchscreen.tap(c.x, c.y); else await p.mouse.click(c.x, c.y);
  }
  const tapAt = (p, q, touch) => (touch ? p.touchscreen.tap(q.x, q.y) : p.mouse.click(q.x, q.y));
  const okBtn = async (p) => (await askPanel(p))?.btns.find((b) => /^(Confirm|OK)/.test(b.text)) || null;

  /** Player p (`who`; `touch`: taps) answers the five forms in order, as §3g's table has it, checking each against spec §3c's answer table. */
  async function fiveForms(p, who, touch, pick) {
    const pid = p.pid, n = await nAns();
    let q = await asking(p, 'Pick a colour');
    ok(q && q.text.includes('1 of 5'), `${who}: the first of five asks shows, "1 of 5"`);
    ok(q && J(q.btns.map((b) => b.text)) === J(['Red', 'Blue', 'Green']), `${who}: options are buttons with their labels (${J(q?.btns.map((b) => b.text))})`);
    if (touch) ok(q && q.btns.every((b) => b.h >= 44 && b.w >= 44), `${who}: each option is at least 44 × 44 px on touch (${q?.btns.map((b) => `${Math.round(b.w)}×${Math.round(b.h)}`).join(', ')})`);
    await press(p, pick.colour, touch);
    ok(J(await answer('colour', pid)) === J(pick.colour === 'Blue' ? { c: 'blue', n: 2 } : pick.colour), `${who} picks ${pick.colour}: onAnswer gets ${pick.colour === 'Blue' ? 'its value {c: "blue", n: 2}' : 'the label'} (${J(await answer('colour', pid))})`);
    q = await asking(p, 'Which stone?');
    ok(q && q.text.includes('1 of 4'), `${who}: then "Which stone?", "1 of 4"`);
    ok(await L.until(async () => J(await p.evaluate(() => [...document.querySelectorAll('.item.offer')].map((el) => el.dataset.id).sort())) === J([ids0.c3, ids0.f6].sort()), 5000), `${who}: the two stones offered are highlighted while it is open, no other piece`);
    let m = await mark(p);
    await P.clickItem(p, ids0.e5, touch);
    ok(!!await waitSeen(p, 'toast', /Pick one of the highlighted pieces/, m) && (await asking(p, 'Which stone?', 500)) && (await nAns()) === n + 1, `${who} taps the e5 stone (not offered): "Pick one of the highlighted pieces", nothing answered`);
    await P.clickItem(p, ids0[pick.which], touch);
    ok(await answer('which', pid) === ids0[pick.which], `${who} taps the ${pick.which} stone: onAnswer gets its id`);
    q = await asking(p, 'Where to?');
    ok(!!q, `${who}: then "Where to?"`);
    const offered = await Promise.all(['a1', 'h1', 'e4'].map((a) => { const c = sqC(a); return S.screenOf(p, c.x, c.y); }));
    const sh = await hintShown(p);
    ok(offered.every((o) => sh.at.some((c) => S.dist(c, o) < 2)), `${who}: a1, h1 and e4 are marked while it is open (${sh.n} marks)`);
    m = await mark(p);
    const e2 = sqC('e2');
    await tapAt(p, await S.screenOf(p, e2.x, e2.y), touch);
    ok(!!await waitSeen(p, 'toast', /Pick one of the highlighted spots/, m) && (await asking(p, 'Where to?', 500)) && (await nAns()) === n + 2, `${who} taps e2 (not offered): told so, nothing answered`);
    const sp = sqC(pick.where);
    await tapAt(p, await S.screenOf(p, sp.x + 18, sp.y - 14), touch);
    ok(await answer('where', pid) === pick.where, `${who} taps near ${pick.where}: onAnswer gets "${pick.where}"`);
    q = await asking(p, 'Pass two cards');
    const hand = await P.viewOf(p, 'v.hand');
    ok(q && (await okBtn(p))?.text === 'Confirm (0/2)' && (await okBtn(p)).off, `${who}: then "Pass two cards", "Confirm (0/2)" disabled`);
    await handCard(p, pick.pass[0], touch);
    ok((await okBtn(p))?.text === 'Confirm (1/2)' && (await okBtn(p)).off, `${who} picks a card: "Confirm (1/2)", still disabled`);
    await handCard(p, pick.pass[1], touch);
    ok((await okBtn(p))?.text === 'Confirm (2/2)' && !(await okBtn(p)).off, `${who} picks a second: "Confirm (2/2)", enabled`);
    const third = [0, 1, 2].find((k) => !pick.pass.includes(k));
    await handCard(p, third, touch);
    ok((await okBtn(p))?.text === 'Confirm (3/2)' && (await okBtn(p)).off, `${who} picks a third: "Confirm (3/2)", disabled again — only exactly 2 (${(await okBtn(p))?.text})`);
    await handCard(p, third, touch);
    ok((await okBtn(p))?.text === 'Confirm (2/2)' && !(await okBtn(p)).off, `${who} lets it go: "Confirm (2/2)"`);
    await press(p, /^Confirm/, touch);
    const v = await answer('pass', pid), want = pick.pass.map((k) => ({ d: hand[k].d, i: hand[k].i }));
    const key = (l) => J((l || []).map((c) => `${c.d}:${c.i}`).sort());
    ok(key(v) === key(want) && v.every((c) => J(Object.keys(c).sort()) === J(['d', 'i'])), `${who}: onAnswer gets those two cards as {d, i} (${J(v)})`);
    ok(await P.waitView(p, 'v.hand.length === 3', null, 5000), `${who}: they stay in the hand`);
    q = await asking(p, 'Your bid?');
    ok(!!q && q.input !== null && +q.input >= -3 && +q.input <= 3, `${who}: then "Your bid?", a number field within [−3, 3] (${q?.input})`);
    await press(p, /^[−-]$/, touch);
    await press(p, /^[−-]$/, touch);
    await press(p, /^[−-]$/, touch);
    await press(p, /^[−-]$/, touch);
    ok((await askPanel(p))?.input === '-3', `${who}: − stops at the min, −3 (${(await askPanel(p))?.input})`);
    for (let k = 0; k < 7; k++) await press(p, '+', touch);
    ok((await askPanel(p))?.input === '3', `${who}: + stops at the max, 3 (${(await askPanel(p))?.input})`);
    await p.fill('#ask-body input', '9');
    ok((await okBtn(p))?.off === true, `${who} types 9: OK is disabled (out of range, shown before anything is sent)`);
    await p.fill('#ask-body input', String(pick.bid));
    ok((await okBtn(p))?.off === false, `${who} types ${pick.bid}: OK is enabled`);
    await press(p, 'OK', touch);
    ok(await answer('bid', pid) === pick.bid, `${who}: onAnswer gets the integer ${pick.bid} (${J(await answer('bid', pid))})`);
    ok(await L.until(async () => !(await askPanel(p)), 5000), `${who}: no ask left — the panel goes`);
  }

  section('Item 4, desktop: Alice answers every form with the mouse — options, a piece, a spot, two hand cards, a number');
  ok((await run(FIVE(host.pid))).ok, '(the script asks Alice five questions)');
  ok(!!await asking(host, 'Pick a colour'), 'Alice\'s panel shows the first');
  await shot(host, 'p3-play-ask-desk');
  await fiveForms(host, 'Alice', false, { colour: 'Blue', which: 'f6', where: 'e4', pass: [0, 1], bid: 2 });

  section('Item 4, iPhone 13 upright: Bob answers every form with taps');
  ok((await run(FIVE(bob.pid))).ok, '(the script asks Bob the same five)');
  ok(!!await asking(bob, 'Pick a colour'), 'Bob\'s panel shows the first');
  for (const [p, who] of [[host, 'Alice'], [carol, 'Carol']]) ok(!(await askPanel(p)), `${who}'s screen shows no panel: the asks are Bob's`);
  await shot(bob, 'p3-play-ask-phone');
  await fiveForms(bob, 'Bob', true, { colour: 'Green', which: 'c3', where: 'a1', pass: [2, 0], bid: -1 });

  section('Item 4, iPhone 13 sideways: Carol\'s prompt and options carry markup — the panel shows it as text');
  const HTML = { prompt: 'Who <b>wins</b>? <img src=x onerror="window.__pwned=2">', a: '<b onclick=x>Me</b>', b: '<img src=x onerror=__pwned=4>' };
  ok((await run(`t.ask(${J(carol.pid)}, { id: 'html', prompt: ${J(HTML.prompt)}, options: [${J(HTML.a)}, ${J(HTML.b)}] });`)).ok, '(the script asks Carol a question written in markup)');
  {
    const q = await asking(carol, HTML.prompt);
    const made = await carol.evaluate(() => ({ els: document.querySelectorAll('#ask img, #ask b, #ask script').length, pwned: window.__pwned ?? null }));
    ok(!!q && J(q.btns.map((b) => b.text)) === J([HTML.a, HTML.b]), `Carol's panel shows the prompt and both labels as typed (${J(q?.btns.map((b) => b.text))})`);
    ok(!made.els && made.pwned === null, `no element is made of them, nothing ran (${J(made)})`);
    await shot(carol, 'p3-play-ask-landscape');
    await press(carol, HTML.b, true);
    ok(await answer('html', carol.pid) === HTML.b, 'her tap on the second answers it: its label, as text');
  }

  section('The panel\'s place: on the desktop, the upright and the sideways iPhone — inside the screen, never over the table, the turn cue, the watchers or a seat label');
  /** Page p's layout, two frames on (as painted): the panel, its card and option buttons, the turn cue, the watchers' box, the seat labels, the table area, the hand bar and the viewport (client rects). */
  const layoutOf = (p) => p.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0 && !el.classList.contains('hidden');
    const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const one = (id) => { const el = document.getElementById(id); return vis(el) ? R(el) : null; };
    return { ask: one('ask'), card: one('ask-card'), opts: [...document.querySelectorAll('#ask-body button')].filter(vis).map(R), cue: one('turn-cue'), watch: [...document.querySelectorAll('#watch-box > *')].filter(vis).map(R),
      seats: [...document.querySelectorAll('.seat')].filter(vis).map((el) => ({ ...R(el), txt: el.textContent })), table: one('table-wrap'), hand: one('hand-bar'), vw: innerWidth, vh: innerHeight };
  });
  ok((await L.act(carol, { t: 'seat', watch: true })).ok && await P.waitView(host, 'v.players[a].seat == null', carol.pid), '(Carol stands up to watch: the watchers\' box shows)');
  ok((await run(`t.public.turn = [t.hostId, ${J(bob.pid)}, ${J(carol.pid)}]; for (const p of t.public.turn) t.ask(p, { id: 'lay', prompt: 'Ready to go on?', options: ['Yes', 'No'] });`)).ok, '(the script makes it everyone\'s turn, and asks each "Ready to go on?")');
  for (const [p, who, touch] of [[host, 'Alice, desktop 1280 × 800', false], [bob, 'Bob, iPhone 13 upright', true], [carol, 'Carol, iPhone 13 sideways', true]]) {
    ok(!!await asking(p, 'Ready to go on?') && await p.waitForFunction(() => !document.getElementById('turn-cue').classList.contains('hidden'), null, { timeout: 5000 }).then(() => true, () => false), `${who}: the ask shows, and the turn cue with it`);
    const Lo = await layoutOf(p), clash = [];
    if (Lo.cue && overlap(Lo.ask, Lo.cue)) clash.push('the turn cue');
    if (Lo.watch.some((w) => overlap(Lo.ask, w))) clash.push('the watchers\' box');
    for (const s of Lo.seats) if (overlap(Lo.ask, s)) clash.push(`the seat label "${s.txt}"`);
    ok(!!Lo.ask && Lo.ask.l >= -0.5 && Lo.ask.t >= -0.5 && Lo.ask.r <= Lo.vw + 0.5 && Lo.ask.b <= Lo.vh + 0.5, `${who}: the panel is inside the viewport (${J(Lo.ask)} in ${Lo.vw} × ${Lo.vh})`);
    ok(!!Lo.cue && Lo.watch.length > 0 && Lo.seats.length >= 2, `${who}: (the turn cue, the watchers' box and ${Lo.seats.length} seat labels are on screen)`);
    ok(!clash.length, `${who}: it covers ${clash.join(', ') || 'none of them'}`);
    ok(!!Lo.table && !overlap(Lo.ask, Lo.table), `${who}: it is never over the table: the table area ends above it (${J(Lo.table)})`);
    if (touch) {
      ok(!!Lo.hand && Lo.ask.b <= Lo.hand.t + 0.5, `${who}: a bottom sheet above the hand bar (${Lo.ask.b.toFixed(1)} ≤ ${Lo.hand?.t.toFixed(1)})`);
      ok(Lo.opts.length === 2 && Lo.opts.every((b) => b.b - b.t >= 44 && b.r - b.l >= 44), `${who}: its buttons are at least 44 px (${Lo.opts.map((b) => `${Math.round(b.r - b.l)}×${Math.round(b.b - b.t)}`).join(', ')})`);
    } else ok(!!Lo.card && Math.abs((Lo.card.l + Lo.card.r) / 2 - Lo.vw / 2) < 2 && Lo.card.r - Lo.card.l <= 720, `${who}: a centred card, at most 720 px wide (${J(Lo.card)})`);
    await shot(p, `p3-play-layout-${touch ? (p === bob ? 'phone' : 'landscape') : 'desk'}`);
  }
  for (const [p, who, touch] of [[host, 'Alice', false], [bob, 'Bob', true], [carol, 'Carol', true]]) { await press(p, 'Yes', touch); ok(await answer('lay', p.pid) === 'Yes', `${who} answers "Yes"`); }
  ok((await L.act(carol, { t: 'seat', sit: true })).ok && await P.waitView(host, 'v.players[a].seat != null', carol.pid), '(Carol sits down again)');
  {
    const mal = partsIn(await malBodies(marks0.mal)), carols = partsIn(await bodiesOf(carol, marks0.carol)), bobs = partsIn(await bodiesOf(bob, marks0.bob));
    ok(!mal.some((x) => x.k === 'ask') && !/Pick a colour|Ready to go on|Who <b>wins/.test(J(await malBodies(marks0.mal))), 'no ask, and no prompt of anyone\'s, ever reached Mallory\'s bodies');
    ok(carols.some((x) => x.k === 'ask') && carols.every((x) => x.to === carol.pid) && !J(carols).includes('Pick a colour'), 'Carol\'s bodies carry her own asks alone, bound to her — never Alice\'s or Bob\'s');
    ok(bobs.filter((x) => x.k === 'ask').every((x) => x.to === bob.pid && !J(x.v).includes('Who <b>wins')), 'Bob\'s carry his own alone');
  }

  section('Answer validation is the host\'s too: forged answers of every form, an unknown id and Mallory\'s answer to Bob\'s ask are refused, no hook runs, the ask stays');
  ok((await run(`t.public.turn = null; t.ask(${J(bob.pid)}, { id: 'v-opt', prompt: 'Heads or tails?', options: ['Heads', 'Tails'] });
    t.ask(${J(bob.pid)}, { id: 'v-item', prompt: 'Which one?', pick: 'item', among: [${J(ids0.c3)}] });
    t.ask(${J(bob.pid)}, { id: 'v-space', prompt: 'Which spot?', pick: 'space', among: ['a1'] });
    t.ask(${J(bob.pid)}, { id: 'v-hand', prompt: 'Two cards?', pick: 'hand', count: 2 });
    t.ask(${J(bob.pid)}, { id: 'v-num', prompt: 'How many?', pick: 'number', min: 1, max: 3 });`)).ok, '(the script asks Bob five more)');
  ok(!!await asking(bob, 'Heads or tails?'), 'Bob\'s panel shows "Heads or tails?"');
  {
    const hand = await P.viewOf(bob, 'v.hand'), c = (k) => ({ idx: k, d: hand[k].d, i: hand[k].i }), n0 = await nAns();
    const other = Array.from({ length: 52 }, (_, i) => i).find((i) => !hand.some((x) => x.d === hand[1].d && x.i === i)); // (a card of that deck he doesn't hold)
    const FORGED = [
      ['v-opt', 2, 'an option index past the end'], ['v-opt', -1, 'a negative index'], ['v-opt', 'Heads', 'a label, not an index'], ['v-opt', 0.5, 'a fraction'],
      ['v-item', ids0.e5, 'a piece not among those offered'], ['v-item', 'nosuchid', 'no such piece'],
      ['v-space', 'b2', 'a spot not offered'], ['v-space', 'zz9', 'no such spot'],
      ['v-hand', [c(0)], 'one card of two'], ['v-hand', [c(0), c(0)], 'the same card twice'], ['v-hand', [c(0), { idx: 1, d: hand[1].d, i: other }], 'a card not in his hand'],
      ['v-num', 4, 'past the max'], ['v-num', 0, 'under the min'], ['v-num', 2.5, 'a fraction'], ['nope', 0, 'an id no ask has'],
    ];
    for (const [id, v, what] of FORGED) {
      const m = await mark(bob);
      await L.act(bob, { t: 'answer', id, v });
      ok(!!await waitSeen(bob, 'toast', /That answer wasn't offered/, m), `Bob's client forges ${id} = ${J(v)} (${what}): "🚫 That answer wasn't offered"`);
      await h.sleep(250); // (notices: 10, then 5 a second)
    }
    const mn = await M.evaluate(() => window.M.got.note.length);
    await M.act({ t: 'answer', id: 'v-opt', v: 0 });
    ok(await L.until(async () => (await M.evaluate((n) => window.M.notes().slice(n).map((x) => x.msg || ''), mn)).some((x) => /wasn't offered/.test(x)), 8000), 'Mallory answers Bob\'s v-opt (an ask that isn\'t hers): refused');
    await h.sleep(500);
    ok((await nAns()) === n0, `no onAnswer ran for any of them (${(await nAns()) - n0} answers recorded)`);
    const q = await askPanel(bob);
    ok(q?.prompt === 'Heads or tails?' && q.text.includes('1 of 5'), `Bob's ask stays, with all five pending ("${q?.prompt}", ${q?.text.match(/1 of \d/)?.[0]})`);
    await L.act(bob, { t: 'answer', id: 'v-opt', v: 1 });
    ok(await answer('v-opt', bob.pid) === 'Tails', '(the control: the same path with an offered index, 1, answers "Tails")');
    ok((await run(`t.cancelAsk(${J(bob.pid)});`)).ok && await L.until(async () => !(await askPanel(bob)), 8000), '(the script withdraws the rest: Bob\'s panel goes)');
  }

  section('Item 4: a host reload mid-ask brings the prompts back (they persist); Bob\'s hint does not survive it (never saved), his secret does');
  ok((await run(`t.ask(t.hostId, { id: 'rl-a', prompt: 'Keep or swap?', options: ['Keep', 'Swap'] }); t.ask(${J(bob.pid)}, { id: 'rl-b', prompt: 'How far?', pick: 'number', min: 1, max: 9 });`)).ok, '(the script asks Alice and Bob)');
  ok(!!await asking(host, 'Keep or swap?') && !!await asking(bob, 'How far?'), 'both prompts show');
  await bob.tap('#secret-head'); // (folded: on his upright phone the card stands over the board's near rows)
  const top = await bob.evaluate((id) => { const r = document.querySelector(`.item[data-id="${id}"]`).getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.item')?.dataset.id === id; }, ids0.e5);
  ok(top, 'Bob folds his 🔒 card: the e5 stone is what his finger meets');
  await P.clickItem(bob, ids0.e5, true);
  await hintOn(bob, 'Bob\'s screen before the reload', [ids0.e5], E5N);
  const boot0 = await P.viewOf(bob, 'v.boot');
  await host.reload();
  ok(await host.waitForFunction(() => window.__ct?.view().seq > 0 && window.__ct.view().rules?.enabled && window.__ct.jobs() === 0, null, { timeout: 30000 }).then(() => true, () => false), 'Alice reloads the host tab: the saved rules run again');
  await record(host);
  ok(await P.waitView(bob, 'v.boot !== a && v.seq > 0', boot0, 30000), 'Bob\'s screen has the reloaded host\'s table');
  ok(!!await asking(host, 'Keep or swap?', 15000), 'Alice\'s prompt is back on her screen');
  ok(!!await asking(bob, 'How far?', 15000), 'Bob\'s is on his');
  ok(await noHint(bob) && (await P.viewOf(bob, 'v.hint')) === null, 'Bob\'s hint is gone: hints are never saved (§3a)');
  ok((await secretCard(bob))?.text === SECRET, 'his 🔒 For you card still holds his secret (it persists)');
  await press(host, 'Swap', false);
  ok(await answer('rl-a', host.pid) === 'Swap', 'Alice answers "Swap" after the reload: onAnswer gets it');
  await bob.fill('#ask-body input', '7');
  await press(bob, 'OK', true);
  ok(await answer('rl-b', bob.pid) === 7, 'Bob answers 7: onAnswer gets it');

  await env.done();
})().catch(h.crash);
