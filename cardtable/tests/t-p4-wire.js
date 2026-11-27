// E2E: Phase 4A's engine over the wire (spec §4c, §4f, §4h; the 📦 dialog
// is Phase 4A part 2's, so every action goes through __ct.act, a click's own
// path). Alice hosts on a desktop; Bob plays on another.
//  1  Bob's addBox — a TransportBox, its images and its deck's as data URLs —
//     is checked on receipt, ingested outside the queue and registered only
//     (src upload, by Bob); Bob gets its PublicBox (no setup, rules or
//     rulesState) and pulls its images by hash.
//  2  The host sets it up with its rules: laid out on both screens, the
//     guest's face-down deck shuffled, the rules started on the box's state
//     ("@#k" mapped) as the box's (rules.box), after the setup committed.
//  3  Bob's setup and reset are refused at the boundary (host only); his
//     view and catalog never carry the box's hidden state.
//  4  The host's own addBox resolves with the box's id (twice: the same box).
//  5  Reset with the box's rules running restarts them; the Worker's digest
//     is the host's.
//  6  A host reload: lastSetup and rules.box are saved, so Reset still
//     restarts the rules.
//  7  A guest box over the guests' budget (shared with decks) is refused on
//     receipt, before anything is decoded.
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./h');
const { ok, section, logHas, toastHas } = h;

