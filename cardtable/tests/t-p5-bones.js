// Phase 5, attacker cases 2, 4 and 7 on the shipped Dominoes (spec §5j, §5g;
// D270, D271), written from the spec apart from the implementation's own
// suites. Bob hosts on a desktop and picks Dominoes from 🎲; Alice plays on
// an iPhone 13; Mallory is a raw peer watching.
//   1  Draw 7 (Alice's button, on her phone) fills both racks: each player's
//      seven tiles show their faces with 🙈 on that player's screen alone.
//   2  Case 2: no body Mallory gets carries a rack tile's type, face, name
//      or pips, nor any per-recipient form; her view holds the racks' backs.
//   3  Case 7: the script's validate vetoes peeks — Bob's Peek from the bar
//      is refused with its notice (no overlay, no line), Mallory's too (no
//      answer); case 4's move and flip of Alice's tile refused (the flip
//      uniformly), the tile as it was.
//   4  The leader plays a tile out of their rack: face up for everyone,
//      Mallory included — and still nothing of the thirteen left.
'use strict';
const h = require('./h');
const { ok, section } = h;
const M = require('./p4m-lib');
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const V = require('./p5v-lib');
const { pickGame } = require('./stones-lib');

const J = JSON.stringify;
const MAL = V.MAL;

