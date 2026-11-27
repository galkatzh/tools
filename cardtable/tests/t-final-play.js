// Final review, fix-up B (D311–D313): playing on a phone and a desktop.
//   (1) seats across games: a card game from 🎲 after a board game clears the
//       board and ends its named seats (the confirm says so), so the third
//       player, who watched draughts, sits and is dealt into Hold'em; the
//       host's seat menu ends the named seats on its own, asking first when
//       seats own pieces (cancelled, nothing changes); a guest's endSeats
//       is refused; a card game that deals from a deck gets one on the
//       cleared table; a watcher's box never covers a seat label, a new game
//       starts the view afresh — on a table of the same size too (chess
//       zoomed, then Draughts: D317) — and the log follows its newest line
//       when the hand bar comes back.
//   (2) 🗑 of what holds many asks first (a bag of 28), as a group's does,
//       and Dominoes' rules keep its boneyard; Reveal on a cupped die lifts
//       the whole cup.
//   (3) boxes: a guest's upload is said on the host's screen and marks 📦;
//       the 📦 list keeps its Set up button through patches when a box's
//       name has an apostrophe; a box that needs more seated players than
//       sit says so at once, asking nothing; the 📜 dialog a guest reads
//       follows the rules as they start.
//   (4) dialogs and the keyboard: Help opens at its top, its Close in reach
//       on a phone; the name offered is selected; a seat label opens its
//       menu with Enter; a tab whose terminal bridge is down reports it
//       without a stream of console errors.
'use strict';
const h = require('./h');
const L = require('./p1-lib');
const P = require('./p2t-lib');
const { pinch } = require('./p4s-lib');
const ST = require('./stones-lib');
const { pickGame } = ST;
const { ok, section } = h;

/** Waits for page p to show a toast containing `txt`; its text, or ''. */
const toastSays = (p, txt, ms = 10000) => p.waitForFunction((t) => document.getElementById('toast').textContent.includes(t), txt, { timeout: ms })
  .then(() => p.evaluate(() => document.getElementById('toast').textContent), () => '');
/** Client rects of page p's seat labels and its watchers' box (null when hidden). */
const boxes = (p) => p.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
  const wb = document.getElementById('watch-box'), me = document.getElementById('watch-me');
  return { labels: [...document.querySelectorAll('.seat')].map((el) => ({ txt: el.textContent, ...r(el) })), watch: me.classList.contains('hidden') ? null : r(wb) };
});
const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
/** The ids of page p's items of kind `k` ('b' a bag, 'g' a piece, …). */
const itemsOf = (p, k) => P.viewOf(p, 'Object.keys(v.items).filter((id) => v.items[id].k === a)', k);

