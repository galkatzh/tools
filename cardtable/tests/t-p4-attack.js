// Phase 4B in real tabs: spec §4j attacker case 8, and the watchdog's budget
// for a group (§3f.5). Written from the spec (§4c, §4j, §2c, §2d, §3f.5) and
// its decisions (D217–D219), not from the implementation.
//
// Alice hosts and sets "Muster" up (an original test box: pawns, a locked
// one, Bob's pawn and Bob's face-down card, a face-down crate, two dice, a
// face-down die and a face-down token under one back, another face-down
// card, 200 drill pawns). Bob is an honest guest whose incoming state bodies
// are recorded (p1-lib's RTC hook). Mallory is a raw peer, seated with her
// own key (final-lib), who sends `group` actions no page would:
//   a) a move of 500 ids — one pawn named 150 times, Bob's pawn, the locked
//      one, Bob's face-down card, the face-down die, the other face-down
//      card, the crate, 44 ids that name nothing, then a free pawn at the
//      201st place and another pawn 299 times: capped (nothing past the
//      200th is looked at), deduplicated (the pawn moves once), skipped (one
//      notice counting the 51 distinct members of the first 200);
//   b) a roll of 500 ids: one roll of the two dice she sees, the face-down
//      die never rolled;
//   c) a flip and a remove of only what isn't hers: refused, nothing changes;
//   d) a burst of eight 500-id groups: each costs what 200 members cost
//      (1 + ⌊200/20⌋ = 11 of the 40-token burst), so 3 to 7 apply, not 1 (as
//      500 ids would) nor 8 (as one token would), and she is told to slow down.
// Then a recursive scan of every body she received (state, notes, …) and of
// Bob's: no face-down card's index, no hidden piece's type, face or side,
// none of the hidden types' words (they live only in the public catalog).
// Last, the watchdog in a real Worker: a script whose validate() spends 22 ms
// on each member of Bob's 200-member group (4.4 s in all, past a flat 4 s)
// is not stopped — the budget is 4000 + 10 ms × 200 — while one spending
// 400 ms on each of 20 members (8 s, past 4000 + 200) is, with the actor told
// and nothing of the group applied.
'use strict';
const h = require('./h');
const { ok, section } = h;
const { mallory } = require('./final-lib');
const { player, view, act, pidOf, until } = require('./p1-lib');

