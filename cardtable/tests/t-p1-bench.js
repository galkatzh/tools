// Browser benchmarks on a 1,000-card table (Phase 1, spec §1k), then on the
// 1,000-piece bench box (Phase 2, spec §2k): each budget is asserted, so a
// regression fails the suite. Timing-sensitive: run-all.sh runs it alone,
// after the parallel batch (its SERIAL list).
//   B1'  bytes per move on the wire, as the other guest receives them (Trystero
//        framing included): ≤ 1.5 KB
//   B3   a guest applies and draws a one-item patch: p95 ≤ 4 ms (__ct.perf.lastApplyMs)
//   B4   panning on an emulated phone (iPhone 13, CPU × 2): no long task over 50 ms
//        (from the pan's first event on: not the probe's search for bare felt),
//        and rAF interval p95 ≤ max(20 ms, 1.25 × the same pan over an empty table);
//        on the bench box, also five two-finger gestures (3 s of moves each)
//        over 1,000 ×3 stacks, whose badges turn back against the view (D91)
//        and grow on a table drawn small — both only once the fingers rest or
//        lift (D96, D102): a half-turn twist and a pinch from the fit to 12×
//        on 6000 × 4000, and a half-turn twist on 1800 × 1200, whose fit (and
//        the badges' exact size) changes by over 25% as it turns. The same
//        budgets while the fingers are down (after one gesture not measured:
//        the table's first turn off its axes, or first zoom that far, redraws
//        its layer once), then the badges settle with no task over 150 ms (a
//        restyle of the 1,000 badges: in a frame that also moved the table it
//        took 50–670 ms, where every frame of a twist paid it before D96).
//        Then the pinch in four legs: with 200 ms hesitations (no resize; no
//        task over 150 ms: a hesitation alone can let the browser raster the
//        layer again, 50–65 ms), and with rests just past PINCH_REST_MS,
//        where the badges resize and the fingers move on 50 ms later (no task
//        over 150 ms: a resize costs at a rest what it does at the lift).
//        Every pan and gesture row also counts the phone's layouts (CDP
//        Performance.getMetrics' LayoutCount, from its first event to 300 ms
//        after the lift): at most B4_LAYOUTS (15; 0–7 here), since after
//        each layout the browser hit-tests the whole table for hover (2–6 ms
//        at CPU × 2 with 1,000 pieces) — what placeSeats wrote in each frame
//        laid it out 81–101 times a pan, 86–88 a twist: the 33 ms frames of
//        D246. The 1,000-piece pan and the 6000 × 4000 twist run again with
//        a piece's own bar open beside it (placeBeside, which read its size
//        and wrote its left and top each frame: 178–181 layouts a pan,
//        302–355 a twist, D247)
//   B6   the host saves the 1,000-item table: every save's main-thread part ≤ 8 ms
//        (__ct.perf.lastSaveSyncMs, around doSave's synchronous IndexedDB put): ten
//        throttled saves (rapid play) and five unthrottled ones (a move 1.1 s
//        after the last save), after one unmeasured (see savesB6)
//   B8   a guest that pulled a 40-image deck reloads: 0 `asset` bytes received
//        (the __rtc byte counter, per channel), and no image asked for
// Phase 2 (§2k) re-runs B1', B3, B4, B6 and B8 on the bench box (P.BENCH: 1
// board, 600 tokens, 250 tiles, 50 dice, 60 supplies, 39 bags), loaded with
// __ct.act({t: 'loadBox', box, setup: true, clear: true}) — its Node budgets
// B1, B2, B5 and B7 are core-p2-bench.mjs's — and adds the two below. It runs
// first, the cards after it. A new page's links must form within LINK_MS
// (15 s; they take under a second): one that doesn't fails the suite.
//   B10  a guest renders a 1,000-piece snapshot (__ct.perf.lastSnapRenderMs): ≤ 400 ms
//        on a desktop, ≤ 1,500 ms on the iPhone 13 at CPU × 2: a new guest joining (and
//        drawing the pieces, never "?" placeholders), and a snapshot asked for after a
//        lost patch (the boxes already here)
//   B11  boardSVG of a 64 × 64 grid: ≤ 30 ms, then cached (in the page)
// Phase 3 (§3k) adds three on the 1,000-card table, whose rules run in a Worker:
//   B12  the Worker round trip of a host's move under a `validate` script
//        (__ct.perf.lastRulesRoundtripMs: from the post to its patch applied):
//        ≤ 3 ms median, ≤ 8 ms p95, over 50 moves after 10 not measured, each
//        from a settled page (60 ms after the last, past a frame: the last
//        move's broadcast and drawing, otherwise in the window, are B3's and B5's)
//   B14  an infinite loop in onAction: the rules are off within 4 s + 1 s, and
//        during the hang a host click (opening the log panel) is handled —
//        its event's timeStamp to the panel's change — in < 100 ms
//   B15  a Worker starting over the table and the CAH decks (__ct.perf.lastRulesInitMs:
//        spawn to `ready`): ≤ 300 ms, at each of three Enables
const h = require('./h');
const L = require('./p1-lib');
const A = require('./assets-lib');
const P = require('./p2t-lib');
const { ok, section } = h;

