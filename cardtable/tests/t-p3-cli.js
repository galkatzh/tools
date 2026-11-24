// Phase 3C, the terminal bridges (spec §3i), cli.js and cli.py in parity: the
// REPLs' asks / answer / select (to a fake tab: exactly their commands, their
// usage lines, the same help), the Bridge API's answer and select; then real
// tabs — Alice hosts on cli.js, Bob plays on cli.py — under a strict probe
// script (a board, four stones, onSelect hints a stone's neighbours, onAnswer
// records every answer in t.public.ans, a host press of "run" carries code
// its onAction runs): the snapshot's asks (an option's label only), hint,
// secret and top-level strict (`rules` still the script's name); each new
// ask, hint and secret printed as it arrives — the tab's one text, the same
// in both REPLs ("❓ promo: Promote to [0] ♕ [1] ♖ [2] ♗ [3] ♘"); `asks` on
// demand; `answer` turned by the tab into what the host checks, for every
// form (an option by its label in any case or by its number, an item id, an
// address, hand indices, a number); what isn't offered, or no question, said
// as an error with nothing sent.
const h = require('./h');
const { ok, section } = h;
const { until } = require('./p1-lib');
const { LANGS, killAll, repl, type, push, sent, json, eq, api, viaApi } = require('./cli-lib');

const FAKE = { pid: 'p1', name: 'Fake', role: 'guest', room: 'r', seq: 1, table: { shape: 'rect', w: 1400, h: 1200 }, seats: null, me: { seat: 90 },
  players: [], buttons: [], log: [], msgs: [], hand: [], items: [], asks: [], hint: null, secret: null, strict: false };
/** Each new REPL command and exactly what it must send. */
const COMMANDS = [
  ['asks', { t: 'asks' }],
  ['answer promo 3', { t: 'answer', id: 'promo', v: '3' }],
  ['answer colour Light blue', { t: 'answer', id: 'colour', v: 'Light blue' }],
  ['answer two 0,3', { t: 'answer', id: 'two', v: '0,3' }],
  ['select ab12cd34', { t: 'select', id: 'ab12cd34' }],
];
const USAGE = [['answer promo', 'answer <id> <value>'], ['select', 'select <id>']];
const API = [
  [['answer', 'promo', 3], { t: 'answer', id: 'promo', v: 3 }],
  [['answer', 'two', [0, 3]], { t: 'answer', id: 'two', v: [0, 3] }],
  [['answer', 'colour', 'Red'], { t: 'answer', id: 'colour', v: 'Red' }],
  [['select', 'x1'], { t: 'select', id: 'x1' }],
];
/** The probe (strict, so the snapshot's `strict` is true). */
const PROBE = `({ name: 'CLI probe', strict: true, allow: ['move', 'draw'],
  setup(t) {
    t.public.ans = t.public.ans || [];
    if (t.data.built) return;
    t.data.built = true;
    const box = t.newBox({ name: 'CLI box', pieces: [
      { id: 'board', kind: 'board', w: 372, h: 372, faces: [{ color: '#557755' }], grid: { type: 'square', cols: 8, rows: 8, cell: 44, x: 10, y: 10, draw: 'checker', labels: 'chess' } },
      { id: 'stone', kind: 'token', w: 40, stack: 'none', faces: [{ label: 'S', color: '#f8fafc' }] },
    ] });
    t.spawn(box + '/board', { at: { x: 200, y: 464 } });
    for (const a of ['c3', 'd4', 'e5', 'f6']) t.spawn(box + '/stone', { at: a });
  },
  onSelect(t, p, id) { const w = t.where(id); if (w) t.hint(p, { spaces: t.neighbors(w), items: [id] }); },
  onAnswer(t, p, id, v) { t.public.ans = t.public.ans.concat([{ p, id, v }]).slice(-30); },
  onAction(t, a) { if (a.t === 'rulesBtn' && a.id === 'run') new Function('t', 'a', '"use strict";\\n' + a.code)(t, a); },
  buttons: (t) => [{ id: 'run', label: 'Run', pid: t.hostId }],
})`;

