// Phase 1 performance budgets in Node (spec §1k: B1, B2, B5 and B7). They
// run on the 1,000-card table of §1k, with 8 recipients. Each budget is
// asserted, so a regression fails the run. run-all.sh runs this file on its
// own after the parallel batch (its SERIAL list): timings taken on a loaded
// machine would mean nothing. Seeded: SEED=n replays a run.
import { core, ok, section, report, crash, seeds, rng, env, quantile, keyOf, HOST } from './node-lib.mjs';

const { createTable, PROTO, spliceBody, sealText, playR, CARD_W, CARD_H } = core;
/** 8 seated guests: player ids, and peer ids shaped like Trystero's (20 characters). */
const GUESTS = Array.from({ length: 8 }, (_, k) => ({ pid: String(k + 1).repeat(16), tp: `peer${k + 1}`.padEnd(20, 'x') }));
/** §1k: a throwaway script whose setup adds 20 standard decks and deals
 *  1,000 cards face up in a grid inside PLAY_R. It then deals each player 4
 *  cards, so every snapshot carries a hand. */
const SETUP = `({
  name: 'Bench setup',
  setup(t) {
    const g = t.geom(), piles = [];
    for (let k = 0; k < 20; k++) piles.push(t.addStandardDeck({ x: g.cx - 50, y: g.cy - 70 }));
    for (let n = 0; n < 1000; n++) {
      const col = n % 40, row = Math.floor(n / 40);
      t.deal(piles[Math.floor(n / 52)], { x: g.cx - 50 + (col - 19.5) * 37, y: g.cy - 70 + (row - 12) * 58, up: true });
    }
    t.dealToAll(piles[19], 4);
  },
})`;
/** B7's synthetic hook: 400 t.item(id) and 50 t.find({kind: 'pile'}). */
const READS = `({
  name: 'Bench reads',
  buttons: () => [{ id: 'read', label: 'Read' }],
  onButton(t) {
    const ids = t.data.ids;
    let items = 0, piles = 0;
    for (let k = 0; k < 400; k++) if (t.item(ids[k % ids.length])) items++;
    for (let k = 0; k < 50; k++) piles += t.find({ kind: 'pile' }).length;
    t.data.got = { items, piles };
  },
})`;
const ms = (x) => `${x.toFixed(3)} ms`;

(async () => {
  for (const seed of seeds([1])) {
    const r = rng(seed), E = env(seed), T = createTable({}, E), s = T.state;
    T.open('Alice');
    for (const g of GUESTS) T.join(g.pid, `Guest ${g.pid[0]}`, keyOf(g.pid));
    T.apply(HOST, { t: 'size', size: 2400 });
    T.apply(HOST, { t: 'setRules', enabled: true, code: SETUP });
    T.apply(HOST, { t: 'setRules', enabled: false });
    const cards = Object.keys(s.items).filter((id) => s.items[id].k === 'c'), piles = Object.keys(s.items).filter((id) => s.items[id].k === 'p');
    const inside = cards.every((id) => Math.hypot(s.items[id].x + CARD_W / 2 - 1200, s.items[id].y + CARD_H / 2 - 1200) < playR(2400));
    section(`the 1,000-card table (seed ${seed})`);
    ok(cards.length === 1000 && cards.every((id) => s.items[id].up) && inside && GUESTS.every((g) => s.players[g.pid].hand.length === 4),
      `1,000 loose face-up cards inside PLAY_R on a large table, ${piles.length} piles, 8 guests holding 4 cards each (${Object.keys(s.items).length} items)`);
    // A long game's log: every bucket full (the deals filled the actions).
    for (let k = 0; k < 100; k++) T.apply(HOST, { t: 'chat', msg: `round ${k}: nice hand, who's dealing the next one? ${'·'.repeat(r.int(20))}` });
    for (let k = 0; k < 50; k++) T.apply(GUESTS[k % 8].pid, { t: 'peek', id: piles[0] });
    T.takeDirty();
    T.drain();
    ok(s.log.length === 350, `a long game's log: all three buckets full (${s.log.length} entries)`);
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64');
    const head = () => ({ v: PROTO, boot: 1.7e12, seq: s.seq, host: HOST });
    const move = () => T.apply(r.pick(GUESTS).pid, { t: 'move', id: r.pick(cards), x: 160 + r() * 2000, y: 160 + r() * 2000 });

    section('B5: a snapshot at 1,000 items is ≤ 160 KB of JSON, built in ≤ 15 ms (p95 of 40)');
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
    ok(snapBytes <= 160 * 1024, `B5: the snapshot body is ${(snapBytes / 1024).toFixed(1)} KB (≤ 160 KB), with the whole log and a hand — seed ${seed}`);
    ok(snapP95 <= 15, `B5: built (takeDirty, snapContent, one serialization, the splice, the seal started) in ${ms(snapP95)} p95 (≤ 15 ms) — seed ${seed}`);

    section('B1 and B2: one move, patched to 8 recipients (200 moves, after 20 to warm up)');
    const sync = new Map(GUESTS.map((g) => [g, s.seq]));
    const tickMs = [], sizes = [];
    let wide = 0; // moves whose patch carried more than the moved item
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
      tickMs.push(dt);
      wide += Object.keys({ ...content.items, ...content.pos }).length !== 1; // (a moved item travels as its new place, in pos: D233)
      sizes.push(...sealed.map((x) => JSON.stringify(x).length));
    }
    const b1 = Math.max(...sizes), b2 = quantile(tickMs, 0.95);
    console.log(`    sealed patch per move per peer: mean ${Math.round(sizes.reduce((a, b) => a + b) / sizes.length)} B, max ${b1} B; host tick median ${ms(quantile(tickMs, 0.5))}, p95 ${ms(b2)}`);
    ok(!wide, `each move's patch carries exactly one item (${wide} did not)`);
    ok(b1 <= 1024, `B1: every sealed single-item patch is ≤ 1,024 B on the wire object (max ${b1} B over ${sizes.length}) — seed ${seed}`);
    ok(b2 <= 5, `B2: host apply, takeDirty, the shared patch and 8 splices and seals take ${ms(b2)} p95 (≤ 5 ms) — seed ${seed}`);

    section('B7: 400 t.item(id) and 50 t.find({kind: "pile"}) in one hook take ≤ 20 ms (p95 of 20)');
    T.apply(HOST, { t: 'setRules', enabled: true, code: READS });
    T.api.data.ids = Array.from({ length: 400 }, () => r.pick(cards));
    const hookMs = [];
    for (let k = 0; k < 23; k++) {
      const t0 = performance.now();
      T.apply(HOST, { t: 'rulesBtn', id: 'read' });
      if (k >= 3) hookMs.push(performance.now() - t0);
    }
    const got = T.api.data.got, nPiles = Object.values(s.items).filter((it) => it.k === 'p').length, b7 = quantile(hookMs, 0.95);
    console.log(`    the whole rulesBtn action: median ${ms(quantile(hookMs, 0.5))}, p95 ${ms(b7)}`);
    ok(got?.items === 400 && got.piles === 50 * nPiles && s.rules.enabled, `the hook read 400 items and ${nPiles} pile(s) 50 times, without error`);
    ok(b7 <= 20, `B7: ${ms(b7)} p95 for the action that runs the hook (≤ 20 ms) — seed ${seed}`);
  }
  report();
})().catch(crash);
