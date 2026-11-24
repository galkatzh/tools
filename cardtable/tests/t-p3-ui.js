// Phase 3C, the rules' own parts on the screen (spec §3g; §3l t-p3-space items
// 3, 4 and 6, the UI's half): Alice hosts on a desktop (1280 × 800), Bob plays
// on an iPhone 13 held upright, Carol watches on one in landscape. A "UI
// probe" script (strict, with `allow`: so the 📜 button says strict) builds a
// board with four stones; its onSelect hints a stone's neighbours, its
// onAnswer records every answer in t.public.ans, and a host press of "run"
// carries code its onAction runs in the Worker (t-engine's Probe), which
// makes the asks and secrets. Checked on the screens, with real taps and
// clicks: Enable's "Starting…"; the strict title; a tap's `select` and the
// hint layer (only the selecting player's; discs, rings round a piece, on
// the right spots, numbers only), a drag's `select`; every ask form through
// the panel (options, "1 of N", ▾ and the chip, an item and a space picked
// on the table — what isn't offered says so — hand cards with "Confirm
// (k/n)", the number stepper with its validation), the host refusing an
// unoffered answer, the panel's place on every screen (above the hand bar,
// inside the viewport, finger-sized buttons, clear of the seat labels, the
// turn cue, the watchers and the pieces asked about; a centred card on the
// desktop); a host reload mid-ask; the 🔒 For you card; the asks gone while
// the rules are off, the secret kept; an error the open 📜 dialog shows as
// it happens. Screenshots: shots/p3-ui-*.png.
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const S = require('./p3-lib');
const { shot } = require('./fun-lib');
const { until } = require('./p1-lib');

const { devices } = h.playwright;
const J = JSON.stringify;
/** The probe. Its top level takes 600 ms (so Enable's "Starting…" can be seen). */
const PROBE = `(() => { const end = Date.now() + 600; while (Date.now() < end); return { name: 'UI probe', strict: true,
  allow: ['move', 'flip', 'rot', 'draw', 'deal', 'play', 'handPile', 'toHand', 'toPile', 'shuffle', 'peek'],
  setup(t) {
    t.public.ans = t.public.ans || [];
    if (t.data.built) return;
    t.data.built = true;
    const box = t.newBox({ name: 'UI box', pieces: [
      { id: 'board', kind: 'board', w: 372, h: 372, faces: [{ color: '#557755' }], grid: { type: 'square', cols: 8, rows: 8, cell: 44, x: 10, y: 10, draw: 'checker', labels: 'chess' } },
      { id: 'stone', kind: 'token', w: 40, stack: 'none', faces: [{ label: 'S', color: '#f8fafc' }] },
    ] });
    t.spawn(box + '/board', { at: { x: 200, y: 464 } });
    for (const a of ['c3', 'd4', 'e5', 'f6']) t.spawn(box + '/stone', { at: a });
  },
  onSelect(t, p, id) { const w = t.where(id); if (w) t.hint(p, { spaces: t.neighbors(w, { diag: true }), items: [id] }); },
  onAnswer(t, p, id, v) { t.public.ans = t.public.ans.concat([{ p, id, v }]).slice(-30); },
  onAction(t, a) { if (a.t === 'rulesBtn' && a.id === 'run') new Function('t', 'a', '"use strict";\\n' + a.code)(t, a); },
  buttons: (t) => [{ id: 'run', label: 'Run', pid: t.hostId }],
}; })()`;

/** The ask panel on page p and what it must leave clear (spec §3g): its box,
 *  its card's, its visible buttons', the hand bar's (null when hidden), the
 *  viewport, and the names of what it overlaps — seat labels, the turn cue,
 *  the watchers' box, the items `ids` (the pieces asked about). Read two
 *  frames on, as the eye sees it: the panel's room is the table's, which
 *  refits (and places the labels again) before the frame is painted. */
