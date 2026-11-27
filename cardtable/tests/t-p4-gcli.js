// Phase 4B, the terminal's `group` (spec §4i, D224) in cli.js and cli.py, in
// parity, written from the spec rather than from either bridge: `group <op>
// <id,id,…> [dx dy | deg | bag]` — op move dx dy, rot deg, flip, roll, lock,
// unlock, del, bag <bag> — and the Bridge API's group(op, ids, kw) (cli.js,
// kw an object) / group(op, ids, **kw) (cli.py) both send {t: 'group', op,
// ids, ...kw}. To a fake tab: every form sends exactly that from both REPLs
// and both APIs; a malformed line prints the same usage in both and sends
// nothing; both helps list it alike. Then real tabs — Alice hosting on
// cli.js, Bob a guest on cli.py — on an original test box ("Drill"): each op
// typed in a terminal is one action on the table, its one log line printed
// in both REPLs, the members one may not handle skipped and said once in the
// sender's REPL (§4c), a bag named by its name, an unknown op said in the
// terminal.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const { player, act, pidOf, until } = require('./p1-lib');
const { APP, LANGS, child, killAll, repl, type, push, sent, json, eq } = require('./cli-lib');

const FAKE = {
  pid: 'p1', name: 'Fake', role: 'guest', room: 'r', seq: 1, table: { shape: 'rect', w: 2400, h: 1600 }, seats: null, me: { seat: 90 },
  players: [], buttons: [], log: [], msgs: [], hand: [], items: [], asks: [], hint: null, secret: null, strict: false, boxes: [], lastSetup: null,
};
const USAGE = 'group <op> <id,id,…> [dx dy | deg | bag]';
/** Each REPL line and exactly what it must send (§4i, D224: the op as typed, the ids split at commas, dx dy / deg / bag as kw). */
const LINES = [
  ['group move ab01,ab02,ab03 120 -40', { t: 'group', op: 'move', ids: ['ab01', 'ab02', 'ab03'], dx: 120, dy: -40 }],
  ['group move ab01 0.5 7', { t: 'group', op: 'move', ids: ['ab01'], dx: 0.5, dy: 7 }],
  ['group rot ab01,ab02 -45', { t: 'group', op: 'rot', ids: ['ab01', 'ab02'], deg: -45 }],
  ['group flip ab01,ab02', { t: 'group', op: 'flip', ids: ['ab01', 'ab02'] }],
  ['group roll d1,d2,d3', { t: 'group', op: 'roll', ids: ['d1', 'd2', 'd3'] }],
  ['group lock ab01,ab02', { t: 'group', op: 'lock', ids: ['ab01', 'ab02'] }],
  ['group unlock ab01', { t: 'group', op: 'unlock', ids: ['ab01'] }],
  ['group del ab01,ab02', { t: 'group', op: 'del', ids: ['ab01', 'ab02'] }],
  ['group bag ab01,ab02 Old Sack', { t: 'group', op: 'bag', ids: ['ab01', 'ab02'], bag: 'Old Sack' }],
];
/** Lines a REPL must refuse with the usage, sending nothing. */
const BAD = ['group', 'group move', 'group move ab01', 'group move ab01 5', 'group move ab01 x 5', 'group rot ab01', 'group rot ab01 1 2', 'group bag ab01'];
/** Bridge API calls ([op, ids, kw]) and what each must send. */
const CALLS = [
  [['move', ['ab01', 'ab02'], { dx: 30, dy: -40 }], { t: 'group', op: 'move', ids: ['ab01', 'ab02'], dx: 30, dy: -40 }],
  [['rot', ['ab01'], { deg: 60 }], { t: 'group', op: 'rot', ids: ['ab01'], deg: 60 }],
  [['flip', ['ab01', 'ab02', 'ab03']], { t: 'group', op: 'flip', ids: ['ab01', 'ab02', 'ab03'] }],
  [['roll', ['d1', 'd2']], { t: 'group', op: 'roll', ids: ['d1', 'd2'] }],
  [['unlock', ['ab01']], { t: 'group', op: 'unlock', ids: ['ab01'] }],
  [['bag', ['ab01'], { bag: 'Sack' }], { t: 'group', op: 'bag', ids: ['ab01'], bag: 'Sack' }],
];
// Bridge API drivers that also pass keyword arguments: {call, args, kw} → b[call](...args, kw) / getattr(b, call)(*args, **kw).
const NODE_KW = `
const { Bridge } = require(${json(path.join(APP, 'cli.js'))});
(async () => {
  const b = await new Bridge().ready;
  console.log('READY', b.port, b.token);
  require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const c = JSON.parse(l); b[c.call](...c.args, ...(c.kw ? [c.kw] : [])); });
})();`;
const PY_KW = `
import json, sys
sys.path.insert(0, ${json(APP)})
from cli import Bridge
b = Bridge()
print('READY', b.port, b.token, flush=True)
for line in sys.stdin:
    c = json.loads(line)
    getattr(b, c['call'])(*c['args'], **c.get('kw', {}))
`;
/** A keyword-passing Bridge API driver in `lang`, started: {c, lang, port, token}. */
async function apiKw(lang) {
  const c = lang === 'node' ? child('node', ['-e', NODE_KW]) : child('python3', ['-u', '-c', PY_KW]);
  if (!(await until(() => /READY \d+ \w+\n/.test(c.buf), 10000, 100))) throw new Error(`${lang} API driver did not start: ${c.buf}`);
  const [, port, token] = c.buf.match(/READY (\d+) (\w+)/);
  return { c, lang, port: +port, token };
}

