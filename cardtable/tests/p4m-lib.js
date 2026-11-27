// Helpers for the 4B suites written from the spec (t-p4-multi.js,
// t-p4-inspect.js: §4l t-p4-select, independent of the implementation's own
// t-p4-select.js); not a suite itself. Everything here reads the screen (the
// DOM, the view a page draws) or drives real gestures: a mouse with the
// keyboard's Shift, and CDP touches (one finger, a long press, two fingers).
'use strict';
const path = require('path');
const h = require('./h');
const L = require('./p1-lib');
const P3 = require('./p3-lib');
const { watchers } = require('./p4-lib');

const SHOTS = path.join(__dirname, 'shots');

/** A player in its own context (`o.ctx`: a device descriptor), joined as
 *  `name` once the host knows it, with p1-lib's RTC hook (window.__rtc),
 *  p3-lib's actTap (window.__acts: every action it sends, {at, a}) and
 *  p4-lib's watchers (window.__toasts: every notice it shows, {at, msg}).
 *  `page.pid` is its id, `page.touch` whether it is a touch screen. */
async function join(env, name, url, o = {}) {
  const p = await env.page(name, o);
  for (const s of [L.rtcHook, P3.actTap, watchers]) await p.addInitScript(s);
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
  p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
  p.touch = !!o.ctx?.hasTouch;
  p.label = name;
  return p;
}

/** Page p's view items, as plain JSON ({id: item}). */
const items = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__ct.view().items)));
/** The ids of the shown items of `its` whose type is `ty` (a 'box/type' ref ending in it), sorted. */
const ofType = (its, ty) => Object.keys(its).filter((id) => its[id].t?.endsWith(`/${ty}`)).sort();
/** The id of the item of `its` whose centre is (x, y) (within 1), for a piece of size s × s; null when none or several. */
function idAt(its, x, y, s = 60, pred = () => true) {
  const ids = Object.keys(its).filter((id) => its[id].k !== 'b' && Math.abs(its[id].x + s / 2 - x) < 1 && Math.abs(its[id].y + s / 2 - y) < 1 && pred(its[id]));
  return ids.length === 1 ? ids[0] : null;
}

/** The ids page p draws with .selected, sorted. */
const selected = (p) => p.evaluate(() => [...document.querySelectorAll('#table .item.selected')].map((e) => e.dataset.id).sort());
/** Page p's action bar: {on (shown), text, btns (each button's text), box (client rect)}. */
const bar = (p) => p.evaluate(() => {
  const b = document.getElementById('action-bar'), on = !b.classList.contains('hidden') && getComputedStyle(b).display !== 'none' && b.getClientRects().length > 0;
  const r = b.getBoundingClientRect();
  return { on, text: on ? b.textContent : '', btns: on ? [...b.querySelectorAll('button')].map((x) => x.textContent.trim()) : [], box: on ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null };
});
/** The text of page p's selection chip ('' while hidden). */
const chip = (p) => p.evaluate(() => { const c = document.getElementById('sel-chip'); return c && !c.classList.contains('hidden') && c.getClientRects().length ? c.textContent : ''; });
/** Whether page p shows the rubber band now. */
const bandShown = (p) => p.evaluate(() => { const b = document.getElementById('band'); return !!b && !b.classList.contains('hidden') && b.getClientRects().length > 0 && b.getBoundingClientRect().width > 4; });
/** Page p's ⬚ toggle: {on (aria-pressed), shown, box (client rect and centre), wrap (#table-wrap's rect)}. */
const selMode = (p) => p.evaluate(() => {
  const b = document.getElementById('sel-mode'), r = b.getBoundingClientRect(), w = document.getElementById('table-wrap').getBoundingClientRect();
  return { on: b.getAttribute('aria-pressed') === 'true', shown: b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none', box: { l: r.left, t: r.top, r: r.right, b: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 }, wrap: { l: w.left, t: w.top, r: w.right, b: w.bottom } };
});
/** Whether client rect r lies inside page p's viewport. */
const inViewport = (p, r) => p.evaluate((r) => r.l >= -0.5 && r.t >= -0.5 && r.r <= innerWidth + 0.5 && r.b <= innerHeight + 0.5, r);

/** The client point of table point (x, y) on page p (exact under any view turn). */
const pt = (p, x, y) => P3.screenOf(p, x, y);
/** What page p would hit at client point q: an item's id, or the id or tag of what is there. */
const hit = (p, q) => p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e?.closest('.item')?.dataset.id || e?.id || e?.tagName || null; }, [q.x, q.y]);
/** The client centre of item `id`'s element on page p (where it is drawn), or null. */
const centre = (p, id) => P3.centreOf(p, id);
/** The client centre of item `id`'s badge on page p: `cls` 'count' (×N) or 'fanb' (a crowded spot's ×k); null when it has none. */
const badge = (p, id, cls) => p.evaluate(([id, cls]) => {
  const el = document.querySelector(`.item[data-id="${id}"] > .${cls}`);
  if (!el || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
}, [id, cls]);

// --- the mouse and the keyboard ------------------------------------------------
/** A mouse drag on page p through client points `pts` (the first is the
 *  press), Shift held when `shift`; `mid()` runs before the release. */
async function mouseDrag(p, pts, { shift = false, mid, pause = 0 } = {}) {
  if (shift) await p.keyboard.down('Shift');
  try { await P3.gesture(p, pts, { pause, mid }); } finally { if (shift) await p.keyboard.up('Shift'); }
}
/** A click (Shift held when `shift`) at client point q on page p. */
async function click(p, q, shift = false) {
  if (shift) await p.keyboard.down('Shift');
  try { await p.mouse.click(q.x, q.y); } finally { if (shift) await p.keyboard.up('Shift'); }
}

// --- touches (CDP: pointerType 'touch') -----------------------------------------
/** Runs fn(t) with t(type, points) dispatching CDP touch events on page p. */
async function touches(p, fn) {
  const cdp = await p.context().newCDPSession(p);
  try { await fn((type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })); } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
}
/** A one-finger tap at client point q on page p. */
const tap = (p, q) => touches(p, async (t) => { await t('touchStart', [{ x: q.x, y: q.y }]); await h.sleep(40); await t('touchEnd', []); });
/** A one-finger press held `ms` without moving at client point q on page p. */
const longPress = (p, q, ms = 800) => touches(p, async (t) => { await t('touchStart', [{ x: q.x, y: q.y }]); await h.sleep(ms); await t('touchEnd', []); });
/** A one-finger drag on page p through client points `pts`, each move
 *  followed by `pause` ms; `mid()` runs before the lift. The finger then
 *  rests 400 ms, as a hand does: a touch that lands while the swipe's
 *  fling still runs only stops the fling (Chromium suppresses its tap). */
