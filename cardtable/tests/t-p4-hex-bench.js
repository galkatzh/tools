// Phase 4B's budgets on Hexfront (spec §4k B18 and B19; §4l t-p4-hexfront
// item 7), written from the spec. Run alone (run-all.sh SERIAL): wall
// clocks and a throttled CPU mean nothing on a loaded machine.
//  B18 Hexfront's snapshot ≤ 120 KB — in Node (the body a guest's snapshot
//      carries, with the PublicBox the boxes channel brings it), and as the
//      bytes a guest's browser receives (wireLog) — and a guest's cold render
//      (__ct.perf.lastSnapRenderMs) ≤ 600 ms on a desktop and ≤ 2 s on an
//      emulated iPhone 13 at 2× CPU throttle: the worst of three each.
//  B19 a `group` move of 200 items: host apply ≤ 15 ms — in Node, on
//      Hexfront's own table (Azure's 200 counters split into 200 single
//      counters, each on a hex, moved a hex at a time by Azure's player): with
//      the rules off (T.apply) and with Hexfront's turn script on (a mirror
//      runs the job, as the rules Worker does; the host takes its patch:
//      applyStatePatch), the p95 of 40 after 5 to warm up — and in the
//      browser with the rules off (__ct.perf.lastJobMs, the median of 5
//      drags). The patch ≤ 30 KB per peer: in Node the sealed body each of 8
//      guests gets, as B1 and B9 measure one (JSON.stringify of sealText's
//      object: the escaped body, its signature and the host's key), and as
//      each guest's browser receives it (wireLog) after a real group drag:
//      Alice bands Azure's 200 with Shift+drag and drags one of them a hex
//      to the right.
// Alice hosts on a desktop, Bob plays on an iPhone 13, Carol watches on a
// desktop. The 180 splits are set up with __ct.act; the band and the drags
// are real gestures.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const { until, view, pct } = require('./p1-lib');
const B = require('./p4-lib');
const X = require('./p4h-lib');
const core = require(path.join(h.APP_ROOT, 'cardtable/core.js'));
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const HOST = 'a'.repeat(16);
const GUESTS = Array.from({ length: 8 }, (_, k) => String(k + 1).repeat(16));
const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
const ms = (x) => `${x.toFixed(2)} ms`;
/** The rules on the host's page while a Worker runs them: nothing of the script runs there (app.js's). */
const pageHooks = { load: () => '', has: () => false, flag: () => undefined, call(k) { throw new Error(`${k}() ran on the page`); } };
/** A Node table hosted by HOST with 8 guests, Hexfront set up (`hooks`: the page's, for a table whose rules a mirror runs). */
function hexTable(hooks) {
  let clock = 1.7e12, n = 0, seed = 12345;
  const T = core.createTable({}, { pid: HOST, now: () => (clock += 250), random: () => ((seed = (seed * 16807) % 2147483647) / 2147483647), uid: () => (++n).toString(16).padStart(8, '0'), ...(hooks && { hooks }) });
  T.open('Alice');
  GUESTS.forEach((g, k) => T.join(g, `Guest ${k + 1}`, `key-${g}`.padEnd(32, '!')));
  T.apply(HOST, { t: 'loadBox', box: BOXES.hexfront, setup: true, clear: true });
  T.drain();
  T.takeDirty();
  return T;
}
/** Hexfront's units of side `side` on table T (a piece whose type's meta names the side). */
const unitsOf = (T, side) => Object.keys(T.state.items).filter((id) => typeOf(T, T.state.items[id])?.meta?.side === side);
/** The type of item `it` on table T. */
const typeOf = (T, it) => { const [b, t] = (it.t || '').split('/'); return T.state.boxes[b]?.types[t]; };
/** The table centres of rows `r0`…`r1`, columns `c0`…`c1` of the hex map on table T, row by row. */
function hexes(T, r0, r1, c0, c1) {
  const map = Object.values(T.state.items).find((it) => typeOf(T, it)?.kind === 'board'), grid = typeOf(T, map).board.grid, out = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const q = P3.spotXY(grid, c, r); out.push({ x: map.x + q.x, y: map.y + q.y }); }
  return out;
}
/** Splits side `side`'s stacks on table T (by its seat's player, through `apply`) into single counters, each on its own hex of rows 3–12: {who, ids}. */
function singles(T, side, apply) {
  const who = Object.keys(T.state.players).find((q) => T.state.players[q].seatId === side), spots = hexes(T, 3, 12, 1, 22);
  for (const id of unitsOf(T, side)) {
    const { w, h = w } = typeOf(T, T.state.items[id]);
    while (T.state.items[id].n > 1) {
      const s = spots.shift();
      if (!apply(who, { t: 'split', id, n: 1, x: s.x - w / 2, y: s.y - h / 2 })) throw new Error(`a split of ${id} was refused`);
    }
  }
  return { who, ids: unitsOf(T, side) };
}

