// Phase 5, the terminal's private material (spec §5i; D267), written from
// the spec apart from the implementation's own t-p5-cli.js. Real tabs: Alice
// hosts with cli.py, Bob is a guest with cli.js, on an original box
// ("Cubby": two dice under a cup back, a tile with a back, a coin with
// none). What each REPL's tab hands it (its snapshot: the /state it posts) is
// read as the bridge reads it.
//   1  Alice's `hide <id…>`: in her snapshot the dice keep their full fields
//      and carry hiddenFromOthers: true; in Bob's each is {kind: 'hidden'}
//      with its place and owner alone — no type, ref, face or label of it
//      anywhere in his snapshot.
//   2  Bob's `peek <id>` of one: answered in his snapshot's msgs as a
//      "peek: …" naming its face, in his REPL alone; the host's log says he
//      peeked; Alice's `peek` of her own die is answered at once, with no line.
//   3  Alice's `reveal <id>`: face up for both; the die is no longer hers.
//   4  Bob's `hide` of the tile (his own: hiddenFromOthers in his, hidden in
//      Alice's), her peek at it, his `reveal`; his `hide` of the coin (no
//      back): refused, said in his msgs.
//   5  The Bridge API's hide(*ids) in both languages (a fake tab): one hide action.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const { player, act, until } = require('./p1-lib');
const { LANGS, killAll, repl, json, api, viaApi } = require('./cli-lib');
const V = require('./p5v-lib');
const { boxFromDef } = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

const ID = { d1: 'c5b1a001', d2: 'c5b1a002', tile: 'c5b1a003', coin: 'c5b1a004' };
/** "Cubby" (original): every hidden face carries a token found nowhere else (Kd…, Kt…). */
const DEF = {
  name: 'Cubby', table: { shape: 'rect', w: 1600, h: 1000 },
  backs: [{ id: 'cup', color: '#7c2d12', label: '?' }, { id: 'tb', color: '#334155' }],
  pieces: [
    { id: 'kdie', kind: 'die', back: 'cup', faces: [1, 2, 3, 4, 5, 6].map((k) => ({ label: `Kd${k}`, text: `Kd-side-${k}` })) },
    { id: 'ktile', kind: 'tile', w: 60, h: 120, back: 'tb', stack: 'none', faces: [{ pips: [2, 5], name: 'Kt25', text: 'Kt-two-five' }] },
    { id: 'coin', kind: 'token', faces: ['C'] },
  ],
  setup: [
    { piece: 'kdie', at: [400, 300], id: ID.d1 }, { piece: 'kdie', at: [900, 300], f: 3, id: ID.d2 },
    { piece: 'ktile', at: [600, 600], id: ID.tile }, { piece: 'coin', at: [1000, 620], id: ID.coin },
  ],
};
const TOKENS = [...DEF.pieces[0].faces.flatMap((f) => [f.label, f.text]), 'Kt25', 'Kt-two-five', 'pips'];

