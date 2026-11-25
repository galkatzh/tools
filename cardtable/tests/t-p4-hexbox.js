// Phase 4B: Hexfront as a box — deterministic, and resumed elsewhere.
// Written from the spec (§4's demo "a generator with a fixed seed, so the
// box is deterministic", §4m; §2j isBuiltin by content; §4c "Ids and
// players on import"; §4g Export… and the trust dialog) and D221–D222.
//  D  Deterministic: templates.js loaded twice (two module instances, two
//     runs of the generator) gives one box; two set-ups of it in Node give
//     equal stored boxes and layouts (ids aside); the browser's set-up from
//     📦 stores that same box and lays out that same table; set up again
//     from 📦, it is still one catalog entry and the same layout.
//  R  Exported mid-game from 📦 (Export…: a .json, since Hexfront has no
//     images; its rules and game state with it) and imported into a fresh
//     room through 📦's upload with "Set up now": the setup confirm, the
//     trust dialog (the export is no built-in box: its content differs),
//     Enable rules — then the same game: every item by its id (place, count,
//     face, owner, address), each seat's hand, the turn, the phase and the
//     script's state, and the side to play moves on with a real gesture,
//     the other side refused.
// Room 1: Alice hosts on a desktop, Bob plays on an iPhone 13 held upright.
// Room 2: Carol hosts on a desktop, Dave plays on an iPhone 13 held
// sideways. The mid-game position is made with __ct.act (setting positions
// up); every step a player takes in 📦 is a real press.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const { until, view, same, diff } = require('./p1-lib');
const B = require('./p4-lib');
const X = require('./p4h-lib');
const core = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

