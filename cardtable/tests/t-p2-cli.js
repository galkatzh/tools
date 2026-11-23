// Phase 2, the terminal bridges (spec §2i), cli.js and cli.py in parity:
// every new REPL command sends exactly its action (to a fake tab, and through
// a real tab to the host, where a probe script's validate() records what
// arrived); the bridge API's roll, take and seat; the snapshot's new fields
// (table, seats, me, players' seat ids and watchers, pieces, supplies, bags,
// piece piles and piece hand entries); `table` and `players` printed in the
// specified format, the same text in both REPLs; and cliItem resolving bag
// names and supplies' type names.
const h = require('./h');
const { ok, section } = h;
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { act, loadBox, items, at, until, PARLOUR } = require('./p2-lib');

const APP = path.join(h.APP_ROOT, 'cardtable');
const LANGS = ['node', 'python'];
const kids = [];
/** A child process whose stdout and stderr gather in .buf. */
function child(cmd, args) {
  const c = spawn(cmd, args, { cwd: APP, stdio: ['pipe', 'pipe', 'pipe'] });
  kids.push(c);
  c.buf = '';
  c.stdout.on('data', (d) => { c.buf += d; });
  c.stderr.on('data', (d) => { c.buf += d; }); // (Node's REPL reports a usage error on stderr)
  return c;
}
/** A REPL (cli.js or cli.py) for `invite`: {c, lang, port, token, url}. */
async function repl(lang, invite) {
  const c = lang === 'node' ? child('node', [path.join(APP, 'cli.js'), invite]) : child('python3', ['-u', path.join(APP, 'cli.py'), invite]);
  if (!(await until(() => /~cli~\d+-\w+\S*\n/.test(c.buf), 10000, 100))) throw new Error(`${lang} REPL did not start: ${c.buf}`);
  const [url, port, token] = c.buf.match(/(\S+~cli~(\d+)-(\w+)\S*)/).slice(1);
  return { c, lang, port: +port, token, url };
}
/** The REPL's output from character `from` on, as lines without its prompts. */
const linesOf = (r, from) => r.c.buf.slice(from).split('\n').map((l) => l.replace(/^(?:🂡 > )+/, ''));
/** Types `line` (again every 2 s, as the tab's state may lag) until the
 *  lines printed after it pass `done`; returns them (or the last tried). */
async function type(r, line, done, ms = 20000) {
  let lines = [];
  for (const end = Date.now() + ms; Date.now() < end;) {
    const from = r.c.buf.length;
    r.c.stdin.write(line + '\n');
    if (await until(() => done((lines = linesOf(r, from))), 2000, 100)) return lines;
  }
  console.error(`  (${r.lang}: "${line}" never printed what was expected; got ${JSON.stringify(lines.slice(0, 20))})`);
  return lines;
}
/** An HTTP request to a bridge, as a tab makes it: {done: Promise<{status, body}>, abort}. */
function req(port, p, { method = 'GET', body } = {}) {
  let r;
  const done = new Promise((resolve) => {
    r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
    r.end(body);
  });
  return { done, abort: () => r.destroy() };
}
/** Plays the tab: a poll is parked, `fn()` runs (it makes the bridge send),
 *  and every command the bridge then hands out comes back — polling again,
 *  as a tab does, while commands keep coming (a parked poll is answered with
 *  the first one: the rest wait for the next poll). */
async function sent(b, fn) {
  const poll = async (p, ms) => {
    const r = await Promise.race([p.done, h.sleep(ms).then(() => null)]);
    if (!r) { p.abort(); return []; }
    try { return JSON.parse(r.body); } catch (err) { console.error('bad poll body', r.body, err); return null; }
  };
  const first = req(b.port, `/poll?token=${b.token}`);
  await h.sleep(250);
  await fn();
  const all = await poll(first, 5000);
  for (let more = all; more?.length;) all.push(...((more = await poll(req(b.port, `/poll?token=${b.token}`), 600)) || []));
  return all;
}
const json = (x) => JSON.stringify(x);
/** Deep equality of parsed JSON (key order ignored). */
const eq = (a, b) => json(sort(a)) === json(sort(b));
const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
/** A take/pull/split as sent: x, y and n are null when not given, hand false. */
const loose = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null && !(k === 'hand' && v === false)));

// A fake tab's snapshot: enough for the REPLs to accept commands.
const FAKE = { pid: 'p1', name: 'Fake', role: 'guest', room: 'r', seq: 1, table: { shape: 'rect', w: 1400, h: 1200 }, seats: null, me: { seat: 90 },
  players: [], buttons: [], log: [], msgs: [], hand: [], items: [] };