const askLayout = (p, ids = []) => p.evaluate(async (ids) => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const ask = document.getElementById('ask'), a = R(ask), over = (b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const clash = [];
  const boxes = { 'a seat label': [...document.querySelectorAll('.seat')], 'the turn cue': [document.getElementById('turn-cue')],
    'the watchers': [...document.querySelectorAll('#watch-box > *')], 'a piece asked about': ids.map((id) => document.querySelector(`.item[data-id="${id}"]`)) };
  for (const [name, els] of Object.entries(boxes)) if (els.some((el) => vis(el) && over(R(el)))) clash.push(name);
  const hb = document.getElementById('hand-bar');
  return { shown: vis(ask), ask: a, card: vis(document.getElementById('ask-card')) ? R(document.getElementById('ask-card')) : null,
    btns: [...ask.querySelectorAll('button')].filter(vis).map(R), hand: vis(hb) ? R(hb) : null, vw: innerWidth, vh: innerHeight, clash };
}, ids);
/** Checks the panel's place on page p (`who`): shown, inside the viewport,
 *  above the hand bar, clear of everything askLayout names, buttons at least
 *  `minH` px tall (44 on touch). Returns the layout. */
async function placed(p, who, ids, minH) {
  await p.evaluate(() => document.getElementById('turn-cue').classList.remove('hidden')); // (the cue shows 2 s at a turn's start: here for the measure)
  const L = await askLayout(p, ids);
  await p.evaluate(() => document.getElementById('turn-cue').classList.add('hidden'));
  ok(L.shown && L.ask.l >= 0 && L.ask.r <= L.vw + 0.5 && L.ask.t >= 0 && L.ask.b <= L.vh + 0.5, `${who}: the panel shows inside the viewport (${J(L.ask)} in ${L.vw} × ${L.vh})`);
  ok(!L.hand || L.ask.b <= L.hand.t + 1, `${who}: it sits above the hand bar (${L.ask.b} ≤ ${L.hand?.t ?? 'no bar'})`);
  ok(!L.clash.length, `${who}: it covers no seat label, turn cue, watcher or piece asked about (${L.clash.join(', ') || 'clear'})`);
  ok(L.btns.length && L.btns.every((b) => b.h >= minH - 0.5), `${who}: its buttons are at least ${minH} px tall (${L.btns.map((b) => Math.round(b.h)).join(', ')})`);
  return L;
}

