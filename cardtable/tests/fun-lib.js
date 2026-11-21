// Shared helpers for the fun-cluster suites (t-fun-*.js); not a suite itself.
const path = require('path');
const h = require('./h');

const SHOTS = path.join(__dirname, 'shots');
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`) });
const MOTION = { reducedMotion: 'no-preference' };

/** A seated player in its own context; navigator.vibrate records into window.VIB. */
async function player(env, name, url, o = {}) {
  const p = await env.page(name, o);
  await p.addInitScript(() => { window.VIB = []; navigator.vibrate = (pat) => { window.VIB.push(pat); return true; }; });
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
  return p;
}
const rect = (p, sel) => p.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const visible = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0; }, sel);
/** Clicks the action-bar command `cmd` for the item `sel`. */
async function cmd(p, sel, c) {
  await p.click(sel);
  await p.waitForSelector('#action-bar:not(.hidden)');
  await p.click(`#action-bar [data-cmd="${c}"]`);
}
const PILE = '.item.pile';

module.exports = { shot, MOTION, player, rect, overlap, visible, cmd, PILE };