const J = JSON.stringify;
const ID = Object.fromEntries(['f1', 'f2', 'f9', 'b1', 'l1', 'crate', 'd1', 'd2', 'gem', 'pebble', 'c1', 'c2'].map((k, j) => [k, `ba5e20${j.toString(16).padStart(2, '0')}`]));
/** Words that only the public catalog may carry: the hidden types' names and faces, the face-down cards' names. */
const SECRET_WORDS = ['Qgemstone', 'Qruby', 'Qopal', 'Qjade', 'Qonyx', 'Qpebble', 'Qgrit', 'Qcrate', 'Qsalt', 'Qsilk', 'Qzephyr', 'Qlantern'];
const MUSTER = {
  name: 'Muster', imgs: [], lockable: 'anyone', table: { shape: 'rect', w: 3000, h: 2000 },
  backs: [{ id: 'tarp', color: '#3f3f46' }, { id: 'cup', color: '#7c2d12', label: '?' }],
  pieces: [
    { id: 'pawn', kind: 'token', w: 60, faces: ['P', 'p'] },
    { id: 'drill', kind: 'token', w: 40, faces: ['D'] },
    { id: 'crate', name: 'Qcrate', kind: 'tile', w: 80, back: 'tarp', faces: ['Qsalt', 'Qsilk'] },
    { id: 'd4', kind: 'die', faces: ['I', 'II', 'III', 'IV'] },
    { id: 'gem', name: 'Qgemstone', kind: 'die', back: 'cup', faces: ['Qruby', 'Qopal', 'Qjade', 'Qonyx'] },
    { id: 'pebble', name: 'Qpebble', kind: 'token', shape: 'rect', w: 56, stack: 'none', back: 'cup', faces: ['Qgrit'] },
  ],
  decks: [{ name: 'Omens', back: '#1e293b', imgs: [], cards: [{ n: 'Qzephyr crown' }, { n: 'Qlantern' }] }],
  setup: [
    ...[['f1', 300, 300], ['f2', 400, 300], ['f9', 600, 300], ['b1', 300, 500], ['l1', 400, 500]].map(([k, x, y]) => ({ piece: 'pawn', at: [x, y], id: ID[k], ...(k === 'l1' && { lock: true }) })),
    { piece: 'crate', at: [660, 800], up: false, id: ID.crate },
    { piece: 'd4', at: [2400, 300], id: ID.d1 },
    { piece: 'd4', at: [2480, 300], id: ID.d2 },
    { piece: 'gem', at: [2560, 300], up: false, id: ID.gem },
    { piece: 'pebble', at: [2640, 300], up: false, id: ID.pebble },
    { card: { deck: 'Omens', i: 0 }, up: false, at: [2700, 900], id: ID.c1 },
    { card: { deck: 'Omens', i: 1 }, up: false, at: [2820, 900], id: ID.c2 },
    { piece: 'drill', count: 200, spread: [12, 0], at: [100, 1700] },
  ],
};
/** n ids that name nothing on this table. */
const nothing = (n, tag = 0) => Array.from({ length: n }, (_, k) => `dead${tag}${k.toString(16).padStart(3, '0')}`);
/** Watches page p's #toast and keeps every text it shows (window.__toasts). */
const watchToasts = (p) => p.evaluate(() => {
  window.__toasts = [];
  new MutationObserver(() => { const t = document.getElementById('toast').textContent; if (t && window.__toasts.at(-1) !== t) window.__toasts.push(t); })
    .observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
});
const toastsOf = (p) => p.evaluate(() => window.__toasts.slice());
/** Every body raw peer M received, by channel, unwrapped from its signature envelope (the asset channel's bytes left out). */
const sawM = (M) => M.evaluate(() => Object.fromEntries(Object.entries(window.M.got).filter(([ch]) => ch !== 'asset').map(([ch, list]) => [ch, list.map(({ m }) => {
  try { return typeof m?.b === 'string' ? JSON.parse(m.b) : m; } catch (err) { console.error('an unreadable body', err); return m; }
})])));
/** What a scan of `bodies` finds that must stay hidden (§2d, §0.1 item 3):
 *  a face-down card's item with its index `i`; a hidden piece's item with
 *  `t`, `f` or `up`; a hidden type's ref (`<box>/gem`…); a secret word (with
 *  `words`: not for the public catalog's own channels). `seen` counts the
 *  hidden items' entries met, so a scan that sees nothing can't pass. */
function scan(bodies, box, words = true) {
  const found = [], refs = ['gem', 'pebble', 'crate'].map((t) => `${box}/${t}`), cards = [ID.c1, ID.c2], pieces = [ID.gem, ID.pebble, ID.crate];
  let seen = 0;
  const text = (s, at) => {
    if (refs.some((r) => s.includes(r))) found.push(`${at}: a hidden type "${s.slice(0, 60)}"`);
    if (words && SECRET_WORDS.some((w) => s.toLowerCase().includes(w.toLowerCase()))) found.push(`${at}: "${s.slice(0, 60)}"`);
  };
  const walk = (v, at) => {
    if (typeof v === 'string') return text(v, at);
    if (!v || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) return v.forEach((x, k) => walk(x, `${at}[${k}]`));
    for (const [k, x] of Object.entries(v)) {
      text(k, `${at} key`);
      if ((cards.includes(k) || pieces.includes(k)) && x && typeof x === 'object') {
        seen++;
        // (a hidden item that only moved travels as its new place, a patch's `pos` (D233): four numbers and an address — nothing else)
        if (Array.isArray(x)) { if (x.length > 5 || !x.slice(0, 4).every((v) => typeof v === 'number') || (x.length === 5 && typeof x[4] !== 'string')) found.push(`${at}.${k}: a place that says more (${J(x)})`); }
        else if (cards.includes(k) && 'i' in x) found.push(`${at}.${k}: a face-down card with its index (${J(x)})`);
        else if (pieces.includes(k) && ['t', 'f', 'up'].some((f) => f in x)) found.push(`${at}.${k}: a hidden piece shown (${J(x)})`);
      }
      walk(x, `${at}.${k}`);
    }
    return undefined;
  };
  walk(bodies, '');
  return { found, seen };
}

