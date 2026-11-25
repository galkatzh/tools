// Phase 4A, the terminal bridges (spec §4i, minus 4B's group): cli.js and
// cli.py in parity. To a fake tab: `boxes` prints the snapshot's box list in
// the same words in both REPLs; `setup <box> [--keep] [--rules]` and `reset`
// send exactly their commands (a box named in words, too); the help lists
// them the same; the Bridge API's setup() and reset(). Then real tabs, Alice
// hosting on cli.js and Bob on cli.py: the snapshot's `boxes` ({id, name,
// types, rules, src, builtin}) on both, `lastSetup` the host's alone; the
// host's terminal sets a box up (by its name), resets it, and asks for a
// box's rules — which still wait for the host's click on the page (the trust
// dialog); a guest's setup and reset are said to be the host's; a box that
// isn't there is said so; a box that only its rules lay out wants --rules.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const { until } = require('./p1-lib');
const { LANGS, killAll, repl, type, push, sent, json, eq, api, viaApi } = require('./cli-lib');

const FX = path.join(__dirname, 'fixtures');
const BOXES = [
  { id: 'ab12cd34', name: 'Harbor Run', types: 4, rules: false, src: 'host', builtin: false },
  { id: 'cd34ef56', name: 'Beacon Watch', types: 2, rules: true, src: 'upload', builtin: false },
  { id: 'ef56ab12', name: 'Draughts', types: 1, rules: false, src: 'host', builtin: true },
  { id: '0011aabb', name: 'Proof', types: 3, rules: true, src: 'script', builtin: false },
];
const FAKE = { pid: 'p1', name: 'Fake', role: 'host', room: 'r', seq: 1, table: { shape: 'rect', w: 1400, h: 1200 }, seats: null, me: { seat: 90 },
  players: [], buttons: [], log: [], msgs: [], hand: [], items: [], asks: [], hint: null, secret: null, strict: false, boxes: BOXES, lastSetup: 'cd34ef56' };
const LIST = [
  '  [ab12cd34] Harbor Run — 4 piece types · the host\'s',
  '  [cd34ef56] Beacon Watch — 2 piece types · 📜 rules · a guest\'s upload · set up',
  '  [ef56ab12] Draughts — 1 piece type · built in',
  '  [0011aabb] Proof — 3 piece types · 📜 rules · made by the rules',
];
/** Each new REPL command and exactly what it must send. */
const COMMANDS = [
  ['setup ab12cd34', { t: 'setup', box: 'ab12cd34', keep: false, rules: false }],
  ['setup Harbor Run --keep', { t: 'setup', box: 'Harbor Run', keep: true, rules: false }],
  ['setup --rules Beacon Watch', { t: 'setup', box: 'Beacon Watch', keep: false, rules: true }],
  ['reset', { t: 'reset' }],
];
const API = [
  [['setup', 'Harbor Run'], { t: 'setup', box: 'Harbor Run', keep: false, rules: false }],
  [['setup', 'cd34ef56', true, true], { t: 'setup', box: 'cd34ef56', keep: true, rules: true }],
  [['reset'], { t: 'reset' }],
];

