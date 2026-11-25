// Phase 4B's performance budgets in Node (spec §4k): B18's size — the
// Hexfront table a guest's snapshot carries, with the box it draws from (the
// `boxes` channel's PublicBox), ≤ 120 KB — and B19, a `group` move of 200
// items: host apply ≤ 15 ms, the patch ≤ 30 KB per peer. B19 runs with the
// rules off (the host's own table applies the job: T.apply) and on (a
// Worker-like mirror runs it, the host takes the patch: applyStatePatch,
// which is the host's apply then); the patch is measured as B9 measures it
// (core-p2-bench): the sealed body to each of 8 guests, as it goes on the
// wire. The 200 tokens stand on a 24 × 22 hex map, each on its own hex, and
// move a hex right, then back: every member snaps on its own. run-all.sh
// runs this file alone (SERIAL): timings on a loaded machine mean nothing.
// Seeded: SEED=n replays a run.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, core, ok, section, report, crash, seeds, rng, quantile, keyOf, HOST } from './node-lib.mjs';

const { createTable, scriptHooks, publicBox, PROTO, spliceBody, sealText } = core;
const { BOXES } = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));
/** 8 seated guests: player ids, and peer ids shaped like Trystero's (20 characters). */
const GUESTS = Array.from({ length: 8 }, (_, k) => ({ pid: String(k + 1).repeat(16), tp: `peer${k + 1}`.padEnd(20, 'x') }));
const ms = (x) => `${x.toFixed(2)} ms`;
const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
/** 200 tokens, ten rows of twenty, each on its own hex of a 24 × 22 map. */
const TWO_HUNDRED = {
  name: 'Two hundred', imgs: [], table: { shape: 'rect', w: 4000, h: 3000 },
  types: {
    map: { kind: 'board', name: 'Map', w: 2500, h: 2000, board: { grid: { type: 'hex', cols: 24, rows: 22, cell: 100, x: 0, y: 0, draw: 'cells' } } },
    tok: { kind: 'token', name: 'Unit', shape: 'rect', w: 56, faces: [{ label: '● 4-3' }, { label: '● 2-3' }] },
  },
  setup: [{ piece: 'map', at: 'center' }, ...Array.from({ length: 10 }, (_, r) => ({ piece: 'tok', count: 20, spread: [100, 0], at: [822, 500 + 30 + 2 * r * 86.6] }))],
};
/** A table hosted by HOST with the 8 guests, randomness and ids seeded. */
function table(seed, hooks) {
  let clock = 1.7e12, n = 0;
  const T = createTable({}, { pid: HOST, now: () => (clock += 250), random: rng(seed ^ 0x5eed), uid: () => (++n).toString(16).padStart(8, '0'), ...(hooks && { hooks }) });
  T.open('Alice');
  for (const g of GUESTS) T.join(g.pid, `Guest ${g.pid[0]}`, keyOf(g.pid));
  return T;
}
/** The rules view as the host's page answers it (the script runs in a Worker: here, a mirror). */
const pageHooks = { load: () => '', has: () => false, flag: () => undefined, call(h) { throw new Error(`${h}() ran on the page`); } };

