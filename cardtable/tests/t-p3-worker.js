// E2E: the rules Worker (spec §3f; §3l "t-p3-worker.js" items 1–12, and
// "t-p3-space.js" item 5 — strict — as its own section here). Alice hosts on a
// desktop, Bob plays on another; Carol and Dave sit in for the 4-player
// templates of section 1 and then leave; Phoebe hosts a room of her own on an
// iPhone 13 for the 📜 dialog's error display. Every expectation is the
// spec's: a script never runs on the page, so what it did is read from the
// log, both screens' views (__ct.view()), the host's __ct (lastRulesError,
// digest(), workerDigest(), jobs(), perf) and the toasts.
//
// Sections (ONLY=3,5 runs some of them; the fixture is always made), and the
// §3l t-p3-worker item each one is:
//   1  every shipped template, enabled from 🎲 (blank from the 📜 dialog) — 1
//   2  strict and allow — t-p3-space item 5
//   3  atomicity: handle throws after t.move, onAction after t.flip — 3
//   4  setTimeout in a hook — 4
//   5  the async guards: a stray t.say, a stray t.data write, an async validate — 5
//   6  page APIs (and fetch, §3j attacker case 6) — 9
//   7  a syntax error on Enable keeps the running rules ("Starting…", a job
//      queued behind a starting Worker, Disable) — 6
//   8  the dialog's errors on an iPhone 13 — 6, on a phone
//   9  workerDigest() equals the host's digest after 300 actions — 8
//   10 the infinite loop of B14 — 2
//   11 the watchdog: a frozen host page, a hidden one, a genuine loop — 10
//   12 a host reload with the rules on — 7
//   13 module skew (on Enable, and on a host's resume) — 12
//   14 demotion by a second host tab — 11
//
// Section 11's frozen page: CDP's Page.setWebLifecycleState 'frozen' takes no
// effect on a page headless Chromium keeps visible (its timers run on, no
// `freeze` event: checked first, every run), so the suite then does what a
// frozen tab does to the page — hidden, `freeze`, no task runs for the
// frozen time (a 6 s stall of its main thread: the Worker's `done` waits),
// `resume`, visible — and says which of the two it used.
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./h');
const { ok, section, logHas, toastHas, sleep } = h;

const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
const run = (k) => !ONLY || ONLY.includes(k);
const J = JSON.stringify;
const SHOTS = path.join(__dirname, 'shots');
const WORKER_TEXT = "rules now run in a Worker, away from the page (see ENGINE.md, 'Running in a Worker')";
const STUB_TEXT = (k) => `${k} is not available to rules scripts — use t.schedule(seconds, tag)`;

// --- page helpers ---------------------------------------------------------------
/** Page p's own act() (the host's resolves once the job is applied: {ok, error?}). */
const act = (p, a) => p.evaluate((a) => window.__ct.act(a), a);
const itemOf = (p, id) => p.evaluate((id) => window.__ct.view().items[id] || null, id);
const rulesOn = (p) => p.evaluate(() => !!window.__ct.view().rules?.enabled);
const logText = (p) => p.evaluate(() => document.getElementById('log').textContent);
/** A bounded wait: true when `fn(arg)` held within `ms`, else false (never throws). */
const until = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const seen = (p, txt, ms = 10000) => logHas(p, txt, ms).then(() => true, () => false);
// (The log keeps its newest lines only: a count over all of it can drop as old
// lines go. Lines are told apart by their time stamp instead: a mark.)
/** Page p's clock (Date.now()): the log lines that follow are stamped at or after it. */
const mark = (p) => p.evaluate(() => Date.now());
/** The texts of page p's log lines stamped at or after mark t0. */
const since = (p, t0) => p.evaluate((t0) => window.__ct.log().filter((l) => l.ts >= t0).map((l) => l.txt), t0);
/** Waits until page p's log has a line stamped at or after t0 that includes txt. */
const loggedSince = (p, t0, txt, ms = 10000) => until(p, ([t0, txt]) => window.__ct.log().some((l) => l.ts >= t0 && l.txt.includes(txt)), [t0, txt], ms);
const clearToast = (p) => p.evaluate(() => { document.getElementById('toast').textContent = ''; });
/** Runs `fn` and says whether page p then toasts `txt` (the old text cleared first: it outlives hiding). */
async function toasted(p, txt, fn, ms = 10000) {
  await clearToast(p);
  await fn();
  return toastHas(p, txt, ms).then(() => true, () => false);
}
/** Waits until item `id`'s field `k` reads `v` in page p's view. */
const itemIs = (p, id, k, v, ms) => until(p, ([id, k, v]) => window.__ct.view().items[id]?.[k] === v, [id, k, v], ms);
const lastErr = (host) => host.evaluate(() => window.__ct.lastRulesError);
const perf = (host) => host.evaluate(() => ({ ...window.__ct.perf }));
/** The rules are off on the host's screen and its queue is empty. */
const offAndIdle = (host, ms = 15000) => until(host, () => !window.__ct.view().rules?.enabled && window.__ct.jobs() === 0, null, ms);
/** [the Worker's digest, the host's], taken at one instant with no job queued or in flight. */
const digests = (host) => host.evaluate(async () => {
  const end = performance.now() + 15000;
  while (window.__ct.jobs() && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
  if (window.__ct.jobs()) return ['still busy', null];
  const hd = window.__ct.digest();
  return [await window.__ct.workerDigest(), hd];
});
/** Who holds ⏳ on page p's seat labels (or null). */
const turnOf = (p) => p.evaluate(() => {
  for (const s of document.querySelectorAll('.seat')) { const m = s.textContent.match(/⏳ (\S+)/); if (m) return m[1]; }
  return null;
});
/** The Card Czar (👑) on page p's seat labels (t-cah.js). */
const czarName = (p) => p.evaluate(() => {
  for (const s of document.querySelectorAll('.seat')) { const m = s.textContent.match(/(\S+) 🂠\d+ ⭐\d+ 👑/); if (m) return m[1]; }
  return null;
});
const currentPick = (p) => p.evaluate(() => {
  const ms = [...document.getElementById('log').textContent.matchAll(/answer with (\d) card/g)];
  return ms.length ? +ms[ms.length - 1][1] : null;
});
/** Card names ("10♥") of page p's hand (t-bridge.js). */
const handOf = (p) => p.$$eval('.hcard', (els) => els.map((el) => (el.querySelector('.mr')?.textContent || '') + (el.querySelector('.ms')?.textContent || '')));

/** Page p's host freezes for `ms`, in the middle of whatever runs: through
 *  CDP (Page.setWebLifecycleState) when that takes — the page then answers
 *  nothing — else as a frozen tab is to the page: hidden, `freeze`, its main
 *  thread stalled (no task runs: a Worker's message waits), `resume`,
 *  visible. Resolves 'cdp' or 'emulated'. */
async function freeze(p, ms) {
  const cdp = await p.context().newCDPSession(p);
  try {
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    const answers = await Promise.race([p.evaluate(() => true), sleep(500).then(() => false)]);
    if (!answers) {
      await sleep(ms - 500);
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      return 'cdp';
    }
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await p.evaluate((ms) => {
      const vis = (hidden) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      };
      vis(true);
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('freeze'));
      const end = performance.now() + ms;
      while (performance.now() < end); // (frozen: no timer fires, no message is read)
      document.dispatchEvent(new Event('resume'));
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    }, ms);
    return 'emulated';
  } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
}
/** Page p reads as hidden (visibilitychange) — it still runs — or visible again. */
const setHidden = (p, hidden) => p.evaluate((hidden) => {
  if (hidden) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  } else {
    delete document.hidden;
    delete document.visibilityState;
  }
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

/** The 📜 dialog as page p shows it: the error line, the dialog and its
 *  shown buttons (client px), and whether each is the top element at its
 *  centre (not covered, not off screen). */
const dialogLayout = (p) => p.evaluate(() => {
  const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const onTop = (el) => {
    const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + Math.min(b.height / 2, 8);
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top));
  };
  const err = document.getElementById('rules-err'), dlg = document.getElementById('rules-dialog'), cs = getComputedStyle(err);
  const btns = [...dlg.querySelectorAll('menu button')].filter((b) => getComputedStyle(b).display !== 'none' && b.getClientRects().length);
  return {
    vw: innerWidth, vh: innerHeight, open: dlg.open, text: err.textContent, status: document.getElementById('rules-status').textContent,
    err: box(err), dlg: box(dlg), errTop: onTop(err), overflowX: err.scrollWidth - err.clientWidth, font: parseFloat(cs.fontSize),
    line: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2, pageOverflow: document.documentElement.scrollWidth - innerWidth,
    btns: btns.map((b) => ({ txt: b.textContent.trim(), ...box(b), top: onTop(b) })),
  };
});
const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
/** The checks of "the dialog's error reads well at 390 px" for layout L. */
function readsWell(L, who) {
  ok(L.open && L.text.length > 0, `${who}: the dialog stays open showing the error ("${L.text.slice(0, 80)}")`);
  ok(L.dlg.l >= 0 && L.dlg.r <= L.vw + 0.5 && L.pageOverflow <= 0, `${who}: the dialog fits the ${L.vw} px width (${Math.round(L.dlg.l)}–${Math.round(L.dlg.r)}), no page scroll across`);
  ok(L.err.l >= L.dlg.l && L.err.r <= L.dlg.r && L.err.t >= 0 && L.err.b <= L.vh && L.errTop, `${who}: the error line lies on screen, inside the dialog, uncovered (${Math.round(L.err.t)}–${Math.round(L.err.b)} of ${L.vh})`);
  ok(L.overflowX <= 0 && L.font >= 12, `${who}: the error wraps inside its box (overflow ${L.overflowX} px), at ${L.font} px`);
  ok(L.btns.length >= 2 && L.btns.every((b) => b.l >= 0 && b.r <= L.vw + 0.5 && b.t >= 0 && b.b <= L.vh && b.top && !overlaps(b, L.err)),
    `${who}: ${L.btns.map((b) => b.txt).join(', ')} are on screen, uncovered and clear of the error`);
}