(async () => {
  const env = await h.start();
  const bob = await M.join(env, 'Bob', env.url);
  const alice = await M.join(env, 'Alice', bob.url(), { ctx: P.PHONE });
  const Mal = await V.spy(env, bob.url());
  await Mal.hello(0);
  const BOB = bob.pid, ALICE = alice.pid;
  const S = () => bob.evaluate(() => window.__ct.hostState());
  const act = (a) => bob.evaluate((x) => window.__ct.act(x), a);
  const done = () => bob.waitForFunction(() => window.__ct.jobs() === 0, null, { timeout: 15000 });
  const touch = async (p, id) => { const c = await M.centre(p, id); if (p.touch) await M.tap(p, c); else await M.click(p, c); };
  const deselect = (p) => (p.touch ? p.evaluate(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))) : p.keyboard.press('Escape'));
  const barOn = async (p, id) => { await deselect(p); await touch(p, id); await M.until(async () => (await M.bar(p)).on, 4000, 50); return (await M.bar(p)).btns; };

  section('0 Bob picks Dominoes from 🎲; Alice sits South, Bob North, Mallory watches');
  await pickGame(bob, 'dominoes');
  ok(await M.until(async () => (await S()).rules?.enabled && (await S()).rules.name === 'Dominoes', 15000, 200), 'Dominoes is set up with its rules');
  for (const a of [{ p: MAL, watch: true }, { p: ALICE, watch: true }, { p: BOB, watch: true }, { p: ALICE, id: 'south' }, { p: BOB, id: 'north' }]) await act({ t: 'seat', ...a });
  await done();
  let st = await S();
  ok(st.players[ALICE].seatId === 'south' && st.players[BOB].seatId === 'north' && st.players[MAL]?.seat == null, 'seated: Alice South, Bob North; Mallory watches');

  section('1 Draw 7 from Alice\'s phone fills both racks; each sees their own faces, with 🙈');
  const dealAt = await Mal.count();
  const btn = `#rules-btns button[data-rbtn="deal-${ALICE}"]`;
  ok(await alice.waitForSelector(btn, { timeout: 10000 }).then(() => true, () => false), 'Alice\'s phone offers "Draw 7"');
  await alice.locator(btn).tap();
  const racked = (s, seat) => Object.keys(s.items).filter((k) => s.items[k].pv && J(s.items[k].vis) === J([`seat:${seat}`])).sort();
  ok(await M.until(async () => { const s = await S(); return racked(s, 'south').length === 7 && racked(s, 'north').length === 7; }, 15000, 200), 'seven tiles in each rack, hidden for its seat');
  st = await S();
  const AT = racked(st, 'south'), BT = racked(st, 'north');
  ok([...AT, ...BT].every((k) => st.items[k].up === false && st.items[k].po === 1), 'each face down, its seat\'s through po');
  await M.until(async () => { const v = await M.items(alice); return AT.every((k) => v[k] && 't' in v[k]); }, 10000, 100); // (an id not in the view yet: wait, never throw)
  for (const [p, mine, theirs, who] of [[alice, AT, BT, 'Alice'], [bob, BT, AT, 'Bob']]) {
    const v = await M.items(p);
    ok(mine.every((k) => v[k].t === st.items[k].t && v[k].up === false) && theirs.every((k) => !('t' in v[k]) && 'b' in v[k]), `${who}'s view: her or his own seven in full, the other rack's backs`);
    const drawnMine = await Promise.all(mine.map((k) => V.drawn(p, k))), drawnTheirs = await Promise.all(theirs.map((k) => V.drawn(p, k)));
    ok(drawnMine.every((d) => d?.badge) && drawnTheirs.every((d) => d && !d.badge), `${who}'s screen: 🙈 on each of their own tiles, none on the others'`);
  }
  await M.shot(alice, 'p5v-bones-phone');
  await M.shot(bob, 'p5v-bones-desk');

  section('2 case 2: nothing of either rack reaches Mallory');
  const names = (ids) => ids.map((k) => { const ty = st.items[k].t.split('/')[1]; return `${ty[1]}|${ty[2]}`; });
  const tokens = (ids) => [...ids.map((k) => st.items[k].t), ...names(ids)];
  let all = await Mal.bodies();
  let l = [...V.scan(all.slice(dealAt), [...tokens([...AT, ...BT]), 'pips']), ...V.told(all, [...AT, ...BT])];
  ok(!l.length, `${all.length - dealAt} bodies since the deal: no type, name or pips of a rack tile, every record of one reduced ${J(l.slice(0, 3))}`);
  ok(!all.some((b) => b.vis && Object.keys(b.vis).length), 'no per-recipient form at all (she sees nothing hidden)');
  const mv = h.viewFrom(all);
  ok([...AT, ...BT].every((k) => mv.items[k] && 'b' in mv.items[k] && !('t' in mv.items[k])), 'her folded view: the racks\' backs');

  section("3 case 7: the script vetoes peeks (Bob's from the bar, Mallory's); case 4: her move and flip refused");
  const pk = AT[0];
  let btns = await barOn(bob, pk);
  ok(btns.includes('Peek'), `Bob's bar on Alice's tile offers Peek (${J(btns)})`);
  const t0 = Date.now();
  await M.barPress(bob, 'Peek');
  ok(await M.until(async () => (await M.notes(bob, t0)).some((m) => m.includes('No peeking at hidden tiles')), 8000, 100), `the script's notice on Bob's screen (${J(await M.notes(bob, t0))})`);
  await h.sleep(500);
  ok(await bob.evaluate(() => document.getElementById('peek').classList.contains('hidden')) && !(await M.lines(alice, BOB, t0)).includes('peeked at a hidden piece'), 'no overlay, no line');
  await deselect(bob);
  const before = (await S()).items[pk];
  const said = await Mal.tries([{ t: 'peek', id: pk }, { t: 'move', id: pk, x: 300, y: 300 }, { t: 'flip', id: pk }]);
  ok(said[0]?.includes('No peeking at hidden tiles') && !(await Mal.notes()).some((n) => n.peek), `Mallory's peek vetoed, no answer (${J(said[0])})`);
  ok(said.length === 3 && said[1].startsWith('🚫') && said[2] === '🚫 That piece is hidden', `her move refused, her flip with the uniform words (${J(said.slice(1))})`);
  ok(J((await S()).items[pk]) === J(before), 'the tile as it was');

  section('4 the leader plays a tile out of their rack: face up for all; the thirteen left stay hidden from Mallory');
  st = await S();
  const lead = st.rules.public.turn, p = lead === ALICE ? alice : bob, // (the player to move: the public cue — t.data keeps the turn by seat, D284)
    mine = lead === ALICE ? AT : BT, tile = mine[mine.length - 1];
  const pts = P3.steps(await M.centre(p, tile), await M.pt(p, 470, 600), 10);
  if (p.touch) await M.fingerDrag(p, pts);
  else await P3.gesture(p, pts);
  ok(await P.waitView(lead === ALICE ? bob : alice, `'t' in v.items[a] && v.items[a].up !== false`, tile, 10000), `${lead === ALICE ? 'Alice' : 'Bob'} (the leader) plays a tile: face up on the other's screen`);
  ok(await M.until(async () => 't' in (h.viewFrom(await Mal.bodies()).items[tile] || {}), 10000, 200), '…and in Mallory\'s view');
  await h.sleep(500);
  all = await Mal.bodies();
  const left = [...AT, ...BT].filter((k) => k !== tile);
  l = [...V.scan(all.slice(dealAt), [...tokens(left), 'pips']), ...V.told(all, left)];
  ok(!l.length, `the thirteen left: no type, name or pips of one in her ${all.length} bodies ${J(l.slice(0, 3))}`);
  ok(h.viewFrom(all).seq === (await bob.evaluate(() => window.__ct.view().seq)), "her folded view is in step with the host's");
  await env.done();
})().catch(h.crash);