async function fingerDrag(p, pts, { pause = 16, mid } = {}) {
  await P3.gesture(p, pts, { touch: true, pause, mid });
  await h.sleep(400);
}
/** Two fingers spread on page p from `d0` to `d1` px apart about client point c (the view zooms in there). */
const spread = (p, c, d0, d1) => touches(p, async (t) => {
  const at = (d) => [{ x: c.x - d / 2, y: c.y, id: 1 }, { x: c.x + d / 2, y: c.y, id: 2 }];
  await t('touchStart', at(d0));
  for (let k = 1; k <= 14; k++) { await t('touchMove', at(d0 + ((d1 - d0) * k) / 14)); await h.sleep(20); }
  await h.sleep(400);
  await t('touchEnd', []);
});
const reText = (t) => new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'u');
/** A press of the visible button reading exactly `text` inside `scope` on page p: a tap on a touch screen, else a click. */
async function press(p, scope, text) {
  const b = p.locator(`${scope} button:visible`, { hasText: reText(text) }).first();
  if (p.touch) await b.tap();
  else await b.click();
}
/** A press of the action bar's button reading exactly `text`. */
const barPress = (p, text) => press(p, '#action-bar', text);

// --- what was sent, said and logged --------------------------------------------
/** How many actions page p has sent (actTap). */
const nSent = (p) => p.evaluate(() => window.__acts.length);
/** The actions page p sent from the `from`-th on: [{at (performance.now()), a}]. */
const sent = (p, from = 0) => p.evaluate((n) => window.__acts.slice(n), from);
/** The notices page p showed since `at` (Date.now()). */
const notes = (p, at = 0) => p.evaluate((at) => window.__toasts.filter((x) => x.at >= at).map((x) => x.msg), at);
/** The log lines page p shows in player `who`'s name (a pid, or 'rules') since `at` (Date.now(), host clock: one machine). */
const lines = (p, who, at = 0) => p.evaluate(([who, at]) => window.__ct.log().filter((e) => (who === 'rules' ? !/^[0-9a-f]{16}$/.test(e.p || '') : e.p === who) && (e.ts ?? 0) >= at).map((e) => e.txt), [who, at]);
/** The most `drag` messages in any one second among `acts` ([{at, a}]). */
function peakRate(acts) {
  const ts = acts.map((x) => x.at).sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= 1000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`) });
/** Waits until fn() (async) is truthy; false after `ms`. */
const until = L.until;

module.exports = {
  join, items, ofType, idAt, selected, bar, chip, bandShown, selMode, inViewport, pt, hit, centre, badge,
  mouseDrag, click, touches, tap, longPress, fingerDrag, spread, press, barPress, nSent, sent, notes, lines, peakRate, shot, until,
};
