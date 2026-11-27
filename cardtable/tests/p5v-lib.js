// Helpers for the Phase 5 suites written from the spec, apart from the
// implementation's own t-p5-private.js (t-p5-veil.js, t-p5-veil-cli.js,
// t-p5-bones.js, t-p5-order.js); not a suite itself. Mallory's records read
// back, the recursive scans of everything she got, and what a screen draws
// of a piece — read off the DOM by what a player sees (a 🙈, a face's text),
// not by the implementation's class names where the spec names none.
'use strict';
const h = require('./h');
const { mallory } = require('./final-lib');

/** Mallory (final-lib's raw peer, no app code) in the room of `invite`, once
 *  she sees `peers` others, with readers of what she got: `bodies()` her
 *  `state` bodies in arrival order (snapshots and patches, unwrapped),
 *  `notes()` her `note` bodies, `others()` every other channel's messages
 *  but the public catalog's (decks, boxes): {ch, m}, `said(from)` her
 *  notices' texts, `tries(actions)` sends actions and returns the notices
 *  they bring her, `count()` how many bodies she has. */
async function spy(env, invite, peers = 2) {
  const M = await mallory(env, invite, peers);
  M.bodies = () => M.evaluate(() => window.M.got.state.map(({ m }) => (typeof m?.b === 'string' ? JSON.parse(m.b) : m)));
  M.notes = () => M.evaluate(() => window.M.notes());
  M.others = () => M.evaluate(() => Object.entries(window.M.got).filter(([ch]) => !['state', 'note', 'decks', 'boxes', 'asset'].includes(ch))
    .flatMap(([ch, list]) => list.map(({ m }) => ({ ch, m: typeof m?.b === 'string' ? JSON.parse(m.b) : m }))));
  M.count = () => M.evaluate(() => window.M.got.state.length);
  M.said = async (from = 0) => (await M.notes()).filter((n) => n.msg).map((n) => n.msg).slice(from);
  /** Sends actions `as` one by one and returns the `k` notices they bring her (in order; [] after 15 s without them).
   *  It first waits 2.2 s: the host sends a peer at most 10 notices, then 5 a second (§0.1 flood control), and drops the rest. */
  M.tries = async (as, k = as.length) => {
    await h.sleep(2200);
    const n0 = (await M.said()).length;
    for (const a of as) await M.act(a);
    const got = await M.waitForFunction((n) => window.M.notes().filter((x) => x.msg).length >= n, n0 + k, { timeout: 15000 }).then(() => true, () => false);
    if (!got) console.error(`  (Mallory: ${k} notices expected, got ${(await M.said(n0)).length})`);
    return M.said(n0);
  };
  /** Says hello (a keyed action: the host registers her) until a snapshot addressed to her arrives after body `from`: whether one did. */
  M.hello = async (from) => {
    for (const end = Date.now() + 20000; Date.now() < end;) {
      await M.act({ t: 'hello' });
      if (await M.waitForFunction((n) => window.M.got.state.slice(n).some(({ m }) => { const b = typeof m?.b === 'string' ? JSON.parse(m.b) : m; return b.kind === 'snap' && b.to === 'ffffffffffffffff'; }), from, { timeout: 4000 }).then(() => true, () => false)) return true;
    }
    return false;
  };
  return M;
}
const MAL = 'ffffffffffffffff';

/** Every occurrence of one of `tokens` in JSON value v — in a key or in a
 *  string, at any depth (a recursive scan): [path, token] pairs. */
function scan(v, tokens, path = '$', out = []) {
  if (typeof v === 'string') { for (const t of tokens) if (v.includes(t)) out.push([path, t]); } else if (Array.isArray(v)) v.forEach((x, k) => scan(x, tokens, `${path}[${k}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      for (const t of tokens) if (k.includes(t)) out.push([`${path}.${k}`, t]);
      scan(x, tokens, `${path}.${k}`, out);
    }
  }
  return out;
}
/** The fields a piece hidden from a viewer may carry in what that viewer gets (spec §5d, §2d): its back and its place. */
const REDUCED = ['k', 'b', 'x', 'y', 'rot', 'z', 'n', 'owner', 'lock', 'at'];
/** Every record of item `id` in bodies `list` — the shared form (`items`) and
 *  any per-recipient form (`vis`) — as {k (the body's index), where, f}. */
const forms = (list, id) => list.flatMap((b, k) => [['items', b?.items?.[id]], ['vis', b?.vis?.[id]]].filter(([, f]) => f).map(([where, f]) => ({ k, where, f })));
/** The records of `ids` in `list` that would tell a viewer more than a hidden
 *  piece's reduced form: any override, or any field beyond REDUCED (t, f, up, vis, pv, po…). */
const told = (list, ids) => ids.flatMap((id) => forms(list, id).filter(({ where, f }) => where === 'vis' || Object.keys(f).some((x) => !REDUCED.includes(x))).map((x) => ({ id, ...x })));

/** What page p draws of item `id`, as a player sees it: {text (its visible
 *  text: a face's label), badge (a 🙈 shows on it), veiled (the hatched
 *  corner's class, D263), title (its tooltip)}; null when it isn't drawn. */
const drawn = (p, id) => p.evaluate((id) => {
  const el = document.querySelector(`#table .item[data-id="${id}"]`);
  if (!el) return null;
  const shows = (e) => e.getClientRects().length > 0 && window.getComputedStyle(e).display !== 'none' && window.getComputedStyle(e).visibility !== 'hidden';
  return {
    text: el.innerText, title: el.title, veiled: el.classList.contains('veiled'),
    badge: [...el.querySelectorAll('*')].some((e) => e.childElementCount === 0 && e.textContent.trim() === '🙈' && shows(e)),
  };
}, id);
/** What page p shows in the elements of `ids` (by default the table, the log, the notices and the bar), as markup: dialogs aside — the public catalog may be listed there. */
const screenText = (p, ids = ['table', 'log', 'toast', 'action-bar']) => p.evaluate((ids) => ids.map((id) => document.getElementById(id)?.outerHTML || '').join('\n'), ids);
/** Installs, on page p, a record of the items its screen tumbles (a die's
 *  roll, on every screen: the `.tumble` class, D-pieces.js): window.__tumbles. */
const watchTumbles = (p) => p.evaluate(() => {
  window.__tumbles = [];
  new MutationObserver((ms) => { for (const m of ms) if (m.target.classList?.contains('tumble')) window.__tumbles.push(m.target.dataset.id); })
    .observe(document.getElementById('table'), { subtree: true, attributes: true, attributeFilter: ['class'] });
});
/** The 99 % one-sided binomial bound for a rate p over n trials: p + 2.326·√(p(1−p)/n). */
const bound99 = (p, n) => p + 2.326 * Math.sqrt((p * (1 - p)) / n);

module.exports = { spy, MAL, scan, REDUCED, forms, told, drawn, screenText, watchTumbles, bound99 };
