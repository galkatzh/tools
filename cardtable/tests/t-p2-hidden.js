// Phase 2, the attacker cases of spec §2j (1–14): Mallory, a raw peer
// (final-lib), against a host that loaded a box of pieces, dice, supplies and
// bags, some of them face down (p2-lib SPY). Every body she receives —
// snapshots, patches (log entries travel in them), notes and the boxes
// channel — is scanned, recursively, for the hidden pieces' type refs, face
// labels and names; refusals are checked byte for byte, and every refused
// attack leaves the table as it was.
const h = require('./h');
const { ok, section } = h;
const { mallory } = require('./final-lib');
const { saved, same } = require('./p1-lib');
const { act, loadBox, items, at, arm, until, SECRETS, SPY, GHOST } = require('./p2-lib');

const MPID = 'ffffffffffffffff';
const HIDDEN = '🚫 That piece is hidden';
const ONLY_HOST = '🚫 Only the host can do that';
const FULL = '🚫 The table is full (5,000 items)';
/** What may never reach Mallory outside the catalog: each secret type's id, its faces' labels and its name. */
const needlesOf = (types) => Object.entries(types).flatMap(([id, ty]) => [id, ty.name, ...ty.faces]);

(async () => {
  const env = await h.start();
  const host = await env.page('Alice');
  const hostErrors = [];
  host.on('console', (m) => { if (m.type() === 'error') hostErrors.push(m.text()); });
  await host.goto(env.url);
  await h.joinAs(host, 'Alice');
  await host.waitForSelector('.item.pile .count');
  const invite = await host.evaluate(() => location.href);
  const room = invite.match(/#room~([0-9a-f]+)/)[1];
  const alice = await host.evaluate(() => localStorage.getItem('ct-pid'));
  const M = await mallory(env, invite, 1); // the host is the only other peer
  const X = await arm(M);
  await M.act({ t: 'hello' });
  await M.waitForFunction((p) => window.M.fold()?.players?.[p], MPID, { timeout: 20000 });
  ok(true, 'Mallory (a raw peer) sits at the table');

  section('setup: the host loads a box with hidden pieces while Mallory watches');
  const box = await loadBox(host, SPY);
  const ref = (t) => `${box}/${t}`;
  await host.waitForFunction(() => Object.values(window.__ct.view().items).length > 40);
  const its = await items(host);
  const id = (x, y) => at(its, x, y);
  const ids = {
    board: id(200, 200), marker: id(1470, 1000), chip3: id(700, 800), chip2: id(800, 800), coin2: id(900, 800),
    aliceChip: id(1000, 800), alicePlate: id(1100, 800), supply: id(1200, 800), wheel: id(1300, 800), loose: id(1400, 800),
    chip999: id(1500, 800), full: id(2000, 400), tileX: id(600, 400), unitX: id(750, 400), loot: id(900, 400), hdie: id(1050, 400), htok: id(1150, 400),
    red3: id(1250, 400), red2: id(1350, 400), blue2: id(1450, 400), gold: id(1550, 400), mixed: id(1700, 400), tiles: id(1850, 400),
  };
  const seatChip = (s) => Object.keys(its).find((k) => its[k].owner === `seat:${s}`);
  const dice = Object.keys(its).filter((k) => its[k].t === ref('d6')).sort();
  const missing = Object.keys(ids).filter((k) => !ids[k]);
  ok(!missing.length && dice.length === 21 && ['white', 'black', 'green'].every(seatChip), `every test item is on the table (missing: ${missing.join(', ') || 'none'}; ${dice.length} dice)`);
  const hiddenIds = [ids.tileX, ids.unitX, ids.hdie, ids.htok, ids.red3, ids.red2, ids.blue2, ids.gold];
  await M.waitForFunction((a) => a.every((x) => window.M.fold()?.items[x]), Object.values(ids), { timeout: 20000 });
  const pl = await X.view('v.players');
  ok(pl[alice]?.seatId === 'white' && pl[MPID]?.seatId === 'black', `the named seats: Alice White, Mallory Black (${pl[alice]?.seatId}, ${pl[MPID]?.seatId})`);
  ok(Object.values(pl).every((p) => Object.keys(p).every((k) => ['name', 'color', 'online', 'handCount', 'seat', 'seatId'].includes(k))), 'players carry name, colour, online, hand count, seat and seat id only (§2d)');
  const mv = await X.view(`({ ${Object.entries(ids).map(([k, v]) => `${k}: v.items['${v}']`).join(', ')} })`);
  ok(mv.tileX.b === ref('tback') && mv.unitX.b === ref('uback') && mv.hdie.b === ref('cube') && mv.htok.b === ref('cube') && mv.gold.b === ref('chit') && mv.red3.b === ref('chit'),
    `a hidden piece or supply shows its back's ref "<box>/<back>" (${mv.tileX.b}, ${mv.hdie.b})`);
  ok(hiddenIds.every((x) => { const it = mv[Object.keys(ids).find((k) => ids[k] === x)]; return !('t' in it) && !('f' in it) && !('up' in it); }), 'hidden pieces and the hidden supply carry no t, f or up');
  ok(mv.red3.n === 3 && mv.red2.n === 2 && mv.blue2.n === 2, 'a hidden stack shows its count');
  ok(mv.loot.k === 'b' && mv.loot.n === 3 && mv.loot.name === 'Loot' && !('of' in mv.loot) && !('hand' in mv.loot), 'a bag shows its name and count, never its contents (and no hand flag for a bag of tokens)');
  ok(mv.tiles.hand === true && mv.tiles.n === 2 && mv.mixed.n === 4 && !('hand' in mv.mixed), "a bag of tiles is a hand bag; a bag of tiles and a token isn't");
  ok(mv.board.lock === true && mv.board.z < 0, `the board is locked and in the boards' z band (z ${mv.board.z})`);
  const top = await X.view('({ table: v.table, seats: v.seats, handy: v.handy })');
  ok(same(top.table, SPY.table) && same(top.seats, SPY.seats) && top.handy === true, `the view carries the table, the named seats and handy (${JSON.stringify(top.table)}, ${top.seats?.length} seats, handy ${top.handy})`);
  const pub = await M.evaluate((b) => window.M.got.boxes.map(({ m }) => window.M.body(m)[b]).filter(Boolean).at(-1), box);
  ok(pub && !('setup' in pub) && pub.src === 'host' && pub.by === alice && pub.builtin === false && pub.name === SPY.name,
    `the boxes channel carries the PublicBox: no setup; src "host", by the host, not built in (${JSON.stringify({ src: pub?.src, by: pub?.by, builtin: pub?.builtin, setup: pub && 'setup' in pub })})`);
  // the host claims a chip and a tile (a hand type) for itself
  for (const x of [ids.aliceChip, ids.alicePlate]) await act(host, { t: 'owner', id: x, to: alice });
  await M.waitForFunction((a) => a.ids.every((x) => window.M.fold()?.items[x]?.owner === a.alice), { ids: [ids.aliceChip, ids.alicePlate], alice }, { timeout: 15000 });
  ok(true, 'the host owns a chip and a tile');
  const count = () => X.view('Object.keys(v.items).length');

  section('1: Mallory may move and turn hidden pieces: they stay hidden, and the log says "a hidden piece"');
  {
    const log0 = (await X.view('v.log')).length;
    await X.attempt({ t: 'move', id: ids.tileX, x: 620, y: 420 }, ids.marker, true);
    await X.attempt({ t: 'rot', id: ids.tileX, rot: 50 }, ids.marker, true);
    await X.attempt({ t: 'rot', id: ids.unitX, rot: 33 }, ids.marker, true);
    const v = await X.view(`[v.items['${ids.tileX}'], v.items['${ids.unitX}']]`);
    const lines = (await X.view('v.log')).slice(log0).filter((e) => e.p === MPID).map((e) => e.txt);
    ok(v[0].x === 620 && v[0].y === 420 && v[0].rot === 90 && v[1].rot === 33 && 'b' in v[0] && 'b' in v[1],
      `a hidden tile turns in its back's steps (50° → ${v[0].rot}°), a hidden token freely (${v[1].rot}°)`);
    ok(lines.includes('moved a hidden piece') && lines.filter((x) => x === 'rotated a hidden piece').length === 2, `logged as "moved a hidden piece", "rotated a hidden piece" (${JSON.stringify(lines)})`);
  }

  // §2j case 6 is spread out: the host refuses a guest's host-only action at
  // its boundary with one notice per 10 s, so each goes 10.5 s after the last.
  let boundaryAt = 0;
  async function hostOnly(a, what, unchanged) {
    const wait = boundaryAt + 10500 - Date.now();
    if (wait > 0) await h.sleep(wait);
    const before = await unchanged();
    const r = await X.attempt(a, ids.marker);
    boundaryAt = Date.now();
    ok(r.notes.length === 1 && r.notes[0] === ONLY_HOST, `6: ${what} as a guest is refused: "${ONLY_HOST}" (got ${JSON.stringify(r.notes)})`);
    ok(same(await unchanged(), before), `6: … and changes nothing`);
  }
  await hostOnly({ t: 'table', shape: 'rect', w: 800, h: 600 }, 'table', () => X.view('v.table'));

  section('3: a roll takes no result from the payload; 1 to 20 different dice');
  const die = dice[0], faces = [];
  for (let k = 0; k < 30; k++) {
    await X.send({ t: 'roll', ids: [die], f: k % 2 ? 6 : 5 });
    await X.barrier(ids.marker);
    faces.push(await X.view(`v.items['${die}'].f`));
  }
  ok(faces.every((f) => Number.isInteger(f) && f >= 0 && f < 6) && new Set(faces).size >= 3 && !faces.every((f) => f === 5),
    `30 rolls sent with f: 5 or 6 land on random faces (${faces.join('')})`);
  const rolls = (await X.view('v.log')).filter((e) => e.p === MPID && /^rolled /.test(e.txt));
  ok(rolls.length > 0 && rolls.every((e) => /^rolled [1-6]$/.test(e.txt)), `each roll is logged with its face ("${rolls.at(-1)?.txt}")`);
  for (const [what, ids2] of [['50 copies of one die', Array(50).fill(die)], ['one die twice', [die, die]], ['21 different dice', dice]]) {
    const f0 = await X.view(`v.items['${die}'].f`), log0 = (await X.view('v.log')).length;
    const r = await X.attempt({ t: 'roll', ids: ids2 }, ids.marker);
    const newRolls = (await X.view('v.log')).slice(log0).filter((e) => /^rolled/.test(e.txt));
    ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]) && !newRolls.length && (await X.view(`v.items['${die}'].f`)) === f0, `a roll of ${what} is refused whole (${JSON.stringify(r.notes)})`);
  }
  const twenty = dice.slice(0, 20), log0 = (await X.view('v.log')).length;
  const r20 = await X.attempt({ t: 'roll', ids: [...twenty].reverse() }, ids.marker, true);
  const rolled = (await X.view('v.log')).slice(log0).filter((e) => e.p === MPID && /^rolled/.test(e.txt));
  const f20 = await X.view(`[${twenty.map((d) => `v.items['${d}'].f`).join(',')}]`);
  ok(!r20.notes.length && rolled.length === 1 && rolled[0].txt === `rolled ${f20.map((f) => f + 1).join(' · ')}`,
    `20 different dice roll together: one line, the faces in id order ("${rolled[0]?.txt.slice(0, 60)}…")`);

  section('4: impossible or forged ops are refused or ignored');
  {
    const f0 = await X.view(`v.items['${die}'].f`);
    const r = await X.attempt({ t: 'face', id: die, f: (f0 + 1) % 6 }, ids.marker);
    ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]) && (await X.view(`v.items['${die}'].f`)) === f0, `face on a die is refused (${JSON.stringify(r.notes)})`);
  }
  // (§2j: "refused or ignored, with no state change": a notice is not required)
  const refusedOrIgnored = (notes) => notes.length <= 1 && notes.every((n) => /^🚫/.test(n));
  const n0 = await count();
  for (const n of [-3, 1e9, 0, 3]) {
    const r = await X.attempt({ t: 'split', id: ids.chip3, n, x: 1600, y: 900 }, ids.marker);
    ok(refusedOrIgnored(r.notes) && (await X.view(`v.items['${ids.chip3}'].n`)) === 3 && (await count()) === n0, `split n: ${n} of a ×3 stack changes nothing (${JSON.stringify(r.notes)})`);
  }
  for (const [what, onto, other] of [['onto another type (a coin)', ids.coin2, 2], ['onto a stack with another owner (her own seat\'s)', seatChip('black'), 2]]) {
    const r = await X.attempt({ t: 'join', id: ids.chip3, onto }, ids.marker);
    const v = await X.view(`[v.items['${ids.chip3}']?.n, v.items['${onto}']?.n]`);
    ok(refusedOrIgnored(r.notes) && v[0] === 3 && v[1] === other && (await count()) === n0, `join ${what} changes nothing (${JSON.stringify(r.notes)})`);
  }
  {
    const r = await X.attempt({ t: 'take', id: ids.supply, n: 50, x: 1600, y: 900 }, ids.marker, true);
    const made = await X.view("Object.values(v.items).filter((it) => it.x === 1600 && it.y === 900)");
    ok(!r.notes.length && (await count()) === n0 + 1 && made.length === 1 && made[0].t === ref('chip') && !('n' in made[0]), `take with n: 50 takes one piece, no ×N (${JSON.stringify(made)})`);
  }
  {
    const r = await X.attempt({ t: 'join', id: ids.chip2, onto: ids.chip3 }, ids.marker, true);
    ok(!r.notes.length && (await X.view(`v.items['${ids.chip3}'].n`)) === 5 && !(await X.view(`v.items['${ids.chip2}']`)), 'a lawful join still works: ×2 onto ×3 makes ×5');
    const s = await X.attempt({ t: 'split', id: ids.chip3, n: 2, x: 800, y: 800 }, ids.marker, true);
    ok(!s.notes.length && (await X.view(`v.items['${ids.chip3}'].n`)) === 3, 'a lawful split still works: 2 off a ×5');
  }
  {
    // no human action sets n: a count field on a move is ignored
    const r = await X.attempt({ t: 'move', id: ids.chip3, x: 720, y: 820, n: 999 }, ids.marker, true);
    const c = await X.view(`v.items['${ids.chip3}']`);
    ok(!r.notes.length && c.n === 3 && c.x === 720 && c.y === 820, `a move carrying n: 999 moves the ×3 and leaves its count (×${c.n})`);
    await X.attempt({ t: 'move', id: ids.chip3, x: 700, y: 800 }, ids.marker, true);
  }
  {
    // the count cap (×999) and the bag cap (1,000 pieces)
    const two = await X.view("Object.keys(v.items).find((k) => v.items[k].x === 800 && v.items[k].y === 800 && v.items[k].n === 2)");
    const took = await X.view("Object.keys(v.items).find((k) => v.items[k].x === 1600 && v.items[k].y === 900)");
    for (const [what, a] of [['join of a ×2 onto a ×999', { t: 'join', id: two, onto: ids.chip999 }], ['split of 1 onto a ×999', { t: 'split', id: ids.chip3, n: 1, onto: ids.chip999 }]]) {
      const r = await X.attempt(a, ids.marker);
      const v = await X.view(`[v.items['${ids.chip999}']?.n, v.items['${two}']?.n, v.items['${ids.chip3}']?.n]`);
      ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]) && v[0] === 999 && v[1] === 2 && v[2] === 3, `${what} is refused: at most ×999 (${JSON.stringify(r.notes)})`);
    }
    const r1 = await X.attempt({ t: 'toBag', id: two, bag: ids.full }, ids.marker);
    ok(r1.notes.length === 1 && /^🚫/.test(r1.notes[0]) && (await X.view(`v.items['${ids.full}'].n`)) === 999 && (await X.view(`v.items['${two}'].n`)) === 2,
      `toBag of a ×2 into a bag of 999 is refused whole: at most 1,000 (${JSON.stringify(r1.notes)})`);
    const r2 = await X.attempt({ t: 'toBag', id: took, bag: ids.full }, ids.marker, true);
    ok(!r2.notes.length && (await X.view(`v.items['${ids.full}'].n`)) === 1000 && !(await X.view(`v.items['${took}']`)), 'one more chip fills it to 1,000');
  }

  section('5: pieces the host owns, and a locked board, are refused and re-sent');
  for (const [what, target, notice] of [
    ['a chip the host owns', ids.aliceChip, '🚫 That belongs to Alice'],
    ['a tile the host owns', ids.alicePlate, '🚫 That belongs to Alice'],
    ["a chip of the host's seat", seatChip('white'), '🚫 That belongs to White'],
    ['the locked board', ids.board, '🔒 That is locked in place'],
  ]) {
    const was = await X.view(`v.items['${target}']`);
    for (const a of [{ t: 'move', id: target, x: 2000, y: 1500 }, { t: 'del', id: target }, { t: 'toHand', id: target }]) {
      const r = await X.attempt(a, ids.marker);
      const resent = (await X.bodiesSince(r.since)).some((d) => d.items?.[target] && d.items[target].x === was.x && d.items[target].y === was.y);
      ok(r.notes.length === 1 && r.notes[0] === notice && same(await X.view(`v.items['${target}']`), was) && !(await X.view('v.hand')).length && resent,
        `${a.t} on ${what}: "${notice}", nothing changes, and its position is re-sent (${JSON.stringify(r.notes)}, re-sent: ${resent})`);
    }
  }
  const truth = await items(host);
  ok([ids.aliceChip, ids.alicePlate, seatChip('white'), ids.board].every((x) => truth[x] && truth[x].x === its[x].x && truth[x].y === its[x].y), 'the host agrees: all four are where they were');

  section('7: Mallory cannot take the host\'s seat, nor seat anyone');
  for (const [a, notice] of [
    [{ t: 'seat', id: 'white' }, '🚫 That seat is taken'],
    [{ t: 'seat', id: 'green', p: alice }, '🚫 Only the host can seat other players'],
    [{ t: 'seat', watch: true, p: alice }, '🚫 Only the host can seat other players'],
    [{ t: 'seat', id: 'white', p: MPID }, '🚫 That seat is taken'],
  ]) {
    const r = await X.attempt(a, ids.marker);
    const p = await host.evaluate(() => JSON.parse(JSON.stringify(window.__ct.view().players)));
    ok(r.notes.length === 1 && r.notes[0] === notice && p[alice].seatId === 'white' && p[alice].seat === pl[alice].seat && p[MPID].seatId === 'black',
      `${JSON.stringify(a)}: "${notice}", the seats unchanged (${JSON.stringify(r.notes)})`);
  }

  await hostOnly({ t: 'loadBox', box: { ...SPY, name: 'Evil kit' }, setup: true, clear: true }, 'loadBox', async () => ({
    n: await count(), boxes: await host.evaluate(() => Object.keys(window.__ct.boxes()).sort()), got: await M.evaluate(() => (window.M.got.boxes || []).length),
  }));

  section('9: __proto__ as an id, a type ref or a seat id pollutes nothing');
  const protoNames = () => host.evaluate(() => Object.getOwnPropertyNames(Object.prototype).sort().join());
  const names0 = await protoNames();
  for (const P of ['__proto__', 'constructor', 'prototype', 'toString']) {
    for (const a of [
      { t: 'move', id: P, x: 5, y: 5 }, { t: 'rot', id: P, rot: 90 }, { t: 'flip', id: P }, { t: 'del', id: P }, { t: 'toHand', id: P },
      { t: 'roll', ids: [P] }, { t: 'roll', ids: [P, dice[1]] }, { t: 'face', id: P, f: 0 }, { t: 'split', id: P, n: 1 },
      { t: 'split', id: ids.chip3, n: 1, onto: P }, { t: 'join', id: ids.chip3, onto: P }, { t: 'join', id: P, onto: ids.chip3 },
      { t: 'take', id: P }, { t: 'pull', id: P }, { t: 'toBag', id: P, bag: ids.tiles }, { t: 'toBag', id: ids.loose, bag: P },
      { t: 'lock', id: P, on: true }, { t: 'owner', id: P, to: MPID }, { t: 'owner', id: ids.wheel, to: P }, { t: 'owner', id: ids.wheel, to: `seat:${P}` },
      { t: 'seat', id: P }, { t: 'seat', id: 'green', p: P },
      { t: 'play', idx: 0, type: `${P}/${P}`, f: 0, x: 5, y: 5 }, { t: 'play', idx: 0, type: `${box}/${P}`, f: 0 }, { t: 'play', idx: 0, d: P, i: 0 },
      { t: 'handPile', idx: 0, type: `${box}/${P}`, f: 0, pile: P }, { t: 'stack', id: P, onto: P }, { t: 'toPile', id: P, pile: P },
      { t: 'merge', id: P, pile: P }, { t: 'peek', id: P }, { t: 'shuffle', id: P }, { t: 'draw', id: P }, { t: 'deal', id: P },
    ]) await X.send(a);
  }
  // a forged boxes message: not from the host, so never read
  await M.evaluate((b) => window.M.send.boxes(JSON.parse(`{"__proto__": ${b}, "deadbeef": ${b}}`)), JSON.stringify({ name: 'x', imgs: [], types: { a: { kind: 'token', name: 'a', faces: ['a'] } } }));
  await X.barrier(ids.marker);
  // and boxes with __proto__ ids, from the host itself: refused by cleanBox
  const evil = await host.evaluate(async (seats) => {
    const tok = '{"kind":"token","name":"x","faces":["a"]}';
    const out = [];
    for (const b of [
      `{"name":"Evil1","imgs":[],"types":{"__proto__":${tok}}}`,
      `{"name":"Evil2","imgs":[],"types":{"a":${tok}},"backs":{"__proto__":{"face":{}}}}`,
      `{"name":"Evil3","imgs":[],"types":{"a":${tok}},"seats":[{"id":"__proto__","name":"P"}]}`,
      `{"name":"Evil4","imgs":[],"types":{"a":${tok}},"setup":[{"piece":"__proto__","at":[10,10]}]}`,
      // (an own "__proto__" key is no setup; the box keeps the seats as they are)
      `{"name":"Evil5","imgs":[],"types":{"a":${tok}},"seats":${seats},"__proto__":{"setup":[{"piece":"a","at":[10,10]}]}}`,
    ]) out.push(await window.__ct.act({ t: 'loadBox', box: JSON.parse(b), setup: true, clear: false }));
    return out;
  }, JSON.stringify(SPY.seats));
  ok(evil.slice(0, 4).every((r) => !r.ok && /^🚫 Box rejected: /.test(r.error)), `boxes with __proto__ type, back, seat or setup ids are rejected (${evil.map((r) => r.error).join(' | ')})`);
  ok(await host.evaluate(() => !Object.values(window.__ct.view().items).some((it) => it.x === 10 && it.y === 10)), 'a box\'s own "__proto__" key never smuggles a setup in');
  ok((await protoNames()) === names0 && (await host.evaluate(() => ['x', 'y', 'n', 'f', 't', 'of', 'owner', 'lock', 'seatId', 'hand', 'up', 'name', 'kind', 'types', 'setup'].every((k) => ({})[k] === undefined))),
    'Object.prototype gains nothing, on the host');
  const w = await X.view(`v.items['${ids.wheel}']`);
  ok(w && !('owner' in w) && (await X.view(`v.players['${MPID}'].seatId`)) === 'black', 'the items and seats those named are as they were');
  await h.sleep(2500); // her notices' budget (10, then 5 a second) refills after that flood of refusals

  section('10: every hidden piece gets the same refusal, byte for byte');
  const raw = [];
  for (const [what, a] of [
    ['roll of a hidden die', { t: 'roll', ids: [ids.hdie] }],
    ['roll of a hidden token', { t: 'roll', ids: [ids.htok] }],
    ['face of a hidden die', { t: 'face', id: ids.hdie, f: 0 }],
    ['face of a hidden token', { t: 'face', id: ids.htok, f: 0 }],
    ['join of two hidden stacks of one type', { t: 'join', id: ids.red3, onto: ids.red2 }],
    ['join of two hidden stacks of two types', { t: 'join', id: ids.red3, onto: ids.blue2 }],
    ['split onto a hidden stack of the same type', { t: 'split', id: ids.red3, n: 1, onto: ids.red2 }],
    ['split onto a hidden stack of another type', { t: 'split', id: ids.red3, n: 1, onto: ids.blue2 }],
  ]) {
    const k = (await X.marks()).note;
    const r = await X.attempt(a, ids.marker);
    raw.push(...(await M.evaluate((k) => window.M.got.note.slice(k).map(({ m }) => (typeof m.b === 'string' ? m.b : JSON.stringify(m))), k)));
    ok(r.notes.length === 1 && r.notes[0] === HIDDEN, `${what}: "${HIDDEN}" (${JSON.stringify(r.notes)})`);
  }
  ok(raw.length === 8 && raw.every((b) => b === raw[0]), `the 8 notes are identical, byte for byte (${raw.length} notes, ${new Set(raw).size} distinct)`);
  const hv = await X.view(`[${[ids.red3, ids.red2, ids.blue2, ids.hdie, ids.htok].map((x) => `v.items['${x}']`).join(',')}]`);
  ok(hv[0].n === 3 && hv[1].n === 2 && hv[2].n === 2 && same(hv[3], mv.hdie) && same(hv[4], mv.htok), 'and nothing changed');

  section("11: a bag's hand flag is fixed when it is made");
  {
    const r = await X.attempt({ t: 'pull', id: ids.mixed, hand: true }, ids.marker);
    ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]) && (await X.view(`v.items['${ids.mixed}'].n`)) === 4 && !(await X.view('v.hand')).length,
      `a pull into the hand from a bag without the hand flag is refused (${JSON.stringify(r.notes)})`);
  }
  let tokenLast = false, rounds = 0, pulls = 0;
  const spot = (k) => [2100 + 80 * k, 1600];
  // (a barrier after each pull: the log folds a line that repeats the one before it)
  const pull = async (x, y) => { await X.send({ t: 'pull', id: ids.mixed, x, y }); await X.barrier(ids.marker); pulls++; };
  for (; rounds < 40 && !tokenLast; rounds++) {
    for (let k = 0; k < 3; k++) await pull(...spot(k));
    const pulled = await X.view(`Object.keys(v.items).filter((k) => [${[0, 1, 2].map((k) => `'${spot(k)}'`)}].includes(v.items[k].x + ',' + v.items[k].y))`);
    // the truth (which one is left) from the host's save, once it has caught up
    const seq = await host.evaluate(() => window.__ct.view().seq);
    let of = null;
    await until(async () => { const s = (await saved(host))?.state; of = s?.items?.[ids.mixed]?.of; return s?.seq >= seq && of?.length === 1; }, 10000, 200);
    tokenLast = of?.length === 1 && of[0].t === ref('qzTokM');
    if (!tokenLast) for (const x of pulled) await X.send({ t: 'toBag', id: x, bag: ids.mixed }); // all back in, and again
    if (!tokenLast) await X.barrier(ids.marker);
  }
  ok(tokenLast, `Mallory pulled face down until the token was the last (in ${rounds} round(s))`);
  await pull(2400, 1700);
  const bagForms = (await M.evaluate((x) => window.M.got.state.map(({ m }) => window.M.body(m).items?.[x]).filter(Boolean), ids.mixed));
  // (one body per pull at least, and her snapshot: a fixed "> 6" failed whenever the token was last after the first round)
  ok(bagForms.length > pulls && bagForms.every((b) => !('hand' in b) && !('of' in b)) && bagForms.at(-1).n === 0,
    `the bag's public hand flag never changed over ${bagForms.length} bodies (${pulls} pulls), down to empty`);
  const drew = (await X.view('v.log')).filter((e) => e.p === MPID && /^drew /.test(e.txt));
  ok(drew.length === pulls && drew.every((e) => e.txt === 'drew a piece from the bag Mixed'), `every face-down pull is logged as "drew a piece from the bag Mixed" (${drew.length} lines, ${pulls} pulls)`);
  {
    const r = await X.attempt({ t: 'toBag', id: ids.loose, bag: ids.tiles }, ids.marker);
    ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]) && (await X.view(`v.items['${ids.loose}']`)) && (await X.view(`v.items['${ids.tiles}'].n`)) === 2,
      `toBag of a token (no hand) into a hand bag is refused (${JSON.stringify(r.notes)})`);
  }

  await hostOnly({ t: 'clear' }, 'clear', () => count());

  section('12: log lines name no hidden piece');
  {
    const log0 = (await X.view('v.log')).length;
    await X.attempt({ t: 'take', id: ids.gold, x: 2400, y: 600 }, ids.marker, true);
    const took = await X.view("Object.values(v.items).find((it) => it.x === 2400 && it.y === 600)");
    await X.attempt({ t: 'split', id: ids.red3, n: 1, x: 2500, y: 600 }, ids.marker, true);
    const split = await X.view("Object.values(v.items).find((it) => it.x === 2500 && it.y === 600)");
    const lines = (await X.view('v.log')).slice(log0).filter((e) => e.p === MPID).map((e) => e.txt);
    ok(took?.b === ref('chit') && !('t' in took) && lines.includes('took a hidden piece from a supply of hidden pieces'), `take from a hidden supply: "took a hidden piece from a supply of hidden pieces" (${JSON.stringify(lines)})`);
    ok(split?.b === ref('chit') && !('n' in split) && (await X.view(`v.items['${ids.red3}'].n`)) === 2 && lines.includes('took 1 from a hidden piece ×3'), 'split of a hidden stack: "took 1 from a hidden piece ×3"');
  }
  {
    const code = "({ name: 'Roller', onChat(t, msg) { if (msg === '!roll') for (const d of t.find({ kind: 'die', up: false })) t.roll(d.id); } })";
    await act(host, { t: 'setRules', code, enabled: true });
    // (the enable line must be in her view before counting from it: under load it lands after)
    await M.waitForFunction(() => window.M.fold().log.some((e) => e.p === 'RULES' && /«Roller» enabled/.test(e.txt)), null, { timeout: 15000 });
    const log0 = (await X.view('v.log')).length;
    await act(host, { t: 'chat', msg: '!roll' });
    await M.waitForFunction((k) => window.M.fold().log.slice(k).some((e) => e.p === 'RULES' && /rolled/.test(e.txt)), log0, { timeout: 15000 });
    const lines = (await X.view('v.log')).slice(log0).filter((e) => e.p === 'RULES').map((e) => e.txt);
    const d = await X.view(`v.items['${ids.hdie}']`);
    ok(lines.length === 1 && lines[0] === 'rolled a hidden die' && d.b === ref('cube') && !('f' in d), `t.roll of a hidden die logs "rolled a hidden die", no value (${JSON.stringify(lines)})`);
  }

  section('14: claims and locks');
  for (const [what, a, check] of [
    ['claim of a locked board', { t: 'owner', id: ids.board, to: MPID }, (it) => !('owner' in it) && it.lock === true],
  ]) {
    const r = await X.attempt(a, ids.marker);
    ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]) && check(await X.view(`v.items['${a.id}']`)), `${what} is refused (${JSON.stringify(r.notes)})`);
  }
  await act(host, { t: 'lock', id: ids.board, on: false });
  await M.waitForFunction((x) => window.M.fold().items[x] && !('lock' in window.M.fold().items[x]), ids.board, { timeout: 15000 });
  {
    const r = await X.attempt({ t: 'owner', id: ids.board, to: MPID }, ids.marker);
    ok(r.notes.length === 1 && /^🚫/.test(r.notes[0]) && !('owner' in (await X.view(`v.items['${ids.board}']`))), `the claim of an unlocked board is refused too (${JSON.stringify(r.notes)})`);
    const l = await X.attempt({ t: 'lock', id: ids.aliceChip, on: true }, ids.marker);
    ok(l.notes.length === 1 && /^🚫/.test(l.notes[0]) && !('lock' in (await X.view(`v.items['${ids.aliceChip}']`))), `with lockable "anyone", locking a piece Alice owns is refused (${JSON.stringify(l.notes)})`);
    const ok1 = await X.attempt({ t: 'lock', id: ids.coin2, on: true }, ids.marker, true);
    ok(!ok1.notes.length && (await X.view(`v.items['${ids.coin2}'].lock`)) === true, '… while she may lock a coin nobody owns (lockable "anyone")');
    await X.attempt({ t: 'lock', id: ids.coin2, on: false }, ids.marker, true);
    const c = await X.attempt({ t: 'owner', id: ids.wheel, to: MPID }, ids.marker, true);
    ok(!c.notes.length && (await X.view(`v.items['${ids.wheel}'].owner`)) === MPID, '… and claim a piece nobody owns');
    await X.attempt({ t: 'owner', id: ids.wheel, to: null }, ids.marker, true);
  }
  await act(host, { t: 'lock', id: ids.board, on: true });

  section('1, 2: no body Mallory received names a hidden piece, or what a bag holds');
  const scan = async (types, boxId) => M.evaluate(([n, r]) => window.M.scan(n, r), [needlesOf(types), Object.keys(types).map((t) => `${boxId}/${t}`)]);
  ok((await M.evaluate(() => (window.M.got.boxes || []).length)) > 0 && (await M.evaluate((b) => window.M.got.boxes.some(({ m }) => b in window.M.body(m)), box)), 'Mallory got the box on the boxes channel (so the scan covers it)');
  let hits = await scan(SECRETS, box);
  ok(!hits.length, `the recursive scan of ${await M.evaluate(() => window.M.got.state.length + window.M.got.note.length + (window.M.got.boxes || []).length)} bodies finds no hidden type ref, face label or name, no "of" and no setup (${hits.slice(0, 5).join('; ')})`);
  let forms = await M.evaluate((x) => window.M.forms(x), hiddenIds);
  ok(!forms.length, `every public form she received is §2d's (${forms.slice(0, 3).join('; ')})`);

  section('13: a hidden piece whose box is gone shows {k, b: null}, never its t or f');
  const ghostBox = await loadBox(host, GHOST, { clear: false });
  const its2 = await items(host), ghost = at(its2, 2500, 1500), lamp = at(its2, 2600, 1500);
  ok(its2[ghost]?.b === `${ghostBox}/gb` && its2[lamp]?.t === `${ghostBox}/lamp`, 'the ghost box laid out a hidden piece and a shown one');
  // A face-down pile of its hidden tiles, and one in the host's hand: once the box is gone, a deal and a play must keep them hidden too.
  const shades = [0, 1, 2].map((k) => at(its2, 2400, 1500 + 120 * k));
  ok(shades.every((id) => its2[id]?.b === `${ghostBox}/gt`), 'and three hidden tiles');
  ok((await act(host, { t: 'stack', id: shades[1], onto: shades[0] })).ok && (await act(host, { t: 'toHand', id: shades[2] })).ok, 'the host stacks two of them, and takes the third into its hand');
  const shadePile = at(await items(host), 2400, 1500, (it) => it.k === 'p');
  ok(shadePile, 'a face-down pile of ghost tiles');
  ok(await until(async () => { const s = (await saved(host))?.state; return s?.items?.[ghost] && s.items[shadePile] && !s.items[shades[2]] && (await h.idb(host, 'catalog', [room, ghostBox]))?.kind === 'box'; }, 20000, 300),
    'the host saved them, and the box in its catalog');
  await host.goto(h.plain(env));
  await host.evaluate(async ([room, id]) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('cardtable'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const t = db.transaction('catalog', 'readwrite');
    t.objectStore('catalog').delete([room, id]);
    await new Promise((res, rej) => { t.oncomplete = res; t.onabort = () => rej(t.error); });
    db.close();
  }, [room, ghostBox]);
  ok((await h.idb(host, 'catalog', [room, ghostBox])) === null && (await h.idb(host, 'catalog', [room, box]))?.kind === 'box', "the ghost box's catalog record is deleted (the spy kit's stays)");
  const before = await X.marks(), errs0 = hostErrors.length;
  await host.goto(invite);
  await host.waitForFunction((x) => window.__ct?.view()?.items?.[x], ghost, { timeout: 30000 });
  const hg = await host.evaluate(([g, l]) => JSON.parse(JSON.stringify([window.__ct.view().items[g], window.__ct.view().items[l]])), [ghost, lamp]);
  ok(hg[0].k === 'g' && hg[0].b === null && !('t' in hg[0]) && !('f' in hg[0]) && !('up' in hg[0]) && hg[1].t === `${ghostBox}/lamp` && hg[1].f === 0,
    `on the host's screen: the hidden one is {k:'g', b: null, …} and the shown one keeps t and f (${JSON.stringify(hg[0])})`);
  ok(await host.waitForSelector(`.item[data-id="${ghost}"] .pface.placeholder`, { timeout: 10000 }).then(() => true, () => false), 'it renders as the "?" placeholder');
  ok(hostErrors.slice(errs0).some((e) => /missing/i.test(e)), `the missing box is reported with console.error (${hostErrors.slice(errs0).find((e) => /missing/i.test(e))})`);
  await M.waitForFunction((k) => window.M.got.state.slice(k).some(({ m }) => window.M.body(m).kind === 'snap'), before.state, { timeout: 30000 });
  await M.act({ t: 'hello' });
  await M.waitForFunction(([k, p]) => window.M.got.state.slice(k).some(({ m }) => { const d = window.M.body(m); return d.kind === 'snap' && d.to === p; }), [before.state, MPID], { timeout: 30000 });
  const snaps = (await X.bodiesSince(before.state)).filter((d) => d.kind === 'snap');
  ok(snaps.length && snaps.every((d) => { const g = d.items[ghost]; return g && g.k === 'g' && g.b === null && !('t' in g) && !('f' in g) && !('up' in g) && d.items[lamp]?.t === `${ghostBox}/lamp`; }),
    `every snapshot Mallory got from the reloaded host shows it as {k:'g', b: null} (${snaps.length} snapshot(s): ${JSON.stringify(snaps.at(-1)?.items[ghost])})`);
  const pileTop = (await items(host))[shadePile]?.top;
  ok(pileTop?.b === null && pileTop.up === false && !('t' in pileTop), `the face-down pile's top is {b: null, up: false} (${JSON.stringify(pileTop)})`);
  await M.act({ t: 'deal', id: shadePile, up: false, x: 2200, y: 1200 });
  ok(await until(async () => at(await items(host), 2200, 1200), 15000, 200), 'Mallory deals one face down from the ghost pile');
  const hand13 = await host.evaluate(() => JSON.parse(JSON.stringify(window.__ct.view().hand))), hi = hand13.findIndex((c) => c.t === `${ghostBox}/qzShade`);
  ok(hi >= 0 && hand13[hi].up === false, 'the host holds the other hidden ghost tile');
  ok((await act(host, { t: 'play', idx: hi, type: hand13[hi].t, f: hand13[hi].f, up: false, x: 2200, y: 1500 })).ok, 'and plays it face down');
  const its13 = await items(host), dealt = at(its13, 2200, 1200), played = at(its13, 2200, 1500);
  const stillHidden = (it) => it?.k === 'g' && it.b === null && !('t' in it) && !('f' in it) && !('up' in it);
  ok(stillHidden(its13[dealt]) && stillHidden(its13[played]), `neither turns face up for want of its box: both are {k:'g', b: null} (${JSON.stringify([its13[dealt], its13[played]])})`);
  await X.barrier(ids.marker);
  const mv13 = await M.evaluate(([a, b]) => [window.M.fold().items[a], window.M.fold().items[b]], [dealt, played]);
  ok(mv13.every(stillHidden), `and so in Mallory's view (${JSON.stringify(mv13)})`);

  section('8: 6,000 takes stop at 5,000 items, and the host stays responsive');
  const n8 = await host.evaluate(() => Object.keys(window.__ct.view().items).length);
  /** A box that lays out n plain tokens in one corner (count ≤ 200 an entry). */
  const filler = (name, n) => ({
    name, imgs: [], types: { f: { kind: 'token', name: 'Filler', stack: 'none', faces: [{ color: '#888888' }] } },
    setup: Array.from({ length: Math.ceil(n / 200) }, (_, k) => ({ piece: 'f', count: Math.min(200, n - 200 * k), at: [2800, 1800] })),
  });
  await loadBox(host, filler('Filler A', 3000), { clear: false });
  await loadBox(host, filler('Filler B', 5000 - 10 - n8 - 3000), { clear: false });
  const nFill = await host.evaluate(() => Object.keys(window.__ct.view().items).length);
  ok(nFill === 4990, `the host filled the table to 4,990 items (${n8} + two setups)`);
  await M.waitForFunction((n) => Object.keys(window.M.fold().items).length === n, nFill, { timeout: 60000 });
  await h.sleep(3000); // Mallory's action budget refills; the host's screen settles
  await host.evaluate(() => { window.LAG = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.LAG = Math.max(window.LAG, n - last - 50); last = n; }, 50); });
  const k8 = (await X.marks()).note;
  await M.evaluate((s) => { for (let k = 0; k < 6000; k++) window.M.act({ t: 'take', id: s, x: 2800, y: 100 }); }, ids.supply);
  const full = await until(async () => (await X.notesSince(k8)).includes(FULL), 60000, 300);
  ok(full, `Mallory is told "${FULL}"`);
  await h.sleep(6000);
  const n9 = await host.evaluate(() => Object.keys(window.__ct.view().items).length);
  ok(n9 === 5000, `the table stopped at 5,000 items (${n9})`);
  const lag = await host.evaluate(() => window.LAG);
  ok(lag < 1000, `the host's main thread never stalled for a second (worst ${lag | 0} ms)`);
  const t0 = Date.now(), mv8 = await act(host, { t: 'move', id: ids.marker, x: 1400, y: 1000 });
  ok(mv8.ok && Date.now() - t0 < 2000, `the host still moves a piece at once (${Date.now() - t0} ms)`);
  const own8 = await act(host, { t: 'take', id: ids.supply });
  ok(!own8.ok && own8.error === FULL, `the host's own take is refused at the cap too (${JSON.stringify(own8)})`);
  const setup8 = await act(host, { t: 'loadBox', box: filler('Filler C', 1), setup: true, clear: false });
  ok(!setup8.ok && setup8.error === FULL && (await host.evaluate(() => Object.keys(window.__ct.view().items).length)) === 5000, `a setup that doesn't fit is refused before its first piece (${JSON.stringify(setup8)})`);
  await h.sleep(3000);
  await X.barrier(ids.marker);
  ok(true, 'Mallory\'s next action is applied: the table answers');

  section('the whole record: what Mallory received, scanned once more');
  hits = [...(await scan(SECRETS, box)), ...(await scan({ qzGhost: GHOST.types.qzGhost, qzShade: GHOST.types.qzShade }, ghostBox))];
  ok(!hits.length, `no hidden type ref, face label or name in any body, the reload and the flood included (${hits.slice(0, 5).join('; ')})`);
  forms = await M.evaluate((x) => window.M.forms(x), [...hiddenIds, ghost, dealt, played]);
  ok(!forms.length, `every public form is §2d's (${forms.slice(0, 3).join('; ')})`);
  const unsorted = await M.evaluate(() => window.M.unsorted());
  ok(!unsorted.length, `every snapshot and patch lists its items in sorted-id order (${unsorted.slice(0, 3).join('; ')})`);
  await env.done();
})().catch(h.crash);