const B1_MAX = 1.5 * 1024, B3_MAX = 4, B4_LONG = 50, B4_SETTLE = 150, B4_FLOOR = 20, B4_LAYOUTS = 15, B6_MAX = 8, B10_DESK = 400, B10_PHONE = 1500, B11_MAX = 30;
const B12_MEDIAN = 3, B12_P95 = 8, B14_MS = 5000, B14_CLICK = 100, B15_MAX = 300;
const PAN_MS = 3000, GESTURE_MS = 3000, HESITATE_MS = 200; // (a pause of the fingers shorter than a rest: PINCH_REST_MS)

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

/** Counts page p's layouts from now on (CDP Performance.getMetrics'
 *  LayoutCount): returns a function that says how many there were, and stops. */
async function layouts(p) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Performance.enable');
  const count = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount').value;
  const n0 = await count();
  return async () => {
    const n = (await count()) - n0;
    await cdp.detach().catch((err) => console.error('CDP detach failed', err));
    return n;
  };
}

/** A 3 s felt-drag pan on page p, under CDP CPU throttling × 2: pointer events
 *  driven once per animation frame, rAF timestamps and long tasks collected in
 *  the page. Returns {gaps (ms between frames), long (long-task durations), moved,
 *  layouts (the page's, from before the pan to 300 ms after it: layouts())}. */