/** Drops page p's first hand card at one of three spots near its rim (t-cah.js). */
async function playCard(p, k) {
  await h.playFromHand(p, 0, [0.42, 0.58, 0.5][k % 3], [0.75, 0.75, 0.67][k % 3]);
}
async function submit(p, pick) {
  for (let k = 0; k < pick; k++) {
    const before = await h.handCount(p);
    await playCard(p, k);
    await h.waitHand(p, before - 1);
  }
}
async function join(env, host, name, seats) {
  const p = await env.page(name);
  await p.goto(host.url());
  await h.joinAs(p, name);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
  await host.waitForFunction((k) => document.querySelectorAll('.seat').length === k, seats, { timeout: 30000 });
  return p;
}

/** Sets up a cleared table's fixture: a standard deck and two face-up cards
 *  (A left, B right of the centre), made by a script's setup — in its Worker. */
const FIXTURE = `({ name: 'Fixture', setup(t) {
  const g = t.geom(), pile = t.addStandardDeck({ x: g.cx - 50, y: g.cy - 280 });
  const a = t.deal(pile, { x: g.cx - 260, y: g.cy + 20, up: true }), b = t.deal(pile, { x: g.cx + 160, y: g.cy + 20, up: true });
  t.public.fx = { pile, a: a.id, b: b.id };
} })`;

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const invite = host.url();
  const bob = guest;
  const bobPid = await bob.evaluate(() => localStorage.getItem('ct-pid'));
  const room = invite.match(/#room~([0-9a-f]+)/)[1];
  host.on('dialog', (d) => d.accept().catch((err) => console.error('dialog accept failed', err)));
  const hostErrors = [];
  host.on('console', (m) => { if (m.type() === 'error') hostErrors.push(m.text()); });
  /** The host enables `code` (setRules through act: resolves once its Worker is ready and setup applied). */
  const enable = (code, o = {}) => act(host, { t: 'setRules', code, enabled: true, ...o });
  const disable = () => act(host, { t: 'setRules', enabled: false });
  const inWorker = async (what) => {
    const [wd, hd] = await digests(host);
    ok(typeof wd === 'number' && wd === hd, `${what} runs in a rules Worker whose mirror equals the host's table (digest ${wd} = ${hd})`);
  };

  // 1 ─────────────────────────────────────────────────────────────────────────
  if (run(1)) {
    section('1. every shipped template, enabled from 🎲, plays in the Worker');
    const P = { Alice: host, Bob: bob };
    P.Carol = await join(env, host, 'Carol', 3);
    P.Dave = await join(env, host, 'Dave', 4);
    const names = Object.keys(P);
    /** Picks game k in the 🎲 dialog and waits for its Worker to start and its setup to apply. */
    const fromDice = async (k, title) => {
      const n = (await perf(host)).workerStarts;
      await host.click('#games-btn');
      await host.waitForSelector('#games-dialog[open]');
      await host.click(`#games-list [data-game="${k}"]`);
      const up = await until(host, ([n, title]) => window.__ct.perf.workerStarts === n + 1 && window.__ct.jobs() === 0
        && window.__ct.view().rules?.enabled && window.__ct.view().rules.name === title, [n, title], 20000);
      ok(up, `🎲 ${k}: one new Worker started, «${title}» is on`);
      await inWorker(`«${title}»`);
    };

    // turns: ⏳, an out-of-turn draw refused, a play passes the turn on
    await fromDice('turns', 'Turn order');
    ok(await until(host, () => [...document.querySelectorAll('.seat')].some((s) => /⏳ \S/.test(s.textContent)), null, 10000), 'turns: ⏳ marks the player to move');
    const first = await turnOf(host), other = names.find((n) => n !== first);
    const h0 = await h.handCount(P[other]);
    ok(await toasted(P[other], 'not your turn', () => P[other].dblclick('.item.pile')), `turns: ${other} drawing out of turn is told "It's not your turn"`);
    ok((await h.handCount(P[other])) === h0, `turns: ${other}'s hand is unchanged`);
    const f0 = await h.handCount(P[first]);
    await P[first].dblclick('.item.pile');
    await h.waitHand(P[first], f0 + 1);
    await h.playFromHand(P[first], 0, 0.6, 0.6);
    ok(await until(bob, (n) => [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⏳ ')) && ![...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⏳ ' + n)), first, 10000),
      `turns: ${first} drew and played, and ⏳ moved on (Bob's screen)`);

    // dealer: Deal 1 to all
    await fromDice('dealer', 'Simple dealer');
    const before = {};
    for (const n of names) before[n] = await h.handCount(P[n]);
    await bob.waitForSelector('#rules-btns [data-rbtn="deal1"]', { timeout: 10000 });
    await bob.click('#rules-btns [data-rbtn="deal1"]');
    let dealt = true;
    for (const n of names) dealt = (await h.waitHand(P[n], before[n] + 1).then(() => true, () => false)) && dealt;
    ok(dealt, 'dealer: Bob\'s "Deal 1 to all" gave each of the four one card');

    // Hold'em: a hand to the flop (before Bridge: a Bridge deal leaves every
    // card in the hands, and New hand wants a deck pile — "No deck on the table!")
    await fromDice('holdem', "Hold'em (chips)");
    await host.waitForSelector('#rules-btns [data-rbtn="new"]', { timeout: 10000 });
    await host.click('#rules-btns [data-rbtn="new"]');
    let two = true;
    for (const n of names) two = (await h.waitHand(P[n], 2).then(() => true, () => false)) && two;
    ok(two, "Hold'em: New hand deals 2 hole cards to each of the four");
    const end = Date.now() + 40000;
    while (Date.now() < end && !(await logText(host)).includes('Flop — pot')) {
      let clicked = false;
      for (const n of names) {
        const b = await P[n].$('#rules-btns [data-rbtn="call"], #rules-btns [data-rbtn="check"]');
        if (!b) continue;
        const id = await b.getAttribute('data-rbtn');
        await b.click().catch((err) => console.error(`${n}: ${id} click failed`, err.message));
        await until(P[n], (id) => !document.querySelector(`#rules-btns [data-rbtn="${id}"]`), id, 10000);
        clicked = true;
        break;
      }
      if (!clicked) await sleep(150);
    }
    ok(await seen(host, 'Flop — pot', 1000), "Hold'em: calls and a check close the round — the flop deals itself");
    ok(await until(bob, () => [...document.querySelectorAll('.item:not(.pile)')].filter((el) => el.querySelector('.std')).length === 3, null, 10000),
      "Hold'em: Bob's screen shows the three flop cards");

    // Bridge: a deal, 13 each, the auction opens
    await fromDice('bridge', 'Bridge');
    ok(await seen(host, 'Bridge: press Deal'), 'Bridge: setup says "press Deal" with 4 online');
    await bob.waitForSelector('#rules-btns [data-rbtn="deal"]', { timeout: 10000 });
    await bob.click('#rules-btns [data-rbtn="deal"]');
    let thirteen = true;
    for (const n of names) thirteen = (await h.waitHand(P[n], 13).then(() => true, () => false)) && thirteen;
    await Promise.all(names.map((n) => P[n].waitForSelector('.hcard .mr', { timeout: 10000 }).catch(() => null)));
    const all = (await Promise.all(names.map((n) => handOf(P[n])))).flat();
    ok(thirteen && new Set(all).size === 52, `Bridge: Deal → 13 cards each, 52 distinct (${new Set(all).size})`);
    ok(await seen(host, 'bids first'), 'Bridge: the auction opens');

    // CAH: one round, which needs window.CAH_CARDS inside the Worker
    await fromDice('cah', 'Cards Against Humanity');
    const nWhite = await host.evaluate(() => window.CAH_CARDS.white.length), nBlack = await host.evaluate(() => window.CAH_CARDS.black.length);
    const log1 = await logText(host);
    ok(log1.includes(`defined deck "CAH White" (${nWhite} cards)`) && log1.includes(`defined deck "CAH Black" (${nBlack} cards)`),
      `CAH: the Worker read window.CAH_CARDS (${nWhite} white, ${nBlack} black cards defined)`);
    ok(await until(host, () => /(\S+) 🂠\d+ ⭐\d+ 👑/.test([...document.querySelectorAll('.seat')].map((s) => s.textContent).join('|')), null, 10000), 'CAH: a Card Czar is crowned');
    const czar = await czarName(host), pick = await currentPick(host);
    let ten = true;
    for (const n of names) ten = (await h.waitHand(P[n], 10 + (pick === 3 && n !== czar ? 2 : 0)).then(() => true, () => false)) && ten;
    ok(ten && pick >= 1, `CAH: everyone holds 10 white cards (PICK ${pick}, Czar ${czar})`);
    for (const n of names) if (n !== czar) await submit(P[n], pick);
    ok(await seen(host, 'judges — press 👉', 20000), 'CAH: all three answered, the Czar judges');
    await P[czar].waitForSelector('#rules-btns [data-rbtn="pick0"]', { timeout: 10000 });
    await P[czar].click('#rules-btns [data-rbtn="pick0"]'); // (👉 1)
    ok(await seen(host, 'wins the round with #1'), 'CAH: the Czar crowned answer #1');
    ok(await until(host, (c) => { // (the next round comes from t.schedule: a _tick job in the Worker)
      for (const s of document.querySelectorAll('.seat')) { const m = s.textContent.match(/(\S+) 🂠\d+ ⭐\d+ 👑/); if (m) return m[1] !== c; }
      return false;
    }, czar, 15000), 'CAH: 4 s later the next round starts with the next Czar (a timer in the Worker)');
    await inWorker('CAH after a round');

    // blank (not in 🎲: the 📜 dialog's template list)
    await h.enableRules(host, { tpl: 'blank' });
    ok(await seen(host, 'Rules are on.') && await rulesOn(host), 'blank (📜 dialog): its setup ran, the rules are on');
    if (await host.$('#rules-dialog[open]')) await host.click('#rules-dialog button[value="cancel"]');

    // the free table: no Worker
    await host.click('#games-btn');
    await host.waitForSelector('#games-dialog[open]');
    await host.click('#games-list [data-game="free"]');
    ok(await offAndIdle(host), '🎲 Free table: the rules are off');
    ok(await host.evaluate(() => window.__ct.workerDigest()) === null, 'Free table: no rules Worker runs');
    for (const n of ['Carol', 'Dave']) await P[n].context().close();
    await host.waitForFunction(() => document.querySelectorAll('.seat.offline').length === 2, null, { timeout: 20000 });
  }

  // The fixture ────────────────────────────────────────────────────────────────
  section('fixture: a cleared table, a deck and two face-up cards (made by a script)');
  if (await rulesOn(host)) await disable();
  await act(host, { t: 'clear' });
  ok((await enable(FIXTURE)).ok, 'the fixture script ran');
  const fx = await host.evaluate(() => window.__ct.view().rules.public.fx);
  const A = fx.a, B = fx.b;
  ok(!!(await itemOf(host, A)) && !!(await itemOf(host, B)) && await until(bob, ([a, b]) => !!window.__ct.view().items[a] && !!window.__ct.view().items[b], [A, B]),
    'cards A and B are on both screens');
  await disable();
  ok(await offAndIdle(host), 'and the rules are off again');
  const nextRot = async (id) => (((await itemOf(host, id)).rot || 0) + 90) % 360;

  // 2 ─────────────────────────────────────────────────────────────────────────
  if (run(2)) {
    section('2. strict (t-p3-space item 5): del and flip refused; the allow types and seat allowed');
    await enable("({ name: 'Strict', strict: true, allow: ['rot', 'move'] })");
    ok(await until(bob, () => window.__ct.view().rules?.strict === true && window.__ct.view().rules.enabled, null, 10000), "Bob's rules view says strict");
    ok(await toasted(bob, 'Not a move in this game', () => act(bob, { t: 'del', id: A })), 'Bob\'s del → "🚫 Not a move in this game"');
    ok(!!(await itemOf(host, A)) && !!(await itemOf(bob, A)), 'and A is still on both screens');
    const up0 = (await itemOf(host, A)).up;
    ok(await toasted(bob, 'Not a move in this game', () => act(bob, { t: 'flip', id: A })), 'Bob\'s flip → "🚫 Not a move in this game"');
    ok((await itemOf(host, A)).up === up0 && (await itemOf(bob, A)).up === up0, 'and A is not turned over');
    ok(await seen(host, 'blocked Bob: Not a move in this game'), 'the refusals are on the record');
    const r1 = await nextRot(A);
    await act(bob, { t: 'rot', id: A, rot: r1 });
    ok(await itemIs(host, A, 'rot', r1) && await itemIs(bob, A, 'rot', r1), `rot (in allow) applies: A turned to ${r1}°`);
    const a0 = await itemOf(host, A);
    await act(bob, { t: 'move', id: A, x: a0.x + 30, y: a0.y + 20 });
    ok(await itemIs(host, A, 'x', a0.x + 30) && await itemIs(bob, A, 'y', a0.y + 20), 'move (in allow) applies');
    await act(bob, { t: 'seat', watch: true });
    ok(await until(host, (p) => window.__ct.view().players[p]?.seat == null, bobPid), 'seat (never refused by strict): Bob stands up to watch');
    await act(bob, { t: 'seat', sit: true });
    ok(await until(host, (p) => window.__ct.view().players[p]?.seat != null, bobPid), 'and sits down again');
    // handle() returning true keeps an action strict would refuse
    await enable("({ name: 'Strict handled', strict: true, handle(t, a) { if (a.t === 'flip') { t.flip(a.id); t.say('handled a flip'); return true; } } })");
    await act(bob, { t: 'flip', id: A });
    ok(await itemIs(host, A, 'up', !up0) && await seen(host, 'handled a flip'), 'under strict, a flip handle() returns true for is applied (by the script)');
    ok(await toasted(bob, 'Not a move in this game', () => act(bob, { t: 'rot', id: A, rot: r1 === 270 ? 0 : r1 + 90 })), 'and a rot it neither handles nor allows is refused');
    ok((await itemOf(host, A)).rot === r1, 'A keeps its angle');
    await disable();
  }

  // 3 ─────────────────────────────────────────────────────────────────────────
  if (run(3)) {
    section('3. atomicity: handle throws after t.move; onAction throws after t.flip');
    const a0 = await itemOf(host, A), b0 = await itemOf(host, B);
    await enable(`({ name: 'Atom handle', handle(t, a) {
      if (a.t === 'rot') { t.move(${J(B)}, ${b0.x + 140}, ${b0.y - 160}); throw new Error('handle broke after t.move'); }
    } })`);
    const r1 = (a0.rot + 90) % 360;
    ok(await toasted(bob, 'rules script error', () => act(bob, { t: 'rot', id: A, rot: r1 })), 'Bob is told "🚫 rules script error"');
    ok(await offAndIdle(host), 'the rules disabled themselves (fail closed)');
    const [a1, b1, b1g] = [await itemOf(host, A), await itemOf(host, B), await itemOf(bob, B)];
    ok(b1.x === b0.x && b1.y === b0.y && b1g.x === b0.x && b1g.y === b0.y, `B has not moved: the t.move before the throw is gone (${b1.x},${b1.y} on the host, ${b1g.x},${b1g.y} for Bob)`);
    ok(a1.rot === a0.rot, `and the rot was not applied (A at ${a1.rot}°)`);
    ok(await seen(host, 'rules disabled — script error in handle()'), 'log: "rules disabled — script error in handle()"');
    ok((await lastErr(host)).includes('handle broke after t.move'), `lastRulesError names it ("${await lastErr(host)}")`);

    await enable(`({ name: 'Atom onAction', onAction(t, a) {
      if (a.t === 'rot') { t.flip(${J(B)}); throw new Error('onAction broke after t.flip'); }
    } })`);
    ok(await toasted(host, 'Rules disabled — error in onAction()', () => act(bob, { t: 'rot', id: A, rot: r1 })), 'the host toasts "Rules disabled — error in onAction(): …"');
    ok(await offAndIdle(host), 'the rules disabled themselves');
    ok(await itemIs(host, A, 'rot', r1) && await itemIs(bob, A, 'rot', r1), `the action's own effect is kept: A turned to ${r1}° on both screens`);
    ok((await itemOf(host, B)).up === b0.up && (await itemOf(bob, B)).up === b0.up, 'the t.flip before the throw is discarded: B is not turned over');
    ok(await seen(host, 'rules disabled — script error in onAction()'), 'log: "rules disabled — script error in onAction()"');
    ok((await lastErr(host)).includes('onAction broke after t.flip'), 'lastRulesError names it');
  }

  // 4 ─────────────────────────────────────────────────────────────────────────
  if (run(4)) {
    section('4. setTimeout in a hook');
    await enable("({ name: 'Timeout', onAction(t, a) { if (a.t === 'rot') setTimeout(() => t.say('too late'), 10); } })");
    await act(host, { t: 'rot', id: A, rot: await nextRot(A) });
    ok(await offAndIdle(host), 'the rules disabled themselves');
    const e = await lastErr(host);
    ok(e.includes(STUB_TEXT('setTimeout')), `lastRulesError: the stub's message ("${e}")`);
    ok(!(await logText(host)).includes('too late'), 'the callback never ran');
  }

  // 5 ─────────────────────────────────────────────────────────────────────────
  if (run(5)) {
    section('5. the async guards');
    // (a) a facade call from a stray continuation
    await enable("({ name: 'Stray say', onAction(t, a) { if (a.t === 'rot') Promise.resolve().then(() => t.say('stray say ran')); } })");
    const rA0 = await nextRot(A), t5 = await mark(host);
    ok(await toasted(host, 'Rules disabled — the script crashed: t.say was called outside a hook', () => act(host, { t: 'rot', id: A, rot: rA0 })),
      'the host toasts "Rules disabled — the script crashed: …" (a Worker crash, spec §3f.5)');
    ok(await offAndIdle(host), 'Promise.resolve().then(() => t.say(…)) disables the rules');
    const e1 = await lastErr(host);
    ok(e1.includes('t.say was called outside a hook — rules hooks must be synchronous'), `lastRulesError: "outside a hook" ("${e1}")`);
    ok(!(await logText(host)).includes('stray say ran'), 'the stray t.say said nothing');
    ok(await loggedSince(host, t5, 'rules disabled — the script crashed: t.say was called outside a hook'), 'the log says "rules disabled — the script crashed: …"');

    // (b) a stray write to t.data, then the next job
    const STRAY = `({ name: 'Stray data', setup(t) { t.data.base = 1; },
      onAction(t, a) {
        if (a.t !== 'rot') return;
        t.say('stray-data script saw rot ' + a.rot);
        if (a.id === ${J(A)}) Promise.resolve().then(() => { t.data.x = 1; });
      } })`;
    await enable(STRAY, { reset: true });
    const ra = (await itemOf(host, A)).rot, rA = (ra + 90) % 360, rB = ((await itemOf(host, B)).rot + 90) % 360;
    const [resA, resB] = await host.evaluate(([A, B, rA, rB]) => Promise.all([
      window.__ct.act({ t: 'rot', id: A, rot: rA }), window.__ct.act({ t: 'rot', id: B, rot: rB })]), [A, B, rA, rB]);
    ok(await offAndIdle(host), 'Promise.resolve().then(() => { t.data.x = 1 }) disables the rules');
    const e2 = await lastErr(host);
    ok(e2.includes('changed t.data outside a hook'), `lastRulesError: "changed t.data outside a hook" ("${e2}")`);
    ok(resA.ok === false && (await itemOf(host, A)).rot === ra, 'the job that let it loose is dropped (fail closed): A keeps its angle');
    ok(resB.ok === true && await itemIs(host, B, 'rot', rB) && !(await logText(host)).includes(`stray-data script saw rot ${rB}`),
      'the next job ran on the free table: the rules were off before it committed');
    // the host's t.data never took the stray write: a re-enable keeping the state starts from it
    await enable("({ name: 'Stray data', setup(t) { t.say('kept data: ' + JSON.stringify(t.data)); } })");
    ok(await seen(host, 'kept data: {"base":1}'), 'a re-enable that keeps the game state shows t.data without x (the host never diverged)');
    await inWorker('the re-enabled script');
    await disable();

    // (c) an async validate that would veto
    await enable("({ name: 'Async validate', async validate(t, a) { if (a.t === 'rot') return 'async says no'; } })");
    const r0 = (await itemOf(host, A)).rot;
    ok(await toasted(bob, 'rules script error', () => act(bob, { t: 'rot', id: A, rot: (r0 + 90) % 360 })), 'Bob is told "🚫 rules script error"');
    ok(await offAndIdle(host), 'an async validate disables the rules');
    await sleep(300);
    ok((await itemOf(host, A)).rot === r0 && (await itemOf(bob, A)).rot === r0, 'and the rot is refused, not applied (fail closed)');
    ok(await seen(host, 'rules disabled — script error in validate()'), 'log: "rules disabled — script error in validate()"');
  }

  // 6 ─────────────────────────────────────────────────────────────────────────
  if (run(6)) {
    section('6. page APIs explain themselves; fetch is gone');
    const CASES = [
      ['document.title (setup)', "setup(t) { t.say('title: ' + document.title); }", `document is not available: ${WORKER_TEXT}`, false],
      ["alert('x') (onAction)", "onAction(t, a) { if (a.t === 'rot') alert('x'); }", `alert is not available: ${WORKER_TEXT}`, true],
      ['localStorage.x (validate)', "validate(t, a) { if (a.t === 'rot') return localStorage.x; }", `localStorage is not available: ${WORKER_TEXT}`, true],
      ['globalThis.setTimeout (onAction)', "onAction(t, a) { if (a.t === 'rot') globalThis.setTimeout(() => {}, 1); }", STUB_TEXT('setTimeout'), true],
      ["window.sessionStorage (onAction)", "onAction(t, a) { if (a.t === 'rot') window.sessionStorage.setItem('k', 'v'); }", `sessionStorage is not available: ${WORKER_TEXT}`, true],
      ["fetch('https://example.com') (onAction)", "onAction(t, a) { if (a.t === 'rot') fetch('https://example.com'); }", 'fetch is not defined', true],
    ];
    for (const [what, hook, msg, byRot] of CASES) {
      await enable(`({ name: 'Page API', ${hook} })`, { reset: true });
      if (byRot) await act(host, { t: 'rot', id: A, rot: await nextRot(A) });
      const off = await offAndIdle(host), e = await lastErr(host);
      ok(off && e.includes(msg), `${what} → the rules disable with "${msg.slice(0, 60)}…" (${e.slice(0, 140)})`);
    }
  }

  // 7 ─────────────────────────────────────────────────────────────────────────
  if (run(7)) {
    section('7. a syntax error on Enable: the dialog shows it, the running rules still work');
    await h.enableRules(host, { code: "({ name: 'Keeper', onAction(t, a) { if (a.t === 'rot') t.say('keeper saw rot ' + a.rot); } })" });
    ok(await rulesOn(host) && !(await host.$('#rules-dialog[open]')), '«Keeper» enabled through the 📜 dialog, which closed');
    await host.click('#rules-btn');
    await host.waitForSelector('#rules-dialog[open]');
    await host.fill('#rules-code', "({ name: 'Broken', onAction(t, a) { ");
    await clearToast(host);
    const [label, disabled] = await host.evaluate(() => { const b = document.getElementById('rules-enable'); b.click(); return [b.textContent, b.disabled]; });
    ok(label === 'Starting…' && disabled, `Enable says "${label}" (disabled: ${disabled}) while the Worker starts`);
    const shown = await until(host, () => document.getElementById('rules-err').textContent.length > 0, null, 15000);
    const L = await dialogLayout(host);
    ok(shown && L.open && !/did not start/.test(L.text), `the dialog stays open and shows the syntax error ("${L.text}")`);
    ok(L.status === 'active: Keeper', `its status still reads "${L.status}"`);
    ok(await toastHas(host, 'the running rules are unchanged').then(() => true, () => false), 'toast: "Rules error: … — the running rules are unchanged"');
    ok(await host.evaluate(() => { const b = document.getElementById('rules-enable'); return b.textContent === 'Enable' && !b.disabled; }), 'Enable is a button again');
    await host.click('#rules-dialog button[value="cancel"]');
    const r1 = await nextRot(A);
    await act(bob, { t: 'rot', id: A, rot: r1 });
    ok(await seen(host, `keeper saw rot ${r1}`) && await rulesOn(bob), "Bob's next move still runs through «Keeper»");
    await inWorker('«Keeper», after the failed Enable');
    // a job that arrives while the next Worker starts waits for it (§3f.5), not for «Keeper»
    const LATE = "(() => { const end = Date.now() + 3000; while (Date.now() < end); return { name: 'Late', onAction(t, a) { if (a.t === 'rot') t.say('late saw rot ' + a.rot); } }; })()";
    await host.evaluate((code) => { window.__late = window.__ct.act({ t: 'setRules', code, enabled: true }); }, LATE);
    const r2 = await nextRot(A);
    await act(bob, { t: 'rot', id: A, rot: r2 });
    ok(await until(host, () => window.__ct.jobs() >= 2, null, 2500), "Bob's move is queued behind «Late»'s starting Worker");
    ok((await host.evaluate(() => window.__late)).ok, '«Late» enabled');
    ok(await seen(host, `late saw rot ${r2}`) && !(await logText(host)).includes(`keeper saw rot ${r2}`), 'and its Worker ran the move, after its setRules: «Keeper» never saw it');
    // Disable: the Worker goes, the host's table switches the rules off
    const s0 = (await perf(host)).workerStops, t7 = await mark(host);
    await disable();
    ok(await offAndIdle(host) && await loggedSince(host, t7, 'rules disabled by Alice', 5000) && (await perf(host)).workerStops === s0 + 1 && await host.evaluate(() => window.__ct.workerDigest()) === null,
      'Disable logs "rules disabled by Alice" and ends the Worker');
  }

  // 8 ─────────────────────────────────────────────────────────────────────────
  if (run(8)) {
    section("8. the 📜 dialog's errors on an iPhone 13 (Phoebe hosts a room of her own)");
    const phone = await env.page('Phoebe', { ctx: h.playwright.devices['iPhone 13'] });
    await phone.goto(env.url);
    await h.joinAs(phone, 'Phoebe');
    await phone.waitForSelector('.item.pile .count');
    fs.mkdirSync(SHOTS, { recursive: true });
    await h.enableRules(phone, { code: "({ name: 'Broken', onAction(t, a) { " });
    readsWell(await dialogLayout(phone), 'phone, a syntax error');
    await phone.screenshot({ path: path.join(SHOTS, 'p3-worker-phone-syntax.png') });
    await phone.click('#rules-dialog button[value="cancel"]');
    await h.enableRules(phone, { code: "({ name: 'Old page script', setup(t) { localStorage.best = 1; } })" });
    const L = await dialogLayout(phone);
    readsWell(L, 'phone, a page-API error');
    ok(L.text.includes(`localStorage is not available: ${WORKER_TEXT}`) && L.err.h >= 2 * L.line - 1, `the whole explanation shows, wrapped over ${Math.round(L.err.h / L.line)} lines`);
    ok(L.status === 'inactive', `the status reads "${L.status}"`);
    await phone.screenshot({ path: path.join(SHOTS, 'p3-worker-phone-pageapi.png') });
    await phone.context().close();
  }

  // 9 ─────────────────────────────────────────────────────────────────────────
  if (run(9)) {
    section("9. after 300 actions the Worker's mirror equals the host's table");
    await enable(`({ name: 'Digest',
      setup(t) { t.data.n = t.data.n || 0; },
      validate(t, a) { if (a.t === 'rot' && a.rot === 270) return 'no quarter turns back'; },
      onAction(t, a) {
        const n = ++t.data.n;
        t.public.n = n;
        if (n % 7 === 0) t.secret[a.p] = { text: 'secret ' + n };
        if (n % 13 === 0) t.ask(a.p, { id: 'q' + (n % 3), prompt: 'Pick one', options: ['a', 'b'] });
        if (n % 5 === 0 && a.id && t.item(a.id)) t.hint(a.p, { items: [a.id] });
        if (n % 9 === 0) t.schedule(0.3, 'tick' + n);
      },
      onTimer(t, tag) { t.data.ticks = (t.data.ticks || 0) + 1; },
    })`, { reset: true });
    const p0 = await perf(host);
    /** Page p acts `n` times at random (seeded), `gap` ms apart, on what its view shows. */
    const play = (p, n, seed, gap) => p.evaluate(async ([n, seed, gap]) => {
      let s = seed;
      const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32), pick = (a) => a[Math.floor(rnd() * a.length)];
      for (let i = 0; i < n; i++) {
        const v = window.__ct.view(), T = v.table, ids = (k) => Object.keys(v.items).filter((id) => v.items[id].k === k);
        const cards = ids('c'), piles = ids('p'), hand = window.__ct.hand(), r = rnd();
        const x = Math.round(T.w / 2 - 300 + rnd() * 500), y = Math.round(T.h / 2 - 250 + rnd() * 400);
        let a = { t: 'rot', id: pick(cards), rot: pick([0, 90, 180, 270]) }; // (A and B are always there)
        if (r < 0.25) a = { t: 'move', id: pick(cards), x, y };
        else if (r < 0.58 && r >= 0.45) a = { t: 'flip', id: pick(cards) };
        else if (r < 0.72 && piles.length) a = { t: 'deal', id: pick(piles), x, y, up: rnd() < 0.5 };
        else if (r < 0.82 && piles.length) a = { t: 'draw', id: pick(piles) };
        else if (r < 0.94 && hand.length) { const k = Math.floor(rnd() * hand.length); a = { t: 'play', idx: k, d: hand[k].d, i: hand[k].i, x, y, up: true }; }
        await window.__ct.act(a);
        if (gap) await new Promise((res) => setTimeout(res, gap));
      }
    }, [n, seed, gap]);
    await Promise.all([play(host, 200, 7, 0), play(bob, 100, 11, 70)]); // (Bob's pace stays under flood control's 20 a second)
    const tb = await host.evaluate(() => window.__ct.view().table), bar = { x: Math.round(tb.w / 2) - 123, y: Math.round(tb.h / 2) + 77 };
    await act(bob, { t: 'move', id: B, ...bar }); // (a barrier: the host takes a peer's actions in order)
    ok(await itemIs(host, B, 'x', bar.x, 20000) && await itemIs(host, B, 'y', bar.y, 1000), "every one of Bob's actions reached the host");
    const [wd, hd] = await digests(host);
    ok(typeof wd === 'number' && wd === hd, `workerDigest() equals the host's digest after 300 actions (${wd} = ${hd})`);
    await sleep(500); // (a test build's own check, every 50 jobs, may still be on its way)
    const p1 = await perf(host), jobs = p1.workerJobs - p0.workerJobs, checks = p1.digestChecks - p0.digestChecks;
    ok(jobs >= 300 && checks >= Math.floor(jobs / 50) && p1.digestMismatches === p0.digestMismatches,
      `the test build compared the digests every 50 jobs: ${checks} checks over ${jobs} jobs, no mismatch`);
    ok(await rulesOn(host) && !(await lastErr(host)), 'and the rules are still on, with no error');
    await disable();
  }

  // 10 ────────────────────────────────────────────────────────────────────────
  if (run(10)) {
    section('10. the infinite loop of B14');
    await enable("({ name: 'Loop', onAction(t, a) { if (a.t !== 'rot') return; if (a.rot === 90) for (;;) {} t.say('loop script saw rot ' + a.rot); } })");
    if ((await itemOf(host, A)).rot === 90) await act(host, { t: 'rot', id: A, rot: 0 });
    const r0 = (await itemOf(host, A)).rot, s0 = (await perf(host)).workerStops;
    await clearToast(host);
    ok(await toasted(bob, 'The rules stopped responding — your action was not applied', () => act(bob, { t: 'rot', id: A, rot: 90 }), 15000),
      'Bob: "🚫 The rules stopped responding — your action was not applied"');
    ok(await seen(host, 'rules disabled — the script took longer than 4 s (stopped)'), 'log: "rules disabled — the script took longer than 4 s (stopped)"');
    ok(await toastHas(host, "Rules stopped — the script didn't answer within 4 seconds").then(() => true, () => false), 'host toast: "Rules stopped — the script didn\'t answer within 4 seconds"');
    ok((await itemOf(host, A)).rot === r0 && (await itemOf(bob, A)).rot === r0, 'the looping action was dropped: A keeps its angle on both screens');
    ok((await perf(host)).workerStops > s0 && await host.evaluate(() => window.__ct.workerDigest()) === null, 'the Worker was terminated');
    await host.click('#rules-btn');
    await host.waitForSelector('#rules-dialog[open]');
    const L = await dialogLayout(host);
    ok(L.text.includes('the script took longer than 4 s (stopped)') && L.status === 'inactive', `the 📜 dialog shows the error ("${L.text}", ${L.status})`);
    await host.click('#rules-dialog button[value="cancel"]');
    await act(bob, { t: 'rot', id: A, rot: 180 });
    ok(await itemIs(host, A, 'rot', 180) && await itemIs(bob, A, 'rot', 180) && !(await logText(host)).includes('loop script saw rot 180'), 'the next action works on the free table');
    ok((await enable("({ name: 'Loop', onAction(t, a) { if (a.t !== 'rot') return; if (a.rot === 90) for (;;) {} t.say('loop script saw rot ' + a.rot); } })")).ok && await rulesOn(host), 're-enabling works');
    await act(bob, { t: 'rot', id: A, rot: 270 });
    ok(await seen(host, 'loop script saw rot 270') && await itemIs(bob, A, 'rot', 270), 'and the new Worker runs the next move');
    await disable();
  }

  // 11 ────────────────────────────────────────────────────────────────────────
  if (run(11)) {
    section('11. the watchdog counts visible time');
    // a 3 s hook, the host page frozen for 6 s in its middle
    await enable("({ name: 'Slow', onAction(t, a) { if (a.t === 'rot') { const end = Date.now() + 3000; while (Date.now() < end); t.say('slow hook done ' + a.rot); } } })");
    const r1 = await nextRot(A), t11 = await mark(host);
    await host.evaluate(([A, r]) => {
      window.__slow = { t0: performance.now() };
      window.__ct.act({ t: 'rot', id: A, rot: r }).then((res) => Object.assign(window.__slow, { res, t1: performance.now() }));
    }, [A, r1]);
    await sleep(1000);
    const how = await freeze(host, 6000);
    console.log(`  (the host page was frozen by ${how === 'cdp' ? 'CDP' : 'emulation: CDP\'s frozen state took no effect on this visible headless page'})`);
    ok(await until(host, () => !!window.__slow.res, null, 15000), 'the frozen action came back');
    const slow = await host.evaluate(() => window.__slow);
    ok(slow.res?.ok === true && slow.t1 - slow.t0 >= 7000, `a 3 s hook with the page frozen 6 s in its middle applies (${Math.round(slow.t1 - slow.t0)} ms of wall time)`);
    ok(await rulesOn(host) && !(await lastErr(host)) && await seen(host, `slow hook done ${r1}`) && await itemIs(bob, A, 'rot', r1), 'the rules stay on, and the action applied (both screens)');
    ok(!(await since(host, t11)).some((l) => l.includes('took longer than 4 s')), 'the watchdog never fired');

    // a 5 s hook with the page hidden for 3 s of it: 2 s of visible time
    await enable("({ name: 'Slower', onAction(t, a) { if (a.t === 'rot') { const end = Date.now() + 5000; while (Date.now() < end); t.say('five-second hook done ' + a.rot); } } })");
    const r2 = await nextRot(A);
    await host.evaluate(([A, r]) => {
      window.__slow = { t0: performance.now() };
      window.__ct.act({ t: 'rot', id: A, rot: r }).then((res) => Object.assign(window.__slow, { res, t1: performance.now() }));
    }, [A, r2]);
    await sleep(1000);
    await setHidden(host, true);
    await sleep(3000);
    await setHidden(host, false);
    ok(await until(host, () => !!window.__slow.res, null, 15000), 'the hidden action came back');
    const slower = await host.evaluate(() => window.__slow);
    ok(slower.res?.ok === true && slower.t1 - slower.t0 >= 5000 && await rulesOn(host) && await seen(host, `five-second hook done ${r2}`),
      `a 5 s hook, hidden for 3 s of it, applies and the rules stay on (${Math.round(slower.t1 - slower.t0)} ms)`);

    // a genuine loop, the page visible
    await enable("({ name: 'Spin', onAction(t, a) { if (a.t === 'rot') for (;;) {} } })");
    await clearToast(host);
    const ms = await host.evaluate(([A, r]) => new Promise((res) => {
      const t0 = performance.now(), el = document.getElementById('toast');
      const mo = new MutationObserver(() => { if (el.textContent.includes('Rules stopped')) { mo.disconnect(); res(performance.now() - t0); } });
      mo.observe(el, { childList: true, characterData: true, subtree: true });
      setTimeout(() => { mo.disconnect(); res(-1); }, 15000);
      window.__ct.act({ t: 'rot', id: A, rot: r });
    }), [A, await nextRot(A)]);
    ok(ms >= 3990 && ms <= 5000, `a genuine loop with the page visible stops in 4 s + 1 s (${Math.round(ms)} ms)`);
    ok(await offAndIdle(host), 'and the rules are off');
  }

  // 12 ────────────────────────────────────────────────────────────────────────
  if (run(12)) {
    section('12. a host reload with the rules on: the Worker re-inits, timers resume, setup does not run again');
    const t12 = await mark(host);
    await enable(`({ name: 'Reloader',
      setup(t) { t.data.setups = (t.data.setups || 0) + 1; t.say('reloader setup #' + t.data.setups); t.schedule(6, 'after-reload'); },
      onTimer(t, tag) { t.say('reloader timer: ' + tag); },
      onAction(t, a) { if (a.t === 'rot') t.say('reloader saw rot ' + a.rot); },
    })`, { reset: true });
    ok(await seen(host, 'reloader setup #1'), 'setup ran once on Enable');
    ok(!(await logText(host)).includes('reloader timer: after-reload'), 'its 6 s timer has not fired yet');
    await host.reload();
    await host.waitForFunction(() => window.__ct?.view().seq > 0 && document.querySelector('.item'), null, { timeout: 30000 });
    ok(await until(host, () => window.__ct.view().rules?.enabled && window.__ct.perf.workerStarts === 1 && window.__ct.perf.lastRulesInitMs > 0, null, 15000),
      'the reloaded host started one Worker for the saved rules');
    ok(await seen(host, 'reloader timer: after-reload', 20000), 'the timer fired after the reload (onTimer in the new Worker)');
    ok(await seen(bob, 'reloader timer: after-reload'), "and Bob's log shows it");
    const lt = await since(host, t12), n = (txt) => lt.filter((l) => l.includes(txt)).length;
    ok(n('reloader setup #') === 1 && n('«Reloader» enabled') === 1, `no setup re-run is logged (${n('reloader setup #')} setup line)`);
    ok(n('resumed the table') === 1, 'the log says the table was resumed');
    const r1 = await nextRot(A);
    await act(bob, { t: 'rot', id: A, rot: r1 });
    ok(await seen(host, `reloader saw rot ${r1}`) && await itemIs(bob, A, 'rot', r1), "Bob's next move runs through the resumed script");
    await inWorker('the resumed script');
    await disable();
  }

  // 13 ────────────────────────────────────────────────────────────────────────
  if (run(13)) {
    section('13. module skew: a rules-worker.js of another MODULE_V');
    if (await rulesOn(host)) await disable();
    const src = fs.readFileSync(path.join(h.APP_ROOT, 'cardtable/rules-worker.js'), 'utf8');
    const skewed = src.replace(/export const MODULE_V = \d+;/, `export const MODULE_V = ${h.MODULE_V + 98};`);
    ok(skewed !== src, `the routed copy exports MODULE_V = ${h.MODULE_V + 98}`);
    let hits = 0;
    const WORKER_URL = /\/cardtable\/rules-worker\.js(\?|$)/;
    await host.context().route(WORKER_URL, (r) => { hits++; return r.fulfill({ contentType: 'text/javascript', body: skewed }); });
    await clearToast(host);
    await h.enableRules(host, { code: "({ name: 'Skewed', onAction(t, a) { t.say('skewed script ran'); } })" });
    ok(hits >= 1, `the Worker loaded the routed copy (${hits} request)`);
    ok(await toastHas(host, 'Card Table was updated — reload this page to run rules').then(() => true, () => false), 'Enable fails with the toast "Card Table was updated — reload this page to run rules"');
    const L = await dialogLayout(host);
    ok(L.open && L.text.includes('version mismatch') && !(await rulesOn(host)), `the dialog says why ("${L.text}"), the rules stay off`);
    await host.click('#rules-dialog button[value="cancel"]');
    const r1 = await nextRot(A);
    await act(bob, { t: 'rot', id: A, rot: r1 });
    ok(await itemIs(host, A, 'rot', r1) && await itemIs(bob, A, 'rot', r1) && !(await logText(host)).includes('skewed script ran'), 'the table works without rules');
    await host.context().unroute(WORKER_URL);
    ok((await enable("({ name: 'Unskewed' })")).ok && await rulesOn(host), 'with the right rules-worker.js, Enable works again');
    // a host reload whose saved rules meet the skewed Worker: they go off, loudly (§3f.8 step 5)
    await host.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { // (every toast from the first one)
      const el = document.getElementById('toast');
      window.__toastLog = [];
      new MutationObserver(() => window.__toastLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    }));
    await host.context().route(WORKER_URL, (r) => { hits++; return r.fulfill({ contentType: 'text/javascript', body: skewed }); });
    await host.reload();
    ok(await until(host, () => window.__ct?.view().seq > 0 && window.__ct.jobs() === 0 && window.__ct.perf.workerStarts === 1, null, 20000), 'the reloaded host tried to start the saved rules');
    ok(await host.evaluate(() => window.__toastLog.includes('Card Table was updated — reload this page to run rules')), 'toast: "Card Table was updated — reload this page to run rules"');
    ok(await until(host, () => window.__ct.view().rules?.enabled === false, null, 10000) && await seen(host, 'rules disabled — the saved script failed to load: version mismatch'),
      'the saved rules are off: "rules disabled — the saved script failed to load: version mismatch …"');
    await host.context().unroute(WORKER_URL);
  }

  // 14 ────────────────────────────────────────────────────────────────────────
  if (run(14)) {
    section('14. demotion: a second tab of the host takes the room over');
    // Each select runs a 2.5 s onSelect that changes nothing: the first tab's
    // queue is busy for 30 s while its table (and its save) stays as it is,
    // so the second tab resumes that save one step fresher and wins.
    await enable("({ name: 'Busy', onSelect(t, p, id) { const end = Date.now() + 2500; while (Date.now() < end); } })", { reset: true });
    let saves = -1;
    for (let k = 0; k < 40; k++) { // (until no save lands for 1.5 s)
      const s = (await perf(host)).saves;
      if (s === saves) break;
      saves = s;
      await sleep(1500);
    }
    const before = await host.evaluate(() => ({ seq: window.__ct.view().seq, stops: window.__ct.perf.workerStops, saves: window.__ct.perf.saves }));
    await host.evaluate((A) => {
      window.__dem = [];
      for (let i = 0; i < 12; i++) window.__ct.act({ t: 'select', id: A }).then((r) => window.__dem.push(r));
    }, A);
    ok(await until(host, () => window.__ct.jobs() === 12, null, 5000), 'the first tab has 12 jobs queued or in flight');
    await host.evaluate(() => { // (every toast it shows: the demotion's may be replaced at once)
      const el = document.getElementById('toast');
      window.__toasts = [];
      new MutationObserver(() => window.__toasts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const tab2 = await host.context().newPage();
    await tab2.goto(invite);
    ok(await until(host, () => window.__dem.length === 12, null, 30000), 'every one of its jobs resolved');
    const toasts = await host.evaluate(() => window.__toasts);
    ok(toasts.includes('This table is open in another tab — this one is now a viewer'), `the first tab demoted itself ("${toasts.join('" / "').slice(0, 300)}")`);
    const dem = await host.evaluate(() => window.__dem);
    ok(dem.length === 12 && dem.every((r) => r.ok === false && r.error === 'this tab is no longer the host'), `each with { error: 'this tab is no longer the host' } (${J(dem[0])})`);
    const after = await perf(host);
    ok(after.workerStops > before.stops && await host.evaluate(() => window.__ct.workerDigest()) === null, `its Worker was terminated (workerStops ${before.stops} → ${after.workerStops})`);
    ok(await until(tab2, () => window.__ct?.view().rules?.enabled && window.__ct.jobs() === 0, null, 15000), "the new tab hosts, its own Worker running the saved rules");
    const r1 = await nextRot(A);
    ok((await act(tab2, { t: 'rot', id: A, rot: r1 })).ok && await itemIs(host, A, 'rot', r1), 'a move on the new host reaches the old tab, now a viewer');
    const seq2 = await tab2.evaluate(() => window.__ct.view().seq);
    let rec = null;
    for (const end = Date.now() + 10000; Date.now() < end && !(rec?.state?.seq >= seq2); await sleep(250)) rec = await h.idb(tab2, 'saves', room);
    ok(rec?.state?.seq >= seq2, `the new host saved it (seq ${rec?.state?.seq})`);
    await sleep(2500);
    ok((await perf(host)).saves === after.saves, `the demoted tab writes no further saves (${after.saves} before and after)`);
    rec = await h.idb(tab2, 'saves', room);
    ok(rec?.state?.seq >= seq2, `the save is still the new host's (seq ${rec?.state?.seq} ≥ ${seq2})`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('the one-writer rule and the digest checks held throughout');
  const broke = hostErrors.filter((t) => /one-writer rule broken|differ \(digest/.test(t));
  ok(!broke.length, `no "one-writer rule broken" and no digest mismatch on the host's console (${broke.length}${broke.length ? ': ' + broke[0].slice(0, 160) : ''})`);
  await env.done();
})().catch(h.crash);
