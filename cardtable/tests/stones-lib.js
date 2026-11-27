// Helpers for the go and reversi suites (t-p3-go.js, t-p3-reversi.js); not
// a suite itself. Both games are played by dragging a piece out of a supply
// (a bowl of stones, a pile of discs) onto a spot of the board; these read
// what each screen shows of the result (its view, and the pieces as drawn),
// pick a game from 🎲, press the rules' buttons, and record every toast and
// banner a page shows (they replace each other within seconds).
'use strict';
const P = require('./p2t-lib');
const S = require('./p3-lib');

/** Picks game `k` from the host's 🎲 dialog, agreeing to the "Clear the
 *  table…" confirm when one comes (returned: its text, or null). */
async function pickGame(host, k) {
  let asked = null;
  const yes = (d) => { asked = d.message(); d.accept().catch((err) => console.error('confirm accept failed', err)); };
  host.on('dialog', yes);
  try {
    await host.click('#games-btn');
    await host.waitForSelector('#games-dialog[open]');
    await host.click(`#games-list [data-game="${k}"]`);
    await host.waitForFunction(() => !document.querySelector('#games-dialog[open]'), null, { timeout: 5000 });
  } finally { host.off('dialog', yes); }
  return asked;
}
/** The 🎲 dialog's entry marked as playing on the host (its data-game), closing the dialog again. */
async function playing(host) {
  await host.click('#games-btn');
  await host.waitForSelector('#games-dialog[open]');
  const k = await host.evaluate(() => document.querySelector('#games-list .on')?.dataset.game ?? null);
  await host.evaluate(() => document.getElementById('games-dialog').close());
  return k;
}

/** Starts recording page p's toasts and banners: window.__seen = {toast, ann},
 *  each a list of {at: performance.now(), txt}. */
const record = (p) => p.evaluate(() => {
  window.__seen = { toast: [], ann: [] };
  for (const [k, id] of [['toast', 'toast'], ['ann', 'announce']]) {
    const el = document.getElementById(id);
    new MutationObserver(() => { if (el.textContent) window.__seen[k].push({ at: performance.now(), txt: el.textContent }); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  }
});
/** page p's clock (performance.now): a mark to read what it showed since. */
const mark = (p) => p.evaluate(() => performance.now());
/** The texts page p showed as `kind` ('toast' | 'ann') since `since`. */
const seen = (p, kind, since = 0) => p.evaluate(([k, t]) => window.__seen[k].filter((x) => x.at >= t).map((x) => x.txt), [kind, since]);
/** Waits until page p has shown a `kind` text matching `re` since `since`; that text, or null after `ms`. */
async function waitSeen(p, kind, re, since, ms = 8000) {
  const ok = await p.waitForFunction(([k, src, fl, t]) => window.__seen[k].some((x) => x.at >= t && new RegExp(src, fl).test(x.txt)), [kind, re.source, re.flags, since], { timeout: ms, polling: 50 }).then(() => true, () => false);
  return ok ? (await seen(p, kind, since)).find((x) => re.test(x)) : null;
}

/** Drags out of supply `id` on page p (the mouse, or a finger: `touch`) so
 *  that the piece's centre is let go over address `addr` (its spot's centre
 *  as this page resolves it): a player's move in either game. Paced as a
 *  hand moves (12 steps a frame apart), and held still a moment before the
 *  release: a finger let go mid-flick leaves Chrome flinging, and it then
 *  spends the next tap on stopping the fling (no click) — a gesture no
 *  player makes when setting a stone down. */
async function place(p, id, addr, touch) {
  const r = await p.evaluate((a) => window.__ct.resolve(a), addr);
  if (!r || r.x == null) throw new Error(`no spot ${addr} on the board`);
  const a = await S.centreOf(p, id), b = await S.screenOf(p, r.x, r.y);
  await S.gesture(p, [...S.steps(a, b, 12, 16), { ...b, wait: 120 }], { touch });
}
/** Every piece standing on a spot, as page p draws it: [{id, at, t, f, off
 *  (client px from the drawn centre to its spot's centre: a probe put in
 *  #table at the spot, so exact under the view's turn), lum (the relative
 *  luminance of its face, 0 black … 1 white)}]. */
const drawn = (p) => p.evaluate(() => {
  const v = window.__ct.view(), table = document.getElementById('table');
  const probe = (x, y) => { const i = document.createElement('i'); i.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`; table.appendChild(i); const r = i.getBoundingClientRect(); i.remove(); return { x: r.left, y: r.top }; };
  const lum = (css) => { const [r, g, b] = (css.match(/[\d.]+/g) || [0, 0, 0]).map((x) => +x / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  return [...table.querySelectorAll('.item[data-id]')].map((el) => {
    const it = v.items[el.dataset.id];
    if (!it || it.k !== 'g' || !it.at) return null;
    const r = el.getBoundingClientRect(), s = window.__ct.resolve(it.at), q = probe(s.x, s.y);
    return { id: el.dataset.id, at: it.at, t: it.t, f: it.f, off: Math.hypot(r.left + r.width / 2 - q.x, r.top + r.height / 2 - q.y), lum: lum(getComputedStyle(el.querySelector('.pface') || el).backgroundColor) };
  }).filter(Boolean);
});

/** The rules' buttons page p shows (their texts). */
const buttons = (p) => p.evaluate(() => [...document.querySelectorAll('#rules-btns button')].filter((b) => b.getClientRects().length).map((b) => b.textContent));
/** Clicks (or taps, `touch`) the rules' button on page p whose text matches `re`; false when none shows. */
async function press(p, re, touch) {
  const b = p.locator('#rules-btns button', { hasText: re }).first();
  if (!(await b.count()) || !(await b.isVisible())) return false;
  if (touch) await b.tap(); else await b.click();
  return true;
}
/** Page p's seat label texts. */
const seatTexts = (p) => p.evaluate(() => [...document.querySelectorAll('.seat')].map((el) => el.textContent));

/** The lines of log `after` that came after the last line of log `before`
 *  (both lists of {p, txt, ts}; matched from the end, so a log trimmed at
 *  its start still works). */
function newLines(before, after) {
  if (!before.length) return after;
  const last = JSON.stringify(before.at(-1));
  for (let k = after.length - 1; k >= 0; k--) if (JSON.stringify(after[k]) === last) return after.slice(k + 1);
  throw new Error('newLines: the log no longer holds the last line before the move');
}
/** Waits until fn(page's view) — an expression over `v`, the view, and `a` — holds on every page; true, or false after `ms`. */
async function everywhere(pages, expr, a, ms = 15000) {
  return (await Promise.all(pages.map((p) => P.waitView(p, expr, a, ms)))).every(Boolean);
}

module.exports = { pickGame, playing, record, mark, seen, waitSeen, place, drawn, buttons, press, seatTexts, newLines, everywhere };
