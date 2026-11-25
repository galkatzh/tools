// Phase 2 performance budgets in Node (spec §2k): B9, a `roll` of 20 dice —
// host apply ≤ 2 ms, and the patch ≤ 3 KB per peer — then Phase 1's Node
// budgets B5, B1, B2 and B7 again, on pieces (t-p1-bench.js re-runs the
// browser ones). It runs on the 1,000-piece table of §2k (the `bench` box: a
// 40 × 25 board, 600 tokens, 250 tiles, 50 dice, 60 supplies, 39 bags, loaded
// with loadBox {setup, clear}), with 8 guests. A patch is measured as B1
// measures it (core-p1-bench): the sealed body as it goes on the wire,
// JSON-escaped. run-all.sh runs this
// file on its own after the parallel batch (its SERIAL list): timings taken
// on a loaded machine would mean nothing. Seeded: SEED=n replays a run.
import { core, ok, section, report, crash, seeds, rng, quantile, keyOf, HOST } from './node-lib.mjs';

const { createTable, PROTO, spliceBody, sealText } = core;
/** 8 seated guests: player ids, and peer ids shaped like Trystero's (20 characters). */
const GUESTS = Array.from({ length: 8 }, (_, k) => ({ pid: String(k + 1).repeat(16), tp: `peer${k + 1}`.padEnd(20, 'x') }));
const range = (n) => Array.from({ length: n }, (_, k) => k);
/** §2k's bench box: 1,000 pieces on a 6000 × 4000 table. */
const BENCH = {
  name: 'Bench', imgs: [], table: { shape: 'rect', w: 6000, h: 4000 },
  backs: { tb: { face: { color: '#345678' } } },
  types: {
    map: { kind: 'board', name: 'Map', w: 4000, h: 2500, board: { grid: { type: 'square', cols: 40, rows: 25, cell: 100, x: 0, y: 0, draw: 'lines' } } },
    tok: { kind: 'token', name: 'Token', faces: ['A', 'B', 'C'] },
    tile: { kind: 'tile', name: 'Tile', back: 'tb', faces: ['T1', 'T2'] },
    die: { kind: 'die', name: 'Die' },
    chip: { kind: 'token', name: 'Chip', faces: [{ color: '#cc0000' }] },
    pawn: { kind: 'token', name: 'Pawn', shape: 'pawn', hand: true, faces: [{ color: '#00aa00' }] },
  },
  setup: [
    { piece: 'map', at: 'center' },
    ...range(3).map((k) => ({ piece: 'tok', at: [1100, 800 + 100 * k], count: 200, spread: [18, 0] })),
    { piece: 'tile', at: [1100, 1200], count: 200, spread: [18, 0], up: false },
    { piece: 'tile', at: [1100, 1350], count: 50, spread: [60, 0] },
    { piece: 'die', at: [1100, 1550], count: 50, spread: [60, 0] },
    ...range(60).map((k) => ({ supply: k % 2 ? 'chip' : 'pawn', at: [1100 + 60 * k, 1700] })),
    ...range(39).map((k) => ({ bag: ['tok', 'tok', { t: 'tile', up: false }], name: `Bag ${k}`, at: [1100 + 95 * k, 1850] })),
  ],
};
/** B7's synthetic hook: 400 t.item(id) and 50 t.find({kind: 'die'}). */
const READS = `({
  name: 'Bench reads',
  buttons: () => [{ id: 'read', label: 'Read' }],
  onButton(t) {
    const ids = t.data.ids;
    let items = 0, dice = 0;
    for (let k = 0; k < 400; k++) if (t.item(ids[k % ids.length])) items++;
    for (let k = 0; k < 50; k++) dice += t.find({ kind: 'die' }).length;
    t.data.got = { items, dice };
  },
})`;
const ms = (x) => `${x.toFixed(3)} ms`;

