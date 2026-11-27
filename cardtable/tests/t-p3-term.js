// Phase 3C, the terminal (spec §3i, D158), cli.js and cli.py side by side:
// Alice hosts a strict "Term probe" in a browser; Bob is a bot on cli.js and
// Carol a bot on cli.py (each a REPL started with --as, whose tab joins as
// that player), asked the very same questions, so the two REPLs can be held
// line for line against each other.
//   The snapshot (what each tab pushes to its bridge): asks with an option's
//   label only, a hand pick's count, items' `at`; hint, secret; `strict` at
//   the top while `rules` stays the script's name; with the rules off, no
//   asks and strict false, the secret kept; on again, the asks back.
//   New asks print by themselves, as they arrive (nothing typed): the
//   spec's "❓ id: prompt [0] … [1] …" for options, what to answer for a
//   pick, the same lines in both REPLs, no control character on the
//   terminal; `asks` lists them, the same in both.
//   `answer` in every form and several spellings (an option's number, its
//   label in another case and with a space, an item id, a spot in display
//   and in qualified form, hand indices, a negative number): onAnswer gets
//   spec §3c's value; what isn't offered — or no question — is said as the
//   same error in both, and no `answer` leaves the tab.
//   `select`: the hint in that bot's snapshot alone, printed ("💡 hint");
//   t.secret: each bot's whole entry in its own snapshot, printed ("🔒").
//   The Bridge API with real tabs, in both languages: select, answer (a
//   number, a list of hand indices, a label, a spot) and place.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const { until } = require('./p1-lib');
const P = require('./p2t-lib');
const S = require('./p3-lib');
const { APP, child, killAll, linesOf, type, api, json, eq } = require('./cli-lib');

/** The probe: strict (moves kept); an 8 × 8 board, stones on c3, d4, e5 and
 *  f6, a deck. onSelect hints the piece and its four neighbours; onAnswer
 *  records each answer in t.public.ans; a host press of "run" carries code
 *  that onAction runs (the test's game master). setup runs once. */
const TERM = `({ name: 'Term probe', strict: true, allow: ['move'],
  setup(t) {
    if (t.data.built) return;
    t.data.built = true;
    t.setTable({ shape: 'rect', w: 1200, h: 1200 });
    t.setSeats(null);
    const box = t.newBox({ name: 'Term', pieces: [
      { id: 'board', kind: 'board', w: 840, h: 840, faces: [{ color: '#5c3a1e' }], grid: { type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, draw: 'checker', labels: 'chess' } },
      { id: 'stone', kind: 'token', w: 64, stack: 'none', faces: [{ label: 'S', color: '#f8fafc' }] },
    ] });
    t.spawn(box + '/board', { at: { x: 180, y: 120 } });
    for (const a of ['c3', 'd4', 'e5', 'f6']) t.spawn(box + '/stone', { at: a });
    t.addStandardDeck({ x: 40, y: 1000 });
  },
  onSelect(t, p, id) { const w = t.where(id); t.hint(p, { items: [id], spaces: w ? t.neighbors(w) : [] }); },
  onAnswer(t, p, id, v) { t.public.ans = (t.public.ans || []).concat([{ p, id, v }]).slice(-80); },
  onAction(t, a) { if (a.t === 'rulesBtn' && a.id === 'run') new Function('t', 'a', '"use strict";\\n' + a.code)(t, a); },
  buttons: (t) => [{ id: 'run', label: 'Run', pid: t.hostId }],
})`;
const CTRL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

