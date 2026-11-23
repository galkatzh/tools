// Helpers for the Phase 2B table and demo suites (t-p2-tables.js,
// t-p2-demos.js) and the 1,000-piece benches (t-p1-bench.js); not a suite
// itself. Everything here reads the screen (the DOM, #table's transform) or
// drives real gestures: a mouse, CDP touches, the keyboard.
'use strict';
const h = require('./h');
const L = require('./p1-lib');

const { devices } = h.playwright;
const PHONE = devices['iPhone 13'];

/** A player in its own context (`o.ctx`: a device descriptor; `o.rtc`: with
 *  p1-lib's RTC byte counter, window.__rtc), joined as `name`, once the host
 *  knows it: its own player is in its view. `page.pid` is its player id. */
async function join(env, name, url, o = {}) {
  const p = await env.page(name, o);
  if (o.rtc) await p.addInitScript(L.rtcHook);
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
  p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
  return p;
}

/** Waits until `expr` (an expression over `v`, the page's view, `me`, its
 *  player id, and `a`, the argument) holds; false after `ms`. */
const waitView = (p, expr, a, ms = 20000) => p.waitForFunction(([src, a]) => {
  const v = window.__ct.view(), me = localStorage.getItem('ct-pid');
  return (0, eval)(`(v, me, a) => (${src})`)(v, me, a); // eslint-disable-line no-eval
}, [expr, a], { timeout: ms, polling: 100 }).then(() => true, () => false);
/** The value of `expr` (as in waitView) on page p, as plain JSON. */
const viewOf = (p, expr, a) => p.evaluate(([src, a]) => {
  const v = window.__ct.view(), me = localStorage.getItem('ct-pid');
  const r = (0, eval)(`(v, me, a) => (${src})`)(v, me, a); // eslint-disable-line no-eval
  return r === undefined ? null : JSON.parse(JSON.stringify(r));
}, [expr, a]);

/** #table's view transform on page p: {px, py (the pan, px), rot (degrees, 0–360), s (the scale)}. */
const tf = (p) => p.evaluate(() => {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) rotate\(([-\d.e]+)deg\) scale\(([-\d.e]+)\)/.exec(document.getElementById('table').style.transform);
  return m && { px: +m[1], py: +m[2], rot: ((+m[3] % 360) + 360) % 360, s: +m[4] };
});
/** The table area's size on page p (#table-wrap's client box) and its place: {W, H, left, top, bottom}. */
const wrap = (p) => p.evaluate(() => { const el = document.getElementById('table-wrap'), r = el.getBoundingClientRect(); return { W: el.clientWidth, H: el.clientHeight, left: r.left, top: r.top, bottom: r.bottom }; });
/** The fit of table `tb` ({shape, w, h}) seen at `rot` degrees in a W × H
 *  area (spec §2g): a rectangle's rotated bounding box, a round table's
 *  diameter (it never refits as it turns). */
