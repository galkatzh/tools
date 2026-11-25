// A guest's flood of ruled groups (spec §0.1 flood control, §4c, §4j;
// D234, D241), in a real browser and rules Worker: with 3 MB of t.data a
// 200-member group costs the Worker seconds, and its price follows that
// work past the 40-token burst (it overdraws the bucket), so a guest who
// sends one every 2 s — as fast as he can — buys no more of the Worker than
// flood control allows. Meanwhile another player's single moves wait at
// most behind one group, never behind a queue that grows.
// (Serial: wall-clock waits on a loaded Worker.)
'use strict';
const h = require('./h');
const { ok, section } = h;
const P3 = require('./p3-lib');
const { until, view, act } = require('./p1-lib');

const BOX = {
  name: 'Many', imgs: [], table: { shape: 'rect', w: 4000, h: 3000 },
  types: { tok: { kind: 'token', name: 'Unit', shape: 'rect', w: 40, faces: [{ label: 'U' }] } },
  setup: [...Array.from({ length: 10 }, (_, r) => ({ piece: 'tok', count: 20, spread: [60, 0], at: [300, 300 + 80 * r] })), { piece: 'tok', at: [3000, 2500], id: 'cccc0001' }],
};
const KB = 3000, SECS = 24;
/** The rules: t.data holds KB kilobytes of numbers; every action passes validate. */
const CODE = `({ name: 'Big', setup(t) { t.data.big = Array.from({ length: ${Math.round((KB * 1024) / 8)} }, (_, k) => 1000000 + k); }, validate() {} })`;
const J = JSON.stringify;

(async () => {
  const env = await h.start();
  const alice = await P3.join(env, 'Alice', env.url);
  const bob = await P3.join(env, 'Bob', alice.url());
  const carol = await P3.join(env, 'Carol', alice.url());
  section(`a guest's group of 200 every 2 s with ${KB / 1000} MB of t.data, and another's single move every 2 s (D241)`);
  await act(alice, { t: 'loadBox', box: BOX, setup: true, clear: true });
  await act(alice, { t: 'setRules', enabled: true, reset: true, code: CODE });
  await alice.waitForFunction(() => window.__ct.hostState().rules?.enabled && window.__ct.jobs() === 0, null, { timeout: 60000 });
  ok(await until(async () => Object.keys((await view(carol)).items).length === 201, 15000), 'the 201 tokens on every screen, the rules on');
  const st = await alice.evaluate(() => window.__ct.hostState()), chars = JSON.stringify(st.rules.data).length, C = 'cccc0001';
  const ids = Object.keys(st.items).filter((id) => id !== C).slice(0, 200);
  ok(chars > 2.9e6 && ids.length === 200 && !!st.items[C], `t.data holds ${(chars / 1e6).toFixed(2)} MB`);
  let stop = false, sent = 0, k = 0;
  const flood = (async () => { // Bob: a group move as often as he likes (every 2 s), its price and all
    while (!stop) { await act(bob, { t: 'group', op: 'move', ids, dx: 0, dy: sent % 2 ? -40 : 40 }); sent++; await h.sleep(2000); }
  })();
  const waits = [], depth = [], t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) { // Carol: one move every 2 s, timed from her send to the host's state
    const x = 3000 + 10 * (++k % 20), at = Date.now();
    await act(carol, { t: 'move', id: C, x, y: 2500 });
    let w = null;
    while (Date.now() - at < 30000) {
      const s = await alice.evaluate((C) => ({ x: window.__ct.hostState().items[C].x, q: window.__ct.jobs() }), C);
      depth.push(s.q);
      if (s.x === x) { w = Date.now() - at; break; }
      await h.sleep(50);
    }
    waits.push(w);
    await h.sleep(Math.max(0, 2000 - (Date.now() - at)));
  }
  stop = true;
  await flood;
  const groups = (await view(alice)).log.filter((e) => e.p === bob.pid && /^moved 200 items$/.test(e.txt)).length;
  console.log(`  Bob sent ${sent} groups, ${groups} applied; Carol's ${waits.length} moves waited (ms) ${J(waits)}; the job queue at most ${Math.max(...depth)}`);
  const third = Math.floor(waits.length / 3), mean = (a) => a.reduce((t, w) => t + w, 0) / a.length;
  const median = [...waits].sort((a, b) => a - b)[waits.length >> 1];
  ok(waits.every((w) => w !== null && w < 6000), `each of Carol's moves applies within 6 s — behind one group at most (the longest ${Math.max(...waits)} ms)`);
  ok(median <= 1000, `most wait behind none: the median ${median} ms (with the price capped at the burst, ~1.6 s: a group ran nearly all the time)`);
  ok(mean(waits.slice(-third)) <= mean(waits.slice(0, third)) + 1000, `her waits don't grow: the last third's mean ${mean(waits.slice(-third)).toFixed(0)} ms, the first's ${mean(waits.slice(0, third)).toFixed(0)} ms`);
  ok(Math.max(...depth) <= 3, `the host's job queue stays short (at most ${Math.max(...depth)})`);
  ok(groups >= 1 && groups <= 3 && groups < sent, `flood control lets ${groups} of Bob's ${sent} groups through: each overdraws his bucket by its price, ${11 * Math.ceil(chars / 1e5)} tokens`);
  ok(await alice.evaluate(() => !!window.__ct.hostState().rules?.enabled), 'the rules still run');
  await env.done();
})().catch(h.crash);
