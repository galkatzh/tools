// Browser benchmarks (Phase 1, spec §1k) on a 1,000-card table: each budget
// is asserted, so a regression fails the suite. Timing-sensitive: run-all.sh
// runs it alone, after the parallel batch (its SERIAL list).
//   B1'  bytes per move on the wire, as the other guest receives them (Trystero
//        framing included): ≤ 1.5 KB
//   B3   a guest applies and draws a one-item patch: p95 ≤ 4 ms (__ct.perf.lastApplyMs)
//   B4   panning on an emulated phone (iPhone 13, CPU × 2): no long task over 50 ms,
//        and rAF interval p95 ≤ max(20 ms, 1.25 × the same pan over an empty table)
//   B6   the host saves the 1,000-card table: every save's main-thread part ≤ 8 ms
//        (__ct.perf.lastSaveSyncMs, around doSave's synchronous IndexedDB put)
//   TODO(phase 1B): B8 — a guest with a 40-image deck reloads: 0 `asset` bytes
//        re-sent (the __rtc byte counter, per channel).
const h = require('./h');
const L = require('./p1-lib');
const { ok, section } = h;

const B1_MAX = 1.5 * 1024, B3_MAX = 4, B4_LONG = 50, B4_FLOOR = 20, B6_MAX = 8;
const PAN_MS = 3000;

/** The throwaway script that builds the table (spec §1k): 20 standard decks,
 *  1,000 cards dealt face up in a 40 × 25 grid inside the felt. */
const BUILD = `({ name: 'Bench table', setup(t) {
  const g = t.geom(), piles = [];
  for (let k = 0; k < 20; k++) piles.push(t.addStandardDeck({ x: g.cx - 50, y: g.cy - 70 }));
  const side = g.r * Math.SQRT2 - 160, x0 = g.cx - side / 2, y0 = g.cy - side / 2; // card centres stay inside the felt
  let p = 0;
  for (let n = 0; n < 1000; n++) {
    while (!t.item(piles[p])) p++; // an emptied pile is gone
    t.deal(piles[p], { x: x0 + (n % 40) * side / 39 - 50, y: y0 + Math.floor(n / 40) * side / 24 - 70, up: true });
  }
} })`;

/** A 3 s felt-drag pan on page p, under CDP CPU throttling × 2: pointer events
 *  driven once per animation frame, rAF timestamps and long tasks collected in
 *  the page. Returns {gaps (ms between frames), long (long-task durations), moved}. */
async function pan(p) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
  try {
    return await p.evaluate(async (ms) => {
      const table = document.getElementById('table'), r = document.getElementById('table-wrap').getBoundingClientRect();
      let start = null; // a spot of bare felt: on the table, on no item
      for (let k = 0; k < 2000 && !start; k++) {
        const x = r.left + (r.width * ((k * 37) % 101)) / 101, y = r.top + (r.height * ((k * 53) % 103)) / 103;
        const el = document.elementFromPoint(x, y);
        if (el && table.contains(el) && !el.closest('.item')) start = { x, y, el };
      }
      if (!start) throw new Error('no bare felt to start a pan on');
      const long = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); });
      po.observe({ type: 'longtask' });
      const ev = (type, x, y) => new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
      const t0form = table.style.transform;
      start.el.dispatchEvent(ev('pointerdown', start.x, start.y));
      const frames = [];
      let moved = false;
      await new Promise((done) => {
        const t0 = performance.now();
        const step = (ts) => {
          frames.push(ts);
          const t = ts - t0;
          if (t >= ms) { done(); return; }
          window.dispatchEvent(ev('pointermove', start.x + 140 * Math.sin(t / 350), start.y + 100 * Math.sin(t / 470)));
          moved ||= table.style.transform !== t0form;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      window.dispatchEvent(ev('pointerup', start.x, start.y));
      await new Promise((res) => setTimeout(res, 300)); // the observer delivers late entries
      po.disconnect();
      return { gaps: frames.slice(1).map((t, k) => t - frames[k]), long, moved };
    }, PAN_MS);
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch((err) => console.error('unthrottle failed', err));
    await cdp.detach().catch((err) => console.error('CDP detach failed', err));
  }
}