(async () => {
  const env = await h.start();

  section('the REPLs send asks, answer and select as their commands (a fake tab), with the same help');
  const fakes = await Promise.all(LANGS.map((l) => repl(l, 'http://x/#room~ab~cd')));
  for (const b of fakes) {
    await push(b, FAKE);
    ok(await until(() => b.c.buf.includes('tab connected'), 5000, 100), `${b.lang}: the fake tab is connected`);
  }
  const help = await Promise.all(fakes.map((b) => type(b, 'help', (ls) => ls.some((l) => l.startsWith('  quit')))));
  const helpText = help.map((ls) => ls.slice(ls.findIndex((l) => l.startsWith('commands:')), ls.findIndex((l) => l.startsWith('  quit')) + 1).join('\n'));
  ok(helpText.every((t) => ['asks', 'answer <id> <value>', 'select <id>'].every((w) => t.includes(`  ${w} `))) && helpText[0] === helpText[1], 'both REPLs\' help lists asks, answer and select, word for word the same');
  for (const [line, want] of COMMANDS) {
    const got = await Promise.all(fakes.map((b) => sent(b, () => b.c.stdin.write(line + '\n'))));
    ok(got.every((g) => g?.length === 1 && eq(g[0], want)), `"${line}" sends ${json(want)} from both (${got.map(json).join(' / ')})`);
  }
  for (const [line, usage] of USAGE) {
    const outs = await Promise.all(fakes.map((b) => type(b, line, (ls) => ls.some((l) => l.includes(usage)), 3000)));
    ok(outs.every((ls) => ls.some((l) => l.includes(usage))), `"${line}" prints its usage ("${usage}") in both`);
  }
  const after = await Promise.all(fakes.map((b) => sent(b, () => b.c.stdin.write('chat after\n'))));
  ok(after.every((g) => eq(g, [{ t: 'chat', msg: 'after' }])), `a command missing its arguments sent nothing (${json(after)})`);

  section('the Bridge API: answer and select');
  const apis = await Promise.all(LANGS.map(api));
  const got = await Promise.all(apis.map((b) => viaApi(b, API.map(([c]) => c))));
  for (const [k, [[call, ...args], want]] of API.entries()) {
    ok(got.every((g) => eq(g?.[k], want)), `${call}(${args.map(json).join(', ')}) sends ${json(want)} from both (${got.map((g) => json(g?.[k])).join(' / ')})`);
  }

  section('real tabs: Alice (host) on cli.js, Bob (guest) on cli.py, under a strict probe');
  const { host, guest: bob } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => `${location.origin}${location.pathname}${location.hash}`);
  const alice = await host.evaluate(() => localStorage.getItem('ct-pid')), bobPid = await bob.evaluate(() => localStorage.getItem('ct-pid'));
  const snaps = {};
  const R = {};
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
  await host.waitForFunction(() => Object.values(window.__ct.view().players).filter((p) => p.online).length === 2, null, { timeout: 30000 });
  ok((await host.evaluate((c) => window.__ct.act({ t: 'setRules', code: c, enabled: true }), PROBE)).ok, 'the host enables the CLI probe');
  const snap = (name) => { try { return JSON.parse(snaps[name] || 'null'); } catch (err) { console.error(err); return null; } };
  const ready = (s) => s?.rules === 'CLI probe' && s.strict === true && s.items.filter((it) => it.at).length === 4;
  ok(await until(() => ready(snap('Alice')) && ready(snap('Bob')), 20000, 200), 'both snapshots: rules "CLI probe" (a name, as ever), strict: true at the top, four stones with addresses');
  ok(['Alice', 'Bob'].every((n) => eq(snap(n).asks, []) && snap(n).hint === null && snap(n).secret === null), 'no asks, no hint, no secret yet');
  const stone = (a) => snap('Bob').items.find((it) => it.at === a)?.id;
  const run = (code) => host.evaluate((c) => window.__ct.act({ t: 'rulesBtn', id: 'run', code: c }), code);
  const ans = (id) => host.evaluate((id) => JSON.parse(JSON.stringify((window.__ct.view().rules?.public?.ans || []).filter((x) => x.id === id).at(-1) || null)), id);
  const answered = (id) => until(async () => !!(await ans(id)), 10000, 150);
  /** Lines `name`'s REPL printed from character `from` on that match re. */
  const printed = (name, from, re) => R[name].c.buf.slice(from).split('\n').map((l) => l.replace(/^(?:🂡 > )+/, '')).filter((l) => re.test(l));
  const mark = () => ({ Alice: R.Alice.c.buf.length, Bob: R.Bob.c.buf.length });

  section('select: the hint comes back in the snapshot, and the REPL prints it');
  let m = mark();
  R.Bob.c.stdin.write(`select ${stone('d4')}\n`);
  ok(await until(() => snap('Bob')?.hint?.items?.[0] === stone('d4'), 10000, 150), `Bob's "select" (cli.py): his snapshot's hint (${json(snap('Bob')?.hint)})`);
  ok(eq([...snap('Bob').hint.spaces].sort(), ['c4', 'd3', 'd5', 'e4']) && snap('Alice').hint === null, "the stone's four neighbours; Alice's snapshot has no hint");
  ok(await until(() => printed('Bob', m.Bob, /✉ 💡 hint: /).length === 1, 5000, 100), `his REPL prints it (${json(printed('Bob', m.Bob, /💡/))})`);

  section('asks: printed as they arrive, the same text in both REPLs; `asks` lists them; `answer` for every form');
  m = mark();
  const both = (code) => run(`for (const p of [t.hostId, ${json(bobPid)}]) { ${code} }`);
  await both("t.ask(p, { id: 'promo', prompt: 'Promote to', options: ['♕', '♖', '♗', '♘'] });");
  const PROMO = '  ✉ ❓ promo: Promote to [0] ♕ [1] ♖ [2] ♗ [3] ♘';
  ok(await until(() => ['Alice', 'Bob'].every((n) => printed(n, m[n], /❓ promo/).length === 1), 10000, 150), 'each REPL printed the new ask once, by itself');
  ok(['Alice', 'Bob'].every((n) => printed(n, m[n], /❓ promo/)[0] === PROMO), `"${PROMO.trim()}" in both (${json(printed('Bob', m.Bob, /❓/))})`);
  ok(['Alice', 'Bob'].every((n) => eq(snap(n).asks, [{ id: 'promo', prompt: 'Promote to', options: ['♕', '♖', '♗', '♘'] }])), `the snapshot's asks carry the labels only (${json(snap('Bob').asks)})`);
  await both(`t.draw(p, t.piles()[0].id, 3);
    t.ask(p, { id: 'which', prompt: 'Which stone?', pick: 'item', among: [${json(stone('c3'))}, ${json(stone('f6'))}] });
    t.ask(p, { id: 'where', prompt: 'Where to?', pick: 'space', among: ['b2', 'g7'] });
    t.ask(p, { id: 'two', prompt: 'Pass two cards', pick: 'hand', count: 2 });
    t.ask(p, { id: 'num', prompt: 'How many?', pick: 'number', min: 2, max: 5 });`);
  ok(await until(() => ['Alice', 'Bob'].every((n) => snap(n)?.asks?.length === 5 && snap(n).hand.length === 3), 10000, 150), 'five asks each, and three cards');
  const s = snap('Bob');
  ok(eq(s.asks.slice(1), [
    { id: 'which', prompt: 'Which stone?', pick: 'item', among: [stone('c3'), stone('f6')] },
    { id: 'where', prompt: 'Where to?', pick: 'space', among: ['b2', 'g7'] },
    { id: 'two', prompt: 'Pass two cards', pick: 'hand', count: 2 },
    { id: 'num', prompt: 'How many?', pick: 'number', min: 2, max: 5 },
  ]), `the snapshot's asks, one per form (${json(s.asks.slice(1))})`);
  const lists = await Promise.all(['Alice', 'Bob'].map((n) => type(R[n], 'asks', (ls) => ls.filter((l) => /✉ ❓ /.test(l)).length >= 5)));
  const shown = lists.map((ls) => ls.filter((l) => /✉ ❓ /.test(l)));
  ok(json(shown[0]) === json(shown[1]) && shown[0].length === 5, '"asks" lists all five, the same text in both REPLs');
  ok(json(shown[1].slice(1)) === json([
    `  ✉ ❓ which: Which stone? (an item: ${stone('c3')}, ${stone('f6')})`,
    '  ✉ ❓ where: Where to? (a spot: b2, g7)',
    '  ✉ ❓ two: Pass two cards (2 of your hand cards, by index, comma-separated)',
    '  ✉ ❓ num: How many? (a number from 2 to 5)',
  ]), `each says what to answer (${json(shown[1].slice(1))})`);
  // Bob answers on cli.py, Alice on cli.js
  const hands = { Alice: snap('Alice').hand, Bob: snap('Bob').hand };
  for (const [name, pid, lines, want] of [
    ['Bob', bobPid, ['answer promo ♘', `answer which ${stone('f6')}`, 'answer where g7', 'answer two 2,0', 'answer num 4'], ['♘', stone('f6'), 'g7', [2, 0], 4]],
    ['Alice', alice, ['answer promo 1', `answer which ${stone('c3')}`, 'answer where B2', 'answer two 1 2', 'answer num 2'], ['♖', stone('c3'), 'b2', [1, 2], 2]],
  ]) {
    for (const [k, line] of lines.entries()) {
      const id = line.split(' ')[1];
      R[name].c.stdin.write(`${line}\n`);
      const got = await until(async () => (await ans(id))?.p === pid && (await host.evaluate(([id, p]) => window.__ct.view().rules.public.ans.filter((x) => x.id === id && x.p === p).length, [id, pid])) === 1, 10000, 150);
      const a = await host.evaluate(([id, p]) => JSON.parse(JSON.stringify(window.__ct.view().rules.public.ans.find((x) => x.id === id && x.p === p))), [id, pid]);
      const v = Array.isArray(want[k]) ? want[k].map((j) => { const c = hands[name][j]; return { d: c.key.split(':')[0], i: +c.key.split(':')[1] }; }) : want[k];
      ok(got && eq(a?.v, v), `${R[name].lang} "${line}" → onAnswer gets ${json(v)} (${json(a?.v)})`);
    }
  }
  ok(await until(() => ['Alice', 'Bob'].every((n) => snap(n).asks.length === 0), 10000, 150), 'no asks left in either snapshot');

  section("what isn't offered — or no question at all — is said, and nothing is sent");
  await both("t.ask(p, { id: 'pair', prompt: 'Heads or tails?', options: ['Heads', 'Tails'] }); t.ask(p, { id: 'n2', prompt: 'Pick', pick: 'number', min: 1, max: 3 });");
  ok(await until(() => ['Alice', 'Bob'].every((n) => snap(n)?.asks?.length === 2), 10000, 150), 'two new asks each');
  const said = {};
  for (const [line, re] of [['answer pair Edge', /✉ error: pair: answer \[0\] Heads \[1\] Tails$/], ['answer n2 9', /✉ error: n2: answer a whole number from 1 to 3$/], ['answer nope 1', /✉ error: no question "nope" waits for you — see "asks"$/]]) {
    const outs = await Promise.all(['Alice', 'Bob'].map((n) => type(R[n], line, (ls) => ls.some((l) => re.test(l)), 5000)));
    said[line] = outs.map((ls) => ls.find((l) => re.test(l)));
    ok(said[line].every(Boolean) && said[line][0] === said[line][1], `"${line}": "${(said[line][0] || '').trim()}" in both`);
  }
  await h.sleep(800);
  ok(!(await ans('pair')) && !(await ans('n2')) && ['Alice', 'Bob'].every((n) => snap(n).asks.length === 2), 'no answer reached the host; both asks still wait');
  R.Bob.c.stdin.write('answer pair heads\n');
  ok(await answered('pair') && (await ans('pair')).v === 'Heads', 'a label in another case answers (heads → Heads)');

  section('t.secret: in the snapshot, printed once');
  m = mark();
  await run(`t.secret[${json(bobPid)}] = { text: 'You are the spy.', role: 'spy' };`);
  ok(await until(() => eq(snap('Bob')?.secret, { text: 'You are the spy.', role: 'spy' }), 10000, 150) && snap('Alice').secret === null, `Bob's snapshot has his whole t.secret entry, Alice's none (${json(snap('Bob')?.secret)})`);
  ok(await until(() => printed('Bob', m.Bob, /✉ 🔒 for you: You are the spy\.$/).length === 1, 5000, 100) && !printed('Alice', m.Alice, /🔒/).length, 'his REPL prints its text; Alice\'s prints nothing');

  killAll();
  await env.done();
})().catch((e) => { killAll(); h.crash(e); });