/** "Drill", an original test box: pawns (two faces, free turns), planks (tiles: 90° turns), dice with named faces, a bag "Sack". */
const ID = Object.fromEntries(['a1', 'a2', 'a3', 'b1', 'b2', 'n1', 'n2', 'k1', 'k2', 'd1', 'd2', 'sack'].map((k, j) => [k, `d0d0${j.toString(16).padStart(4, '0')}`]));
const DRILL = {
  name: 'Drill', imgs: [], lockable: 'anyone', table: { shape: 'rect', w: 2400, h: 1600 },
  pieces: [
    { id: 'pawn', kind: 'token', w: 60, faces: ['P', 'p'] },
    { id: 'plank', kind: 'tile', w: 80, faces: ['L'] },
    { id: 'd6', kind: 'die', faces: ['one', 'two', 'three', 'four', 'five', 'six'] },
  ],
  setup: [
    ...[['a1', 300, 300], ['a2', 400, 300], ['a3', 500, 300], ['b1', 300, 600], ['b2', 400, 600], ['n1', 700, 300], ['n2', 800, 300]].map(([k, x, y]) => ({ piece: 'pawn', at: [x, y], id: ID[k] })),
    { piece: 'plank', at: [1000, 300], id: ID.k1 },
    { piece: 'plank', at: [1100, 300], id: ID.k2 },
    { piece: 'd6', at: [1500, 300], id: ID.d1 },
    { piece: 'd6', at: [1600, 300], id: ID.d2 },
    { bag: ['pawn'], name: 'Sack', at: [1800, 1000], id: ID.sack },
  ],
};