(async () => {
  const env = await h.start();
  const host = await L.player(env, 'Alice', env.url);
  const mover = await L.player(env, 'Bob', host.url());
  const phone = await L.player(env, 'Pat', host.url(), { ctx: h.playwright.devices['iPhone 13'] });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length >= 3, null, { timeout: 30000 });

  section('an empty large table (the B4 baseline)');
  await L.act(host, { t: 'size', size: 2400 });
  for (const id of Object.keys((await L.view(host)).items)) await L.act(host, { t: 'del', id });
  ok(await L.until(async () => { const v = await L.view(phone); return v.size === 2400 && !Object.keys(v.items).length; }, 15000),
    'the phone shows an empty table, 2400 units across');
  await h.sleep(1000);
  const base = await pan(phone);
  const baseP95 = L.pct(base.gaps, 95);
  console.log(`  empty table: ${base.gaps.length} frames, rAF p95 ${baseP95.toFixed(1)} ms, long tasks [${base.long}]`);
  ok(base.moved && base.gaps.length > 30, `the scripted pan moves the view (${base.gaps.length} frames)`);

  section('the 1,000-card table');
  await L.act(host, { t: 'setRules', code: BUILD, enabled: true });
  const built = await L.until(() => phone.evaluate(() => Object.values(window.__ct.view().items).filter((it) => it.k === 'c').length >= 1000
    && document.querySelectorAll('.item').length >= 1000), 90000, 500);
  const counts = await phone.evaluate(() => ({ cards: Object.values(window.__ct.view().items).filter((it) => it.k === 'c').length, dom: document.querySelectorAll('.item').length }));
  ok(built, `the guests hold 1,000 cards (${counts.cards} cards, ${counts.dom} elements on the phone)`);
  await h.sleep(2000);

  section("B1' and B3: 50 moves by one guest, as the other guest receives them");
  const cards = await mover.evaluate(() => { const v = window.__ct.view(); return Object.keys(v.items).filter((id) => v.items[id].k === 'c').sort(); });
  const recv = () => phone.evaluate(() => ({ ...window.__rtc.recv }));
  const r0 = await recv();
  const applyMs = [];
  for (let k = 0; k < 50; k++) {
    const a = (k / 50) * 2 * Math.PI, m = { id: cards[(k * 19) % cards.length], x: Math.round(1150 + 320 * Math.cos(a)), y: Math.round(1130 + 320 * Math.sin(a)) };
    await L.act(mover, { t: 'move', ...m });
    await phone.waitForFunction((m) => { const it = window.__ct.view().items[m.id]; return it && it.x === m.x && it.y === m.y; }, m, { timeout: 10000 });
    applyMs.push(await phone.evaluate(() => window.__ct.perf.lastApplyMs));
    await h.sleep(120); // one move per broadcast tick: no coalescing
  }
  const r1 = await recv();
  const per = Object.fromEntries(Object.keys(r1).map((t) => [t, (r1[t] - (r0[t] || 0)) / 50]).filter(([, n]) => n));
  const bytes = Object.values(per).reduce((s, n) => s + n, 0);
  console.log(`  bytes per move received by the phone, by channel: ${JSON.stringify(per)}`);
  ok(bytes > 0 && bytes <= B1_MAX, `B1': ${bytes.toFixed(0)} bytes per move on the wire (≤ ${B1_MAX})`);
  const p95 = L.pct(applyMs, 95);
  console.log(`  lastApplyMs: median ${L.pct(applyMs, 50).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${Math.max(...applyMs).toFixed(2)} ms`);
  ok(applyMs.length === 50 && p95 <= B3_MAX, `B3: the phone applies and draws a one-item patch in ${p95.toFixed(2)} ms p95 (≤ ${B3_MAX} ms)`);

  section('B4: panning the 1,000-card table on the phone');
  await h.sleep(1000);
  const full = await pan(phone);
  const fullP95 = L.pct(full.gaps, 95), limit = Math.max(B4_FLOOR, 1.25 * baseP95);
  console.log(`  1,000 cards: ${full.gaps.length} frames, rAF p95 ${fullP95.toFixed(1)} ms, long tasks [${full.long}]`);
  ok(full.moved && full.gaps.length > 30, `the pan moves the view (${full.gaps.length} frames)`);
  ok(!full.long.some((d) => d > B4_LONG), `B4: no long task over ${B4_LONG} ms while panning (${full.long.length ? full.long.join(', ') + ' ms' : 'none'})`);
  ok(fullP95 <= limit, `B4: rAF interval p95 ${fullP95.toFixed(1)} ms ≤ max(${B4_FLOOR}, 1.25 × ${baseP95.toFixed(1)}) = ${limit.toFixed(1)} ms`);

  section('B6: the host saves the 1,000-card table');
  // One host move, then its save (throttled to one a second): once IndexedDB
  // holds that seq, perf.lastSaveSyncMs is that save's main-thread part.
  const room = host.url().match(/#room~([0-9a-f]+)/)[1], saveMs = [];
  let items = 0;
  for (let k = 0; k < 10; k++) {
    const m = { id: cards[(k * 37) % cards.length], x: 900 + 25 * k, y: 1500 - 25 * k };
    await L.act(host, { t: 'move', ...m });
    await host.waitForFunction((m) => { const it = window.__ct.view().items[m.id]; return it && it.x === m.x && it.y === m.y; }, m, { timeout: 10000 });
    const seq = await host.evaluate(() => window.__ct.view().seq);
    let rec = null;
    const saved = await L.until(async () => (rec = await h.idb(host, 'saves', room))?.state?.seq >= seq, 15000, 100);
    if (!saved) { ok(false, `B6: the save of seq ${seq} reached IndexedDB (it holds ${rec?.state?.seq})`); break; }
    items = Object.keys(rec.state.items).length;
    saveMs.push(await host.evaluate(() => window.__ct.perf.lastSaveSyncMs));
  }
  console.log(`  lastSaveSyncMs per save: ${saveMs.map((x) => x.toFixed(2)).join(', ')} ms (${items} items saved)`);
  ok(saveMs.length === 10 && items >= 1000 && saveMs.every((x) => x > 0 && x <= B6_MAX),
    `B6: each of ${saveMs.length} saves of ${items} items takes ≤ ${B6_MAX} ms on the main thread (max ${Math.max(...saveMs).toFixed(2)} ms)`);
  await env.done();
})().catch(h.crash);