(async () => {
  for (const seed of seeds([1])) {
    const r = rng(seed);
    let clock = 1.7e12, n = 0;
    const T = createTable({ v: 3, table: { shape: 'round', w: 1300, h: 1300 } }, { pid: HOST, now: () => (clock += 250), random: rng(seed ^ 0x5eed), uid: () => (++n).toString(16).padStart(8, '0') }), s = T.state;
    T.open('Alice');
    for (const g of GUESTS) T.join(g.pid, `Guest ${g.pid[0]}`, keyOf(g.pid));
    T.apply(HOST, { t: 'loadBox', box: BENCH, setup: true, clear: true });
    const all = Object.values(s.items), bx = s.lastSetup, kind = (it) => it.k === 'g' && s.boxes[bx]?.types[it.t.split('/')[1]]?.kind;
    const dice = Object.keys(s.items).filter((id) => kind(s.items[id]) === 'die');
    section(`the 1,000-piece table of §2k (seed ${seed})`);
    ok(all.length === 1000 && dice.length === 50 && all.filter((it) => it.k === 's').length === 60 && all.filter((it) => it.k === 'b').length === 39
      && all.filter((it) => kind(it) === 'token').length === 600 && all.filter((it) => kind(it) === 'tile').length === 250 && all.filter((it) => kind(it) === 'board').length === 1,
      `1 board, 600 tokens, 250 tiles, 50 dice, 60 supplies, 39 bags (${all.length} items), 8 guests`);
    T.takeDirty();
    T.drain();
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64');
    const sync = new Map(GUESTS.map((g) => [g, s.seq]));

    section('B9: a roll of 20 dice — host apply ≤ 2 ms (p95 of 200, after 20 to warm up), patch ≤ 3 KB per peer');
    const applyMs = [], tickMs = [], sizes = [], plain = [];
    let wrong = 0;
    for (let k = 0; k < 220; k++) {
      const ids = [...dice].sort(() => r() - 0.5).slice(0, 20), who = r.pick(GUESTS).pid;
      const t0 = performance.now();
      const changed = T.apply(who, { t: 'roll', ids });
      const t1 = performance.now();
      const d = T.takeDirty(), content = T.patchContent(d), fx = [], ann = [];
      for (const e of T.drain()) { if (e.t === 'fx') fx.push(e.f); else if (e.t === 'ann') ann.push(e.msg); }
      if (fx.length) content.fx = fx;
      if (ann.length) content.ann = ann;
      const shared = JSON.stringify({ v: PROTO, boot: 1.7e12, seq: s.seq, host: HOST, kind: 'patch', ...content });
      const texts = GUESTS.map((g) => {
        const text = spliceBody({ to: g.pid, tp: g.tp, base: sync.get(g), ...(d.hands.has(g.pid) ? { hand: s.players[g.pid].hand } : {}) }, shared);
        sync.set(g, s.seq);
        return text;
      });
      const sealing = texts.map((text) => sealText(text, kp.privateKey, pub));
      const t2 = performance.now(); // the synchronous part: the signing runs on after it
      const sealed = await Promise.all(sealing);
      if (!changed || Object.keys(content.items || {}).length !== 20 || content.log?.length !== 1) wrong++;
      if (k < 20) continue;
      applyMs.push(t1 - t0);
      tickMs.push(t2 - t0);
      sizes.push(...sealed.map((x) => JSON.stringify(x).length));
      plain.push(...texts.map((x) => x.length));
    }
    const p95 = quantile(applyMs, 0.95), max = Math.max(...sizes);
    console.log(`    host apply median ${ms(quantile(applyMs, 0.5))}, p95 ${ms(p95)}; whole tick (apply, patch, 8 splices and seals) p95 ${ms(quantile(tickMs, 0.95))}`);
    console.log(`    per-peer patch: sealed max ${max} B, mean ${Math.round(sizes.reduce((a, b) => a + b) / sizes.length)} B; unsealed body max ${Math.max(...plain)} B`);
    ok(!wrong, `every roll changed the table and its patch carried exactly the 20 dice and one log line (${wrong} did not)`);
    ok(p95 <= 2, `B9: host apply of a 20-dice roll takes ${ms(p95)} p95 (≤ 2 ms) — seed ${seed}`);
    ok(max <= 3 * 1024, `B9: every sealed per-peer patch is ≤ 3 KB on the wire object (max ${max} B over ${sizes.length}) — seed ${seed}`);

    // §2k: B1, B2, B5 and B7 again, measured as core-p1-bench measures them, on the 1,000 pieces.
    const tokens = Object.keys(s.items).filter((id) => kind(s.items[id]) === 'token'), pawns = Object.keys(s.items).filter((id) => s.items[id].k === 's' && s.items[id].t.endsWith('/pawn'));
    for (const g of GUESTS) for (let k = 0; k < 4; k++) T.apply(g.pid, { t: 'take', id: pawns[k], hand: true });
    for (let k = 0; k < 100; k++) T.apply(HOST, { t: 'chat', msg: `round ${k}: your move — the dice are hot tonight ${'·'.repeat(r.int(20))}` });
    T.takeDirty();
    T.drain();
    const head = () => ({ v: PROTO, boot: 1.7e12, seq: s.seq, host: HOST });
    const move = () => T.apply(r.pick(GUESTS).pid, { t: 'move', id: r.pick(tokens), x: 1100 + r() * 3700, y: 900 + r() * 2200 });
    ok(tokens.length === 600 && GUESTS.every((g) => s.players[g.pid].hand.length === 4) && Object.keys(s.items).length === 1000,
      `(600 tokens to move; each guest holds 4 pawns taken from a supply; ${s.log.length} log entries)`);

    section('§2k B5: a snapshot of the 1,000-piece table is ≤ 160 KB of JSON, built in ≤ 15 ms (p95 of 40)');
    const snapMs = [];
    let snapBytes = 0;
    for (let k = 0; k < 45; k++) {
      move(); // a tick's worth of change before each
      const t0 = performance.now(), g = GUESTS[k % 8];
      T.takeDirty();
      const shared = JSON.stringify({ ...head(), kind: 'snap', ...T.snapContent(), fx: [], ann: [] });
      const body = spliceBody({ to: g.pid, tp: g.tp, hand: s.players[g.pid].hand }, shared), sealing = sealText(body, kp.privateKey, pub);
      const dt = performance.now() - t0;
      await sealing;
      T.drain();
      if (k >= 5) snapMs.push(dt); // the first five warm the JIT
      snapBytes = Math.max(snapBytes, body.length);
    }
    const snapP95 = quantile(snapMs, 0.95);
    console.log(`    largest snapshot ${(snapBytes / 1024).toFixed(1)} KB; build median ${ms(quantile(snapMs, 0.5))}, p95 ${ms(snapP95)}`);
    ok(snapBytes <= 160 * 1024, `B5: the snapshot body is ${(snapBytes / 1024).toFixed(1)} KB (≤ 160 KB), with the log and a hand — seed ${seed}`);
    ok(snapP95 <= 15, `B5: built (takeDirty, snapContent, one serialization, the splice, the seal started) in ${ms(snapP95)} p95 (≤ 15 ms) — seed ${seed}`);

    section('§2k B1 and B2: one piece move, patched to 8 recipients (200 moves, after 20 to warm up)');
    for (const g of GUESTS) sync.set(g, s.seq);
    const moveMs = [], moveSizes = [];
    let wide = 0; // moves whose patch carried more than the moved piece
    for (let k = 0; k < 220; k++) {
      const t0 = performance.now();
      move();
      const d = T.takeDirty(), content = T.patchContent(d), fx = [], ann = [];
      for (const e of T.drain()) { if (e.t === 'fx') fx.push(e.f); else if (e.t === 'ann') ann.push(e.msg); }
      if (fx.length) content.fx = fx;
      if (ann.length) content.ann = ann;
      const shared = JSON.stringify({ ...head(), kind: 'patch', ...content });
      const sealing = GUESTS.map((g) => {
        const text = spliceBody({ to: g.pid, tp: g.tp, base: sync.get(g), ...(d.hands.has(g.pid) ? { hand: s.players[g.pid].hand } : {}) }, shared);
        sync.set(g, s.seq);
        return sealText(text, kp.privateKey, pub);
      });
      const dt = performance.now() - t0; // the synchronous part: the signing runs on after it
      const sealed = await Promise.all(sealing);
      if (k < 20) continue;
      moveMs.push(dt);
      wide += Object.keys({ ...content.items, ...content.pos }).length !== 1; // (a moved piece travels as its new place, in pos: D233)
      moveSizes.push(...sealed.map((x) => JSON.stringify(x).length));
    }
    const b1 = Math.max(...moveSizes), b2 = quantile(moveMs, 0.95);
    console.log(`    sealed patch per move per peer: mean ${Math.round(moveSizes.reduce((a, b) => a + b) / moveSizes.length)} B, max ${b1} B; host tick median ${ms(quantile(moveMs, 0.5))}, p95 ${ms(b2)}`);
    ok(!wide, `each move's patch carries exactly one piece (${wide} did not)`);
    ok(b1 <= 1024, `B1: every sealed single-piece patch is ≤ 1,024 B on the wire object (max ${b1} B over ${moveSizes.length}) — seed ${seed}`);
    ok(b2 <= 5, `B2: host apply, takeDirty, the shared patch and 8 splices and seals take ${ms(b2)} p95 (≤ 5 ms) — seed ${seed}`);

    section('§2k B7: 400 t.item(id) and 50 t.find({kind: "die"}) in one hook take ≤ 20 ms (p95 of 20)');
    T.apply(HOST, { t: 'setRules', enabled: true, code: READS });
    T.api.data.ids = Array.from({ length: 400 }, () => r.pick(Object.keys(s.items)));
    const hookMs = [];
    for (let k = 0; k < 23; k++) {
      const t0 = performance.now();
      T.apply(HOST, { t: 'rulesBtn', id: 'read' });
      if (k >= 3) hookMs.push(performance.now() - t0);
    }
    const got = T.api.data.got, b7 = quantile(hookMs, 0.95);
    console.log(`    the whole rulesBtn action: median ${ms(quantile(hookMs, 0.5))}, p95 ${ms(b7)}`);
    ok(got?.items === 400 && got.dice === 50 * 50 && s.rules.enabled, `the hook read 400 items and the 50 dice 50 times, without error (${JSON.stringify(got)})`);
    ok(b7 <= 20, `B7: ${ms(b7)} p95 for the action that runs the hook (≤ 20 ms) — seed ${seed}`);
  }
  report();
})().catch(crash);