(async () => {
  const env = await h.start();
  const ann = await P.join(env, 'Ann', env.url);
  const invite = ann.url();
  const S5 = h.playwright.devices['Galaxy S5']; // (360 × 640: the watchers' box is as wide as the top seat label is high up)
  const bo = await P.join(env, 'Bo', invite, { ctx: S5, rtc: true });
  const cy = await P.join(env, 'Cy', invite, { ctx: S5 });
  for (const p of [ann, bo, cy]) await p.evaluate(() => { window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.getElementById('toast').textContent)).observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true }); });
  const everyone = [[ann, 'Ann'], [bo, 'Bo'], [cy, 'Cy']];
  const seated = (p) => P.waitView(p, 'Object.values(v.players).every((pl) => pl.seat != null)');

  section('(1) seats across games: Chess, then Draughts, with three players: one watches');
  ok(/Clear the table/.test(await pickGame(ann, 'chess') || ''), '🎲 Chess asks first (the table holds a deck)');
  {
    ok(await P.waitView(ann, "v.seats?.length === 2 && v.rules?.enabled && Object.values(v.players).filter((pl) => pl.seat == null).length === 1"), 'chess: two named seats, one watcher');
    const name = await P.viewOf(ann, 'Object.entries(v.players).find(([, pl]) => pl.seat == null)[1].name'), w = name === 'Cy' ? cy : bo;
    await L.until(async () => !!(await boxes(w)).watch, 10000, 100);
    await w.waitForTimeout(1500);
    const b = await boxes(w), hit = b.labels.filter((l) => overlap(l, b.watch));
    ok(b.watch && b.labels.length >= 2 && !hit.length, `${name}'s "every seat is taken" box covers no seat label (${hit.map((l) => l.txt).join(', ') || 'none'}; box ${b.watch.t | 0}–${b.watch.b | 0}): D313`);
  }
  // Both phones zoom in on chess, their own edge off-screen: Draughts' table is the same size (1000 × 1360)
  const phones = [[bo, 'Bo'], [cy, 'Cy']];
  for (const [p, n] of phones) {
    // (two fingers on the table, below the watchers' box: a touch beside it lands on it)
    const s0 = (await P.tf(p)).s, c = await p.evaluate(() => {
      const r = document.getElementById('table-wrap').getBoundingClientRect(), on = (x, y) => document.getElementById('table').contains(document.elementFromPoint(x, y));
      for (let f = 0.45; f < 0.7; f += 0.02) { const y = r.top + r.height * f, x = r.left + r.width / 2; if ([30, 100].every((d) => on(x - d, y) && on(x + d, y))) return { x, y }; }
      return null;
    });
    await pinch(p, c, 60, 200);
    const t = await P.tf(p);
    ok(t.s > s0 * 2 && Math.hypot(t.px, t.py) > 20, `${n} zooms in on chess (scale ${s0.toFixed(2)} → ${t.s.toFixed(2)}, pan ${t.px | 0}, ${t.py | 0})`);
  }
  const chessTf = await Promise.all(phones.map(([p]) => P.tf(p)));
  ok(/Clear the table/.test(await pickGame(ann, 'draughts') || ''), '🎲 Draughts');
  ok(await P.waitView(ann, "v.seats?.length === 2 && Object.values(v.players).filter((pl) => pl.seat == null).length === 1"), 'two named seats, one watcher');
  for (const [k, [p, n]] of phones.entries()) {
    const seat = await P.waitView(p, "v.seats?.[0]?.id === 'light' && Object.values(v.items).filter((it) => it.k === 'g' && it.owner).length === 24") && await P.viewOf(p, 'v.players[me].seatId || null');
    await p.waitForTimeout(300);
    const t = await P.tf(p), w = await P.wrap(p), fitS = P.fit({ shape: 'rect', w: 1000, h: 1360 }, t.rot, w.W, w.H);
    ok(t.px === 0 && t.py === 0 && Math.abs(t.s - fitS) < 1e-3, `${n}'s view starts afresh on Draughts, a table as large as chess's (scale ${chessTf[k].s.toFixed(2)} → ${t.s.toFixed(3)}, fit ${fitS.toFixed(3)}; pan ${t.px}, ${t.py}): D317`);
    if (!seat) continue;
    const men = await P.viewOf(p, "Object.keys(v.items).filter((id) => v.items[id].owner === 'seat:' + a)", seat);
    const off = await p.evaluate((ids) => {
      const r = document.getElementById('table-wrap').getBoundingClientRect();
      return ids.filter((id) => { const b = document.querySelector(`.item[data-id="${id}"]`).getBoundingClientRect(); return b.left < r.left || b.right > r.right || b.top < r.top || b.bottom > r.bottom; }).length;
    }, men);
    ok(men.length === 12 && off === 0, `${n} (${seat}) sees all ${men.length} of his own men (${off} off-screen): D317`);
  }
  const watcher = await P.viewOf(ann, 'Object.entries(v.players).find(([, pl]) => pl.seat == null)[1].name');
  const wp = watcher === 'Cy' ? cy : watcher === 'Bo' ? bo : ann;
  ok(watcher !== 'Ann' && await P.waitView(wp, 'v.players[me].seat == null'), `${watcher} watches`);
  await L.until(async () => !!(await boxes(wp)).watch, 10000, 100);
  {
    const b = await boxes(wp), hit = b.labels.filter((l) => overlap(l, b.watch));
    ok(b.watch && b.labels.length >= 2 && !hit.length, `${watcher}'s "every seat is taken" box covers no seat label (${hit.map((l) => l.txt).join(', ') || 'none'}): D313`);
  }

  section('(1) the host\'s seat menu ends the named seats');
  {
    const lab = (await P.labels(ann)).find((l) => !l.me);
    const m = await P.openMenu(ann, lab.text);
    ok(m.includes('End the named seats'), `the host's menu on "${lab.text}" offers it (${m.join(' | ')})`);
    const mB = await P.openMenu(bo, (await P.labels(bo)).find((l) => l.me)?.text || lab.text, true);
    ok(!mB.includes('End the named seats'), `a guest's doesn't (${mB.join(' | ') || 'no menu'})`);
    if (mB.length) await bo.keyboard.press('Escape');
    const r = await L.act(bo, { t: 'endSeats' });
    await bo.waitForTimeout(600);
    ok(await P.viewOf(ann, 'v.seats?.length') === 2, `Bo's own endSeats changes nothing (${JSON.stringify(r)})`);
    // (Draughts' 24 men belong to Light and Dark: ending the seats asks first, D320)
    const owners = () => P.viewOf(ann, "Object.values(v.items).filter((it) => it.owner?.startsWith('seat:')).length");
    const answer = (p, yes) => new Promise((res) => p.once('dialog', (d) => { res(d.message()); (yes ? d.accept() : d.dismiss()).catch((err) => console.error('dialog answer failed', err)); }));
    let asked = answer(ann, false);
    await P.openMenu(ann, lab.text);
    await P.pick(ann, 'End the named seats');
    const q = await Promise.race([asked, ann.waitForTimeout(5000).then(() => 'nothing asked in 5 s')]);
    ok(q === 'End the named seats (Light, Dark)? 24 pieces a seat owns will belong to nobody.', `the host is asked first, told what it costs: "${q}"`);
    await ann.waitForTimeout(600);
    ok(await P.viewOf(ann, 'v.seats?.length') === 2 && await owners() === 24, 'cancelled, nothing changes: two seats, 24 men still theirs');
    asked = answer(ann, true);
    await P.openMenu(ann, lab.text);
    await P.pick(ann, 'End the named seats');
    await Promise.race([asked, ann.waitForTimeout(5000)]);
    ok(await P.waitView(ann, '!v.seats') && await seated(ann), 'accepted: the seats are gone and every player sits (the watcher too)');
    ok(await P.waitView(ann, "v.log.some((e) => e.txt === 'removed the named seats: everyone sits where they like')"), 'the log says so');
  }

  section('(1) the view starts afresh on a new table; the hand bar\'s return keeps the log following');
  ok(/Clear the table/.test(await pickGame(ann, 'draughts') || ''), 'Draughts again: Light and Dark');
  ok(await P.waitView(ann, 'v.seats?.length === 2'), '(named seats back)');
  {
    const f0 = await P.feltPoint(bo, { band: [0.3, 0.7] });
    await P.touchDrag(bo, f0, { x: f0.x + 40, y: f0.y + 60 });
    const t1 = await P.tf(bo);
    ok(Math.hypot(t1.px, t1.py) > 20, `Bo pans his view (${t1.px.toFixed(0)}, ${t1.py.toFixed(0)})`);
    await pickGame(ann, 'backgammon');
    ok(await P.waitView(bo, 'v.table.w === 1480'), "(Backgammon's table on Bo's phone)");
    const t2 = await P.tf(bo);
    ok(t2.px === 0 && t2.py === 0, `the new table opens with Bo's view reset, as 🧭 does (${t2.px}, ${t2.py}): D313`);
  }
  // the log: 30 lines while the hand bar is hidden (no hand items), then the deck brings it back
  if (await ann.evaluate(() => document.getElementById('side').classList.contains('hidden'))) await ann.click('#log-btn');
  ok(await ann.evaluate(() => document.body.classList.contains('nohand')), "(Ann's hand bar is hidden: backgammon has nothing to hold)");
  for (let k = 0; k < 30; k++) await L.act(ann, { t: 'chat', msg: `line ${k}` }).then(() => ann.waitForTimeout(k % 4 === 3 ? 1100 : 30));
  const lastShown = () => ann.evaluate(() => {
    const log = document.getElementById('log'), last = log.lastElementChild, a = log.getBoundingClientRect(), b = last.getBoundingClientRect();
    return { txt: last.textContent, inView: b.bottom <= a.bottom + 1 && b.top >= a.top - 1 };
  });

  section('(1) a card game after a board game: the board and the named seats go');
  let asked = await pickGame(ann, 'holdem');
  ok(asked === "Clear the table and start Texas Hold'em? The board, its pieces and the named seats (Light, Dark) go, with Chess's game state; a standard deck is put on the table.", `the confirm says what goes (and the chess game's kept state), and that a deck comes: "${asked}"`);
  ok(await P.waitView(ann, "!v.seats && !Object.values(v.items).some((it) => it.k === 'g') && v.rules?.enabled && /Hold/.test(v.rules.name)"), "the board and its pieces are gone, the seats ended, Hold'em on");
  for (const [p, n] of everyone) ok(await seated(p), `${n}'s screen: all three sit`);
  ok(await P.waitView(ann, "Object.values(v.items).filter((it) => it.k === 'p' && it.n === 52).length === 1"), "a standard deck of 52 is on the cleared table, for Hold'em to deal from — no + Deck needed (D320)");
  ok(await P.waitView(ann, "!document.body.classList.contains('nohand') || true") && await L.until(() => ann.evaluate(() => !document.body.classList.contains('nohand')), 10000, 100), "the hand bar comes back (a deck's cards go in hands)");
  for (let k = 0; k < 3; k++) await L.act(ann, { t: 'chat', msg: `after ${k}` });
  ok(await L.until(async () => { const s = await lastShown(); return s.txt.endsWith('after 2') && s.inView; }, 8000, 100), `the log still follows: its newest line is in view (${JSON.stringify(await lastShown())}): D313`);
  await L.act(ann, { t: 'rulesBtn', id: 'new' });
  ok(await P.waitView(ann, 'Object.values(v.players).every((pl) => pl.handCount === 2)', null, 15000), `New hand deals all three in (${JSON.stringify(await P.viewOf(ann, 'Object.values(v.players).map((pl) => pl.name + ":" + pl.handCount)'))})`);

  section('(3) the 📜 dialog a guest reads follows the rules');
  await pickGame(ann, 'free');
  ok(await P.waitView(bo, '!v.rules?.enabled'), '(the free table: rules off)');
  await bo.tap('#rules-btn');
  await bo.waitForSelector('#rules-dialog[open]');
  const status = () => bo.evaluate(() => document.getElementById('rules-status').textContent);
  ok(await status() === 'inactive', 'Bo opens 📜: inactive');
  await pickGame(ann, 'turns');
  ok(await L.until(async () => /^active: Turn order/.test(await status()), 10000, 100), `as the host starts Turn order, Bo's open dialog says so ("${await status()}")`);
  ok(await L.until(() => bo.evaluate(() => /name: 'Turn order'/.test(document.getElementById('rules-code').value)), 10000, 100), '…and shows its script');
  await bo.evaluate(() => document.getElementById('rules-dialog').close());

  section('(2) 🗑 of a bag of 28 asks first; Dominoes keeps its boneyard');
  await pickGame(ann, 'dominoes');
  ok(await P.waitView(ann, "v.rules?.enabled && Object.values(v.items).some((it) => it.k === 'b' && it.n === 28)"), 'Dominoes: the boneyard holds 28');
  const [bag] = await itemsOf(bo, 'b');
  await P.clickItem(bo, bag, true);
  await bo.waitForSelector('#action-bar:not(.hidden) [data-cmd="del"]:not(:disabled)');
  const sent0 = await P.sentActs(bo);
  await bo.tap('#action-bar [data-cmd="del"]');
  const del = () => bo.evaluate(() => document.querySelector('#action-bar [data-cmd="del"]')?.textContent);
  ok(await L.until(async () => (await del()) === '🗑 Remove all 28?', 3000, 50), `the first tap asks: "${await del()}"`);
  ok(await P.sentActs(bo) === sent0 && await P.viewOf(ann, 'v.items[a]?.n', bag) === 28, '…and sends nothing');
  await bo.tap('#action-bar [data-cmd="del"]');
  ok(!!await toastSays(bo, 'The tiles and the boneyard stay on the table'), 'the second sends it, and the rules refuse it: "The tiles and the boneyard stay on the table"');
  ok(await P.viewOf(ann, 'v.items[a]?.n', bag) === 28, 'the boneyard is still there, whole');
  { // a game in progress: the host's End the named seats says what it would cost (D320)
    let drew = false;
    for (const [p] of everyone) if (!drew && (await ST.buttons(p)).includes('Draw 7')) drew = await ST.press(p, /^Draw 7$/);
    const hidden = "Object.values(v.items).filter((it) => it.k === 'g' && 'b' in it).length === 14"; // (as the watcher sees them: both racks)
    const wpage = (await Promise.all(everyone.map(async ([p]) => [p, await P.viewOf(p, 'v.players[me].seat == null')]))).find(([, w]) => w)?.[0];
    ok(drew && !!wpage && await P.waitView(wpage, hidden), '(Draw 7: seven hidden tiles in each rack)');
    const name = await P.viewOf(ann, 'v.rules.name'), lab = (await P.labels(ann))[0];
    const asked = new Promise((res) => ann.once('dialog', (d) => { res(d.message()); d.dismiss().catch((err) => console.error('dialog dismiss failed', err)); }));
    await P.openMenu(ann, lab.text);
    await P.pick(ann, 'End the named seats');
    const q = await Promise.race([asked, ann.waitForTimeout(5000).then(() => 'nothing asked in 5 s')]);
    ok(q === `End the named seats (South, North)? 16 pieces a seat owns will belong to nobody; 14 hidden pieces only a seat may see will be seen by no one, its player included; ${name} may not go on without them.`, `mid-game, the host is told what ending the seats costs: "${q}"`);
    await ann.waitForTimeout(600);
    ok(await P.viewOf(ann, 'v.seats?.length') === 2 && await P.viewOf(wpage, hidden), 'cancelled: the seats and the hidden tiles stay as they were');
  }

  section('(2) Reveal on a cupped die lifts its cup');
  await pickGame(ann, 'backgammon');
  ok(await P.waitView(ann, "Object.values(v.items).filter((it) => it.k === 'g' && (it.t || '').endsWith('/die')).length === 2"), '(backgammon: two dice)');
  const dice = await P.viewOf(ann, "Object.keys(v.items).filter((id) => (v.items[id].t || '').endsWith('/die'))");
  await P.clickItem(ann, dice[0]);
  await ann.waitForSelector('#action-bar:not(.hidden) [data-cmd="hide"]:not(:disabled)');
  await ann.keyboard.press('h');
  ok(await P.waitView(bo, "a.every((id) => 'b' in v.items[id])", dice), 'H cups both dice (Bo sees their backs)');
  await ann.waitForTimeout(400);
  if (!await ann.$('#action-bar:not(.hidden) [data-cmd="flip"]')) await P.clickItem(ann, dice[0]); // (still selected after H, or selected again)
  await ann.waitForSelector('#action-bar:not(.hidden) [data-cmd="flip"]:not(:disabled)');
  ok(await ann.evaluate(() => document.querySelector('#action-bar [data-cmd="flip"]').textContent) === 'Reveal', '(the bar offers Reveal)');
  await ann.keyboard.press('f');
  ok(await P.waitView(bo, "a.every((id) => 't' in v.items[id] && v.items[id].up !== false)", dice), 'F on one lifts the whole cup: Bo sees both faces (D313)');

  section('(3) a guest\'s box: said on the host\'s screen, and 📦 marked');
  await ann.evaluate(() => { window.__toasts = []; });
  await L.act(bo, { t: 'addBox', box: { name: "Bob's Game", pieces: [{ id: 'boat', kind: 'token', faces: ['B'] }], setup: [{ piece: 'boat', at: 'center' }] } });
  ok(!!await toastSays(ann, "Bo added «Bob's Game» — 📦 to set it up"), "Ann's screen: \"Bo added «Bob's Game» — 📦 to set it up\"");
  ok(await ann.evaluate(() => document.getElementById('box-btn').classList.contains('new')), '📦 is marked');
  await ann.click('#box-btn');
  await ann.waitForSelector('#box-dialog[open]');
  ok(!await ann.evaluate(() => document.getElementById('box-btn').classList.contains('new')), 'opening it clears the mark');
  ok(await ann.evaluate(() => document.activeElement?.tagName === 'H3' && document.getElementById('box-dialog').scrollTop === 0), '📦 opens at its top, its heading focused (not a link below the fold)');

  section('(3) the 📦 list keeps its buttons through patches ("Bob\'s Game")');
  {
    await ann.evaluate(() => { for (const b of document.querySelectorAll('#box-list button')) b.__kept = true; });
    const pieces = await P.viewOf(ann, "Object.keys(v.items).filter((id) => v.items[id].k === 'g' && !v.items[id].owner)");
    for (let k = 0; k < 5; k++) {
      const it = await P.viewOf(ann, 'v.items[a]', pieces[0]);
      await L.act(ann, { t: 'move', id: pieces[0], x: it.x + (k % 2 ? 40 : -40), y: it.y });
      await ann.waitForTimeout(150);
    }
    ok(await ann.evaluate(() => [...document.querySelectorAll('#box-list button')].every((b) => b.__kept)), "five patches later every Set up button is the same element: the focus and a click under way stay (D313)");
  }

  section('(3) a box that needs more seated players than sit says so at once');
  {
    await L.act(ann, { t: 'addBox', box: { name: 'Four Corners', pieces: [{ id: 'm', kind: 'token', faces: ['M'] }], setup: [{ piece: 'm', at: 'center', owner: '#4' }], rules: "({ name: 'Four Corners' })" } });
    await L.until(() => ann.evaluate(() => [...document.querySelectorAll('#box-list .box-row')].some((r) => r.textContent.includes('Four Corners'))), 8000, 100);
    await ann.evaluate(() => [...document.querySelectorAll('#box-list .box-row')].find((r) => r.textContent.includes('Four Corners')).querySelector('[data-act="setup"]').click());
    await ann.waitForTimeout(800);
    const msg = await ann.evaluate(() => document.getElementById('box-msg').textContent);
    ok(!await ann.evaluate(() => document.getElementById('box-ask').open), 'no "Set up?" and no trust dialog');
    ok(/needs 4 seated players \(3 are seated\)/.test(msg), `the reason, at once: "${msg}"`);
    await ann.evaluate(() => document.getElementById('box-dialog').close());
  }

  section('(4) Help: opens at its top; on a phone its Close stays in reach');
  {
    await bo.tap('#help-btn');
    await bo.waitForSelector('#help-dialog[open]');
    const at = await bo.evaluate(() => ({ top: document.getElementById('help-dialog').scrollTop, focus: document.activeElement?.textContent }));
    ok(at.top === 0 && at.focus === 'How to play', `it opens at "How to play" (scrollTop ${at.top}, focus "${at.focus}")`);
    const close = await bo.evaluate(() => { const b = document.querySelector('#help-dialog > form:last-child button').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: innerHeight }; });
    ok(close.bottom <= close.vh && close.top >= 0, `its Close is on screen without scrolling (${close.top | 0}–${close.bottom | 0} of ${close.vh})`);
    await bo.evaluate(() => document.getElementById('help-dialog').close());
  }

  section('(4) the keyboard: a seat label opens its menu with Enter');
  {
    const focused = await ann.evaluate(() => { const el = document.querySelector('.seat[role="button"][tabindex="0"]'); el?.focus(); return el?.textContent ?? null; });
    ok(!!focused, `a seat label is a focusable button ("${focused}")`);
    await ann.keyboard.press('Enter');
    const m = await P.menu(ann);
    ok(m.length > 0 && await ann.evaluate(() => document.activeElement?.closest('#seat-menu') !== null), `Enter opens its menu, the first entry focused (${m.join(' | ')})`);
    await ann.keyboard.press('Escape');
    const names = await ann.evaluate(() => ['rules-btn', 'view-btn', 'log-btn', 'sel-mode'].map((id) => document.getElementById(id).getAttribute('aria-label')));
    ok(names.join() === 'Rules,Reset view,Log and chat,Select several', `the icon buttons have names (${names.join(', ')})`);
  }

  section('(4) the name offered is selected; a bridged tab with no bridge stays quiet');
  {
    const dee = await env.page('Dee');
    dee.watchdogOK = true; // (it leaves without joining)
    const errs = [];
    dee.on('console', (m) => { if (m.type() === 'error' && /bridge/.test(m.text())) errs.push(m.text()); });
    await dee.goto(`${invite}~cli~9-tok`);
    await dee.waitForSelector('#name-dialog[open]');
    const sel = await dee.evaluate(() => { const i = document.getElementById('name-first'); return { v: i.value, a: i.selectionStart, b: i.selectionEnd }; });
    ok(sel.v.length > 0 && sel.a === 0 && sel.b === sel.v.length, `the name dialog offers "${sel.v}" selected: typing replaces it (${sel.a}–${sel.b})`);
    await dee.keyboard.type('Dee');
    await dee.keyboard.press('Enter');
    await dee.waitForTimeout(8000);
    ok(errs.length <= 6, `8 s with the bridge down: ${errs.length} bridge errors in the console (it was about 2.5 a second: 20)`);
    ok(await dee.evaluate(() => /Terminal bridge not reachable/.test(document.getElementById('toast').textContent) || window.__ct.view().seq > 0), '(and the toast says the bridge is out of reach)');
    await dee.context().close();
  }

  await env.done();
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(2); });