/** A fake tab's snapshot whose names, labels and type names carry control characters. */
const EVIL = { ...FAKE, seq: 2,
  players: [{ id: 'p1', name: 'Na\x1bme', seat: null, online: true, cards: 0, watching: true }, { id: 'p2', name: 'Bo\x07b', seat: 90, seatId: 'white', online: true, cards: 1 }],
  hand: [{ idx: 0, key: 't:b/x:0', kind: 'piece', name: 'Ti\x1b[2Jle', label: '\x9bT' }],
  items: [
    { id: 'aaaaaaa1', kind: 'token', type: 'Ev\x1b[31mil', typeRef: 'b/x', face: 0, label: '\x07L', n: 2, owner: 'Ow\x1b]0;x\x07ner', locked: true, x: 1, y: 2 },
    { id: 'aaaaaaa2', kind: 'supply', type: 'G\x1bold', typeRef: 'b/g', face: 0, pieceKind: 'token', x: 3, y: 4 },
    { id: 'aaaaaaa3', kind: 'bag', name: 'Ba\x9bg', count: 3, x: 5, y: 6 },
    { id: 'aaaaaaa4', kind: 'pile', name: 'P\x1bile', count: 2, x: 7, y: 8, top: { type: 'T\x1bop', label: '\x1bL' } },
    { id: 'aaaaaaa5', kind: 'board', type: 'Bo\x1bard', typeRef: 'b/b', face: 0, x: 0, y: 0 },
    { id: 'aaaaaaa6', kind: 'hidden', n: 2, owner: 'Wh\x1bite', x: 9, y: 9 },
  ] };
const CTRL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
/** Each new REPL command and what it must send (null: the two REPLs must only agree; `loose`: x, y, n and hand compared as given). */
const COMMANDS = [
  ['roll d1 d2', { t: 'roll', ids: ['d1', 'd2'] }],
  ['roll all', null],
  ['face w1 2', { t: 'face', id: 'w1', f: 2 }],
  ['take Gold', { t: 'take', id: 'Gold' }, true],
  ['take s1 100 200', { t: 'take', id: 's1', x: 100, y: 200 }, true],
  ['take s1 --hand', { t: 'take', id: 's1', hand: true }, true],
  ['pull Tiles', { t: 'pull', id: 'Tiles' }, true],
  ['pull Tiles 10 20 --hand', { t: 'pull', id: 'Tiles', x: 10, y: 20, hand: true }, true],
  ['split m4', { t: 'split', id: 'm4' }, true],
  ['split m4 2', { t: 'split', id: 'm4', n: 2 }, true],
  ['split m4 2 300 400', { t: 'split', id: 'm4', n: 2, x: 300, y: 400 }, true],
  ['bag t1 Tiles', { t: 'toBag', id: 't1', bag: 'Tiles' }],
  ['lock m4', { t: 'lock', id: 'm4', on: true }],
  ['unlock m4', { t: 'lock', id: 'm4', on: false }],
  ['claim m4', { t: 'owner', id: 'm4', to: 'p1' }],
  ['release m4', { t: 'owner', id: 'm4', to: null }],
  ['seat black', { t: 'seat', id: 'black' }],
  ['seat -', { t: 'seat', watch: true }],
  ['seat +', { t: 'seat', sit: true }],
];
const USAGE = [['roll', 'roll <id'], ['face w1', 'face <id> <f>'], ['take', 'take <supply>'], ['pull', 'pull <bag>'], ['split m4 x', 'split <id>'],
  ['bag t1', 'bag <id> <bag>'], ['lock', 'lock <id>'], ['claim', 'claim <id>'], ['seat', 'seat <id>']];
// The bridge API, the same calls in both languages (JSON lines {call, args}).
const NODE_API = `
const { Bridge } = require(${json(path.join(APP, 'cli.js'))});
(async () => {
  const b = await new Bridge().ready;
  console.log('READY', b.port, b.token);
  require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const c = JSON.parse(l); b[c.call](...c.args); });
})();`;
const PY_API = `
import json, sys
sys.path.insert(0, ${json(APP)})
from cli import Bridge
b = Bridge()
print('READY', b.port, b.token, flush=True)
for line in sys.stdin:
    c = json.loads(line)
    getattr(b, c['call'])(*c['args'])
`;
const API = [
  [['roll', 'd1', 'd2'], { t: 'roll', ids: ['d1', 'd2'] }],
  [['take', 'Gold'], { t: 'take', id: 'Gold', x: null, y: null, hand: false }],
  [['take', 's1', 10, 20, true], { t: 'take', id: 's1', x: 10, y: 20, hand: true }],
  [['seat', 'white'], { t: 'seat', id: 'white' }],
  [['seat', '-'], { t: 'seat', watch: true }],
  [['seat', '+'], { t: 'seat', sit: true }],
];
/** The host's probe: validate() records every ruled action as it arrives, numbered, in t.public. */
const PROBE = `({ name: 'Probe', validate(t, a) {
  const { p, ...x } = a, P = t.public;
  P.n = (P.n || 0) + 1;
  (P.acts ||= []).push({ k: P.n, p, a: x });
  if (P.acts.length > 20) P.acts.shift();
} })`;