(async () => {
  const env = await h.start();
  const alice = await player(env, 'Alice', env.url), bob = await player(env, 'Bob', alice.url());
  const invite = await alice.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const snaps = {}, R = {};
  for (const [page, name, lang] of [[alice, 'Alice', 'python'], [bob, 'Bob', 'node']]) {
    // (the tab posts its snapshot to the bridge: kept here as the bridge reads it)
    await page.route(/127\.0\.0\.1:\d+\/state\?/, (route) => {
      snaps[name] = route.request().postData();
      route.continue().catch((err) => console.error('route.continue failed', err.message));
    });
    R[name] = await repl(lang, invite);
    await page.goto(R[name].url);
    await page.reload(); // (a hash change alone doesn't boot again)
    await page.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await until(() => R[name].c.buf.includes(`tab connected: ${name}`), 20000, 200), `${lang}: ${name}'s tab is connected to its REPL`);
  }
  const snap = (name) => { try { return JSON.parse(snaps[name] || 'null'); } catch (err) { console.error('an unreadable snapshot', err); return null; } };
  const item = (name, id) => snap(name)?.items.find((x) => x.id === id);
  const S = () => alice.evaluate(() => window.__ct.hostState());
  /** The lines REPL `name` printed after buffer offset `from` that match `re` (its prompts stripped). */
  const printed = (name, from, re) => R[name].c.buf.slice(from).split('\n').map((l) => l.replace(/^(?:🂡 > )+/, '')).filter((l) => re.test(l));
  const mark = () => ({ Alice: R.Alice.c.buf.length, Bob: R.Bob.c.buf.length });
  const type = (name, line) => R[name].c.stdin.write(line + '\n');

  ok((await act(alice, { t: 'loadBox', box: boxFromDef(DEF), setup: true, clear: true })).ok, 'the host sets «Cubby» up');
  ok(await until(() => snap('Bob')?.items.length === 4 && item('Alice', ID.d1)?.kind === 'die', 20000, 200), `both snapshots hold the four items (${snap('Bob')?.items.length})`);
  const box = (await S()).lastSetup, refs = DEF.pieces.map((p) => `${box}/${p.id}`);

  section("1 Alice's `hide`: her snapshot holds the dice whole with hiddenFromOthers; Bob's {kind: 'hidden'}");
  let from = mark();
  type('Alice', `hide ${ID.d1} ${ID.d2}`);
  ok(await until(() => item('Bob', ID.d1)?.kind === 'hidden' && item('Bob', ID.d2)?.kind === 'hidden' && item('Alice', ID.d2)?.hiddenFromOthers === true, 15000, 100), 'the dice hidden from Bob, hers to see');
  let st = await S();
  ok(st.items[ID.d1].up === false && json(st.items[ID.d1].vis) === json([Object.keys(st.players).find((q) => st.players[q].name === 'Alice')]), `the host: up false, vis [Alice] (${json(st.items[ID.d1])})`);
  const a1 = item('Alice', ID.d1), b1 = item('Bob', ID.d1);
  ok(a1.kind === 'die' && a1.face === st.items[ID.d1].f && a1.label === `Kd${st.items[ID.d1].f + 1}` && a1.hiddenFromOthers === true && a1.typeRef === refs[0],
    `Alice's: the die in full — kind, face, label, its type — and hiddenFromOthers: true (§5i) (${json(a1)})`);
  ok(json(Object.keys(b1).sort()) === json(['id', 'kind', 'owner', 'x', 'y']) && b1.kind === 'hidden', `Bob's: {kind: 'hidden'}, its place and owner alone (§5i, as in Phase 2) (${json(b1)})`);
  let leak = V.scan(snap('Bob').items, [...TOKENS.filter((t) => t.startsWith('Kd')), refs[0], 'hiddenFromOthers']);
  ok(!leak.length, `no face, label or type ref of the dice anywhere in Bob's items ${json(leak.slice(0, 3))}`);
  ok(await until(() => printed('Bob', from.Bob, /Alice hid 2 pieces/).length === 1, 10000, 100), 'his REPL prints "Alice hid 2 pieces"');
  type('Alice', 'table');
  ok(await until(() => printed('Alice', from.Alice, new RegExp(`\\[${ID.d1}\\].*🙈 hidden from others`)).length >= 1, 10000, 100), `her "table" marks her die "🙈 hidden from others" (${json(printed('Alice', from.Alice, new RegExp(ID.d1)))})`);

  section("2 peeks: Bob's at a cupped die — in his msgs alone, on the record; Alice's at her own — at once, no line");
  from = mark();
  type('Bob', `peek ${ID.d1}`);
  const face = `Kd${st.items[ID.d1].f + 1}`;
  ok(await until(() => (snap('Bob')?.msgs || []).some((m) => m.startsWith('peek: ') && m.includes(face)), 15000, 100), `Bob's snapshot: msgs gains "peek: …" naming the face ${face} (§5i, D267) (${json((snap('Bob')?.msgs || []).filter((m) => m.startsWith('peek')))})`);
  ok(await until(() => printed('Bob', from.Bob, new RegExp(`peek: ${face}`)).length === 1, 10000, 100), `his REPL prints it (${json(printed('Bob', from.Bob, /peek/))})`);
  ok(await until(() => printed('Alice', from.Alice, /Bob peeked at a hidden piece/).length === 1, 10000, 100), "Alice's REPL: \"Bob peeked at a hidden piece\"");
  ok(!(snap('Alice')?.msgs || []).some((m) => m.startsWith('peek')) && !printed('Alice', from.Alice, new RegExp(face)).length, "…and never the face: no peek in Alice's msgs");
  ok(item('Bob', ID.d1).kind === 'hidden', "Bob's snapshot still holds the die hidden: a peek is one message");
  from = mark();
  type('Alice', `peek ${ID.d2}`);
  const face2 = `Kd${st.items[ID.d2].f + 1}`;
  ok(await until(() => printed('Alice', from.Alice, new RegExp(`peek: ${face2}`)).length === 1, 10000, 100), `Alice's peek at her own die: "${face2}" at once`);
  await h.sleep(1000);
  ok(!printed('Bob', from.Bob, /peeked/).length, '…with no line (she can see it already: §5c)');

  section('3 `reveal`: face up for both, no longer hers');
  type('Alice', `reveal ${ID.d1}`);
  ok(await until(() => item('Bob', ID.d1)?.kind === 'die' && item('Bob', ID.d1)?.face === st.items[ID.d1].f && item('Bob', ID.d1)?.label === face, 15000, 100), `Bob's snapshot shows its face ${face} (${json(item('Bob', ID.d1))})`);
  ok(!item('Alice', ID.d1)?.hiddenFromOthers && !item('Alice', ID.d1)?.owner, `Alice's: no hiddenFromOthers, no owner the cup gave (${json(item('Alice', ID.d1))})`);
  st = await S();
  ok(st.items[ID.d1].up !== false && !st.items[ID.d1].vis && !st.items[ID.d1].po, `the host: face up, no vis, no po (${json(st.items[ID.d1])})`);

  section("4 Bob's `hide` of the tile, Alice's peek, his `reveal`; his `hide` of the coin refused");
  from = mark();
  type('Bob', `hide ${ID.tile}`);
  ok(await until(() => item('Alice', ID.tile)?.kind === 'hidden' && item('Bob', ID.tile)?.hiddenFromOthers === true, 15000, 100), "the tile Bob's alone: hiddenFromOthers in his snapshot, {kind: 'hidden'} in Alice's");
  leak = V.scan(snap('Alice').items, ['Kt25', 'Kt-two-five', refs[1], 'pips']);
  ok(!leak.length, `no pips, name or type ref of it in Alice's items ${json(leak.slice(0, 3))}`);
  type('Alice', `peek ${ID.tile}`);
  ok(await until(() => (snap('Alice')?.msgs || []).some((m) => m.startsWith('peek: ') && /Kt25|2\|5/.test(m)), 15000, 100),
    `Alice's peek at Bob's tile: in her msgs (${json((snap('Alice')?.msgs || []).filter((m) => m.startsWith('peek')))})`);
  ok(await until(() => printed('Bob', from.Bob, /Alice peeked at a hidden piece/).length === 1, 10000, 100), "Bob's REPL: \"Alice peeked at a hidden piece\"");
  type('Bob', `reveal ${ID.tile}`);
  ok(await until(() => item('Alice', ID.tile)?.kind === 'tile', 15000, 100), `Bob's reveal: the tile face up in Alice's snapshot (${json(item('Alice', ID.tile))})`);
  from = mark();
  type('Bob', `hide ${ID.coin}`);
  ok(await until(() => (snap('Bob')?.msgs || []).some((m) => m === 'note: 🚫 That piece has no hidden side'), 10000, 100), `his hide of the coin is refused, said in his msgs (${json((snap('Bob')?.msgs || []).slice(-2))})`);
  st = await S();
  ok(st.items[ID.coin].up !== false && !st.items[ID.coin].vis, 'the coin as it was');
  const lb = V.scan(snap('Bob').items.filter((x) => x.id === ID.d2), [...TOKENS.filter((t) => t.startsWith('Kd')), refs[0]]);
  ok(item('Bob', ID.d2)?.kind === 'hidden' && !lb.length, `Alice's other die, still cupped, is {kind: 'hidden'} in Bob's snapshot to the end (${json(item('Bob', ID.d2))})`);

  section('5 the Bridge API: hide(*ids) — one hide action, in both languages');
  const apis = await Promise.all(LANGS.map(api));
  const got = await Promise.all(apis.map((b) => viaApi(b, [['hide', 'aa01', 'aa02'], ['hide', 'aa03']])));
  for (const [k, b] of apis.entries()) {
    ok(json(got[k]) === json([{ t: 'hide', ids: ['aa01', 'aa02'] }, { t: 'hide', ids: ['aa03'] }]), `${b.lang}: hide('aa01', 'aa02') and hide('aa03') send ${json(got[k])}`);
  }
  killAll();
  await env.done();
})().catch((e) => { killAll(); h.crash(e); });