async function pan(p) {
  const unthrottle = await throttle(p), laid = await layouts(p);
  try {
    const r = await p.evaluate(async (ms) => {
      const table = document.getElementById('table'), r = document.getElementById('table-wrap').getBoundingClientRect();
      let start = null; // a spot of bare felt: on the table, on no item
      for (let k = 0; k < 2000 && !start; k++) {
        const x = r.left + (r.width * ((k * 37) % 101)) / 101, y = r.top + (r.height * ((k * 53) % 103)) / 103;
        const el = document.elementFromPoint(x, y);
        if (el && table.contains(el) && !el.closest('.item')) start = { x, y, el };
      }
      if (!start) throw new Error('no bare felt to start a pan on');
      // The search above is the probe's, not the pan's: on a table full of
      // cards its thousand hit tests make a long task of this very task (one
      // that ends after an observer starts here is reported to it). The
      // observer starts in a task of its own, before the pan's first event.
      await new Promise((res) => setTimeout(res, 0));
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
    return { ...r, layouts: await laid() };
  } finally { await unthrottle(); }
}

/** A two-finger gesture on page p over GESTURE_MS of moves, under CDP CPU
 *  throttling × 2, driven once per animation frame: two touch pointers
 *  opposite each other about the table area's centre turn `turn` half-turns
 *  while their half-distance goes from `from` to `to` px, geometrically (both
 *  by default a fifth of the area's smaller side: a twist alone), in `legs`
 *  equal legs with the fingers held still `pause` ms between them; rAF
 *  timestamps and long tasks collected in the page. Returns {gaps (ms
 *  between frames), long (the durations of the long tasks while the fingers
 *  are down), settle (theirs from the task where they lift on: the badges
 *  settle there), turned (degrees the view turned), zoomed (the factor its
 *  scale grew by), pauses (at the end of each pause: {bz (the view sheet's
 *  --bz), want (the --bz the scale calls for)}), layouts (as pan's)}. */
async function gesture(p, { turn = 0, from, to, legs = 1, pause = 0 } = {}) {
  const unthrottle = await throttle(p), laid = await layouts(p);
  try {
    const r = await p.evaluate(async ([ms, turn, from, to, legs, pause]) => {
      const table = document.getElementById('table'), r = document.getElementById('table-wrap').getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = Math.min(r.width, r.height) / 5, d0 = from ?? R, d1 = to ?? R;
      const tf = (k) => +new RegExp(`${k}\\(([-\\d.e]+)`).exec(table.style.transform)[1];
      // (--bz read from its rule, not a badge's computed style: that would restyle them here)
      const bzRule = [...document.adoptedStyleSheets].flatMap((s) => [...s.cssRules]).find((x) => x.style?.getPropertyValue('--bz'));
      const pauses = [], span = ms / legs, cycle = span + pause;
      await new Promise((res) => setTimeout(res, 0)); // (the observer starts in a task of its own: see pan)
      const tasks = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e); });
      po.observe({ type: 'longtask' });
      const ev = (type, id, x, y) => new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
      /** The two fingers at time t (0 to 1 of the gesture). */
      const fingers = (t) => {
        const a = turn * Math.PI * t, d = d0 * (d1 / d0) ** t;
        return [[7, cx + d * Math.cos(a), cy + d * Math.sin(a)], [8, cx - d * Math.cos(a), cy - d * Math.sin(a)]];
      };
      const a0 = tf('rotate'), s0 = tf('scale');
      for (const [id, x, y] of fingers(0)) table.dispatchEvent(ev('pointerdown', id, x, y));
      const frames = [];
      await new Promise((done) => {
        const t0 = performance.now();
        const step = (ts) => {
          frames.push(ts);
          const t = ts - t0, k = Math.min(legs - 1, Math.floor(t / cycle)), into = t - k * cycle;
          if (t >= legs * cycle - pause) { done(); return; }
          if (into < span) { // leg k moves (its first frame closes the pause before it)
            if (pauses.length < k) pauses.push({ bz: +bzRule.style.getPropertyValue('--bz'), want: Math.min(3, Math.max(1, 0.67 / tf('scale'))) });
            for (const [id, x, y] of fingers((k + into / span) / legs)) window.dispatchEvent(ev('pointermove', id, x, y));
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const turned = (((tf('rotate') - a0) % 360) + 360) % 360, zoomed = tf('scale') / s0, up = performance.now();
      for (const [id, x, y] of fingers(1)) window.dispatchEvent(ev('pointerup', id, x, y));
      await new Promise((res) => setTimeout(res, 300)); // the observer delivers late entries
      po.disconnect();
      const dur = (es) => es.map((e) => Math.round(e.duration)); // (a task that holds the lift began before it, in the same frame)
      return { gaps: frames.slice(1).map((t, k) => t - frames[k]), long: dur(tasks.filter((e) => e.startTime + e.duration < up)), settle: dur(tasks.filter((e) => e.startTime + e.duration >= up)), turned, zoomed, pauses };
    }, [GESTURE_MS, turn, from, to, legs, pause]);
    return { ...r, layouts: await laid() };
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
    console.log(`  ${what}: ${r.gaps.length} frames, rAF p95 ${p95.toFixed(1)} ms, long tasks [${r.long}], ${r.layouts} layouts`);
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
      const to = await phone.evaluate((m) => window.__ct.snap(m.id, m.x, m.y), m); // (Phase 3: a piece on the board snaps to its cell)
      await L.act(mover, { t: 'move', ...m });
      await phone.waitForFunction(([m, to]) => { const it = window.__ct.view().items[m.id]; return it && it.x === to.x && it.y === to.y; }, [m, to], { timeout: 10000 });
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
    ok(full.layouts <= B4_LAYOUTS, `B4: the pan lays the page out ${full.layouts} times in ${full.gaps.length} frames (≤ ${B4_LAYOUTS}: each is followed by the browser's hover hit test of the whole table)`);
  }
  /** Where the phone's bar is: {open (shown, beside its piece: not a docked row), x, y (its centre, client px), text}. */
  const barNow = () => phone.evaluate(() => {
    const b = document.getElementById('action-bar'), r = b.getBoundingClientRect();
    return { open: !b.classList.contains('hidden') && !b.classList.contains('row'), x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent };
  });
  /** The phone taps items of `ids` drawn on top of their spots near the
   *  table area's middle, one after another, until one's own bar opens
   *  beside it (a tap on a stack's ×N badge opens the inspector instead:
   *  Esc closes it). Returns its id and the bar (barNow), or null. */
  async function tapOne(ids) {
    const qs = await phone.evaluate((ids) => {
      const w = document.getElementById('table-wrap').getBoundingClientRect(), out = [];
      for (const id of ids) {
        const r = document.querySelector(`.item[data-id="${id}"]`)?.getBoundingClientRect(), x = r && r.left + r.width / 2, y = r && r.top + r.height / 2;
        if (r && Math.abs(x - w.left - w.width / 2) < w.width / 5 && Math.abs(y - w.top - w.height / 2) < w.height / 5 && document.elementFromPoint(x, y)?.closest('.item')?.dataset.id === id) out.push({ id, x, y });
      }
      return out.slice(0, 12);
    }, ids);
    for (const q of qs) {
      await phone.touchscreen.tap(q.x, q.y);
      if (await L.until(async () => (await barNow()).open, 1500, 100)) return { id: q.id, ...(await barNow()) };
      await phone.keyboard.press('Escape');
      await h.sleep(300);
    }
    return null;
  }
  /** The phone puts its piece's bar away (Esc). */
  const unselect = async () => { await phone.keyboard.press('Escape'); await L.until(async () => !(await barNow()).open, 5000, 100); };
  /** B6: host moves of `ids`, from (x0, y0), each followed by its save: once IndexedDB holds that
   *  seq, perf.lastSaveSyncMs is that save's main-thread part. Saves are throttled to one a second
   *  (app.js persist), so play takes two paths, both measured: ten moves made right after the last
   *  save (rapid play) wait out the throttle; five made 1.1 s after it (unhurried, turn-based play)
   *  start their save as soon as the app starts one, SAVE_DEFER_MS after the move (out of its burst
   *  of work). A first move and save, after the idle pan, go unmeasured (that one ran slow alone in
   *  some earlier series: 10.0 ms once). */
  async function savesB6(ids, x0, y0) {
    const room = host.url().match(/#room~([0-9a-f]+)/)[1], ms = { 'throttled (rapid play)': [], 'unthrottled (a move 1.1 s after the last save)': [] }, [thr, once] = Object.values(ms);
    let items = 0;
    for (let k = -1; k < 15; k++) {
      if (k >= 10) await h.sleep(1100);
      const m = { id: ids.at((k * 37) % ids.length), x: x0 + 25 * k, y: y0 - 25 * k };
      const to = await host.evaluate((m) => window.__ct.snap(m.id, m.x, m.y), m); // (Phase 3: a piece on the board snaps to its cell)
      await L.act(host, { t: 'move', ...m });
      await host.waitForFunction(([m, to]) => { const it = window.__ct.view().items[m.id]; return it && it.x === to.x && it.y === to.y; }, [m, to], { timeout: 10000 });
      const seq = await host.evaluate(() => window.__ct.view().seq);
      let rec = null;
      const saved = await L.until(async () => (rec = await h.idb(host, 'saves', room))?.state?.seq >= seq, 15000, 100);
      if (!saved) { ok(false, `B6: the save of seq ${seq} reached IndexedDB (it holds ${rec?.state?.seq})`); break; }
      items = Object.keys(rec.state.items).length;
      if (k >= 0) (k < 10 ? thr : once).push(await host.evaluate(() => window.__ct.perf.lastSaveSyncMs));
    }
    for (const [path, xs] of Object.entries(ms)) {
      console.log(`  lastSaveSyncMs per save, ${path}: ${xs.map((x) => x.toFixed(2)).join(', ')} ms (${items} items saved)`);
      ok(xs.length === (xs === thr ? 10 : 5) && items >= 1000 && xs.every((x) => x > 0 && x <= B6_MAX),
        `B6, ${path}: each of ${xs.length} saves of ${items} items takes ≤ ${B6_MAX} ms on the main thread (max ${Math.max(...xs).toFixed(2)} ms)`);
    }
  }
  /** How many players page p sees connected, itself included (its "● n"). */
  const here = (p) => p.$eval('#net-status', (el) => +(/● (\d+)/.exec(el.textContent)?.[1] || 1));
  /** Page p's net status tooltip (who it sees, its relays), for a failure's message. */
  const netTitle = (p) => p.$eval('#net-status', (el) => el.title).catch((e) => `unreadable: ${e.message}`);
  const LINK_MS = 15000; // a new page's links form in well under a second (D95)
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
    await mover.reload();
    // (his links form at once, or never: D95. Not retried — that hid the bug.)
    if (!(await L.until(async () => (await here(mover).catch(() => 0)) >= 3, LINK_MS, 250))) {
      throw new Error(`Bob's reload never linked to everyone in ${LINK_MS / 1000} s: he sees ${await here(mover).catch(() => '?')} players ("${await netTitle(mover)}"), the host "${await netTitle(host)}"`);
    }
    if (!(await mover.waitForFunction((n) => document.querySelectorAll('.item').length >= n, extra ? 1040 : 40, { timeout: 45000 }).then(() => true, () => false))) {
      throw new Error(`Bob's reload, linked to everyone, never got the table ("${await netTitle(mover)}")`);
    }
    ok(await L.until(async () => (await drawn(mover)) === 40, 30000), `Bob reloads: 40 faces drawn again${extra}`);
    await h.sleep(2000); // a request, had he sent one, would be answered by now
    const again = await mover.evaluate(() => ({ bytes: window.__rtc.recv.asset || 0, needs: window.__needs.length }));
    ok(again.bytes === 0 && again.needs === 0, `B8: 0 asset bytes re-sent (${again.bytes} B, ${again.needs} image requests)`);
  }

  // --- Phase 2 (spec §2k) first ---
  section('§2k: an empty 6000 × 4000 table (the B4 baseline for the pieces)');
  ok((await L.act(host, { t: 'loadBox', box: P.BENCH, setup: false, clear: true })).ok,
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
   *  afterwards. Its links must form within LINK_MS, and the table come in
   *  45 s: else the join fails (null), with what each side sees. Returns
   *  {ms: lastSnapRenderMs, ph: the most "?" shown at once, dom, drawn, done:
   *  whether every piece showed its face}. */
  async function joinRender(name, o = {}) {
    const p = await env.page(name, { ctx: o.ctx });
    await p.addInitScript(placeholderWatch);
    const unthrottle = o.slow ? await throttle(p) : null;
    try {
      await p.goto(host.url());
      await h.joinAs(p, name);
      const linked = await L.until(async () => (await here(p).catch(() => 0)) >= 4, LINK_MS, 250);
      if (!linked || !(await p.waitForFunction(() => Object.keys(window.__ct?.view().items || {}).length >= 1000, null, { timeout: 45000 }).then(() => true, () => false))) {
        ok(false, `${name} joins: ${linked ? 'linked to everyone, it never got the table' : `its links never formed in ${LINK_MS / 1000} s`} (${JSON.stringify(await state(p))}; the host: "${await netTitle(host)}")`);
        return null;
      }
      const done = await p.waitForFunction(() => window.__ct.perf.lastSnapRenderMs > 0 && document.querySelectorAll('.item').length >= 1000 && !document.querySelector('.pface.placeholder'), null, { timeout: 30000 })
        .then(() => true, () => false);
      if (!done) console.log(`  (${name} has the table but never drew it all: ${JSON.stringify(await state(p))})`);
      await h.sleep(1500); // (the snapshot that registers the player redraws nothing: it doesn't count)
      return { ...(await p.evaluate(() => ({ ms: window.__ct.perf.lastSnapRenderMs, ph: window.__ph, dom: document.querySelectorAll('.item').length, drawn: window.__ct.perf.drawn }))), done };
    } finally {
      await unthrottle?.();
      await p.context().close();
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

  section('§2k B4: the same pan with a token\'s own bar open beside it — it follows the view by translate, on the size it read before (D247)');
  let one = await tapOne(tokens);
  ok(!!one, `the phone taps a token: its bar opens beside it ("${one?.text}")`);
  await panB4(pbase, '1,000 pieces, a token\'s bar open');
  let after = await barNow();
  ok(after.open, `the bar is still open beside it after the pan ("${after.text}")`);
  await unselect();

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

  section('§2k B8: a guest with a 40-image deck rejoins the 1,000-piece table on a warm cache');
  const deck0 = await A.addDeck(host, A.imgDeck('Forty', A.tinyPngs(40, 8)), 150, 150);
  ok(deck0.ok && deck0.pile, 'the host adds a deck of 40 images beside the bench');
  await rejoinB8(deck0, 5000, 100, true, ', and the 1,000 pieces');

  /** Loads 1,000 stacks of 3 chips on a w × h rectangle (20 rows of 50 from
   *  `at`, `step` apart), and waits for the phone to draw them. */
  async function loadStacks(w, h, at, step) {
    const box = { name: 'Stacks', imgs: [], table: { shape: 'rect', w, h }, types: { chip: { kind: 'token', name: 'Chip', faces: [{ color: '#facc15' }] } },
      setup: Array.from({ length: 20 }, (_, k) => ({ piece: 'chip', n: 3, at: [at[0], at[1] + step[1] * k], count: 50, spread: [step[0], 0] })) };
    ok((await L.act(host, { t: 'loadBox', box, setup: true, clear: true })).ok, `the host loads 1,000 stacks of 3 chips on a ${w} × ${h} table`);
    ok(await phone.waitForFunction((w) => window.__ct.view().table.w === w && document.querySelectorAll('.item > .count').length >= 1000, w, { timeout: 60000 }).then(() => true, () => false), 'the phone draws them, with their ×3');
  }
  /** The phone's view back to the fit at its seat (🧭), and a second to settle. */
  const refit = async () => { await phone.tap('#view-btn'); await h.sleep(1000); };
  /** B4 for a two-finger gesture `g` (gesture's options) on the phone, from
   *  the fit; `what` it is. A first one is not measured: the first time the
   *  table turns off its axes, or zooms that far, the browser draws its layer
   *  again once, text included (a 60–200 ms frame with these 1,000 ×3 badges,
   *  none with plain chips, and never again on the page). Budgets: no task
   *  over `long` ms while the fingers are down; the rAF p95 of a pan (`p95`:
   *  off for a pinch with pauses, whose moves are the pinch's, its pauses
   *  idle frames); no settle task over B4_SETTLE. Returns the measured one. */
  async function gestureB4(what, g, { long = B4_LONG, p95: tight = true } = {}) {
    await refit();
    const warm = await gesture(phone, g);
    console.log(`  (a first ${what}, not measured: long tasks [${warm.long}], then [${warm.settle}] as the fingers lift)`);
    await refit();
    const r = await gesture(phone, g), p95 = L.pct(r.gaps, 95), limit = Math.max(B4_FLOOR, 1.25 * pbase.p95);
    console.log(`  ${what}: ${r.gaps.length} frames, turned ${r.turned.toFixed(1)}°, zoomed ${r.zoomed.toFixed(2)}×, rAF p95 ${p95.toFixed(1)} ms, long tasks [${r.long}], then [${r.settle}] as the fingers lift, ${r.layouts} layouts`);
    ok(!r.long.some((d) => d > long), `B4: no ${long === B4_LONG ? 'long task' : 'task'} over ${long} ms while the fingers are down (${r.long.length ? r.long.join(', ') + ' ms' : 'none over 50 ms'})`);
    if (tight) ok(p95 <= limit, `B4: rAF interval p95 ${p95.toFixed(1)} ms ≤ max(${B4_FLOOR}, 1.25 × ${pbase.p95.toFixed(1)}) = ${limit.toFixed(1)} ms`);
    ok(!r.settle.some((d) => d > B4_SETTLE), `B4: as they lift, the 1,000 badges settle (upright, their exact size) in one go, no task over ${B4_SETTLE} ms (${r.settle.length ? r.settle.join(', ') + ' ms' : 'none over 50 ms'})`);
    ok(r.layouts <= B4_LAYOUTS, `B4: the gesture lays the page out ${r.layouts} times in ${r.gaps.length} frames, the lift's included (≤ ${B4_LAYOUTS})`);
    return r;
  }
  /** The phone's badges after the lift, and what this view calls for: {view, rot (--view and the view's turn), bz, want (--bz and its exact value)}. */
  const badges = () => phone.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.item > .count')), t = document.getElementById('table').style.transform, s = +/scale\(([-\d.e]+)\)/.exec(t)[1];
    return { view: parseFloat(cs.getPropertyValue('--view')), rot: +/rotate\(([-\d.e]+)deg\)/.exec(t)[1], bz: +cs.getPropertyValue('--bz'), want: Math.min(3, Math.max(1, 0.67 / s)) };
  });

  section('§2k B4: a two-finger twist on the phone, over 1,000 ×3 stacks (each badge turns back against the view: D91, D96)');
  await loadStacks(6000, 4000, [600, 400], [100, 160]);
  const tw = await gestureB4('twist (half a turn)', { turn: 1 });
  ok(tw.gaps.length > 30 && Math.abs(tw.turned - 180) < 20, `the scripted twist turns the view (${tw.turned.toFixed(1)}°, ${tw.gaps.length} frames)`);
  let b = await badges();
  ok(Math.abs(b.view - b.rot) < 0.01, `once the fingers lift, the badges turn back by the view's exact angle (${b.view}°, the view ${b.rot}°)`);

  section('§2k B4: the twist with a stack\'s own bar open beside it, which turns about the view with its stack (D247)');
  await refit();
  one = await tapOne(await phone.evaluate(() => Object.keys(window.__ct.view().items)));
  ok(!!one, `the phone taps a stack: its bar opens beside it ("${one?.text}")`);
  const twb = await gestureB4('twist (half a turn), a stack\'s bar open', { turn: 1 });
  after = await barNow();
  const at = await P.itemXY(phone, one.id);
  ok(twb.gaps.length > 30 && Math.abs(twb.turned - 180) < 20 && after.open && Math.hypot(after.x - at.x, after.y - at.y) < 160,
    `the twist turns the view (${twb.turned.toFixed(1)}°), the bar still open beside its stack (${Math.round(Math.hypot(after.x - at.x, after.y - at.y))} px from it)`);
  await unselect();

  section('§2k B4 (pinch): a pinch-zoom on the phone from the fit to 12×, over the same stacks (their size waits for a rest of the fingers, or the lift: D96)');
  const pz = await gestureB4('pinch', { from: 20, to: 240 });
  ok(pz.gaps.length > 30 && Math.abs(pz.zoomed - 12) < 0.5, `the scripted pinch zooms the view (${pz.zoomed.toFixed(2)}×, ${pz.gaps.length} frames)`);
  b = await badges();
  ok(Math.abs(b.bz - b.want) < 0.006, `once the fingers lift, the badges take the zoom's size (--bz ${b.bz}, ${b.want.toFixed(3)} wanted)`);
  const step = (x, y) => Math.max(x / y, y / x), sizes = (r) => r.pauses.map((m) => `${m.bz} for ${m.want.toFixed(2)}`).join(', ');

  section(`§2k B4 (paused pinch): the same pinch in four legs, the fingers hesitating ${HESITATE_MS} ms between them, shorter than a rest (${P.PINCH_REST_MS} ms): the badges keep their size (D102)`);
  // (Its task budget is B4_SETTLE's: a hesitation alone can let the browser
  // raster the layer again at the new zoom, which the next move waits for,
  // 50–65 ms with --bz unchanged. What a too-short rest would cost, a
  // resize at a hesitation, the --bz check below catches.)
  const pp = await gestureB4('paused pinch', { from: 20, to: 240, legs: 4, pause: HESITATE_MS }, { long: B4_SETTLE, p95: false });
  ok(pp.pauses.length === 3 && pp.pauses.every((m) => m.bz === 3) && pp.pauses.some((m) => step(m.want, 3) > 1.25),
    `no hesitation resizes the badges, though the zoom calls for over 25% less at one (--bz at each: ${sizes(pp)})`);

  section(`§2k B4 (rested pinch): the same pinch in four legs, the fingers resting ${P.PINCH_REST_MS + 50} ms between them: at a rest the badges take the zoom's size if it differs by over 25%, and the fingers move on 50 ms later (D102)`);
  const rp = await gestureB4('rested pinch', { from: 20, to: 240, legs: 4, pause: P.PINCH_REST_MS + 50 }, { long: B4_SETTLE, p95: false });
  ok(rp.pauses.length === 3 && rp.pauses.every((m, k) => { const was = k ? rp.pauses[k - 1].bz : 3; return step(m.want, was) > 1.25 ? Math.abs(m.bz - m.want) < 0.006 : m.bz === was; })
    && rp.pauses.some((m) => m.bz !== 3), `at each rest the badges take the zoom's size if it differs from theirs by over 25%, and keep theirs otherwise (--bz at each: ${sizes(rp)})`);

  section('§2k B4 (twist, a rectangle that refits as it turns): 1,000 ×3 stacks on 1800 × 1200, where the badges\' exact size changes by over 25% as the view turns');
  await loadStacks(1800, 1200, [100, 100], [32, 50]);
  const tr = await gestureB4('twist (half a turn)', { turn: 1 });
  ok(tr.gaps.length > 30 && Math.abs(tr.turned - 180) < 20, `the scripted twist turns the view (${tr.turned.toFixed(1)}°, ${tr.gaps.length} frames)`);
  await refit();

  // --- Phase 1 (spec §1k): the 1,000-card table ---


  section('an empty large table (the B4 baseline)');
  await L.act(host, { t: 'clear' });
  await L.act(host, { t: 'size', size: 2400 });
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

  section('§3k B12: the rules Worker round trip of a host move under validate, at 1,000 cards');
  const VALIDATE = "({ name: 'Bench rules', validate(t, a) { if (a.t === 'move' && !t.item(a.id)) return 'no such card'; } })";
  ok((await L.act(host, { t: 'setRules', code: VALIDATE, enabled: true })).ok, 'the host enables a script with validate');
  const ids12 = await host.evaluate(() => { const v = window.__ct.view(); return Object.keys(v.items).filter((id) => v.items[id].k === 'c').slice(0, 60); });
  const rt = [];
  for (let k = 0; k < 60; k++) { // (each move from a settled page: the last one's broadcast sent, its frame drawn — 16 moves a second)
    const r = await host.evaluate(async ([id, x, y]) => {
      await new Promise((res) => setTimeout(() => requestAnimationFrame(() => setTimeout(res, 0)), 60));
      return { ok: (await window.__ct.act({ t: 'move', id, x, y })).ok, ms: window.__ct.perf.lastRulesRoundtripMs, worker: window.__ct.perf.lastRulesWorkerMs };
    }, [ids12[k], 700 + (k % 10) * 30, 1500 + (k % 7) * 20]);
    if (k >= 10 && r.ok) rt.push(r);
  }
  const rtMs = rt.map((r) => r.ms), med = L.pct(rtMs, 50), p95 = L.pct(rtMs, 95);
  console.log(`  round trips: median ${med.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${Math.max(...rtMs).toFixed(2)} ms; in the Worker: median ${L.pct(rt.map((r) => r.worker), 50).toFixed(2)} ms`);
  ok(rt.length === 50 && med <= B12_MEDIAN && p95 <= B12_P95, `B12: ${rt.length} moves' Worker round trips: median ${med.toFixed(2)} ms (≤ ${B12_MEDIAN}), p95 ${p95.toFixed(2)} ms (≤ ${B12_P95})`);

  section("B1' and B3: 50 moves by one guest, as the other guest receives them");
  const cards = await mover.evaluate(() => { const v = window.__ct.view(); return Object.keys(v.items).filter((id) => v.items[id].k === 'c').sort(); });
  await movesB1B3(cards, 1150, 1130, 320, 320);

  section('B4: panning the 1,000-card table on the phone');
  await panB4(base, '1,000 cards');

  section('B6: the host saves the 1,000-card table');
  await savesB6(cards, 900, 1500);

  section('B8: a guest with a 40-image deck rejoins on a warm cache');
  const deck = await A.addDeck(host, A.imgDeck('Forty', A.tinyPngs(40, 8)), 1150, 1130);
  ok(deck.ok && deck.pile, 'the host adds the deck of 40 images again (Bob pulled them on the piece table)');
  await rejoinB8(deck, 700, 700, false);

  section('§3k B15: a rules Worker starting over the 1,000 cards and the CAH decks');
  await h.enableRules(host, { tpl: 'cah' }); // (its setup registers the three CAH decks: the Enables below start over them)
  ok(await host.evaluate(() => window.__ct.view().rules?.name === 'Cards Against Humanity' && !window.__ct.lastRulesError), 'CAH runs, its decks in the catalog');
  const inits = [];
  for (let k = 0; k < 3; k++) {
    await h.enableRules(host, { tpl: 'cah' });
    inits.push(await host.evaluate(() => ({ ms: window.__ct.perf.lastRulesInitMs, items: Object.keys(window.__ct.view().items).length, err: window.__ct.lastRulesError })));
  }
  console.log(`  Worker starts: ${inits.map((r) => `${r.ms.toFixed(1)} ms (${r.items} items)`).join(', ')}`);
  ok(inits.every((r) => !r.err && r.items >= 1000 && r.ms > 0 && r.ms <= B15_MAX), `B15: each start, spawn to ready, ≤ ${B15_MAX} ms (${inits.map((r) => r.ms.toFixed(1)).join(', ')} ms)`);

  section('§3k B14: an infinite loop in onAction — the watchdog, and the host page during the hang');
  ok((await L.act(host, { t: 'setRules', enabled: true, code: "({ name: 'Hang', onAction(t, a) { if (a.t === 'rot') for (;;); } })" })).ok, 'the host enables a script that hangs on a turn');
  await host.evaluate(() => {
    const b = (window.__b14 = {});
    document.getElementById('log-btn').addEventListener('click', (e) => { b.click = e.timeStamp; }, { capture: true, once: true });
    new MutationObserver((_, o) => { b.dom = performance.now(); o.disconnect(); }).observe(document.getElementById('side'), { attributes: true });
  });
  const t14 = Date.now(), hung = L.act(host, { t: 'rot', id: cards[0], rot: 90 });
  await h.sleep(1500);
  await host.click('#log-btn');
  const r14 = await hung, took = Date.now() - t14;
  await host.waitForFunction(() => !window.__ct.view().rules.enabled, null, { timeout: 5000 }).catch(() => {});
  const b14 = await host.evaluate(() => ({ ...window.__b14, off: !window.__ct.view().rules.enabled, err: window.__ct.lastRulesError }));
  await host.click('#log-btn'); // (the panel closes again)
  ok(!r14.ok && b14.off && /longer than 4 s/.test(b14.err), `the rules stopped, the turn not applied (${b14.err})`);
  ok(took <= B14_MS, `B14: the rules are off ${took} ms after the action (≤ ${B14_MS})`);
  ok(b14.dom > b14.click && b14.dom - b14.click < B14_CLICK, `B14: a host click during the hang opens the log panel in ${(b14.dom - b14.click).toFixed(1)} ms (< ${B14_CLICK})`);

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
      const t0 = performance.now(), svg = pieces.boardSVG(type), t1 = performance.now(), again = pieces.boardSVG(type);
      // (the cached call timed three times, the fastest kept: one sample alone can hold a GC pause)
      const cached = Math.min(...[0, 1, 2].map(() => { const t = performance.now(); pieces.boardSVG(type); return performance.now() - t; }));
      out[id] = { first: t1 - t0, cached, same: again === svg, kb: svg.length / 1024, svg: svg.startsWith('<svg') && svg.includes('viewBox="0 0 6000 6000"') };
    }
    return out;
  }, h.MODULE_V);
  for (const [id, r] of Object.entries(b11)) console.log(`  ${id}: ${r.first.toFixed(2)} ms, then ${r.cached.toFixed(3)} ms (${r.kb.toFixed(0)} KB)`);
  ok(Object.keys(b11).length === 8 && Object.values(b11).every((r) => r.svg), 'eight 64 × 64 boards (square and hex, every draw mode, 4,096 fills, 64 marks) each draw an SVG over the board');
  ok(Object.values(b11).every((r) => r.first <= B11_MAX), `B11: each takes ≤ ${B11_MAX} ms the first time (max ${Math.max(...Object.values(b11).map((r) => r.first)).toFixed(2)} ms)`);
  ok(Object.values(b11).every((r) => r.same && r.cached <= 1), `B11: and is cached: the second call returns the same string, and a cached call takes ≤ 1 ms (the fastest of three; max ${Math.max(...Object.values(b11).map((r) => r.cached)).toFixed(3)} ms)`);
  await env.done();
})().catch(h.crash);