(async () => {
  const env = await h.start();

  section('the REPLs: `boxes` in the same words, setup and reset as their commands (a fake tab), the same help');
  const fakes = await Promise.all(LANGS.map((l) => repl(l, 'http://x/#room~ab~cd')));
  for (const b of fakes) {
    await push(b, FAKE);
    ok(await until(() => b.c.buf.includes('tab connected'), 5000, 100), `${b.lang}: the fake tab is connected`);
  }
  const help = await Promise.all(fakes.map((b) => type(b, 'help', (ls) => ls.some((l) => l.startsWith('  quit')))));
  const helpText = help.map((ls) => ls.slice(ls.findIndex((l) => l.startsWith('commands:')), ls.findIndex((l) => l.startsWith('  quit')) + 1).join('\n'));
  ok(helpText.every((t) => ['boxes', 'setup <box> [--keep] [--rules]', 'reset'].every((w) => t.includes(`  ${w} `))) && helpText[0] === helpText[1], "both REPLs' help lists boxes, setup and reset, word for word the same");
  const lists = await Promise.all(fakes.map((b) => type(b, 'boxes', (ls) => ls.some((l) => l.startsWith('  [0011aabb]')))));
  for (const [k, b] of fakes.entries()) {
    const got = lists[k].filter((l) => l.startsWith('  ['));
    ok(json(got) === json(LIST), `${b.lang}: "boxes" lists each box — size, 📜, where it comes from, the one set up (${json(got)})`);
  }
  for (const [line, want] of COMMANDS) {
    const got = await Promise.all(fakes.map((b) => sent(b, () => b.c.stdin.write(line + '\n'))));
    ok(got.every((g) => g?.length === 1 && eq(g[0], want)), `"${line}" sends ${json(want)} from both (${got.map(json).join(' / ')})`);
  }
  const usage = await Promise.all(fakes.map((b) => type(b, 'setup --keep', (ls) => ls.some((l) => l.includes('setup <box> [--keep] [--rules]')), 3000)));
  ok(usage.every((ls) => ls.some((l) => l.includes('setup <box> [--keep] [--rules] — see "boxes"'))), '"setup" without a box prints its usage in both');
  await Promise.all(fakes.map((b) => push(b, { ...FAKE, boxes: [] })));
  const none = await Promise.all(fakes.map((b) => type(b, 'boxes', (ls) => ls.includes('(no game boxes on this table)'), 5000)));
  ok(none.every((ls) => ls.includes('(no game boxes on this table)')), 'no box: both say so');

  section('the Bridge API: setup and reset');
  const apis = await Promise.all(LANGS.map(api));
  const got = await Promise.all(apis.map((b) => viaApi(b, API.map(([c]) => c))));
  for (const [k, [[call, ...args], want]] of API.entries()) {
    ok(got.every((g) => eq(g?.[k], want)), `${call}(${args.map(json).join(', ')}) sends ${json(want)} from both (${got.map((g) => json(g?.[k])).join(' / ')})`);
  }

  section('real tabs: Alice (host) on cli.js, Bob (guest) on cli.py; two boxes on the table');
  const { host, guest: bob } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const snaps = {}, R = {};
  for (const [page, name, lang] of [[host, 'Alice', 'node'], [bob, 'Bob', 'python']]) {
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
  const snap = (name) => { try { return JSON.parse(snaps[name] || 'null'); } catch (err) { console.error(err); return null; } };
  await host.click('#box-btn');
  await host.setChecked('#box-now', false);
  for (const files of [fs.readdirSync(path.join(FX, 'harbor')).map((f) => path.join(FX, 'harbor', f)), ['game.json', 'rules.js'].map((f) => path.join(FX, 'beacon', f))]) {
    await host.evaluate(() => { document.getElementById('box-progress').textContent = ''; });
    await host.setInputFiles('#box-files', files);
    await host.waitForFunction(() => /^Added/.test(document.getElementById('box-progress').textContent), null, { timeout: 20000 });
  }
  await host.evaluate(() => document.getElementById('box-dialog').close());
  const st = await host.evaluate(() => window.__ct.hostState()), id = (n) => Object.keys(st.boxes).find((k) => st.boxes[k].name === n);
  const want = [
    { id: id('Harbor Run'), name: 'Harbor Run', types: 4, rules: false, src: 'host', builtin: false },
    { id: id('Beacon Watch'), name: 'Beacon Watch', types: 2, rules: true, src: 'host', builtin: false },
  ];
  ok(await until(() => eq(snap('Alice')?.boxes, want) && eq(snap('Bob')?.boxes, want), 20000, 200), `both snapshots list the boxes: ${json(snap('Bob')?.boxes)}`);
  ok(snap('Alice').lastSetup === null && snap('Bob').lastSetup === null, 'nothing set up yet: lastSetup null');
  const printed = (n, from, re) => R[n].c.buf.slice(from).split('\n').filter((l) => re.test(l));
  let m = R.Alice.c.buf.length;
  R.Alice.c.stdin.write('setup harbor run\n');
  ok(await until(() => snap('Alice')?.lastSetup === id('Harbor Run') && snap('Bob')?.items.length === 7, 20000, 200) && await until(() => printed('Alice', m, /▸ Alice set up «Harbor Run» \(\d+ items\)/).length === 1, 10000, 100),
    `Alice's "setup harbor run" (its name, any case) sets it up: the log line in her REPL, lastSetup ${snap('Alice')?.lastSetup}; Bob's snapshot shows ${snap('Bob')?.items.length} items, lastSetup ${snap('Bob')?.lastSetup}`);
  ok(snap('Bob').lastSetup === null, "lastSetup is the host's to know");
  const boat = snap('Alice').items.find((it) => it.type === 'Boat' && it.owner === 'Alice');
  await host.evaluate((i) => window.__ct.act({ t: 'move', id: i, x: 50, y: 50 }), boat.id);
  m = R.Alice.c.buf.length;
  R.Alice.c.stdin.write('reset\n');
  ok(await until(() => printed('Alice', m, /▸ Alice reset «Harbor Run»/).length === 1, 10000, 100) && await until(() => snap('Alice').items.find((it) => it.type === 'Boat' && it.owner === 'Alice')?.x === boat.x, 10000, 100), '"reset" lays it out again: the boat back where it was');
  for (const line of ['setup Harbor Run', 'reset']) {
    const outs = await type(R.Bob, line, (ls) => ls.some((l) => /✉ error: (setup|reset): only the host/.test(l)), 5000);
    ok(outs.some((l) => l.includes(`✉ error: ${line.split(' ')[0]}: only the host ${line === 'reset' ? 'resets a game' : 'sets up a game'}`)), `Bob's "${line}": the host's alone, said in his REPL`);
  }
  const none2 = await type(R.Alice, 'setup Nowhere', (ls) => ls.some((l) => /✉ error: no such game box: Nowhere/.test(l)), 5000);
  ok(none2.some((l) => l.includes('✉ error: no such game box: Nowhere — see "boxes"')), 'a box that isn\'t there is said so');
  m = R.Alice.c.buf.length;
  R.Alice.c.stdin.write('setup Beacon Watch --rules\n');
  ok(await until(() => printed('Alice', m, /✉ setup: «Beacon Watch» has rules — confirm them on the page/).length === 1, 10000, 100), "the terminal asks for a box's rules: they wait for the host's click on the page");
  ok(await host.waitForSelector('#box-ask[open][data-kind="trust"]', { timeout: 10000 }).then(() => true, () => false), 'the trust dialog shows on the host\'s page');
  await host.click('#box-ask-btns button[value="enable"]');
  ok(await until(() => snap('Alice')?.rules === 'Beacon Watch' && snap('Alice').lastSetup === id('Beacon Watch'), 20000, 200), 'Enable rules there: set up, its rules running (the snapshot\'s rules: "Beacon Watch")');
  // A box without a layout is set up by its rules alone: without --rules the terminal refuses it, saying so (D213)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-cli-'));
  fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify({ name: 'Laid by its rules', pieces: [{ id: 'gem', kind: 'token', faces: ['G'] }], rules: 'rules.js' }));
  fs.writeFileSync(path.join(dir, 'rules.js'), "({ name: 'Laid by its rules' })");
  await host.click('#box-btn');
  await host.setChecked('#box-now', false);
  await host.evaluate(() => { document.getElementById('box-progress').textContent = ''; });
  await host.setInputFiles('#box-files', ['game.json', 'rules.js'].map((f) => path.join(dir, f)));
  await host.waitForFunction(() => /^Added/.test(document.getElementById('box-progress').textContent), null, { timeout: 20000 });
  await host.evaluate(() => document.getElementById('box-dialog').close());
  fs.rmSync(dir, { recursive: true, force: true });
  const lone = await type(R.Alice, 'setup Laid by its rules', (ls) => ls.some((l) => /✉ error: setup: «Laid by its rules» has no layout/.test(l)), 5000);
  ok(lone.some((l) => l.includes('✉ error: setup: «Laid by its rules» has no layout — its rules lay the table out: add --rules')) && snap('Alice').lastSetup === id('Beacon Watch'),
    'a box with rules and no layout, set up without --rules: refused in the terminal, nothing cleared');
  // Set up with --rules (Enable on the page), its rules then switched off: "reset" would clear the table for nothing — refused, saying so (D215)
  R.Alice.c.stdin.write('setup Laid by its rules --rules\n');
  await host.waitForSelector('#box-ask[open][data-kind="trust"]', { timeout: 10000 });
  await host.waitForTimeout(600); // (ASK_ARM_MS: the buttons arm after half a second)
  await host.click('#box-ask-btns button[value="enable"]');
  const lid = await host.evaluate(() => Object.entries(window.__ct.hostState().boxes).find(([, b]) => b.name === 'Laid by its rules')[0]);
  ok(await until(() => snap('Alice')?.lastSetup === lid && snap('Alice').rules === 'Laid by its rules', 20000, 200), '"setup Laid by its rules --rules", enabled on the page: set up, its rules running');
  await host.evaluate(() => window.__ct.act({ t: 'setRules', enabled: false }));
  ok(await until(() => snap('Alice')?.rules == null, 10000, 100), `its rules switched off (the snapshot's rules: ${snap('Alice')?.rules})`);
  const stuck = await type(R.Alice, 'reset', (ls) => ls.some((l) => /✉ error: reset: /.test(l)), 5000);
  ok(stuck.some((l) => l.includes("✉ error: reset: «Laid by its rules» is laid out by its rules, which aren't running: Set up starts them again")) && snap('Alice').lastSetup === lid,
    `"reset" with its rules off: refused in the terminal, still the box set up (${stuck.filter((l) => /error/.test(l)).join(' | ')})`);
  killAll();
  await env.done();
})().catch((e) => { killAll(); h.crash(e); });