const { devices } = h.playwright;
const LAND = { ...devices['iPhone 13 landscape'] };
const HOST = 'a'.repeat(16), BOB = 'b'.repeat(16);
/** A type ref's own id ("ab12cd34/inf" → "inf"). */
const local = (t) => t?.slice(t.indexOf('/') + 1);
/** A Node table hosted by HOST with Bob, Hexfront set up from `box` (rules off): {T, box (stored), layout}. */
function nodeSetup(box, seed) {
  let n = seed << 16;
  const T = core.createTable({}, { pid: HOST, now: () => 1.7e12, random: () => ((seed = (seed * 16807) % 2147483647) / 2147483647), uid: () => (++n).toString(16).padStart(8, '0') });
  T.open('Alice');
  T.join(BOB, 'Bob', `key-${BOB}`.padEnd(32, '!'));
  T.apply(HOST, { t: 'loadBox', box, setup: true, clear: true });
  T.drain();
  return { T, box: T.state.boxes[T.state.lastSetup], layout: X.layoutOf(T.publicItems()) };
}

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-hexbox-'));

  section('D. Deterministic: one box from two runs of the generator, one layout from every set-up');
  const url = pathToFileURL(path.join(h.APP_ROOT, 'cardtable/templates.js')).href;
  const [m1, m2] = [await import(`${url}?run=1`), await import(`${url}?run=2`)];
  const hx = m1.BOXES.hexfront;
  ok(!!hx && m1 !== m2 && m1.BOXES.hexfront !== m2.BOXES.hexfront, 'templates.js loaded twice: two module instances, two Hexfront boxes made');
  ok(same(hx, m2.BOXES.hexfront), `the two are one box, field for field (${(JSON.stringify(hx).length / 1024).toFixed(1)} KB)${diff(hx, m2.BOXES.hexfront) ? `: ${diff(hx, m2.BOXES.hexfront)}` : ''}`);
  ok(hx.name === 'Hexfront' && !hx.imgs?.length && typeof hx.rules === 'string' && hx.rules.length > 0, `«${hx.name}»: no images (the map and counters are drawn), its turn script inside (${hx.rules?.length} chars)`);
  const n1 = nodeSetup(hx, 7), n2 = nodeSetup(m2.BOXES.hexfront, 991);
  ok(same(n1.box, n2.box) && core.isBuiltin(n1.box), `two set-ups in Node store one box, built in by content (isBuiltin)${diff(n1.box, n2.box) ? `: ${diff(n1.box, n2.box)}` : ''}`);
  ok(same(n1.layout, n2.layout), `and lay out one table, ids aside (${n1.layout.length} items)${diff(n1.layout, n2.layout) ? `: ${diff(n1.layout, n2.layout)}` : ''}`);

  const alice = await X.player(env, 'Alice', env.url);
  const bob = await X.player(env, 'Bob', alice.url(), { ctx: P.PHONE });
  const asked = [];
  alice.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
  /** Host page p sets Hexfront up from 📦's Built-in section (a confirm accepted when asked); resolves once its rules run. */
  async function builtIn(p, other) {
    const t = Date.now();
    await B.openBoxes(p);
    await p.locator('#box-builtins .box-row', { hasText: 'Hexfront' }).locator('button', { hasText: 'Set up' }).click();
    const run = async (q) => { const v = await view(q); return v.rules?.enabled && v.rules.name === 'Hexfront' && v.rules.public?.turn && Object.values(v.items).length > 40; };
    const done = await until(async () => (await run(p)) && (await run(other)), 20000);
    await B.settle(p);
    return done && !(await p.evaluate((t) => window.__modals.some((m) => m.at >= t && m.id === 'box-ask'), t));
  }
  ok(await builtIn(alice, bob), "Alice sets Hexfront up from 📦's Built-in section: its rules run on both screens, with no trust dialog");
  const S1 = await B.S(alice), L1 = X.layoutOf((await view(bob)).items), box1 = S1.lastSetup;
  ok(same(S1.boxes[box1], n1.box), `the box the browser stored is the one Node made, field for field${diff(S1.boxes[box1], n1.box) ? `: ${diff(S1.boxes[box1], n1.box)}` : ''}`);
  ok(same(L1, n1.layout), `the table Bob's phone shows is the one Node laid out, ids aside${diff(L1, n1.layout) ? `: ${diff(L1, n1.layout)}` : ''}`);

  section('R. Mid-game: Azure moves, splits, draws an event and fights; Ember moves and draws (set up with __ct.act)');
  let H = await X.hexOf(alice);
  const seat = Object.fromEntries(Object.entries(H.seats).map(([s, q]) => [q, s]));
  const pageOf = (side) => [alice, bob].find((p) => seat[p.pid] === side), dir = Object.fromEntries(Object.keys(H.seats).map((s) => [s, X.forward(H, s)]));
  const first = seat[H.rules.public.turn], second = Object.keys(H.seats).find((s) => s !== first);
  /** Side `side`'s player sends `a` (__ct.act); resolves the host's view once the host has applied it (its state moved on) and its queue is idle. */
  const play = async (side, a) => {
    const s0 = (await view(alice)).seq;
    await pageOf(side).evaluate((x) => window.__ct.act(x), a);
    if (!(await until(async () => (await view(alice)).seq > s0, 8000, 50))) ok(false, `${side}'s ${a.t} changed nothing on the host`);
    await B.settle(alice, 150);
    return X.hexOf(alice);
  };
  const at = (Hx, id, q) => ({ t: 'move', id, x: q.x - Hx.size[id].w / 2, y: q.y - Hx.size[id].h / 2 });
  const [f1, f2] = X.frontOf(H, first, dir[first]);
  H = await play(first, at(H, f1, X.ahead(H, f1, dir[first])));
  const sp = X.ahead(H, f2, dir[first]);
  H = await play(first, { t: 'split', id: f2, n: 4, x: sp.x - H.size[f2].w / 2, y: sp.y - H.size[f2].h / 2 });
  H = await play(first, { t: 'draw', id: H.events });
  const btn = (side, re) => (H.rules.public.buttons || []).find((b) => b.pid === H.seats[side] && re.test(b.label))?.id;
  H = await play(first, { t: 'rulesBtn', id: btn(first, /combat/i) });
  H = await play(first, { t: 'rulesBtn', id: btn(first, /end/i) });
  const [e1] = X.frontOf(H, second, dir[second]);
  H = await play(second, at(H, e1, X.ahead(H, e1, dir[second])));
  H = await play(second, { t: 'draw', id: H.events });
  const S2 = await B.S(alice), units = H.units.length;
  ok(units === 41 && H.items[f2].n === 6 && H.rules.public.turn === H.seats[second] && Object.values(S2.players).filter((q) => q.hand.length === 1).length === 2,
    `the position: ${units} stacks (a split), ${second}'s turn, each player holding one event card (${JSON.stringify(S2.rules.data)})`);
  const before = { items: (await view(bob)).items, hands: {}, data: S2.rules.data, badges: {} };
  for (const p of [alice, bob]) before.hands[seat[p.pid]] = (await X.hexOf(p)).hand.map((c) => ({ t: local(c.t), f: c.f }));
  for (const [q, b] of Object.entries(H.rules.public.badges || {})) before.badges[seat[q]] = b;

  section('R. Exported from 📦: Hexfront.json with its rules and game state');
  await B.openBoxes(alice);
  const defaults = await alice.evaluate(() => ({ rules: document.getElementById('box-x-rules').checked, state: document.getElementById('box-x-state').checked }));
  ok(defaults.rules && defaults.state, `Export… offers the rules and the game state, ticked: the table runs its rules (${JSON.stringify(defaults)})`);
  const [dl] = await Promise.all([alice.waitForEvent('download', { timeout: 30000 }), X.press(alice, '#box-x-go')]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  let g = null;
  try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.error('the export is no JSON', err); }
  ok(dl.suggestedFilename() === 'Hexfront.json' && !!g, `the download is «${dl.suggestedFilename()}»: a .json, no images being involved (§4g)`);
  ok(g?.name === 'Hexfront' && typeof g.rules === 'string' && g.rules.length > 0 && !!g.rulesState?.data && Array.isArray(g.setup) && g.setup.length >= units,
    `it carries the rules, the game state and a setup of the position (${g?.setup?.length} entries)`);
  await B.closeBoxes(alice);

  section('D. Set up again from 📦: still one Hexfront in the catalog, the same layout as the first');
  ok(await builtIn(alice, bob), 'the second set-up runs its rules on both screens, no trust dialog');
  const S3 = await B.S(alice), hexes = Object.entries(S3.boxes).filter(([, b]) => b.name === 'Hexfront');
  ok(hexes.length === 1 && hexes[0][0] === box1 && S3.lastSetup === box1, `the catalog keeps one Hexfront, the same box (${hexes.map(([id]) => id).join(', ')})`);
  const L2 = X.layoutOf((await view(bob)).items);
  ok(same(L2, L1), `the same table as the first set-up, ids aside${diff(L2, L1) ? `: ${diff(L2, L1)}` : ''}`);

  section('R. A fresh room: Carol (desktop) uploads the export, Set up now — the setup confirm, the trust dialog, Enable rules');
  const carol = await X.player(env, 'Carol', env.url);
  const dave = await X.player(env, 'Dave', carol.url(), { ctx: LAND });
  await carol.waitForFunction((q) => !!window.__ct.view().players[q], dave.pid, { timeout: 30000 });
  carol.on('dialog', (d) => { console.error('Carol: a native dialog nobody expected', d.message()); d.dismiss(); });
  const up = await B.upload(carol, [file], { now: true });
  ok(up.ask === 'setup', `the upload registers and asks first: the table has items (${up.ask || up.err || up.progress})`);
  const q1 = await B.asked(carol, 'setup');
  ok(!!q1 && q1.buttons.some((b) => b.label === 'Set up'), `"${q1?.title}" (${q1?.lines.join(' ')})`);
  await B.reply(carol, 'Set up', { 'Enable its rules': true });
  const q2 = await B.asked(carol, 'trust');
  ok(!!q2 && q2.buttons.some((b) => b.label === 'Enable rules'), `the trust dialog: an exported game is no built-in box ("${q2?.title}")`);
  await B.reply(carol, 'Enable rules');
  ok(await until(async () => { const v = await view(dave); return v.rules?.enabled && v.rules.name === 'Hexfront' && Object.keys(v.items).length === Object.keys(before.items).length; }, 20000),
    "Enable rules: Hexfront runs in the new room, on Dave's phone too");
  await B.settle(carol);
  const S4 = await B.S(carol);
  ok(!core.isBuiltin(S4.boxes[S4.lastSetup]), 'the box it stored is not built in (its content is the export\'s)');
  const toasts = await B.toasts(carol);
  ok(!toasts.some((t) => /ids had to change|weren't seated|was invalid/.test(t)), `no id remapped, no state dropped (${JSON.stringify(toasts)})`);

  section('R. The same game: every item by its id, each seat\'s hand, the turn, the phase and the script\'s state');
  const after = await view(dave), Hd = await X.hexOf(carol), seat2 = Object.fromEntries(Object.entries(Hd.seats).map(([s, q]) => [q, s]));
  const pick = (it) => ({ k: it.k, t: local(it.t), f: it.f, n: it.n, owner: it.owner, at: it.at, rot: it.rot, lock: !!it.lock, name: it.name, top: it.top && { b: local(it.top.b), up: it.top.up } });
  const ids = Object.keys(before.items), wrong = ids.filter((id) => {
    const a = before.items[id], b = after.items[id];
    return !b || !same(pick(a), pick(b)) || Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5;
  });
  ok(same(Object.keys(after.items).sort(), ids.sort()) && !wrong.length, `all ${ids.length} items, ids kept, each where it was, as it was (${wrong.slice(0, 3).map((id) => `${id}: ${JSON.stringify(pick(before.items[id]))} → ${JSON.stringify(after.items[id] && pick(after.items[id]))}`).join('; ') || 'none differ'})`);
  ok(Object.keys(Hd.seats).length === 2 && [carol, dave].every((p) => !!seat2[p.pid]), `Carol and Dave sit in the two seats (${JSON.stringify(Hd.seats)})`);
  for (const p of [carol, dave]) {
    const hand = (await X.hexOf(p)).hand.map((c) => ({ t: local(c.t), f: c.f }));
    ok(same(hand, before.hands[seat2[p.pid]]), `${p.who} (${seat2[p.pid]}) holds what ${seat2[p.pid]} held: ${JSON.stringify(hand)}`);
  }
  ok(same(S4.rules.data, before.data), `the script's state is the exported one (${JSON.stringify(S4.rules.data)})`);
  ok(after.rules.public.turn === Hd.seats[second] && after.rules.public.badges?.[Hd.seats[second]] === before.badges[second], `${second}'s turn, on its new player's seat, in the same phase ("${after.rules.public.badges?.[Hd.seats[second]]}")`);

  section(`R. Play goes on: ${second}'s player moves a stack forward on their own screen; ${first}'s is refused`);
  const mover = [carol, dave].find((p) => seat2[p.pid] === second), idle = mover === carol ? dave : carol;
  const [s1] = X.frontOf(Hd, second, X.forward(Hd, second)), to = X.ahead(Hd, s1, X.forward(Hd, second));
  await X.moveStack(mover, s1, to);
  ok(await until(async () => (await X.hexOf(idle)).items[s1]?.at === to.at && (await X.hexOf(mover)).items[s1]?.n === Hd.items[s1].n, 8000), `${mover.who}${mover.touch ? ' (phone, sideways)' : ''} moves it to ${to.at}, on both screens`);
  await X.putAway(mover);
  const [s2] = X.frontOf(Hd, first, X.forward(Hd, first)), t0 = Date.now();
  await X.moveStack(idle, s2, X.ahead(Hd, s2, X.forward(Hd, first)));
  const no = await X.refusal(idle, t0);
  ok(!!no && await until(async () => (await X.hexOf(carol)).items[s2].at === Hd.items[s2].at, 3000), `${idle.who}'s move out of turn is refused: "${no}"`);
  const lastErr = await carol.evaluate(() => window.__ct.lastRulesError || '');
  ok(!lastErr, `no script error in the new room (${lastErr})`);
  await dave.screenshot({ path: path.join(__dirname, 'shots', 'p4-hexbox-iphone-land.png') });
  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
