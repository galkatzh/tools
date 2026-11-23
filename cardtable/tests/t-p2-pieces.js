// E2E (spec §2l "t-p2-pieces.js"): a free table of pieces played by hand on
// two screens, host Alice and guest Bob — once on a desktop viewport (mouse,
// Shift, double-click, the keys) and once on the iPhone 13 descriptor (touch:
// a drag from a ×N stack takes one, ✥ Move all, the long-press zoom; the
// bar stands in for double-clicks). Items 1–11 of §2l, the rest of §2g's
// gesture table, the keys, and the action bar for every kind and permission.
// Each check is read on BOTH screens: __ct.view(), the DOM (classes, badges,
// the bar's buttons) and the log. Gestures are real (mouse, keyboard, CDP
// touch); __ct.act only sets up state, and sends the refused actions a screen
// never offers (to see the refusal itself).
// A failed check saves both screens in shots/ (p2-pieces-<pass>-fail<k>-*.png).
//   ONLY=desktop|phone  runs one of the two passes
'use strict';
const h = require('./h');
const { section } = h;
const L = require('./p1-lib');
const { loadBox, at } = require('./p2-lib');
const { toastLog } = require('./assets-lib');
const { devices } = h.playwright;

// The test box: every kind of §2a. Bob sits North (top edge), so his view is
// turned 180°; every screen point is read from the page, never assumed.
const KIT = {
  name: 'Kit',
  imgs: [],
  table: { shape: 'rect', w: 1200, h: 800 },
  seats: [{ id: 'south', name: 'South', color: '#e11d48', edge: 'bottom' }, { id: 'north', name: 'North', color: '#2563eb', edge: 'top' }],
  backs: { cb: { face: { color: '#334155' } }, tb: { face: { color: '#1e3a8a' } }, cube: { face: { color: '#222222', label: '?' } } },
  types: {
    coin: { kind: 'token', name: 'Coin', faces: [{ color: '#facc15' }, { color: '#a16207' }] }, // 2 faces, stacks by count
    chit: { kind: 'token', name: 'Chit', faces: [{ color: '#16a34a' }], back: 'cb' },          // a back
    wheel: { kind: 'token', name: 'Wheel', stack: 'none', faces: [1, 2, 3, 4, 5, 6] },          // turns through 6 faces
    hex: { kind: 'tile', name: 'Hex', shape: 'hex', rotStep: 60, hand: false, stack: 'none', faces: [{ color: '#0ea5e9' }] },
    tile: { kind: 'tile', name: 'Tile', faces: [{ color: '#fef3c7', label: 'T', text: 'A tile' }], back: 'tb' }, // piles, hands, a back
    plain: { kind: 'tile', name: 'Plain', faces: [{ color: '#e9d5ff', label: 'P' }] },          // piles, hands, no back
    d6: { kind: 'die', name: 'Die' },
    hdie: { kind: 'die', name: 'Shadow die', back: 'cube' },                                    // hidden, alike from outside…
    htok: { kind: 'token', name: 'Masked', w: 56, shape: 'rect', stack: 'none', faces: [{ color: '#000000' }], back: 'cube' }, // …with this
    board: { kind: 'board', name: 'Map', w: 300, h: 300, board: { grid: { type: 'square', cols: 4, rows: 4, cell: 70, x: 10, y: 10, draw: 'checker', labels: 'chess' } } },
  },
  setup: [
    { piece: 'coin', n: 5, at: [60, 120] }, { piece: 'coin', n: 3, at: [180, 120] }, { piece: 'coin', at: [300, 120] },
    { piece: 'coin', f: 1, n: 2, at: [420, 120] }, { piece: 'chit', at: [540, 120] }, { piece: 'wheel', at: [660, 120] },
    { piece: 'hex', at: [780, 120] },
    { piece: 'd6', at: [60, 240] }, { piece: 'd6', count: 3, spread: [60, 0], at: [300, 240] }, // a lone die, and three side by side
    { piece: 'hdie', up: false, at: [560, 240] }, { piece: 'htok', up: false, at: [660, 240] }, { piece: 'chit', n: 2, up: false, at: [780, 240] },
    { supply: 'coin', at: [60, 360] }, { supply: 'plain', at: [180, 360] },
    { bag: [{ t: 'coin', n: 4 }], name: 'Pouch', at: [300, 360] }, { bag: [{ t: 'tile', n: 3 }], name: 'Tiles', at: [420, 360] },
    { piece: 'board', at: [840, 360] },
    { piece: 'tile', count: 4, spread: [120, 0], at: [60, 500] }, { piece: 'plain', at: [540, 500] },
  ],
};
/** A second box whose pieces anyone may lock (lockable 'anyone'); the same seats, so loading it keeps them. */
const LOCKABLE = {
  name: 'Lockables', imgs: [], lockable: 'anyone', seats: KIT.seats,
  types: { gem: { kind: 'token', name: 'Gem', faces: [{ color: '#a855f7' }] } },
  setup: [{ piece: 'gem', at: [920, 120] }, { bag: [{ t: 'gem', n: 2 }], name: 'Sack', at: [1030, 230] }],
};
// Free felt (table points, centres) where pieces are dropped, and where a tap deselects.
const FREE = { a: [640, 400], b: [750, 410], c: [650, 560], d: [760, 560], e: [1100, 160], f: [700, 650], g: [560, 660] };
const EMPTY = [[1170, 740], [30, 740], [1170, 30], [30, 30], [1170, 400]]; // corners, clear of the seat labels

/** A seated player in its own context (ctx: Playwright context options),
 *  with p1-lib's RTC byte counter (window.__rtc) and assets-lib's toast log (window.__toasts). */
async function player(env, name, url, ctx) {
  const p = await env.page(name, { ctx });
  await p.addInitScript(L.rtcHook);
  await p.addInitScript(toastLog);
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
  return p;
}

/** Fails loudly in the log but answers false: a wait that timed out is a failed check, reported by ok(). */
const no = (what) => (err) => { console.error(`  (waited in vain: ${what}: ${String(err.message).split('\n')[0]})`); return false; };
/** Waits until pred(view, arg, __ct) holds on page p (pred is run in the page: it sees only its arguments). */
const until = (p, pred, arg, ms = 20000) => p.waitForFunction(([src, a]) => (0, eval)(`(${src})`)(window.__ct.view(), a, window.__ct), [pred.toString(), arg], { timeout: ms, polling: 100 }) // eslint-disable-line no-eval
  .then(() => true, no(pred.toString().slice(0, 90)));
/** Page p's public view (plain JSON). */
const V = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__ct.view())));
const sorted = (xs) => [...xs].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let pages = [];
/** On a crash, saves every open screen in shots/ (p2-pieces-<mode>-crash-<k>.png), then rethrows. */
const crashShots = (mode) => async (err) => {
  await Promise.all(pages.map((p, k) => p.screenshot({ path: `${__dirname}/shots/p2-pieces-${mode}-crash-${k}.png` }).catch((e) => console.error('screenshot failed', e.message))));
  throw err;
};

