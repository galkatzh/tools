// Phase 5, the terminal bridges (spec §5i): cli.js and cli.py in parity.
// To a fake tab: `hide <id…>`, `reveal <id>`, `peek <id>` and `group hide
// <id,id,…>` send exactly their commands from both REPLs; a line without an
// id prints the same usage in both and sends nothing; both helps list hide
// and reveal word for word alike; `table` marks a piece hidden from the
// others ("🙈 hidden from others") in the same words; the Bridge API's
// hide(...ids) / hide(*ids) and reveal(id). Then real tabs, Alice hosting on
// cli.js and Bob a guest on cli.py, on an original box ("Cupboard"): Alice's
// `hide` cups two dice — her snapshot's items carry hiddenFromOthers and
// their full fields, Bob's are {kind: 'hidden'}; Bob's `peek` of one answers
// "peek: <face> <type>" in his REPL alone and is logged, Alice's of her own
// is said at once with no line; `reveal` turns one face up for both, and
// again says it is not face down; Bob's `hide` of a piece with no back is
// refused, his `group hide` of a tile and the coin skips the coin.
'use strict';
const h = require('./h');
const { ok, section } = h;
const { player, act, until } = require('./p1-lib');
const { LANGS, killAll, repl, type, push, sent, json, eq, api, viaApi } = require('./cli-lib');

const FAKE = {
  pid: 'p1', name: 'Fake', role: 'guest', room: 'r', seq: 1, table: { shape: 'rect', w: 2400, h: 1600 }, seats: null, me: { seat: 90 },
  players: [], buttons: [], log: [], msgs: [], hand: [], asks: [], hint: null, secret: null, strict: false, boxes: [], lastSetup: null,
  items: [
    { id: 'aa01', kind: 'die', type: 'Die', typeRef: 'b/d6', face: 2, label: '3', x: 100, y: 200, owner: 'Fake', hiddenFromOthers: true },
    { id: 'aa02', kind: 'hidden', x: 300, y: 200, owner: 'Bob' },
  ],
};
/** Each REPL line and exactly what it must send (§5i). */
const LINES = [
  ['hide aa01', { t: 'hide', ids: ['aa01'] }],
  ['hide aa01 aa02 aa03', { t: 'hide', ids: ['aa01', 'aa02', 'aa03'] }],
  ['reveal aa01', { t: 'reveal', id: 'aa01' }],
  ['peek aa02', { t: 'peek', id: 'aa02' }],
  ['group hide aa01,aa02', { t: 'group', op: 'hide', ids: ['aa01', 'aa02'] }],
];
const API = [
  [['hide', 'aa01', 'aa02'], { t: 'hide', ids: ['aa01', 'aa02'] }],
  [['hide', 'aa03'], { t: 'hide', ids: ['aa03'] }],
  [['reveal', 'aa01'], { t: 'reveal', id: 'aa01' }],
];
/** "Cupboard", an original test box: dice under a cup back, tiles with a back, a coin with none. */
const ID = Object.fromEntries(['d1', 'd2', 'k1', 'k2', 'coin'].map((k, j) => [k, `c0c0${j.toString(16).padStart(4, '0')}`]));
const CUPBOARD = {
  name: 'Cupboard', imgs: [], table: { shape: 'rect', w: 2400, h: 1600 },
  backs: [{ id: 'cup', color: '#7c2d12', label: '?' }, { id: 'tb', color: '#334155' }],
  pieces: [
    { id: 'd6', kind: 'die', back: 'cup', faces: ['one', 'two', 'three', 'four', 'five', 'six'] },
    { id: 'tile', kind: 'tile', w: 60, h: 120, back: 'tb', faces: [{ pips: [2, 5] }] },
    { id: 'coin', kind: 'token', faces: ['C'] },
  ],
  setup: [
    { piece: 'd6', at: [500, 300], id: ID.d1 }, { piece: 'd6', at: [1500, 300], id: ID.d2 },
    { piece: 'tile', at: [500, 800], id: ID.k1 }, { piece: 'tile', at: [700, 800], id: ID.k2 },
    { piece: 'coin', at: [1000, 800], id: ID.coin },
  ],
};