(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64');
  /** The tick after a job on T: each guest's sealed patch, as the wire carries it ({sizes, items}). */
  async function tick(T, sync) {
    const s = T.state, d = T.takeDirty(), content = T.patchContent(d), fx = [];
    for (const e of T.drain()) if (e.t === 'fx') fx.push(e.f);
    if (fx.length) content.fx = fx;
    const shared = JSON.stringify({ v: PROTO, boot: 1.7e12, seq: s.seq, host: HOST, kind: 'patch', ...content });
    const sealed = await Promise.all(GUESTS.map((g) => {
      const text = spliceBody({ to: g.pid, tp: g.tp, base: sync.get(g), ...(d.hands.has(g.pid) ? { hand: s.players[g.pid].hand } : {}) }, shared);
      sync.set(g, s.seq);
      return sealText(text, kp.privateKey, pub);
    }));
    return { sizes: sealed.map((x) => JSON.stringify(x).length), items: Object.keys(content.items || {}).length, log: content.log?.length ?? 0 };
  }

  for (const seed of seeds([1])) {
    section(`B18: Hexfront's table — the snapshot a guest gets, with the box it draws from, ≤ 120 KB (seed ${seed})`);
    {
      const T = table(seed);
      T.apply(HOST, { t: 'loadBox', box: BOXES.hexfront, setup: true, clear: true });
      T.drain();
      const s = T.state, snap = JSON.stringify({ v: PROTO, kind: 'snap', boot: 1.7e12, seq: s.seq, host: HOST, ...T.snapContent() });
      const box = JSON.stringify(publicBox(s.boxes[s.lastSetup], s.boxSrc[s.lastSetup]));
      const counters = Object.values(s.items).reduce((n, it) => n + (it.n || 0), 0);
      console.log(`    snapshot ${KB(snap.length)} (${Object.keys(s.items).length} items, ${counters} counters), PublicBox ${KB(box.length)}`);
      ok(counters === 400 && snap.length + box.length <= 120 * 1024, `B18: Hexfront's snapshot and its box come to ${KB(snap.length + box.length)} (≤ 120 KB)`);
    }

    section('B19: a group move of 200 items — host apply ≤ 15 ms (p95 of 40, after 5 to warm up), the patch ≤ 30 KB per peer');
    for (const rules of [false, true]) {
      const T = table(seed, rules && pageHooks), r = rng(seed);
      T.apply(HOST, { t: 'loadBox', box: TWO_HUNDRED, setup: true, clear: true });
      const ids = Object.keys(T.state.items).filter((id) => T.state.items[id].t?.endsWith('/tok'));
      let M = null;
      if (rules) { // (the rules on: a mirror of the host's table runs the job, as rules-worker.js does; the host takes its patch)
        T.apply(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Watch', onAction(t, a) { t.data.n = (t.data.n || 0) + 1; } })" });
        T.syncSpots();
        const { keys, decks, boxes, boxSrc, ...state } = T.state, m = structuredClone({ state, decks, boxes, boxSrc }), hk = scriptHooks();
        hk.load(T.state.rules.code);
        let n = 0;
        M = createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid: HOST, now: () => 1.8e12, random: rng(seed), uid: () => `f${(++n).toString(16).padStart(7, '0')}`, hooks: hk, mirror: true });
      }
      T.takeDirty();
      T.drain();
      const sync = new Map(GUESTS.map((g) => [g, T.state.seq])), applyMs = [], workerMs = [], sizes = [];
      let wrong = 0;
      for (let k = 0; k < 45; k++) {
        const who = r.pick([HOST, ...GUESTS.map((g) => g.pid)]), a = { t: 'group', op: 'move', ids, dx: k % 2 ? -100 : 100, dy: 0 };
        let t0, t1;
        if (M) {
          const w0 = performance.now(), job = M.job(who, a), w1 = performance.now();
          M.drain();
          const patch = structuredClone(job.patch), out = structuredClone(job.out); // (what postMessage hands the host)
          t0 = performance.now();
          T.applyStatePatch(patch, out, { p: who, a });
          t1 = performance.now();
          if (k >= 5) workerMs.push(w1 - w0);
        } else {
          t0 = performance.now();
          T.apply(who, a);
          t1 = performance.now();
        }
        const t = await tick(T, sync);
        if (t.items !== 200 || t.log < 1 || !ids.every((id) => T.state.items[id].at)) wrong++;
        if (k < 5) continue;
        applyMs.push(t1 - t0);
        sizes.push(...t.sizes);
      }
      const p95 = quantile(applyMs, 0.95), max = Math.max(...sizes), how = rules ? 'rules on: applyStatePatch of the mirror\'s patch' : 'rules off: T.apply';
      console.log(`    ${how}: median ${ms(quantile(applyMs, 0.5))}, p95 ${ms(p95)}${rules ? `; the mirror's job (the Worker's time) median ${ms(quantile(workerMs, 0.5))}, p95 ${ms(quantile(workerMs, 0.95))}` : ''}; per-peer patch max ${KB(max)}`);
      ok(!wrong && (!rules || T.digest() === M.digest()), `every group move took all 200, each on a hex, with its line${rules ? ', the mirror and the host alike (digest)' : ''} (${wrong} did not)`);
      ok(p95 <= 15, `B19 (${how}): a 200-item group move takes ${ms(p95)} p95 on the host (≤ 15 ms)`);
      ok(max <= 30 * 1024, `B19 (${how}): every sealed per-peer patch is ≤ 30 KB (max ${KB(max)} over ${sizes.length})`);
    }
  }
  report();
})().catch(crash);