(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64');
  /** Table T's last job as each guest's sealed patch (spliceBody: the guest's own head, then the shared body), measured as B1 measures
   *  a body: the length of JSON.stringify(sealText(…)) — the JSON-escaped body with its signature and the host's key. */
  async function sealed(T) {
    const s = T.state, d = T.takeDirty(), content = T.patchContent(d), fx = T.drain().filter((e) => e.t === 'fx').map((e) => e.f);
    const shared = JSON.stringify({ v: core.PROTO, boot: 1.7e12, seq: s.seq, host: HOST, kind: 'patch', ...content, ...(fx.length && { fx }) });
    return Promise.all(GUESTS.map(async (g, k) => JSON.stringify(await core.sealText(core.spliceBody({ to: g, tp: `peer${k + 1}`.padEnd(20, 'x'), base: s.seq - 1 }, shared), kp.privateKey, pub)).length));
  }
  section('B18 (Node): Hexfront\'s snapshot, with the box it draws from, ≤ 120 KB');
  {
    const T = hexTable(), s = T.state;
    const snap = JSON.stringify({ v: core.PROTO, kind: 'snap', boot: 1.7e12, seq: s.seq, host: HOST, to: GUESTS[0], hand: [], ...T.snapContent() });
    const box = JSON.stringify(core.publicBox(s.boxes[s.lastSetup], s.boxSrc[s.lastSetup]));
    const counters = Object.values(s.items).reduce((n, it) => n + (it.n || 0), 0);
    console.log(`    the snapshot ${KB(snap.length)} (${Object.keys(s.items).length} items, ${counters} counters); the PublicBox ${KB(box.length)}`);
    ok(counters === 400 && snap.length <= 120 * 1024, `B18: the snapshot's body ${KB(snap.length)} ≤ 120 KB`);
    ok(snap.length + box.length <= 120 * 1024, `B18: with its box (D222's reading) ${KB(snap.length + box.length)} ≤ 120 KB`);
  }

  section('B19 (Node): a group move of Azure\'s 200 single counters on Hexfront\'s map, a hex at a time — host apply p95 ≤ 15 ms (40, after 5)');
  for (const rules of [false, true]) {
    const T = hexTable(rules && pageHooks);
    let M = null, mover, ids;
    if (rules) { // (a mirror of the host's table runs the script, as rules-worker.js does; the host takes each job's patch)
      ({ who: mover, ids } = singles(T, 'azure', (p, a) => T.apply(p, a)));
      T.syncSpots();
      const { keys, decks, boxes, boxSrc, ...state } = T.state, m = structuredClone({ state, decks, boxes, boxSrc }), hk = core.scriptHooks();
      hk.load(BOXES.hexfront.rules);
      let n = 0;
      M = core.createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid: HOST, now: () => 1.8e12, random: Math.random, uid: () => `f${(++n).toString(16).padStart(7, '0')}`, hooks: hk, mirror: true });
      const a = { t: 'setRules', enabled: true, code: BOXES.hexfront.rules, reset: true }, r = M.job(HOST, a);
      T.applyStatePatch(structuredClone(r.patch), structuredClone(r.out), { p: HOST, a });
      M.drain();
      T.drain();
      ok(T.state.rules?.enabled && T.state.rules.data?.side === 'azure' && T.digest() === M.digest(), `Hexfront's turn script on, Azure to move, the mirror and the host alike (${JSON.stringify(T.state.rules?.data)})`);
    } else ({ who: mover, ids } = singles(T, 'azure', (p, a) => T.apply(p, a)));
    T.takeDirty();
    T.drain();
    const applyMs = [], workerMs = [], sizes = [];
    let wrong = 0;
    for (let k = 0; k < 45; k++) {
      const a = { t: 'group', op: 'move', ids, dx: k % 2 ? -100 : 100, dy: 0 }, was = ids.map((id) => T.state.items[id].at), last = T.state.log.at(-1);
      let t0, t1;
      if (M) {
        const w0 = performance.now(), r = M.job(mover, a), w1 = performance.now();
        M.drain();
        const patch = structuredClone(r.patch), out = structuredClone(r.out); // (what postMessage hands the host)
        t0 = performance.now();
        T.applyStatePatch(patch, out, { p: mover, a });
        t1 = performance.now();
        if (k >= 5) workerMs.push(w1 - w0);
      } else {
        t0 = performance.now();
        T.apply(mover, a);
        t1 = performance.now();
      }
      const per = await sealed(T), line = T.state.log.at(-1); // (the job's one line, the last: the log keeps a bounded number, so its length says nothing)
      if (!ids.every((id, j) => T.state.items[id].at && T.state.items[id].at !== was[j]) || line === last || line.p !== mover || line.txt !== 'moved 200 items') wrong++;
      if (k >= 5) { applyMs.push(t1 - t0); sizes.push(...per); }
    }
    const how = rules ? 'the rules on: applyStatePatch of the mirror\'s patch' : 'the rules off: T.apply';
    console.log(`    ${how}: median ${ms(pct(applyMs, 50))}, p95 ${ms(pct(applyMs, 95))}${rules ? `; the mirror's job (a Worker's time) median ${ms(pct(workerMs, 50))}, p95 ${ms(pct(workerMs, 95))}` : ''}`);
    ok(ids.length === 200 && !wrong && (!M || T.digest() === M.digest()), `each of the 45 moved all 200, every one to a new hex, in one line "moved 200 items"${M ? ', the mirror and the host alike' : ''} (${wrong} did not)`);
    ok(pct(applyMs, 95) <= 15, `B19 (${how}): host apply p95 ${ms(pct(applyMs, 95))} ≤ 15 ms`);
    ok(Math.max(...sizes) <= 30 * 1024, `B19 (${how}): every guest's sealed patch ≤ 30 KB (max ${KB(Math.max(...sizes))} over ${sizes.length})`);
  }

  const env = await h.start();
  const alice = await X.player(env, 'Alice', env.url);
  const bob = await X.player(env, 'Bob', alice.url(), { ctx: P.PHONE });
  alice.on('dialog', (d) => d.accept());
  await B.openBoxes(alice);
  await alice.locator('#box-builtins .box-row', { hasText: 'Hexfront' }).locator('button', { hasText: 'Set up' }).click();
  ok(await until(async () => { const v = await view(bob); return v.rules?.enabled && v.rules.name === 'Hexfront' && Object.keys(v.items).length > 40; }, 20000), 'Hexfront set up from 📦, its rules on, on Bob\'s phone');
  await B.settle(alice);

  section('B18 (browser): a guest\'s cold render — desktop ≤ 600 ms, iPhone 13 at 2× CPU throttle ≤ 2 s (the worst of 3); the snapshot as it arrives ≤ 120 KB');
  /** Page p's render of the snapshot that drew Hexfront, once its 44 items stand: {ms, snap: its bytes, boxes: the boxes message's}. */
  const cold = (p) => p.waitForFunction(() => Object.keys(window.__ct?.view().items || {}).length >= 44 && window.__ct.perf.lastSnapRenderMs > 0, null, { timeout: 30000 })
    .then(() => p.evaluate(() => ({
      ms: window.__ct.perf.lastSnapRenderMs,
      snap: Math.max(0, ...window.__wire.filter((m) => m.kind === 'snap' && m.items.length >= 44).map((m) => m.bytes)),
      boxes: Math.max(0, ...window.__wire.filter((m) => m.type === 'boxes').map((m) => m.bytes)),
    })));
  const carol = await X.player(env, 'Carol', alice.url());
  const desk = [await cold(carol)];
  for (let k = 0; k < 2; k++) { await carol.reload(); desk.push(await cold(carol)); }
  const cdp = await bob.context().newCDPSession(bob), phone = [];
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
  try { for (let k = 0; k < 3; k++) { await bob.reload(); phone.push(await cold(bob)); } } finally { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await cdp.detach(); }
  const worst = (xs) => Math.max(...xs.map((x) => x.ms));
  console.log(`    desktop ${desk.map((x) => x.ms.toFixed(0)).join(', ')} ms; iPhone 13 at 2× ${phone.map((x) => x.ms.toFixed(0)).join(', ')} ms; the snapshot ${KB(desk[0].snap)}, the boxes message ${KB(desk[0].boxes)} on the wire`);
  ok(worst(desk) <= 600, `B18: a desktop guest's cold render ≤ 600 ms (worst ${worst(desk).toFixed(0)} ms)`);
  ok(worst(phone) <= 2000, `B18: an iPhone 13 guest's at 2× CPU throttle ≤ 2 s (worst ${worst(phone).toFixed(0)} ms)`);
  const snapB = Math.max(...[...desk, ...phone].map((x) => x.snap)), boxB = Math.max(...[...desk, ...phone].map((x) => x.boxes));
  ok(snapB > 0 && snapB <= 120 * 1024, `B18: the snapshot a guest receives is ${KB(snapB)} on the wire (≤ 120 KB)`);
  ok(boxB > 0 && snapB + boxB <= 120 * 1024, `B18: with the box the boxes channel brings, ${KB(snapB + boxB)} (≤ 120 KB)`);

  section('B19 (browser): Alice bands Azure\'s 200 single counters (Shift+drag) and drags them a hex right: the patch each guest receives ≤ 30 KB');
  let H = await X.hexOf(alice);
  const azure = H.seats.azure, mover = [alice, bob].find((p) => p.pid === azure);
  ok(mover === alice, `Alice holds Azure: she makes the splits and the drags (${H.seats.azure === alice.pid ? 'Alice' : 'Bob'})`);
  const spots = [];
  for (let r = 3; r <= 12; r++) for (let c = 1; c <= 22; c++) spots.push(X.hexAt(H.map, c, r));
  for (const id of H.units.filter((u) => H.side[u] === 'azure')) {
    for (let k = 1; k < 10; k++) {
      const s = spots.shift();
      await alice.evaluate((a) => window.__ct.act(a), { t: 'split', id, n: 1, x: s.x - H.size[id].w / 2, y: s.y - H.size[id].h / 2 });
    }
  }
  await B.settle(alice);
  H = await X.hexOf(alice);
  const az = H.units.filter((u) => H.side[u] === 'azure');
  ok(az.length === 200 && az.every((u) => H.items[u].n === undefined || H.items[u].n === 1) && new Set(az.map((u) => H.items[u].at)).size === 200, `Azure's 200 counters stand one a hex (${az.length} items on ${new Set(az.map((u) => H.items[u].at)).size} hexes)`);
  await X.press(alice, '#view-btn');
  await h.sleep(200);
  const top = X.hexAt(H.map, 0, 3).y - 60, a0 = await P3.screenOf(alice, H.map.x - 8, top), a1 = await P3.screenOf(alice, H.map.x + H.map.w + 8, H.map.y + H.map.h + 8);
  await P.mouseDrag(alice, a0, a1, { shift: true, steps: 12 });
  const picked = await alice.evaluate(() => [...document.querySelectorAll('#table .item.selected')].map((e) => e.dataset.id));
  ok(picked.length === 200 && az.every((u) => picked.includes(u)) && /^200 selected/.test((await X.bar(alice))?.text || ''), `the band picks Azure's 200 ("${(await X.bar(alice))?.text.slice(0, 40)}")`);
  /** Alice drags the group by one hex (`dir` +1: right, −1: left), pressing its member nearest the map's middle; resolves once both guests show them all moved. */
  async function groupHex(dir) {
    const Hn = await X.hexOf(alice), mid = az.slice().sort((a, b) => Math.hypot(X.centre(Hn, a).x - 1700, X.centre(Hn, a).y - 1200) - Math.hypot(X.centre(Hn, b).x - 1700, X.centre(Hn, b).y - 1200))[0];
    const c = X.centre(Hn, mid), was = Object.fromEntries(az.map((u) => [u, Hn.items[u].at]));
    const from = await P3.screenOf(alice, c.x, c.y), to = await P3.screenOf(alice, c.x + 100 * dir, c.y);
    const marks = await Promise.all([bob, carol].map((p) => p.evaluate(() => window.__wire.length)));
    await X.dragFrom(alice, from, to);
    const moved = await until(async () => {
      for (const p of [bob, carol]) { const it = (await view(p)).items; if (!az.every((u) => it[u]?.at && it[u].at !== was[u])) return false; }
      return true;
    }, 15000);
    return { moved, marks };
  }
  const s1 = Date.now(), g1 = await groupHex(1);
  ok(g1.moved, 'the drop: every one of the 200 stands on its new hex, on Bob\'s phone and Carol\'s screen');
  ok(await until(async () => (await X.linesBy(bob, alice.pid, /^moved 200 items$/, s1)).length === 1, 5000), 'one line, on Bob\'s phone too: "Alice moved 200 items"');
  for (const [k, p] of [bob, carol].entries()) {
    const got = await p.evaluate((from) => window.__wire.slice(from).filter((m) => m.kind === 'patch' && m.items.length >= 200), g1.marks[k]);
    console.log(`    ${p.who}: the group's patch ${got.map((m) => `${KB(m.bytes)} on the wire (its body ${KB(m.chars)}, of which ${m.items.length} items ${KB(m.itemChars)})`).join('; ')}`);
    ok(got.length >= 1 && got.every((m) => m.bytes <= 30 * 1024), `B19: the patch ${p.who} receives for the 200 is ≤ 30 KB on the wire (${got.map((m) => KB(m.bytes)).join(', ') || 'none seen'})`);
  }

  section('B19 (browser): the rules switched off in 📜, the host\'s own apply of the 200 (__ct.perf.lastJobMs) — the median of 5 drags ≤ 15 ms');
  await X.press(alice, '#rules-btn');
  await alice.waitForSelector('#rules-dialog[open]');
  await X.press(alice, '#rules-disable');
  ok(await until(async () => !(await view(bob)).rules?.enabled, 8000), 'Disable: the rules are off on every screen');
  await alice.keyboard.press('Escape');
  await alice.waitForSelector('#rules-dialog:not([open])', { state: 'attached' });
  const jobs = [];
  for (let k = 0; k < 5; k++) {
    const g = await groupHex(k % 2 ? 1 : -1);
    jobs.push(await alice.evaluate(() => window.__ct.perf.lastJobMs));
    if (!g.moved) ok(false, `drag ${k + 1}: the 200 didn't all move`);
  }
  console.log(`    the host's T.apply of a 200-member group: ${jobs.map((x) => x.toFixed(1)).join(', ')} ms`);
  ok(pct(jobs, 50) <= 15, `B19: the host applies a 200-item group in ${pct(jobs, 50).toFixed(1)} ms (median of 5; worst ${Math.max(...jobs).toFixed(1)}) ≤ 15 ms`);
  await env.done();
})().catch(h.crash);