/** One pass: host + guest on `mode` ('desktop' | 'phone'). */
async function pass(env, mode) {
  const phone = mode === 'phone';
  // Desktop Bob sees animations (the tumble must really play); everyone else runs with reduced motion.
  const ctxA = phone ? { ...devices['iPhone 13'] } : {};
  const ctxB = phone ? { ...devices['iPhone 13'] } : { reducedMotion: 'no-preference' };
  const alice = await player(env, 'Alice', env.url, ctxA);
  const bob = await player(env, 'Bob', alice.url(), ctxB);
  const P = (pages = [alice, bob]), NAME = new Map([[alice, 'Alice'], [bob, 'Bob']]);
  await alice.waitForFunction(() => document.querySelectorAll('.seat').length >= 2, null, { timeout: 30000 });
  const pidA = await L.pidOf(alice), pidB = await L.pidOf(bob);
  const say = (s) => `[${mode}] ${s}`;
  // A failed check also saves both screens (the first 4 of a pass) in shots/, for the post-mortem.
  let fails = 0;
  const ok = (cond, msg) => {
    h.ok(cond, msg);
    if (!cond && ++fails <= 4) for (const p of P) p.screenshot({ path: `${__dirname}/shots/p2-pieces-${mode}-fail${fails}-${NAME.get(p)}.png` }).catch((err) => console.error('screenshot failed', err.message));
  };
  const both = async (pred, arg, ms) => (await Promise.all(P.map((p) => until(p, pred, arg, ms)))).every(Boolean);

  // --- screen geometry ---------------------------------------------------------
  /** The client point of table point (x, y) on page p (a probe in #table: the view's turn, zoom and pan apply). */
  const scr = (p, [x, y]) => p.evaluate(([x, y]) => {
    const e = document.createElement('i');
    e.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
    document.getElementById('table').appendChild(e);
    const r = e.getBoundingClientRect();
    e.remove();
    return [r.left, r.top];
  }, [x, y]);
  /** A client point on item `id` where it is on top (its centre if it can), once its glide ended; throws if there is none. */
  async function spot(p, id) {
    await p.waitForFunction((id) => { const el = document.querySelector(`.item[data-id="${id}"]`); return el && !el.getAnimations().length; }, id, { timeout: 10000 }).catch(no(`item ${id} drawn and still`));
    return p.evaluate((id) => {
      const el = document.querySelector(`.item[data-id="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect(), hit = (q) => document.elementFromPoint(...q)?.closest('.item') === el;
      const c = [r.left + r.width / 2, r.top + r.height / 2];
      if (hit(c)) return c;
      // covered in part: the uncovered sample point farthest from every covered one (a finger's tap is not a point)
      const pts = [];
      for (let fy = 0.1; fy < 0.95; fy += 0.1) for (let fx = 0.1; fx < 0.95; fx += 0.1) pts.push([r.left + fx * r.width, r.top + fy * r.height]);
      const mine = pts.filter(hit), theirs = pts.filter((q) => !mine.includes(q));
      const far = (q) => Math.min(...theirs.map((t) => Math.hypot(t[0] - q[0], t[1] - q[1])));
      if (mine.length) return mine.reduce((best, q) => (far(q) > far(best) ? q : best));
      const top = document.elementFromPoint(...c);
      return `covered: its centre ${c.map(Math.round)} shows ${top?.tagName}#${top?.id}.${[...(top?.classList || [])].join('.')} ${top?.closest('.item')?.dataset.id || ''}`;
    }, id).then((q) => {
      if (Array.isArray(q)) return q;
      throw new Error(`no spot on item ${id} on ${NAME.get(p)}'s screen (${q || 'not drawn'})`);
    });
  }
  /** The table point under client point q on page p: scr inverted (an affine map, read from three probes). */
  async function tab(p, q) {
    const [o, ex, ey] = await Promise.all([[0, 0], [1000, 0], [0, 1000]].map((t) => scr(p, t)));
    const a = (ex[0] - o[0]) / 1000, b = (ex[1] - o[1]) / 1000, c = (ey[0] - o[0]) / 1000, d = (ey[1] - o[1]) / 1000, det = a * d - b * c;
    const dx = q[0] - o[0], dy = q[1] - o[1];
    return [(d * dx - c * dy) / det, (a * dy - b * dx) / det];
  }
  /** Whether client point q on page p is bare felt: no item, no seat label, no bar there. */
  const bare = (p, q) => p.evaluate((q) => {
    const e = document.elementFromPoint(...q);
    const onLabel = [...document.querySelectorAll('.seat')].some((s) => { const r = s.getBoundingClientRect(); return q[0] >= r.left && q[0] <= r.right && q[1] >= r.top && q[1] <= r.bottom; });
    return !!e?.closest('#table') && !e.closest('.item') && !onLabel;
  }, q);
  /** The client point of free table point `t` on page p (said loudly when it isn't bare felt). */
  async function free(p, t) {
    const q = await scr(p, t);
    if (!(await bare(p, q))) console.error(`  (table point ${t} is not free felt on ${NAME.get(p)}'s screen)`);
    return q;
  }

  // --- gestures: mouse on desktop, CDP touch on the phone --------------------------
  const cdps = new Map();
  const touch = async (p, type, pts) => {
    if (!cdps.has(p)) cdps.set(p, await p.context().newCDPSession(p));
    await cdps.get(p).send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
  };
  /** Drags from client point `a` to `b`, through o.via if given (Shift held when o.shift: desktop only). */
  async function drag(p, a, b, o = {}) {
    const legs = o.via ? [[a, o.via], [o.via, b]] : [[a, b]];
    if (phone) {
      await touch(p, 'touchStart', [a]);
      for (const [u, w] of legs) for (let k = 1; k <= 10; k++) { await touch(p, 'touchMove', [[u[0] + ((w[0] - u[0]) * k) / 10, u[1] + ((w[1] - u[1]) * k) / 10]]); await h.sleep(20); }
      await h.sleep(150); // the finger stops before it lifts: lifted while still moving, Chrome starts a fling, and the next tap only stops it (no click)
      await touch(p, 'touchEnd', []);
      return;
    }
    if (o.shift) await p.keyboard.down('Shift');
    await p.mouse.move(...a);
    await p.mouse.down();
    for (const [, w] of legs) await p.mouse.move(...w, { steps: 12 });
    await p.mouse.up();
    if (o.shift) await p.keyboard.up('Shift');
  }
  const tap = async (p, q) => { if (phone) { await touch(p, 'touchStart', [q]); await touch(p, 'touchEnd', []); } else await p.mouse.click(...q); };
  /** Presses a button (CSS selector `s`): a tap on the phone (through the same touch input as the
   *  gestures: two touch sources can lose a tap), a click on desktop. */
  async function btn(p, s) {
    if (!phone) return p.click(s, { timeout: 8000 });
    // where the button is, once it holds still and nothing covers it (a patch may redraw the bar meanwhile)
    const at = () => p.evaluate((s) => {
      const el = document.querySelector(s), r = el?.getBoundingClientRect(), c = r && [r.left + r.width / 2, r.top + r.height / 2];
      return r?.width && el.contains(document.elementFromPoint(...c)) ? c.map(Math.round).join() : '';
    }, s);
    let q = '';
    for (const end = Date.now() + 8000; Date.now() < end; await h.sleep(60)) { const q1 = await at(); if (q1 && q1 === q) break; q = q1; }
    if (!q) throw new Error(`no button ${s} to tap on ${NAME.get(p)}'s screen`);
    await tap(p, q.split(',').map(Number));
  }
  /** Drags item `id` onto item `onto`, or to table point `to` (an array), nothing selected first (no bar in the
   *  way). Returns the drag in table units: a piece keeps where it was grabbed, so what moves (or the copy taken
   *  out) lands that far from where the item lay. */
  async function dragItem(p, id, to, o) {
    await deselect(p);
    const a = await spot(p, id), b = Array.isArray(to) ? await free(p, to) : await spot(p, to);
    const [ta, tb] = [await tab(p, a), await tab(p, b)];
    await drag(p, a, b, o);
    return [tb[0] - ta[0], tb[1] - ta[1]];
  }
  /** Item it's top-left moved by drag vector `by`. */
  const moved = (it, by) => [it.x + by[0], it.y + by[1]];
  /** Whether page views hold item `id` with its top-left at `xy` (±3 units). */
  const lies = (id, xy, extra = '') => both(new Function('v', 'a', `const it = v.items[a.id]; return !!it && Math.hypot(it.x - a.xy[0], it.y - a.xy[1]) <= 3${extra && ` && (${extra})`};`), { id, xy });
  const isSel = (p, id) => p.evaluate((id) => !!document.querySelector(`.item[data-id="${id}"]`)?.classList.contains('selected'), id);
  /** Selects item `id` on p with one tap (unless it is), and waits for it. Another
   *  selection goes first: its bar may cover the item, and move as it redraws. */
  async function select(p, id) {
    if (await isSel(p, id)) return true;
    await deselect(p);
    await tap(p, await spot(p, id));
    return p.waitForFunction((id) => document.querySelector(`.item[data-id="${id}"]`)?.classList.contains('selected'), id, { timeout: 8000 }).then(() => true, no(`select ${id}`));
  }
  /** Taps bare felt (a corner the bar doesn't cover): nothing stays selected. */
  async function deselect(p) {
    if (!(await p.evaluate(() => !!document.querySelector('.item.selected')))) return;
    let q = null;
    for (const t of EMPTY) if (await bare(p, (q = await scr(p, t)))) break;
    await tap(p, q);
    await p.waitForFunction(() => !document.querySelector('.item.selected'), null, { timeout: 8000 }).catch(no('deselect'));
  }
  /** The bar's commands (data-cmd) as shown, sorted; [] when the bar is hidden. */
  const bar = (p) => p.evaluate(() => { const b = document.getElementById('action-bar'); return b.classList.contains('hidden') ? [] : [...b.querySelectorAll('[data-cmd]')].map((x) => x.dataset.cmd).sort(); });
  /** Selects `id` and presses its bar's `cmd` (data-to `to`, for giveTo). */
  async function press(p, id, cmd, to) {
    await select(p, id);
    await btn(p, `#action-bar:not(.hidden) [data-cmd="${cmd}"]${to ? `[data-to="${to}"]` : ''}`);
  }
  /** Selects `id` on p, reads its bar, and deselects. */
  async function barOf(p, id) {
    await deselect(p);
    await select(p, id);
    const got = await bar(p);
    await deselect(p);
    return got;
  }
  /** Checks that `id`'s bar on p offers exactly `want` (data-cmd values). */
  async function barIs(p, id, want, what) {
    const got = await barOf(p, id);
    ok(same(got, sorted(want)), say(`${NAME.get(p)}'s bar on ${what}: ${want.join(' ') || 'nothing (hidden)'} (${got.join(' ') || 'hidden'})`));
  }

  // --- the log: what came after a mark, on both screens, in the view and the DOM ----
  const marks = () => Promise.all(P.map((p) => p.evaluate(() => JSON.stringify(window.__ct.view().log.at(-1) ?? null))));
  /** The log entries page p has after mark m, as [name, text]. */
  const since = (p, m) => p.evaluate((m) => {
    const v = window.__ct.view(), k = v.log.findIndex((e) => JSON.stringify(e) === m);
    return v.log.slice(k + 1).map((e) => [v.players[e.p]?.name ?? String(e.p), e.txt]);
  }, m);
  /** Waits until both screens log `name`'s line matching `re` after marks `m`: in __ct.view().log and as a row of #log. */
  async function logged(m, name, re) {
    const one = (p, k) => p.waitForFunction(([m, name, src, fl]) => {
      const v = window.__ct.view(), j = v.log.findIndex((e) => JSON.stringify(e) === m), re = new RegExp(src, fl);
      const inView = v.log.slice(j + 1).some((e) => v.players[e.p]?.name === name && re.test(e.txt));
      const inDom = [...document.querySelectorAll('#log .lg')].slice(-15).some((r) => r.querySelector('b')?.textContent === name && re.test(r.textContent.slice(r.textContent.indexOf(name) + name.length + 1)));
      return inView && inDom;
    }, [m[k], name, re.source, re.flags], { timeout: 20000, polling: 100 }).then(() => true, no(`log "${name} ${re}"`));
    return (await Promise.all(P.map(one))).every(Boolean);
  }
  /** Checks `name`'s log line `re` on both screens. */
  const logOk = async (m, name, re, what) => ok(await logged(m, name, re), say(`${what}: both logs read "${name} ${re.source.replace(/^\^|\$$/g, '').replace(/\\/g, '')}"`));

  // --- the DOM of an item, on a page ----------------------------------------------
  const dom = (p, id) => p.evaluate((id) => {
    const el = document.querySelector(`.item[data-id="${id}"]`);
    if (!el) return null;
    const q = (s) => el.querySelector(s);
    return {
      cls: [...el.classList], count: q('.count')?.textContent ?? null, label: q('.plabel')?.textContent ?? null, back: !!q('.pback'),
      odot: q('.odot') ? getComputedStyle(q('.odot')).backgroundColor : null, lockb: q('.lockb') ? getComputedStyle(q('.lockb')).display : null,
      rot: el.style.transform, bn: q('.bn')?.textContent ?? null, bname: q('.bname')?.textContent ?? null,
    };
  }, id);
  const domBoth = (id) => Promise.all(P.map((p) => dom(p, id)));
  /** rgb() of a #rrggbb colour, as getComputedStyle reports it. */
  const rgb = (c) => `rgb(${[1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)).join(', ')})`;
  /** Ids in page p's view that are not in `before` and pass pred (run in Node on the item). */
  const fresh = async (p, before, pred = () => true) => Object.entries((await V(p)).items).filter(([id, it]) => !before.includes(id) && pred(it)).map(([id]) => id);
  const ids = async (p) => Object.keys((await V(p)).items);
  /** The table point at the centre of item `it` (its size given). */
  const centre = (it, w, hh = w) => [it.x + w / 2, it.y + hh / 2];
  const near = (a, b, d) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= d;

  // --- what was sent: the guest's actions as bytes on the wire (both ends), the host's own
  // in the log (every action the host applies logs a line, every refusal is a notice) --
  const wire = async () => ({
    sent: await bob.evaluate(() => window.__rtc.sent.act || 0), recv: await alice.evaluate(() => window.__rtc.recv.act || 0),
    m: await marks(), toasts: await Promise.all(P.map((p) => p.evaluate(() => window.__toasts.length))),
  });
  /** What happened since wire() snapshot w, as a list of what was sent or shown ([] when nothing). */
  async function sentSince(w) {
    const out = [], w1 = await wire();
    if (w1.sent !== w.sent) out.push(`Bob sent ${w1.sent - w.sent} act bytes`);
    if (w1.recv !== w.recv) out.push(`the host received ${w1.recv - w.recv} act bytes`);
    for (const [k, p] of P.entries()) {
      for (const [n, t] of await since(p, w.m[k])) if (n === 'Alice' || n === 'Bob') out.push(`${NAME.get(p)}'s log: ${n} ${t}`);
      for (const t of await toastsSince(p, w.toasts[k])) out.push(`${NAME.get(p)}'s notice: ${t}`);
    }
    return out;
  }
  const toastsSince = (p, k) => p.evaluate((k) => window.__toasts.slice(k).map((t) => t.msg), k);
  /** Item `id` as the host has it once the table is quiet (a guest's live moves arrive one by one: read mid-way, a spot is stale). */
  const settled = async (id) => { await quiet(); return (await V(alice)).items[id]; };
  /** Waits until the host's view has held still for 800 ms (whatever was in flight has landed). */
  async function quiet() {
    let seq = -1, at = Date.now();
    for (const end = Date.now() + 15000; Date.now() < end; await h.sleep(100)) {
      const s = (await V(alice)).seq;
      if (s !== seq) { seq = s; at = Date.now(); } else if (Date.now() - at >= 800) return;
    }
    console.error('  (the table never went quiet)');
  }

  // ==========================================================================================
  section(say('setup: the test box on a 1200 × 800 table; Alice sits South, Bob North'));
  const kit = await loadBox(alice, KIT);
  ok(await both((v) => Object.keys(v.items).length === 24 && v.seats?.length === 2), say('both screens hold the 24 items and the two named seats'));
  if (await alice.evaluate(() => !document.getElementById('game-strip').classList.contains('hidden'))) await btn(alice, '#game-strip-x');
  const its0 = (await V(alice)).items, I = {};
  for (const [k, x, y] of [['A', 60, 120], ['B', 180, 120], ['C', 300, 120], ['D', 420, 120], ['chit', 540, 120], ['wheel', 660, 120], ['hex', 780, 120],
    ['L', 60, 240], ['d1', 300, 240], ['d2', 360, 240], ['d3', 420, 240], ['hdie', 560, 240], ['htok', 660, 240], ['hch', 780, 240],
    ['S', 60, 360], ['SP', 180, 360], ['pouch', 300, 360], ['tbag', 420, 360], ['board', 840, 360],
    ['t1', 60, 500], ['t2', 180, 500], ['t3', 300, 500], ['t4', 420, 500], ['p1', 540, 500]]) I[k] = at(its0, x, y);
  ok(Object.values(I).every(Boolean), say(`every setup item found by its place (${Object.keys(I).filter((k) => !I[k]).join(', ') || 'all'})`));
  const ref = (t) => `${kit}/${t}`;
  ok(await bob.evaluate(() => { const m = /rotate\(([-\d.]+)deg\)/.exec(document.getElementById('table').style.transform); return m && Math.abs(Math.abs(+m[1]) - 180) < 1; }), say("Bob's view is turned 180° (North at his bottom edge)"));

  // ------------------------------------------------------------------------------------------
  section(say('drawing (§2g): shapes, badges, the bag pouch, the board SVG — on both screens'));
  {
    const [a, b] = await domBoth(I.A);
    ok([a, b].every((d) => d.cls.includes('piece') && d.cls.includes('shape-disc') && d.count === '×5'), say('a ×5 coin stack: .piece.shape-disc with the "×5" pill'));
    const [s] = await domBoth(I.S);
    ok(s.cls.includes('supply') && s.count === '∞', say('a supply: .supply with "∞"'));
    const [g1, g2] = await domBoth(I.pouch);
    ok([g1, g2].every((d) => d.cls.includes('bag') && d.bname === 'Pouch' && d.bn === '4'), say('a bag: .item.bag drawn as a pouch with its name and count (Pouch, 4)'));
    const pouch = await alice.evaluate((id) => { const el = document.querySelector(`.item[data-id="${id}"]`); return [el.offsetWidth, el.offsetHeight, !!el.querySelector('svg.pouch')]; }, I.pouch);
    ok(pouch[0] === 90 && pouch[1] === 100 && pouch[2], say(`the pouch is 90 × 100 and drawn (${pouch})`));
    for (const p of P) {
      const r = await p.evaluate(([board, hex, t1, A, hdie, d1]) => {
        const el = (id) => document.querySelector(`.item[data-id="${id}"]`), cs = (id) => getComputedStyle(el(id).querySelector('.pface'));
        const svg = el(board).querySelector('svg.psvg');
        return {
          board: el(board).classList.contains('board') && !!svg && svg.getAttribute('viewBox') === '0 0 300 300' && getComputedStyle(svg).pointerEvents === 'none' && +el(board).style.zIndex < 0,
          labels: svg ? [...svg.querySelectorAll('text')].map((t) => t.textContent).join('') : '',
          hex: cs(hex).clipPath !== 'none', rect: cs(t1).borderRadius === '8%', disc: cs(A).borderRadius === '50%',
          hidden: !!el(hdie).querySelector('.pback') && !el(hdie).classList.contains('die'), die: el(d1).classList.contains('die') && !!el(d1).querySelector('.pips'),
        };
      }, [I.board, I.hex, I.t1, I.A, I.hdie, I.d1]);
      ok(r.board, say(`${NAME.get(p)}: the board is .item.board with one svg.psvg (viewBox 0 0 300 300, pointer-events none), in the negative z band`));
      ok(r.labels === 'abcd4321', say(`${NAME.get(p)}: its chess labels a–d, 1–4 (${r.labels})`));
      ok(r.hex && r.rect && r.disc, say(`${NAME.get(p)}: hex clip-path, rect 8% radius, disc 50% (${r.hex}, ${r.rect}, ${r.disc})`));
      ok(r.hidden && r.die, say(`${NAME.get(p)}: a hidden die draws its back and is not marked a die; a shown die has pips`));
    }
  }

  // ------------------------------------------------------------------------------------------
  section(say('the bar (§2g) for every kind, from public data only: guest Bob and host Alice'));
  const HOST = ['lock', 'give'];
  for (const [id, what, want, extra = []] of [
    [I.A, 'a ×5 coin stack', ['flip', 'rl', 'rr', 'split', 'all', 'claim', 'del']],
    [I.C, 'a single coin', ['flip', 'rl', 'rr', 'claim', 'del']],
    [I.chit, 'a chit with a back', ['flip', 'rl', 'rr', 'claim', 'del']],
    [I.hex, 'a one-face hex tile (no back)', ['rl', 'rr', 'claim', 'del']],
    [I.wheel, 'the 6-face wheel', ['flip', 'rl', 'rr', 'claim', 'del'], ['zoom']],
    [I.t1, 'a tile (hand, back)', ['flip', 'rl', 'rr', 'hand', 'claim', 'del'], ['zoom']],
    [I.p1, 'a plain tile (hand, no back)', ['rl', 'rr', 'hand', 'claim', 'del'], ['zoom']],
    [I.L, 'a die', ['roll', 'claim', 'del']],
    [I.hdie, 'a hidden die', ['flip', 'rl', 'rr', 'claim', 'del']],
    [I.htok, 'a hidden token sharing its back', ['flip', 'rl', 'rr', 'claim', 'del']],
    [I.hch, 'a hidden ×2 chit stack (the back says count)', ['flip', 'rl', 'rr', 'split', 'all', 'claim', 'del']],
  ]) {
    // (🔍 on a face with a label, text or image: the implementer's documented addition to §2g's list)
    const tag = extra.length ? ' (+🔍: the face has a label)' : '';
    await barIs(bob, id, [...want, ...extra], what + tag);
    await barIs(alice, id, [...want, ...extra, ...HOST], what + tag);
  }
  ok(same(await barOf(bob, I.hdie), await barOf(bob, I.htok)), say('a hidden die and a hidden token of one back get the same bar (flags from the back)'));
  // (✥ Move on a supply: the 2B review's addition to §2g's list — touch has no Shift+drag to move one)
  await barIs(bob, I.S, ['take', 'all', 'del'], 'a coin supply (+✥ Move)');
  await barIs(alice, I.S, ['take', 'all', 'lock', 'del'], 'a coin supply (+✥ Move)');
  await barIs(bob, I.SP, ['take', 'takeHand', 'all', 'del'], 'a supply of hand tiles (+✥ Move)');
  await barIs(bob, I.pouch, ['pull', 'del'], 'a bag of coins (no hand)');
  await barIs(alice, I.pouch, ['pull', 'lock', 'del'], 'a bag of coins (no hand)');
  await barIs(bob, I.tbag, ['pull', 'pullHand', 'del'], 'a bag of tiles (hand)');
  await barIs(bob, I.board, [], 'the locked board');
  await barIs(alice, I.board, ['lock', 'give'], 'the locked board');
  await select(alice, I.board);
  ok(await alice.evaluate(() => document.querySelector('#action-bar [data-cmd="lock"]')?.textContent.includes('🔓')), say("the host's lock button on a locked board reads 🔓 Unlock"));
  await deselect(alice);

  // ------------------------------------------------------------------------------------------
  section(say('1. stacks: join, take one, one onto another stack, the whole stack'));
  let m = await marks();
  await dragItem(bob, I.C, I.B); // a single coin onto a ×3 coin stack: join
  ok(await both((v, a) => v.items[a.B]?.n === 4 && !v.items[a.C], { B: I.B, C: I.C }), say('Bob drops a coin on the ×3 stack: it joins (×4), on both screens'));
  ok((await domBoth(I.B)).every((d) => d?.count === '×4') && (await Promise.all(P.map((p) => dom(p, I.C)))).every((d) => d === null), say('both draw "×4" and the coin is gone'));
  await logOk(m, 'Bob', /^stacked Coin \(×4\)$/, 'join');

  m = await marks();
  let before = await ids(alice);
  let it0 = await settled(I.A);
  let by = await dragItem(alice, I.A, FREE.a); // a plain drag from ×5: takes one
  ok(await both((v, a) => v.items[a.A]?.n === 4 && Object.keys(v.items).length === a.n, { A: I.A, n: before.length + 1 }), say(`${phone ? 'a touch' : 'a'} drag from the ×5 stack takes one: ×4 stays, on both screens`));
  const [X] = await fresh(alice, before);
  const x0 = (await V(bob)).items[X];
  ok(x0 && x0.t === ref('coin') && x0.f === 0 && !x0.n && near([x0.x, x0.y], moved(it0, by), 3), say(`the one taken lies where it was dropped, a single coin (${JSON.stringify(x0 && { t: x0.t, f: x0.f, n: x0.n, x: x0.x, y: x0.y })})`));
  ok((await domBoth(I.A)).every((d) => d.count === '×4') && (await domBoth(X)).every((d) => d && d.count === null), say('both draw ×4, and the new coin without a pill'));
  await logOk(m, 'Alice', /^took 1 from Coin ×5$/, 'split');

  m = await marks();
  await dragItem(bob, I.A, I.B); // one from ×4 onto the matching ×4: split {onto}
  ok(await both((v, a) => v.items[a.A]?.n === 3 && v.items[a.B]?.n === 5 && Object.keys(v.items).length === a.n, { A: I.A, B: I.B, n: before.length + 1 }), say('Bob drags one from ×4 onto the other ×4 stack: ×3 and ×5, no new item'));
  await logOk(m, 'Bob', /^moved 1 from Coin ×4 onto Coin ×[45]$/, 'split onto');

  m = await marks();
  const a0 = await settled(I.A);
  if (!phone) {
    by = await dragItem(alice, I.A, FREE.b, { shift: true }); // Shift: the whole stack moves
    ok(await lies(I.A, moved(a0, by), `it.n === 3 && Object.keys(v.items).length === ${before.length + 1}`), say('Shift+drag moves the whole ×3 stack, on both screens'));
    await logOk(m, 'Alice', /^moved Coin ×3$/, 'Shift+drag');
  } else {
    await press(alice, I.A, 'all'); // ✥ Move all arms a whole-stack drag
    ok(await alice.evaluate(() => !!document.querySelector('#action-bar [data-cmd="all"].on')), say('✥ Move all shows armed (.on)'));
    const g = await spot(alice, I.A), d = await free(alice, FREE.b), [ga, gb] = [await tab(alice, g), await tab(alice, d)];
    await drag(alice, g, d);
    ok(await lies(I.A, moved(a0, [gb[0] - ga[0], gb[1] - ga[1]]), `it.n === 3 && Object.keys(v.items).length === ${before.length + 1}`), say('armed, a touch drag moves the whole ×3 stack, on both screens'));
    await logOk(m, 'Alice', /^moved Coin ×3$/, 'Move all');
    await press(alice, I.A, 'all'); // armed again, then let 5 s pass: it disarms by itself
    ok(await alice.evaluate(() => !!document.querySelector('#action-bar [data-cmd="all"].on')), say('armed again'));
    ok(await alice.waitForFunction(() => !document.querySelector('#action-bar [data-cmd="all"].on'), null, { timeout: 7000 }).then(() => true, no('Move all disarms')), say('after 5 s ✥ Move all is no longer armed'));
    await deselect(alice);
    const n0 = (await ids(alice)).length;
    await drag(alice, await spot(alice, I.A), await free(alice, FREE.d));
    ok(await both((v, a) => v.items[a.A]?.n === 2 && Object.keys(v.items).length === a.n + 1, { A: I.A, n: n0 }), say('so the next touch drag takes one again (×2 stays)'));
    const [Y] = await fresh(alice, [...before, X]);
    await press(alice, Y, 'del'); // tidy: the extra coin goes
    ok(await both((v, a) => !v.items[a], Y), say('(🗑 removes the extra coin)'));
  }

  m = await marks();
  await dragItem(bob, X, I.D); // a face-0 coin onto a face-1 stack: not the same face, so no join — a move
  ok(await both((v, a) => v.items[a.D]?.n === 2 && !!v.items[a.X], { D: I.D, X }), say('a coin of another face dropped on the ×2 stack does not join it (it is moved)'));
  await logOk(m, 'Bob', /^moved Coin$/, 'drop on another face');
  it0 = await settled(X);
  by = await dragItem(bob, X, FREE.a);
  ok(await lies(X, moved(it0, by)), say('(and dragged back to free felt)'));

  // ------------------------------------------------------------------------------------------
  section(say('2. flip: with a back, with 2 faces, turning through N faces'));
  const flipBy = async (p, id) => { if (phone) await press(p, id, 'flip'); else { await deselect(p); await p.mouse.dblclick(...(await spot(p, id))); } };
  const how = phone ? 'the bar\'s Flip' : 'a double-click';
  m = await marks();
  await flipBy(bob, I.chit);
  ok(await both((v, a) => { const it = v.items[a.id]; return it && it.b === a.b && !('t' in it) && !('f' in it) && !('up' in it); }, { id: I.chit, b: `${kit}/cb` }), say(`Bob turns the chit face down (${how}): both views show only its back {b}`));
  ok((await domBoth(I.chit)).every((d) => d.back), say('both draw its back (.pback)'));
  await logOk(m, 'Bob', /^turned Chit face down$/, 'flip with a back');
  m = await marks();
  await flipBy(alice, I.chit);
  ok(await both((v, a) => v.items[a.id]?.t === a.t && !('b' in v.items[a.id]), { id: I.chit, t: ref('chit') }), say(`Alice turns it over again (${how}): shown on both`));
  await logOk(m, 'Alice', /^turned over Chit$/, 'turn over');
  m = await marks();
  await flipBy(alice, X);
  ok(await both((v, a) => v.items[a]?.f === 1, X), say(`Alice flips a 2-face coin (${how}): face 1 on both`));
  await logOk(m, 'Alice', /^flipped Coin$/, 'flip 2 faces');
  m = await marks();
  await flipBy(bob, I.wheel);
  ok(await both((v, a) => v.items[a]?.f === 1, I.wheel), say(`Bob turns the 6-face wheel (${how}): face 1 on both`));
  ok((await domBoth(I.wheel)).every((d) => d.label === '2'), say('both draw its face "2"'));
  await logOk(m, 'Bob', /^turned 1 to 2$/, 'turn N faces');

  // ------------------------------------------------------------------------------------------
  section(say('3. rotate by rotStep (⟳ / ⟲)'));
  const rotOk = async (id, deg) => (await both((v, a) => ((v.items[a.id]?.rot % 360) + 360) % 360 === a.deg, { id, deg })) && (await domBoth(id)).every((d) => d.rot === `rotate(${deg}deg)`);
  m = await marks();
  await press(bob, I.hex, 'rr');
  ok(await rotOk(I.hex, 60), say('Bob ⟳ the hex tile (rotStep 60): 60° on both views and both screens'));
  await logOk(m, 'Bob', /^rotated Hex$/, 'rotate');
  await press(bob, I.hex, 'rl');
  ok(await rotOk(I.hex, 0), say('⟲ turns it back to 0°'));
  await press(alice, I.t1, 'rr');
  ok(await rotOk(I.t1, 90), say('Alice ⟳ a tile (rotStep 90): 90°'));
  await press(alice, X, 'rr');
  ok(await rotOk(X, 45), say('⟳ a coin that turns freely (rotStep 0): 45°'));
  await press(alice, X, 'rl');
  ok(await rotOk(X, 0), say('⟲: 0° again'));
  await deselect(alice);
  await deselect(bob);

  // ------------------------------------------------------------------------------------------
  section(say('4. rolls: one die alone, a handful of three side by side; the tumble on both screens'));
  /** Starts recording, on page p, every item element that gets .tumble: its id, whether a 'tumble' CSS animation runs on its face (its duration), and how long the class stayed. */
  const recTumbles = () => Promise.all(P.map((p) => p.evaluate(() => {
    window.__tumbles = [];
    if (window.__tumbleObs) return;
    window.__tumbleObs = new MutationObserver((ms) => {
      for (const { target: el } of ms) {
        if (!el.classList?.contains('item')) continue;
        const on = el.classList.contains('tumble'), r = window.__tumbles.find((x) => x.id === el.dataset.id && x.ms === undefined);
        if (on && !r) window.__tumbles.push({ id: el.dataset.id, at: performance.now(), anim: (el.querySelector('.pface')?.getAnimations() || []).filter((a) => a.animationName === 'tumble').map((a) => a.effect.getTiming().duration) });
        else if (!on && r) r.ms = performance.now() - r.at;
      }
    });
    window.__tumbleObs.observe(document.getElementById('table'), { attributes: true, attributeFilter: ['class'], subtree: true });
  })));
  const tumbles = () => Promise.all(P.map((p) => p.evaluate(() => window.__tumbles)));
  /** Rolls die `id` the way this pass does: a double-click (desktop), the bar's 🎲 Roll (phone), or Space. */
  const rollBy = async (p, id, key) => {
    if (key) { await select(p, id); await p.keyboard.press('Space'); return; }
    if (phone) await press(p, id, 'roll'); else { await deselect(p); await p.mouse.dblclick(...(await spot(p, id))); }
  };
  /** After a roll of `dice` by `name` from marks m: one log line on both screens naming their faces in id order, the faces the same on both, the tumble on exactly those dice on both. */
  async function rolled(m, name, dice, what) {
    const want = sorted(dice);
    ok(await logged(m, name, /^rolled /), say(`${what}: the roll reaches both screens`));
    await h.sleep(700); // (a second line would be a bug: let it come, and the tumble end)
    const lines = await Promise.all(P.map((p, k) => since(p, m[k])));
    const views = await Promise.all(P.map(V));
    const faces = want.map((id) => views[1].items[id].f);
    ok(lines.every((ls) => ls.filter(([n, t]) => /^rolled /.test(t)).length === 1), say(`${what}: one log line on each screen (${JSON.stringify(lines[1])})`));
    ok(lines.every((ls) => ls.some(([n, t]) => n === name && t === `rolled ${faces.map((f) => f + 1).join(' · ')}`)), say(`${what}: it names the ${dice.length} faces in id order, as both screens show them ("rolled ${faces.map((f) => f + 1).join(' · ')}")`));
    ok(want.every((id) => views[0].items[id].f === views[1].items[id].f), say(`${what}: the faces agree on both screens`));
    const tb = await tumbles();
    tb.forEach((list, k) => {
      ok(same(sorted(new Set(list.map((r) => r.id))), want), say(`${what}: ${NAME.get(P[k])}'s screen tumbles exactly the rolled dice (${list.length} tumble(s))`));
      ok(list.every((r) => r.ms >= 440 && r.ms < 3000), say(`${what}: …for about 450 ms, then it goes (${list.map((r) => Math.round(r.ms)).join(', ')} ms; a loaded machine runs timers late)`));
    });
    return tb;
  }
  await recTumbles();
  m = await marks();
  await rollBy(bob, I.L);
  let tb = await rolled(m, 'Bob', [I.L], `Bob rolls the lone die (${phone ? '🎲 Roll' : 'double-click'})`);
  if (!phone) {
    ok(tb[1].every((r) => same(r.anim, [450])), say(`motion on (Bob): a 450 ms "tumble" animation plays on the die's face (${JSON.stringify(tb[1].map((r) => r.anim))})`));
    ok(tb[0].every((r) => !r.anim.length), say('reduced motion (Alice): no animation, the face just changes'));
  }
  await recTumbles();
  m = await marks();
  await rollBy(alice, I.d2);
  await rolled(m, 'Alice', [I.d1, I.d2, I.d3], `Alice rolls the middle die of three (${phone ? '🎲 Roll' : 'one double-click'}): the handful`);
  if (!phone) {
    await recTumbles();
    m = await marks();
    await rollBy(bob, I.d1, true);
    await rolled(m, 'Bob', [I.d1, I.d2, I.d3], 'Bob selects a die and presses Space: the handful');
    await deselect(bob);
  }
  // A die Bob may not handle is no part of his handful: Alice claims the end one.
  await press(alice, I.d3, 'claim');
  ok(await both((v, a) => v.items[a.id]?.owner === a.p, { id: I.d3, p: pidA }), say('Alice claims the third die'));
  await deselect(alice);
  await recTumbles();
  m = await marks();
  await rollBy(bob, I.d1);
  await rolled(m, 'Bob', [I.d1, I.d2], 'Bob rolls the first die: only the two he may handle roll');
  await press(alice, I.d3, 'release');
  ok(await both((v, a) => !v.items[a]?.owner, I.d3), say('(Alice releases it)'));
  await deselect(alice);
  // a drag moves a die: it is not rolled
  await recTumbles();
  m = await marks();
  it0 = await settled(I.L);
  const fL = it0.f;
  by = await dragItem(bob, I.L, FREE.c);
  ok(await lies(I.L, moved(it0, by), `it.f === ${fL}`), say('Bob drags the lone die: it moves, its face unchanged, on both screens'));
  await logOk(m, 'Bob', /^moved Die$/, 'move a die');
  ok((await tumbles()).every((l) => !l.length) && (await Promise.all(P.map((p, k) => since(p, m[k])))).every((ls) => !ls.some(([, t]) => /^rolled /.test(t))), say('no roll, no tumble'));
  by = await dragItem(bob, I.L, [it0.x + 28, it0.y + 28]);
  ok(await lies(I.L, [it0.x, it0.y]), say('(and back)'));

  // ------------------------------------------------------------------------------------------
  section(say('5. lock, the 🔒 badge, and the refusal for a guest'));
  m = await marks();
  await press(alice, I.B, 'lock');
  ok(await both((v, a) => v.items[a]?.lock === true, I.B), say('Alice locks the ×5 stack (🔒 Lock): locked on both views'));
  await logOk(m, 'Alice', /^locked Coin ×5$/, 'lock');
  const [lbA, lbB] = await domBoth(I.B);
  ok(lbA.lockb === 'block' && lbB.lockb === 'none', say(`🔒 shows only while selected: on Alice's screen (selected) ${lbA.lockb}, on Bob's ${lbB.lockb}`));
  ok((await alice.evaluate(() => document.querySelector('#action-bar [data-cmd="lock"]')?.textContent)).includes('🔓'), say('her bar now offers 🔓 Unlock'));
  await barIs(alice, I.B, ['lock', 'give'], 'the locked stack');
  await barIs(bob, I.B, [], 'the locked stack (nothing moves, turns or removes it, no lock for a guest)');
  const b0 = await settled(I.B);
  const t0 = await bob.evaluate(() => window.__toasts.length);
  await bob.evaluate((a) => window.__ct.act(a), { t: 'move', id: I.B, x: 900, y: 650 }); // the screen never sends it: the refusal itself
  ok(await bob.waitForFunction((k) => window.__toasts.slice(k).some((t) => t.msg.includes('🔒 That is locked in place')), t0, { timeout: 15000 }).then(() => true, no('lock refusal')), say('a guest\'s move of the locked stack is refused: "🔒 That is locked in place" on his screen'));
  ok(await both((v, a) => v.items[a.id].x === a.x && v.items[a.id].y === a.y, { id: I.B, x: b0.x, y: b0.y }), say('and it stays put on both screens'));
  m = await marks();
  await press(alice, I.B, 'lock');
  ok(await both((v, a) => !v.items[a]?.lock, I.B), say('🔓 Unlock: unlocked on both'));
  await logOk(m, 'Alice', /^unlocked Coin ×5$/, 'unlock');
  await deselect(alice);
  // lockable: 'anyone' — a guest may lock what he may handle, bags too (their box is public, D88)
  const lb = await loadBox(alice, LOCKABLE, { clear: false });
  ok(await both((v) => Object.values(v.items).some((it) => it.k === 'b' && it.name === 'Sack') && v.seats?.length === 2), say('a second box, lockable by anyone, joins the table (same seats)'));
  const lits = (await V(alice)).items, gem = at(lits, 920, 120), sack = at(lits, 1030, 230);
  ok(lits[sack]?.box === lb && lits[I.pouch]?.box === kit, say(`a bag's public form carries its box (D88): ${lits[sack]?.box === lb}, ${lits[I.pouch]?.box === kit}`));
  await barIs(bob, gem, ['rl', 'rr', 'lock', 'claim', 'del'], 'a lockable gem');
  await barIs(bob, sack, ['pull', 'lock', 'del'], 'a bag of the lockable box');
  m = await marks();
  await press(bob, gem, 'lock');
  ok(await both((v, a) => v.items[a]?.lock === true, gem), say('Bob locks the gem himself: locked on both'));
  await logOk(m, 'Bob', /^locked Gem$/, 'guest lock');
  await barIs(bob, gem, ['lock'], 'his locked gem (🔓 Unlock only)');
  await press(bob, gem, 'lock');
  ok(await both((v, a) => !v.items[a]?.lock, gem), say('and unlocks it'));
  await press(bob, sack, 'lock');
  ok(await both((v, a) => v.items[a]?.lock === true, sack), say('Bob locks the Sack bag'));
  await deselect(bob);

  // ------------------------------------------------------------------------------------------
  section(say('6. owners: claim, the owner refusal, release, give (to a player, to a seat)'));
  m = await marks();
  await press(bob, X, 'claim');
  ok(await both((v, a) => v.items[a.X]?.owner === a.p, { X, p: pidB }), say('Bob claims a coin (👤 Claim): his on both views'));
  await logOk(m, 'Bob', /^claimed Coin$/, 'claim');
  const colB = (await V(alice)).players[pidB].color, colA = (await V(alice)).players[pidA].color;
  ok((await domBoth(X)).every((d) => d.odot === rgb(colB)), say(`both draw its owner dot in Bob's colour (${colB})`));
  await barIs(bob, X, ['flip', 'rl', 'rr', 'release', 'del'], 'his own coin');
  await barIs(alice, X, ['lock', 'release', 'give'], "Bob's coin");
  const x1 = (await V(alice)).items[X], ta = await alice.evaluate(() => window.__toasts.length);
  await alice.evaluate((a) => window.__ct.act(a), { t: 'move', id: X, x: 100, y: 650 }); // the host is not exempt (D17)
  ok(await alice.waitForFunction((k) => window.__toasts.slice(k).some((t) => t.msg.includes('🚫 That belongs to Bob')), ta, { timeout: 15000 }).then(() => true, no('owner refusal')), say('the host\'s move of Bob\'s coin is refused: "🚫 That belongs to Bob"'));
  ok(await both((v, a) => v.items[a.id].x === a.x && v.items[a.id].y === a.y, { id: X, x: x1.x, y: x1.y }), say('and it stays put on both screens'));
  m = await marks();
  await press(bob, X, 'release');
  ok(await both((v, a) => v.items[a] && !v.items[a].owner, X), say('Bob releases it (👤 Release): unowned on both, no dot'));
  ok((await domBoth(X)).every((d) => d.odot === null), say('both drop the owner dot'));
  await logOk(m, 'Bob', /^released Coin$/, 'release');
  await deselect(bob);
  m = await marks();
  await press(alice, X, 'give');
  const gives = await alice.evaluate(() => [...document.querySelectorAll('#action-bar [data-cmd="giveTo"]')].map((b) => b.dataset.to));
  ok(gives.includes(pidA) && gives.includes(pidB), say(`Give ▸ lists the players (${gives.length} entries; the named seats too: the implementer's addition)`));
  await btn(alice, `#action-bar [data-cmd="giveTo"][data-to="${pidB}"]`).catch(no('give to Bob'));
  ok(await both((v, a) => v.items[a.X]?.owner === a.p, { X, p: pidB }), say('Alice gives the coin to Bob: his on both'));
  await logOk(m, 'Alice', /^gave Coin to Bob$/, 'give');
  await deselect(alice);
  m = await marks();
  await press(alice, X, 'give');
  await btn(alice, '#action-bar [data-cmd="giveTo"][data-to="seat:north"]').catch(no('give to North'));
  ok(await both((v, a) => v.items[a]?.owner === 'seat:north', X), say('…then to the North seat: seat-bound on both'));
  await logOk(m, 'Alice', /^gave Coin to North$/, 'give to a seat');
  ok((await domBoth(X)).every((d) => d.odot === rgb('#2563eb')), say("a seat-bound owner's dot is the seat's colour (#2563eb), on both screens"));
  await barIs(bob, X, ['flip', 'rl', 'rr', 'release', 'del'], "the North seat's coin (Bob sits North)");
  await press(bob, X, 'release');
  ok(await both((v, a) => !v.items[a]?.owner, X), say('Bob releases it'));
  // Alice's own pieces, for item 11 (from Bob's screen)
  await press(alice, I.D, 'claim');
  ok(await both((v, a) => v.items[a.id]?.owner === a.p, { id: I.D, p: pidA }), say('Alice claims the ×2 coin stack of face 1'));
  ok((await domBoth(I.D)).every((d) => d.odot === rgb(colA)), say(`its dot is Alice's colour on both screens (${colA})`));
  await barIs(bob, I.D, [], "Alice's stack (nothing for Bob)");
  const tb0 = await bob.evaluate(() => window.__toasts.length);
  await bob.evaluate((a) => window.__ct.act(a), { t: 'del', id: I.D }); // the screen never offers it: the refusal itself
  ok(await bob.waitForFunction((k) => window.__toasts.slice(k).some((t) => t.msg.includes('🚫 That belongs to Alice')), tb0, { timeout: 15000 }).then(() => true, no('owner refusal (guest)')), say('a guest\'s removal of Alice\'s stack is refused: "🚫 That belongs to Alice"'));
  ok(await both((v, a) => v.items[a]?.n === 2, I.D), say('and it is still there on both screens'));
  await barIs(bob, I.board, [], 'the locked board (no claim: a board)');
  await deselect(alice);

  // ------------------------------------------------------------------------------------------
  section(say('7. supplies: take by drag and by ' + (phone ? 'the bar' : 'double-click') + ', return by drop' + (phone ? '' : ', Shift+drag moves it')));
  m = await marks();
  before = await ids(alice);
  it0 = await settled(I.S);
  by = await dragItem(bob, I.S, FREE.c); // a plain drag on a supply spawns a piece
  ok(await both((v, a) => Object.keys(v.items).length === a.n && v.items[a.S]?.k === 's' && v.items[a.S].x === 60 && v.items[a.S].y === 360, { n: before.length + 1, S: I.S }), say('Bob drags from the coin supply: a new coin, the supply stays where it was'));
  const [Tk] = await fresh(alice, before);
  const tk = (await V(bob)).items[Tk];
  ok(tk?.k === 'g' && tk.t === ref('coin') && near([tk.x, tk.y], moved(it0, by), 3), say('the coin lies where it was dropped'));
  ok((await domBoth(I.S)).every((d) => d.count === '∞'), say('the supply still shows ∞'));
  await logOk(m, 'Bob', /^took Coin from the Coin supply$/, 'take by drag');
  m = await marks();
  before = await ids(alice);
  if (phone) await press(alice, I.S, 'take'); else { await deselect(alice); await alice.mouse.dblclick(...(await spot(alice, I.S))); }
  ok(await both((v, a) => Object.keys(v.items).length === a, before.length + 1), say(`Alice takes one with ${phone ? 'the bar\'s Take 1' : 'a double-click'}: a new coin`));
  const [Tk2] = await fresh(alice, before);
  const tk2 = (await V(alice)).items[Tk2];
  ok(tk2 && Math.hypot(tk2.x - 60, tk2.y - 360) < 140, say(`it lies next to the supply (${tk2?.x},${tk2?.y})`));
  await logOk(m, 'Alice', /^took Coin from the Coin supply$/, 'take by ' + (phone ? 'the bar' : 'double-click'));
  m = await marks();
  await deselect(alice);
  await dragItem(bob, Tk, I.S); // back into its supply
  ok(await both((v, a) => !v.items[a.Tk] && v.items[a.S]?.k === 's', { Tk, S: I.S }), say('Bob drops his coin on the supply: it goes back (join), on both'));
  await logOk(m, 'Bob', /^returned Coin to the Coin supply$/, 'return');
  await dragItem(alice, Tk2, I.S);
  ok(await both((v, a) => !v.items[a], Tk2), say('Alice returns hers too'));
  if (!phone) {
    m = await marks();
    it0 = await settled(I.S);
    by = await dragItem(alice, I.S, FREE.g, { shift: true });
    ok(await lies(I.S, moved(it0, by), "it.k === 's'"), say('Shift+drag moves the supply itself, on both screens'));
    await logOk(m, 'Alice', /^moved the Coin supply$/, 'Shift+drag a supply');
  }
  // a supply of hand tiles dragged onto the hand bar: one goes into the hand
  m = await marks();
  const hb = async (p) => { const r = await p.locator('#hand').boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  await drag(bob, await spot(bob, I.SP), await hb(bob));
  ok(await until(bob, (v, a, ct) => ct.hand().length === 1 && ct.hand()[0].t === a, ref('plain')), say('Bob drags from the tile supply onto his hand bar: the tile is in his hand'));
  ok(await both((v, a) => v.players[a].handCount === 1, pidB), say('both screens count his hand (1)'));
  ok(await bob.waitForFunction(() => document.querySelectorAll('.hcard').length === 1, null, { timeout: 10000 }).then(() => true, no('hcard')), say('his hand bar draws it'));
  await logOk(m, 'Bob', /^took P into hand$/, 'take into the hand');

  // ------------------------------------------------------------------------------------------
  section(say('8. bags: pull to the table and into the hand, toBag, the counts'));
  m = await marks();
  before = await ids(alice);
  if (phone) await press(bob, I.pouch, 'pull'); else { await deselect(bob); await bob.mouse.dblclick(...(await spot(bob, I.pouch))); }
  ok(await both((v, a) => v.items[a.id]?.n === 3 && Object.keys(v.items).length === a.n, { id: I.pouch, n: before.length + 1 }), say(`Bob pulls from the Pouch (${phone ? 'Draw' : 'double-click'}): a coin on the table, the bag counts 3 on both views`));
  ok((await domBoth(I.pouch)).every((d) => d.bn === '3'), say('both pouches read 3'));
  const [Pc] = await fresh(alice, before);
  const pc = (await V(alice)).items[Pc];
  ok(pc?.t === ref('coin') && Math.hypot(pc.x - 300, pc.y - 360) < 160, say('the coin lies next to the bag'));
  await logOk(m, 'Bob', /^drew Coin from the bag Pouch$/, 'pull');
  m = await marks();
  await dragItem(bob, Pc, I.pouch);
  ok(await both((v, a) => !v.items[a.c] && v.items[a.b]?.n === 4, { c: Pc, b: I.pouch }), say('Bob drops the coin on the Pouch (toBag): gone, the bag counts 4 on both'));
  ok((await domBoth(I.pouch)).every((d) => d.bn === '4'), say('both pouches read 4'));
  await logOk(m, 'Bob', /^put Coin into the bag Pouch$/, 'toBag');
  m = await marks();
  if (phone) await press(alice, I.tbag, 'pullHand'); else { await deselect(alice); await alice.mouse.dblclick(...(await spot(alice, I.tbag))); }
  ok(await until(alice, (v, a, ct) => ct.hand().length === 1 && ct.hand()[0].t === a, ref('tile')), say(`Alice pulls from the Tiles bag (${phone ? '✋ Draw to hand' : 'double-click: a hand bag'}): a tile in her hand`));
  ok(await both((v, a) => v.items[a.id]?.n === 2 && v.players[a.p].handCount === 1, { id: I.tbag, p: pidA }), say('the bag counts 2 and her hand 1, on both'));
  ok((await domBoth(I.tbag)).every((d) => d.bn === '2'), say('both bags read 2'));
  await logOk(m, 'Alice', /^drew a piece from the bag Tiles$/, 'pull into the hand');
  m = await marks();
  it0 = await settled(I.pouch);
  by = await dragItem(alice, I.pouch, FREE.d);
  ok(await lies(I.pouch, moved(it0, by), 'it.n === 4'), say('a drag moves a bag (its contents go with it)'));
  await logOk(m, 'Alice', /^moved the bag Pouch$/, 'move a bag');

  // ------------------------------------------------------------------------------------------
  section(say('9. a pile of tiles: stack, toPile, draw, deal (pieces), flip, peek at a hidden top, shuffle'));
  m = await marks();
  before = await ids(alice);
  await dragItem(bob, I.t1, I.t2); // two loose tiles of one size: a pile
  ok(await both((v, a) => !v.items[a.t1] && !v.items[a.t2] && Object.values(v.items).some((it) => it.k === 'p' && it.n === 2), { t1: I.t1, t2: I.t2 }), say('Bob drops a tile on another: they stack into a pile of 2, on both'));
  const [PL] = await fresh(alice, before, (it) => it.k === 'p');
  const pl0 = (await V(bob)).items[PL];
  ok(pl0?.top?.t === ref('tile') && pl0.top.up === true && pl0.x === 180 && pl0.y === 500, say(`the pile lies where the lower tile was, its top shown (${JSON.stringify(pl0?.top)})`));
  ok((await domBoth(PL)).every((d) => d.cls.includes('pile') && d.cls.includes('multi') && d.count === '2'), say('both draw it as a .pile.multi with its count 2'));
  await logOk(m, 'Bob', /^stacked T onto T$/, 'stack');
  m = await marks();
  await dragItem(alice, I.t3, PL);
  ok(await both((v, a) => v.items[a.p]?.n === 3 && !v.items[a.t], { p: PL, t: I.t3 }), say('Alice drops a third tile on the pile (toPile): 3'));
  await logOk(m, 'Alice', /^put T onto the stacked pile$/, 'toPile');
  await dragItem(bob, I.t4, PL);
  ok(await both((v, a) => v.items[a.p]?.n === 4, { p: PL }), say('Bob adds the fourth: 4'));
  m = await marks();
  if (phone) await press(bob, PL, 'draw'); else { await deselect(bob); await bob.mouse.dblclick(...(await spot(bob, PL))); }
  ok(await until(bob, (v, a, ct) => ct.hand().filter((c) => c.t === a).length === 1, ref('tile')), say(`Bob draws from the pile (${phone ? 'Draw' : 'double-click'}): a tile in his hand`));
  ok(await both((v, a) => v.items[a.p]?.n === 3 && v.players[a.b].handCount === 2, { p: PL, b: pidB }), say('the pile counts 3, his hand 2, on both'));
  await logOk(m, 'Bob', /^drew a piece from the stacked pile$/, 'draw');
  m = await marks();
  before = await ids(alice);
  await press(alice, PL, 'dealup');
  ok(await both((v, a) => v.items[a.p]?.n === 2 && Object.keys(v.items).length === a.n, { p: PL, n: before.length + 1 }), say('Alice deals one face up (Deal↑): the pile counts 2'));
  const [Dt] = await fresh(alice, before);
  ok(await both((v, a) => v.items[a.id]?.k === 'g' && v.items[a.id].t === a.t && !('up' in v.items[a.id]), { id: Dt, t: ref('tile') }), say('the dealt item is a piece (k:"g"), not a card, face up on both'));
  await logOk(m, 'Alice', /^dealt T from the stacked pile$/, 'deal');
  m = await marks();
  await press(alice, PL, 'flip');
  ok(await both((v, a) => { const t = v.items[a.p]?.top; return t && t.up === false && t.b === a.b && !('t' in t) && !('f' in t); }, { p: PL, b: `${kit}/tb` }), say('Alice turns the pile over: its top is a hidden back {b, up:false} on both'));
  ok((await domBoth(PL)).every((d) => d.back), say('both draw the back on the pile'));
  await logOk(m, 'Alice', /^flipped the stacked pile/, 'flip the pile');
  await deselect(alice);
  m = await marks();
  await press(bob, PL, 'peek');
  ok(await bob.waitForSelector('#peek:not(.hidden) #peek-inner .plabel', { timeout: 10000 }).then(async (e) => (await e.textContent()) === 'T', no('peek')), say('Bob peeks: the hidden top shows to him (the T tile, in the zoom overlay)'));
  ok((await bob.textContent('#peek-cap')).includes('Only you can see this'), say('captioned "Only you can see this"'));
  ok(await alice.evaluate(() => document.getElementById('peek').classList.contains('hidden')), say('Alice sees no overlay'));
  await logOk(m, 'Bob', /^peeked at the top piece of the stacked pile$/, 'peek');
  await btn(bob, '#peek');
  ok(await bob.waitForSelector('#peek.hidden', { state: 'attached', timeout: 5000 }).then(() => true, no('peek closes')), say('a tap closes the overlay'));
  m = await marks();
  await press(alice, PL, 'shuffle');
  await logOk(m, 'Alice', /^shuffled the stacked pile \(2 pieces\)$/, 'shuffle');
  await deselect(alice);
  await deselect(bob);

  // ------------------------------------------------------------------------------------------
  section(say('10. a piece in the hand: dragged to the table; face down when it has a back; onto the hand bar'));
  /** Drags page p's hand entry of type `t` to table point `to`; returns the table point it was let go at. */
  async function fromHand(p, t, to) {
    const k = await p.evaluate((t) => window.__ct.hand().findIndex((c) => c.t === t), t);
    const card = p.locator(`.hcard[data-idx="${k}"]`);
    await card.scrollIntoViewIfNeeded();
    const r = await card.boundingBox(), a = [r.x + Math.min(12, r.width / 2), r.y + r.height / 2], b = await free(p, to);
    await drag(p, a, b, { via: [a[0], a[1] - 90] }); // (up first: on touch a sideways swipe scrolls the hand)
    return tab(p, b);
  }
  m = await marks();
  before = await ids(alice);
  const let1 = await fromHand(bob, ref('tile'), FREE.e);
  ok(await both((v, a) => Object.keys(v.items).length === a.n && v.players[a.b].handCount === 1, { n: before.length + 1, b: pidB }), say('Bob drags his tile from the hand to the table: on the table, his hand counts 1'));
  const [Pt] = await fresh(alice, before);
  const pt = (await V(alice)).items[Pt];
  ok(pt?.k === 'g' && pt.t === ref('tile') && !('up' in pt), say('a face-up tile'));
  ok(pt && near(centre(pt, 100), let1, 3), say(`…centred where he let go, ${let1.map(Math.round)} (its centre: ${pt && centre(pt, 100).map(Math.round)})`));
  await logOk(m, 'Bob', /^played T from hand$/, 'play');
  // face-down mode: a piece with a back lands hidden, one without lands face up
  for (const p of P) await btn(p, '#facedown-toggle');
  ok((await Promise.all(P.map((p) => p.evaluate(() => document.getElementById('facedown-toggle').classList.contains('on'))))).every(Boolean), say('both turn on face-down plays (🂠)'));
  m = await marks();
  before = await ids(alice);
  await fromHand(alice, ref('tile'), FREE.f);
  ok(await both((v, a) => Object.keys(v.items).length === a, before.length + 1), say('Alice drags her tile (it has a back) to the table'));
  const [Ht] = await fresh(alice, before);
  ok(await both((v, a) => { const it = v.items[a.id]; return it?.k === 'g' && it.b === a.b && !('t' in it); }, { id: Ht, b: `${kit}/tb` }), say('it lands face down: both views hold only its back'));
  ok((await domBoth(Ht)).every((d) => d.back), say('both draw its back'));
  await logOk(m, 'Alice', /^played a piece face down from hand$/, 'play face down');
  before = await ids(alice);
  await fromHand(bob, ref('plain'), FREE.c);
  ok(await both((v, a) => Object.keys(v.items).length === a, before.length + 1), say('Bob drags his plain tile (no back) with face-down on'));
  const [Pp] = await fresh(alice, before);
  ok(await both((v, a) => v.items[a.id]?.t === a.t, { id: Pp, t: ref('plain') }), say('it lands face up: it has no hidden side'));
  for (const p of P) await btn(p, '#facedown-toggle');
  ok((await Promise.all(P.map((p) => p.evaluate(() => !document.getElementById('facedown-toggle').classList.contains('on'))))).every(Boolean), say('(both turn face-down plays off again)'));
  m = await marks();
  await drag(bob, await spot(bob, Pt), await hb(bob)); // a hand-type piece onto the hand bar
  ok(await both((v, a) => !v.items[a.id] && v.players[a.b].handCount === 1, { id: Pt, b: pidB }), say('Bob drops a tile from the table onto his hand bar (toHand): in his hand, off the table'));
  ok(await until(bob, (v, a, ct) => ct.hand().some((c) => c.t === a), ref('tile')), say('his hand holds it'));
  await logOk(m, 'Bob', /^took T from the table into hand$/, 'toHand');
  const xs = await settled(X);
  await drag(bob, await spot(bob, X), await hb(bob)); // a coin can't be held: it is just moved
  ok(await both((v, a) => !!v.items[a.X] && v.players[a.b].handCount === 1, { X, b: pidB }), say('a coin (not a hand type) dropped on the hand bar stays on the table'));
  it0 = await settled(X);
  by = await dragItem(bob, X, [xs.x + 30, xs.y + 30]);
  ok(await lies(X, moved(it0, by)), say('(and dragged back)'));

  // ------------------------------------------------------------------------------------------
  section(say('11. a drag on a locked board, or on Alice\'s piece, pans Bob\'s view: nothing sent, no notice; a tap selects'));
  const panOf = (p) => p.evaluate(() => /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.getElementById('table').style.transform).slice(1).map(Number));
  async function pans(p, id, what) {
    await deselect(p);
    await quiet();
    const w0 = await wire(), v0 = await V(p), pan0 = await panOf(p), from = await spot(p, id);
    await drag(p, from, [from[0] + 40, from[1] + 30]);
    const pan1 = await panOf(p);
    ok(Math.abs(pan1[0] - pan0[0] - 40) < 2 && Math.abs(pan1[1] - pan0[1] - 30) < 2, say(`${NAME.get(p)} drags on ${what}: the view pans by the drag (${pan0.map(Math.round)} → ${pan1.map(Math.round)})`));
    await h.sleep(1200); // (anything sent would have arrived by now)
    const got = await sentSince(w0), v1 = await V(p);
    ok(!got.some((x) => !x.includes('notice')), say(`…and nothing is sent: no act bytes from Bob, none at the host, no log line by either (${JSON.stringify(got)})`));
    ok(!got.some((x) => x.includes('notice')), say('…and no notice appears on either screen'));
    ok(v1.items[id].x === v0.items[id].x && v1.items[id].y === v0.items[id].y, say('…it did not move'));
    await btn(p, '#view-btn'); // 🧭: back to the seat view (on the phone, the pan can take an item by the edge off the screen)
    await tap(p, await spot(p, id));
    ok(await isSel(p, id), say(`a tap still selects ${what}`));
    const b = await bar(p);
    ok(!b.length === (await p.evaluate(() => document.getElementById('action-bar').classList.contains('hidden'))), say(`its bar is shown with what ${NAME.get(p)} may do (${b.join(' ') || 'nothing, so hidden'})`));
    await deselect(p);
  }
  await pans(bob, I.board, 'the locked board');
  await pans(bob, I.D, "Alice's ×2 stack");
  await press(alice, I.L, 'lock');
  ok(await both((v, a) => v.items[a]?.lock === true, I.L), say('(Alice locks the lone die)'));
  await deselect(alice);
  await pans(bob, I.L, 'the locked die');
  await select(bob, I.L);
  ok(same(await bar(bob), ['roll']), say('a locked die still rolls: Bob\'s bar offers 🎲 Roll only'));
  await deselect(bob);
  await press(alice, I.L, 'lock');
  await deselect(alice);
  await press(bob, X, 'claim');
  ok(await both((v, a) => v.items[a.X]?.owner === a.p, { X, p: pidB }), say('(Bob claims a coin)'));
  await deselect(bob);
  await pans(alice, X, "Bob's coin (from Alice's screen)");
  await pans(alice, I.board, 'the locked board (the host too: locks bind her)');
  if (!phone) {
    await quiet();
    const w0 = await wire();
    for (const [p, id] of [[bob, I.board], [bob, I.D], [alice, X]]) { await deselect(p); await p.mouse.dblclick(...(await spot(p, id))); }
    await h.sleep(1200);
    const got = await sentSince(w0);
    ok(!got.length, say(`a double-click on the locked board or on someone else's piece sends nothing either, and shows no notice (${JSON.stringify(got)})`));
    for (const p of P) await deselect(p);
  }
  // once the host unlocks the board, a drag moves it (and it stays in the boards' z band)
  m = await marks();
  await press(alice, I.board, 'lock');
  ok(await both((v, a) => !v.items[a]?.lock, I.board), say('Alice unlocks the board'));
  await barIs(alice, I.board, ['rl', 'rr', 'lock', 'give', 'del'], 'the unlocked board');
  const bd0 = await settled(I.board);
  const bfrom = await spot(alice, I.board), bto = [bfrom[0] - 30, bfrom[1] - 20], [ba, bb] = [await tab(alice, bfrom), await tab(alice, bto)];
  await drag(alice, bfrom, bto);
  ok(await lies(I.board, moved(bd0, [bb[0] - ba[0], bb[1] - ba[1]]), `it.z === ${bd0.z}`), say(`unlocked, a drag moves the board, and its z stays in the boards' band (${bd0.z})`));
  await logOk(m, 'Alice', /^moved Map$/, 'move the board');

  // ------------------------------------------------------------------------------------------
  if (!phone) {
    section(say('keys: R / Shift+R rotate by the step, F flips, Space rolls, Delete removes, Esc deselects'));
    await select(alice, I.hex);
    await alice.keyboard.press('r');
    ok(await rotOk(I.hex, 60), say('R turns the hex tile by its step (60°), on both screens'));
    await alice.keyboard.press('Shift+R');
    ok(await rotOk(I.hex, 0), say('Shift+R turns it back'));
    m = await marks();
    await select(alice, I.chit);
    await alice.keyboard.press('f');
    ok(await both((v, a) => v.items[a]?.up === undefined && 'b' in v.items[a], I.chit), say('F turns the chit face down'));
    await logOk(m, 'Alice', /^turned Chit face down$/, 'F');
    await alice.keyboard.press('f');
    ok(await both((v, a) => 't' in v.items[a], I.chit), say('F again: face up'));
    await recTumbles();
    m = await marks();
    await select(alice, I.d2);
    await alice.keyboard.press(' ');
    await rolled(m, 'Alice', [I.d1, I.d2, I.d3], 'Space on a die: the handful');
    m = await marks();
    await select(alice, I.A);
    await alice.keyboard.press('Delete');
    ok(await both((v, a) => !v.items[a], I.A), say('Delete removes the selected stack, on both screens'));
    await logOk(m, 'Alice', /^removed Coin ×3$/, 'Delete');
    await select(alice, I.wheel);
    ok(!(await alice.evaluate(() => document.getElementById('action-bar').classList.contains('hidden'))), say('(the wheel is selected, its bar up)'));
    await alice.keyboard.press('Escape');
    ok(await alice.evaluate(() => !document.querySelector('.item.selected') && document.getElementById('action-bar').classList.contains('hidden')), say('Esc deselects: no selection, no bar'));
    // keys do only what the bar offers, and nothing inside an input
    await quiet();
    const w0 = await wire(), r0 = (await V(alice)).items[I.d1].rot;
    await select(bob, I.D);
    await bob.keyboard.press('Delete');
    await bob.keyboard.press('f');
    await bob.keyboard.press('r');
    await deselect(bob);
    await select(bob, I.d1);
    await bob.keyboard.press('r');
    await deselect(bob);
    await select(alice, I.wheel);
    await alice.click('#chat-input');
    await alice.keyboard.press('f');
    await alice.keyboard.press('Delete');
    await h.sleep(1200);
    const got = await sentSince(w0), v1 = await V(alice);
    ok(!got.length && v1.items[I.D] && v1.items[I.wheel]?.f === 1 && v1.items[I.d1].rot === r0, say(`Delete, F and R on Alice's stack, R on a die (no rotation for dice), and F or Delete typed in the chat box do nothing, send nothing, show no notice (${JSON.stringify(got)})`));
    await alice.keyboard.press('Escape');
  } else {
    section(say('touch: a long press on a piece with a label, text or image zooms its face until the finger lifts'));
    const hold = async (p, id) => {
      const q = await spot(p, id);
      await touch(p, 'touchStart', [q]);
      const shown = await L.until(() => p.evaluate(() => !document.getElementById('peek').classList.contains('hidden')), 2500, 100);
      const html = shown ? await p.evaluate(() => [document.querySelector('#peek-inner .plabel')?.textContent, document.querySelector('#peek-inner .ptext')?.textContent]) : null;
      await touch(p, 'touchEnd', []);
      const closed = await p.waitForSelector('#peek.hidden', { state: 'attached', timeout: 2000 }).then(() => true, no('the zoom closes'));
      return { shown, html, closed };
    };
    const z1 = await hold(bob, I.p1);
    ok(z1.shown && z1.html?.[0] === 'P', say(`a long press on the plain tile shows its face, label P (${JSON.stringify(z1.html)})`));
    ok(z1.closed, say('lifting the finger closes it'));
    ok(!(await isSel(bob, I.p1)), say('and the long press does not select it'));
    const z2 = await hold(alice, Dt);
    ok(z2.shown && same(z2.html, ['T', 'A tile']), say(`on a tile with a label and a text: both show (${JSON.stringify(z2.html)})`));
    const z3 = await hold(bob, I.hex);
    ok(!z3.shown, say('a long press on a piece whose face has none (a plain colour) shows nothing'));
    const z4 = await hold(bob, Ht);
    ok(!z4.shown, say('nor on a face-down piece'));
    await deselect(bob);
  }

  section(say('the end state agrees on both screens; no notice but the refusals asked for'));
  const [va, vb] = await Promise.all(P.map(V));
  ok(same(va.items, vb.items), say('both views hold the same items'));
  const asked = { Alice: ['🚫 That belongs to Bob'], Bob: ['🔒 That is locked in place', '🚫 That belongs to Alice'] };
  for (const p of P) {
    const seen = await toastsSince(p, 0);
    ok(same(seen, asked[NAME.get(p)]), say(`${NAME.get(p)}'s notices: ${JSON.stringify(seen)}`));
  }
  await Promise.all(P.map((p) => p.screenshot({ path: `${__dirname}/shots/p2-pieces-${mode}-${NAME.get(p)}.png` })));
  await Promise.all(P.map((p) => p.context().close()));
}

(async () => {
  const env = await h.start();
  for (const mode of ['desktop', 'phone']) if (!process.env.ONLY || process.env.ONLY === mode) await pass(env, mode).catch(crashShots(mode));
  await env.done();
})().catch(h.crash);