(async () => {
  const env = await h.start();

  section('the REPLs send each new command as its action (a fake tab)');
  const fakes = await Promise.all(LANGS.map((l) => repl(l, 'http://x/#room~ab~cd')));
  for (const b of fakes) {
    await req(b.port, `/state?token=${b.token}`, { method: 'POST', body: json(FAKE) }).done;
    ok(await until(() => b.c.buf.includes('tab connected'), 5000, 100), `${b.lang}: the fake tab is connected`);
  }
  const help = await Promise.all(fakes.map((b) => type(b, 'help', (ls) => ls.some((l) => l.startsWith('  quit')))));
  const helpText = help.map((ls) => ls.slice(ls.findIndex((l) => l.startsWith('commands:')), ls.findIndex((l) => l.startsWith('  quit')) + 1).join('\n'));
  const words = ['roll', 'face', 'take', 'pull', 'split', 'bag', 'lock', 'unlock', 'claim', 'release', 'seat'];
  ok(helpText.every((t) => words.every((w) => new RegExp(`\\b${w}\\b`).test(t))) && helpText[0] === helpText[1], `both REPLs' help lists ${words.join(', ')}, word for word the same`);
  for (const [line, want, isLoose] of COMMANDS) {
    const got = await Promise.all(fakes.map((b) => sent(b, () => b.c.stdin.write(line + '\n'))));
    const one = got.map((g) => (g?.length === 1 ? g[0] : g));
    ok(got.every((g) => g?.length === 1) && eq(one[0], one[1]), `"${line}": both REPLs send the same command (${json(one[0])} / ${json(one[1])})`);
    if (want) ok(one.every((c) => eq(isLoose ? loose(c) : c, want)), `"${line}" sends ${json(want)}`);
  }
  for (const [line, usage] of USAGE) {
    const outs = await Promise.all(fakes.map((b) => type(b, line, (ls) => ls.some((l) => l.includes(usage)), 3000)));
    ok(outs.every((ls) => ls.some((l) => l.includes(usage))), `"${line}" prints its usage ("${usage}…") in both`);
  }
  const after = await Promise.all(fakes.map((b) => sent(b, () => b.c.stdin.write('chat after\n'))));
  ok(after.every((g) => eq(g, [{ t: 'chat', msg: 'after' }])), `a command with bad arguments sends nothing (${json(after)})`);

  section('`table`, `players` and `hand` strip control characters, alike in both REPLs');
  for (const b of fakes) await req(b.port, `/state?token=${b.token}`, { method: 'POST', body: json(EVIL) }).done;
  const shown = {};
  for (const [cmd, pick, n] of [['table', (l) => /^  \[aaaaaaa\d\] /.test(l), 6], ['players', (l) => /🂠/.test(l), 2], ['hand', (l) => /^ +0\. /.test(l), 1]]) {
    const outs = await Promise.all(fakes.map((b) => type(b, cmd, (ls) => ls.filter(pick).length >= n)));
    const got = outs.map((ls) => ls.filter(pick));
    ok(got.every((ls) => ls.length === n && !ls.some((l) => CTRL.test(l))), `"${cmd}": no control character reaches the terminal (${json(got[1])})`);
    ok(json(got[0]) === json(got[1]), `"${cmd}": the same text from both`);
    shown[cmd] = got[0];
  }
  ok(shown.table.includes('  [aaaaaaa1] L Ev[31mil (token) ×2 @1,2 owner:Ow]0;xner 🔒') && shown.table.includes('  [aaaaaaa6] hidden piece ×2 @9,9 owner:White'),
    `the visible text stays (${json(shown.table[0])})`);

  section('a shown supply whose box the tab lacks prints as "? unknown piece", in both REPLs');
  const GONE = { ...FAKE, seq: 3, items: [{ id: 'aaaaaaa7', kind: 'supply', unknown: true, typeRef: 'b/q', x: 11, y: 12 }] };
  for (const b of fakes) await req(b.port, `/state?token=${b.token}`, { method: 'POST', body: json(GONE) }).done;
  const gone = (await Promise.all(fakes.map((b) => type(b, 'table', (ls) => ls.some((l) => l.startsWith('  [aaaaaaa7] ')))))).map((ls) => ls.find((l) => l.startsWith('  [aaaaaaa7] ')));
  ok(gone.every((l) => l === '  [aaaaaaa7] supply ? unknown piece ∞ @11,12'), `"  [aaaaaaa7] supply ? unknown piece ∞ @11,12" from both (${json(gone)})`);

  section('the bridge API: roll, take and seat');
  const apis = await Promise.all(LANGS.map(async (lang) => {
    const c = lang === 'node' ? child('node', ['-e', NODE_API]) : child('python3', ['-u', '-c', PY_API]);
    if (!(await until(() => /READY \d+ \w+\n/.test(c.buf), 10000, 100))) throw new Error(`${lang} API driver did not start: ${c.buf}`);
    const [, port, token] = c.buf.match(/READY (\d+) (\w+)/);
    return { c, lang, port: +port, token };
  }));
  const viaApi = await Promise.all(apis.map((b) => sent(b, async () => {
    for (const [[call, ...args]] of API) b.c.stdin.write(json({ call, args }) + '\n');
    await h.sleep(500);
  })));
  for (const [k, [[call, ...args], want]] of API.entries()) {
    ok(viaApi.every((g) => eq(g?.[k], want)), `${call}(${args.map((a) => json(a)).join(', ')}) sends ${json(want)} from both (${viaApi.map((g) => json(g?.[k])).join(' / ')})`);
  }

  section('real tabs: Alice (host) on cli.js, Bob (guest) on cli.py');
  const { host, guest: bob } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const alice = await host.evaluate(() => localStorage.getItem('ct-pid'));
  const bobPid = await bob.evaluate(() => localStorage.getItem('ct-pid'));
  const snaps = {}; // the last state each tab pushed to its bridge (as the bridge got it)
  const tabs = [[host, 'Alice', 'node'], [bob, 'Bob', 'python']];
  const R = {};
  for (const [page, name, lang] of tabs) {
    await page.route(/127\.0\.0\.1:\d+\/state\?/, (route) => {
      snaps[name] = route.request().postData();
      route.continue().catch((err) => console.error('route.continue failed', err.message));
    });
    R[name] = await repl(lang, invite);
    await page.goto(R[name].url);
    await page.reload(); // a hash change alone doesn't boot again
    await page.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await until(() => R[name].c.buf.includes(`tab connected: ${name}`), 20000, 200), `${lang}: ${name}'s tab is connected`);
  }
  await host.waitForFunction(() => Object.values(window.__ct.view().players).filter((p) => p.online).length === 2, null, { timeout: 30000 });
  const box = await loadBox(host, PARLOUR);
  const ref = (t) => `${box}/${t}`;
  let its = await items(host);
  const id = (x, y) => at(its, x, y);
  const I = { man3: id(412, 620), unit2: id(80, 90), gold: id(200, 200), bag: id(300, 300), board: id(0, 0), wheel: id(900, 300), man4: id(1000, 600), tile: id(1100, 300) };
  const dice = [id(700, 900), id(780, 900), id(860, 900)];
  const hts = Object.keys(its).filter((k) => its[k].b === ref('tb'));
  const shownTiles = Object.keys(its).filter((k) => its[k].x === 1200 && its[k].y === 900);
  ok(Object.values(I).every(Boolean) && dice.every(Boolean) && hts.length === 5 && shownTiles.length === 2, 'the Parlour box is laid out');
  // the host makes the spec's example lines: an owned, locked ×3; a seat's hidden ×2; a pile of 5 hidden tiles; dice of each owner
  for (const a of [
    { t: 'owner', id: I.man3, to: alice }, { t: 'lock', id: I.man3, on: true }, { t: 'owner', id: I.unit2, to: 'seat:white' },
    { t: 'owner', id: dice[1], to: 'seat:white' }, { t: 'owner', id: dice[2], to: 'seat:black' }, { t: 'lock', id: dice[0], on: true },
    { t: 'stack', id: hts[0], onto: hts[1] }, { t: 'stack', id: shownTiles[0], onto: shownTiles[1] },
  ]) ok((await act(host, a)).ok, `the host: ${json(a)}`);
  its = await items(host);
  I.pile = at(its, 500, 500, (it) => it.k === 'p');
  I.tilePile = at(its, 1200, 900, (it) => it.k === 'p');
  for (const x of hts.slice(2)) await act(host, { t: 'toPile', id: x, pile: I.pile });
  await act(host, { t: 'setRules', code: PROBE, enabled: true });
  const snap = (name) => { try { return JSON.parse(snaps[name] || 'null'); } catch (err) { console.error(err); return null; } };
  const ready = (s) => s?.rules === 'Probe' && s.items.find((x) => x.id === I.pile)?.count === 5 && s.items.find((x) => x.id === I.man3)?.locked;
  ok(await until(() => ready(snap('Alice')) && ready(snap('Bob')), 20000, 200), 'both tabs pushed the prepared table to their bridges');

  section('the snapshot (cliSnapshot)');
  for (const [name, me, mine] of [['Alice', alice, 'white'], ['Bob', bobPid, 'black']]) {
    const s = snap(name), item = (x) => s.items.find((it) => it.id === x);
    ok(eq(s.table, { shape: 'rect', w: 1400, h: 1200 }), `${name}: table ${json(s.table)}`);
    ok(eq(s.seats, [{ id: 'white', name: 'White', player: alice }, { id: 'black', name: 'Black', player: bobPid }]), `${name}: seats ${json(s.seats)}`);
    ok(s.me?.seatId === mine && typeof s.me.seat === 'number', `${name}: me ${json(s.me)}`);
    const ps = Object.fromEntries(s.players.map((p) => [p.id, p]));
    ok(ps[alice]?.seatId === 'white' && ps[bobPid]?.seatId === 'black' && !s.players.some((p) => p.watching), `${name}: players carry their seat ids, nobody watches`);
    ok(eq(item(I.man3), { id: I.man3, kind: 'token', type: 'Light man', typeRef: ref('man'), face: 1, label: '♛', n: 3, owner: 'Alice', locked: true, x: 412, y: 620 }), `${name}: a token ${json(item(I.man3))}`);
    const u = item(I.unit2);
    ok(u?.kind === 'hidden' && u.n === 2 && u.owner === 'White' && u.x === 80 && u.y === 90 && !['type', 'typeRef', 'face', 'label', 'text'].some((k) => k in u), `${name}: a hidden stack ${json(u)}`);
    const g = item(I.gold);
    ok(g?.kind === 'supply' && g.type === 'Gold' && g.typeRef === ref('gold') && g.face === 0 && !('label' in g) && g.x === 200 && g.y === 200, `${name}: a supply ${json(g)}`);
    ok(eq(item(I.bag), { id: I.bag, kind: 'bag', name: 'Tiles', count: 42, x: 300, y: 300 }), `${name}: a bag ${json(item(I.bag))}`);
    const p = item(I.pile);
    ok(p?.kind === 'pile' && p.count === 5 && p.x === 500 && p.y === 500 && p.top && !('type' in p.top) && !('label' in p.top), `${name}: a pile of hidden tiles ${json(p)}`);
    const b = item(I.board);
    ok(b?.kind === 'board' && b.type === 'Chessboard' && b.typeRef === ref('board') && b.face === 0 && b.locked === true && b.x === 0 && b.y === 0, `${name}: a board ${json(b)}`);
    const d = dice.map(item);
    ok(d.every((x) => x?.kind === 'die' && x.type === 'Die' && x.typeRef === ref('die') && Number.isInteger(x.face)) && !('owner' in d[0]) && d[0].locked === true && d[1].owner === 'White' && d[2].owner === 'Black', `${name}: dice ${json(d[1])}`);
    const tp = item(I.tilePile);
    ok(tp?.kind === 'pile' && tp.count === 2 && eq(tp.top, { type: 'Tile', label: 'T' }), `${name}: a pile of shown tiles: top {type, label} (${json(tp)})`);
    ok(eq(item(I.tile), { id: I.tile, kind: 'tile', type: 'Tile', typeRef: ref('tile'), face: 0, label: 'T', text: 'A tile', x: 1100, y: 300 }), `${name}: a tile with text ${json(item(I.tile))}`);
    ok(item(I.wheel)?.label === 'W0' && item(I.man4)?.n === 4 && !('label' in item(I.man4)), `${name}: a 3-face token and a plain ×4`);
  }

  section('`table` prints every kind in the specified format, the same in both REPLs');
  const want = [
    `  [${I.man3}] ♛ Light man (token) ×3 @412,620 owner:Alice 🔒`,
    `  [${I.unit2}] hidden piece ×2 @80,90 owner:White`,
    `  [${I.gold}] supply Gold (token) ∞ @200,200`,
    `  [${I.bag}] bag "Tiles" ×42 @300,300`,
    `  [${I.pile}] pile "stack" ×5 top: hidden piece @500,500`,
    `  [${I.board}] board Chessboard (board) @0,0 🔒`,
    `  [${I.wheel}] W0 Wheel (token) @900,300`,
    `  [${I.man4}] Light man (token) ×4 @1000,600`,
    `  [${I.tile}] T Tile (tile) @1100,300`,
  ];
  const n = snap('Alice').items.length;
  const tables = {};
  for (const name of ['Alice', 'Bob']) {
    const lines = (await type(R[name], 'table', (ls) => ls.filter((l) => /^  \[[0-9a-f]{8}\] /.test(l)).length >= n && want.every((w) => ls.includes(w))))
      .filter((l) => /^  \[[0-9a-f]{8}\] /.test(l));
    tables[name] = lines.sort();
    for (const w of want) ok(lines.includes(w), `${R[name].lang}: ${w.trim()}`);
    ok(dice.every((d, k) => lines.some((l) => new RegExp(`^  \\[${d}\\] (?:\\S+ )?Die \\(die\\) @${700 + 80 * k},900${[' 🔒', ' owner:White', ' owner:Black'][k]}$`).test(l))), `${R[name].lang}: the dice print as "… Die (die) @x,y", then owner:… or 🔒`);
    ok(lines.length === n, `${R[name].lang}: one line per item (${lines.length} of ${n})`);
  }
  ok(json(tables.Alice) === json(tables.Bob), 'cli.js and cli.py print the same table');

  section('`players` marks the seat ids and the watchers');
  /** `players` as printed in `name`'s REPL (its " (you)" taken out, to compare the two). */
  const lines = (ls) => ls.filter((l) => /🂠/.test(l)).map((l) => l.replace(' (you)', ''));
  const players = async (name, pred) => lines(await type(R[name], 'players', (ls) => pred(lines(ls))));
  const seated = (ls) => ls.some((l) => /Alice \[white\]/.test(l)) && ls.some((l) => /Bob \[black\]/.test(l));
  const pa = await players('Alice', seated), pb = await players('Bob', seated);
  ok(seated(pa) && seated(pb) && !pa.concat(pb).some((l) => l.includes('(watching)')), `both show [white] and [black] (${json(pa)})`);
  ok(json(pa.sort()) === json(pb.sort()), 'the same text in both REPLs');

  section('every new command, through the tabs, sends exactly its action');
  let k0 = 0;
  /** The probe's records after #k0 (the ruled actions the host received). */
  const probed = () => host.evaluate(() => JSON.parse(JSON.stringify(window.__ct.view().rules?.public?.acts || [])));
  /** Types `line` into `name`'s REPL and returns the first action the host received after it. */
  async function through(name, line) {
    const k = Math.max(k0, ...(await probed()).map((e) => e.k));
    R[name].c.stdin.write(line + '\n');
    let got = null;
    await until(async () => { got = (await probed()).find((e) => e.k > k); return got; }, 10000, 150);
    k0 = got?.k ?? k;
    return got;
  }
  const check = async (name, line, pred, what) => {
    const got = await through(name, line);
    ok(got && got.p === (name === 'Alice' ? alice : bobPid) && pred(got.a), `${R[name].lang} "${line}" → ${what} (${json(got?.a)})`);
    return got?.a;
  };
  const keys = (a, list) => Object.keys(a).every((k) => list.includes(k));
  const view = async () => JSON.parse(JSON.stringify(await host.evaluate(() => window.__ct.view())));
  // Alice (cli.js)
  const ra = await check('Alice', 'roll all', (a) => keys(a, ['t', 'ids']) && a.t === 'roll' && eq([...a.ids].sort(), [dice[0], dice[1]].sort()), 'roll of every die she may handle (hers, and nobody\'s even locked)');
  ok(ra && (await until(async () => (await view()).log.some((e) => e.p === alice && /^rolled \S+ · \S+$/.test(e.txt)), 5000)), 'logged as one roll of two dice');
  await check('Alice', `roll ${dice[1]} ${dice[0]}`, (a) => eq(a, { t: 'roll', ids: [dice[1], dice[0]] }), '{t: roll, ids}');
  await check('Alice', `face ${I.wheel} 2`, (a) => eq(a, { t: 'face', id: I.wheel, f: 2 }), '{t: face, id, f}');
  await check('Alice', 'take Gold', (a) => keys(a, ['t', 'id', 'x', 'y', 'hand']) && a.t === 'take' && a.id === I.gold && !a.hand, 'a take from the supply named by its type');
  await check('Alice', 'take Gold 600 700', (a) => keys(a, ['t', 'id', 'x', 'y', 'hand']) && a.id === I.gold && a.x === 600 && a.y === 700 && !a.hand, 'a take at 600,700');
  ok(await until(async () => Object.values((await view()).items).some((it) => it.t === ref('gold') && it.k === 'g' && it.x === 600 && it.y === 700), 5000), 'a Gold token lies at 600,700');
  // (Phase 3: the host draws a pull's piece before the hooks, spec §3c: validate sees it as a.pick)
  await check('Alice', 'pull Tiles --hand', (a) => keys(a, ['t', 'id', 'hand', 'pick']) && a.t === 'pull' && a.id === I.bag && a.hand === true && Number.isInteger(a.pick), 'a pull into the hand from the bag named "Tiles"');
  await check('Alice', `split ${I.man4}`, (a) => keys(a, ['t', 'id', 'n', 'x', 'y']) && a.t === 'split' && a.id === I.man4 && (a.n ?? 1) === 1, '{t: split, id}');
  await check('Alice', `split ${I.man4} 2 1000 800`, (a) => eq(a, { t: 'split', id: I.man4, n: 2, x: 1000, y: 800 }), '{t: split, id, n, x, y}');
  await check('Alice', `bag ${I.tile} Tiles`, (a) => eq(a, { t: 'toBag', id: I.tile, bag: I.bag }), '{t: toBag, id, bag} (the bag named "Tiles")');
  await check('Alice', `lock ${I.wheel}`, (a) => eq(a, { t: 'lock', id: I.wheel, on: true }), '{t: lock, id, on: true}');
  await check('Alice', `unlock ${I.wheel}`, (a) => eq(a, { t: 'lock', id: I.wheel, on: false }), '{t: lock, id, on: false}');
  await check('Alice', `claim ${I.wheel}`, (a) => eq(a, { t: 'owner', id: I.wheel, to: alice }), '{t: owner, id, to: her}');
  await check('Alice', `release ${I.wheel}`, (a) => eq(a, { t: 'owner', id: I.wheel, to: null }), '{t: owner, id, to: null}');
  let v = await view();
  const man1 = Object.keys(v.items).find((x) => v.items[x].t === ref('man') && !v.items[x].n && v.items[x].f === 0);
  const man2 = at(v.items, 1000, 800);
  ok(v.items[I.wheel]?.f === 2 && !v.items[I.wheel].lock && !v.items[I.wheel].owner && v.items[I.man4] && !v.items[I.man4].n && v.items[man2]?.n === 2 && man1 && !v.items[I.tile] && v.items[I.bag].n === 42,
    'the table shows it all: the wheel on W2, free again; ×4 split into 1 + 1 + 2; the tile back in its bag');
  // Bob (cli.py)
  await check('Bob', 'roll all', (a) => keys(a, ['t', 'ids']) && a.t === 'roll' && eq([...a.ids].sort(), [dice[0], dice[2]].sort()), 'roll of every die he may handle');
  await check('Bob', `roll ${dice[0]} ${dice[2]}`, (a) => eq(a, { t: 'roll', ids: [dice[0], dice[2]] }), '{t: roll, ids}');
  await check('Bob', `face ${I.wheel} 1`, (a) => eq(a, { t: 'face', id: I.wheel, f: 1 }), '{t: face, id, f}');
  await check('Bob', 'take Gold --hand', (a) => eq(a, { t: 'take', id: I.gold, hand: true }), '{t: take, id, hand: true}');
  await check('Bob', 'take Gold 650 750', (a) => keys(a, ['t', 'id', 'x', 'y', 'hand']) && a.id === I.gold && a.x === 650 && a.y === 750 && !a.hand, 'a take at 650,750');
  await check('Bob', 'pull Tiles --hand', (a) => keys(a, ['t', 'id', 'hand', 'pick']) && a.id === I.bag && a.hand === true && Number.isInteger(a.pick), 'a pull into the hand');
  await check('Bob', `split ${man2} 1 1100 900`, (a) => eq(a, { t: 'split', id: man2, n: 1, x: 1100, y: 900 }), '{t: split, id, n, x, y}');
  await check('Bob', `bag ${man1} Tiles`, (a) => eq(a, { t: 'toBag', id: man1, bag: I.bag }), '{t: toBag, id, bag}');
  await check('Bob', `lock ${I.wheel}`, (a) => eq(a, { t: 'lock', id: I.wheel, on: true }), '{t: lock, id, on: true}');
  await check('Bob', `unlock ${I.wheel}`, (a) => eq(a, { t: 'lock', id: I.wheel, on: false }), '{t: lock, id, on: false}');
  await check('Bob', `claim ${I.wheel}`, (a) => eq(a, { t: 'owner', id: I.wheel, to: bobPid }), '{t: owner, id, to: him}');
  ok(await until(async () => (await view()).items[I.wheel]?.owner === bobPid, 5000), 'Bob owns the wheel');
  await check('Bob', `release ${I.wheel}`, (a) => eq(a, { t: 'owner', id: I.wheel, to: null }), '{t: owner, id, to: null}');

  section('a piece in the hand; seats and watchers, from the terminal');
  const hands = {};
  for (const name of ['Alice', 'Bob']) {
    ok(await until(() => snap(name)?.hand?.length === 1, 10000), `${name} holds one tile`);
    const e = snap(name).hand[0];
    ok(eq(e, { idx: 0, key: `t:${ref('tile')}:0`, kind: 'piece', name: 'Tile', label: 'T' }), `${name}'s hand entry is {idx, key "t:<typeRef>:<f>", kind: piece, name, label} (${json(e)})`);
    hands[name] = (await type(R[name], 'hand', (ls) => ls.some((l) => /^ +0\. /.test(l)))).find((l) => /^ +0\. /.test(l));
  }
  ok(hands.Alice && hands.Alice === hands.Bob && hands.Alice.includes('T') && hands.Alice.includes('Tile'), `both REPLs print the piece alike ("${hands.Alice}")`);
  await check('Bob', 'seat -', (a) => eq(a, { t: 'seat', watch: true }), '{t: seat, watch: true}');
  ok(await until(() => { const s = snap('Bob'); return s?.me?.seat === null && !('seatId' in s.me) && s.players.find((p) => p.id === bobPid)?.watching === true && s.seats[1].player === null; }, 10000),
    `Bob watches: me {seat: null}, players[…].watching, the seat Black is free (${json(snap('Bob')?.me)})`);
  const watching = (ls) => ls.some((l) => /Bob\b.*\(watching\)/.test(l) && !l.includes('[black]'));
  const wa = await players('Alice', watching), wb = await players('Bob', watching);
  ok(watching(wa) && watching(wb) && json(wa.sort()) === json(wb.sort()), `"players" marks Bob "(watching)" in both REPLs (${json(wb)})`);
  await check('Bob', 'seat +', (a) => eq(a, { t: 'seat', sit: true }), '{t: seat, sit: true}');
  await check('Bob', 'seat black', (a) => eq(a, { t: 'seat', id: 'black' }), '{t: seat, id}');
  ok(await until(() => snap('Bob')?.me?.seatId === 'black', 10000), 'Bob sits as Black again');

  section('the bar and a double-click offer nothing the host would refuse: a locked board, another player\'s die');
  /** A screen point on item `id` in `page` where it is the topmost item (null if there is none). */
  const spotOn = (page, x) => page.evaluate((x) => {
    const el = document.querySelector(`.item[data-id="${x}"]`), r = el.getBoundingClientRect();
    for (let fy = 0.1; fy < 1; fy += 0.1) {
      for (let fx = 0.1; fx < 1; fx += 0.1) {
        const p = [r.left + fx * r.width, r.top + fy * r.height];
        if (document.elementFromPoint(...p)?.closest('.item') === el) return p;
      }
    }
    return null;
  }, x);
  const kUI = Math.max(0, ...(await probed()).map((e) => e.k));
  const barHidden = (page) => page.evaluate(() => document.getElementById('action-bar').classList.contains('hidden'));
  const onBoard = await spotOn(host, I.board), onDie = await spotOn(bob, dice[1]);
  ok(onBoard && onDie, 'a free spot on the board (Alice), and on the die White owns (Bob)');
  await host.mouse.dblclick(...onBoard);
  await bob.mouse.dblclick(...onDie);
  await h.sleep(700);
  await host.mouse.click(...onBoard); // (a click toggles the selection: the double-click's two left it off)
  await bob.mouse.click(...onDie);
  const selected = (page, x) => page.evaluate((x) => document.querySelector(`.item[data-id="${x}"]`).classList.contains('selected'), x);
  // (Phase 2B's full bar: the host may unlock a board and give it away, nothing more — it isn't hers to move, turn or remove)
  const cmds = (page) => page.evaluate(() => [...document.querySelectorAll('#action-bar [data-cmd]')].map((b) => b.dataset.cmd).join());
  ok(await selected(host, I.board) && await cmds(host) === 'lock,give', `Alice's click selects the locked board, and its bar offers only what the host may do: unlock it, give it (${await cmds(host)})`);
  ok(await selected(bob, dice[1]) && await barHidden(bob), "Bob's selects White's die, and its bar shows nothing");
  await h.sleep(1500);
  const sentUI = (await probed()).filter((e) => e.k > kUI).map((e) => e.a);
  ok(!sentUI.length, `nothing was sent — no flip of the board, no roll of her die (${json(sentUI)})`);

  section('`roll all` over more than 20 dice says so, and sends nothing');
  await loadBox(host, { name: 'Dice tray', imgs: [], types: { d: { kind: 'die', name: 'Die' } }, setup: [{ piece: 'd', count: 21, spread: [60, 0], at: [60, 1060] }] }, { clear: false });
  const k21 = Math.max(0, ...(await probed()).map((e) => e.k));
  const said = await Promise.all(['Alice', 'Bob'].map(async (name) => (await type(R[name], 'roll all', (ls) => ls.some((l) => /roll all: that is \d+ dice — at most 20 per roll/.test(l)))).find((l) => /at most 20/.test(l))));
  ok(said.every((l) => /^ {2}✉ error: roll all: that is 2\d dice — at most 20 per roll, name them$/.test(l || '')), `both REPLs print the tab's refusal (${json(said)})`);
  await h.sleep(1500);
  ok(!(await probed()).some((e) => e.k > k21 && e.a.t === 'roll'), 'and no roll reached the host');

  for (const k of kids) k.kill();
  await env.done();
})().catch((e) => { for (const k of kids) k.kill(); h.crash(e); });
