// Browser benchmarks on a 1,000-card table (Phase 1, spec §1k), then on the
// 1,000-piece bench box (Phase 2, spec §2k): each budget is asserted, so a
// regression fails the suite. Timing-sensitive: run-all.sh runs it alone,
// after the parallel batch (its SERIAL list).
//   B1'  bytes per move on the wire, as the other guest receives them (Trystero
//        framing included): ≤ 1.5 KB
//   B3   a guest applies and draws a one-item patch: p95 ≤ 4 ms (__ct.perf.lastApplyMs)
//   B4   panning on an emulated phone (iPhone 13, CPU × 2): no long task over 50 ms,
//        and rAF interval p95 ≤ max(20 ms, 1.25 × the same pan over an empty table)
//   B6   the host saves the 1,000-item table: every save's main-thread part ≤ 8 ms
//        (__ct.perf.lastSaveSyncMs, around doSave's synchronous IndexedDB put)
//   B8   a guest that pulled a 40-image deck reloads: 0 `asset` bytes received
//        (the __rtc byte counter, per channel), and no image asked for
// Phase 2 (§2k) re-runs B1', B3, B4, B6 and B8 on the bench box (P.BENCH: 1
// board, 600 tokens, 250 tiles, 50 dice, 60 supplies, 39 bags), loaded with
// __ct.act({t: 'loadBox', box, setup: true, clear: true}) — its Node budgets
// B1, B2, B5 and B7 are core-p2-bench.mjs's — and adds:
//   B10  a guest renders a 1,000-piece snapshot (__ct.perf.lastSnapRenderMs): ≤ 400 ms
//        on a desktop, ≤ 1,500 ms on the iPhone 13 at CPU × 2: a new guest joining (and
//        drawing the pieces, never "?" placeholders), and a snapshot asked for after a
//        lost patch (the boxes already here)
//   B11  boardSVG of a 64 × 64 grid: ≤ 30 ms, then cached (in the page)
const h = require('./h');
const L = require('./p1-lib');
const A = require('./assets-lib');
const P = require('./p2t-lib');
const { ok, section } = h;

const B1_MAX = 1.5 * 1024, B3_MAX = 4, B4_LONG = 50, B4_FLOOR = 20, B6_MAX = 8, B10_DESK = 400, B10_PHONE = 1500, B11_MAX = 30;
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

/** CPU throttling on page p (CDP Emulation.setCPUThrottlingRate): returns a function that lifts it. */
async function throttle(p, rate = 2) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return async () => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch((err) => console.error('unthrottle failed', err));
    await cdp.detach().catch((err) => console.error('CDP detach failed', err));
  };
}

/** A 3 s felt-drag pan on page p, under CDP CPU throttling × 2: pointer events
 *  driven once per animation frame, rAF timestamps and long tasks collected in
 *  the page. Returns {gaps (ms between frames), long (long-task durations), moved}. */
async function pan(p) {
  const unthrottle = await throttle(p);
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
  } finally { await unthrottle(); }
}

/** Init script: window.__ph, the most "?" placeholders (a piece whose box
 *  isn't here yet) this page has shown at once since it loaded. */
function placeholderWatch() {
  window.__ph = 0;
  new MutationObserver(() => { window.__ph = Math.max(window.__ph, document.querySelectorAll('.pface.placeholder').length); })
    .observe(document, { subtree: true, childList: true });
}

