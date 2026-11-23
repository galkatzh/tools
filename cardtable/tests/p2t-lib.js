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
/** The actions page p has sent so far (bytes on the `act` channel; p1-lib's RTC hook). */
const sentActs = (p) => p.evaluate(() => window.__rtc.sent.act || 0);

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
  PHONE, join, waitView, viewOf, tf, wrap, fit, angDiff, labels, label, menu, openMenu, pick, feltPoint,
  mouseDrag, touchDrag, dragOn, itemXY, clickItem, sentActs, rgb, shows, inViewport,
};