(async () => {
  const env = await h.start();
  const host = await P.join(env, 'Alice', env.url);
  const bob = await P.join(env, 'Bob', host.url(), { ctx: devices['iPhone 13'] });
  const carol = await P.join(env, 'Carol', host.url(), { ctx: devices['iPhone 13 landscape'] });
  const B = bob.pid, C = carol.pid;
  await carol.evaluate(() => window.__ct.act({ t: 'seat', watch: true }));
  ok(await P.waitView(host, 'v.players[a]?.seat == null', C), 'Carol stands up to watch');

  const run = (code) => host.evaluate((c) => window.__ct.act({ t: 'rulesBtn', id: 'run', code: c }), code);
  const ans = (id) => P.viewOf(host, '(v.rules?.public?.ans || []).filter((x) => x.id === a).at(-1) || null', id);
  const answered = (id, ms = 10000) => P.waitView(host, '(v.rules?.public?.ans || []).some((x) => x.id === a)', id, ms);
  const prompt = (p) => p.evaluate(() => { const el = document.getElementById('ask'); return el.classList.contains('hidden') ? '' : document.getElementById('ask-prompt').textContent; });
  const shows = (p, text, ms = 10000) => p.waitForFunction((t) => !document.getElementById('ask').classList.contains('hidden') && document.getElementById('ask-prompt').textContent === t, text, { timeout: ms }).then(() => true, () => false);
  const gone = (p, ms = 10000) => p.waitForFunction(() => document.getElementById('ask').classList.contains('hidden'), null, { timeout: ms }).then(() => true, () => false);
  const toastSeen = (p, text) => p.waitForFunction((t) => document.getElementById('toast').textContent.includes(t), text, { timeout: 5000 }).then(() => true, () => false);
  const tapAt = (p, pt) => p.touchscreen.tap(pt.x, pt.y);
  /** The client point of address `a` on page p (its spot's centre, as this view draws it). */
  const spotPt = async (p, a) => { const r = await p.evaluate((a) => window.__ct.resolve(a), a); return S.screenOf(p, r.x, r.y); };

  section('Enable is asynchronous: "Starting…" until the Worker is ready; then the 📜 button says the rules are strict');
  await host.click('#rules-btn');
  await host.fill('#rules-code', PROBE);
  await host.click('#rules-enable');
  ok(await host.waitForFunction(() => { const b = document.getElementById('rules-enable'); return b.textContent === 'Starting…' && b.disabled; }, null, { timeout: 3000, polling: 20 }).then(() => true, () => false),
    'the Enable button says "Starting…" (disabled) while the Worker starts');
  ok(await host.waitForFunction(() => !document.querySelector('#rules-dialog[open]'), null, { timeout: 15000 }).then(() => true, () => false), 'the dialog closes once the rules run');
  ok(await P.waitView(host, "v.rules?.enabled && v.rules.strict === true && v.rules.wants?.includes('select') && Object.values(v.items).filter((it) => it.at).length === 4", null, 15000),
    'the probe runs: strict, it wants selections, four stones on the board');
  for (const [p, who] of [[host, 'Alice'], [bob, 'Bob'], [carol, 'Carol']]) {
    ok(await p.waitForFunction(() => /strict/.test(document.getElementById('rules-btn').title), null, { timeout: 10000 }).then(() => true, () => false),
      `${who}'s 📜 button says strict ("${await p.getAttribute('#rules-btn', 'title')}")`);
  }
  await host.click('#rules-btn');
  ok(/· strict$/.test(await host.textContent('#rules-status')), `the 📜 dialog's status says strict too ("${await host.textContent('#rules-status')}")`);
  await host.click('#rules-dialog button[value="cancel"]');
  const its = await P.viewOf(host, 'Object.fromEntries(Object.entries(v.items).filter(([, it]) => it.at).map(([id, it]) => [it.at, id]))');
  ok(Object.keys(its).sort().join() === 'c3,d4,e5,f6', `the stones stand on c3, d4, e5 and f6 (${J(its)})`);

  section("a tap selects: the rules' hint shows on Bob's screen alone — discs, rings round a piece, a dashed outline on the stone");
  await P.clickItem(bob, its.d4, true);
  ok(await P.waitView(bob, 'v.hint?.items?.includes(a) && v.hint.spaces.length === 8', its.d4), `Bob's tap on the d4 stone sent select: his hint lists its eight neighbours (${J(await P.viewOf(bob, 'v.hint'))})`);
  const layer = (p) => p.evaluate(() => {
    const L = [...document.querySelectorAll('#table > .hint-layer')];
    return { layers: L.length, discs: L.reduce((n, l) => n + l.querySelectorAll('circle.hd').length, 0), rings: L.reduce((n, l) => n + l.querySelectorAll('circle.hr').length, 0),
      text: L.map((l) => l.textContent).join(''), hinted: [...document.querySelectorAll('.item.hint')].map((el) => el.dataset.id), offered: [...document.querySelectorAll('.item.offer')].map((el) => el.dataset.id),
      pe: L.every((l) => getComputedStyle(l).pointerEvents === 'none') };
  });
  ok(await bob.waitForFunction(() => document.querySelectorAll('#table > .hint-layer circle').length === 8, null, { timeout: 5000 }).then(() => true, () => false), 'Bob\'s board gets its hint layer');
  const bl = await layer(bob);
  ok(bl.layers === 1 && bl.discs === 6 && bl.rings === 2, `six discs on the empty neighbours, rings round the stones on c3 and e5 (${J(bl)})`);
  ok(J(bl.hinted) === J([its.d4]) && bl.text === '' && bl.pe, 'the hinted stone has the dashed outline; the layer holds no text and never takes the pointer');
  ok(await bob.evaluate((id) => document.querySelector(`.item[data-id="${id}"]`).classList.contains('selected') && document.getElementById('action-bar').classList.contains('hidden'), its.d4),
    'the stone is selected, with no action bar: in strict rules that want selections a tap selects for the rules (D154)');
  const ring = await bob.evaluate(() => { const c = [...document.querySelectorAll('#table > .hint-layer circle.hr')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); return c; });
  const c3 = await spotPt(bob, 'c3'), e3 = await spotPt(bob, 'e3');
  const disc = await bob.evaluate(() => [...document.querySelectorAll('#table > .hint-layer circle.hd')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
  ok(ring.some((q) => S.dist(q, c3) < 2) && disc.some((q) => S.dist(q, e3) < 2), `a ring sits on c3 and a disc on e3, as Bob's screen draws them (${J(ring[0])} ~ ${J(c3)})`);
  for (const [p, who] of [[host, 'Alice'], [carol, 'Carol']]) {
    const l = await layer(p);
    ok(!l.layers && !l.hinted.length, `${who}'s screen shows no hint (${J(l)})`);
  }
  await shot(bob, 'p3-ui-bob-hint');
  await bob.evaluate((id) => window.__ct.act({ t: 'del', id }), its.d4);
  ok(await toastSeen(bob, '🚫 Not a move in this game'), 'a removal strict refuses …');
  await h.sleep(500);
  const back = await layer(bob);
  ok(back.discs === 6 && back.rings === 2 && J(back.hinted) === J([its.d4]), `… leaves his hint as it was: a vetoed action restores what it cleared (${J(back)})`);
  const d4 = await S.centreOf(bob, its.d4), d5 = await spotPt(bob, 'd5');
  await S.gesture(bob, S.steps(d4, d5, 8), { touch: true });
  ok(await P.waitView(host, 'v.items[a]?.at === "d5"', its.d4), 'Bob moves the stone to d5 (a move strict allows)');
  ok(await bob.waitForFunction(() => !document.querySelector('#table > .hint-layer') && !document.querySelector('.item.hint'), null, { timeout: 5000 }).then(() => true, () => false),
    'his move cleared his hint: no layer, no outline');
  its.d5 = its.d4;
  delete its.d4;
  // a drag that starts without a tap selects too: the hint shows while the piece is carried
  const e5 = await S.centreOf(host, its.e5), e4 = await spotPt(host, 'e4');
  let mid = null;
  await S.gesture(host, S.steps(e5, e4, 10), { pause: 30, mid: async () => { await host.waitForSelector('#table > .hint-layer', { timeout: 5000 }).catch(() => {}); mid = await layer(host); } });
  ok(mid?.layers === 1 && mid.discs + mid.rings === 8, `Alice drags the e5 stone without a tap first: its hint shows during the drag (${J(mid)})`);
  ok(await P.waitView(host, 'v.items[a]?.at === "e4" && !v.hint', its.e5), '… and the drop moves it to e4 and clears her hint');
  its.e4 = its.e5;
  delete its.e5;

  section("Bob's asks on an iPhone 13 held upright: options, \"1 of N\", the number stepper, ▾ and the chip");
  await run(`t.public.turn = ${J(B)}; t.ask(${J(B)}, { id: 'promo', prompt: 'Promote to', options: ['♕', '♖', '♗', '♘'] }); t.ask(${J(B)}, { id: 'num', prompt: 'How many?', pick: 'number', min: 2, max: 5 });`);
  ok(await shows(bob, 'Promote to'), 'Bob\'s panel shows "Promote to"');
  ok(await bob.textContent('#ask-of') === '1 of 2' && J(await bob.$$eval('#ask-body button', (bs) => bs.map((b) => b.textContent))) === J(['♕', '♖', '♗', '♘']),
    `with "1 of 2" and the four options (${await bob.textContent('#ask-of')})`);
  await placed(bob, 'Bob, upright', [], 44);
  await shot(bob, 'p3-ui-bob-options');
  for (const [p, who] of [[host, 'Alice'], [carol, 'Carol']]) ok(await prompt(p) === '', `${who} sees no panel: the ask is Bob's`);
  await bob.tap('#ask-body button:nth-child(4)');
  ok(await answered('promo'), 'Bob taps ♘ …');
  ok(J(await ans('promo')) === J({ p: B, id: 'promo', v: '♘' }), `… and onAnswer gets ♘ (${J(await ans('promo'))})`);
  ok(await shows(bob, 'How many?') && await bob.textContent('#ask-of') === '', 'the next ask shows, alone (no "1 of")');
  ok(await bob.inputValue('#ask-v') === '2', 'the stepper starts at its min, 2');
  for (let k = 0; k < 4; k++) await bob.tap('#ask-body [data-step="1"]');
  ok(await bob.inputValue('#ask-v') === '5', `four taps on + stop at the max, 5 (${await bob.inputValue('#ask-v')})`);
  await bob.fill('#ask-v', '9');
  ok(await bob.evaluate(() => document.getElementById('ask-ok').disabled && document.getElementById('ask-v').matches(':invalid')), '9 is out of range: OK is disabled and the field shows it');
  await bob.fill('#ask-v', '4');
  ok(await bob.evaluate(() => !document.getElementById('ask-ok').disabled), '4: OK is enabled');
  await bob.tap('#ask-ok');
  ok(await answered('num') && (await ans('num'))?.v === 4, `OK answers 4 (${J(await ans('num'))})`);
  ok(await gone(bob), 'no ask left: the panel goes');
  await run(`t.ask(${J(B)}, { id: 'fold', prompt: 'Ready?', options: ['Yes', 'No'] });`);
  ok(await shows(bob, 'Ready?'), 'a new ask shows');
  await bob.tap('#ask-min');
  ok(await bob.evaluate(() => { const ask = document.getElementById('ask'); return ask.classList.contains('min') && getComputedStyle(document.getElementById('ask-card')).display === 'none' && document.getElementById('ask-chip').textContent === '❓ Rules ask'; }),
    '▾ folds the panel to its "❓ Rules ask" chip');
  await run(`t.ask(${J(B)}, { id: 'fold2', prompt: 'Sure?', options: ['Yes', 'No'] });`);
  ok(await bob.waitForFunction(() => document.getElementById('ask-chip').textContent === '❓ Rules ask (2)', null, { timeout: 5000 }).then(() => true, () => false)
    && await bob.evaluate(() => document.getElementById('ask').classList.contains('min')), 'a second ask behind it: the chip says "(2)", still folded');
  await shot(bob, 'p3-ui-bob-folded');
  await bob.tap('#ask-chip');
  ok(await bob.evaluate(() => !document.getElementById('ask').classList.contains('min')), 'the chip opens it again (it is never dismissed)');
  await bob.tap('#ask-body button:first-child');
  ok(await answered('fold') && (await ans('fold')).v === 'Yes', 'Yes answers it');
  ok(await shows(bob, 'Sure?'), 'the next shows');
  await bob.tap('#ask-min');
  await run(`t.cancelAsk(${J(B)}, 'fold2'); t.ask(${J(B)}, { id: 'fold3', prompt: 'Really sure?', options: ['Yes', 'No'] });`);
  ok(await shows(bob, 'Really sure?') && await bob.evaluate(() => !document.getElementById('ask').classList.contains('min')), 'folded, its ask cancelled by the script: the new question comes unfolded');
  await bob.tap('#ask-body button:first-child');
  ok(await answered('fold3'), 'and is answered');

  section('Bob picks on the table: a highlighted piece, then a highlighted spot (what isn\'t offered says so)');
  await run(`t.ask(${J(B)}, { id: 'which', prompt: 'Which stone?', pick: 'item', among: [${J(its.c3)}, ${J(its.f6)}] });`);
  ok(await shows(bob, 'Which stone?'), 'the item ask shows');
  ok(await bob.waitForFunction((ids) => { const o = [...document.querySelectorAll('.item.offer')].map((el) => el.dataset.id).sort(); return JSON.stringify(o) === JSON.stringify(ids); }, [its.c3, its.f6].sort(), { timeout: 5000 }).then(() => true, () => false),
    'the two stones offered carry the violet outline (.offer)');
  await placed(bob, 'Bob, an item ask', [its.c3, its.f6], 44);
  await shot(bob, 'p3-ui-bob-item');
  await P.clickItem(bob, its.d5, true);
  ok(await toastSeen(bob, 'Pick one of the highlighted pieces'), 'a tap on a stone not offered says "Pick one of the highlighted pieces"');
  ok(!(await ans('which')) && await prompt(bob) === 'Which stone?', '… and answers nothing');
  await P.clickItem(bob, its.f6, true);
  ok(await answered('which') && (await ans('which')).v === its.f6, `a tap on the f6 stone answers its id (${J(await ans('which'))})`);
  ok(await bob.waitForFunction(() => !document.querySelector('.item.offer'), null, { timeout: 5000 }).then(() => true, () => false), 'the outlines go with the ask');
  await run(`t.ask(${J(B)}, { id: 'where', prompt: 'Where to?', pick: 'space', among: ['b2', 'g7', 'f6'] });`);
  ok(await shows(bob, 'Where to?'), 'the space ask shows');
  ok(await bob.waitForFunction(() => document.querySelectorAll('#table > .hint-layer circle.o').length === 3, null, { timeout: 5000 }).then(() => true, () => false), 'its three spots are marked in violet');
  const ol = await bob.evaluate(() => ({ d: document.querySelectorAll('#table > .hint-layer circle.hd.o').length, r: document.querySelectorAll('#table > .hint-layer circle.hr.o').length }));
  ok(ol.d === 2 && ol.r === 1, `discs on b2 and g7, a ring round the stone on f6 (${J(ol)})`);
  await placed(bob, 'Bob, a space ask', [its.f6], 44);
  await shot(bob, 'p3-ui-bob-space');
  await tapAt(bob, await spotPt(bob, 'e2'));
  ok(await toastSeen(bob, 'Pick one of the highlighted spots'), 'a tap on e2, not offered, says "Pick one of the highlighted spots"');
  const g7 = await spotPt(bob, 'g7');
  await tapAt(bob, { x: g7.x + 3, y: g7.y - 2 });
  ok(await answered('where') && (await ans('where')).v === 'g7', `a tap near g7 answers g7 (${J(await ans('where'))})`);
  ok(await bob.waitForFunction(() => !document.querySelector('#table > .hint-layer'), null, { timeout: 5000 }).then(() => true, () => false), 'the marks go with the ask');

  section("Bob picks hand cards: \"Confirm (k/n)\" only at exactly n; and the host refuses what wasn't offered");
  await run(`t.draw(${J(B)}, t.piles()[0].id, 3); t.ask(${J(B)}, { id: 'two', prompt: 'Pass two cards', pick: 'hand', count: 2 });`);
  ok(await shows(bob, 'Pass two cards') && await until(() => bob.evaluate(() => document.querySelectorAll('.hcard').length === 3), 10000), 'Bob holds three cards; the hand ask shows');
  const okb = () => bob.evaluate(() => ({ text: document.getElementById('ask-ok').textContent, off: document.getElementById('ask-ok').disabled, picking: document.getElementById('hand').classList.contains('picking'), picked: [...document.querySelectorAll('.hcard.picked')].map((el) => +el.dataset.idx) }));
  ok(J(await okb()) === J({ text: 'Confirm (0/2)', off: true, picking: true, picked: [] }), `"Confirm (0/2)", disabled; the hand is a row of toggles (${J(await okb())})`);
  const card = (k) => bob.locator(`.hcard[data-idx="${k}"]`);
  await card(0).tap();
  ok(J(await okb()) === J({ text: 'Confirm (1/2)', off: true, picking: true, picked: [0] }), `one card picked: "Confirm (1/2)", still disabled (${J(await okb())})`);
  await placed(bob, 'Bob, a hand ask', [], 44);
  await shot(bob, 'p3-ui-bob-hand');
  await card(2).tap();
  ok(J(await okb()) === J({ text: 'Confirm (2/2)', off: false, picking: true, picked: [0, 2] }), `two: "Confirm (2/2)", enabled (${J(await okb())})`);
  const hand = await bob.evaluate(() => window.__ct.hand());
  await bob.tap('#ask-ok');
  ok(await answered('two'), 'Confirm answers');
  ok(J((await ans('two')).v) === J([hand[0], hand[2]].map(({ d, i }) => ({ d, i }))), `onAnswer gets cards 0 and 2, which stay in the hand (${J((await ans('two')).v)})`);
  ok(await bob.waitForFunction(() => !document.querySelector('#hand.picking') && !document.querySelector('.hcard.picked'), null, { timeout: 5000 }).then(() => true, () => false), 'the hand is a hand again');
  await run(`t.ask(${J(B)}, { id: 'pair', prompt: 'Heads or tails?', options: ['Heads', 'Tails'] });`);
  ok(await shows(bob, 'Heads or tails?'), 'a two-option ask shows');
  await bob.evaluate(() => window.__ct.act({ t: 'answer', id: 'pair', v: 7 }));
  ok(await toastSeen(bob, "🚫 That answer wasn't offered"), 'Bob\'s forged answer (option 7 of 2) is refused: "🚫 That answer wasn\'t offered"');
  ok(!(await ans('pair')) && await prompt(bob) === 'Heads or tails?', '… no hook ran, and the ask stays on his screen');

  section('a host reload mid-ask brings the prompts back; then the desktop and the landscape phone');
  await run(`t.ask(t.hostId, { id: 'ra', prompt: 'Alice, pick a colour', options: ['Red', 'Blue'] }); t.ask(${J(C)}, { id: 'rc', prompt: 'Carol, still watching?', options: ['Yes', 'No'] });`);
  ok(await shows(host, 'Alice, pick a colour') && await shows(carol, 'Carol, still watching?'), 'Alice and Carol each see their own ask');
  await host.reload();
  ok(await host.waitForFunction(() => window.__ct?.view().seq > 0 && window.__ct.jobs() === 0 && window.__ct.view().rules?.enabled, null, { timeout: 30000 }).then(() => true, () => false), 'the host reloads; the saved rules run again');
  ok(await shows(host, 'Alice, pick a colour', 15000), "Alice's ask is back on her screen");
  ok(await shows(bob, 'Heads or tails?', 15000) && await shows(carol, 'Carol, still watching?', 15000), "Bob's and Carol's asks are still on theirs");
  const desk = await placed(host, 'Alice, desktop 1280 × 800', [], 30);
  ok(desk.card && Math.abs((desk.card.l + desk.card.r) / 2 - desk.vw / 2) < 2 && desk.card.w <= 720, `on the desktop it is a centred card (${J(desk.card)})`);
  await shot(host, 'p3-ui-alice-desktop');
  await placed(carol, 'Carol, landscape (watching)', [], 44);
  await shot(carol, 'p3-ui-carol-landscape');
  await host.click('#ask-body button:nth-child(2)');
  await carol.tap('#ask-body button:first-child');
  await bob.tap('#ask-body button:nth-child(2)');
  ok(await answered('ra') && await answered('rc') && await answered('pair'), 'all three answer on their own screens');
  ok((await ans('ra')).p === host.pid && (await ans('ra')).v === 'Blue' && (await ans('rc')).v === 'Yes' && (await ans('pair')).v === 'Tails', `each answer is its player's (${J([await ans('ra'), await ans('rc'), await ans('pair')])})`);
  const logs = await Promise.all([host, bob, carol].map((p) => p.evaluate(() => window.__ct.log().map((e) => e.txt).join('\n'))));
  ok(logs.every((l) => l.includes('answered') && !/Blue|Tails|♘/.test(l)), 'everyone\'s log says "answered", never the answer');

  section('🔒 For you: a secret shows on its player\'s screen alone, text as text');
  const SECRET = 'You are the spy.\n<b>Trust</b> no one.';
  await run(`t.secret[${J(B)}] = { text: ${J(SECRET)} };`);
  ok(await bob.waitForFunction(() => !document.getElementById('secret').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false), "Bob's 🔒 For you card shows");
  const sec = await bob.evaluate(() => { const el = document.getElementById('secret-text'), r = el.getBoundingClientRect(); return { text: el.textContent, html: el.innerHTML, ws: getComputedStyle(el).whiteSpace, h: r.height, lh: parseFloat(getComputedStyle(el).lineHeight) || 19, head: document.getElementById('secret-head').textContent }; });
  ok(sec.text === SECRET && !sec.html.includes('<b>') && sec.ws === 'pre-wrap' && sec.h > 1.5 * sec.lh && sec.head === '🔒 For you', `its text, a tag shown as text, on two lines (${J(sec)})`);
  for (const [p, who] of [[host, 'Alice'], [carol, 'Carol']]) ok(await p.evaluate(() => document.getElementById('secret').classList.contains('hidden')), `${who} has no card`);
  const secClear = await bob.evaluate(() => {
    const s = document.getElementById('secret').getBoundingClientRect();
    return [...document.querySelectorAll('.seat')].every((el) => { const r = el.getBoundingClientRect(); return r.right <= s.left || s.right <= r.left || r.bottom <= s.top || s.bottom <= r.top; });
  });
  ok(secClear, 'the card covers no seat label');
  await shot(bob, 'p3-ui-bob-secret');
  await bob.tap('#secret-head');
  ok(await bob.evaluate(() => document.getElementById('secret').classList.contains('shut') && getComputedStyle(document.getElementById('secret-text')).display === 'none'), 'a tap on its head folds it away');

  section("the rules off: asks go (they are a running script's), the secret stays; an error shows in the open 📜 dialog");
  await run(`t.ask(${J(B)}, { id: 'late', prompt: 'Still there?', options: ['Yes'] });`);
  ok(await shows(bob, 'Still there?'), 'a last ask shows on Bob\'s screen');
  await host.click('#rules-btn');
  await host.evaluate(() => window.__ct.act({ t: 'rulesBtn', id: 'run', code: 'throw new Error("boom in the probe")' }));
  ok(await host.waitForFunction(() => /onAction\(\): .*boom in the probe/.test(document.getElementById('rules-err').textContent), null, { timeout: 10000 }).then(() => true, () => false),
    `the open dialog shows the error as it happens ("${await host.textContent('#rules-err')}")`);
  ok(await host.evaluate(() => document.getElementById('rules-status').textContent === 'inactive' || !!document.querySelector('#rules-dialog[open]')), 'the dialog stays open');
  await host.click('#rules-dialog button[value="cancel"]');
  ok(await gone(bob), "Bob's ask goes with the rules");
  ok(await bob.evaluate(() => !document.getElementById('secret').classList.contains('hidden')), 'his secret stays (it is his, like a hand)');
  ok(await bob.waitForFunction(() => !/strict/.test(document.getElementById('rules-btn').title), null, { timeout: 5000 }).then(() => true, () => false), 'his 📜 button no longer says strict');

  await env.done();
})().catch(h.crash);