(async () => {
  const env = await h.start();
  const host = await P.join(env, 'Alice', env.url);
  const invite = await host.evaluate(() => location.href);
  ok((await host.evaluate((c) => window.__ct.act({ t: 'setRules', code: c, enabled: true }), TERM)).ok, 'Alice enables the strict Term probe');
  const run = (code) => host.evaluate((c) => window.__ct.act({ t: 'rulesBtn', id: 'run', code: c }), code);

  section('two bots: Bob on cli.js, Carol on cli.py, each a REPL started with --as, its tab joining as that player');
  const snaps = {}, B = {}, ports = {}; // ports: each tab's bridge now (a push still on its way to the one before isn't kept)
  /** Starts `name`'s REPL in `lang` with --as, opens the URL it prints in a
   *  tab of its own (which records what it sends: actTap), and keeps the last
   *  snapshot the tab pushes to its bridge (snaps[name]). */
  async function bot(lang, name) {
    const c = lang === 'node' ? child('node', [path.join(APP, 'cli.js'), invite, '--as', name]) : child('python3', ['-u', path.join(APP, 'cli.py'), invite, '--as', name]);
    if (!(await until(() => /~cli~\d+-\w+\S*\n/.test(c.buf), 10000, 100))) throw new Error(`${lang} REPL did not start: ${c.buf}`);
    const url = c.buf.match(/(\S+~cli~\d+-\w+\S*)/)[1];
    ports[name] = url.match(/~cli~(\d+)-/)[1];
    const tab = await env.page(name);
    await tab.addInitScript(S.actTap);
    await tab.route(/127\.0\.0\.1:\d+\/state\?/, (route) => {
      if (new URL(route.request().url()).port === ports[name]) snaps[name] = route.request().postData();
      route.continue().catch((err) => console.error('route.continue failed', err.message));
    });
    await tab.goto(url);
    return { c, lang, name, tab, url };
  }
  B.Bob = await bot('node', 'Bob');
  B.Carol = await bot('python', 'Carol');
  const snap = (n) => { try { return JSON.parse(snaps[n] || 'null'); } catch (err) { console.error(err); return null; } };
  for (const n of ['Bob', 'Carol']) {
    ok(B[n].url.includes(`~as~${n}`) && await until(() => B[n].c.buf.includes(`tab connected: ${n}`), 30000, 200), `${B[n].lang}: the REPL printed a URL with ~as~${n}; its tab joined and connected as ${n}`);
  }
  ok(await until(() => ['Bob', 'Carol'].every((n) => snap(n)?.items?.filter((it) => it.at).length === 4), 20000, 200), 'both snapshots show the four stones on their squares');
  const pid = { Bob: snap('Bob').pid, Carol: snap('Carol').pid };
  ok(await P.waitView(host, 'a.every((p) => v.players[p]?.online)', [pid.Bob, pid.Carol]), `the host sees both bots at the table (${json(pid)})`);
  const at0 = Object.fromEntries(snap('Bob').items.filter((it) => it.at).map((it) => [it.at, it.id])), stone = (a) => at0[a];
  const board = snap('Bob').items.find((it) => it.kind === 'board').id;

  section('the snapshot: `strict` at the top, `rules` still the name; no asks, hint or secret yet; `at` on items');
  for (const n of ['Bob', 'Carol']) {
    const s = snap(n);
    ok(s.strict === true && s.rules === 'Term probe', `${n}: strict ${s.strict}, rules ${json(s.rules)} (a name: cah-bot.py compares it)`);
    ok(eq(s.asks, []) && s.hint === null && s.secret === null, `${n}: asks [], hint null, secret null (${json([s.asks, s.hint, s.secret])})`);
    ok(eq(s.items.filter((it) => it.at).map((it) => it.at).sort(), ['c3', 'd4', 'e5', 'f6']), `${n}: the stones carry their display addresses`);
  }
  const tl = (await Promise.all(['Bob', 'Carol'].map((n) => type(B[n], 'table', (ls) => ls.some((l) => l.startsWith(`  [${stone('e5')}] `)))))).map((ls) => ls.find((l) => l.startsWith(`  [${stone('e5')}] `)));
  ok(!!tl[0] && tl[0] === tl[1], `"table" prints a stone on a square alike in both REPLs ("${tl[0]?.trim()}")`);

  section('new asks print by themselves as they arrive — the same lines in both REPLs');
  const ASKS = `for (const p of ${json([pid.Bob, pid.Carol])}) {
    t.draw(p, t.piles()[0].id, 3);
    t.ask(p, { id: 'colour', prompt: 'Pick a colour', options: ['Red', { label: 'Blue', value: { c: 'blue', n: 2 } }, 'Light green'] });
    t.ask(p, { id: 'which', prompt: 'Which stone?', pick: 'item', among: [${json(stone('c3'))}, ${json(stone('f6'))}] });
    t.ask(p, { id: 'where', prompt: 'Where to?', pick: 'space', among: ['a1', 'h1', 'e4'] });
    t.ask(p, { id: 'pass', prompt: 'Pass two cards', pick: 'hand', count: 2 });
    t.ask(p, { id: 'one', prompt: 'Show a card', pick: 'hand' });
    t.ask(p, { id: 'bid', prompt: 'Your bid?', pick: 'number', min: -3, max: 3 });
    t.ask(p, { id: 'ctl', prompt: 'Beep\\u0007 \\u001b[2Jclear?', options: ['\\u001b]0;pwn\\u0007ok', 'fine'] });
  }`;
  const from = { Bob: B.Bob.c.buf.length, Carol: B.Carol.c.buf.length };
  ok((await run(ASKS)).ok, '(the script deals each bot three cards and asks each the same seven questions)');
  /** The ask lines ("✉ ❓ …") REPL `n` printed since `from`. */
  const askLines = (n, at = from[n]) => linesOf(B[n], at).filter((l) => l.startsWith('  ✉ ❓ '));
  ok(await until(() => ['Bob', 'Carol'].every((n) => askLines(n).length >= 7), 15000, 150), `each REPL printed seven ask lines, nobody typing (${askLines('Bob').length}, ${askLines('Carol').length})`);
  await h.sleep(700);
  const [lb, lc] = [askLines('Bob'), askLines('Carol')];
  ok(lb.length === 7 && json(lb) === json(lc), `cli.js and cli.py printed the same seven lines, each once (${json(lb.map((l) => l.slice(0, 40)))})`);
  ok(lb[0] === '  ✉ ❓ colour: Pick a colour [0] Red [1] Blue [2] Light green', `options read as the spec's "❓ promo: Promote to [0] ♕ …": "${lb[0]?.trim()}"`);
  const has = (l, ...w) => !!l && w.every((x) => l.includes(x));
  ok(has(lb[1], '❓ which: Which stone?', stone('c3'), stone('f6')), `an item pick names what to answer: "${lb[1]?.trim()}"`);
  ok(has(lb[2], '❓ where: Where to?', 'a1', 'h1', 'e4'), `a spot pick names the spots: "${lb[2]?.trim()}"`);
  ok(has(lb[3], '❓ pass: Pass two cards', '2'), `a hand pick says how many: "${lb[3]?.trim()}"`);
  ok(has(lb[5], '❓ bid: Your bid?', '-3', '3'), `a number pick says its range: "${lb[5]?.trim()}"`);
  ok(!CTRL.test(B.Bob.c.buf.slice(from.Bob)) && !CTRL.test(B.Carol.c.buf.slice(from.Carol)) && has(lb[6], '❓ ctl: Beep', 'clear?', '[1] fine'), `a script's control characters never reach either terminal ("${lb[6]?.trim()}")`);

  section('the snapshot\'s asks: one per form, an option\'s label only, a hand pick\'s count');
  ok(await until(() => ['Bob', 'Carol'].every((n) => snap(n)?.asks?.length === 7 && snap(n).hand.length === 3), 10000, 150), 'seven asks and three cards in each snapshot');
  for (const n of ['Bob', 'Carol']) {
    const a = Object.fromEntries(snap(n).asks.map((q) => [q.id, q]));
    ok(eq(a.colour, { id: 'colour', prompt: 'Pick a colour', options: ['Red', 'Blue', 'Light green'] }) && !json(snap(n)).includes('"c":"blue"'), `${n}: options are labels only — Blue's value is never sent (${json(a.colour)})`);
    ok(eq(a.which, { id: 'which', prompt: 'Which stone?', pick: 'item', among: [stone('c3'), stone('f6')] }) && eq(a.where, { id: 'where', prompt: 'Where to?', pick: 'space', among: ['a1', 'h1', 'e4'] }), `${n}: an item pick and a spot pick, with among`);
    ok(eq(a.pass, { id: 'pass', prompt: 'Pass two cards', pick: 'hand', count: 2 }) && eq(a.one, { id: 'one', prompt: 'Show a card', pick: 'hand', count: 1 }), `${n}: hand picks with their count — 1 where the script gave none (${json(a.one)})`);
    ok(eq(a.bid, { id: 'bid', prompt: 'Your bid?', pick: 'number', min: -3, max: 3 }), `${n}: a number pick with min and max`);
  }

  section('`asks` lists the pending asks, the same text in both REPLs');
  const listed = await Promise.all(['Bob', 'Carol'].map((n) => type(B[n], 'asks', (ls) => ls.filter((l) => l.startsWith('  ✉ ❓ ')).length >= 7)));
  const shown = listed.map((ls) => ls.filter((l) => l.startsWith('  ✉ ❓ ')).slice(0, 7));
  ok(json(shown[0]) === json(shown[1]) && json(shown[0]) === json(lb), '"asks": the seven, in order, word for word as they first printed, in both');

  section('`answer` in every form, and several spellings — onAnswer gets spec §3c\'s value');
  const ansOf = (id, p) => P.viewOf(host, '(v.rules.public.ans || []).find((x) => x.id === a.id && x.p === a.p) || null', { id, p });
  const hand = { Bob: snap('Bob').hand, Carol: snap('Carol').hand };
  const cards = (n, ks) => ks.map((k) => { const [d, i] = hand[n][k].key.split(':'); return { d, i: +i }; });
  const sorted = (l) => json([...(l || [])].map((c) => json(c)).sort());
  const ANSWERS = {
    Bob: [['answer colour 1', 'colour', { c: 'blue', n: 2 }], [`answer which ${stone('c3')}`, 'which', stone('c3')], ['answer where e4', 'where', 'e4'],
      ['answer pass 0,2', 'pass', cards('Bob', [0, 2])], ['answer one 1', 'one', cards('Bob', [1])], ['answer bid -2', 'bid', -2], ['answer ctl 1', 'ctl', 'fine']],
    Carol: [['answer colour LIGHT GREEN', 'colour', 'Light green'], [`answer which ${stone('f6')}`, 'which', stone('f6')], [`answer where ${board}:h1`, 'where', 'h1'],
      ['answer pass 2,1', 'pass', cards('Carol', [2, 1])], ['answer one 0', 'one', cards('Carol', [0])], ['answer bid 3', 'bid', 3], ['answer ctl FINE', 'ctl', 'fine']],
  };
  for (const n of ['Bob', 'Carol']) {
    for (const [line, id, want] of ANSWERS[n]) {
      B[n].c.stdin.write(`${line}\n`);
      let got = null;
      await until(async () => (got = await ansOf(id, pid[n])), 10000, 150);
      const same = Array.isArray(want) ? sorted(got?.v) === sorted(want) : eq(got?.v, want);
      ok(!!got && same, `${B[n].lang} "${line}" → onAnswer gets ${json(want)} (${json(got?.v)})`);
    }
  }
  ok(await until(() => ['Bob', 'Carol'].every((n) => eq(snap(n).asks, [])), 10000, 150), 'every ask answered: none left in either snapshot');
  ok(['Bob', 'Carol'].every((n) => snap(n).hand.length === 3), 'and the cards picked stayed in the hands');

  section('what isn\'t offered — or no question at all — is said, the same in both, and no answer leaves the tab');
  ok((await run(`for (const p of ${json([pid.Bob, pid.Carol])}) {
    t.ask(p, { id: 'pair', prompt: 'Heads or tails?', options: ['Heads', 'Tails'] });
    t.ask(p, { id: 'it2', prompt: 'This one?', pick: 'item', among: [${json(stone('c3'))}] });
    t.ask(p, { id: 'sp2', prompt: 'That spot?', pick: 'space', among: ['a1'] });
    t.ask(p, { id: 'h2', prompt: 'Two cards?', pick: 'hand', count: 2 });
    t.ask(p, { id: 'n2', prompt: 'How many?', pick: 'number', min: 1, max: 3 });
  }`)).ok, '(five more asks each)');
  ok(await until(() => ['Bob', 'Carol'].every((n) => snap(n)?.asks?.length === 5), 10000, 150), 'five pending in each snapshot');
  const sent0 = await Promise.all(['Bob', 'Carol'].map((n) => B[n].tab.evaluate(() => window.__acts.length)));
  const n0 = await P.viewOf(host, '(v.rules.public.ans || []).length');
  // (each error found by the ask it names: a line held back and printed late must not pass for the next one's)
  const WRONG = [['answer pair Edge', 'pair'], ['answer pair 2', 'pair', true], [`answer it2 ${stone('e5')}`, 'it2'], ['answer sp2 b2', 'sp2'], ['answer h2 0', 'h2'], ['answer h2 0,0', 'h2', true],
    ['answer h2 0,7', 'h2', true], ['answer n2 9', 'n2'], ['answer n2 1.5', 'n2', true], ['answer nope 1', '"nope"']];
  for (const [line, id, again] of WRONG) {
    const at = { Bob: B.Bob.c.buf.length, Carol: B.Carol.c.buf.length };
    for (const n of ['Bob', 'Carol']) B[n].c.stdin.write(`${line}\n`);
    const err = (n) => linesOf(B[n], at[n]).find((l) => l.startsWith('  ✉ error: ') && l.includes(id));
    await until(() => err('Bob') && err('Carol'), 8000, 100);
    ok(!!err('Bob') && err('Bob') === err('Carol'), `"${line}": "${(err('Bob') || '').trim()}" in both${again ? ' (said again: the same words as the error before it)' : ''}`);
  }
  await h.sleep(800);
  const sent1 = await Promise.all(['Bob', 'Carol'].map((n) => B[n].tab.evaluate((k) => window.__acts.slice(k).map((x) => x.a.t), sent0[['Bob', 'Carol'].indexOf(n)])));
  ok(sent1.every((l) => !l.includes('answer')), `neither tab sent an answer (${json(sent1)})`);
  ok((await P.viewOf(host, '(v.rules.public.ans || []).length')) === n0 && ['Bob', 'Carol'].every((n) => snap(n).asks.length === 5), 'no onAnswer ran, and all five still wait');
  B.Carol.c.stdin.write('answer pair tails\n');
  ok(eq((await until(async () => !!(await ansOf('pair', pid.Carol)), 10000, 150)) && (await ansOf('pair', pid.Carol)).v, 'Tails'), '(the control: "answer pair tails" answers "Tails")');

  section('options labelled with digits: a typed number is a label first, then an index (3C review)');
  ok((await run(`for (const p of ${json([pid.Bob, pid.Carol])}) t.ask(p, { id: 'dig', prompt: 'How many tricks?', options: ['1', '2', '3', '4'] });`)).ok
    && await until(() => ['Bob', 'Carol'].every((n) => snap(n)?.asks?.some((q) => q.id === 'dig')), 10000, 150), '(an ask whose options are 1, 2, 3, 4)');
  for (const [n, line, want] of [['Bob', 'answer dig 3', '3'], ['Carol', 'answer dig 0', '1']]) {
    B[n].c.stdin.write(`${line}\n`);
    let got = null;
    await until(async () => (got = await ansOf('dig', pid[n])), 10000, 150);
    ok(eq(got?.v, want), `${B[n].lang} "${line}" → "${want}" (${want === '3' ? 'the option labelled 3, not index 3' : 'no option is labelled 0: index 0'}) (${json(got?.v)})`);
  }

  section('`select`: the hint arrives in that bot\'s snapshot alone, and its REPL prints it');
  const hintLine = (n, at) => linesOf(B[n], at).find((l) => l.startsWith('  ✉ 💡 hint: '));
  let at = { Bob: B.Bob.c.buf.length, Carol: B.Carol.c.buf.length };
  B.Bob.c.stdin.write(`select ${stone('d4')}\n`);
  ok(await until(() => snap('Bob')?.hint?.items?.[0] === stone('d4'), 10000, 150), `cli.js "select ${stone('d4')}": Bob's snapshot has the hint (${json(snap('Bob')?.hint)})`);
  ok(eq(Object.keys(snap('Bob').hint).sort(), ['items', 'spaces']) && eq([...snap('Bob').hint.spaces].sort(), ['c4', 'd3', 'd5', 'e4']) && snap('Carol').hint === null, 'it is {items, spaces}: the stone and its four neighbours; Carol\'s snapshot has none');
  ok(await until(() => hintLine('Bob', at.Bob), 5000, 100) && ['c4', 'd3', 'd5', 'e4', stone('d4')].every((w) => hintLine('Bob', at.Bob).includes(w)) && !hintLine('Carol', at.Carol), `cli.js prints "${(hintLine('Bob', at.Bob) || '').trim()}"; cli.py nothing`);
  at = { Bob: B.Bob.c.buf.length, Carol: B.Carol.c.buf.length };
  B.Carol.c.stdin.write(`select ${stone('e5')}\n`);
  ok(await until(() => snap('Carol')?.hint?.items?.[0] === stone('e5'), 10000, 150) && eq([...snap('Carol').hint.spaces].sort(), ['d5', 'e4', 'e6', 'f5']), `cli.py "select": Carol's hint (${json(snap('Carol')?.hint)})`);
  ok(await until(() => hintLine('Carol', at.Carol), 5000, 100) && ['d5', 'e4', 'e6', 'f5', stone('e5')].every((w) => hintLine('Carol', at.Carol).includes(w)), `cli.py prints "${(hintLine('Carol', at.Carol) || '').trim()}"`);
  ok(snap('Bob').hint.items[0] === stone('d4'), 'Bob\'s hint is still his own');

  section('t.secret: each bot\'s whole entry in its own snapshot, its text printed');
  at = { Bob: B.Bob.c.buf.length, Carol: B.Carol.c.buf.length };
  ok((await run(`t.secret[${json(pid.Bob)}] = { text: 'You guard the north gate', gate: 'N', n: 1 }; t.secret[${json(pid.Carol)}] = { text: 'You guard the south gate', gate: 'S', n: 2 };`)).ok, '(the script gives each a secret)');
  ok(await until(() => eq(snap('Bob')?.secret, { text: 'You guard the north gate', gate: 'N', n: 1 }) && eq(snap('Carol')?.secret, { text: 'You guard the south gate', gate: 'S', n: 2 }), 10000, 150),
    `each snapshot holds its own whole entry, not only its text (${json(snap('Bob')?.secret)})`);
  ok(!json(snap('Bob')).includes('south gate') && !json(snap('Carol')).includes('north gate'), 'and never the other\'s');
  const secLine = (n) => linesOf(B[n], at[n]).filter((l) => l.startsWith('  ✉ 🔒 '));
  ok(await until(() => secLine('Bob').length && secLine('Carol').length, 5000, 100) && json(secLine('Bob')) === json(['  ✉ 🔒 for you: You guard the north gate']) && json(secLine('Carol')) === json(['  ✉ 🔒 for you: You guard the south gate']),
    `printed once each: "${secLine('Bob')[0]?.trim()}" / "${secLine('Carol')[0]?.trim()}"`);

  section('the rules off: no asks and strict false in the snapshots, the secret kept; on again (state kept), the asks are back');
  ok((await host.evaluate(() => window.__ct.act({ t: 'setRules', enabled: false }))).ok, 'Alice disables the rules');
  ok(await until(() => ['Bob', 'Carol'].every((n) => snap(n)?.rules === null && snap(n).strict === false && eq(snap(n).asks, []) && snap(n).hint === null), 10000, 150), 'both snapshots: rules null, strict false, no asks, no hint');
  ok(['Bob', 'Carol'].every((n) => snap(n).secret?.gate), 'each secret is still there');
  {
    // a select the host would drop is said, never sent (3C review): the rules take none now
    const at2 = { Bob: B.Bob.c.buf.length, Carol: B.Carol.c.buf.length }, n1 = await Promise.all(['Bob', 'Carol'].map((n) => B[n].tab.evaluate(() => window.__acts.length)));
    for (const n of ['Bob', 'Carol']) B[n].c.stdin.write(`select ${stone('c3')}\n`);
    const err = (n) => linesOf(B[n], at2[n]).find((l) => l.startsWith('  ✉ error: select '));
    await until(() => err('Bob') && err('Carol'), 8000, 100);
    const sent = await Promise.all(['Bob', 'Carol'].map((n, k) => B[n].tab.evaluate((j) => window.__acts.slice(j).map((x) => x.a.t), n1[k])));
    ok(!!err('Bob') && err('Bob') === err('Carol') && /the rules take no selections/.test(err('Bob')) && sent.every((l) => !l.includes('select')),
      `"select" with no rules running: "${(err('Bob') || '').trim()}" in both, and no select left either tab (${json(sent)})`);
  }
  ok((await host.evaluate((c) => window.__ct.act({ t: 'setRules', code: c, enabled: true }), TERM)).ok, 'Alice enables it again, keeping the state');
  ok(await until(() => snap('Bob')?.strict === true && snap('Bob').asks.length === 5 && snap('Carol')?.asks.length === 4, 15000, 150), `the asks still pending are back: Bob's five, Carol's four (she answered "pair") (${json([snap('Bob')?.asks.map((q) => q.id), snap('Carol')?.asks.map((q) => q.id)])})`);
  ok((await run(`for (const p of ${json([pid.Bob, pid.Carol])}) t.cancelAsk(p);`)).ok && await until(() => ['Bob', 'Carol'].every((n) => eq(snap(n).asks, [])), 10000, 150), '(the script withdraws them)');

  section('the Bridge API with real tabs, in both languages: select, answer and place');
  const apis = { Bob: await api('node'), Carol: await api('python') };
  for (const n of ['Bob', 'Carol']) {
    B[n].c.kill();
    delete snaps[n]; // (only what the tab pushes to its new bridge counts: a bot waits for the table before it acts)
    ports[n] = String(apis[n].port);
    const url = `${invite.replace(/~cli~.*$/, '')}~cli~${apis[n].port}-${apis[n].token}~as~${n}`;
    await B[n].tab.goto(url);
    await B[n].tab.reload(); // (a hash change alone doesn't boot again)
  }
  const call = (n, c, ...args) => apis[n].c.stdin.write(json({ call: c, args }) + '\n');
  ok(await until(() => ['Bob', 'Carol'].every((n) => snap(n)?.pid === pid[n] && snap(n).rules === 'Term probe' && snap(n).items.filter((it) => it.at).length === 4 && !(snap(n).hint)), 30000, 200), `both tabs, paired with ${apis.Bob.lang}'s and ${apis.Carol.lang}'s Bridge, push the table — the same players`);
  call('Bob', 'select', stone('c3'));
  call('Carol', 'select', stone('f6'));
  ok(await until(() => snap('Bob')?.hint?.items?.[0] === stone('c3') && snap('Carol')?.hint?.items?.[0] === stone('f6'), 10000, 150), `select(id) → each its own hint (${json([snap('Bob')?.hint?.items, snap('Carol')?.hint?.items])})`);
  ok((await run(`for (const p of ${json([pid.Bob, pid.Carol])}) {
    t.ask(p, { id: 'api-o', prompt: 'Red or blue?', options: ['Red', 'Blue'] });
    t.ask(p, { id: 'api-h', prompt: 'Two cards', pick: 'hand', count: 2 });
    t.ask(p, { id: 'api-n', prompt: 'How many?', pick: 'number', min: 0, max: 9 });
    t.ask(p, { id: 'api-s', prompt: 'Where?', pick: 'space', among: ['b2', 'g7'] });
  }`)).ok && await until(() => ['Bob', 'Carol'].every((n) => snap(n)?.asks?.length === 4), 10000, 150), '(four asks each)');
  const hd = { Bob: snap('Bob').hand, Carol: snap('Carol').hand };
  const cardsOf = (n, ks) => ks.map((k) => { const [d, i] = hd[n][k].key.split(':'); return { d, i: +i }; });
  for (const [n, c, args, id, want] of [
    ['Bob', 'answer', ['api-o', 1], 'api-o', 'Blue'], ['Carol', 'answer', ['api-o', 'red'], 'api-o', 'Red'],
    ['Bob', 'answer', ['api-h', [0, 1]], 'api-h', cardsOf('Bob', [0, 1])], ['Carol', 'answer', ['api-h', '2,0'], 'api-h', cardsOf('Carol', [2, 0])],
    ['Bob', 'answer', ['api-n', 7], 'api-n', 7], ['Carol', 'answer', ['api-n', 0], 'api-n', 0],
    ['Bob', 'answer', ['api-s', 'g7'], 'api-s', 'g7'], ['Carol', 'answer', ['api-s', `${board}:b2`], 'api-s', 'b2'],
  ]) {
    call(n, c, ...args);
    let got = null;
    await until(async () => (got = await ansOf(id, pid[n])), 10000, 150);
    ok(!!got && (Array.isArray(want) ? sorted(got.v) === sorted(want) : eq(got.v, want)), `${apis[n].lang} ${c}(${args.map(json).join(', ')}) → onAnswer gets ${json(want)} (${json(got?.v)})`);
  }
  call('Bob', 'place', stone('e5'), 'h1');
  call('Carol', 'place', stone('d4'), `${board}:a8`);
  ok(await P.waitView(host, 'v.items[a.e5]?.at === "h1" && v.items[a.d4]?.at === "a8"', { e5: stone('e5'), d4: stone('d4') }), 'place(id, "h1") (node) and place(id, "<board>:a8") (python) move the stones there, centred');

  killAll();
  await env.done();
})().catch((e) => { killAll(); h.crash(e); });