function fit(tb, rot, W, H) {
  if (tb.shape !== 'rect') return Math.min(W / tb.w, H / tb.h);
  const a = (rot * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return Math.min(W / (tb.w * c + tb.h * s), H / (tb.w * s + tb.h * c));
}
/** The smallest angle between two directions, in degrees. */
const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** The seat labels on page p: [{text, ghost, me, x, y (centre, client px), w, h, style, color (computed border)}]. */
const labels = (p) => p.evaluate(() => [...document.querySelectorAll('.seat')].map((el) => {
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  return { text: el.textContent, ghost: el.classList.contains('ghost'), me: el.classList.contains('me'), x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, style: cs.borderTopStyle, color: cs.borderTopColor };
}));
/** The label on page p whose text is `text` (or matches it, a RegExp), once it shows; null after `ms`. */
async function label(p, text, ms = 15000) {
  let hit = null;
  await L.until(async () => (hit = (await labels(p)).find((l) => (text instanceof RegExp ? text.test(l.text) : l.text === text))), ms, 100);
  return hit || null;
}
/** The open seat menu's entries on page p ([] while it is closed). */
const menu = (p) => p.evaluate(() => {
  const m = document.getElementById('seat-menu');
  return m.classList.contains('hidden') ? [] : [...m.querySelectorAll('button')].map((b) => b.textContent);
});
/** Clicks (or, `touch`, taps) the label `text` on page p, and returns the
 *  seat menu that opened (its entries; [] when none did, after a moment). */
async function openMenu(p, text, touch) {
  const l = await label(p, text);
  if (!l) throw new Error(`no seat label "${text}" on ${p.pid}: ${JSON.stringify((await labels(p)).map((x) => x.text))}`);
  if (touch) await p.touchscreen.tap(l.x, l.y);
  else await p.mouse.click(l.x, l.y);
  let m = [];
  await L.until(async () => (m = await menu(p)).length > 0, 1500, 100);
  return m;
}
/** Clicks (taps) the seat menu's entry `text` on page p. */
async function pick(p, text, touch) {
  const b = p.locator('#seat-menu button', { hasText: text }).first();
  if (touch) await b.tap();
  else await b.click();
}

/** A client point on bare felt on page p: #table itself is what the pointer
 *  hits there (no item, button or bar), away from the seat labels. `o.band`
 *  [y0, y1] restricts it to that part of the table area's height. */
const feltPoint = (p, o = {}) => p.evaluate((band) => {
  const table = document.getElementById('table'), r = document.getElementById('table-wrap').getBoundingClientRect();
  const seats = [...document.querySelectorAll('.seat')].map((el) => el.getBoundingClientRect());
  for (let k = 0; k < 6000; k++) {
    const x = r.left + 24 + ((r.width - 48) * ((k * 37) % 101)) / 101;
    const y = r.top + r.height * band[0] + 24 + ((r.height * (band[1] - band[0]) - 48) * ((k * 53) % 103)) / 103;
    if (document.elementFromPoint(x, y) !== table) continue;
    if (seats.some((s) => x > s.left - 30 && x < s.right + 30 && y > s.top - 30 && y < s.bottom + 30)) continue;
    return { x, y };
  }
  return null;
}, o.band || [0, 1]);

/** A mouse drag on page p from client point a to b. */
async function mouseDrag(p, a, b, o = {}) {
  await p.mouse.move(a.x, a.y);
  if (o.shift) await p.keyboard.down('Shift');
  await p.mouse.down();
  await p.mouse.move(b.x, b.y, { steps: o.steps || 10 });
  await p.mouse.up();
  if (o.shift) await p.keyboard.up('Shift');
}
/** A one-finger touch drag on page p (CDP touches: pointerType 'touch') from a to b. */
async function touchDrag(p, a, b, steps = 10) {
  const cdp = await p.context().newCDPSession(p);
  const t = (type, pt) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pt ? [{ x: pt.x, y: pt.y }] : [] });
  try {
    await t('touchStart', a);
    for (let k = 1; k <= steps; k++) await t('touchMove', { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    await t('touchEnd');
  } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
}
/** Drags on page p with the mouse or, `touch`, a finger. */
const dragOn = (p, a, b, touch) => (touch ? touchDrag(p, a, b) : mouseDrag(p, a, b));
/** The centre of item `id`'s element on page p, in client px (null when it isn't drawn). */
const itemXY = (p, id) => p.evaluate((id) => {
  const el = document.querySelector(`.item[data-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, id);
/** Clicks (taps) item `id` on page p at its centre. */
async function clickItem(p, id, touch) {
  const c = await itemXY(p, id);
  if (touch) await p.touchscreen.tap(c.x, c.y);
  else await p.mouse.click(c.x, c.y);
}
/** Board item `id`'s printed texts on page p, as the screen shows them (D91):
 *  `texts`, one {t (the text), label (a space's or zone's label, .slabel:
 *  turned by the nearest half turn; else a coordinate), a (its on-screen
 *  angle in degrees, 0 when it reads upright: getScreenCTM composes every
 *  transform on the way, the view's, the board's and its own included), off
 *  (px from its box's centre to its anchor — its own x, y placed by the
 *  board's SVG), near (px to the nearest other text's anchor), fs (its font
 *  size on screen, px, its own scale included), out (board units its ink
 *  stands past the board's edge, 0 inside: the glyphs' own bounds, measured
 *  on a canvas in its font, centred on its anchor as the text is)} each; and
 *  `bare`, the angle the first coordinate shows while its own turn is taken
 *  off for a moment: the view's turn plus the board's, which D91 undoes. */
const boardTexts = (p, id) => p.evaluate((id) => {
  const svg = document.querySelector(`.item[data-id="${id}"] svg.psvg`), M = svg.getScreenCTM(), Mi = M.inverse(), els = [...svg.querySelectorAll('text')];
  const [, , W, H] = svg.getAttribute('viewBox').split(' ').map(Number), ctx = document.createElement('canvas').getContext('2d');
  const angle = (el) => { const m = el.getScreenCTM(); return Math.round((Math.atan2(m.b, m.a) * 1800) / Math.PI) / 10; };
  const anchors = els.map((el) => new DOMPoint(+el.getAttribute('x'), +el.getAttribute('y')).matrixTransform(M));
  /** Text el's ink: its corners in its own user units (text-anchor middle, dominant-baseline central: the canvas's centre, middle). */
  const ink = (el) => {
    const cs = getComputedStyle(el), x = +el.getAttribute('x'), y = +el.getAttribute('y');
    Object.assign(ctx, { font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, textAlign: 'center', textBaseline: 'middle' });
    const k = ctx.measureText(el.textContent), [l, r, t, b] = [x - k.actualBoundingBoxLeft, x + k.actualBoundingBoxRight, y - k.actualBoundingBoxAscent, y + k.actualBoundingBoxDescent];
    return [[l, t], [r, t], [l, b], [r, b]];
  };
  const texts = els.map((el, k) => {
    const r = el.getBoundingClientRect(), d = (q) => Math.hypot(r.left + r.width / 2 - q.x, r.top + r.height / 2 - q.y), m = el.getScreenCTM();
    // its ink's corners, through its own turn and scale to the screen and back into board units
    const corners = ink(el).map(([x, y]) => new DOMPoint(x, y).matrixTransform(m).matrixTransform(Mi));
    const out = Math.max(0, ...corners.flatMap((q) => [-q.x, q.x - W, -q.y, q.y - H]));
    return { t: el.textContent, label: el.classList.contains('slabel'), a: angle(el), off: d(anchors[k]), near: Math.min(...anchors.filter((_, j) => j !== k).map(d)), fs: parseFloat(getComputedStyle(el).fontSize) * Math.hypot(m.a, m.b), out: Math.round(out * 10) / 10 };
  });
  const el = svg.querySelector('.blabels text'), turn = el.style.transform;
  el.style.transform = 'none';
  const bare = angle(el);
  el.style.transform = turn;
  return { texts, bare };
}, id);
/** Checks (h.ok) that the printed texts of board `id` on page p (`who`, for
 *  the messages) read as D91 has them — each coordinate upright, each space
 *  or zone label never upside down (at most a quarter turn off upright), all
 *  of them inside the board (a coordinate grows on a table drawn small, but
 *  no more than its margin holds) — that each sits by its own anchor, and
 *  that without its turn a coordinate would read at `bare` degrees (the
 *  view's turn plus the board's): the reading is live, and the view really turns it. */
async function upright(p, id, bare, who) {
  const b = await boardTexts(p, id), coords = b.texts.filter((x) => !x.label), labels = b.texts.filter((x) => x.label);
  const crooked = coords.filter((x) => Math.abs(x.a) > 0.5), astray = b.texts.filter((x) => !(x.off <= 0.5 * x.fs && x.off < x.near)), out = coords.filter((x) => x.out > 0.5);
  h.ok(coords.length > 0 && !crooked.length, `${who}: all ${coords.length} of the board's coordinates read upright (${crooked.map((x) => `${x.t} at ${x.a}°`).join(', ') || 'every one at 0°'})`);
  h.ok(!out.length, `${who}: and stay inside the board (${out.map((x) => `${x.t}: ${x.out} past the edge`).join(', ') || `${coords.length} inside, at ${coords[0]?.fs.toFixed(1)} px`})`);
  if (labels.length) {
    const wrong = labels.filter((x) => Math.abs(x.a) > 90.5 || x.out > 0.5);
    h.ok(!wrong.length, `${who}: its ${labels.length} space and zone labels are never upside down, and stay inside the board (${labels.map((x) => `"${x.t}" at ${x.a}°, ${x.out} past the edge`).join('; ')})`);
  }
  h.ok(!astray.length, `${who}: each sits by its own file, rank or space: its centre within half its font size of its anchor, nearer its own than any other (${astray.map((x) => `${x.t}: ${x.off.toFixed(1)} px off, ${x.near.toFixed(1)} px to another`).join(', ') || 'all'})`);
  h.ok(angDiff(b.bare, bare) < 0.5, `${who}: without its own turn a coordinate would read at ${b.bare}° (the view's turn and the board's: ${bare}°)`);
}
/** The badges on page p that read upright on every screen (D91): a pile's
 *  count and name, ×N, ∞, a shown 🔒 and a bag — [{what, a, bare, below?,
 *  off?}]: `a`, its on-screen angle (degrees, 0 when upright), read from two
 *  probes put at its top corners; `bare`, the angle with its own turn taken
 *  off for a moment (--view and --rot zeroed on it), less its item's rot
 *  (so: the view's turn, which the badge undoes). A pile's name also has
 *  `below`, px from the pile's lowest corner on the screen down to the
 *  name's top (≥ 0: it sits under the pile, clear of it), `off`, px from
 *  the pile's centre across to the name's, and `count`, px² of the pile's
 *  count that it covers. */
const badgeAngles = (p) => p.evaluate(() => [...document.querySelectorAll('#table .item > .count, #table .pile > .pname, #table .bag > .bagbox, #table .item > .lockb')].filter((el) => el.getClientRects().length).map((el) => {
  const pos = el.style.position, item = el.closest('.item'), rot = +window.__ct.view().items[item.dataset.id].rot || 0;
  /** Client rects of probes put at (left, top) in element e. */
  const probes = (e, pts) => pts.map(([left, top]) => { const i = document.createElement('i'); i.style.cssText = `position:absolute;top:${top};left:${left};width:0;height:0`; e.appendChild(i); const r = i.getBoundingClientRect(); i.remove(); return r; });
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; // (a probe's place is its parent's box)
  const angle = () => { const [a, b] = probes(el, [['0', '0'], ['100%', '0']]); return Math.round((Math.atan2(b.top - a.top, b.left - a.left) * 1800) / Math.PI) / 10; };
  const a = angle(), out = { what: `${el.className} "${el.textContent}"`, a };
  el.style.setProperty('--view', '0deg');
  el.style.setProperty('--rot', '0deg');
  out.bare = (((angle() - rot) % 360) + 360) % 360;
  el.style.removeProperty('--view');
  el.style.removeProperty('--rot');
  el.style.position = pos;
  if (el.classList.contains('pname')) {
    const c = probes(item, [['0', '0'], ['100%', '0'], ['0', '100%'], ['100%', '100%'], ['50%', '50%']]), n = el.getBoundingClientRect();
    out.below = Math.round((n.top - Math.max(...c.slice(0, 4).map((q) => q.top))) * 10) / 10;
    out.off = Math.round((n.left + n.width / 2 - c[4].left) * 10) / 10;
    const k = item.querySelector(':scope > .count')?.getBoundingClientRect();
    out.count = k ? Math.round(Math.max(0, Math.min(n.right, k.right) - Math.max(n.left, k.left)) * Math.max(0, Math.min(n.bottom, k.bottom) - Math.max(n.top, k.top))) : 0;
  }
  return out;
}));
/** Checks (h.ok) that every badge on page p (`who`) reads upright, and that
 *  without its turn it would read at `turn`, the view's (the reading is
 *  live); and that a pile's name sits under its pile on the screen, centred
 *  and clear of it (D91 amended after the close-out's second review). */
async function badgesUpright(p, turn, who) {
  const b = await badgeAngles(p), crooked = b.filter((x) => Math.abs(x.a) > 0.5), bare = b.filter((x) => angDiff(x.bare, turn) > 0.5);
  h.ok(b.length > 0 && !crooked.length, `${who}: all ${b.length} badges (a pile's count and name, ×N, ∞, 🔒, a bag) read upright (${crooked.map((x) => `${x.what} at ${x.a}°`).join(', ') || 'every one at 0°'})`);
  h.ok(!bare.length, `${who}: without its own turn each would read at the view's turn plus its item's, ${turn}° (${bare.map((x) => `${x.what}: ${x.bare}°`).join(', ') || 'all'})`);
  const names = b.filter((x) => 'below' in x), astray = names.filter((x) => x.below < -0.5 || Math.abs(x.off) > 1 || x.count > 0);
  if (names.length) h.ok(!astray.length, `${who}: each pile's name sits under its pile on the screen, centred, clear of it and of its count (${names.map((x) => `${x.what}: ${x.below} px below, ${x.off} px across, ${x.count} px² of the count covered`).join('; ')})`);
}
/** The actions page p has sent so far (bytes on the `act` channel; p1-lib's RTC hook). */
const sentActs = (p) => p.evaluate(() => window.__rtc.sent.act || 0);

const range = (n) => Array.from({ length: n }, (_, k) => k);
/** The bench box of spec §2k, for the browser budgets: on a 6000 × 4000
 *  table, 1 board (a 40 × 25 square grid of cell 100, draw 'lines'), 600
 *  tokens (12 rows of 50), 250 tiles (5 rows of 50, the first two face
 *  down), 50 dice, 60 supplies (chips and hand-held pawns) and 39 bags (3
 *  pieces each): 1,000 items, laid out over the board as a game would. */
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
    ...range(12).map((k) => ({ piece: 'tok', at: [1050, 800 + 75 * k], count: 50, spread: [75, 0], f: k % 3 })),
    ...range(5).map((k) => ({ piece: 'tile', at: [1050, 1750 + 110 * k], count: 50, spread: [78, 0], ...(k < 2 ? { up: false } : {}) })),
    { piece: 'die', at: [1050, 2350], count: 50, spread: [70, 0] },
    ...range(60).map((k) => ({ supply: k % 2 ? 'chip' : 'pawn', at: [1050 + 62 * k, 2480] })),
    ...range(39).map((k) => ({ bag: ['tok', 'tok', { t: 'tile', up: false }], name: `Bag ${k}`, at: [1050 + 95 * k, 2600] })),
  ],
};

/** '#rrggbb' as a computed style colour reads ('rgb(r, g, b)'). */
const rgb = (hex) => `rgb(${[1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)).join(', ')})`;
/** Whether element `sel` shows on page p: in the DOM, displayed, with a box. */
const shows = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0; }, sel);
/** Whether every client box of `sel`'s matches on page p lies inside the viewport. */
const inViewport = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].every((el) => {
  const r = el.getBoundingClientRect();
  return r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
}), sel);

module.exports = {
  PHONE, BENCH, join, waitView, viewOf, tf, wrap, fit, angDiff, labels, label, menu, openMenu, pick, feltPoint,
  mouseDrag, touchDrag, dragOn, itemXY, clickItem, sentActs, rgb, shows, inViewport, boardTexts, upright, badgeAngles, badgesUpright,
};
