// Helpers for the Phase 4B selection suites (t-p4-select.js,
// t-p4-hexfront.js): what a page shows of the multi-selection, the group
// bar and the stack inspector, and the gestures that drive them (a tap or
// a click, a two-finger pinch, a long press: CDP touches on a phone); not a
// suite itself.
'use strict';
const path = require('path');
const h = require('./h');
const { until } = require('./p1-lib');

const SHOTS = path.join(__dirname, 'shots');
/** What page p shows of the selection: {ids (.selected), bar (the bar's text, '' hidden), chip ('' hidden)}. */
const shown = (p) => p.evaluate(() => {
  const vis = (el) => !el.classList.contains('hidden');
  return {
    ids: [...document.querySelectorAll('#table .item.selected')].map((e) => e.dataset.id),
    bar: vis(document.getElementById('action-bar')) ? document.getElementById('action-bar').textContent : '',
    chip: vis(document.getElementById('sel-chip')) ? document.getElementById('sel-chip').textContent : '',
  };
});
/** The client box of `sel` on page p ({l, t, r, b}), or null when hidden. */
const box = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (!el || el.classList.contains('hidden')) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, sel);
/** The union of items `ids`' client boxes on page p. */
const itemsBox = (p, ids) => p.evaluate((ids) => ids.map((id) => document.querySelector(`.item[data-id="${id}"]`).getBoundingClientRect())
  .reduce((u, r) => ({ l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) }), { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }), ids);
const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const inside = (a, W, H) => a.l >= 0 && a.t >= 0 && a.r <= W && a.b <= H;
/** Page p's notices (#toast's texts, as they came: watched from now on). */
async function toasts(p) {
  await p.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(() => { const t = document.getElementById('toast').textContent; if (t && window.__toasts.at(-1) !== t) window.__toasts.push(t); })
      .observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
  });
}
const said = (p, re, ms = 10000) => until(() => p.evaluate((src) => window.__toasts.some((t) => new RegExp(src, 'u').test(t)), re.source), ms, 100);
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`) });
/** A tap (a touch, or a click) at client point q. */
const tap = (p, q, touch) => (touch ? p.touchscreen.tap(q.x, q.y) : p.mouse.click(q.x, q.y));
/** Presses a button (selector s): a tap on a touch screen, a click else. */
const press = (p, s, touch) => (touch ? p.tap(s) : p.click(s));
/** Two fingers spread from `d0` to `d1` px apart about client point c on page p (a pinch out: the view zooms in there). */
async function pinch(p, c, d0, d1) {
  const cdp = await p.context().newCDPSession(p), at = (d) => [{ x: c.x - d / 2, y: c.y, id: 1 }, { x: c.x + d / 2, y: c.y, id: 2 }];
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(d0) });
    for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(d0 + ((d1 - d0) * k) / 12) }); await h.sleep(16); }
    await h.sleep(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
}
/** A client point in the table area of page p, away from the inspector and the bar (a tap there is "outside"). */
const outside = (p) => p.evaluate(() => {
  const w = document.getElementById('table-wrap').getBoundingClientRect(), keep = ['inspector', 'action-bar', 'sel-mode'].map((id) => document.getElementById(id).getBoundingClientRect());
  for (let k = 0; k < 400; k++) {
    const x = w.left + 20 + ((w.width - 40) * ((k * 37) % 101)) / 101, y = w.top + 20 + ((w.height - 40) * ((k * 53) % 103)) / 103;
    if (!keep.some((r) => x > r.left - 10 && x < r.right + 10 && y > r.top - 10 && y < r.bottom + 10)) return { x, y };
  }
  return null;
});
/** A long press (one finger held `ms` without moving) at client point q. */
async function hold(p, q, ms = 700) {
  const cdp = await p.context().newCDPSession(p);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: q.x, y: q.y }] });
    await h.sleep(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
}
/** The client centre of item `id`'s badge (`.count` or `.fanb`) on page p. */
const badgeAt = (p, id, cls) => p.evaluate(([id, cls]) => { const r = document.querySelector(`.item[data-id="${id}"] > .${cls}`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, [id, cls]);
/** The open inspector on page p: {text, rows (its list's ids), back (a hidden face's thumbnail shows)} or null. */
const inspector = (p) => p.evaluate(() => {
  const el = document.getElementById('inspector');
  return el.classList.contains('hidden') ? null : { text: el.textContent, rows: [...el.querySelectorAll('li[data-id]')].map((li) => li.dataset.id), back: !!el.querySelector('.ithumb .pback'), k: +el.querySelector('output')?.textContent || 0 };
});

module.exports = { shown, box, itemsBox, overlap, inside, toasts, said, shot, tap, press, pinch, outside, hold, badgeAt, inspector };