(async () => {
  const env = await h.start();
  const alice = await player(env, 'Alice', env.url);
  const bob = await player(env, 'Bob', alice.url());
  await bob.evaluate(() => { window.__rtc.keep = true; });
  for (const p of [alice, bob]) await watchToasts(p);
  const BOB = await pidOf(bob);
  const S = () => alice.evaluate(() => window.__ct.hostState());

  section('Alice sets up "Muster"; Bob is given a pawn and a face-down card; Mallory, a raw peer, sits down');
  const added = await act(alice, { t: 'addBox', box: MUSTER });
  await act(alice, { t: 'setup', box: added.id });
  for (const id of [ID.b1, ID.c1]) await act(alice, { t: 'owner', id, to: BOB });
  ok(await until(async () => { const v = await view(bob); return v.items[ID.b1]?.owner === BOB && v.items[ID.c1]?.owner === BOB && Object.keys(v.items).length === 212; }, 20000),
    `set up: 212 items on Bob's screen, his pawn and his card (box ${added.id})`);
  const M = await mallory(env, alice.url(), 2);
  await M.act({ t: 'chat', msg: 'hi all' }); // (she sits down: a seat, a name)
  await h.logHas(alice, 'Mallory');
  const st0 = await S(), xy = (st, k) => (st.items[k] ? [st.items[k].x, st.items[k].y] : null);
  const notesSince = async (n) => (await M.notes()).slice(n);
  ok(st0.players.ffffffffffffffff?.name === 'Mallory', 'Mallory is at the table');

  section('§4j case 8a: a move of 500 ids — capped at the first 200, each once, the members she may not move skipped, one notice');
  const ids = [...Array(150).fill(ID.f1), ID.b1, ID.l1, ID.c1, ID.gem, ID.c2, ID.crate, ...nothing(44), ID.f9, ...Array(299).fill(ID.f2)];
  let n0 = (await M.notes()).length;
  await M.act({ t: 'group', op: 'move', ids, dx: 0, dy: 60 });
  ok(await until(async () => (await notesSince(n0)).some((m) => /skipped/.test(m)), 10000), 'her notice came');
  const notes = await notesSince(n0), st1 = await S();
  ok(ids.length === 500 && J(xy(st1, ID.f1)) === J([300, 360]), `the pawn she named 150 times moved once, by 60 (${J(xy(st1, ID.f1))})`);
  ok([ID.gem, ID.c2, ID.crate].every((k) => J(xy(st1, k)) === J([st0.items[k].x, st0.items[k].y + 60])), 'the face-down die, the face-down card and the crate — no one\'s, unlocked — moved with it');
  ok([ID.b1, ID.l1, ID.c1, ID.f9, ID.f2].every((k) => J(st1.items[k]) === J(st0.items[k])), "Bob's pawn, the locked one, Bob's face-down card, the pawn at the 201st place and the one past it: untouched");
  ok(notes.length === 1 && /^47 of 51 were skipped: (?:🚫 )?That belongs to Bob$/u.test(notes[0]),
    `one notice: 51 distinct members in the first 200 ids, 47 of them skipped, the first reason the lowest one's (Bob's pawn), no "🚫" as some applied (${J(notes)})`);
  ok(st1.log.filter((e) => e.p === 'ffffffffffffffff' && /^moved /.test(e.txt)).map((e) => e.txt).join() === 'moved 4 items', `one line in her name: "moved 4 items" (${J(st1.log.slice(-3).map((e) => e.txt))})`);
  ok(st1.items[ID.c1].up === false && st1.items[ID.gem].up === false && st1.items[ID.crate].up === false, 'everything face down stays face down');

  section('§4j case 8b: a roll of 500 ids — one roll of the two dice she sees; the face-down die is no die to her, never rolled');
  const roll = [...Array(100).fill(ID.d1), ID.gem, ID.pebble, ID.f1, ID.d2, ...nothing(396, 1)];
  const logLen = st1.log.length;
  await M.act({ t: 'group', op: 'roll', ids: roll });
  ok(await until(async () => (await S()).log.slice(logLen).some((e) => /^rolled /.test(e.txt)), 10000), 'the roll is in the log');
  const st2 = await S(), lab = (k) => ['I', 'II', 'III', 'IV'][st2.items[k].f];
  const rolled = st2.log.slice(logLen).filter((e) => /^rolled /.test(e.txt));
  ok(rolled.length === 1 && rolled[0].p === 'ffffffffffffffff' && rolled[0].txt === `rolled 2 dice: ${lab(ID.d1)} · ${lab(ID.d2)}`, `one line in her name, the two dice in id order (${J(rolled.map((e) => e.txt))})`);
  ok(st2.items[ID.gem].f === st0.items[ID.gem].f && J(st2.items[ID.pebble]) === J(st0.items[ID.pebble]), 'the face-down die kept its face; the face-down token is untouched');

  section("§4j case 8c: a flip and a remove of only what isn't hers — refused, nothing changes");
  n0 = (await M.notes()).length;
  await M.act({ t: 'group', op: 'flip', ids: [ID.c1, ID.b1, ID.l1, ID.c1] });
  await M.act({ t: 'group', op: 'del', ids: [ID.b1, ID.c1, ID.l1, ...nothing(20, 2)] });
  ok(await until(async () => (await notesSince(n0)).length >= 2, 10000), 'two notices came');
  const st3 = await S(), refusals = await notesSince(n0);
  ok([ID.c1, ID.b1, ID.l1].every((k) => J(st3.items[k]) === J(st2.items[k])) && st3.items[ID.c1].up === false, "Bob's card still face down, his pawn and the locked one where they were");
  ok(refusals.length === 2 && /^🚫 3 of 3 were skipped: /.test(refusals[0]) && /^🚫 23 of 23 were skipped: /.test(refusals[1]),
    `each a refusal ("🚫"), counting the distinct members — the card named twice is one (${J(refusals)})`);

  section('§4j case 8d: a burst of eight 500-id groups — each costs 11 tokens of the 40-token burst (200 members, not 500), so 3 to 7 apply; she is told to slow down');
  await h.sleep(2500); // (her bucket refills: 20 tokens a second, 40 at most)
  n0 = (await M.notes()).length;
  const x0 = (await S()).items[ID.f2].x;
  await M.evaluate((g) => { for (let k = 0; k < 8; k++) window.M.act(g); }, { t: 'group', op: 'move', ids: [ID.f2, ...nothing(499, 3)], dx: 10, dy: 0 });
  await h.sleep(3000);
  const moved = ((await S()).items[ID.f2].x - x0) / 10, slow = await notesSince(n0);
  ok(moved >= 3 && moved <= 7, `${moved} of the 8 applied (3 at least: 500 ids cost what 200 do; 7 at most: a group isn't one token)`);
  ok(slow.includes('🚫 Too many actions — slow down'), `the rest refused by flood control (${J(slow.filter((m) => !/skipped/.test(m)))})`);

  section('nothing hidden in anything Mallory or Bob received: no face-down card\'s index, no hidden piece\'s type, face or side, no hidden word (§0.1 item 3, §2d)');
  // (one more broadcast for her: how many bodies the earlier ticks coalesced into varies with the load — 5 or 6 — and the check below wants 6)
  const b1 = (await S()).items[ID.b1];
  await act(bob, { t: 'move', id: ID.b1, x: b1.x + 10, y: b1.y });
  await until(async () => ((await sawM(M)).state || []).length > 5, 10000);
  await h.sleep(1500); // (the last broadcasts)
  const got = await sawM(M), box = added.id;
  const play = scan(Object.fromEntries(Object.entries(got).filter(([ch]) => ch !== 'boxes' && ch !== 'decks')), box);
  const cat = scan({ boxes: got.boxes, decks: got.decks }, box, false);
  ok((got.state || []).length > 5 && play.seen > 10, `the scan sees her bodies: ${(got.state || []).length} state, ${(got.note || []).length} notes, the hidden items met ${play.seen} times`);
  ok(!play.found.length, `Mallory: none (${play.found.slice(0, 5).join(' | ') || 'none'})`);
  ok(!cat.found.length && SECRET_WORDS.some((w) => J(got.boxes).includes(w)), "the catalog she got names the hidden types (it is public, §2d) but holds no item's identity");
  const bodies = await bob.evaluate(() => window.__rtc.bodies.map((b) => b.body)), bs = scan({ bodies, log: await bob.evaluate(() => window.__ct.log()) }, box);
  ok(bodies.length > 5 && bs.seen > 10 && !bs.found.length, `Bob's ${bodies.length} state bodies and his log: none (${bs.found.slice(0, 5).join(' | ') || 'none'})`);

  section("the watchdog's budget for a group, in a real Worker: 4000 + 10 ms × N (§3f.5, §4c, D219)");
  const SLOW = `({ name: 'Slow quartermaster',
    validate(t, a) {
      if (a.t !== 'move' || !a.group) return;
      const ms = a.group >= 100 ? 22 : 400, t0 = Date.now();
      while (Date.now() - t0 < ms);
    },
  })`;
  await h.enableRules(alice, { code: SLOW });
  ok(await until(async () => (await S()).rules?.enabled && (await alice.evaluate(() => window.__ct.jobs())) === 0, 15000), 'Alice enabled the slow script');
  const drills = Object.entries((await S()).items).filter(([, it]) => /\/drill$/.test(it.t)).map(([k]) => k);
  const tA = (await toastsOf(alice)).length, tB = (await toastsOf(bob)).length;
  let t0 = Date.now();
  await act(bob, { t: 'group', op: 'move', ids: drills, dx: 0, dy: -100 });
  ok(await until(async () => { const st = await S(); return !st.rules.enabled || drills.every((k) => st.items[k].y === 1600); }, 20000), 'the 200-member group came back');
  const took = Date.now() - t0, st4 = await S(), ms = await alice.evaluate(() => window.__ct.perf.lastRulesWorkerMs);
  ok(drills.every((k) => st4.items[k].y === 1600) && st4.rules.enabled, `Bob's 200 drill pawns moved, the rules still on, after ${took} ms`);
  ok(ms > 4000, `the Worker spent ${Math.round(ms)} ms on it — past a flat 4 s budget, within 4000 + 10 × 200`);
  ok(!(await toastsOf(alice)).slice(tA).some((m) => /Rules stopped/.test(m)) && !(await toastsOf(bob)).slice(tB).some((m) => /stopped responding/.test(m)), 'no watchdog stop, no one told of one');
  const twenty = drills.slice(0, 20);
  t0 = Date.now();
  await act(bob, { t: 'group', op: 'move', ids: twenty, dx: 0, dy: -100 });
  ok(await until(async () => !(await S()).rules.enabled, 15000, 100), 'the 20-member group, 8 s of validate(): the watchdog stopped the rules');
  const stopped = Date.now() - t0, st5 = await S();
  ok(stopped >= 4000 && stopped < 7900, `stopped ${stopped} ms after Bob sent it: after its budget (4000 + 10 × 20), before the job could end`);
  ok(twenty.every((k) => st5.items[k].y === 1600), 'none of the 20 moved: the job was dropped whole');
  // (the stop names the limit this job had, 4000 + 10 × 20 ms: a flat "4 seconds" would mislead)
  ok(await until(async () => (await toastsOf(alice)).slice(tA).includes("Rules stopped — the script didn't answer within 4.2 seconds"), 5000), "Alice's toast: \"Rules stopped — the script didn't answer within 4.2 seconds\"");
  ok(await until(async () => (await toastsOf(bob)).slice(tB).includes('🚫 The rules stopped responding — your action was not applied'), 5000), 'Bob is told his action was not applied');
  await env.done();
})().catch(h.crash);