(async () => {
  const env = await h.start();

  section('to a fake tab: every `group` line sends exactly its command, from both REPLs; a malformed line prints the same usage and sends nothing; both helps list it alike');
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
  const after = await Promise.all(fakes.map((b) => sent(b, () => { for (const bad of BAD) b.c.stdin.write(bad + '\n'); b.c.stdin.write('group flip zz01\n'); })));
  ok(after.every((g) => g?.length === 1 && eq(g[0], { t: 'group', op: 'flip', ids: ['zz01'] })), `${BAD.length} malformed lines send nothing: only the good line after them arrives (${after.map(json).join(' / ')})`);
  const usages = fakes.map((b, k) => b.c.buf.slice(marks[k]).split('\n').filter((l) => l.includes(USAGE)).map((l) => l.replace(/^(?:🂡 > )+/, '').trim()));
  ok(usages.every((u) => u.length === BAD.length) && json(usages[0]) === json(usages[1]), `each prints the usage, word for word alike in both (${json(usages[0][0]?.replace(/^\S+ /, ''))})`);
  const help = await Promise.all(fakes.map((b) => type(b, 'help', (ls) => ls.some((l) => l.startsWith(`  ${USAGE}`)))));
  const helpLine = help.map((ls) => ls.find((l) => l.startsWith(`  ${USAGE}`)));
  ok(helpLine.every(Boolean) && helpLine[0] === helpLine[1], `both helps list it, alike: ${json(helpLine[0])}`);

  section('the Bridge API: group(op, ids, kw) in cli.js, group(op, ids, **kw) in cli.py, the same command');
  const apis = await Promise.all(LANGS.map(apiKw));
  const viaKw = (b) => sent(b, async () => {
    for (const [[op, ids, kw]] of CALLS) b.c.stdin.write(json({ call: 'group', args: [op, ids], ...(kw && { kw }) }) + '\n');
    await h.sleep(500);
  });
  const calls = await Promise.all(apis.map(viaKw));
  for (const [k, [[op, ids, kw], want]] of CALLS.entries()) {
    ok(calls.every((g) => eq(g?.[k], want)), `group(${json(op)}, ${json(ids)}${kw ? `, ${json(kw)}` : ''}) sends ${json(want)} from both (${calls.map((g) => json(g?.[k])).join(' / ')})`);
  }

  section('real tabs: Alice (host) on cli.js, Bob (guest) on cli.py; "Drill" set up');
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
  const [A, B] = [await pidOf(alice), await pidOf(bob)];
  const added = await act(alice, { t: 'addBox', box: DRILL });
  await act(alice, { t: 'setup', box: added.id });
  for (const [ids, to] of [[[ID.a1, ID.a2, ID.a3], A], [[ID.b1, ID.b2], B]]) for (const id of ids) await act(alice, { t: 'owner', id, to });
  ok(await until(() => item('Bob', ID.b2)?.owner === 'Bob' && item('Alice', ID.a3)?.owner === 'Alice' && snap('Bob').items.length === 12, 20000, 200), `set up: 12 items in both snapshots, Alice's pawns and Bob's (${snap('Bob')?.items.length})`);
  const S = () => alice.evaluate(() => window.__ct.hostState());
  /** The lines REPL `name` printed after buffer offset `from` that match `re` (prompts stripped). */
  const printed = (name, from, re) => R[name].c.buf.slice(from).split('\n').map((l) => l.replace(/^(?:🂡 > )+/, '')).filter((l) => re.test(l));
  /** Types `line` once into `who`'s REPL and waits until both REPLs print the log line `re`; returns [the offsets before it]. */
  async function both(who, line, re) {
    const from = { Alice: R.Alice.c.buf.length, Bob: R.Bob.c.buf.length };
    R[who].c.stdin.write(line + '\n');
    const seen = await until(() => printed('Alice', from.Alice, re).length === 1 && printed('Bob', from.Bob, re).length === 1, 15000, 100);
    ok(seen, `"${line}" (${who}, ${who === 'Alice' ? 'cli.js' : 'cli.py'}): one line in both REPLs — ${json(printed('Bob', from.Bob, re))}`);
    return from;
  }

  section('each op, typed in a terminal: one action; its one line in both REPLs; the members one may not handle skipped, said once in the sender\'s REPL (§4c, §4i)');
  let from = await both('Bob', `group move ${[ID.b1, ID.b2, ID.a1, ID.n1].join(',')} 0 100`, /▸ Bob moved 3 items$/);
  ok(await until(() => item('Alice', ID.b1)?.y === 700 && item('Alice', ID.b2)?.y === 700 && item('Alice', ID.n1)?.y === 400 && item('Alice', ID.a1)?.y === 300, 10000, 100), "Bob's two pawns and the free one a hundred down on Alice's screen; Alice's pawn where it was");
  ok(await until(() => printed('Bob', from.Bob, /✉ note: 1 of 4 (?:was|were) skipped: (?:🚫 )?That belongs to Alice$/).length === 1, 10000, 100) && !printed('Alice', from.Alice, /✉ note/).length,
    `Bob's REPL says the skip once (${json(printed('Bob', from.Bob, /✉/))}); Alice's says nothing of it`);
  await both('Alice', `group rot ${[ID.k1, ID.k2, ID.n2].join(',')} 60`, /▸ Alice rotated 3 items$/);
  const st1 = await S();
  ok(st1.items[ID.k1].rot === 90 && st1.items[ID.k2].rot === 90 && st1.items[ID.n2].rot === 60, `a turn of 60 each, snapped per member: the planks (90° steps) to 90, the pawn (free) to 60 (${json([ID.k1, ID.k2, ID.n2].map((k) => st1.items[k].rot))})`);
  from = await both('Bob', `group roll ${ID.d2},${ID.d1},${ID.b1}`, /▸ Bob rolled 2 dice: \w+ · \w+$/);
  const [, f1, f2] = /▸ Bob rolled 2 dice: (\w+) · (\w+)$/.exec(printed('Bob', from.Bob, /▸ Bob rolled/)[0]) || [];
  ok(await until(() => item('Bob', ID.d1)?.label === f1 && item('Bob', ID.d2)?.label === f2, 10000, 100), `one roll of the two dice (the pawn is none), their faces in id order: ${f1} · ${f2}`);
  await both('Alice', `group bag ${[ID.a1, ID.a2, ID.n2].join(',')} Sack`, /▸ Alice put 3 items into the bag Sack$/);
  ok(await until(() => item('Bob', ID.sack)?.count === 4 && [ID.a1, ID.a2, ID.n2].every((k) => !item('Bob', k)), 10000, 100), `the bag named by its name: three pawns into it (${item('Bob', ID.sack)?.count} in it now), gone from the table`);
  await both('Bob', `group lock ${ID.b1},${ID.b2}`, /▸ Bob locked 2 items$/);
  ok(await until(() => item('Alice', ID.b1)?.locked && item('Alice', ID.b2)?.locked, 10000, 100), 'locked (anyone may lock what they may handle, in this box)');
  await both('Bob', `group unlock ${ID.b1},${ID.b2}`, /▸ Bob unlocked 2 items$/);
  ok(await until(() => !item('Alice', ID.b1)?.locked && !item('Alice', ID.b2)?.locked, 10000, 100), 'unlocked');
  from = await both('Bob', `group del ${[ID.b1, ID.k1, ID.a3].join(',')}`, /▸ Bob removed 2 items$/);
  ok(await until(() => !item('Alice', ID.b1) && !item('Alice', ID.k1) && !!item('Alice', ID.a3), 10000, 100), "Bob's pawn and the plank removed; Alice's pawn stays");
  ok(await until(() => printed('Bob', from.Bob, /✉ note: 1 of 3 (?:was|were) skipped: (?:🚫 )?That belongs to Alice$/).length === 1, 10000, 100), `said once in Bob's REPL (${json(printed('Bob', from.Bob, /✉/))})`);

  section('an unknown op is said in the terminal, in both; nothing changes');
  const st2 = await S();
  for (const name of ['Alice', 'Bob']) {
    const out = await type(R[name], `group spin ${ID.n1}`, (ls) => ls.some((l) => /✉ error: .*spin/.test(l)), 5000);
    ok(out.some((l) => /✉ error: group: .*"?spin"?/.test(l)), `${name}'s "group spin …": ${json(out.filter((l) => /✉/.test(l)))}`);
  }
  ok(json((await S()).items) === json(st2.items), 'the table is as it was');
  killAll();
  await env.done();
})().catch((e) => { killAll(); h.crash(e); });