const IMG = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'fixtures/37x23.png')).toString('base64')}`;
const MARK = 'ZQXJ-hidden-state';
/** A TransportBox (spec §4c): the authoring format, its images inline. */
const def = (o = {}) => ({
  name: 'Wire test', players: [2, 4], imgs: [IMG],
  table: { shape: 'rect', w: 2400, h: 1600 },
  pieces: [
    { id: 'board', kind: 'board', w: 600, h: 400, grid: { type: 'square', cols: 6, rows: 4, cell: 100, labels: 'chess' } },
    { id: 'unit', kind: 'token', shape: 'rect', w: 60, back: 'b', faces: [{ img: 0 }, { label: 'U' }] },
  ],
  backs: [{ id: 'b', color: '#333' }],
  decks: [{ name: 'Cards', back: '#123456', cards: [{ n: 'one', img: IMG }, { n: 'two' }, { n: 'three' }, { n: 'four' }, { n: 'five' }, { n: 'six' }] }],
  setup: [
    { piece: 'board', at: 'center' },
    { piece: 'unit', at: { board: 'board', at: 'b2' }, owner: '#1' },
    { deck: 'Cards', at: [200, 200] },
    { hands: { '#2': [{ deck: 'Cards', i: 1 }] } },
  ],
  rules: "({ name: 'Wire rules', setup(t) { t.data.n = (t.data.n || 0) + 1; } })",
  rulesState: { data: { mark: MARK, first: '@#1' }, public: {}, asks: {}, secret: {} },
  ...o,
});
const settle = (page) => page.waitForFunction(() => window.__ct.jobs() === 0, null, { timeout: 15000 });
const state = (page) => page.evaluate(() => window.__ct.hostState());

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const pids = await host.evaluate(() => Object.keys(window.__ct.view().players));

  section("1 a guest's box registers only: src upload, by its sender; guests get its PublicBox and pull its images");
  ok(await guest.evaluate((d) => window.__ct.act({ t: 'addBox', box: d }).then((r) => r.ok), def()), "Bob's addBox is sent");
  await logHas(host, 'added the box «Wire test» (2 piece types)');
  let S = await state(host);
  const bid = Object.keys(S.boxes).find((id) => S.boxes[id].name === 'Wire test'), bob = pids.find((p) => S.players[p].name === 'Bob');
  ok(bid && S.boxSrc[bid].src === 'upload' && S.boxSrc[bid].by === bob && S.boxes[bid].imgs.every((x) => /^[0-9a-f]{64}$/.test(x)) && S.boxes[bid].rulesState.data.mark === MARK,
    `registered as Bob's upload, its images as asset ids, its rules state kept (${JSON.stringify(S.boxSrc[bid])})`);
  ok(Object.keys(S.items).length === 1 && !S.lastSetup, 'nothing laid out (the table still has its deck only)');
  await guest.waitForFunction((b) => !!window.__ct.boxes()[b], bid, { timeout: 15000 });
  const gb = await guest.evaluate((b) => window.__ct.boxes()[b], bid);
  ok(!('setup' in gb) && !('rules' in gb) && !('rulesState' in gb) && gb.decks?.Cards, "Bob's catalog holds the box without its setup, rules and rulesState");

  section('2 the host sets it up with its rules: both screens, the face-down deck shuffled, the rules started on its state');
  const r = await host.evaluate((b) => window.__ct.act({ t: 'setup', box: b, rules: true }), bid);
  await settle(host);
  S = await state(host);
  const seated = Object.entries(S.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360)).map(([q]) => q);
  ok(r.ok && S.lastSetup === bid && S.rules?.enabled && S.rules.name === 'Wire rules' && S.rules.box === bid && S.rules.data.first === seated[0] && S.rules.data.n === 1,
    `set up; the rules run as the box's, on its state ("@#1" → the first seated), their setup ran once (${JSON.stringify(S.rules?.data)})`);
  await logHas(host, 'set up «Wire test» (3 items), face-down piles shuffled');
  const deck = Object.values(S.items).find((x) => x.k === 'p');
  ok(deck && deck.cards.length === 6 && JSON.stringify(deck.cards.map((c) => c.i)) !== '[0,1,2,3,4,5]', `Bob's box: its face-down deck shuffled (${JSON.stringify(deck?.cards.map((c) => c.i))})`);
  await guest.waitForFunction(() => Object.keys(window.__ct.view().items).length === 3, null, { timeout: 15000 });
  const unit = Object.entries(S.items).find(([, x]) => x.t === `${bid}/unit`);
  ok(unit && unit[1].owner === seated[0] && unit[1].at.endsWith(':b2'), 'the unit on b2, owned by "#1"');
  await guest.waitForFunction((id) => { const img = document.querySelector(`[data-id="${id}"] img`); return img && img.complete && img.naturalWidth > 0; }, unit[0], { timeout: 20000 })
    .then(() => ok(true, "Bob's screen draws the unit's image, pulled from the host by hash"), (e) => ok(false, `Bob's screen draws the unit's image: ${e.message.split('\n')[0]}`));
  const hand = seated[1] === bob ? await guest.evaluate(() => window.__ct.hand()) : S.players[seated[1]].hand;
  ok(hand.length === 1 && hand[0].i === 1, 'the hand of "#2"');
  ok(await host.evaluate(async () => (await window.__ct.workerDigest()) === window.__ct.digest()), "the Worker's digest is the host's");

  section("3 a guest's setup and reset are refused (host only); the box's hidden state never reaches him");
  const before = (await state(host)).seq;
  await guest.evaluate((b) => window.__ct.act({ t: 'setup', box: b }), bid);
  await toastHas(guest, 'Only the host can do that');
  await guest.evaluate(() => window.__ct.act({ t: 'reset' }));
  await h.sleep(600);
  ok((await state(host)).seq === before, "Bob's setup and reset change nothing");
  const seen = await guest.evaluate(() => JSON.stringify([window.__ct.view(), window.__ct.boxes(), window.__ct.log()]));
  ok(!seen.includes(MARK) && !seen.includes('"rulesState"') && !seen.includes('"setup"'), "Bob's view, catalog and log hold no setup, no rulesState and none of t.data");

  section("4 the host's own addBox resolves with the box's id; the same box again, the same id");
  const mine = def({ name: 'Host box', rules: undefined, rulesState: undefined });
  const a1 = await host.evaluate((d) => window.__ct.act({ t: 'addBox', box: d }), mine);
  const a2 = await host.evaluate((d) => window.__ct.act({ t: 'addBox', box: d }), mine);
  S = await state(host);
  ok(a1.ok && a1.id && S.boxes[a1.id]?.name === 'Host box' && S.boxSrc[a1.id].src === 'host', `registered: {ok, id: ${a1.id}}, src host`);
  ok(a2.id === a1.id && !a2.ok && Object.values(S.boxes).filter((b) => b.name === 'Host box').length === 1, `again: the same id, nothing new (${JSON.stringify(a2)})`);

  section("5 Reset with the box's rules running restarts them, afresh on its state");
  await host.evaluate(() => window.__ct.act({ t: 'reset' }));
  await settle(host);
  await logHas(host, 'reset «Wire test»');
  S = await state(host);
  ok(S.rules.enabled && S.rules.box === bid && S.rules.data.n === 1 && Object.keys(S.items).length === 3, `the rules restarted (their setup ran on the box's state again: n = ${S.rules.data.n})`);
  ok(await host.evaluate(async () => (await window.__ct.workerDigest()) === window.__ct.digest()), "the Worker's digest is the host's");

  section('6 a host reload: lastSetup and rules.box are saved; Reset still restarts the rules');
  await h.sleep(1500); // (the save is deferred: SAVE_DEFER_MS, at most one a second)
  await host.reload();
  await host.waitForFunction(() => window.__ct?.hostState()?.rules?.enabled && window.__ct.jobs() === 0, null, { timeout: 20000 });
  S = await state(host);
  ok(S.lastSetup === bid && S.rules.box === bid && S.v === require(path.join(h.APP_ROOT, 'cardtable/core.js')).STATE_V, `resumed: lastSetup and rules.box kept, state v${S.v} (STATE_V: 5 in Phase 4, 6 in Phase 5)`);
  await host.evaluate(() => window.__ct.act({ t: 'reset' }));
  await settle(host);
  S = await state(host);
  const tail = S.log.slice(-4).map((e) => e.txt);
  ok(S.rules.enabled && S.rules.box === bid && S.rules.data.n === 1 && tail.includes('reset «Wire test»') && tail.some((l) => /^«Wire rules» enabled by Alice/.test(l)),
    `Reset after the reload: laid out again, the rules restarted (${JSON.stringify(tail)})`);
  await guest.waitForFunction(() => Object.keys(window.__ct.view().items).length === 3, null, { timeout: 20000 });

  section("7 a guest's box over the guests' budget (shared with decks) is refused on receipt");
  const big = def({ name: 'Big', rules: undefined, rulesState: undefined, meta: undefined, pad: 'x'.repeat(1.6e6) });
  await guest.evaluate((d) => window.__ct.act({ t: 'addBox', box: d }), big);
  await toastHas(guest, "Box rejected: this table's budget for guests is full");
  S = await state(host);
  ok(!Object.values(S.boxes).some((b) => b.name === 'Big'), 'nothing registered');
  await env.done();
})().catch(h.crash);