(async () => {
  const env = await h.start();
  const host = await L.player(env, 'Alice', env.url);
  const mover = await L.player(env, 'Bob', host.url());
  const phone = await L.player(env, 'Pat', host.url(), { ctx: P.PHONE });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length >= 3, null, { timeout: 30000 });

  /** The phone's rAF p95 while panning: logged, and checked to move the view. */
  async function panOn(what) {
    await h.sleep(1000);
    const r = await pan(phone), p95 = L.pct(r.gaps, 95);
    console.log(`  ${what}: ${r.gaps.length} frames, rAF p95 ${p95.toFixed(1)} ms, long tasks [${r.long}]`);
    ok(r.moved && r.gaps.length > 30, `the scripted pan moves the view (${r.gaps.length} frames)`);
    return { ...r, p95 };
  }
  /** B1' and B3: 50 moves of `ids` by one guest, around (cx, cy), as the phone receives them. */
  async function movesB1B3(ids, cx, cy, rx, ry) {
    const recv = () => phone.evaluate(() => ({ ...window.__rtc.recv }));
    const r0 = await recv();
    const applyMs = [];
    for (let k = 0; k < 50; k++) {
      const a = (k / 50) * 2 * Math.PI, m = { id: ids[(k * 19) % ids.length], x: Math.round(cx + rx * Math.cos(a)), y: Math.round(cy + ry * Math.sin(a)) };
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
  }
  /** B4: the phone pans the full table; `base` is the same pan over the empty table. */
  async function panB4(base, what) {
    const full = await panOn(what), limit = Math.max(B4_FLOOR, 1.25 * base.p95);
    ok(!full.long.some((d) => d > B4_LONG), `B4: no long task over ${B4_LONG} ms while panning (${full.long.length ? full.long.join(', ') + ' ms' : 'none'})`);
    ok(full.p95 <= limit, `B4: rAF interval p95 ${full.p95.toFixed(1)} ms ≤ max(${B4_FLOOR}, 1.25 × ${base.p95.toFixed(1)}) = ${limit.toFixed(1)} ms`);
  }
  /** B6: 10 host moves of `ids`, from (x0, y0), each followed by its save (throttled to one a second): once IndexedDB holds that seq, perf.lastSaveSyncMs is that save's main-thread part. */
  async function savesB6(ids, x0, y0) {
    const room = host.url().match(/#room~([0-9a-f]+)/)[1], saveMs = [];
    let items = 0;
    for (let k = 0; k < 10; k++) {
      const m = { id: ids[(k * 37) % ids.length], x: x0 + 25 * k, y: y0 - 25 * k };
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
  }
  /** How many players page p sees connected, itself included (its "● n"). */
  const here = (p) => p.$eval('#net-status', (el) => +(/● (\d+)/.exec(el.textContent)?.[1] || 1));
  /** How many face images page p has drawn. */
  const drawn = (p) => p.evaluate(() => [...document.querySelectorAll('.item img.face')].filter((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0).length);
  /** B8: the 40-image deck `deck` is dealt face up from (x0, y0); Bob pulls
   *  it (`pulls`; else he holds its images already), then reloads: nothing comes again. */
  async function rejoinB8(deck, x0, y0, pulls, extra = '') {
    for (let k = 0; k < 40; k++) await L.act(host, { t: 'deal', id: deck.pile, up: true, x: x0 + (k % 8) * 120, y: y0 + Math.floor(k / 8) * 160 });
    ok(await L.until(async () => (await drawn(mover)) === 40, 30000), `Bob ${pulls ? 'pulls them' : 'has them'}: 40 faces drawn`);
    const pulled = await mover.evaluate(() => window.__rtc.recv.asset || 0);
    if (pulls) ok(pulled > 0, `(${pulled} asset bytes received)`);
    await mover.addInitScript(A.needLog);
    for (let k = 1; ; k++) { // (a reload whose links never formed — the harness's signalling stall, see t-p1-delta — is tried again)
      await mover.reload();
      if (await mover.waitForFunction((n) => document.querySelectorAll('.item').length >= n, extra ? 1040 : 40, { timeout: 45000 }).then(() => true, () => false)) break;
      const linked = (await here(mover)) >= 3;
      console.log(`  (Bob's reload, try ${k}: no table after 45 s; he sees ${await here(mover)} players, the host ${await here(host)})`);
      if (linked || k === 3) throw new Error(`Bob's reload never got the table (${linked ? 'linked to everyone' : 'never linked to the host'})`);
    }
    ok(await L.until(async () => (await drawn(mover)) === 40, 30000), `Bob reloads: 40 faces drawn again${extra}`);
    await h.sleep(2000); // a request, had he sent one, would be answered by now
    const again = await mover.evaluate(() => ({ bytes: window.__rtc.recv.asset || 0, needs: window.__needs.length }));
    ok(again.bytes === 0 && again.needs === 0, `B8: 0 asset bytes re-sent (${again.bytes} B, ${again.needs} image requests)`);
  }

  section('an empty large table (the B4 baseline)');
  await L.act(host, { t: 'size', size: 2400 });
  for (const id of Object.keys((await L.view(host)).items)) await L.act(host, { t: 'del', id });
  ok(await L.until(async () => { const v = await L.view(phone); return v.table.w === 2400 && !Object.keys(v.items).length; }, 15000), // (Phase 2: the size is table.w)
    'the phone shows an empty table, 2400 units across');
  const base = await panOn('empty table');

  section('the 1,000-card table');
  await L.act(host, { t: 'setRules', code: BUILD, enabled: true });
  const built = await L.until(() => phone.evaluate(() => Object.values(window.__ct.view().items).filter((it) => it.k === 'c').length >= 1000
    && document.querySelectorAll('.item').length >= 1000), 90000, 500);
  const counts = await phone.evaluate(() => ({ cards: Object.values(window.__ct.view().items).filter((it) => it.k === 'c').length, dom: document.querySelectorAll('.item').length }));
  ok(built, `the guests hold 1,000 cards (${counts.cards} cards, ${counts.dom} elements on the phone)`);
  await h.sleep(2000);

  section("B1' and B3: 50 moves by one guest, as the other guest receives them");
  const cards = await mover.evaluate(() => { const v = window.__ct.view(); return Object.keys(v.items).filter((id) => v.items[id].k === 'c').sort(); });
  await movesB1B3(cards, 1150, 1130, 320, 320);

  section('B4: panning the 1,000-card table on the phone');
  await panB4(base, '1,000 cards');

  section('B6: the host saves the 1,000-card table');
  await savesB6(cards, 900, 1500);

  section('B8: a guest with a 40-image deck rejoins on a warm cache');
  const deck = await A.addDeck(host, A.imgDeck('Forty', A.tinyPngs(40, 8)), 1150, 1130);
  ok(deck.ok && deck.pile, 'the host adds a deck of 40 images');
  await rejoinB8(deck, 700, 700, true);

  // --- Phase 2 (spec §2k): the same budgets on 1,000 pieces, then B10 and B11 ---
  section('§2k: an empty 6000 × 4000 table (the B4 baseline for the pieces)');
  ok((await L.act(host, { t: 'setRules', enabled: false })).ok && (await L.act(host, { t: 'loadBox', box: P.BENCH, setup: false, clear: true })).ok,
    'the host clears the table and takes the bench box\'s table (loadBox without its setup)');
  ok(await L.until(async () => { const v = await L.view(phone); return v.table.shape === 'rect' && v.table.w === 6000 && v.table.h === 4000 && !Object.keys(v.items).length; }, 15000),
    'the phone shows an empty 6000 × 4000 rectangle');
  const pbase = await panOn('empty rectangle');

  section('§2k: the 1,000-piece bench box, loaded with __ct.act({t: \'loadBox\', box, setup: true, clear: true})');
  ok((await L.act(host, { t: 'loadBox', box: P.BENCH, setup: true, clear: true })).ok, 'the host loads it');
  const kinds = async (p) => p.evaluate(() => {
    const v = window.__ct.view(), boxes = window.__ct.boxes(), n = {};
    for (const it of Object.values(v.items)) {
      const [b, t] = (it.t || it.b || '/').split('/'), k = it.k === 'g' ? (it.t ? boxes[b]?.types[t]?.kind : boxes[b]?.backs[t] && 'tile') : it.k;
      n[k] = (n[k] || 0) + 1;
    }
    return { n, dom: document.querySelectorAll('.item').length, ph: document.querySelectorAll('.pface.placeholder').length };
  });
  ok(await L.until(async () => { const k = await kinds(phone); return k.dom >= 1000 && !k.ph; }, 60000, 300), 'the phone draws it');
  const got = await kinds(phone);
  ok(L.same(got.n, { board: 1, token: 600, tile: 250, die: 50, s: 60, b: 39 }) && got.dom === 1000,
    `1 board, 600 tokens, 250 tiles (100 face down), 50 dice, 60 supplies, 39 bags: ${JSON.stringify(got.n)}, ${got.dom} elements on the phone`);
  await h.sleep(2000);

  section('§2k B10: a guest renders a 1,000-piece snapshot — a new guest joins the table');
  /** A page's side of a join, for the log: {items (its view), dom, ph (shown now), maxPh, perf, net}. */
  const state = (p) => p.evaluate(() => ({ items: Object.keys(window.__ct?.view().items || {}).length, dom: document.querySelectorAll('.item').length,
    ph: document.querySelectorAll('.pface.placeholder').length, maxPh: window.__ph, perf: window.__ct?.perf, net: document.getElementById('net-status')?.title }));
  /** A new guest `name` (a fresh page: `o.ctx` its device, `o.slow` CPU × 2
   *  from before it loads) joins and draws the table; its page is closed
   *  afterwards. A page whose WebRTC links never all formed (the harness's
   *  signalling stall, see t-p1-delta) is replaced by a fresh one, and
   *  logged; one linked to everyone that still gets no table fails. Returns
   *  {ms: lastSnapRenderMs, ph: the most "?" shown at once, dom, drawn, done:
   *  whether every piece showed its face}. */
  async function joinRender(name, o = {}) {
    for (let attempt = 1; ; attempt++) {
      const p = await env.page(name, { ctx: o.ctx });
      await p.addInitScript(placeholderWatch);
      const unthrottle = o.slow ? await throttle(p) : null;
      try {
        await p.goto(host.url());
        await h.joinAs(p, name);
        if (await p.waitForFunction(() => Object.keys(window.__ct?.view().items || {}).length >= 1000, null, { timeout: 45000 }).then(() => true, () => false)) {
          const done = await p.waitForFunction(() => window.__ct.perf.lastSnapRenderMs > 0 && document.querySelectorAll('.item').length >= 1000 && !document.querySelector('.pface.placeholder'), null, { timeout: 30000 })
            .then(() => true, () => false);
          if (!done) console.log(`  (${name} has the table but never drew it all: ${JSON.stringify(await state(p))})`);
          await h.sleep(1500); // (the snapshot that registers the player redraws nothing: it doesn't count)
          return { ...(await p.evaluate(() => ({ ms: window.__ct.perf.lastSnapRenderMs, ph: window.__ph, dom: document.querySelectorAll('.item').length, drawn: window.__ct.perf.drawn }))), done };
        }
        const linked = (await here(p)) >= 4;
        console.log(`  (${name}, try ${attempt}: no table after 45 s: ${JSON.stringify(await state(p))}; the host: "${await host.evaluate(() => document.getElementById('net-status').title)}")`);
        if (linked) throw new Error(`${name}, linked to everyone, never got the table`);
        if (attempt === 3) { ok(false, `${name} could join: three fresh pages never linked to the host (see above)`); return null; }
      } finally {
        await unthrottle?.();
        await p.context().close();
      }
    }
  }
  for (const [what, o, max] of [['desktop', {}, B10_DESK], ['iPhone 13 at CPU × 2', { ctx: P.PHONE, slow: true }, B10_PHONE]]) {
    const runs = [];
    for (let k = 0; k < 3; k++) runs.push(await joinRender(`${o.slow ? 'Phi' : 'Dee'}${k + 1}`, o));
    if (runs.includes(null)) continue;
    console.log(`  ${what}: ${runs.map((r) => `${r.ms.toFixed(1)} ms (${r.dom} items, ${r.drawn} drawn, at most ${r.ph} "?" at once)`).join('; ')}`);
    ok(runs.every((r) => r.done), `${what}: each new guest draws the whole table, every piece with its face`);
    ok(runs.every((r) => r.ms > 0 && r.ms <= max), `B10, ${what}: each join's snapshot render (lastSnapRenderMs) ≤ ${max} ms: ${runs.map((r) => r.ms.toFixed(1)).join(', ')} ms`);
    ok(runs.every((r) => r.ph === 0 && r.drawn === r.dom),
      `B10, ${what}: and that render is the table's: its pieces drawn with their faces once, never as "?" placeholders waiting for the box (at most ${Math.max(...runs.map((r) => r.ph))} "?" at once; ${runs.map((r) => r.drawn).join(', ')} items drawn for ${runs[0].dom})`);
  }

  section("§2k B1' and B3: 50 moves of pieces by one guest, as the other guest receives them");
  const tokens = await mover.evaluate(() => { const v = window.__ct.view(); return Object.keys(v.items).filter((id) => v.items[id].k === 'g' && v.items[id].z >= 0 && /\/tok$/.test(v.items[id].t)).sort(); });
  ok(tokens.length === 600, `(Bob moves tokens: ${tokens.length} of them)`);
  await movesB1B3(tokens, 2970, 1970, 900, 500);

  section('§2k B4: panning the 1,000-piece table on the phone');
  await panB4(pbase, '1,000 pieces');

  section('§2k B6: the host saves the 1,000-piece table');
  await savesB6(tokens, 2500, 2900);

  section('§2k B10: a snapshot asked for after a lost patch (the boxes already here)');
  for (const [p, what, max] of [[mover, 'desktop', B10_DESK], [phone, 'iPhone 13 at CPU × 2', B10_PHONE]]) {
    const runs = [];
    for (let k = 0; k < 3; k++) {
      ok((await L.act(host, { t: 'clear' })).ok, `(${what}, run ${k + 1}: the host clears the table)`);
      await p.waitForFunction(() => !document.querySelector('.item'), null, { timeout: 30000 });
      const snaps = await p.evaluate(() => { window.__rtc.drop.push('patch'); return window.__ct.perf.snaps; });
      const unthrottle = p === phone ? await throttle(p) : null;
      try {
        await L.act(host, { t: 'loadBox', box: P.BENCH, setup: true }); // its patch is lost on p…
        await p.waitForFunction(() => !window.__rtc.drop.length, null, { timeout: 30000 });
        const anId = Object.keys((await L.view(host)).items)[0];
        await L.act(host, { t: 'rot', id: anId, rot: 0 }); // …so the next shows a gap, and p asks for a snapshot
        await L.act(host, { t: 'rot', id: anId, rot: 90 });
        ok(await p.waitForFunction((n) => window.__ct.perf.snaps > n && document.querySelectorAll('.item').length >= 1000, snaps, { timeout: 60000 }).then(() => true, () => false),
          `(${what}, run ${k + 1}: the setup's patch is lost, and the snapshot asked for draws the table)`);
        await h.sleep(1000);
      } finally { await unthrottle?.(); }
      runs.push(await p.evaluate(() => ({ ms: window.__ct.perf.lastSnapRenderMs, ph: document.querySelectorAll('.pface.placeholder').length, dom: document.querySelectorAll('.item').length })));
    }
    console.log(`  ${what}: ${runs.map((r) => `${r.ms.toFixed(1)} ms (${r.dom} items, ${r.ph} "?")`).join('; ')}`);
    ok(runs.every((r) => r.ms > 0 && r.ms <= max && !r.ph && r.dom >= 1000), `B10, ${what}: a 1,000-piece snapshot drawn with its faces in ≤ ${max} ms: ${runs.map((r) => r.ms.toFixed(1)).join(', ')} ms`);
  }

  section('§2k B8: a guest with the 40-image deck rejoins the 1,000-piece table on a warm cache');
  const deck2 = await A.addDeck(host, A.imgDeck('Forty', A.tinyPngs(40, 8)), 150, 150);
  ok(deck2.ok && deck2.pile, 'the host adds the same 40 images again, beside the bench');
  await rejoinB8(deck2, 5000, 100, false, ', and the 1,000 pieces');

  section('§2k B11: boardSVG of a 64 × 64 grid ≤ 30 ms, cached afterwards (in the page)');
  const b11 = await host.evaluate(async (v) => {
    const core = await import(`/cardtable/core.js?v=${v}`), pieces = await import(`/cardtable/pieces.js?v=${v}`);
    const grid = (g) => ({ kind: 'board', name: 'Grid', w: 6000, h: 6000, board: { grid: { cols: 64, rows: 64, cell: 90, x: 20, y: 20, ...g } } });
    const fills = {};
    for (let c = 0; c < 64; c++) for (let r = 0; r < 64; r++) fills[`${c},${r}`] = (c * 7 + r) % 3 ? '#ff000080' : '#0000ff80';
    const marks = Array.from({ length: 64 }, (_, k) => `${k},${(k * 7) % 64}`);
    const box = core.cleanBox({ name: 'B11', imgs: [], types: {
      squareChecker: grid({ type: 'square', draw: 'checker' }),
      squareCells: grid({ type: 'square', draw: 'cells', colors: ['#eeeeee', '#333333'] }),
      squareLines: grid({ type: 'square', draw: 'lines' }),
      squarePoints: grid({ type: 'square', snap: 'point', draw: 'lines', marks }),
      squareFilled: grid({ type: 'square', draw: 'checker', fills }),
      hexPointyCells: grid({ type: 'hex', hex: 'pointy', draw: 'cells' }),
      hexFlatChecker: grid({ type: 'hex', hex: 'flat', draw: 'checker' }),
      hexLines: grid({ type: 'hex', hex: 'pointy', draw: 'lines' }),
    } });
    const out = {};
    for (const [id, type] of Object.entries(box.types)) {
      const t0 = performance.now(), svg = pieces.boardSVG(type), t1 = performance.now(), again = pieces.boardSVG(type), t2 = performance.now();
      out[id] = { first: t1 - t0, cached: t2 - t1, same: again === svg, kb: svg.length / 1024, svg: svg.startsWith('<svg') && svg.includes('viewBox="0 0 6000 6000"') };
    }
    return out;
  }, h.MODULE_V);
  for (const [id, r] of Object.entries(b11)) console.log(`  ${id}: ${r.first.toFixed(2)} ms, then ${r.cached.toFixed(3)} ms (${r.kb.toFixed(0)} KB)`);
  ok(Object.keys(b11).length === 8 && Object.values(b11).every((r) => r.svg), 'eight 64 × 64 boards (square and hex, every draw mode, 4,096 fills, 64 marks) each draw an SVG over the board');
  ok(Object.values(b11).every((r) => r.first <= B11_MAX), `B11: each takes ≤ ${B11_MAX} ms the first time (max ${Math.max(...Object.values(b11).map((r) => r.first)).toFixed(2)} ms)`);
  ok(Object.values(b11).every((r) => r.same && r.cached <= 1), `B11: and is cached: the second call returns the same string in ≤ 1 ms (max ${Math.max(...Object.values(b11).map((r) => r.cached)).toFixed(3)} ms)`);
  await env.done();
})().catch(h.crash);