(async () => {
  const env = await h.start();

  section('to a fake tab: hide, reveal, peek and group hide send exactly their commands from both REPLs; the same usage, help and table line');
  const fakes = await Promise.all(LANGS.map((l) => repl(l, 'http://x/#room~ab~cd')));
  for (const b of fakes) {
    await push(b, FAKE);
    ok(await until(() => b.c.buf.includes('tab connected'), 5000, 100), `${b.lang}: the fake tab is connected`);
  }
  for (const [line, want] of LINES) {
    const got = await Promise.all(fakes.map((b) => sent(b, () => b.c.stdin.write(line + '\n'))));
    ok(got.every((g) => g?.length === 1 && eq(g[0], want)), `"${line}" sends ${json(want)} from both (${got.map(json).join(' / ')})`);
  }
  const marks = fakes.map((b) => b.c.buf.length);
  const after = await Promise.all(fakes.map((b) => sent(b, () => { b.c.stdin.write('hide\n'); b.c.stdin.write('reveal\n'); b.c.stdin.write('reveal aa09\n'); })));
  ok(after.every((g) => g?.length === 1 && eq(g[0], { t: 'reveal', id: 'aa09' })), `"hide" and "reveal" with no id send nothing: only the good line after them arrives (${after.map(json).join(' / ')})`);
  const said = fakes.map((b, k) => b.c.buf.slice(marks[k]).split('\n').map((l) => l.replace(/^(?:🂡 > )+/, '').trim()).filter((l) => /hide <id\.\.\.>|reveal <id>/.test(l)));
  ok(said.every((u) => u.length === 2) && json(said[0].map((l) => l.replace(/^\S+ /, ''))) === json(said[1].map((l) => l.replace(/^\S+ /, ''))), `each prints the usages, alike in both (${json(said)})`);
  const help = await Promise.all(fakes.map((b) => type(b, 'help', (ls) => ls.some((l) => l.startsWith('  quit')))));
  const lines = help.map((ls) => ls.filter((l) => /^ {2}(hide|reveal|flip\|peek\|tohand|group) /.test(l)));
  ok(lines.every((ls) => ls.length === 4) && json(lines[0]) === json(lines[1]), `both helps list hide, reveal, peek (a hidden piece) and group … hide, alike: ${json(lines[0])}`);
  const tables = await Promise.all(fakes.map((b) => type(b, 'table', (ls) => ls.some((l) => l.startsWith('  [aa02]')))));
  const rows = tables.map((ls) => ls.filter((l) => l.startsWith('  [aa0')));
  ok(json(rows[0]) === json(rows[1]) && rows[0][0] === '  [aa01] 3 Die (die) @100,200 owner:Fake 🙈 hidden from others' && rows[0][1] === '  [aa02] hidden piece @300,200 owner:Bob',
    `"table" marks the piece only you see, in the same words in both (${json(rows[0])})`);

  section('the Bridge API: hide(...ids) / hide(*ids), reveal(id)');
  const apis = await Promise.all(LANGS.map(api));
  const got = await Promise.all(apis.map((b) => viaApi(b, API.map(([c]) => c))));
  for (const [k, [[call, ...args], want]] of API.entries()) {
    ok(got.every((g) => eq(g?.[k], want)), `${call}(${args.map(json).join(', ')}) sends ${json(want)} from both (${got.map((g) => json(g?.[k])).join(' / ')})`);
  }

  section('real tabs: Alice (host) on cli.js, Bob (guest) on cli.py; "Cupboard" set up');
  const alice = await player(env, 'Alice', env.url), bob = await player(env, 'Bob', alice.url());
  const invite = await alice.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const snaps = {}, R = {};
  for (const [page, name, lang] of [[alice, 'Alice', 'node'], [bob, 'Bob', 'python']]) {
    await page.route(/127\.0\.0\.1:\d+\/state\?/, (route) => {
      snaps[name] = route.request().postData();
      route.continue().catch((err) => console.error('route.continue failed', err.message));
    });
    R[name] = await repl(lang, invite);
    await page.goto(R[name].url);
    await page.reload(); // (a hash change alone doesn't boot again)
    await page.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await until(() => R[name].c.buf.includes(`tab connected: ${name}`), 20000, 200), `${lang}: ${name}'s tab is connected`);
  }
  const snap = (name) => { try { return JSON.parse(snaps[name] || 'null'); } catch (err) { console.error('an unreadable snapshot', err); return null; } };
  const item = (name, id) => snap(name)?.items.find((x) => x.id === id);
  const added = await act(alice, { t: 'addBox', box: CUPBOARD });
  await act(alice, { t: 'setup', box: added.id });
  ok(await until(() => snap('Bob')?.items.length === 5 && item('Alice', ID.d1)?.kind === 'die', 20000, 200), `set up: 5 items in both snapshots (${snap('Bob')?.items.length})`);
  const S = () => alice.evaluate(() => window.__ct.hostState());
  /** The lines REPL `name` printed after buffer offset `from` that match `re` (prompts stripped). */
  const printed = (name, from, re) => R[name].c.buf.slice(from).split('\n').map((l) => l.replace(/^(?:🂡 > )+/, '')).filter((l) => re.test(l));

  section("Alice's `hide`: her snapshot holds the dice whole and hiddenFromOthers, Bob's {kind: 'hidden'}");
  let from = { Alice: R.Alice.c.buf.length, Bob: R.Bob.c.buf.length };
  R.Alice.c.stdin.write(`hide ${ID.d1} ${ID.d2}\n`);
  ok(await until(() => printed('Bob', from.Bob, /▸ Alice hid 2 pieces$/).length === 1, 15000, 100), 'one line, "Alice hid 2 pieces", in both REPLs');
  ok(await until(() => item('Bob', ID.d1)?.kind === 'hidden' && item('Alice', ID.d1)?.hiddenFromOthers === true, 10000, 100), 'the dice hidden from Bob, Alice\'s to see');
  let st = await S();
  const [a1, b1] = [item('Alice', ID.d1), item('Bob', ID.d1)];
  ok(a1.kind === 'die' && a1.type === 'd6' && a1.face === st.items[ID.d1].f && a1.label === CUPBOARD.pieces[0].faces[st.items[ID.d1].f] && a1.owner === 'Alice',
    `Alice's snapshot: the die in full — kind, type, face, label — owned by her through the cup (${json(a1)})`);
  ok(eq(Object.keys(b1).sort(), ['id', 'kind', 'owner', 'x', 'y']) && !json(snap('Bob')).includes('"hiddenFromOthers"'), `Bob's: {kind: 'hidden'}, its place and owner, nothing more (${json(b1)})`);
  const rows2 = await type(R.Alice, 'table', (ls) => ls.some((l) => l.startsWith(`  [${ID.d2}]`)));
  ok(rows2.find((l) => l.startsWith(`  [${ID.d1}]`))?.endsWith('owner:Alice 🙈 hidden from others'), `Alice's "table": ${json(rows2.find((l) => l.startsWith(`  [${ID.d1}]`)))}`);

  section("peeks: Bob's at a cupped die is answered to him alone, on the record; Alice's of her own is said at once");
  from = { Alice: R.Alice.c.buf.length, Bob: R.Bob.c.buf.length };
  R.Bob.c.stdin.write(`peek ${ID.d1}\n`);
  const face = CUPBOARD.pieces[0].faces[st.items[ID.d1].f];
  ok(await until(() => printed('Bob', from.Bob, new RegExp(`✉ peek: ${face} d6$`)).length === 1, 15000, 100), `Bob's REPL: "✉ peek: ${face} d6"`);
  ok(await until(() => printed('Alice', from.Alice, /▸ Bob peeked at a hidden piece$/).length === 1, 10000, 100) && !printed('Alice', from.Alice, /✉ peek/).length, "Alice's REPL: the line, never the face");
  from.Alice = R.Alice.c.buf.length;
  R.Alice.c.stdin.write(`peek ${ID.d2}\n`);
  const face2 = CUPBOARD.pieces[0].faces[st.items[ID.d2].f];
  ok(await until(() => printed('Alice', from.Alice, new RegExp(`✉ peek: ${face2} d6$`)).length === 1, 10000, 100), `Alice's own die: "✉ peek: ${face2} d6" at once`);
  await h.sleep(800);
  ok(!printed('Alice', from.Alice, /peeked/).length, '…with no line in the log');

  section('`reveal`: face up for both; a second one is said in the terminal');
  from = { Alice: R.Alice.c.buf.length, Bob: R.Bob.c.buf.length };
  R.Alice.c.stdin.write(`reveal ${ID.d1}\n`);
  ok(await until(() => item('Bob', ID.d1)?.kind === 'die' && item('Bob', ID.d1)?.face === st.items[ID.d1].f && !item('Alice', ID.d1)?.hiddenFromOthers, 15000, 100), `revealed: Bob's snapshot shows its face (${json(item('Bob', ID.d1))})`);
  ok(!(await S()).items[ID.d1].owner, 'its owner from the cup gone');
  const again = await type(R.Alice, `reveal ${ID.d1}`, (ls) => ls.some((l) => /✉ error: reveal/.test(l)), 5000);
  ok(again.some((l) => l.endsWith(`✉ error: reveal ${ID.d1}: it is not face down`)), `a second reveal: ${json(again.filter((l) => /✉/.test(l)))}`);

  section("Bob's `hide` of the coin (no back) is refused; his `group hide` of a tile and the coin skips the coin");
  const no = await type(R.Bob, `hide ${ID.coin}`, (ls) => ls.some((l) => /✉ note: 🚫 That piece has no hidden side/.test(l)), 8000);
  ok(no.some((l) => l.endsWith('✉ note: 🚫 That piece has no hidden side')), `"hide <coin>": ${json(no.filter((l) => /✉/.test(l)))}`);
  from = { Alice: R.Alice.c.buf.length, Bob: R.Bob.c.buf.length };
  R.Bob.c.stdin.write(`group hide ${ID.k1},${ID.coin}\n`);
  ok(await until(() => printed('Alice', from.Alice, /▸ Bob hid 1 piece$/).length === 1, 15000, 100), `one line in Alice's REPL, "Bob hid 1 piece" (${json(printed('Alice', from.Alice, /▸ Bob/))})`);
  ok(await until(() => printed('Bob', from.Bob, /✉ note: 1 of 2 was skipped: That piece has no hidden side$/).length === 1, 10000, 100), `the skip said once in Bob's REPL (${json(printed('Bob', from.Bob, /✉/))})`);
  st = await S();
  ok(st.items[ID.k1].up === false && st.items[ID.k1].vis?.length === 1 && st.items[ID.coin].up !== false && item('Alice', ID.k1)?.kind === 'hidden' && item('Bob', ID.k1)?.hiddenFromOthers, "the tile Bob's alone; the coin as it was");
  ok(eq(Object.keys(item('Bob', ID.d2)).sort(), ['id', 'kind', 'owner', 'x', 'y']) && item('Bob', ID.d2).kind === 'hidden', `Alice's die still cupped: Bob's snapshot holds its place and owner alone (${json(item('Bob', ID.d2))})`);
  killAll();
  await env.done();
})().catch((e) => { killAll(); h.crash(e); });
