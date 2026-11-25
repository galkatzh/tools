// Phase 4 (game boxes) in plain Node (spec §4l, core-p4.test.mjs), on the
// state core as app.js runs it: a host table, and — while rules run — a
// Worker-like mirror whose every job's patch the host checks and takes
// (room()). The sections follow §4l's list:
//  (1) cleanBox over the game.json authoring format (boxOfDef): the board
//      structure on the piece, the img shorthand, backs' defaults, decks,
//      rules and rulesState (shape and caps), h from w, "at": "seat", src
//      and by dropped; checkTransportBox; PublicBox; the grammar's refusals.
//  (2) The setup interpreter: every entry kind, forEachSeat over named and
//      automatic seats, "#k" (owners and hands), a "#k" past the seated
//      players failing before any op, {board, at} and address strings, the
//      item caps, a missing deck, ids reused or re-minted (remap), the
//      shuffle of face-down decks and piles; setup and reset as actions.
//  (3) `group` (Phase 4B): one sub-action per member under every check and,
//      with the rules on, the ruled pipeline from a savepoint of its own;
//      one line, one bulb, one notice; the flood cost; the patches.
// (Hx) Hexfront (Phase 4B): the generated box, set up as 📦's Built-in
//      does (loadBox with its rules), and its turn script played.
//  (4) Export → import round trips: a varied position, ids included, in a
//      fresh room with other players; chess and Hold'em mid-game, set up
//      there with their rules and played on.
//  (5) Deduplication: addBox and t.newBox of the same box.
//  (6) MIGRATE[4]; Reset after a save/load round trip (lastSetup, rules.box).
//  (7) setRules.state: "@#k", remapped ids, the §3a gates (attacker case 11).
//  (8) addBox: the guests' budget, refusals, ids kept or remapped, a forged
//      built-in (attacker case 10).
//  (9) The Worker path: box jobs' patches taken by the host (digests agree),
//      and forged ones refused (checkPatch).
// (10) The facade: t.boxes, t.box, t.layout.
// Then the test author's own sections, (1′) to (W′), written apart from the
// implementation (see their header below): items 1, 2, 4, 5 and 6 again,
// and the Worker contract of §4f; and (3′), item 3 (`group`) again, written
// apart from 4B's implementation.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { APP_ROOT, core, store, FIXTURES, ok, section, report, crash, guard, json, canon, rng, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

const templates = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));
const { BOXES, RULES_TEMPLATES } = templates;
const {
  createTable, cleanBox, boxOfDef, checkTransportBox, publicBox, isBuiltin, scriptHooks, MIGRATE, migrate, STATE_V, PROTO, RULES,
  MAX_SETUP_ITEMS, GUEST_DECK_CHARS, MAX_BOX_CHARS, HOST_ACTIONS, PUBLIC_ACTIONS, RULED_ACTIONS, CATALOG_ID_RE,
  GROUP_OPS, MAX_GROUP, groupIds, floodCost, snapRot, faceLabel, spliceBody, sealText, SIG, applyViewPatch,
} = core;

// --- small tools ----------------------------------------------------------------
const J = (v) => JSON.stringify(v);
const EVE = 'e'.repeat(16);
/** Runs fn with console.warn / console.error collected, not printed: {value, warn, error}. */
function quietly(fn) {
  const got = { warn: [], error: [] }, keep = [console.warn, console.error];
  console.warn = (...a) => got.warn.push(a.map(String).join(' '));
  console.error = (...a) => got.error.push(a.map(String).join(' '));
  try { got.value = fn(); } finally { [console.warn, console.error] = keep; }
  return got;
}
/** The error message fn throws, or '' when it doesn't. */
const thrown = (fn) => { try { quietly(fn); return ''; } catch (e) { return e.message; } };
const near = (a, b) => Math.abs(a - b) <= 0.5;
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const H1 = 'a1'.repeat(32), H2 = 'b2'.repeat(32); // (asset ids: what an ingested box's images are)

/** A room as app.js runs one: the host table `H` (its own runner answers
 *  the rules view only: pageHooks), a mirror `M` while rules run (built from
 *  the host's state at each Enable, the script loaded first, as
 *  rules-worker.js does), and job(p, a): the job on whichever runs it — the
 *  mirror's patch checked and taken by the host — then what the host's
 *  effects ask for: the `enable` of a setup with rules queues the box's
 *  setRules at once (app.js enableBox). Returns {fx: the host's effects,
 *  notes: the notices to p, toasts, lines: the log lines it wrote, error?}.
 *  `players`: [[pid, name]] joining after the host. `prefix`: the room's
 *  ids ("1" → 10000001…), so two rooms never mint alike. */
function room(pid, name, players = [], prefix = '1') {
  let n = 0, ready = null;
  const clk = { t: 1.7e12 }, uid = () => prefix + (++n).toString(16).padStart(7, '0');
  const pageHooks = {
    load: () => '', has: (h) => h === 'onSelect' && !!ready?.wants.includes('select'),
    flag: (k) => (k === 'strict' ? ready?.strict : undefined), call(h) { throw new Error(`${h}() ran on the page`); },
  };
  const H = quietly(() => createTable({}, { pid, now: () => (clk.t += 250), uid, hooks: pageHooks })).value;
  H.open(name);
  for (const [p, nm] of players) quietly(() => H.apply(p, { t: '_join', name: nm }));
  H.drain();
  const R = { H, M: null, clk, pid };
  const start = (code) => {
    H.syncSpots();
    const { keys, decks, boxes, boxSrc, ...state } = H.state, m = structuredClone({ state, decks, boxes, boxSrc }), hk = scriptHooks();
    const nm = hk.load(code);
    R.M = quietly(() => createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid, now: () => clk.t, uid, hooks: hk, mirror: true })).value;
    ready = { name: nm, wants: hk.has('onSelect') ? ['select'] : [], strict: hk.flag('strict') === true };
  };
  /** Job (p, a) as app.js's runJob runs it. */
  R.job = (p, a) => {
    const n0 = H.state.log.length;
    let error;
    if (a.t === 'setRules' && p === pid && a.enabled) start(a.code);
    else if (a.t === 'setRules' && p === pid) R.M = null;
    if (R.M) {
      const r = quietly(() => R.M.job(p, a)).value;
      if (r.fatal) throw new Error(`fatal: ${r.fatal}`);
      quietly(() => H.applyStatePatch(structuredClone(r.patch), structuredClone(r.out), { p, a }));
      R.M.drain();
      error = r.out.error;
    } else quietly(() => H.apply(p, a));
    const fx = H.drain(), lines = H.state.log.slice(n0).map((e) => e.txt);
    if (!H.state.rules?.enabled) R.M = null;
    const out = { fx, notes: fx.filter((e) => e.t === 'note' && e.p === p).map((e) => e.msg), toasts: fx.filter((e) => e.t === 'toast').map((e) => e.msg), lines, error };
    for (const e of fx.filter((x) => x.t === 'enable')) { // (app.js enableBox: the box's rules, first in the queue)
      const box = H.state.boxes[e.box];
      out.enabled = R.job(pid, { t: 'setRules', enabled: true, reset: true, code: box.rules, box: e.box, remap: e.remap, ...(box.rulesState && { state: box.rulesState }) });
    }
    H.takeDirty();
    return out;
  };
  R.same = () => !R.M || H.digest() === R.M.digest();
  /** The box id the last addBox named (its `added` effect). */
  R.add = (p, box, cost) => { const r = R.job(p, { t: 'addBox', box, ...(cost !== undefined && { cost }) }); r.id = r.fx.find((e) => e.t === 'added')?.id; return r; };
  R.seated = () => Object.entries(H.state.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360)).map(([q]) => q);
  return R;
}
/** The items of box `bid` on table T: its pieces and supplies, and the bags it made (cards and piles carry no box). */
const ofBox = (T, bid) => Object.entries(T.state.items).filter(([, it]) => (it.t || '').startsWith(`${bid}/`) || it.box === bid);

/** A test box in the authoring format (an ingested one: images are asset ids). */
function gameDef(o = {}) {
  return {
    name: 'Skirmish', id: 'abcd0001', players: [2, 4], imgs: [H1, H2],
    table: { shape: 'rect', w: 3000, h: 2000, felt: '#2c3e2f' },
    seats: [{ id: 'red', name: 'Red', edge: 'bottom', color: '#dc2626' }, { id: 'blue', name: 'Blue', edge: 'top', color: '#2563eb' }],
    lockable: 'anyone',
    backs: [{ id: 'unit', color: '#444' }, { id: 'tileb', img: 1 }],
    pieces: [
      { id: 'map', kind: 'board', img: 0, w: 1000, h: 800, primary: true, grid: { type: 'square', cols: 10, rows: 8, cell: 100, labels: 'chess' },
        spaces: [{ id: 'camp', x: -60, y: 400, r: 50 }] },
      { id: 'inf', kind: 'token', shape: 'rect', w: 60, stack: 'count', back: 'unit', faces: [{ label: 'I' }, { label: 'i' }], meta: { atk: 4 } },
      { id: 'd6', kind: 'die' },
      { id: 'gold', kind: 'token', shape: 'disc', w: 40, faces: [{ color: '#eab308', label: '1' }] },
      { id: 'tile', kind: 'tile', w: 70, back: 'tileb', faces: ['A', 'B', 'C', 'D'] },
    ],
    decks: [{ name: 'Events', id: 'abcd0002', back: '#123456', imgs: [], cards: [{ n: 'Storm' }, { n: 'Calm' }, { n: 'Fog' }, { n: 'Sun' }] }],
    setup: [
      { piece: 'map', at: 'center', id: 'abcd1001' },
      { piece: 'inf', n: 6, at: { board: 'map', at: 'c3' }, owner: 'seat:red', id: 'abcd1002' },
      { piece: 'inf', at: 'map:h6', owner: '#2', id: 'abcd1003' },
      { supply: 'gold', at: [200, 200] },
      { piece: 'd6', count: 2, spread: [70, 0], at: [2700, 200] },
      { deck: 'Events', at: [2700, 1000], id: 'abcd1004' },
      { pile: [{ piece: 'tile', f: 0 }, { piece: 'tile', f: 1 }, { piece: 'tile', f: 2 }, { piece: 'tile', f: 3 }], at: [2500, 1500], name: 'Tiles' },
      { card: { deck: 'Events', i: 3 }, up: true, at: [2400, 1000] },
      { bag: [{ t: 'tile', n: 3, up: false }, 'gold'], name: 'Sack', at: [300, 1600] },
      { forEachSeat: [{ piece: 'inf', n: 2, at: 'seat', owner: 'seat' }] },
      { hands: { '#1': [{ deck: 'Events', i: 0 }], blue: [{ piece: 'tile', f: 3 }] } },
    ],
    rules: "({ name: 'Skirmish rules', setup(t) { t.data.ran = (t.data.ran || 0) + 1; } })",
    rulesState: { data: { first: '@#1', camp: 'abcd1002', box: 'abcd0001' }, public: { round: 3 }, asks: { '@#2': [{ id: 'go', prompt: 'Ready?', options: ['yes', 'no'] }] }, secret: { '@#1': { text: 'You lead.' } } },
    meta: { edition: 1 },
    ...o,
  };
}

// =============================================================================
// (1) cleanBox over the authoring format
// =============================================================================
function testFormat() {
  section('(1) boxOfDef: the game.json authoring format, cleaned (§4a)');
  const { box, decks, id } = boxOfDef(gameDef());
  ok(id === 'abcd0001' && decks.length === 1 && decks[0][0] === 'Events' && decks[0][2] === 'abcd0002' && J(box.decks) === J({ Events: 'abcd0002' }),
    `the box asks for its id, its deck for its own, named in box.decks (${J(box.decks)})`);
  const map = box.types.map;
  ok(map.board?.grid?.labels === 'chess' && map.board.primary === true && map.board.spaces[0].id === 'camp' && map.faces.length === 1 && map.faces[0].img === 0,
    "the board's structure sits on the piece; img is the one-face shorthand");
  ok(box.types.inf.h === 60 && box.types.d6.faces.length === 6 && box.types.inf.meta.atk === 4 && box.types.gold.h === 40, 'h defaults to w (60 × 60, 40 × 40); a die gets its six faces; meta kept');
  ok(box.backs.unit.w === 60 && box.backs.unit.stack === 'count' && box.backs.unit.face.color === '#444' && box.backs.tileb.face.img === 1 && box.backs.tileb.w === 70,
    "backs take w/h/shape/rotStep/hand/stack from their first user; a back's img is its face");
  ok(box.rules.startsWith('({') && J(box.rulesState.public) === J({ round: 3 }) && box.meta.edition === 1, 'rules, rulesState and meta kept');
  const forged = boxOfDef(gameDef({ src: 'builtin', by: HOST, builtin: true })).box;
  ok(!('src' in forged) && !('by' in forged) && !('builtin' in forged), 'src, by and builtin are dropped');
  ok(canon(cleanBox(box)) === canon(box), 'cleanBox is idempotent on it');
  const seat = boxOfDef(gameDef({ setup: [{ forEachSeat: [{ piece: 'gold', at: 'seat' }] }] })).box;
  ok(seat.setup[0].forEachSeat[0].at === 'seat', '"at": "seat" inside forEachSeat (TABLETOP §4)');

  section('(1) the caps and gates of §4j: rules, rulesState, meta, decks, ids');
  for (const [what, def, re] of [
    ['rules of 200,001 characters', { rules: 'x'.repeat(200001) }, /^rules must be/],
    ['rules that are no text', { rules: 5 }, /^rules must be/],
    ['a rulesState with a field of its own', { rulesState: { data: {}, eval: {} } }, /^rulesState must be \{data, public, asks, secret\}/],
    ['a rulesState whose asks are a list', { rulesState: { asks: [] } }, /^rulesState must be/],
    ['a rulesState over 4e6 characters', { rulesState: { data: { x: 'y'.repeat(4e6) } } }, /^rulesState is too large/],
    ['meta over 8 KB', { meta: { x: 'y'.repeat(8200) } }, /^meta is too large/],
    ['two decks of one name', { decks: [gameDef().decks[0], { ...gameDef().decks[0], id: undefined }] }, /two decks are named «Events»/],
    ['a deck that embeds an image (not ingested)', { decks: [{ name: 'X', back: PNG1, cards: [{ n: 'a' }] }] }, /^decks\[0\]: this deck still embeds its images/],
    ['a box id that is no catalog id', { id: 'my-game' }, /^id must be an id of 8 hex digits/],
    ['a deck id that is no catalog id', { decks: [{ ...gameDef().decks[0], id: 'events' }] }, /^decks\[0\]\.id must be/],
  ]) {
    const e = thrown(() => boxOfDef(gameDef(def)));
    ok(re.test(e), `${what}: refused ("${e.slice(0, 90)}")`);
  }
  ok(!thrown(() => boxOfDef({ name: 'Cards only', decks: gameDef().decks })) && /^types needs at least 1 entry/.test(thrown(() => boxOfDef({ name: 'Nothing' }))),
    'a box of decks alone is a box (a card game\'s export); one with neither types nor decks is not');

  section('(1) the full setup grammar refuses what it cannot lay out (§4a)');
  const S = (setup, o = {}) => thrown(() => boxOfDef(gameDef({ setup, ...o })));
  for (const [what, setup, re] of [
    ['a deck the box lacks', [{ deck: 'Nope', at: 'center' }], /setup\[0\]: deck names no deck of the box/],
    ['a card past the deck\'s cap', [{ card: { deck: 'Events', i: 99999 }, at: 'center' }], /setup\[0\]\.card: i must be/],
    ['a pile of cards and pieces', [{ pile: [{ deck: 'Events', i: 0 }, { piece: 'tile' }], at: 'center' }], /pile mixes cards and pieces/],
    ['a pile of pieces that don\'t stack as a pile', [{ pile: [{ piece: 'inf' }], at: 'center' }], /pile holds pieces that don't stack together/],
    ['an empty pile', [{ pile: [], at: 'center' }], /pile needs at least 1 entry/],
    ['hands inside forEachSeat', [{ forEachSeat: [{ hands: { '#1': [{ deck: 'Events', i: 0 }] } }] }], /hands can't be inside forEachSeat/],
    ['a hand for a seat the box lacks', [{ hands: { green: [{ deck: 'Events', i: 0 }] } }], /hands names no seat: "green"/],
    ['a piece no hand may hold', [{ hands: { '#1': [{ piece: 'inf' }] } }], /"inf" can't be held in a hand/],
    ['an id on an entry of 2 items', [{ piece: 'gold', count: 2, at: 'center', id: 'abcd9999' }], /id is only for an entry that places one item/],
    ['an id inside forEachSeat', [{ forEachSeat: [{ piece: 'gold', at: 'seat', id: 'abcd9999' }] }], /id is only for an entry that places one item/],
    ['one id twice', [{ piece: 'gold', at: 'center', id: 'abcd9999' }, { supply: 'gold', at: 'center', id: 'abcd9999' }], /"abcd9999" is used twice/],
    ['an id that is no item id', [{ piece: 'gold', at: 'center', id: '__proto__' }], /id must be an item id/],
    ['{board, at} on no board type', [{ piece: 'gold', at: { board: 'gold', at: 'a1' } }], /board names no board of the box/],
    ['{board, at} on no spot of it', [{ piece: 'map', at: 'center' }, { piece: 'gold', at: { board: 'map', at: 'z9' } }], /at is no address of the board "map"/],
    ['{board, at} on a board never placed', [{ piece: 'gold', at: { board: 'map', at: 'a1' } }], /board "map" is never placed by this setup/],
    ['an address on none of its boards', [{ piece: 'gold', at: 'q99' }], /setup\[0\]: at must be/],
    ['free without [x, y]', [{ piece: 'gold', at: 'center', free: true }], /free must be true, with "at" as \[x, y\]/],
    ['an owner "#0"', [{ piece: 'gold', at: 'center', owner: '#0' }], /owner must be/],
  ]) {
    const e = S(setup);
    ok(re.test(e), `${what}: refused ("${e.slice(0, 110)}")`);
  }
  ok(!S([{ piece: 'map', at: 'center' }, { piece: 'gold', at: 'map:b2', owner: '#3' }, { piece: 'gold', at: 'camp' }, { piece: 'gold', at: 'map#1:j8' }]),
    'addresses bare, by board type, with #n, and a space id; an owner "#3": all accepted');

  section('(1) checkTransportBox: a TransportBox as it arrives, before anything is decoded');
  const tb = { ...gameDef(), imgs: [PNG1, PNG1], decks: [{ name: 'Events', id: 'abcd0002', back: PNG1, cards: [{ n: 'a', img: PNG1 }] }] };
  ok(checkTransportBox(tb) === J(tb).length, 'a good one: its cost is its JSON length');
  for (const [what, x, re] of [
    ['an image that is no data URL', { ...tb, imgs: ['https://evil/x.png'] }, /^imgs\[0\] is not an image/],
    ['an SVG data URL', { ...tb, imgs: ['data:image/svg+xml;base64,PHN2Zz4='] }, /^imgs\[0\] is not an image/],
    ['a face on an image the box lacks', { ...tb, imgs: [] }, /names no image of the box/],
    ['a box over MAX_BOX_CHARS', { ...tb, pad: 'x'.repeat(MAX_BOX_CHARS) }, /^the box is too large/],
    ['__proto__ type ids', { ...tb, pieces: [{ id: '__proto__', kind: 'token' }] }, /is not an id/],
  ]) {
    const e = thrown(() => checkTransportBox(x));
    ok(re.test(e), `${what}: refused ("${e.slice(0, 80)}")`);
  }

  section('(1) PublicBox: what guests see of a box (§4b, §4d)');
  const pub = publicBox(box, { src: 'upload', by: BOB });
  ok(!('setup' in pub) && !('rules' in pub) && !('rulesState' in pub) && pub.hasRules === true && pub.src === 'upload' && pub.by === BOB && pub.builtin === false && J(pub.decks) === J(box.decks) && pub.meta.edition === 1,
    'no setup, rules or rulesState; its decks and meta (public), hasRules, src, by, builtin');
  ok(!thrown(() => cleanBox(pub)) && canon(cleanBox(pub)) === canon((({ setup, rules, rulesState, ...x }) => x)(box)), "a guest's cleanBox takes it (the display fields dropped)");
  ok(publicBox(cleanBox(BOXES.draughts)).builtin === true && !('hasRules' in publicBox(cleanBox(BOXES.draughts))), 'a built-in box says so, by content');
}

// =============================================================================
// (2) The setup interpreter, and setup / reset as actions
// =============================================================================
function testSetup() {
  section('(2) addBox registers only; setup lays out every entry kind (§4a, §4c)');
  const R = room(HOST, 'Alice', [[BOB, 'Bob'], [CAROL, 'Carol']]), H = R.H;
  let r = R.add(HOST, gameDef());
  const bid = r.id;
  ok(bid === 'abcd0001' && r.lines.at(-1) === 'added the box «Skirmish» (5 piece types)' && !ofBox(H, bid).length && J(H.state.boxSrc[bid]) === J({ src: 'host', by: HOST }) && H.state.decks.abcd0002?.cards.length === 4,
    `registered under the id it asked for, its deck too; nothing laid out (${J(r.lines)})`);
  r = R.job(HOST, { t: 'setup', box: bid });
  const it = (id) => H.state.items[id], items = ofBox(H, bid), seated = R.seated();
  ok(r.lines.at(-1) === 'set up «Skirmish» (12 items)' && H.state.lastSetup === bid && !r.fx.some((e) => e.t === 'enable'), `logged "${r.lines.at(-1)}"; lastSetup; no rules asked for`);
  ok(J(H.state.table) === J({ shape: 'rect', w: 3000, h: 2000, felt: '#2c3e2f' }) && H.state.seats.length === 2 && seated.length === 2, 'its table and named seats (two of three players seated)');
  ok(it('abcd1001')?.lock === true && it('abcd1002')?.at === 'abcd1001:c3' && it('abcd1002').n === 6 && it('abcd1002').owner === 'seat:red' && it('abcd1003')?.at === 'abcd1001:h6' && it('abcd1003').owner === seated[1],
    `ids kept; {board: map, at: c3} and 'map:h6' snap there; owner "#2" is the second seated player clockwise (${it('abcd1003')?.owner?.slice(0, 4)})`);
  const all = Object.values(H.state.items), pile = it('abcd1004'), tiles = all.find((x) => x.name === 'Tiles'), card = all.find((x) => x.k === 'c'), bag = all.find((x) => x.k === 'b');
  ok(pile?.k === 'p' && pile.name === 'Events' && pile.cards.length === 4 && pile.cards.every((c) => c.d === 'abcd0002' && c.up === false) && J(pile.cards.map((c) => c.i)) === '[0,1,2,3]',
    'a deck entry: a face-down pile of the whole deck, in order (the host\'s box: not shuffled)');
  ok(J(tiles?.cards.map((c) => [c.f, c.up])) === J([[0, false], [1, false], [2, false], [3, false]]) && card?.up === true && card.i === 3,
    'a pile of pieces (face down: the type has a back); a loose card face up');
  ok(bag?.of.length === 4 && bag.box === bid && bag.name === 'Sack' && bag.of.filter((m) => m.up === false).length === 3, 'a bag of 3 hidden tiles and a gold');
  const perSeat = items.filter(([, x]) => x.t === `${bid}/inf` && x.n === 2);
  ok(perSeat.length === 2 && J(perSeat.map(([, x]) => x.owner).sort()) === J(['seat:blue', 'seat:red']), 'forEachSeat over the named seats: one stack of 2 each, owned by the seat');
  const red = H.state.players[seated[0]], blue = H.state.players[seated[1]];
  ok(J(red.hand) === J([{ d: 'abcd0002', i: 0 }]) && J(blue.hand) === J([{ t: `${bid}/tile`, f: 3 }]) && red.seatId === 'red', 'hands: "#1" (the first seated clockwise from the bottom: Red) and the seat "blue"');
  ok(H.pub && Object.values(H.publicItems()).every((x) => !(x.k === 'p' && x.cards)) && !J(H.publicItems()).includes('"i":0,"up":false'), 'the public view hides the piles and the face-down cards');

  section('(2) a setup that cannot be laid out fails before any op (§4c)');
  const seq = H.state.seq, digest = H.digest(), log = H.state.log.length;
  for (const [k, [what, setup, re]] of [
    ['a "#3" with two seated', [{ piece: 'gold', at: 'center', owner: '#3' }], /this game needs 3 seated players \(2 are seated\)/],
    ['a hand for "#5"', [{ hands: { '#5': [{ deck: 'Events', i: 0 }] } }], /this game needs 5 seated players/],
    ['a card past the deck', [{ card: { deck: 'Events', i: 9 }, at: 'center' }], /its deck «Events» has no card 9 \(it has 4\)/],
    ['more than MAX_SETUP_ITEMS (8 × 200 for each of the 3 players: no named seats)', [{ forEachSeat: Array.from({ length: 8 }, () => ({ piece: 'gold', count: 200, at: 'seat' })) }], /it places too many items \(4,800, max 3,000\)/],
  ].entries()) {
    const def = gameDef({ id: undefined, name: `Bad ${k}`, setup, ...(/MAX_SETUP/.test(what) && { seats: undefined }) });
    const b = R.add(HOST, def).id;
    r = R.job(HOST, { t: 'setup', box: b });
    ok(re.test(r.notes[0] || '') && /^🚫 Couldn't set up «Bad \d»: /.test(r.notes[0]) && H.digest() === digest && !r.lines.length && H.state.lastSetup === bid, `${what}: "${r.notes[0]}" — the table, its log and lastSetup untouched`);
  }
  const lost = R.add(HOST, { ...gameDef({ id: undefined, name: 'Lost deck', setup: [{ deck: 'Events', at: 'center' }] }) }).id;
  H.state.boxes[lost] = { ...H.state.boxes[lost], decks: { Events: 'dead0000' } }; // (a box whose deck is gone from the catalog)
  r = R.job(HOST, { t: 'setup', box: lost });
  ok(/its deck «Events» is missing from this table/.test(r.notes[0] || '') && H.digest() === digest, `a deck missing from the catalog: "${r.notes[0]}"`);
  const addr = R.add(HOST, gameDef({ id: undefined, name: 'No map', setup: [{ piece: 'gold', at: 'map:c3' }] })).id;
  r = R.job(HOST, { t: 'setup', box: addr });
  ok(/no such address 'map:c3'/.test(r.notes[0] || '') && H.digest() === digest && !r.lines.length, `an address no board on the table has: undone whole ("${r.notes[0]}")`);
  ok(H.state.seq >= seq && H.state.log.length === log + 6, `(only the six addBox lines were written: ${H.state.log.length - log})`);
  for (const [p, a, re] of [[BOB, { t: 'setup', box: bid }, /Only the host/], [BOB, { t: 'reset' }, /Only the host/], [HOST, { t: 'setup', box: 'ffff0000' }, /No such game box/],
    [HOST, { t: 'setup', box: bid, rules: true, clear: false }, null], [HOST, { t: 'reset', box: addr }, /Reset only resets the box last set up/]]) {
    if (!re) continue;
    r = R.job(p, a);
    ok(re.test(r.notes[0] || '') && H.digest() === digest, `${a.t} by ${p === HOST ? 'the host' : 'Bob'} (${J(a)}): refused ("${r.notes[0]}")`);
  }
  const plain = R.add(HOST, { name: 'Plain', pieces: [{ id: 'p', kind: 'die' }], setup: [{ piece: 'p', at: 'center' }] }).id;
  r = R.job(HOST, { t: 'setup', box: plain, rules: true });
  ok(/«Plain» has no rules/.test(r.notes[0] || ''), `rules: true needs box.rules ("${r.notes[0]}")`);

  section('(2) --keep: no clear; an id the table holds is minted anew (remap), and said once');
  r = R.job(HOST, { t: 'setup', box: bid, clear: false });
  ok(/^🚫 Couldn't set up «Skirmish»: the ambiguous address 'map:h6' \(h6 or map#2:h6\)/.test(r.notes[0] || '') && Object.keys(H.state.items).length === 12,
    `with a second map, its 'map:h6' is ambiguous: refused whole ("${r.notes[0]}")`);
  const keep = R.add(HOST, gameDef({ id: undefined, name: 'Keep', setup: gameDef().setup.filter((e) => typeof e.at !== 'string' || e.at === 'center') })).id;
  R.job(HOST, { t: 'setup', box: keep });
  r = R.job(HOST, { t: 'setup', box: keep, clear: false });
  const remap = r.toasts.find((m) => /ids? had to change/.test(m));
  ok(remap === '3 ids had to change; a running script that stored them may misbehave' && it('abcd1001') && Object.keys(H.state.items).length === 22 && Object.values(H.state.items).filter((x) => x.at?.endsWith(':c3')).length === 2,
    `the 3 ids taken got new ones: "${remap}"; both layouts on the table, {board, at} on each one's own map`);

  section('(2) reset: clears, lays the last setup out again (§4c)');
  R.job(HOST, { t: 'setup', box: bid });
  const hands0 = J(H.state.players[seated[0]].hand);
  r = R.job(HOST, { t: 'reset' });
  ok(r.lines.at(-1) === 'reset «Skirmish»' && ofBox(H, bid).length === 9 && it('abcd1002')?.at === 'abcd1001:c3' && J(H.state.players[seated[0]].hand) === hands0 && Object.keys(H.state.items).length === 12,
    `"reset «Skirmish»": the table cleared (hands too) and laid out afresh, ids as asked (${J(r.lines)})`);

  section("(2) a guest's box shuffles its face-down decks and piles by default (§4c, D83)");
  const guestBox = R.add(BOB, gameDef({ id: undefined, name: 'Bob\'s', rules: undefined, rulesState: undefined })).id;
  ok(H.state.boxSrc[guestBox]?.src === 'upload' && H.state.boxSrc[guestBox].by === BOB, "Bob's box: src upload, by Bob");
  let moved = 0;
  for (let k = 0; k < 6; k++) {
    r = R.job(HOST, { t: 'setup', box: guestBox });
    const all = Object.values(H.state.items), deck = all.find((x) => x.name === 'Events'), tl = all.find((x) => x.name === 'Tiles');
    if (J(deck.cards.map((c) => c.i)) !== '[0,1,2,3]' || J(tl.cards.map((c) => c.f)) !== '[0,1,2,3]') moved++;
  }
  ok(moved >= 5 && /, face-down piles shuffled$/.test(r.lines.at(-1)), `six setups: the deck or the tiles came out in another order ${moved} times; "${r.lines.at(-1)}"`);
  r = R.job(HOST, { t: 'setup', box: guestBox, shuffle: false });
  const kept = Object.values(H.state.items).find((x) => x.name === 'Events');
  ok(J(kept.cards.map((c) => c.i)) === '[0,1,2,3]' && !/shuffled/.test(r.lines.at(-1)), 'unticked (shuffle: false): its order as written');
  r = R.job(HOST, { t: 'setup', box: bid, shuffle: true });
  ok(/, face-down piles shuffled$/.test(r.lines.at(-1)), "the host's own box shuffled when asked");
}

// =============================================================================
// (4) Export → import round trips
// =============================================================================
/** The private state of table H in its own words, for comparing two rooms:
 *  every item by id (positions within 0.5), owners and hands by seat ("#k"
 *  for a seated player), bag contents as multisets. */
function position(R) {
  const H = R.H, K = new Map(R.seated().map((q, k) => [q, `#${k + 1}`])), ty = (t) => t?.slice(t.indexOf('/') + 1);
  const items = Object.fromEntries(Object.entries(H.state.items).map(([id, it]) => [id, {
    k: it.k, x: it.x, y: it.y, rot: it.rot, f: it.f, n: it.n, up: it.up, t: ty(it.t), at: it.at, lock: !!it.lock, name: it.name, i: it.i,
    owner: it.owner && (K.get(it.owner) ?? it.owner), cards: it.cards?.map((c) => J([c.i ?? ty(c.t), c.f, c.up])), of: it.of && it.of.map((m) => J([ty(m.t), m.f, m.up])).sort(),
  }]));
  const hands = Object.fromEntries([...K].map(([q, k]) => [k, H.state.players[q].hand.map((m) => J([m.i ?? ty(m.t), m.f, m.up]))]));
  return { items, hands, table: H.state.table, seats: H.state.seats };
}
/** Where positions a and b differ ('' when they don't). */
function differ(a, b) {
  for (const [id, x] of Object.entries(a.items)) {
    const y = b.items[id];
    if (!y) return `item ${id} is missing`;
    for (const k of Object.keys(x)) if (!(k === 'x' || k === 'y' ? near(x[k], y[k]) : J(x[k]) === J(y[k]))) return `item ${id}: ${k} ${J(x[k])} ≠ ${J(y[k])}`;
  }
  if (Object.keys(a.items).length !== Object.keys(b.items).length) return `${Object.keys(a.items).length} items ≠ ${Object.keys(b.items).length}`;
  return J(a.hands) !== J(b.hands) ? `hands ${J(a.hands)} ≠ ${J(b.hands)}` : J(a.table) !== J(b.table) ? 'table' : J(a.seats) !== J(b.seats) ? 'seats' : '';
}
function testRoundTrip() {
  section('(4) export a position to a box, set it up in a fresh room: the same private state, ids included (§4l item 4)');
  const A = room(HOST, 'Alice', [[BOB, 'Bob'], [CAROL, 'Carol']]);
  const bid = A.add(HOST, gameDef()).id;
  A.job(HOST, { t: 'setup', box: bid, rules: true });
  const H = A.H, seated = A.seated();
  // play a little: moves, a free piece off a spot, a hidden piece, a turn, a split, a draw into a hand, an owner by pid, a lock
  const inf = 'abcd1003', c = H.api.spot('d4');
  A.job(seated[1], { t: 'move', id: inf, x: c.x - 30, y: c.y - 30 });
  A.job(HOST, { t: 'rulesBtn', id: 'none' });
  quietly(() => {
    const t = H.api; // (the host's own facade: a test's hand, as core-p3 does)
    H.begin();
    t.move('abcd1002', { x: 1180, y: 700, free: true });
    t.spawn(`${bid}/tile`, { at: 'e5', up: false, rot: 90 });
    t.spawn(`${bid}/gold`, { at: { x: 900, y: 1700 }, owner: seated[0] });
    t.spawn(`${bid}/inf`, { at: 'map:a1', n: 3 });
    t.draw(seated[1], 'abcd1004', 1);
    t.lock('abcd1004', true);
    t.setFace('abcd1003', 1);
    H.commit(false);
  });
  H.takeDirty();
  H.state.rules.data.pick = seated[1];
  H.state.rules.secret[seated[1]] = { text: 'Blue knows.' };
  const before = position(A), { box, warnings } = quietly(() => H.exportBox({ rules: true, state: true })).value;
  ok(!warnings.length && box.id === bid && box.setup.length > 10 && box.setup.at(-1).hands && J(box.rulesState.data.pick) === '"@#2"' && box.rulesState.secret['@#2']?.text === 'Blue knows.' && box.rules === H.state.rules.code,
    `exported: the box's id, ${box.setup.length} entries, the hands by "#k", the state with "@#k" (${J(box.rulesState.data)})`);
  ok(box.setup.some((e) => e.free && e.id === 'abcd1002') && box.setup.some((e) => e.up === false && e.rot === 90) && box.setup.find((e) => e.id === 'abcd1004')?.lock === true,
    'a piece off its spot goes free; a hidden turned tile; a locked pile');
  ok(!J(box).includes(HOST) && !J(box).includes(BOB) && !J(box).includes(CAROL), 'no player id anywhere in it');
  const B = room(DAVE, 'Dave', [[EVE, 'Eve'], ['f'.repeat(16), 'Fay']], '2');
  const b2 = B.add(DAVE, box).id;
  const r = B.job(DAVE, { t: 'setup', box: b2, rules: true });
  const after = position(B), why = differ(before, after);
  ok(b2 === bid && !why, `in the fresh room: the box under its own id, and every item, owner, hand and pile as it was (${why || 'equal'})`);
  const S = B.seated();
  ok(r.enabled && B.H.state.rules.enabled && B.H.state.rules.box === b2 && B.H.state.rules.data.pick === S[1] && B.H.state.rules.secret[S[1]]?.text === 'Blue knows.' && B.H.state.rules.data.first === S[0] && B.H.state.rules.data.ran === 2 && B.same(),
    `the rules started on the state, "@#k" now the new room's players (pick → ${S[1].slice(0, 4)}), the digests agree`);
  ok(B.H.state.rules.asks[S[1]]?.[0]?.id === 'go' && J(B.H.mine(S[1]).ask?.[0]?.options) === J(['yes', 'no']), "the pending ask is the new #2's");
}

/** Plays chess's `from` → `to` for player p (the piece dragged to land centred on `to`). */
function chessMove(R, p, from, to) {
  const t = (R.M || R.H).api, id = t.at(from)[0]?.id, ty = t.type((R.M || R.H).state.items[id].t), c = t.spot(to);
  return R.job(p, { t: 'move', id, x: c.x - ty.w / 2, y: c.y - ty.h / 2 });
}
function testResumeElsewhere() {
  section('(4) chess exported mid-game, imported into a fresh room, played on (§4l item 4, t-p4-boxes item 8 in Node)');
  {
    const A = room(HOST, 'Alice', [[BOB, 'Bob']]);
    A.job(HOST, { t: 'setRules', enabled: true, code: RULES_TEMPLATES.chess, reset: true });
    const W = (R) => Object.keys(R.H.state.players).find((q) => R.H.state.players[q].seatId === 'white'), Bk = (R) => Object.keys(R.H.state.players).find((q) => R.H.state.players[q].seatId === 'black');
    chessMove(A, W(A), 'e2', 'e4');
    chessMove(A, Bk(A), 'e7', 'e5');
    chessMove(A, W(A), 'g1', 'f3');
    const boxId = A.H.state.rules.data.box, { box } = quietly(() => A.H.exportBox({ rules: true, state: true })).value;
    ok(A.H.state.rules.data.turn === 'b' && box.id === boxId && box.rulesState.data.box === boxId && box.rulesState.data.turn === 'b', `three plies played, Black to move; the export carries chess's box id (${boxId})`);
    const B = room(CAROL, 'Carol', [[DAVE, 'Dave']], '3');
    const b2 = B.add(CAROL, box).id, r = B.job(CAROL, { t: 'setup', box: b2, rules: true });
    ok(b2 === boxId && r.enabled && !r.enabled.error && B.H.state.rules.enabled && B.H.state.rules.data.box === boxId && B.H.state.rules.data.turn === 'b', 'set up with its rules in the fresh room: its box id kept, chess goes on where it was');
    const m = chessMove(B, Bk(B), 'b8', 'c6');
    ok(!m.error && !m.notes.length && B.H.state.rules.enabled && B.H.state.rules.data.turn === 'w' && B.H.api.at('c6')[0]?.t === `${boxId}/bN` && B.same(), `Black (now ${Bk(B) === DAVE ? 'Dave' : 'Carol'}) plays Nc6: legal, no script error (${J(m.lines.slice(-1))})`);
    const bad = chessMove(B, Bk(B), 'c6', 'd4');
    ok(/^🚫/.test(bad.notes[0] || '') && B.H.state.rules.enabled, `and the rules still refuse an illegal move ("${bad.notes[0]}")`);
  }
  section("(4) Hold'em exported mid-hand, imported, played on: pile ids and pid-keyed stacks")
  {
    const A = room(HOST, 'Alice', [[BOB, 'Bob']]);
    A.job(HOST, { t: 'setRules', enabled: true, code: RULES_TEMPLATES.holdem, reset: true });
    A.job(HOST, { t: 'rulesBtn', id: 'new' });
    const d = A.H.state.rules.data, toAct = d.turn, stacks = J(Object.values(d.stacks).sort());
    ok(d.stage === 'hand' && !!toAct && Object.values(A.H.state.players).every((pl) => pl.hand.length === 2), `a hand dealt: two cards each, ${toAct === HOST ? 'Alice' : 'Bob'} to act`);
    const { box } = quietly(() => A.H.exportBox({ rules: true, state: true })).value;
    ok(!box.pieces.length && box.decks.length === 1 && box.setup.at(-1).hands && !J(box).includes(HOST) && !J(box).includes(BOB), 'a box of one deck, no pieces; the hands by "#k"; no player id in it');
    const B = room(CAROL, 'Carol', [[DAVE, 'Dave']], '4');
    const b2 = B.add(CAROL, box).id, r = B.job(CAROL, { t: 'setup', box: b2, rules: true });
    const e = B.H.state.rules.data, K = (q) => A.seated().indexOf(q), mapped = B.seated()[K(toAct)];
    ok(r.enabled && !r.enabled.error && e.stage === 'hand' && e.turn === mapped && J(Object.values(e.stacks).sort()) === stacks && Object.keys(e.stacks).every((q) => B.H.state.players[q]),
      `the hand goes on: the turn is the same seat's (${mapped === CAROL ? 'Carol' : 'Dave'}), the stacks keyed by the new players`);
    const before = e.stacks[mapped], call = B.job(mapped, { t: 'rulesBtn', id: (B.H.state.rules.public.buttons || []).find((x) => x.pid === mapped && /^(call|check)$/.test(x.id))?.id });
    ok(!call.error && B.H.state.rules.enabled && call.lines.some((l) => /calls|checks/.test(l)) && B.H.state.rules.data.stacks[mapped] <= before && B.same(), `${mapped === CAROL ? 'Carol' : 'Dave'} calls: no script error (${J(call.lines.slice(-2))})`);
  }
}

// =============================================================================
// (5) Deduplication, (6) MIGRATE[4] and Reset after a reload
// =============================================================================
function testDedupMigrate() {
  section('(5) the same box twice: one catalog entry; a one-field change: a new box (§4c)');
  const R = room(HOST, 'Alice', [[BOB, 'Bob']]);
  const a = R.add(HOST, gameDef()), b = R.add(BOB, gameDef({ id: undefined }));
  ok(a.id === b.id && b.notes[0] === 'That box is already on this table' && !b.lines.length && Object.keys(R.H.state.boxes).length === 1 && !R.H.state.guestDeckChars,
    `the same content again (Bob's, without the id): the same box, "${b.notes[0]}", nothing spent`);
  const c = R.add(HOST, gameDef({ meta: { edition: 2 } }));
  ok(c.id && c.id !== a.id && Object.keys(R.H.state.boxes).length === 2 && c.toasts[0] === '2 ids had to change; a running script that stored them may misbehave',
    `meta changed: a new box (${c.id}); its id and its deck's were taken: remapped and said`);
  ok(R.H.state.boxes[c.id].rulesState.data.box === c.id && R.H.state.boxes[c.id].decks.Events !== 'abcd0002', "the box id in its rulesState is the new one");
  const def = { name: 'Plain', pieces: [{ id: 'p', kind: 'die' }], decks: [{ name: 'D', back: null, imgs: [], cards: [{ n: 'a' }] }] };
  const d = R.add(HOST, def).id;
  R.job(HOST, { t: 'setRules', enabled: true, code: '({ name: "S", buttons(t) { t.data.nb = t.newBox({ name: "Plain", pieces: [{ id: "p", kind: "die" }], decks: [{ name: "D", cards: [{ name: "a" }] }] }); return []; } })' });
  ok(R.H.state.rules.data.nb === d && Object.keys(R.H.state.boxes).length === 3, `t.newBox of the same box (its text deck alike) returns addBox's id (${R.H.state.rules.data.nb})`);

  section('(6) MIGRATE[4]: v4 → v5, lastSetup kept, rules.box absent');
  const v4 = { v: 4, seq: 3, table: { shape: 'round', w: 1300, h: 1300 }, seats: null, boardSeq: 0, zMax: 0, items: {}, players: {}, keys: {}, log: [], guestDeckChars: 0, lastSetup: 'abcd0001', rules: { code: '({})', name: 'R', enabled: false, data: {}, public: {}, asks: {}, secret: {} } };
  const m = MIGRATE[4](json(v4));
  ok(STATE_V === 6 && PROTO === 6 && m.v === 5 && m.lastSetup === 'abcd0001' && !('box' in m.rules) && canon(migrate(json(v4))) === canon(MIGRATE[5](json(m))), `v ${m.v}, lastSetup kept, no rules.box; migrate() goes on with MIGRATE[5] (Phase 5)`);

  section('(6) Reset after a save/load round trip: lastSetup and rules.box are saved');
  const S = room(HOST, 'Alice', [[BOB, 'Bob']]), bid = S.add(HOST, gameDef()).id;
  S.job(HOST, { t: 'setup', box: bid, rules: true });
  const save = json({ ...S.H.snapshot(), decks: S.H.state.decks, boxes: S.H.state.boxes, boxSrc: S.H.state.boxSrc });
  ok(save.lastSetup === bid && save.rules.box === bid && save.rules.enabled, 'the save holds lastSetup and rules.box');
  let k = 0;
  const T = quietly(() => createTable(json(save), { pid: HOST, now: () => 1.8e12, uid: () => (0xff000000 + ++k).toString(16) })).value;
  quietly(() => T.resume('Alice'));
  T.drain();
  T.state.rules.enabled = true; // (as the host's page does once the saved rules' Worker started: rules on, mirror elsewhere)
  quietly(() => { T.state.items.abcd1003.x += 300; });
  const r = quietly(() => T.apply(HOST, { t: 'reset' }));
  const fx = T.drain();
  ok(T.state.log.at(-1).txt === 'reset «Skirmish»' && fx.some((e) => e.t === 'enable' && e.box === bid) && T.state.items.abcd1003.at === 'abcd1001:h6',
    `resumed, then Reset: laid out again, and the box's rules asked to restart (rules.box = lastSetup) (${r.error.join('; ') || 'quietly'})`);
  T.state.rules.box = 'other';
  quietly(() => T.apply(HOST, { t: 'reset' }));
  ok(!T.drain().some((e) => e.t === 'enable'), "rules that aren't the box's: Reset leaves them be");
}

// =============================================================================
// (7) setRules.state: the gates (attacker case 11), "@#k", remapped ids
// =============================================================================
function testSeed() {
  section('(7) a forged engine state is dropped, loudly, on Set up (§4j attacker case 11)');
  const R = room(HOST, 'Alice', [[BOB, 'Bob']]);
  const many = Array.from({ length: 500 }, (_, k) => `o${k}`);
  const bad = gameDef({
    rulesState: {
      data: { _timers: [{ at: 'x', tag: 'boom' }, { at: 5, tag: 'ok' }], keep: 1 }, public: {},
      asks: { '@#1': [{ id: 'big', prompt: 'Pick', options: many }, { id: 'fine', prompt: 'OK?', options: ['y'] }] },
      secret: JSON.parse('{"__proto__": {"text": "x"}, "@#2": {"text": "fine"}, "@#7": {"text": "nobody"}}'),
    },
  });
  ok('__proto__' in boxOfDef(bad).box.rulesState.secret && Object.hasOwn(boxOfDef(bad).box.rulesState.secret, '__proto__'), '(the box keeps the forged entries: cleanBox checks only the shape)');
  const bid = R.add(HOST, bad).id, r = quietly(() => R.job(HOST, { t: 'setup', box: bid, rules: true })).value;
  const st = R.H.state.rules, S = R.seated();
  ok(J(st.data._timers) === J([{ at: 5, tag: 'ok' }]) && st.data.keep === 1 && J(st.asks[S[0]].map((x) => x.id)) === J(['fine']) && J(Object.keys(st.secret)) === J([S[1]]) && st.enabled,
    `the timer with at "x", the ask of 500 options, the secret keyed __proto__ and the one for "#7" (nobody) dropped; the rest seeded (${J(Object.keys(st.secret))})`);
  ok(J(r.enabled.toasts) === J(['Some saved game state was invalid and was dropped', "Some saved state referred to players who weren't seated; it was dropped"]),
    `one toast for the invalid, one for the unseated (${J(r.enabled.toasts)})`);
  const errs = quietly(() => createTable(json(R.H.state), { pid: HOST, now: () => 1.8e12 }).apply(HOST, { t: 'setRules', enabled: true, reset: true, code: '({ name: "X" })', state: bad.rulesState })).error;
  ok(errs.filter((e) => /^saved game state: .* — dropped/.test(e) || /_timers: dropped/.test(e)).length >= 4, `each drop is a console.error (${errs.length})`);

  section('(7) the ids that had to change are put into the state, then "@#k" (§4c)');
  let n = 0;
  const T = quietly(() => createTable({}, { pid: HOST, now: () => 1.7e12, uid: () => (0x30000000 + ++n).toString(16) })).value; // (its own runner: the scripts run here)
  quietly(() => { T.open('Alice'); T.apply(BOB, { t: '_join', name: 'Bob' }); });
  quietly(() => T.apply(HOST, { t: 'setRules', enabled: true, reset: true, code: '({ name: "Y" })', remap: { abcd1002: '99990000' }, state: { data: { u: 'abcd1002', l: ['@#2', 'abcd1002x'], o: { abcd1002: '@#1' } }, public: {}, asks: {}, secret: {} } }));
  const sx = Object.entries(T.state.players).filter(([, pl]) => pl.seat != null).sort(([, a], [, b]) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360)).map(([q]) => q);
  ok(J(T.state.rules.data) === J({ u: '99990000', l: [sx[1], 'abcd1002x'], o: { 99990000: sx[0] } }), `keys and values exactly equal to an old id or "@#k" are replaced, nothing else (${J(T.state.rules.data)})`);
  ok(!('box' in T.state.rules), 'no box given: no rules.box');
  quietly(() => T.apply(BOB, { t: 'setRules', enabled: true, reset: true, code: '({ name: "Z" })', state: { data: { evil: 1 } } }));
  ok(T.state.rules.name === 'Y' && !T.state.rules.data.evil, "a guest's setRules (with state) changes nothing: host only");
}

// =============================================================================
// (8) addBox: budget, refusals, ids, a forged built-in
// =============================================================================
function testAddBox() {
  section("(8) a guest's box: the guests' budget, shared with decks (§4c, D41)");
  const R = room(HOST, 'Alice', [[BOB, 'Bob']]);
  R.job(BOB, { t: 'addDeck', deck: { name: 'Mini', cards: [{ n: 'A' }] }, cost: GUEST_DECK_CHARS - 1000 });
  const used = R.H.state.guestDeckChars;
  let r = R.add(BOB, gameDef({ id: undefined }), 5000);
  ok(r.notes[0] === "🚫 Box rejected: this table's budget for guests is full (1 kB left) — ask the host to add it" && R.H.state.guestDeckChars === used && !Object.keys(R.H.state.boxes).length,
    `Bob's deck left 1 kB: his box of 5 kB is refused ("${r.notes[0]}")`);
  r = R.add(HOST, gameDef());
  ok(r.id && R.H.state.guestDeckChars === used, "the host's own box: no budget");
  const R2 = room(HOST, 'Alice', [[BOB, 'Bob']]);
  r = R2.add(BOB, gameDef({ id: undefined, name: 'Small' }), 4000);
  ok(r.id && R2.H.state.guestDeckChars >= 4000 && R2.H.state.boxSrc[r.id].src === 'upload', `within the budget: registered, its cost spent (${R2.H.state.guestDeckChars})`);

  section('(8) a box that fails cleanBox: "🚫 Box rejected: {message}"');
  r = R2.add(BOB, { name: 'Bad', pieces: [{ id: 'x', kind: 'unicorn' }] });
  ok(/^🚫 Box rejected: pieces\[0\] \(«x»\): kind must be one of/.test(r.notes[0] || ''), `named as its author wrote it: "${r.notes[0]}"`);

  section('(8) a forged built-in (§4j attacker case 10): src, by and the name buy nothing');
  const forged = { ...json(BOXES.draughts), src: 'builtin', by: HOST, builtin: true, types: { ...json(BOXES.draughts.types), light: { ...BOXES.draughts.types.light, name: 'Light mann' } } };
  const def = { ...forged, pieces: Object.entries(forged.types).map(([id, t]) => ({ id, ...t, ...t.board })), types: undefined };
  for (const t of def.pieces) delete t.board;
  r = R2.add(BOB, def);
  const rec = R2.H.state.boxSrc[r.id], box = R2.H.state.boxes[r.id];
  ok(rec.src === 'upload' && rec.by === BOB && box.name === 'Draughts' && !isBuiltin(box) && R2.H.api.boxes().find((x) => x.id === r.id).builtin === false,
    `stored as src upload, by Bob; isBuiltin false (${J(rec)})`);
  const real = R2.add(HOST, Object.assign({ ...json(BOXES.draughts), types: undefined }, { pieces: Object.entries(BOXES.draughts.types).map(([id, t]) => ({ id, ...json(t), ...json(t).board, board: undefined })) }));
  ok(isBuiltin(R2.H.state.boxes[real.id]) && R2.H.api.boxes().find((x) => x.id === real.id).builtin, 'the real one, in the authoring format: built in, by content');
}

async function testIngest() {
  section("(8) store.js ingestBox: a TransportBox's images checked and named by hash, its decks ingested with their ids (the host's preprocessing, §4c)");
  const png = fs.readFileSync(path.join(FIXTURES, '37x23.png')), url = `data:image/png;base64,${png.toString('base64')}`, h = await store.sha256hex(png);
  const tb = { ...gameDef(), imgs: [url, url], decks: [{ name: 'Events', id: 'abcd0002', back: url, cards: [{ n: 'a', img: url }, { n: 'b' }] }] };
  const { box, assets } = await store.ingestBox(tb);
  ok(J(box.imgs) === J([h, h]) && assets.size === 1 && assets.get(h).mime === 'image/png' && box.decks[0].id === 'abcd0002' && box.decks[0].backImg === h && box.decks[0].imgs[0] === h,
    "its images and its deck's as asset ids (one asset: the same bytes), the deck's id kept");
  const made = boxOfDef(box);
  ok(made.id === 'abcd0001' && made.decks[0][2] === 'abcd0002' && made.box.imgs[0] === h, 'what addBox takes (boxOfDef)');
  const fail = async (x) => { try { await store.ingestBox(x); return ''; } catch (e) { return e.message; } };
  const gif = `data:image/png;base64,${fs.readFileSync(path.join(FIXTURES, '37x23.gif')).toString('base64')}`;
  ok(/^image 2: the image claims to be image\/png but is image\/gif$/.test(await fail({ ...tb, imgs: [url, gif] })), 'an image whose bytes are another type than it claims: refused, named');
  ok(/^image 1: not a PNG\/JPEG\/WebP\/GIF image$/.test(await fail({ ...tb, imgs: ['data:image/svg+xml;base64,PHN2Zz4='] })), 'an SVG: refused, named');
  ok(/^deck 1 \(«Events»\): card 1: /.test(await fail({ ...tb, decks: [{ name: 'Events', cards: [{ n: 'a', img: gif }] }] })), "a deck's bad image: refused, naming the deck and the card");
}

// =============================================================================
// (9) The Worker path: box jobs in a mirror, checked by the host
// =============================================================================
function testWorkerPath() {
  section('(9) with rules on, addBox, setup and reset run in the mirror; the host takes their patches (digests agree)');
  const R = room(HOST, 'Alice', [[BOB, 'Bob'], [CAROL, 'Carol']]);
  R.job(HOST, { t: 'setRules', enabled: true, code: '({ name: "Watcher", onAction(t, a) { if (a.t === "addBox") t.say("a box!"); } })' });
  let r = R.add(BOB, gameDef({ id: undefined }), 3000);
  ok(r.id && R.H.state.boxSrc[r.id].src === 'upload' && r.lines.includes('a box!') && R.H.state.guestDeckChars >= 3000 && R.same(), `a guest's addBox, ruled: registered, onAction ran, the budget spent (${J(r.lines)})`);
  const bid = r.id;
  r = R.job(HOST, { t: 'setup', box: bid });
  ok(Object.keys(R.H.state.items).length === 12 && R.H.state.lastSetup === bid && R.same(), `setup in the mirror: 12 items, lastSetup, the digests agree (${Object.keys(R.H.state.items).length}, ${J(r.notes)})`);
  r = R.job(HOST, { t: 'setup', box: bid, rules: true });
  ok(r.enabled && R.H.state.rules.name === 'Skirmish rules' && R.H.state.rules.box === bid && R.same(), 'setup with rules from running rules: the box\'s rules start after it (rules.box)');
  r = R.job(HOST, { t: 'reset' });
  ok(r.enabled && R.H.state.rules.data.ran === 1 && R.same(), 'reset with the box\'s rules running: they restart afresh on its state');
  R.job(HOST, { t: 'setRules', enabled: true, code: '({ name: "Other" })' });
  ok(!('box' in R.H.state.rules) && R.same(), "another script enabled: rules.box goes (the patch says box: null)");

  section('(9) forged patches of box jobs are refused whole (checkPatch)');
  const L = room(HOST, 'Alice', [[BOB, 'Bob']]), gbid = L.add(HOST, gameDef()).id;
  L.job(HOST, { t: 'setRules', enabled: true, code: '({ name: "Plain" })' });
  const refused = (what, p, a, forge, re) => {
    const r0 = quietly(() => L.M.job(p, a)).value, P = structuredClone(r0.patch), O = structuredClone(r0.out);
    forge(P, O);
    const before = L.H.digest();
    let threw = null;
    try { quietly(() => L.H.applyStatePatch(P, O, { p, a })); } catch (e) { threw = e; }
    ok(threw && re.test(threw.message) && L.H.digest() === before, `${what}: refused (${threw?.message})`);
    L.job(HOST, { t: 'setRules', enabled: true, code: '({ name: "Plain" })' }); // (a fresh mirror from the host's table)
  };
  const ROT = { t: 'rot', id: 'abcd1003', rot: 90 }, mini = { name: 'Mini', pieces: [{ id: 'p', kind: 'die' }] };
  L.job(HOST, { t: 'setup', box: gbid });
  for (const [what, p, a, forge, re] of [
    ["Bob's box said to be the host's", BOB, { t: 'addBox', box: mini, cost: 100 }, (P) => { for (const r1 of Object.values(P.boxes)) r1.src = 'host'; }, /^the script added a game box in Bob's name$/],
    ["Bob's box with its rulesState rewritten", BOB, { t: 'addBox', box: { ...mini, rulesState: { data: { a: 1 } } }, cost: 100 }, (P) => { for (const r1 of Object.values(P.boxes)) r1.box.rulesState.data.a = 2; }, /^the script rewrote Bob's box$/],
    ['a box in a rot', HOST, ROT, (P) => { P.boxes = { ffff0001: { box: cleanBox({ name: 'X', types: { a: { kind: 'die', name: 'A' } } }), src: 'host', by: HOST } }; }, /^the script added a game box in Alice's name$/],
    ['a last setup in a rot', HOST, ROT, (P) => { P.lastSetup = gbid; }, /^the script set the last setup outside a setup$/],
    ['an enable in a rot', HOST, ROT, (P, O) => { O.effects.push({ t: 'enable', box: gbid, remap: {} }); }, /^the script asked for rules the host never chose$/],
    ['an enable in a setup without rules', HOST, { t: 'setup', box: gbid }, (P, O) => { O.effects.push({ t: 'enable', box: gbid, remap: {} }); }, /^the script asked for rules the host never chose$/],
    ['an enable with a remap the setup never made', HOST, { t: 'setup', box: gbid, rules: true }, (P, O) => { O.effects.find((e) => e.t === 'enable').remap = { abcd1002: 'abcd1003' }; }, /^the script asked for rules the host never chose$/],
    ["an addBox's `added` naming another box", BOB, { t: 'addBox', box: mini, cost: 100 }, (P, O) => { O.effects.find((e) => e.t === 'added').id = gbid; }, /^the script rewrote Bob's box$/],
    ["the rules' box set in a rot", HOST, ROT, (P) => { P.rules = { ...P.rules, box: gbid }; }, /^the script set the rules' box$/],
  ]) refused(what, p, a, forge, re);
}

// =============================================================================
// (3) group: one sub-action per member, each under every check and the
//     ruled pipeline, from a savepoint of its own (§4c, §3f.4, §4l item 3)
// =============================================================================
/** A box for group tests: a 10 × 8 grid map, tokens (free turns), a tile
 *  (90°), a hex token (60°), dice (one with a back), a bag; every placed
 *  item under an id "cafe00NN". */
function squad() {
  const id = (k) => `cafe00${k.toString(16).padStart(2, '0')}`;
  return {
    name: 'Squad', players: [2, 4], imgs: [], lockable: 'anyone',
    table: { shape: 'rect', w: 3000, h: 2000 },
    backs: [{ id: 'hid', color: '#333333' }],
    pieces: [
      { id: 'map', kind: 'board', w: 1000, h: 800, grid: { type: 'square', cols: 10, rows: 8, cell: 100 } },
      { id: 'inf', kind: 'token', shape: 'rect', w: 60, faces: [{ label: 'I' }, { label: 'i' }] },
      { id: 'sq', kind: 'tile', w: 80, faces: ['A', 'B'] },
      { id: 'hx', kind: 'token', shape: 'hex', w: 60, rotStep: 60, faces: ['H'] },
      { id: 'd6', kind: 'die' },
      { id: 'hd', kind: 'die', back: 'hid' },
    ],
    setup: [
      { piece: 'map', at: 'center', id: id(0) },
      ...[1, 2, 3, 4, 5].map((k) => ({ piece: 'inf', at: [1000 + 100 * k + 20, 620], id: id(k) })), // cells (k, 0)
      { piece: 'inf', at: [1120, 920], owner: '#2', id: id(6) },
      { piece: 'inf', at: [1220, 920], lock: true, id: id(7) },
      { piece: 'sq', at: [400, 300], id: id(8) },
      { piece: 'hx', at: [600, 300], id: id(9) },
      { piece: 'inf', n: 4, at: [800, 300], id: id(10) },
      { piece: 'd6', at: [2600, 200], id: id(11) },
      { piece: 'd6', at: [2700, 200], id: id(12) },
      { piece: 'hd', at: [2800, 200], up: false, id: id(13) },
      { bag: ['inf'], name: 'Sack', at: [300, 1600], id: id(14) },
    ],
  };
}
const C = (k) => `cafe00${k.toString(16).padStart(2, '0')}`;
function testGroup() {
  section('(3) group, rules off: one sub-action per member, every check; one line, one bulb, one notice');
  const R = room(HOST, 'Alice', [[BOB, 'Bob'], [CAROL, 'Carol']], '3'), H = R.H, bid = R.add(HOST, squad()).id;
  R.job(HOST, { t: 'setup', box: bid });
  const it = (k) => H.state.items[C(k)], xy = (ks) => ks.map((k) => [it(k).x, it(k).y]);
  // (the "#2" token's owner, and the third player, who owns nothing: their names from the seating)
  const two = it(6).owner, third = [BOB, CAROL].find((q) => q !== two), [TWO, THIRD] = [two, third].map((q) => H.state.players[q].name);
  ok(two === ranked(H)[1] && two !== HOST, `the setup: ${Object.keys(H.state.items).length} items, the "#2" token is ${TWO}'s`);
  const free = [1, 2, 3, 4, 5], before = xy(free), seq0 = H.state.seq;
  /** Player p's action on the host's table, as the app runs it (no Worker): what it said, and what the tick re-sends. */
  const run = (p, a) => { const q = quietly(() => H.apply(p, a)), fx = H.drain(), d = H.takeDirty(); return { changed: q.value, fx, lines: d.log.map((e) => [e.p, e.txt]), notes: fx.filter((e) => e.t === 'note' && e.p === p), sent: d.items }; };
  let r = run(HOST, { t: 'group', op: 'move', ids: [...free, 6, 7].map(C), dx: 100, dy: 0 });
  ok(J(xy(free)) === J(before.map(([x, y]) => [x + 100, y])) && free.every((k) => it(k).at?.endsWith(`:${k + 1},0`)), `the five free tokens moved one cell right, each snapped on its own (${J(free.map((k) => it(k).at))})`);
  ok(J(xy([6, 7])) === J([[1120, 920], [1220, 920]]), `${TWO}'s token and the locked one stay put`);
  ok(J(r.lines) === J([[HOST, 'moved 5 items']]), `one line, the actor's (${J(r.lines)})`);
  const bulbs = r.fx.filter((e) => e.t === 'fx');
  ok(bulbs.length === 1 && bulbs[0].f.p === HOST && bulbs[0].f.id === C(1) && bulbs[0].f.x === it(1).x, `one name bulb, on the first member moved, where it is now (${J(bulbs)})`);
  ok(J(r.notes.map((e) => [e.msg, !!e.ruled])) === J([[`2 of 7 were skipped: That belongs to ${TWO}`, false]]), `one notice, the first reason (bottom to top) — not a refusal: some applied (${J(r.notes)})`);
  ok(r.sent.has(C(6)) && r.sent.has(C(7)) && H.state.seq > seq0, 'the skipped members are re-sent (their optimistic drop snaps back)');

  r = run(two, { t: 'group', op: 'move', ids: [6, 7].map(C), dx: 100, dy: 0 });
  ok(J(r.lines) === J([[two, 'moved 1 item']]) && J(r.notes.map((e) => e.msg)) === J(['1 of 2 was skipped: That is locked in place']) && it(6).x === 1220, `${TWO} moves their own token; the locked one is skipped (${J(r.notes.map((e) => e.msg))})`);
  r = run(third, { t: 'group', op: 'move', ids: [6, 7].map(C), dx: 50, dy: 50 });
  ok(!r.lines.length && J(r.notes.map((e) => e.msg)) === J(['🚫 2 of 2 were skipped: That is locked in place']) && r.sent.has(C(6)) && r.sent.has(C(7)), `none of them ${THIRD}'s to move: one refusal (the first reason bottom to top: the locked one lies under the token just moved), both re-sent (${J(r.notes.map((e) => e.msg))})`);
  r = run(third, { t: 'group', op: 'move', ids: [C(7)], dx: 50, dy: 50 });
  ok(J(r.notes.map((e) => e.msg)) === J(['🔒 That is locked in place']), `a group of one says the single action's refusal, word for word (${J(r.notes.map((e) => e.msg))})`);

  section('(3) a group move keeps its shape at the table\'s edge (groupShift: the live drag\'s clamp)');
  const edge = [11, 12, 13], e0 = xy(edge);
  r = run(HOST, { t: 'group', op: 'move', ids: edge.map(C), dx: 5000, dy: -5000 });
  const e1 = xy(edge), dxs = e1.map(([x], j) => x - e0[j][0]), dys = e1.map(([, y], j) => y - e0[j][1]);
  ok(new Set(dxs).size === 1 && new Set(dys).size === 1 && e1.every(([x, y]) => x + 56 <= 3000 && y >= 0) && dxs[0] > 0 && dys[0] < 0, `the three dice slid as one, to the corner (shift ${dxs[0]}, ${dys[0]})`);
  const L = H.drag(HOST, { ids: edge.map(C), dx: 5000, dy: -5000 }), live = H.drain().find((e) => e.t === 'fx')?.f;
  ok(L && live.dx === 0 && live.dy === 0, `…and a live drag of them past the corner now relays no shift at all (${J(live)})`);

  section('(3) rot is a per-member delta, snapped to each member\'s rotStep; flip, lock, del, toBag');
  const r0 = [8, 9, 10].map((k) => it(k).rot);
  r = run(HOST, { t: 'group', op: 'rot', ids: [8, 9, 10].map(C), rot: 90 });
  ok(J([8, 9, 10].map((k) => it(k).rot)) === J([snapRot(r0[0] + 90, 90), snapRot(r0[1] + 90, 60), snapRot(r0[2] + 90, 0)]) && it(9).rot % 60 === 0,
    `tile +90 → ${it(8).rot}, hex (60° steps) → ${it(9).rot}, free token → ${it(10).rot}`);
  ok(J(r.lines) === J([[HOST, 'rotated 3 items']]), 'one line');
  r = run(HOST, { t: 'group', op: 'rot', ids: [8, 9].map(C), rot: -90 });
  ok(it(8).rot === r0[0] && J(r.lines) === J([[HOST, 'rotated 2 items']]), `turned back by −90: the tile is where it was (${it(8).rot})`);
  const f0 = [1, 2].map((k) => it(k).f);
  r = run(HOST, { t: 'group', op: 'flip', ids: [1, 2, 11].map(C) });
  ok(J([1, 2].map((k) => it(k).f)) === J(f0.map((f) => 1 - f)) && J(r.lines) === J([[HOST, 'flipped 2 items']]) && J(r.notes.map((e) => e.msg)) === J(['1 of 3 was skipped: Dice are rolled, not turned']),
    `two tokens flipped, the die skipped (${J(r.notes.map((e) => e.msg))})`);
  r = run(BOB, { t: 'group', op: 'lock', ids: [1, 2, 7].map(C), on: true });
  ok(it(1).lock && it(2).lock && J(r.lines) === J([[BOB, 'locked 2 items']]) && !r.notes.length, `lockable "anyone": Bob locks two; the one locked already is no skip, just nothing to do (${J(r.lines)})`);
  r = run(BOB, { t: 'group', op: 'lock', ids: [1, 2].map(C), on: false });
  ok(!it(1).lock && !it(2).lock && J(r.lines) === J([[BOB, 'unlocked 2 items']]), 'and unlocks them');
  const sack = it(14), n0 = sack.of.length;
  r = run(HOST, { t: 'group', op: 'toBag', ids: [3, 10, 11].map(C), bag: C(14) });
  ok(!it(3) && !it(10) && !it(11) && it(14).of.length === n0 + 1 + 4 + 1 && J(r.lines) === J([[HOST, 'put 3 items into the bag Sack']]), `into the bag: a token, a ×4 stack, a die (${it(14).of.length - n0} pieces) — one line (${J(r.lines)})`);
  r = run(HOST, { t: 'group', op: 'del', ids: [4, 5].map(C).concat(['dead0001']) });
  ok(!it(4) && !it(5) && J(r.lines) === J([[HOST, 'removed 2 items']]) && J(r.notes.map((e) => e.msg)) === J(['1 of 3 was skipped: it is gone']), `two removed, a gone one said (${J(r.notes.map((e) => e.msg))})`);

  section('(3) roll: one roll of the dice the player sees among the members; a hidden die is no die to them, and its value never shows');
  const hd0 = it(13).f;
  r = run(BOB, { t: 'group', op: 'roll', ids: [1, 2, 12, 13].map(C) });
  const want = `rolled 1 die: ${faceLabel(H.state.boxes[bid].types.d6.faces[it(12).f], it(12).f)}`;
  ok(J(r.lines) === J([[BOB, want]]) && it(13).f === hd0 && !r.notes.length, `the tokens aren't dice and the face-down die is hidden: Bob rolls the one die (${J(r.lines)})`);
  const rb = r.fx.filter((e) => e.t === 'fx');
  ok(rb.length === 1 && J(rb[0].f.roll) === J([C(12)]), `one bulb, with the tumble (${J(rb)})`);
  r = run(BOB, { t: 'group', op: 'roll', ids: [1, 13].map(C) });
  ok(!r.changed && J(r.notes.map((e) => e.msg)) === J(['🚫 Only dice can be rolled: none of those is a die']), `no die he can see: refused, nothing changes (${J(r.notes.map((e) => e.msg))})`);
  const box2 = { ...squad(), name: 'Dice tray', setup: [...Array(22)].map((_, k) => ({ piece: 'd6', at: [200 + 60 * k, 1700], id: `dd00${k.toString(16).padStart(4, '0')}` })) };
  const R2 = room(HOST, 'Alice', [[BOB, 'Bob']], '4'), b2 = R2.add(HOST, box2).id;
  R2.job(HOST, { t: 'setup', box: b2 });
  const many = Object.keys(R2.H.state.items);
  let q = R2.job(BOB, { t: 'group', op: 'roll', ids: many.slice(0, 4) });
  ok(/^rolled 4 dice: \d · \d · \d · \d$/.test(q.lines[0]) && q.lines.length === 1, `four dice: "${q.lines[0]}"`);
  q = R2.job(BOB, { t: 'group', op: 'roll', ids: many });
  ok(!q.lines.length && J(q.notes) === J(['🚫 Roll 1 to 20 different dice']), `22 dice: one roll takes at most 20, as the single roll says (${J(q.notes)})`);

  section('(3) the payload: ids capped at MAX_GROUP and deduplicated, a flood cost of 1 + ⌊N/20⌋; malformed groups refused');
  ok(MAX_GROUP === 200 && GROUP_OPS.join() === 'move,rot,flip,roll,lock,del,toBag,hide' && PUBLIC_ACTIONS.includes('group') && !RULED_ACTIONS.includes('group'), 'GROUP_OPS; group is a public action, ruled per member (not as a whole)');
  const big = [...Array(500)].map((_, k) => `e${String(k).padStart(7, '0')}`);
  ok(groupIds({ ids: big }).length === 200 && groupIds({ ids: [C(1), C(1), 7, '7', null, {}, C(2)] }).join() === [C(1), '7', C(2)].join(), 'groupIds: the first 200, each once, as text (a number its digits, as textIds reads it), nothing else');
  ok(floodCost({ t: 'group', ids: [...Array(200)].map((_, k) => 10000000 + k) }) === 11, 'a payload of 200 numeric ids costs what 200 text ids do (the job runs on them all)');
  ok([[1, 1], [19, 1], [20, 2], [200, 11], [500, 11]].every(([n, c]) => floodCost({ t: 'group', ids: big.slice(0, n) }) === c) && floodCost({ t: 'drag', ids: big }) === 1 && floodCost({ t: 'move' }) === 1,
    'floodCost: 1 + ⌊N/20⌋ for a group (N ≤ 200), 1 for anything else — a group drag too');
  const T3 = createTable({}, { pid: HOST, now: () => 1.7e12, uid: () => 'f0000001' }), g200 = { t: 'group', op: 'del', ids: big };
  const passed = [1, 2, 3, 4].filter(() => T3.mayAct(BOB, g200)).length, singles = [...Array(10)].filter(() => T3.mayAct(BOB, { t: 'move' })).length;
  ok(passed === 3 && singles === 7, `flood control: three 200-member groups (11 tokens each) pass a fresh burst of 40, the fourth doesn't; 7 single actions then do (${passed}, ${singles})`);
  const x1 = it(1).x;
  r = run(third, { t: 'group', op: 'move', ids: [...Array(300).fill(C(6)), ...Array(200).fill(C(1))], dx: 10, dy: 0 });
  ok(J(r.notes.map((e) => e.msg)) === J([`🚫 That belongs to ${TWO}`]) && it(1).x === x1, `Mallory's 500 ids, one of them ${TWO}'s 300 times: capped (the free token at 301 never looked at), deduplicated, skipped (${J(r.notes.map((e) => e.msg))})`);
  for (const [a, msg] of [
    [{ op: 'shuffle', ids: [C(1)] }, '🚫 A group can only move, rot, flip, roll, lock, del, toBag, hide'], [{ op: 'move', ids: [] }, "🚫 Name the group's items"], [{ op: 'move', ids: 'x' }, "🚫 Name the group's items"],
    [{ op: 'lock', ids: [C(1)] }, '🚫 Say lock or unlock (on: true or false)'], [{ op: 'toBag', ids: [C(1)], bag: C(2) }, '🚫 That is not a bag'],
  ]) {
    const s0 = H.state.seq;
    r = run(HOST, { t: 'group', ...a });
    ok(!r.changed && H.state.seq === s0 && J(r.notes.map((e) => e.msg)) === J([msg]), `${J(a)}: refused, nothing changes (${J(r.notes.map((e) => e.msg))})`);
  }

  section('(3) rules on: each member through handle / strict / validate from its own savepoint; a veto rolls back that member only');
  const picky = `({ name: 'Picky',
    validate(t, a) { if (a.id === '${C(3)}') return 'Not that one'; },
    onAction(t, a) { (t.data.seen ||= []).push([a.t, a.id, a.group ?? null, a.to ?? null, a.from ?? null]); t.say('saw ' + a.id); },
    buttons(t) { t.data.btn = (t.data.btn || 0) + 1; return []; } })`;
  const W = room(HOST, 'Alice', [[BOB, 'Bob']], '5'), wb = W.add(HOST, squad()).id;
  W.job(HOST, { t: 'setup', box: wb });
  W.job(HOST, { t: 'setRules', enabled: true, code: picky });
  const wit = (k) => W.H.state.items[C(k)], btn0 = W.H.state.rules.data.btn;
  const at0 = free.map((k) => wit(k).at);
  q = W.job(HOST, { t: 'group', op: 'move', ids: free.map(C), dx: 0, dy: 100 });
  ok(free.every((k) => (k === 3 ? wit(k).y === 620 : wit(k).y === 720)) && W.same(), `four moved down a cell; the vetoed one stays put; the host took the mirror's patch, the digests agree (${J(free.map((k) => wit(k).y))})`);
  const seen = W.H.state.rules.data.seen;
  const local = (at) => at.slice(at.indexOf(':') + 1); // (the display form: one board, its local address)
  ok(seen.length === 4 && seen.every(([t, id, g, to, from]) => t === 'move' && g === 5 && to === local(wit(+id.slice(-2)).at) && from === local(at0[free.indexOf(+id.slice(-2))])) && !seen.some(([, id]) => id === C(3)),
    `onAction ran for each member applied, seeing {group: 5} and its own a.to / a.from (${J(seen.map((s) => s.slice(1)))})`);
  ok(W.H.state.rules.data.btn === btn0 + 1, `buttons() ran once for the group (${btn0} → ${W.H.state.rules.data.btn})`);
  ok(J(q.lines) === J(['saw cafe0001', 'saw cafe0002', 'saw cafe0004', 'saw cafe0005', 'moved 4 items', 'blocked Alice: Not that one (1 of 5)']), `the rules' own lines, one line for the moves, one "blocked" line (${J(q.lines)})`);
  const note = (x) => J(x.fx.filter((e) => e.t === 'note' && e.p === HOST).map((e) => [e.msg, e.ruled === true]));
  ok(note(q) === J([['1 of 5 was skipped: Not that one', true]]), `one notice, flagged as the rules' refusal (${note(q)})`);
  q = W.job(HOST, { t: 'group', op: 'move', ids: [3, 6].map(C), dx: 0, dy: 100 });
  ok(note(q) === J([['🚫 2 of 2 were skipped: Not that one', true]]), `the first reason (bottom to top) the rules', the second the engine's (Bob's token): flagged as the first is (${note(q)})`);
  q = W.job(HOST, { t: 'group', op: 'move', ids: [6, 7].map(C), dx: 0, dy: 100 });
  ok(note(q) === J([['🚫 2 of 2 were skipped: That belongs to Bob', false]]) && !q.lines.length, `the engine's refusals alone: not flagged, no "blocked" line (${note(q)})`);

  W.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Strict', strict: true, allow: ['rot'] })" });
  const y0 = free.map((k) => wit(k).y);
  q = W.job(HOST, { t: 'group', op: 'move', ids: [1, 2].map(C), dx: 0, dy: 100 });
  ok(J(free.map((k) => wit(k).y)) === J(y0) && J(q.notes) === J(['🚫 2 of 2 were skipped: Not a move in this game']) && W.same(), `strict, per member: a move is refused for each (${J(q.notes)})`);
  q = W.job(HOST, { t: 'group', op: 'rot', ids: [8, 9].map(C), rot: 90 });
  ok(J(q.lines) === J(['rotated 2 items']) && W.same(), 'a rot its `allow` lists goes through');

  section('(3) a handle or validate that throws fails the whole group closed; a later hook keeps the members done');
  for (const hook of ['handle', 'validate']) {
    W.job(HOST, { t: 'setRules', enabled: true, code: `({ name: 'Boom', ${hook}(t, a) { t.data.n = (t.data.n || 0) + 1; if (a.id === '${C(3)}') throw new Error('boom'); } })` });
    const xs = free.map((k) => [wit(k).x, wit(k).y]), log0 = W.H.state.log.length;
    q = W.job(HOST, { t: 'group', op: 'move', ids: free.map(C), dx: 0, dy: 100 });
    ok(J(free.map((k) => [wit(k).x, wit(k).y])) === J(xs) && !W.H.state.rules.enabled && !W.H.state.rules.data.n, `${hook}() throws at the third member: nothing moved, not even the first two; no hook's writes kept; the rules off`);
    ok(J(q.notes) === J(['🚫 rules script error']) && J(W.H.state.log.slice(log0).map((e) => e.txt)) === J([`rules disabled — script error in ${hook}()`, 'blocked Alice: rules script error']), `one refusal, the single action's words (${J(q.notes)}, ${J(q.lines)})`);
  }
  const order = [...free].sort((x, y) => wit(x).z - wit(y).z), ys = order.map((k) => wit(k).y); // (bottom to top: the order the members run in)
  W.job(HOST, { t: 'setRules', enabled: true, code: `({ name: 'Late', onAction(t, a) { t.data.done = (t.data.done || 0) + 1; if (a.id === '${C(order[1])}') { t.data.bad = 1; throw new Error('late'); } } })` });
  q = W.job(HOST, { t: 'group', op: 'move', ids: free.map(C), dx: 0, dy: 100 });
  ok(J(order.map((k, j) => wit(k).y - ys[j])) === J([100, 100, 0, 0, 0]) && W.H.state.rules.data.done === 1 && !('bad' in W.H.state.rules.data) && !W.H.state.rules.enabled,
    `onAction throws at the second member: the first two moved (their effects kept), the hook's own writes undone, the rest skipped, the rules off (${J(W.H.state.rules.data)})`);
  ok(J(q.notes) === J(['3 of 5 were skipped: rules script error']) && q.lines.includes('moved 2 items'), `said once (${J(q.notes)})`);

  section('(3) the host takes a group job\'s patch whole, and still refuses a forged one; `group` on a single action is the host\'s');
  W.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Mark', onAction(t, a) { t.data.g = a.group ?? 'none'; } })" });
  q = W.job(BOB, { t: 'move', id: C(6), x: 1320, y: 920, group: 9 });
  ok(W.H.state.rules.data.g === 'none' && W.same(), `a single move's forged {group: 9} never reaches the hooks (${W.H.state.rules.data.g})`);
  const ga = { t: 'group', op: 'move', ids: [1, 2].map(C), dx: 0, dy: -100 }, m0 = quietly(() => W.M.job(HOST, ga)).value, y1 = wit(1).y;
  const forged = structuredClone(m0.out);
  forged.effects.push({ t: 'fx', f: { p: BOB, id: C(1), x: 0, y: 0 } });
  let threw = '';
  try { quietly(() => W.H.applyStatePatch(structuredClone(m0.patch), forged, { p: HOST, a: ga })); } catch (e) { threw = e.message; }
  ok(/name bulb into Alice's group/.test(threw), `a bulb in Bob's name in Alice's group: refused (${threw})`);
  quietly(() => W.H.applyStatePatch(structuredClone(m0.patch), structuredClone(m0.out), { p: HOST, a: ga }));
  ok(W.same() && wit(1).y === y1 - 100, 'the honest patch: taken');
}

// =============================================================================
// (Hx) Hexfront: the generated hex-map skeleton and its turn script (§4, §4l
//      t-p4-hexfront items 1–6 in Node), and loadBox's `rules`
// =============================================================================
async function testHexfront() {
  section('(Hx) BOXES.hexfront: built in by content, the same box on every load (a fixed seed), original');
  const fresh = (await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')).href + '?again')).BOXES.hexfront;
  const HX = BOXES.hexfront, B = cleanBox(json(HX));
  ok(fresh !== HX && canon(cleanBox(json(fresh))) === canon(B) && isBuiltin(HX) && isBuiltin(cleanBox(json(fresh))), 'a second evaluation of templates.js generates the same box: built in by content');
  const units = B.setup.filter((e) => B.types[e.piece]?.meta?.side), g = B.types.map.board.grid;
  ok(units.length === 40 && units.every((e) => e.n === 10 && e.owner === `seat:${B.types[e.piece].meta.side}`) && units.filter((e) => e.owner === 'seat:azure').length === 20,
    `400 counters in 40 stacks of ten, 20 a side, each owned by its side's seat (${units.length} stacks)`);
  ok(g.type === 'hex' && g.cols === 24 && g.rows === 16 && Object.keys(g.fills).length > 60 && g.marks.length === 8 && B.types.map.board.zones.length === 2,
    `one hex map, 24 × 16: ${Object.keys(g.fills).length} terrain fills, 8 towns, two deployment zones`);
  const ev = B.setup.find((e) => e.pile);
  ok(B.types.d6.kind === 'die' && B.setup.filter((e) => e.piece === 'd6').reduce((n, e) => n + (e.count ?? 1), 0) === 2 && ev?.pile.length === 24 && ev.name === 'Events' && B.types.event.back && B.types.event.hand,
    'two dice; 24 event cards, a face-down pile of tiles one may hold in a hand');
  ok(J(B.seats.map((s) => s.id)) === J(['azure', 'ember']) && B.rules.includes("name: 'Hexfront'") && J(HX.players) === J([2, 2]) && HX.meta.pitch, 'two seats, Azure and Ember; its turn script; a pitch for 📦');

  section('(Hx) Set up as 📦\'s Built-in does: loadBox {setup, clear, rules} — the box\'s rules start right after it');
  const R = room(HOST, 'Alice', [[BOB, 'Bob']], '7'), H = R.H;
  let q = R.job(HOST, { t: 'loadBox', box: json(HX), setup: true, clear: true, rules: true });
  const bid = H.state.lastSetup, items = () => Object.entries(H.state.items);
  ok(q.enabled && H.state.rules.enabled && H.state.rules.name === 'Hexfront' && H.state.rules.box === bid && isBuiltin(H.state.boxes[bid]) && R.same(), `set up, its turn script running as the box's (rules.box): ${J(q.lines)}`);
  ok(items().length === 44 && items().filter(([, it]) => it.n === 10).length === 40 && items().reduce((n, [, it]) => n + (it.n || 0), 0) === 400, `on the table: 44 items, 400 counters in 40 stacks (${items().length})`);
  const holder = (side) => Object.keys(H.state.players).find((p) => H.state.players[p].seatId === side), az = holder('azure'), em = holder('ember');
  ok(az && em && az !== em && H.state.rules.public.turn === az && J(H.state.rules.public.buttons) === J([{ id: 'combat', label: '⚔ To combat', pid: az }]) && H.state.rules.data.turn === 1,
    `Azure (${H.state.players[az].name}) to move: the turn cue and the phase button are theirs`);
  ok(q.enabled.lines.includes('shuffled the Events pile (24 pieces)'), 'the event cards were shuffled when the rules started');
  const mine = (side) => items().filter(([, it]) => it.owner === `seat:${side}`).map(([id]) => id), AZ = mine('azure'), EM = mine('ember');
  const dice = items().filter(([, it]) => it.t?.endsWith('/d6')).map(([id]) => id), events = items().find(([, it]) => it.name === 'Events')[0];
  const dy = 1.5 * (100 / Math.sqrt(3)), it = (id) => H.state.items[id];

  section('(Hx) the turn script: only the side to play moves its own units; split, join, combat, an event card');
  q = R.job(em, { t: 'move', id: EM[0], x: it(EM[0]).x, y: it(EM[0]).y + dy });
  ok(J(q.notes) === J(["🚫 It's Azure's turn"]) && R.same(), `Ember moves out of turn: refused (${J(q.notes)})`);
  q = R.job(az, { t: 'move', id: EM[0], x: it(EM[0]).x, y: it(EM[0]).y + dy });
  ok(J(q.notes) === J(['🚫 That belongs to Ember']), `Azure moves Ember's stack: the engine's owner check (${J(q.notes)})`);
  const at0 = AZ.slice(0, 5).map((id) => it(id).at);
  q = R.job(az, { t: 'group', op: 'move', ids: AZ.slice(0, 5), dx: 0, dy: -dy });
  ok(J(q.lines) === J(['moved 5 items']) && AZ.slice(0, 5).every((id, k) => it(id).at !== at0[k] && it(id).at) && R.same(), `Azure moves five stacks a row up as a group, each on a hex (${J(AZ.slice(0, 5).map((id) => it(id).at.split(':')[1]))})`);
  q = R.job(em, { t: 'group', op: 'move', ids: EM.slice(0, 5), dx: 0, dy });
  ok(J(q.notes) === J(["🚫 5 of 5 were skipped: It's Azure's turn"]) && q.lines.includes("blocked Bob: It's Azure's turn (5 of 5)"), `Ember's group out of turn: every member vetoed, one notice (${J(q.notes)})`);
  q = R.job(az, { t: 'split', id: AZ[0], n: 4, x: it(AZ[0]).x + 100, y: it(AZ[0]).y });
  const part = items().find(([id, x]) => x.n === 4 && x.t === it(AZ[0]).t && id !== AZ[0])?.[0];
  ok(part && it(AZ[0]).n === 6 && it(part).owner === 'seat:azure', `split: 4 off a stack of ten, still Azure's (${J(q.lines)})`);
  q = R.job(az, { t: 'join', id: part, onto: AZ[0] });
  ok(!it(part) && it(AZ[0]).n === 10, `join: back to ten (${J(q.lines)})`);
  q = R.job(az, { t: 'roll', ids: dice });
  ok(J(q.notes) === J(['🚫 Dice are rolled in the combat phase']), 'no dice in the movement phase');
  q = R.job(az, { t: 'rulesBtn', id: 'combat' });
  ok(H.state.rules.data.phase === 'combat' && J(H.state.rules.public.buttons) === J([{ id: 'end', label: '⏭ End turn', pid: az }]) && H.state.rules.public.badges[az] === '⚔ Combat', '⚔ To combat: the phase moves on, End turn offered');
  q = R.job(az, { t: 'move', id: AZ[6], x: it(AZ[6]).x, y: it(AZ[6]).y - dy });
  ok(J(q.notes) === J(['🚫 Movement is over this turn — fight, or End turn']), 'no movement in combat');
  q = R.job(em, { t: 'group', op: 'roll', ids: dice });
  ok(J(q.notes) === J(['🚫 Only Azure rolls this turn']), "the defender doesn't roll");
  q = R.job(az, { t: 'group', op: 'roll', ids: dice });
  ok(/^rolled 2 dice: \d · \d$/.test(q.lines[0]) && R.same(), `the attacker rolls both dice, as a group: "${q.lines[0]}"`);
  const f0 = it(EM[1]).f;
  q = R.job(em, { t: 'flip', id: EM[1] });
  ok(it(EM[1]).f === 1 - f0 && R.same(), 'the defender takes a loss on their own stack (a flip to its reduced face) in combat');
  q = R.job(em, { t: 'draw', id: events });
  ok(J(q.notes) === J(['🚫 Only Azure draws an event this turn']), 'only the side to play draws an event');
  q = R.job(az, { t: 'draw', id: events });
  const hand = H.state.players[az].hand;
  ok(hand.length === 1 && hand[0].t === `${bid}/event` && q.lines.some((l) => l.startsWith('drew a piece from')), `Azure draws an event card into their hand (${J(hand)})`);
  q = R.job(az, { t: 'draw', id: events });
  ok(J(q.notes) === J(['🚫 One event a turn']) && H.state.players[az].hand.length === 1, 'one a turn');
  q = R.job(em, { t: 'rulesBtn', id: 'end' });
  ok(J(q.notes) === J(['🚫 That button is not available to you right now']) && H.state.rules.data.side === 'azure', "End turn is Azure's button: Ember's press is refused by the engine");
  q = R.job(az, { t: 'rulesBtn', id: 'end' });
  ok(H.state.rules.data.side === 'ember' && H.state.rules.data.turn === 1 && H.state.rules.public.turn === em && q.lines.includes('📣 Turn 1 — Ember moves') && R.same(), `End turn: Ember moves (${J(q.lines)})`);
  q = R.job(em, { t: 'move', id: EM[2], x: it(EM[2]).x, y: it(EM[2]).y + dy });
  ok(!q.notes.length && q.lines[0]?.startsWith('moved'), 'now Ember moves');
  R.job(em, { t: 'rulesBtn', id: 'combat' });
  R.job(em, { t: 'rulesBtn', id: 'end' });
  ok(H.state.rules.data.turn === 2 && H.state.rules.data.side === 'azure' && !H.state.rules.data.drew && R.same(), 'and back to Azure: turn 2, a fresh event draw');

  section('(Hx) loadBox {rules}: only for a box with rules; its `enable` taken from a Worker only as the engine writes it');
  const plain = { ...cleanBox(json(BOXES.draughts)) };
  q = R.job(HOST, { t: 'loadBox', box: plain, setup: true, clear: true, rules: true });
  ok(J(q.notes) === J(['🚫 «Draughts» has no rules']) && H.state.lastSetup === bid, `a box without rules: refused, nothing changes (${J(q.notes)})`);
  const L = room(HOST, 'Alice', [[BOB, 'Bob']], '8');
  L.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Plain' })" });
  const la = { t: 'loadBox', box: json(HX), setup: true, clear: true, rules: true }, m0 = quietly(() => L.M.job(HOST, la)).value;
  const forge = (f) => { const o = structuredClone(m0.out); f(o); try { quietly(() => L.H.applyStatePatch(structuredClone(m0.patch), o, { p: HOST, a: la })); return ''; } catch (e) { return e.message; } };
  ok(forge((o) => { o.effects.find((e) => e.t === 'enable').remap = { abcd0001: 'abcd0002' }; }) === 'the script asked for rules the host never chose', 'a remap the clearing loadBox never made: refused');
  const off = forge((o) => { o.effects.find((e) => e.t === 'enable').box = 'ffff0001'; });
  ok(off === 'the script asked for rules the host never chose', `an enable naming another box: refused (${off})`);
  const wo = { t: 'loadBox', box: json(HX), setup: true, clear: true }, m1 = quietly(() => L.M.job(HOST, wo)).value;
  let threw = '';
  try { quietly(() => L.H.applyStatePatch(structuredClone(m1.patch), { ...structuredClone(m1.out), effects: [...structuredClone(m1.out.effects), { t: 'enable', box: m1.out.effects.find((e) => e.t === 'box')?.id ?? '', remap: {} }] }, { p: HOST, a: wo })); } catch (e) { threw = e.message; }
  ok(threw === 'the script asked for rules the host never chose', `an enable in a loadBox without rules: refused (${threw})`);
  L.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Plain' })" }); // (a fresh mirror: the two above were never taken)
  q = L.job(HOST, la);
  ok(q.enabled && L.H.state.rules.name === 'Hexfront' && L.H.state.rules.box === L.H.state.lastSetup && L.same(), `from running rules, the honest loadBox: taken, Hexfront's rules start after it (${J(q.lines.slice(-2))})`);
}

// =============================================================================
// (10) The facade: t.boxes, t.box, t.layout
// =============================================================================
function testFacade() {
  section('(10) t.boxes(), t.box(id), t.layout(boxId, entries?) (§4e)');
  const R = room(HOST, 'Alice', [[BOB, 'Bob']]), bid = R.add(HOST, gameDef()).id;
  R.job(HOST, { t: 'setup', box: bid });
  const F = { n: null, err: null };
  const kid = R.add(HOST, gameDef({ id: undefined, name: 'K', setup: [{ piece: 'gold', count: 2, at: 'center' }, { piece: 'd6', at: [100, 100], id: 'abcd1003' }] })).id;
  R.job(HOST, { t: 'setRules', enabled: true, code: `({ name: 'L', onButton(t, id) {
    if (id === 'list') t.data.list = t.boxes();
    if (id === 'box') t.data.box = t.box('${bid}');
    if (id === 'lay') t.data.n = t.layout('${bid}', [{ piece: 'gold', count: 3, at: 'map:a1' }, { piece: 'inf', at: 'b2', owner: '#2' }]);
    if (id === 'all') t.data.n = t.layout('${kid}');
    if (id === 'bad') { try { t.layout('${bid}', [{ piece: 'gold', at: 'center', owner: '#9' }]); } catch (e) { t.data.err = e.constructor.name + ': ' + e.message; } }
  }, buttons: () => ['list', 'box', 'lay', 'all', 'bad'].map((id) => ({ id, label: id })) })` });
  R.job(HOST, { t: 'rulesBtn', id: 'list' });
  ok(J(R.H.state.rules.data.list[0]) === J({ id: bid, name: 'Skirmish', src: 'host', builtin: false, types: 5 }) && R.H.state.rules.data.list.length === 2, `t.boxes(): ${J(R.H.state.rules.data.list)}`);
  R.job(HOST, { t: 'rulesBtn', id: 'box' });
  const b = R.H.state.rules.data.box;
  ok(b && !('setup' in b) && !('rules' in b) && !('rulesState' in b) && J(b.decks) === J({ Events: 'abcd0002' }) && b.meta.edition === 1 && b.types.inf.meta.atk === 4, 't.box(id): the public box with its decks and meta');
  let r = R.job(HOST, { t: 'rulesBtn', id: 'lay' });
  ok(R.H.state.rules.data.n === 4 && r.lines.includes('placed 4 items of «Skirmish»') && R.H.api.at('b2')[0]?.owner === R.seated()[1] && R.same(), `t.layout of 2 entries: 4 items, one line, "#2" the second seated (${J(r.lines)})`);
  r = R.job(HOST, { t: 'rulesBtn', id: 'all' });
  ok(R.H.state.rules.data.n === 3 && R.H.state.rules.enabled && R.H.state.items.abcd1003?.t === `${bid}/inf` && Object.values(R.H.state.items).filter((x) => x.t === `${kid}/d6`).length === 1 && R.same(),
    "t.layout(boxId): the box's own setup, nothing cleared (the id it asks for is taken: a new one)");
  r = R.job(HOST, { t: 'rulesBtn', id: 'bad' });
  ok(/^TypeError: t\.layout: this game needs 9 seated players/.test(R.H.state.rules.data.err || ''), `a "#9" with two seated: a TypeError before any op (${R.H.state.rules.data.err})`);

  section('(10) the action lists: setup and reset are host actions; addBox a ruled one guests may send');
  ok(HOST_ACTIONS.includes('setup') && HOST_ACTIONS.includes('reset') && PUBLIC_ACTIONS.includes('addBox') && RULED_ACTIONS.includes('addBox') && !PUBLIC_ACTIONS.includes('setup'), 'HOST_ACTIONS ⊃ setup, reset; PUBLIC_ACTIONS ∋ addBox');
  ok(CATALOG_ID_RE.test('abcd0001') && !CATALOG_ID_RE.test('ABCD0001') && MAX_SETUP_ITEMS === 3000, 'catalog ids: 8 lower-case hex digits');
}

// =============================================================================
// The test author's sections: spec §4l's core-p4 items 1, 2, 4, 5 and 6, and
// §4f's Worker contract, written apart from the implementation. Every
// expectation is read off the spec (§2a, §2c, §2j, §4a–§4h; TABLETOP §4)
// and the decisions it records (D83, D105, D119, D176–D186), never off
// core.js, which these sections only drive (createTable, apply, exportBox,
// boxOfDef, the facade). Randomness is seeded (node-lib's rng): every
// shuffle they look at comes out the same on every run.
// =============================================================================
const FAY = 'f'.repeat(16);
const AS = ['1a', '2b', '3c'].map((x) => x.repeat(32)); // an ingested box's three images (asset ids; none holds a player id)

/** A host's table as the page runs one with the rules in-page (the default
 *  scriptHooks): randomness from rng(seed); ids from `ids` first (a test may
 *  push to it later), then `prefix` and a counter; `me` hosts as `name`
 *  (its id kept as T.me), `players` ([pid, name]) join after. */
function hostTable({ seed = 1, players = [], prefix = '6', ids = [], me = HOST, name = 'Alice' } = {}) {
  let n = 0;
  const clk = { t: 1.7e12 }, random = rng(seed);
  const uid = () => ids.shift() ?? `${prefix}${(++n).toString(16).padStart(7, '0')}`;
  const T = quietly(() => createTable({}, { pid: me, now: () => (clk.t += 250), random, uid })).value;
  T.me = me;
  quietly(() => T.open(name));
  for (const [p, nm] of players) quietly(() => T.apply(p, { t: '_join', name: nm }));
  T.drain();
  T.takeDirty();
  return T;
}
/** Player p's action `a` on table T, carried out as the app does: applied,
 *  its effects drained — an `enable` effect queues the box's own setRules
 *  at once (§4c, D181: app.js's enableBox) — and what it said: {fx, notes
 *  (to p), toasts, lines (the log lines sent out), warn and error (the
 *  console's), id (the box an `added` effect names), enabled (the queued
 *  setRules' own result)}. */
function act(T, p, a) {
  const q = quietly(() => T.apply(p, a)), fx = T.drain(), d = T.takeDirty();
  const r = {
    fx, warn: q.warn, error: q.error, lines: d.log.map((e) => e.txt), id: fx.find((e) => e.t === 'added')?.id,
    notes: fx.filter((e) => e.t === 'note' && e.p === p).map((e) => e.msg), toasts: fx.filter((e) => e.t === 'toast').map((e) => e.msg),
  };
  for (const e of fx.filter((x) => x.t === 'enable')) {
    const box = T.state.boxes[e.box];
    r.enabled = act(T, T.me, { t: 'setRules', enabled: true, reset: true, code: box.rules, box: e.box, remap: e.remap, ...(box.rulesState && { state: box.rulesState }) });
  }
  return r;
}
/** T's seated players, clockwise from the bottom of the table: (seat − 90 + 360) % 360 (§4a: "#k" is the k-th, from 1). */
const ranked = (T) => Object.entries(T.state.players).filter(([, pl]) => pl.seat != null)
  .sort(([, a], [, b]) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360)).map(([q]) => q);
/** Who sits in T's named seat `id`. */
const holderOf = (T, id) => Object.keys(T.state.players).find((q) => T.state.players[q].seatId === id);
/** T's items as [id, item], those passing f(item, id). */
const itemsOf = (T, f = () => true) => Object.entries(T.state.items).filter(([id, it]) => f(it, id));
/** o's own property k, or undefined. */
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
/** A type ref's type id ("<box>/<type>" → "<type>"). */
const tid = (t) => (typeof t === 'string' ? t.slice(t.indexOf('/') + 1) : undefined);
/** §2a's grid geometry, board-local: the centre of chess address s on square grid g (files from a, ranks from the bottom row). */
const chessXY = (g, s) => { const c = s.charCodeAt(0) - 97, r = g.rows - Number(s.slice(1)); return [(g.x ?? 0) + (c + 0.5) * g.cell, (g.y ?? 0) + (r + 0.5) * g.cell]; };
/** …the centre of axial address "q,r" on a pointy hex grid (odd-r offset: c = q + (r − (r&1))/2; R = cell/√3). */
const hexXY = (g, s) => {
  const [q, r] = s.split(',').map(Number), c = q + (r - (r & 1)) / 2, R = g.cell / Math.sqrt(3);
  return [(g.x ?? 0) + g.cell * (c + 0.5 * (r & 1)) + g.cell / 2, (g.y ?? 0) + R + r * 1.5 * R];
};
/** §2a: a seat at angle `a` on a rectangle sits where the ray from the centre meets the table inset by 50. */
const rimXY = (tb, a) => {
  const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
  const t = Math.min(Math.abs(c) > 1e-9 ? (tb.w / 2 - 50) / Math.abs(c) : Infinity, Math.abs(s) > 1e-9 ? (tb.h / 2 - 50) / Math.abs(s) : Infinity);
  return [tb.w / 2 + t * c, tb.h / 2 + t * s];
};
/** Whether item `it`, w × h, has its centre on table point [x, y] (within 0.5: §0.2, an address centres the item). */
const centredOn = (it, w, h, [x, y]) => !!it && near(it.x + w / 2, x) && near(it.y + h / 2, y);
/** Whether item `it`'s top-left is [x, y] (within 0.5: §0.2, [x, y] in a setup is a top-left). */
const topLeft = (it, x, y) => !!it && near(it.x, x) && near(it.y, y);
/** A board-local point on the table, for a board whose top-left is [x, y] (and unturned). */
const plus = ([x, y], [dx, dy]) => [x + dx, y + dy];

/** Cleaned box `b` (types and backs as maps) in §4a's authoring format: pieces and backs as lists, a board's structure on its piece. */
const asAuthoring = (b) => {
  const D = json(b);
  return { ...D, types: undefined, backs: Object.entries(D.backs || {}).map(([id, x]) => ({ id, ...x })),
    pieces: Object.entries(D.types).map(([id, t]) => { const { board, ...rest } = t; return { id, ...rest, ...board }; }) };
};
/** "Tidewater"'s setup: every entry kind of §4a's grammar, every `Where`. 24 items. */
const TIDE_SETUP = [
  { piece: 'chart', at: 'center', id: 'feed1001' },
  { piece: 'reef', at: [100, 1300], id: 'feed1002' },
  { piece: 'boat', at: 'c3', n: 4, owner: '#1', id: 'feed1003' },
  { piece: 'boat', at: 'chart:f6', f: 1, rot: 90 },
  { piece: 'buoy', at: 'dock' },
  { piece: 'buoy', at: { board: 'reef', at: '2,1' } },
  { piece: 'buoy', count: 3, spread: [60, 0], at: [2400, 100], lock: true },
  { supply: 'boat', at: [2600, 1700], owner: 'seat:south' },
  { bag: ['buoy', { t: 'cargo', f: 2, n: 3, up: false }], name: 'Hold', at: [2700, 300] },
  { deck: 'Weather', at: [2400, 600], id: 'feed1004' },
  { deck: 'Weather', at: [2550, 600], up: true, name: 'Forecast' },
  { pile: [{ deck: 'Weather', i: 4 }, { deck: 'Weather', i: 1, up: true }], at: [2400, 900], name: 'Pair' },
  { pile: [{ piece: 'cargo', f: 0 }, { piece: 'cargo', f: 1 }, { piece: 'cargo', f: 2, up: true }], at: [2550, 900] },
  { card: { deck: 'Weather', i: 3 }, up: true, at: [2700, 900] },
  { card: { deck: 'Weather', i: 5 }, at: [2700, 1100] },
  { forEachSeat: [{ piece: 'boat', at: 'seat', owner: 'seat' }, { piece: 'buoy', at: { seat: [200, 50] } }] },
  { group: [{ piece: 'cargo', f: 0, up: false, at: [200, 200] }, { piece: 'cargo', f: 1, up: false, at: [300, 200] }, { piece: 'cargo', f: 2, up: false, at: [400, 200] }], shuffle: true },
  { hands: { south: [{ deck: 'Weather', i: 0 }, { piece: 'cargo', f: 1 }], '#2': [{ piece: 'cargo', f: 2, up: false }] } },
];
/** Tidewater's rules: a fresh game once (t.data.ready), a Tide button. */
const TIDE_RULES = `({ name: 'Tidewater rules',
  setup(t) { if (!t.data.ready) { t.data.ready = true; t.data.tides = 0; } },
  buttons: () => [{ id: 'tide', label: 'Tide' }],
  onButton(t, id) { if (id === 'tide') t.data.tides++; },
})`;
/** "Tidewater", an original test box in the game.json authoring format of
 *  §4a, ingested (its images asset ids): a primary square chess-labelled
 *  "chart" with two spaces, a link and a zone on the piece; a pointy hex
 *  "reef"; boats with a back ("fog") and buoys, cargo tiles with an image
 *  back ("crate"), a die, a deck; two named seats, North (top) and South
 *  (bottom). */
function tide(o = {}) {
  return {
    name: 'Tidewater', id: 'feed0001', players: [2, 3], imgs: [...AS],
    table: { shape: 'rect', w: 3000, h: 2000, felt: '#1e3a4c' },
    seats: [{ id: 'north', name: 'North', edge: 'top', color: '#38bdf8' }, { id: 'south', name: 'South', edge: 'bottom', color: '#f97316' }],
    lockable: 'anyone',
    backs: [{ id: 'fog', color: '#334155', label: '?' }, { id: 'crate', img: 2 }],
    pieces: [
      { id: 'chart', kind: 'board', img: 0, w: 800, h: 800, primary: true,
        grid: { type: 'square', cols: 6, rows: 6, cell: 100, x: 0, y: 0, labels: 'chess' },
        spaces: [{ id: 'dock', x: 700, y: 700, r: 60 }, { id: 'quay', x: 700, y: 100, r: 60 }], links: [['dock', 'quay']],
        zones: [{ id: 'harbor', poly: [[600, 600], [800, 600], [800, 800], [600, 800]] }] },
      { id: 'reef', kind: 'board', w: 600, h: 520, grid: { type: 'hex', hex: 'pointy', cols: 6, rows: 5, cell: 90, x: 10, y: 10 } },
      { id: 'boat', kind: 'token', shape: 'rect', w: 50, stack: 'count', back: 'fog', faces: [{ img: 1 }, { label: 'b' }], meta: { speed: 3 } },
      { id: 'buoy', kind: 'token', w: 40, faces: [{ color: '#ef4444', label: '1' }] },
      { id: 'cargo', kind: 'tile', w: 80, back: 'crate', faces: ['salt', 'tea', 'silk'] },
      { id: 'die', kind: 'die' },
    ],
    decks: [{ name: 'Weather', id: 'feed0002', back: '#0f172a', imgs: [], cards: ['Gale', 'Calm', 'Fog', 'Squall', 'Sun', 'Rain'].map((n) => ({ n })) }],
    setup: TIDE_SETUP,
    ...o,
  };
}
const CHART = tide().pieces[0].grid, REEF = tide().pieces[1].grid;
const TIDE_IDS = ['feed1001', 'feed1002', 'feed1003', 'feed1004'];

/** The private state of table T in its own words, for comparing two tables
 *  (§4l item 4): every item by id — kind, type id, top-left, turn, face,
 *  count, up, lock, address, name, owner by seat ("seat:<id>") or by rank
 *  ("#k"), a card by its deck's name, a pile's members in order, a bag's as
 *  a multiset — the items' order bottom to top, the hands by rank, and the
 *  table and its named seats. */
function privateOf(T, ty = tid) {
  const K = new Map(ranked(T).map((q, k) => [q, `#${k + 1}`])), dn = (d) => T.state.decks[d]?.name ?? `?${d}`;
  const who = (o) => (o === undefined ? null : o.startsWith('seat:') ? o : K.get(o) ?? `unseated ${o}`);
  const mem = (m) => (m.d !== undefined ? ['card', dn(m.d), m.i, !!m.up] : ['piece', ty(m.t), m.f ?? 0, m.up !== false]);
  const items = Object.fromEntries(Object.entries(T.state.items).map(([id, it]) => [id, {
    k: it.k, type: ty(it.t) ?? null, x: it.x, y: it.y, rot: it.rot ?? 0, f: it.f ?? null, n: it.n ?? 1, up: it.up ?? null, lock: !!it.lock,
    at: it.at ?? null, name: it.name ?? null, owner: who(it.owner), card: it.k === 'c' ? [dn(it.d), it.i] : null,
    cards: it.cards ? it.cards.map((m) => J(mem(m))) : null, bag: it.of ? it.of.map((m) => J(mem(m))).sort() : null, hand: !!it.hand,
  }]));
  const order = Object.entries(T.state.items).sort(([, a], [, b]) => a.z - b.z).map(([id]) => id);
  const hands = Object.fromEntries([...K].map(([q, k]) => [k, T.state.players[q].hand.map((m) => J(mem(m)))]));
  return { items, order, hands, table: T.state.table, seats: T.state.seats };
}
/** A type ref of table T by what the type is, whatever its id: its fields,
 *  its faces' images by asset id, its back's look — so two tables whose
 *  boxes name one type differently (an export merges boxes, renaming what
 *  clashes: D185) compare equal. */
const typeContent = (T) => (ref) => {
  if (typeof ref !== 'string') return undefined;
  const box = T.state.boxes[ref.slice(0, ref.indexOf('/'))], t = box?.types[tid(ref)];
  if (!t) return `missing ${ref}`;
  const img = (f) => (f.img === undefined ? f : { ...f, img: box.imgs[f.img] }), back = t.back && box.backs[t.back];
  return canon({ ...t, faces: t.faces.map(img), back: back ? { ...back, face: img(back.face) } : null });
};
/** Where private states a and b differ ('' when they don't; positions within 0.5). */
function unlike(a, b) {
  const ids = Object.keys(a.items), jds = Object.keys(b.items);
  if (J(ids.sort()) !== J(jds.sort())) return `the ids differ: ${J(ids.filter((x) => !b.items[x]))} ≠ ${J(jds.filter((x) => !a.items[x]))}`;
  for (const id of ids) {
    for (const k of Object.keys(a.items[id])) {
      const [u, v] = [a.items[id][k], b.items[id][k]];
      if (k === 'x' || k === 'y' ? !near(u, v) : J(u) !== J(v)) return `item ${id}: ${k} ${J(u)} ≠ ${J(v)}`;
    }
  }
  for (const k of ['order', 'hands', 'table', 'seats']) if (J(a[k]) !== J(b[k])) return `${k}: ${J(a[k]).slice(0, 300)} ≠ ${J(b[k]).slice(0, 300)}`;
  return '';
}

// -----------------------------------------------------------------------------
// (1′) cleanBox over the game.json authoring format
// -----------------------------------------------------------------------------
/** TABLETOP §4's own example, as an ingested TransportBox reads it (its
 *  images asset ids, its deck's cards real ones, its rules inline). */
const tabletopExample = () => ({
  name: 'My Game', players: [2, 4], imgs: [...AS],
  table: { shape: 'rect', w: 3200, h: 2200, felt: '#2c3e2f' },
  pieces: [
    { id: 'board', kind: 'board', img: 0, w: 2000, h: 1400, grid: { type: 'hex', hex: 'pointy', cols: 20, rows: 14, cell: 100 } },
    { id: 'inf', kind: 'token', shape: 'rect', w: 60, h: 60, stack: 'count', faces: [{ img: 1 }, { img: 2 }], meta: { atk: 4 } },
    { id: 'd6', kind: 'die', faces: [1, 2, 3, 4, 5, 6] },
    { id: 'gold', kind: 'token', shape: 'disc', w: 40, faces: [{ color: '#eab308', label: '1' }] },
  ],
  decks: [{ name: 'Events', back: null, imgs: [], cards: [{ n: 'Flood' }, { n: 'Drought' }, { n: 'Fair' }] }],
  setup: [
    { piece: 'board', at: 'center' },
    { supply: 'gold', at: [200, 200] },
    { piece: 'd6', count: 2, at: [2900, 200] },
    { deck: 'Events', at: [2900, 1000], shuffle: true },
    { forEachSeat: [{ piece: 'inf', n: 6, at: 'seat', owner: 'seat' }] },
  ],
  rules: '({ name: "My Game" })',
});

function indepFormat() {
  section("(1′) TABLETOP §4's example is a box, each field meaning what it says there (§4a: a superset of TABLETOP §4)");
  let got;
  const e = thrown(() => { got = boxOfDef(tabletopExample()); });
  ok(!e, `accepted (${e || 'no error'})`);
  if (got) {
    const { types, setup } = got.box;
    ok(types.board?.kind === 'board' && J(types.board.faces) === J([{ img: 0 }]) && types.board.board?.grid?.type === 'hex' && types.board.board.grid.hex === 'pointy'
      && types.board.board.grid.cols === 20 && types.board.board.grid.rows === 14 && types.board.board.grid.cell === 100 && !('grid' in types.board),
    'the board: one face from its img, its hex grid on the piece moved into its board structure');
    ok(types.inf?.w === 60 && types.inf.h === 60 && types.inf.shape === 'rect' && types.inf.stack === 'count' && J(types.inf.faces) === J([{ img: 1 }, { img: 2 }]) && types.inf.meta?.atk === 4,
      'inf: 60 × 60, rect, stacks by count, two image faces, its meta');
    ok(J(types.d6?.faces) === J([1, 2, 3, 4, 5, 6].map((pips) => ({ pips }))), `the die's numbers 1–6 are pips (${J(types.d6?.faces)})`);
    ok(types.gold?.w === 40 && types.gold.h === 40 && types.gold.shape === 'disc' && J(types.gold.faces) === J([{ color: '#eab308', label: '1' }]),
      `gold, given only a w: its h is its w (${types.gold?.w} × ${types.gold?.h})`);
    ok(setup[3]?.deck === 'Events' && setup[3].shuffle === true && setup[4]?.forEachSeat?.[0]?.at === 'seat' && setup[4].forEachSeat[0].owner === 'seat' && setup[4].forEachSeat[0].n === 6,
      'the setup keeps "shuffle": true on the deck, and "at": "seat" / "owner": "seat" inside forEachSeat');
    ok(J(got.box.players) === '[2,4]' && J(got.box.table) === J({ shape: 'rect', w: 3200, h: 2200, felt: '#2c3e2f' }) && J(Object.keys(got.box.decks || {})) === '["Events"]',
      'players, table, and its deck by name');
  }

  section("(1′) the authoring format, cleaned: a board's structure on its piece, the img shorthand, the backs' defaults, decks (§4a, §2a)");
  const { box: b, decks, id } = boxOfDef(tide());
  const chart = b.types.chart, reef = b.types.reef;
  ok(chart.board?.primary === true && chart.board.grid?.type === 'square' && chart.board.grid.labels === 'chess' && chart.board.grid.cols === 6 && chart.board.grid.cell === 100
    && J(chart.board.spaces?.map((s) => s.id)) === '["dock","quay"]' && J(chart.board.links) === J([['dock', 'quay']]) && chart.board.zones?.[0]?.id === 'harbor',
  "chart: primary, its grid, spaces, link and zone all in its board structure");
  ok(['primary', 'grid', 'spaces', 'zones', 'links'].every((k) => !(k in chart)) && reef.board?.grid?.type === 'hex' && reef.board.grid.hex === 'pointy' && !reef.board.primary,
    'nothing of it left on the type itself; reef: a pointy hex grid, not primary');
  ok(J(chart.faces) === J([{ img: 0 }]) && J(b.types.boat.faces) === J([{ img: 1 }, { label: 'b' }]) && J(b.backs.crate?.face) === J({ img: 2 }),
    'img on a piece is its one face; on a back, its face');
  ok(chart.rotStep === 90 && chart.stack === 'none' && chart.hand === false && chart.shape === 'rect', "a board's defaults (§2a): rect, rotStep 90, no stack, not held");
  ok(b.types.buoy.h === 40 && b.types.buoy.shape === 'disc' && b.types.buoy.stack === 'count' && b.types.buoy.rotStep === 0 && b.types.buoy.hand === false,
    "a token given only w: h = w, and a token's defaults (disc, stacks by count, rotStep 0, not held)");
  ok(b.types.cargo.h === 80 && b.types.cargo.shape === 'rect' && b.types.cargo.stack === 'pile' && b.types.cargo.rotStep === 90 && b.types.cargo.hand === true,
    "a tile given only w: h = w, and a tile's defaults (rect, stacks as a pile, rotStep 90, held)");
  ok(b.types.die.w === 56 && b.types.die.h === 56 && J(b.types.die.faces) === J([1, 2, 3, 4, 5, 6].map((pips) => ({ pips }))), "a die's defaults: 56 × 56, six pips faces");
  const fog = b.backs.fog, crate = b.backs.crate;
  ok(fog && J([fog.w, fog.h, fog.shape, fog.rotStep, fog.hand, fog.stack]) === J([50, 50, 'rect', 0, false, 'count']) && J(fog.face) === J({ color: '#334155', label: '?' }),
    `the back "fog" takes w/h/shape/rotStep/hand/stack from its first user, the boat (${J(fog)})`);
  ok(crate && J([crate.w, crate.h, crate.shape, crate.rotStep, crate.hand, crate.stack]) === J([80, 80, 'rect', 90, true, 'pile']),
    `the back "crate" takes the cargo tile's (${J(crate)})`);
  ok(id === 'feed0001' && decks.length === 1 && decks[0][0] === 'Weather' && decks[0][2] === 'feed0002' && J(b.decks) === J({ Weather: 'feed0002' })
    && J(decks[0][1].cards.map((c) => c.n)) === J(['Gale', 'Calm', 'Fog', 'Squall', 'Sun', 'Rain']),
  "the box's id and its deck's, asked for; the deck named in box.decks; its cards cleaned as a deck's");

  section('(1′) what the authoring format refuses: images, backs, decks, "seat" (§2j references, §2c)');
  const P = tide().pieces, refuse = (what, def) => { const err = thrown(() => boxOfDef(def)); ok(!!err, `${what}: refused ("${err.slice(0, 110)}")`); };
  refuse('a face on an image past the list', tide({ pieces: P.map((p) => (p.id === 'boat' ? { ...p, faces: [{ img: 3 }] } : p)) }));
  refuse('a face on an image that is null', tide({ imgs: [AS[0], null, AS[2]] }));
  refuse('a back whose own w is not its user\'s', tide({ backs: [{ id: 'fog', color: '#334155', w: 70 }, { id: 'crate', img: 2 }] }));
  refuse('two users of one back that differ (a rect boat, a disc raft)', tide({ pieces: [...P, { id: 'raft', kind: 'token', w: 50, back: 'fog', faces: ['r'] }] }));
  refuse('a piece whose back is no back of the box', tide({ pieces: P.map((p) => (p.id === 'boat' ? { ...p, back: 'mist' } : p)) }));
  refuse('decks that are no list', tide({ decks: { Weather: 'feed0002' } }));
  refuse('a setup entry on a deck the box lacks', tide({ setup: [{ deck: 'Tides', at: [100, 100] }] }));
  refuse('a setup entry of a type the box lacks', tide({ setup: [{ piece: 'kraken', at: [100, 100] }] }));
  refuse('"at": "seat" outside forEachSeat', tide({ setup: [{ piece: 'buoy', at: 'seat' }] }));
  refuse('"at": {seat: [dx, dy]} outside forEachSeat', tide({ setup: [{ piece: 'buoy', at: { seat: [0, 50] } }] }));
  ok(!thrown(() => boxOfDef(tide({ setup: [{ forEachSeat: [{ piece: 'buoy', at: { seat: [10, 90] } }] }] }))), '"at": {seat: [dx, dy]} inside forEachSeat: accepted');

  section('(1′) the caps of §4j, at their bounds: rules 200,000 chars, rulesState 4e6 chars of JSON, meta 8 KB');
  const accepts = (def) => thrown(() => boxOfDef(def));
  ok(!accepts(tide({ rules: 'x'.repeat(200000) })) && !!accepts(tide({ rules: 'x'.repeat(200001) })), 'rules: 200,000 characters accepted, 200,001 refused');
  const shell = J({ data: { x: '' }, public: {}, asks: {}, secret: {} }).length, st = (n) => ({ data: { x: 'y'.repeat(n - shell) }, public: {}, asks: {}, secret: {} });
  ok(J(st(4e6)).length === 4e6 && !accepts(tide({ rulesState: st(4e6) })) && !!accepts(tide({ rulesState: st(4e6 + 1) })), 'rulesState: 4,000,000 characters of JSON accepted, one more refused');
  ok(!!accepts(tide({ rulesState: { data: {}, public: {}, asks: {}, secret: [] } })) && !!accepts(tide({ rulesState: { data: 'x' } })) && !!accepts(tide({ rulesState: [] })),
    'rulesState: secret a list, data a string, the whole a list — each refused (its shape: {data, public, asks, secret}, objects)');
  const meta = (n) => ({ x: 'y'.repeat(n - J({ x: '' }).length) });
  ok(J(meta(8000)).length === 8000 && !accepts(tide({ meta: meta(8000) })) && !!accepts(tide({ meta: meta(8193) })), 'meta: 8,000 characters of JSON accepted, 8,193 (past 8 KB) refused');

  section('(1′) src, by and every field a box does not have are dropped (§2j: whitelisting; the trust markers are the catalog record\'s)');
  const forged = boxOfDef(tide({ src: 'builtin', by: HOST, builtin: true, hasRules: true, evil: '<img src=x onerror=alert(1)>' })).box;
  ok(['src', 'by', 'builtin', 'hasRules', 'evil'].every((k) => !(k in forged)) && canon(forged) === canon(b), 'none of them is in the cleaned box, which equals the box without them');
  const straight = cleanBox({ ...b, src: 'builtin', by: HOST, evil: 1 });
  ok(!('src' in straight) && !('by' in straight) && !('evil' in straight), 'cleanBox itself drops them too');
  const T = hostTable({ seed: 3, players: [[BOB, 'Bob']] });
  const r = act(T, BOB, { t: 'addBox', box: tide({ src: 'host', by: HOST }), cost: 9000 });
  ok(r.id && J(T.state.boxSrc[r.id]) === J({ src: 'upload', by: BOB }) && !('src' in T.state.boxes[r.id]) && !('by' in T.state.boxes[r.id]),
    `Bob's box saying src "host", by the host: recorded as Bob's upload (${J(T.state.boxSrc[r.id])})`);
}

/** §4j's gates on a box's rulesState, read when it is seeded (D177: cleanBox
 *  checks its shape and size; setRules.state the entries): asks through
 *  cleanAsk (and ASK_MAX), data._timers validated, secret keys a pid or
 *  "@#k" and each value ≤ 8,000 chars; entries keyed by nobody at the table
 *  dropped too, each loudly, with one toast per kind. */
function indepGates() {
  section("(1′) rulesState's entries through §3a's gates when the game is set up with its rules (§4c setRules.state, §4j, D177)");
  const T = hostTable({ seed: 5, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const asks = {
    '@#1': [{ id: 'fine', prompt: 'Sail?', options: ['yes', 'no'] }, { id: 'nope', prompt: 'Pick', options: [] }, { id: 'fine', prompt: 'Again?', options: ['a'] }],
    '@#2': Array.from({ length: 9 }, (_, k) => ({ id: `q${k}`, prompt: `Q${k}?`, options: ['y'] })),
    '@#3': [{ id: 'ghost', prompt: 'Boo?', options: ['y'] }],
  };
  const secret = { '@#1': { text: 'Mind the reef.' }, '@#2': 'z'.repeat(8001), mallory: { text: 'x' }, [EVE]: { text: 'gone' } };
  const state = { data: { _timers: [{ at: 5, tag: 'ok' }, { at: 6, tag: 't'.repeat(101) }, { at: 'x', tag: 'bad' }], keep: '@#2' }, public: { lead: '@#1' }, asks, secret };
  const add = act(T, HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES, rulesState: state }) });
  ok(!!add.id && canon(T.state.boxes[add.id].rulesState) === canon(state), 'the box registers with its entries as they are (cleanBox checks the shape and size)');
  const r = act(T, HOST, { t: 'setup', box: add.id, rules: true }), S = holderOf(T, 'south'), N = holderOf(T, 'north'), rs = T.state.rules;
  ok(!!r.enabled && rs?.enabled === true && rs.box === add.id && J(ranked(T)) === J([S, N]), 'set up with its rules: they run (rules.box), "#1" is South\'s player, "#2" North\'s');
  ok(J(rs.data._timers) === J([{ at: 5, tag: 'ok' }]) && rs.data.keep === N && rs.public.lead === S, 'the timers with a 101-char tag and at "x" dropped; "@#k" values mapped to the players');
  ok(J((rs.asks[S] || []).map((x) => x.id)) === '["fine"]', `#1's asks: the one with no options and the second "fine" dropped (${J((rs.asks[S] || []).map((x) => x.id))})`);
  ok((rs.asks[N] || []).length === 8 && rs.asks[N][7].id === 'q7', `#2's nine asks: eight kept (ASK_MAX), the ninth dropped (${(rs.asks[N] || []).length})`);
  ok(J(Object.keys(rs.asks).sort()) === J([S, N].sort()) && J(Object.keys(rs.secret)) === J([S]) && rs.secret[S]?.text === 'Mind the reef.',
    `"@#3" (two are seated), a secret of 8,001 characters, one keyed "mallory" and one keyed by a pid not at the table: dropped (${J(Object.keys(rs.secret))})`);
  const toasts = r.enabled?.toasts || [];
  ok(toasts.filter((m) => m === 'Some saved game state was invalid and was dropped').length === 1 && toasts.filter((m) => m === "Some saved state referred to players who weren't seated; it was dropped").length === 1,
    `one toast for the invalid entries, one for the players not seated (${J(toasts)})`);
  ok((r.enabled?.error || []).length >= 8, `each drop said with console.error (${(r.enabled?.error || []).length} lines)`);
  const W = hostTable({ seed: 6, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const raw = { [BOB]: { text: 'Bob' }, [CAROL]: { text: 'Carol' }, [EVE]: { text: 'gone' } };
  const w = act(W, HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES, rulesState: { data: {}, public: {}, asks: {}, secret: raw } }) });
  const ws = act(W, HOST, { t: 'setup', box: w.id, rules: true });
  const watcher = Object.keys(W.state.players).find((q) => W.state.players[q].seat == null);
  ok([BOB, CAROL].includes(watcher) && J(Object.keys(W.state.rules.secret).sort()) === J([BOB, CAROL].sort()) && (ws.enabled?.toasts || []).includes("Some saved state referred to players who weren't seated; it was dropped"),
    `secrets under raw pids: kept for the players at the table — the watcher too (${W.state.players[watcher]?.name}) — dropped for a pid not at it (D177)`);
}

// -----------------------------------------------------------------------------
// (2′) The setup interpreter
// -----------------------------------------------------------------------------
function indepSetup() {
  section('(2′) every entry kind of §4a, laid out where its Where says (§4a, §2c, §0.2: [x, y] a top-left, an address a centre)');
  const T = hostTable({ seed: 11, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const opened = itemsOf(T, (it) => it.k === 'p')[0][0];
  act(T, HOST, { t: 'draw', id: opened });
  ok(T.state.players[HOST].hand.length === 1, '(Alice holds a card before the setup)');
  const add = act(T, HOST, { t: 'addBox', box: tide() }), bid = add.id;
  ok(bid === 'feed0001' && T.state.decks.feed0002?.cards.length === 6 && add.lines.includes('added the box «Tidewater» (6 piece types)') && !itemsOf(T, (it) => tid(it.t) && it.t.startsWith(bid)).length && T.state.lastSetup === undefined,
    `addBox registers the box and its deck under the ids they ask for, says so, and lays nothing out (${J(add.lines)})`);
  const r = act(T, HOST, { t: 'setup', box: bid }), it = (id) => T.state.items[id], S = holderOf(T, 'south'), N = holderOf(T, 'north');
  ok(r.lines.includes('set up «Tidewater» (24 items)') && !r.lines.some((l) => /shuffled/.test(l)) && T.state.lastSetup === bid && Object.keys(T.state.items).length === 24,
    `"set up «Tidewater» (24 items)", the host's box not shuffled; lastSetup (${J(r.lines.slice(-1))}, ${Object.keys(T.state.items).length} items)`);
  ok(!own(T.state.items, opened) && J(T.state.table) === J(tide().table) && J(T.state.seats.map((s) => s.id)) === '["north","south"]' && !!S && !!N && J(ranked(T)) === J([S, N]),
    "cleared first (the opened deck gone); the box's table and named seats; \"#1\" is the bottom seat's player, \"#2\" the top's");
  ok(J(T.state.players[N].hand) === J([{ t: `${bid}/cargo`, f: 2, up: false }]) && J(T.state.players[S].hand) === J([{ d: 'feed0002', i: 0 }, { t: `${bid}/cargo`, f: 1 }])
    && Object.values(T.state.players).filter((pl) => pl.seat == null).every((pl) => !pl.hand.length),
  `the hands emptied by the clear, then dealt: South by seat id (a card, a piece face up), "#2" North (a piece face down) — ${J(T.state.players[S].hand)}`);
  const C0 = [1500 - 400, 1000 - 400], R0 = [100, 1300];
  ok(topLeft(it('feed1001'), ...C0) && it('feed1001').lock === true && it('feed1001').z < 0 && topLeft(it('feed1002'), ...R0) && it('feed1002').lock === true,
    'the boards: "center" centres the chart, [x, y] is the reef\'s top-left; both locked, in the board band');
  ok(centredOn(it('feed1003'), 50, 50, plus(C0, chessXY(CHART, 'c3'))) && it('feed1003').at === 'feed1001:c3' && it('feed1003').n === 4 && it('feed1003').owner === S,
    `"c3" (bare: the primary board) centres the boat stack of 4 on that cell, owned by "#1", South's player (${J([it('feed1003')?.x, it('feed1003')?.y, it('feed1003')?.at])})`);
  const pcs = (t, f = () => true) => itemsOf(T, (x) => x.t === `${bid}/${t}` && x.k === 'g' && f(x));
  const f6 = pcs('boat', (x) => x.f === 1)[0]?.[1];
  ok(centredOn(f6, 50, 50, plus(C0, chessXY(CHART, 'f6'))) && f6.at === 'feed1001:f6' && f6.rot === 90, '"chart:f6" (by board type): centred there, face 1, turned 90°');
  const dock = pcs('buoy', (x) => x.at === 'feed1001:dock')[0]?.[1], reefBuoy = pcs('buoy', (x) => x.at === 'feed1002:2,1')[0]?.[1];
  ok(centredOn(dock, 40, 40, plus(C0, [700, 700])), '"dock" (a space id): centred on the space');
  ok(centredOn(reefBuoy, 40, 40, plus(R0, hexXY(REEF, '2,1'))), `{board: "reef", at: "2,1"}: centred on that hex (${J([reefBuoy?.x, reefBuoy?.y])})`);
  const row = pcs('buoy', (x) => x.y === 100 && x.x >= 2400).map(([, x]) => x).sort((a, b) => a.x - b.x);
  ok(row.length === 3 && row.every((x, k) => topLeft(x, 2400 + 60 * k, 100) && x.lock === true), 'count 3 with spread [60, 0]: three buoys stepped from [2400, 100], each locked');
  const sup = itemsOf(T, (x) => x.k === 's')[0]?.[1];
  ok(sup?.t === `${bid}/boat` && topLeft(sup, 2600, 1700) && sup.owner === 'seat:south', "a supply, owned by the seat (\"seat:south\")");
  const bag = itemsOf(T, (x) => x.k === 'b')[0]?.[1];
  ok(bag?.name === 'Hold' && topLeft(bag, 2700, 300) && J(bag.of.map((m) => J([tid(m.t), m.f ?? 0, m.up !== false])).sort()) === J([J(['buoy', 0, true]), ...Array(3).fill(J(['cargo', 2, false]))].sort()) && !bag.hand,
    'a bag: a buoy and three cargo face down; not a hand bag (a buoy can\'t be held)');
  const pile = (name) => itemsOf(T, (x) => x.k === 'p' && x.name === name)[0]?.[1], cards = (p) => J(p?.cards.map((c) => [c.d ?? tid(c.t), c.i ?? c.f, !!c.up]));
  ok(it('feed1004')?.k === 'p' && it('feed1004').name === 'Weather' && topLeft(it('feed1004'), 2400, 600) && cards(it('feed1004')) === J([0, 1, 2, 3, 4, 5].map((i) => ['feed0002', i, false])),
    'a deck entry: a face-down pile of the whole deck, named after it, in its order');
  ok(cards(pile('Forecast')) === J([0, 1, 2, 3, 4, 5].map((i) => ['feed0002', i, true])), 'a deck entry with "up": its cards face up');
  ok(cards(pile('Pair')) === J([['feed0002', 4, false], ['feed0002', 1, true]]), 'a pile of cards, each as given (face down unless "up")');
  const cargoPile = itemsOf(T, (x) => x.k === 'p' && x.cards[0]?.t)[0]?.[1];
  ok(cards(cargoPile) === J([['cargo', 0, false], ['cargo', 1, false], ['cargo', 2, true]]) && topLeft(cargoPile, 2550, 900), 'a pile of pieces: face down (their type has a back) unless "up" (D178)');
  const loose = itemsOf(T, (x) => x.k === 'c').map(([, x]) => x).sort((a, b) => a.i - b.i);
  ok(J(loose.map((c) => [c.i, c.up])) === J([[3, true], [5, false]]) && topLeft(loose[0], 2700, 900) && topLeft(loose[1], 2700, 1100), 'cards: face up only with "up"');
  const seatBoats = pcs('boat', (x) => x.owner === 'seat:north' || x.owner === 'seat:south');
  const nb = seatBoats.find(([, x]) => x.owner === 'seat:north')?.[1], sb = seatBoats.find(([, x]) => x.owner === 'seat:south')?.[1];
  ok(seatBoats.length === 2 && centredOn(nb, 50, 50, [1500, 50 + 120]) && centredOn(sb, 50, 50, [1500, 1950 - 120]),
    `forEachSeat over the named seats: a boat owned by each seat, its centre 120 (SEAT_INSET) from the seat toward the table (${J([nb?.x, nb?.y, sb?.x, sb?.y])})`);
  const nbu = pcs('buoy', (x) => near(x.y + 20, 100))[0]?.[1], sbu = pcs('buoy', (x) => near(x.y + 20, 1900))[0]?.[1];
  ok(centredOn(nbu, 40, 40, [1500 - 200, 50 + 50]) && centredOn(sbu, 40, 40, [1500 + 200, 1950 - 50]) && !nbu.owner && !sbu.owner,
    '{seat: [200, 50]}: 200 to the seat\'s right and 50 toward the table (North\'s right is the table\'s left)');
  const grp = pcs('cargo', (x) => x.up === false);
  ok(grp.length === 3 && J(grp.map(([, x]) => [x.x, x.y]).sort((a, b) => a[0] - b[0])) === J([[200, 200], [300, 200], [400, 200]]) && J(grp.map(([, x]) => x.f).sort()) === '[0,1,2]',
    'a shuffled group: its three hidden cargo on the three places, faces 0, 1, 2');

  section('(2′) forEachSeat over automatic seats: one per seated player, owned by that player, at their seat (TABLETOP §4\'s example laid out)');
  const A = hostTable({ seed: 12, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const ex = act(A, HOST, { t: 'addBox', box: tabletopExample() });
  const s = act(A, HOST, { t: 'setup', box: ex.id });
  const tb = A.state.table, infs = itemsOf(A, (x) => tid(x.t) === 'inf');
  ok(s.lines.includes('set up «My Game» (8 items)') && A.state.seats === null && ranked(A).length === 3, `"set up «My Game» (8 items)", no named seats, three seated (${J(s.lines.slice(-1))})`);
  ok(infs.length === 3 && J(infs.map(([, x]) => x.owner).sort()) === J(ranked(A).slice().sort()) && infs.every(([, x]) => x.n === 6),
    "a stack of 6 for each seated player, owned by that player's id");
  ok(infs.every(([, x]) => {
    const [sx, sy] = rimXY(tb, A.state.players[x.owner].seat), cx = x.x + 30, cy = x.y + 30;
    return Math.abs(Math.hypot(cx - sx, cy - sy) - 120) < 0.5 && (cx - sx) * (tb.w / 2 - sx) + (cy - sy) * (tb.h / 2 - sy) > 0;
  }), 'each 120 from its player\'s seat point, toward the table');
  const brd = itemsOf(A, (x) => tid(x.t) === 'board')[0]?.[1], ev = itemsOf(A, (x) => x.k === 'p')[0]?.[1];
  ok(topLeft(brd, 1600 - 1000, 1100 - 700) && ev?.cards.length === 3 && J(ev.cards.map((c) => c.i).sort()) === '[0,1,2]' && itemsOf(A, (x) => tid(x.t) === 'd6').length === 2,
    'the board centred, the Events deck as a pile of its 3 cards, two dice');
  const P1 = hostTable({ seed: 13 });
  const pier = { name: 'Pier', pieces: [{ id: 'post', kind: 'token', w: 30, faces: ['P'] }], table: { shape: 'rect', w: 1600, h: 1200 },
    seats: [{ id: 'east', name: 'East', edge: 'right' }, { id: 'west', name: 'West', edge: 'left' }], setup: [{ forEachSeat: [{ piece: 'post', at: 'seat', owner: 'seat' }] }] };
  act(P1, HOST, { t: 'setup', box: act(P1, HOST, { t: 'addBox', box: pier }).id });
  ok(J(itemsOf(P1).map(([, x]) => x.owner).sort()) === '["seat:east","seat:west"]' && ranked(P1).length === 1,
    'over named seats, once per named seat — the empty one too (one player at the table)');

  section('(2′) "#k": the k-th seated player clockwise from the bottom, whatever order the seats are declared in (§4a)');
  const compass = (setup) => ({
    name: 'Compass', table: { shape: 'rect', w: 2400, h: 2400 }, pieces: [{ id: 'flag', kind: 'token', w: 40, faces: ['F'] }],
    seats: [{ id: 'north', name: 'North', edge: 'top' }, { id: 'east', name: 'East', edge: 'right' }, { id: 'south', name: 'South', edge: 'bottom' }, { id: 'west', name: 'West', edge: 'left' }],
    decks: [{ name: 'Orders', back: null, imgs: [], cards: [{ n: 'One' }, { n: 'Two' }, { n: 'Three' }, { n: 'Four' }] }], setup,
  });
  const ks = (n) => [...Array.from({ length: n }, (_, k) => ({ piece: 'flag', at: [100 + 100 * k, 100], owner: `#${k + 1}`, id: `c0a5000${k + 1}` })),
    { hands: Object.fromEntries(Array.from({ length: n }, (_, k) => [`#${k + 1}`, [{ deck: 'Orders', i: k }]])) }];
  const Q = hostTable({ seed: 14, players: [[BOB, 'Bob'], [CAROL, 'Carol'], [DAVE, 'Dave']] });
  act(Q, HOST, { t: 'setup', box: act(Q, HOST, { t: 'addBox', box: compass(ks(4)) }).id });
  const want = ['south', 'west', 'north', 'east'].map((x) => holderOf(Q, x));
  ok(want.every(Boolean) && [1, 2, 3, 4].every((k) => Q.state.items[`c0a5000${k}`]?.owner === want[k - 1] && J(Q.state.players[want[k - 1]].hand) === J([{ d: Object.values(Q.state.boxes).at(-1).decks.Orders, i: k - 1 }])),
    'seats declared north, east, south, west: "#1" is South\'s player, "#2" West\'s, "#3" North\'s, "#4" East\'s — owners and hands alike');
  const Q3 = hostTable({ seed: 15, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const c3 = act(Q3, HOST, { t: 'addBox', box: compass(ks(3)) }).id;
  act(Q3, HOST, { t: 'setup', box: c3 });
  const want3 = ['south', 'north', 'east'].map((x) => holderOf(Q3, x));
  ok(!holderOf(Q3, 'west') && [1, 2, 3].every((k) => Q3.state.items[`c0a5000${k}`]?.owner === want3[k - 1]), 'three players, West empty: "#2" is North\'s player (the empty seat counts no one)');
  const c4 = act(Q3, HOST, { t: 'addBox', box: { ...compass(ks(4)), name: 'Compass 4' } }).id, before = canon(Q3.state);
  const q4 = act(Q3, HOST, { t: 'setup', box: c4 });
  ok(/^🚫 .*this game needs 4 seated players/.test(q4.notes[0] || '') && canon(Q3.state) === before && !q4.lines.length,
    `a "#4" with three seated: refused before any op — the table, its seats, items, hands and log as they were ("${q4.notes[0]}")`);

  section('(2′) {board, at}: on the first board of that type the setup placed (§4a)');
  const twin = {
    name: 'Twin pads', table: { shape: 'rect', w: 2400, h: 1200 }, pieces: [{ id: 'pad', kind: 'board', w: 400, h: 400, grid: { type: 'square', cols: 4, rows: 4, cell: 100 } }, { id: 'peg', kind: 'token', w: 20, faces: ['p'] }],
    setup: [{ piece: 'pad', at: [200, 200], id: 'ba5e0001' }, { piece: 'pad', at: [1200, 200], id: 'ba5e0002' }, { piece: 'peg', at: { board: 'pad', at: '1,2' } }, { piece: 'peg', at: { board: 'pad', at: '3,0' } }],
  };
  const W = hostTable({ seed: 16 });
  const tw = act(W, HOST, { t: 'setup', box: act(W, HOST, { t: 'addBox', box: twin }).id });
  const pegs = itemsOf(W, (x) => tid(x.t) === 'peg').map(([, x]) => x);
  ok(pegs.length === 2 && pegs.every((x) => x.at?.startsWith('ba5e0001:')) && centredOn(pegs.find((x) => x.at === 'ba5e0001:1,2'), 20, 20, [200 + 150, 200 + 250]) && centredOn(pegs.find((x) => x.at === 'ba5e0001:3,0'), 20, 20, [200 + 350, 200 + 50]),
    `both pegs on the first pad placed, centred on cells "1,2" and "3,0" ("xy": zero-based from the top-left) (${J(pegs.map((x) => x.at))}, ${J(tw.notes)})`);

  section('(2′) the item total, and the 3,000-item cap — checked before any op (§2c, §4c)');
  const flot = { name: 'Flotilla', table: { shape: 'rect', w: 6000, h: 4000 }, pieces: [{ id: 'chip', kind: 'token', w: 20, faces: ['c'] }],
    setup: [{ forEachSeat: Array.from({ length: 5 }, () => ({ piece: 'chip', count: 200, at: 'seat' })) }] };
  ok(!thrown(() => boxOfDef({ ...flot, setup: Array.from({ length: 15 }, () => ({ piece: 'chip', count: 200, at: [100, 100] })) }))
    && /too many items/.test(thrown(() => boxOfDef({ ...flot, setup: Array.from({ length: 16 }, () => ({ piece: 'chip', count: 200, at: [100, 100] })) }))),
  'a setup of 3,000 items is a box; one of 3,200 is refused as it is read');
  const F = hostTable({ seed: 17, players: [[BOB, 'Bob'], [CAROL, 'Carol']] }), fid = act(F, HOST, { t: 'addBox', box: flot }).id;
  const f3 = act(F, HOST, { t: 'setup', box: fid });
  ok(Object.keys(F.state.items).length === 3000 && f3.lines.some((l) => /^set up «Flotilla» \(3,?000 items\)$/.test(l)), `three seated × 1,000: 3,000 items, the cap itself, laid out (${J(f3.lines.slice(-1))})`);
  const full = canon(F.state), f4 = act(F, HOST, { t: 'setup', box: fid, clear: false });
  ok(/^🚫 /.test(f4.notes[0] || '') && canon(F.state) === full && !f4.lines.length, `kept (no clear): 6,000 on a table of at most 5,000 — refused before any op ("${f4.notes[0]}")`);
  act(F, DAVE, { t: '_join', name: 'Dave' });
  const four = canon(F.state), f5 = act(F, HOST, { t: 'setup', box: fid });
  ok(/^🚫 .*too many items/.test(f5.notes[0] || '') && canon(F.state) === four && !f5.lines.length, `four seated × 1,000 = 4,000: refused before any op — nothing cleared ("${f5.notes[0]}")`);

  section('(2′) a missing deck or type fails before any op (§4c)');
  const M = hostTable({ seed: 18, players: [[BOB, 'Bob']] }), mdecks = J(Object.keys(M.state.decks)), m0 = canon(M.state);
  const nt = act(M, HOST, { t: 'addBox', box: tide({ setup: [{ piece: 'buoy', at: [10, 10] }, { piece: 'kraken', at: [20, 20] }] }) });
  ok(/^🚫 Box rejected: /.test(nt.notes[0] || '') && !nt.id && canon(M.state) === m0 && J(Object.keys(M.state.decks)) === mdecks,
    `a setup naming a type the box lacks: the box refused whole — not even its deck registered ("${nt.notes[0]}")`);
  const mb = act(M, HOST, { t: 'addBox', box: tide() }).id;
  act(M, HOST, { t: 'draw', id: itemsOf(M, (x) => x.k === 'p')[0][0] });
  delete M.state.decks.feed0002; // (the box's deck gone from the catalog: a save whose deck record couldn't be read)
  const m1 = canon(M.state), md = act(M, HOST, { t: 'setup', box: mb });
  ok(/^🚫 .*«Weather»/.test(md.notes[0] || '') && canon(M.state) === m1 && !md.lines.length && M.state.players[HOST].hand.length === 1 && M.state.table.shape === 'round' && M.state.seats === null,
    `its deck missing from the table: refused before any op — not cleared, the table still round, no seats, the hand kept ("${md.notes[0]}")`);
  const late = act(M, HOST, { t: 'addBox', box: tide({ id: undefined, name: 'Late', decks: [{ ...tide().decks[0], id: 'feed0003' }], setup: [{ piece: 'buoy', at: [10, 10] }, { card: { deck: 'Weather', i: 6 }, at: [50, 50] }] }) }).id;
  const m2 = canon(M.state), ml = act(M, HOST, { t: 'setup', box: late });
  ok(/^🚫 /.test(ml.notes[0] || '') && canon(M.state) === m2, `a card past its deck's end (6 of 6): refused before any op ("${ml.notes[0]}")`);
  const empty = act(M, HOST, { t: 'addBox', box: tide({ id: undefined, name: 'Empty seat', decks: [{ ...tide().decks[0], id: 'feed0005' }], setup: [{ hands: { north: [{ deck: 'Weather', i: 0 }] } }] }) }).id;
  const m3 = canon(M.state), me = act(M, HOST, { t: 'setup', box: empty });
  // (two players, two named seats: whoever is North is seated; the setup is refused only if nobody holds the seat — which can't be here)
  ok(!me.notes.length && J(M.state.players[holderOf(M, 'north')].hand) === J([{ d: 'feed0005', i: 0 }]) && canon(M.state) !== m3, 'a hand for a named seat someone holds: dealt');
  const lone = hostTable({ seed: 19 }), lb = act(lone, HOST, { t: 'addBox', box: tide({ setup: [{ piece: 'buoy', at: [10, 10] }, { hands: { south: [{ deck: 'Weather', i: 0 }] } }] }) }).id;
  const l0 = canon(lone.state), lr = act(lone, HOST, { t: 'setup', box: lb });
  ok(!holderOf(lone, 'south') && /^🚫 /.test(lr.notes[0] || '') && canon(lone.state) === l0, `a hand for a named seat nobody holds (one player: South empty): refused before any op ("${lr.notes[0]}")`);
  const noReef = act(lone, HOST, { t: 'addBox', box: tide({ id: undefined, name: 'No reef', setup: [{ piece: 'chart', at: 'center' }, { piece: 'buoy', at: 'c3' }, { piece: 'buoy', at: 'reef:2,1' }] }) }).id;
  const l1 = canon(lone.state), lz = act(lone, HOST, { t: 'setup', box: noReef });
  ok(/^🚫 /.test(lz.notes[0] || '') && canon(lone.state) === l1 && !lz.lines.length && lone.state.table.shape === 'round',
    `an address on a board type the setup never places, found only once the chart and a buoy were down: undone whole — no item, line, table or seat left (D179) ("${lz.notes[0]}")`);

  section('(2′) ids: an entry\'s id when free; when taken, a new one, a remap table, said once (§4c, D180)');
  const ids = [], I = hostTable({ seed: 20, players: [[BOB, 'Bob']], ids }), ib = act(I, HOST, { t: 'addBox', box: tide() }).id;
  ids.push('feed1004', 'feed1003'); // (the next ids minted, before any entry asks for them: §4c says a clearing setup keeps every id it asks for)
  const i1 = act(I, HOST, { t: 'setup', box: ib });
  ok(TIDE_IDS.every((x) => I.state.items[x]) && I.state.items.feed1004.name === 'Weather' && I.state.items.feed1003.n === 4 && !i1.toasts.length && !i1.warn.some((w) => /had to change/.test(w)),
    'a clearing setup: every id it asks for, even those the table\'s id source offered first to other items; nothing said');
  const i2 = act(I, HOST, { t: 'setup', box: ib });
  ok(TIDE_IDS.every((x) => I.state.items[x]) && !i2.toasts.length, 'set up again over itself (clearing): the same ids again');
  const keep = act(I, HOST, { t: 'addBox', box: tide({ id: 'feed0011', name: 'Tidewater 2', setup: TIDE_SETUP.filter((e) => Array.isArray(e.at) && !e.group) }) }).id;
  const i3 = act(I, HOST, { t: 'setup', box: keep, clear: false });
  const second = itemsOf(I, (x) => (x.t || '').startsWith(`${keep}/`) && tid(x.t) === 'reef')[0];
  ok(i3.toasts.filter((m) => m === '2 ids had to change; a running script that stored them may misbehave').length === 1 && i3.warn.length >= 1 && TIDE_IDS.every((x) => (I.state.items[x].t || '').startsWith(`${ib}/`) || I.state.items[x].k === 'p')
    && second && second[0] !== 'feed1002' && I.state.items.feed1002.t === `${ib}/reef`,
  `kept (no clear), its 2 ids taken: new ones, said once in a toast and console.warn — the old items keep theirs (${J(i3.toasts)})`);
  const rsx = { data: { pile: 'feed1004', chart: 'feed1001', near: 'feed1004x', list: ['feed1002'] }, public: {}, asks: {}, secret: {} };
  const rb = act(I, HOST, { t: 'addBox', box: tide({ id: 'feed0031', name: 'Tidewater R', rules: TIDE_RULES, rulesState: rsx, setup: TIDE_SETUP.filter((e) => Array.isArray(e.at) && !e.group) }) }).id;
  const i4 = act(I, HOST, { t: 'setup', box: rb, clear: false, rules: true }), en = i4.fx.find((e) => e.t === 'enable');
  ok(!!en && J(Object.keys(en.remap).sort()) === '["feed1002","feed1004"]' && I.state.items[en.remap.feed1004]?.name === 'Weather' && tid(I.state.items[en.remap.feed1002]?.t) === 'reef' && (I.state.items[en.remap.feed1002].t || '').startsWith(`${rb}/`),
    `with its rules: the remap table names each taken id and the new item laid out in its place (${J(en?.remap)})`);
  const dx = I.state.rules?.data;
  ok(I.state.rules?.enabled && I.state.rules.box === rb && dx?.pile === en?.remap.feed1004 && J(dx.list) === J([en?.remap.feed1002]) && dx.chart === 'feed1001' && dx.near === 'feed1004x',
    `its rules start with the new ids put into their state — keys and values exactly equal to an old one only (${J(dx)})`);
  const dk = act(I, HOST, { t: 'addBox', box: tide({ id: 'feed0041', name: 'Deck remap', rulesState: { data: { deck: 'feed0002', box: 'feed0041', [`by-feed0002`]: 1 }, public: {}, asks: {}, secret: {} } }) });
  const dbx = I.state.boxes[dk.id];
  ok(dk.id === 'feed0041' && dbx?.decks.Weather !== 'feed0002' && !!I.state.decks[dbx?.decks.Weather] && dbx.rulesState.data.deck === dbx.decks.Weather && dbx.rulesState.data.box === 'feed0041'
    && dk.toasts.some((m) => /^1 ids? had to change; a running script that stored (it|them) may misbehave$/.test(m)),
  `registration: the box's free id kept, its deck's taken one re-minted, the new deck id put into the box's rulesState, said once (${J(dk.toasts)}, ${J(dbx?.rulesState.data)})`);

  section("(2′) a guest's box shuffles its face-down deck and pile entries by default; face-up ones stay (§4c, D83)");
  const G = hostTable({ seed: 21, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const gb = act(G, BOB, { t: 'addBox', box: tide({ id: undefined, setup: TIDE_SETUP.filter((e) => !e.group) }), cost: 20000 }).id;
  ok(G.state.boxSrc[gb]?.src === 'upload', "(Bob's box: an upload)");
  const order = () => ({ deck: J(G.state.items.feed1004.cards.map((c) => c.i)), cargo: J(itemsOf(G, (x) => x.k === 'p' && x.cards[0]?.t)[0][1].cards.map((c) => [c.f, c.up])), up: J(itemsOf(G, (x) => x.name === 'Forecast')[0][1].cards.map((c) => c.i)) });
  const runs = [];
  for (let k = 0; k < 4; k++) runs.push({ r: act(G, HOST, { t: 'setup', box: gb }), o: order() });
  ok(runs.every(({ r }) => r.lines.some((l) => l === 'set up «Tidewater» (21 items), face-down piles shuffled')), `each setup: "${runs[0].r.lines.at(-1)}"`);
  ok(runs.some(({ o }) => o.deck !== '[0,1,2,3,4,5]') && runs.every(({ o }) => J(JSON.parse(o.deck).sort()) === '[0,1,2,3,4,5]'), `the face-down deck shuffled (${runs.map(({ o }) => o.deck).join(' ')})`);
  ok(runs.some(({ o }) => J(JSON.parse(o.cargo).filter(([, up]) => !up).map(([f]) => f)) !== '[0,1]') && runs.every(({ o }) => J(JSON.parse(o.cargo).map(([f]) => f).sort()) === '[0,1,2]'),
    `the face-down members of the cargo pile shuffled (${runs.map(({ o }) => o.cargo).join(' ')})`);
  ok(runs.every(({ o }) => J(JSON.parse(o.cargo)[2]) === '[2,true]'), 'its face-up member left where the box put it (on top, showing): only what lies face down is shuffled');
  ok(runs.every(({ o }) => o.up === '[0,1,2,3,4,5]'), 'the face-up deck entry never shuffled');
  const unt = act(G, HOST, { t: 'setup', box: gb, shuffle: false });
  ok(order().deck === '[0,1,2,3,4,5]' && !unt.lines.some((l) => /shuffled/.test(l)), '"Shuffle face-down piles" unticked (shuffle: false): as written');
  const rs = [];
  for (let k = 0; k < 4; k++) { act(G, HOST, { t: 'reset' }); rs.push(order().deck); }
  ok(rs.some((d) => d !== '[0,1,2,3,4,5]'), `reset: the box's default, shuffled (${rs.join(' ')})`);
  const hb = act(G, HOST, { t: 'addBox', box: tide({ name: 'Tidewater H', setup: TIDE_SETUP.filter((e) => !e.group) }) }).id, hs = []; // (its own content: Bob's would be found)
  for (let k = 0; k < 3; k++) { act(G, HOST, { t: 'setup', box: hb }); hs.push(order().deck); }
  ok(hs.every((d) => d === '[0,1,2,3,4,5]'), "the host's own box: never shuffled by default");
  const ho = [];
  for (let k = 0; k < 4; k++) ho.push([act(G, HOST, { t: 'setup', box: hb, shuffle: true }), order().deck]);
  ok(ho.some(([, d]) => d !== '[0,1,2,3,4,5]') && ho.every(([r]) => r.lines.some((l) => /, face-down piles shuffled$/.test(l))), "…and shuffled when the host asks (shuffle: true)");
  const sh = act(G, HOST, { t: 'addBox', box: { ...tide({ id: 'feed0021', name: 'Own shuffle' }), decks: [{ ...tide().decks[0], id: 'feed0022' }], setup: [{ deck: 'Weather', at: [100, 100], shuffle: true, id: 'feed2001' }] } }).id, ss = [];
  for (let k = 0; k < 4; k++) { act(G, HOST, { t: 'setup', box: sh }); ss.push(J(G.state.items.feed2001.cards.map((c) => c.i))); }
  ok(ss.some((d) => d !== '[0,1,2,3,4,5]'), `a deck entry's own "shuffle": true, in the host's box: shuffled (${ss.join(' ')})`);
}

// -----------------------------------------------------------------------------
// (4′) Export → import, in core
// -----------------------------------------------------------------------------
function indepRoundTrip() {
  section('(4′) a varied position exported, then set up in a fresh room: the same private state, ids included (§4l item 4, §4c)');
  const A = hostTable({ seed: 31, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const bid = act(A, HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES }) }).id;
  act(A, HOST, { t: 'setup', box: bid, rules: true });
  const S = holderOf(A, 'south'), N = holderOf(A, 'north'), C0 = [1100, 600];
  // play: moves, a shuffle, draws, a pull, a turn, an unlock — and, by the host's own facade, a free piece, an owner by player, a hidden stack, the rules' state
  const e2 = plus(C0, chessXY(CHART, 'e2'));
  act(A, S, { t: 'move', id: 'feed1003', x: e2[0] - 25, y: e2[1] - 25 });
  act(A, HOST, { t: 'shuffle', id: 'feed1004' });
  act(A, S, { t: 'draw', id: 'feed1004' });
  act(A, S, { t: 'draw', id: 'feed1004' });
  const hold = itemsOf(A, (x) => x.k === 'b')[0][0];
  act(A, HOST, { t: 'pull', id: hold, x: 2000, y: 100 });
  act(A, HOST, { t: 'rot', id: itemsOf(A, (x) => x.name === 'Forecast')[0][0], rot: 90 });
  act(A, HOST, { t: 'lock', id: 'feed1002', on: false });
  quietly(() => {
    const t = A.api;
    A.begin();
    t.move(itemsOf(A, (x) => x.at === 'feed1001:dock')[0][0], { x: 1234.5, y: 777.25, free: true });
    t.setOwner(itemsOf(A, (x) => x.k === 's')[0][0], N);
    t.spawn(`${bid}/boat`, { at: 'reef:3,2', n: 2, up: false });
    t.data.lead = N;
    t.data.score = { [S]: 3, [N]: 1 };
    t.data.pile = 'feed1004';
    t.public.turn = S;
    t.secret[S] = { text: 'Mind the reef.' };
    t.ask(N, { id: 'sail', prompt: 'Sail?', options: ['yes', 'no'] });
    A.commit(false);
  });
  A.drain();
  A.takeDirty();
  const before = privateOf(A), rsA = J(A.state.rules.data);
  ok(A.state.items.feed1003.at === 'feed1001:e2' && A.state.players[S].hand.length === 4 && itemsOf(A, (x) => x.k === 'b')[0][1].of.length === 3 && itemsOf(A, (x) => x.at === 'feed1002:3,2' && x.up === false && x.n === 2).length === 1,
    '(the position: the boat stack on e2, South holding four, the bag down to three, a hidden stack of 2 on the reef)');
  const { box, warnings } = quietly(() => A.exportBox({ rules: true, state: true })).value;
  const ents = box.setup.filter((x) => !x.hands);
  ok(box.id === bid && box.decks?.[0]?.id === 'feed0002' && ents.length === Object.keys(A.state.items).length && ents.every((x) => typeof x.id === 'string' && own(A.state.items, x.id)) && !warnings.length,
    `the export carries the box's id, its deck's, and each item under its own id (${ents.length} entries)`);
  ok(![HOST, BOB, CAROL].some((q) => J(box).includes(q)) && box.rulesState?.data?.lead === '@#2' && J(Object.keys(box.rulesState.data.score).sort()) === '["@#1","@#2"]'
    && J(Object.keys(box.rulesState.secret)) === '["@#1"]' && J(Object.keys(box.rulesState.asks)) === '["@#2"]' && box.rulesState.public.turn === '@#1',
  `no player id anywhere: owners, hands and the rules' state by "#k" / "@#k" (${J(box.rulesState?.data)})`);
  ok(box.setup.some((x) => x.owner === '#2') && box.setup.some((x) => x.owner === 'seat:south') && box.setup.some((x) => x.hands?.['#1']?.length === 4),
    'an owner by player as "#2", one by seat as "seat:south", South\'s hand as "#1"');

  const B = hostTable({ seed: 32, me: DAVE, name: 'Dave', players: [[EVE, 'Eve'], [FAY, 'Fay']], prefix: '7' });
  const added = act(B, DAVE, { t: 'addBox', box: json(box) });
  ok(added.id === bid && !!B.state.decks.feed0002 && !added.toasts.length, `the fresh room keeps the box's id and its deck's (${added.id})`);
  const set = act(B, DAVE, { t: 'setup', box: added.id, rules: true }), after = privateOf(B), why = unlike(before, after);
  ok(!why, `every item (ids, places within 0.5, faces, counts, owners by seat and "#k", pile orders, bags as multisets), the order bottom to top, the hands by "#k": equal (${why || 'equal'})`);
  const S2 = holderOf(B, 'south'), N2 = holderOf(B, 'north'), rb = B.state.rules;
  ok(!!set.enabled && rb?.enabled && rb.box === bid && rb.data.lead === N2 && J(rb.data.score) === J({ [S2]: 3, [N2]: 1 }) && rb.data.pile === 'feed1004' && rb.data.ready === true && rb.public.turn === S2,
    `the rules run on the exported state, "@#k" now the new room's players (${J(rb?.data)})`);
  ok(rb?.secret?.[S2]?.text === 'Mind the reef.' && rb.asks?.[N2]?.[0]?.id === 'sail' && Object.keys(rb.secret).length === 1 && Object.keys(rb.asks).length === 1, "South's secret and North's pending ask, theirs in the new room");
  ok([DAVE, EVE, FAY].includes(S2) && [DAVE, EVE, FAY].includes(N2) && B.state.items.feed1003.owner === S2, '(the new room\'s own players: "#1" owns the boat stack there)');

  section('(4′) the same table: export, clear, set the export up — the same private state, ids included');
  act(A, HOST, { t: 'clear' });
  const again = act(A, HOST, { t: 'addBox', box: json(box) }), set2 = act(A, HOST, { t: 'setup', box: again.id, rules: true });
  const why2 = unlike(before, privateOf(A)), K = ranked(A);
  ok(!!again.id && again.id !== bid && !why2, `added again (its ids taken: ${again.id}), set up: equal (${why2 || 'equal'})`);
  /** JSON v with each "@#k" (a key or a string) as the k-th of `K`. */
  const seatedAs = (v) => (typeof v === 'string' ? (/^@#[1-9]\d*$/.test(v) ? K[+v.slice(2) - 1] ?? v : v) : Array.isArray(v) ? v.map(seatedAs)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [seatedAs(k), seatedAs(x)])) : v);
  ok(!!set2.enabled && canon(A.state.rules.data) === canon(seatedAs(box.rulesState.data)) && A.state.rules.data.pile === 'feed1004' && Object.keys(JSON.parse(rsA).score).length === 2,
    `the rules' state seeded again, "@#k" the players seated now ("#2" is ${A.state.players[K[1]]?.name}: ${J(A.state.rules.data)})`);

  section("(4′) what an export can't map: a player who isn't seated (§4c, D185)");
  const X = hostTable({ seed: 33, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const xb = act(X, HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES, setup: TIDE_SETUP.filter((e) => !e.group) }) }).id;
  act(X, HOST, { t: 'setup', box: xb, rules: true });
  const wat = Object.keys(X.state.players).find((q) => X.state.players[q].seat == null), one = ranked(X)[0];
  quietly(() => {
    const t = X.api;
    X.begin();
    t.setOwner('feed1003', wat);
    t.data.watcher = wat;
    t.data.both = [wat, one];
    t.secret[wat] = { text: 'watching' };
    t.secret[one] = { text: 'seated' };
    X.commit(false);
  });
  X.drain();
  const xo = quietly(() => X.exportBox({ rules: true, state: true })), xbox = xo.value.box, xe = xbox.setup.find((e) => e.id === 'feed1003');
  ok(!!wat && xe && !('owner' in xe) && xo.value.warnings.length >= 1 && xo.warn.length >= 1, `an item a watcher owns goes ownerless, said in the warnings and the console (${J(xo.value.warnings)})`);
  ok(xbox.rulesState.data.watcher === wat && J(xbox.rulesState.data.both) === J([wat, '@#1']) && J(Object.keys(xbox.rulesState.secret).sort()) === J([wat, '@#1'].sort()),
    "the rules' state: a seated player's id as \"@#1\", the watcher's left as it is");
  const Y = hostTable({ seed: 34, me: DAVE, name: 'Dave', players: [[EVE, 'Eve'], [FAY, 'Fay']], prefix: '7' });
  const ys = act(Y, DAVE, { t: 'setup', box: act(Y, DAVE, { t: 'addBox', box: json(xbox) }).id, rules: true }), yr = Y.state.rules;
  ok(yr?.enabled && yr.data.watcher === wat && J(yr.data.both) === J([wat, ranked(Y)[0]]) && J(Object.keys(yr.secret)) === J([ranked(Y)[0]]) && !Y.state.items.feed1003.owner,
    `in a fresh room: the old watcher's id left in t.data, the secret keyed by it dropped, "@#1" the new #1 (${J(yr?.data)})`);
  ok((ys.enabled?.toasts || []).filter((m) => m === "Some saved state referred to players who weren't seated; it was dropped").length === 1, `one toast says so (${J(ys.enabled?.toasts)})`);

  section('(4′) a position using three boxes: one export, their types merged (a clashing id renamed), the same private state in a fresh room (D185)');
  const M = hostTable({ seed: 35, players: [[BOB, 'Bob']] });
  const mb = act(M, HOST, { t: 'addBox', box: tide({ setup: TIDE_SETUP.filter((e) => !e.group) }) }).id;
  act(M, HOST, { t: 'setup', box: mb });
  const dbid = act(M, HOST, { t: 'addBox', box: asAuthoring(BOXES.draughts) }).id, man = Object.keys(M.state.boxes[dbid].types).find((k) => M.state.boxes[dbid].types[k].kind !== 'board');
  const lagoon = { name: 'Lagoon', imgs: [AS[1]], backs: [{ id: 'fog', color: '#0f766e' }], pieces: [{ id: 'buoy', kind: 'token', w: 44, back: 'fog', faces: [{ img: 0 }, { label: 'L' }] }] };
  const lb = act(M, HOST, { t: 'addBox', box: lagoon }).id;
  quietly(() => {
    const t = M.api;
    M.begin();
    t.spawn(`${dbid}/${man}`, { at: { x: 2000, y: 1500 } });
    t.spawn(`${lb}/buoy`, { at: { x: 2100, y: 1500 }, up: false });
    t.spawn(`${lb}/buoy`, { at: { x: 2200, y: 1500 }, f: 1 });
    M.commit(false);
  });
  M.drain();
  act(M, HOST, { t: 'toBag', id: itemsOf(M, (x) => x.t === `${lb}/buoy` && x.f === 1)[0][0], bag: itemsOf(M, (x) => x.k === 'b')[0][0] });
  const mo = quietly(() => M.exportBox({ rules: false, state: false })).value, ids3 = mo.box.pieces.map((x) => x.id);
  ok(!('rules' in mo.box) && !('rulesState' in mo.box), 'exported without "Include the rules" and "…the game state": neither travels');
  ok(!mo.warnings.length && ids3.includes('buoy') && ids3.some((x) => /^buoy-\d$/.test(x)) && ids3.includes(man) && mo.box.backs.map((x) => x.id).some((x) => /^fog-\d$/.test(x)) && mo.box.imgs.length === 4 && mo.box.name === 'Tidewater',
    `one box: Tidewater's types first, the draughts man, Lagoon's buoy and back renamed where they clash (${J(ids3)})`);
  const Z = hostTable({ seed: 36, me: DAVE, name: 'Dave', players: [[EVE, 'Eve']], prefix: '7' });
  act(Z, DAVE, { t: 'setup', box: act(Z, DAVE, { t: 'addBox', box: json(mo.box) }).id });
  const why3 = unlike(privateOf(M, typeContent(M)), privateOf(Z, typeContent(Z)));
  ok(isBuiltin(M.state.boxes[dbid]) && !why3, `every item, by what its type is (the bag holding a Lagoon buoy too): equal (${why3 || 'equal'})`);

  section("(4′) a piece a table change left off its spot's centre, on it by containment (D119): its address through export → import");
  const Q = hostTable({ seed: 37, players: [[BOB, 'Bob']] });
  const qb = act(Q, HOST, { t: 'addBox', box: tide({ setup: TIDE_SETUP.filter((e) => !e.group) }) }).id;
  act(Q, HOST, { t: 'setup', box: qb });
  act(Q, HOST, { t: 'table', shape: 'rect', w: 2000, h: 1400 });
  const reef = Q.state.items.feed1002, pulled = itemsOf(Q, (x) => x.at === 'feed1002:2,1')[0];
  ok(!!pulled && !centredOn(pulled[1], 40, 40, plus([reef.x, reef.y], hexXY(REEF, '2,1'))), `(the 2,1 buoy, pulled in with the smaller table, lies off its hex's centre and is on it by containment: ${J(pulled && [pulled[1].x, pulled[1].y])})`);
  const qx = quietly(() => Q.exportBox({})).value.box, Qz = hostTable({ seed: 38, me: DAVE, name: 'Dave', players: [[EVE, 'Eve']], prefix: '7' });
  act(Qz, DAVE, { t: 'setup', box: act(Qz, DAVE, { t: 'addBox', box: json(qx) }).id });
  const whyQ = unlike(privateOf(Q), privateOf(Qz));
  ok(!!pulled && Qz.state.items[pulled[0]]?.at === 'feed1002:2,1' && !whyQ, `in the fresh room it is on 2,1 too: the same private state, its address included (${whyQ || 'equal'}; exported as ${J(pulled && qx.setup.find((e) => e.id === pulled[0]))})`);
}

// -----------------------------------------------------------------------------
// (5′) Deduplication
// -----------------------------------------------------------------------------
function indepDedup() {
  section('(5′) addBox of an identical box returns the existing one; a one-field change registers a new box (§4c, §2j boxKey)');
  const T = hostTable({ seed: 41, players: [[BOB, 'Bob']] });
  const first = act(T, HOST, { t: 'addBox', box: tide() }), id = first.id, nBoxes = () => Object.keys(T.state.boxes).length, nDecks = () => Object.keys(T.state.decks).length;
  const [b0, d0, g0] = [nBoxes(), nDecks(), T.state.guestDeckChars || 0];
  /** The same box with every object's keys in reverse order. */
  const reversed = (v) => (Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v);
  for (const [what, p, def] of [
    ["the same box from Bob, its keys in another order and with no id", BOB, reversed({ ...tide(), id: undefined })],
    ['the same box asking for another box id', HOST, tide({ id: 'beef0001' })],
    ['the same box whose deck asks for another id', HOST, tide({ decks: [{ ...tide().decks[0], id: 'beef0002' }] })],
  ]) {
    const r = act(T, p, { t: 'addBox', box: def, ...(p !== HOST && { cost: 30000 }) });
    ok(r.id === id && r.notes[0] === 'That box is already on this table' && !r.lines.length && nBoxes() === b0 && nDecks() === d0 && (T.state.guestDeckChars || 0) === g0,
      `${what}: the existing id, "That box is already on this table", nothing registered or spent (${r.id})`);
  }
  const P = tide().pieces, seen = new Set([id]);
  for (const [what, def] of [
    ['meta added', tide({ meta: { edition: 2 } })],
    ["a type's name", tide({ pieces: P.map((x) => (x.id === 'boat' ? { ...x, name: 'Skiff' } : x)) })],
    ["a seat's colour", tide({ seats: [tide().seats[0], { ...tide().seats[1], color: '#22c55e' }] })],
    ['a setup entry one unit over', tide({ setup: TIDE_SETUP.map((e) => (e.count === 3 ? { ...e, at: [2401, 100] } : e)) })],
    ["a deck's card renamed", tide({ decks: [{ ...tide().decks[0], cards: tide().decks[0].cards.map((c, k) => (k ? c : { n: 'Gust' })) }] })],
    ['rules added', tide({ rules: TIDE_RULES })],
  ]) {
    const n = nBoxes(), r = act(T, HOST, { t: 'addBox', box: def }), again = act(T, HOST, { t: 'addBox', box: def });
    ok(!!r.id && !seen.has(r.id) && nBoxes() === n + 1 && again.id === r.id && again.notes[0] === 'That box is already on this table' && nBoxes() === n + 1,
      `${what}: a new box (${r.id}); the same change again: that one`);
    seen.add(r.id);
  }

  section('(5′) the same box found whichever way it came: a loaded built-in by addBox, addBox\'s by t.newBox, t.newBox\'s own (§3e, D111)');
  const sig = { name: 'Signal', pieces: [{ id: 'flag', kind: 'token', faces: ['F'] }], decks: [{ name: 'Codes', cards: [{ name: 'Alpha' }, { name: 'Bravo', count: 2 }] }] };
  const up = act(T, HOST, { t: 'addBox', box: { name: 'Signal', pieces: [{ id: 'flag', kind: 'token', faces: ['F'] }], decks: [{ name: 'Codes', back: null, imgs: [], cards: [{ n: 'Alpha' }, { n: 'Bravo' }, { n: 'Bravo' }] }] } }).id;
  const dl = act(T, HOST, { t: 'loadBox', box: BOXES.draughts }), draughts = Object.keys(T.state.boxes).find((x) => isBuiltin(T.state.boxes[x]) && T.state.boxes[x].name === 'Draughts');
  const viaAdd = act(T, HOST, { t: 'addBox', box: asAuthoring(BOXES.draughts) });
  ok(!!draughts && viaAdd.id === draughts && viaAdd.notes[0] === 'That box is already on this table', `the built-in draughts, loaded, then added in the authoring format: the same box (${J(dl.lines.slice(-1))}, ${J(viaAdd.notes)})`);
  const changed = { ...sig, pieces: [{ id: 'flag', kind: 'token', faces: ['G'] }] };
  act(T, HOST, { t: 'setRules', enabled: true, reset: true, code: `({ name: 'Maker', buttons: () => [{ id: 'go', label: 'Go' }], onButton(t) {
    t.data.a = t.newBox(${J(sig)}); t.data.b = t.newBox(${J(sig)});
    t.data.c = t.newBox(${J(changed)}); t.data.d = t.newBox(${J(changed)});
  } })` });
  const n0 = nBoxes(), d1 = nDecks(), go = act(T, HOST, { t: 'rulesBtn', id: 'go' }), dt = T.state.rules.data;
  ok(dt.a === up && dt.b === up, `t.newBox of addBox's box (its text deck alike): addBox's id, twice (${dt.a}, ${dt.b})`);
  ok(!!dt.c && dt.c !== up && dt.d === dt.c && nBoxes() === n0 + 1 && nDecks() === d1 + 1 && go.lines.filter((l) => /^defined the box «Signal»/.test(l)).length === 1,
    `a one-field change: one new box (and its deck), defined once, found the second time (${J(go.lines)})`);
  const back = act(T, HOST, { t: 'addBox', box: { ...changed, decks: [{ name: 'Codes', back: null, imgs: [], cards: [{ n: 'Alpha' }, { n: 'Bravo' }, { n: 'Bravo' }] }] } });
  ok(back.id === dt.c && back.notes[0] === 'That box is already on this table', "and addBox of the script's box: the script's id");
}

// -----------------------------------------------------------------------------
// (6′) MIGRATE[4], and Reset after a save/load round trip
// -----------------------------------------------------------------------------
/** Table T as the app saves it (T.snapshot() and the catalog), loaded into a
 *  fresh table as the host's page resumes one (createTable, resume). */
function reload(T, seed, mutate = (s) => s) {
  const save = mutate(json({ ...T.snapshot(), decks: T.state.decks, boxes: T.state.boxes, boxSrc: T.state.boxSrc }));
  let n = 0;
  const clk = { t: 1.9e12 }, U = quietly(() => createTable(save, { pid: T.me, now: () => (clk.t += 250), random: rng(seed), uid: () => `9${(++n).toString(16).padStart(7, '0')}` })).value;
  U.me = T.me;
  const r = quietly(() => U.resume('Alice'));
  U.drain();
  U.takeDirty();
  return { U, save, r };
}
function indepMigrate() {
  section('(6′) MIGRATE[4]: v4 → v5, lastSetup kept, rules.box left absent, nothing else touched (§4h)');
  const v4 = {
    v: 4, seq: 9, table: { shape: 'rect', w: 3000, h: 2000 }, seats: [{ id: 'north', name: 'North', edge: 'top' }], boardSeq: 1, zMax: 3,
    items: { feed1001: { k: 'g', t: 'feed0001/chart', f: 0, x: 1100, y: 600, rot: 0, z: -999999, lock: true } }, players: {}, keys: {}, log: [], guestDeckChars: 77,
    lastSetup: 'feed0001', rules: { code: TIDE_RULES, name: 'Tidewater rules', enabled: true, data: { tides: 2 }, public: {}, asks: {}, secret: {} },
    boxes: { feed0001: { name: 'X' } }, boxSrc: { feed0001: { src: 'upload', by: BOB } },
  };
  const m = MIGRATE[4](json(v4));
  ok(m.v === 5 && m.lastSetup === 'feed0001' && !('box' in m.rules) && canon({ ...m, v: 4 }) === canon(v4), `v 5; lastSetup kept; no rules.box; every other field as it was, catalog records included`);

  section('(6′) a v4 save resumed: its boxes as they were — duplicates too — and Reset sets the box up without re-enabling rules (§4h)');
  const T = hostTable({ seed: 51, players: [[BOB, 'Bob']] });
  const bid = act(T, HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES, setup: TIDE_SETUP.filter((e) => !e.group) }) }).id;
  act(T, HOST, { t: 'setup', box: bid, rules: true });
  act(T, HOST, { t: 'rulesBtn', id: 'tide' });
  const { U } = reload(T, 52, (s) => {
    s.v = 4;
    delete s.rules.box;
    s.boxes.dead0001 = json(s.boxes[bid]); // (an older version registered the same box twice; an item refers to the second)
    s.boxSrc.dead0001 = { src: 'upload', by: BOB };
    s.items.dead1001 = { k: 'g', t: 'dead0001/buoy', f: 0, x: 100, y: 1700, rot: 0, z: 999 };
    return s;
  });
  ok(U.state.v === STATE_V && U.state.lastSetup === bid && !('box' in U.state.rules) && U.state.rules.enabled && U.state.rules.data.tides === 1, `resumed at v${STATE_V} (v5 in Phase 4): lastSetup, the rules running on their state, no rules.box`);
  ok(J(U.state.boxSrc[bid]) === J({ src: 'host', by: HOST }) && J(U.state.boxSrc.dead0001) === J({ src: 'upload', by: BOB }) && !!U.state.boxes.dead0001 && !!U.state.items.dead1001,
    'no catalog record rewritten; the duplicate box stays, with the item that uses it');
  const nb = Object.keys(U.state.boxes).length, dup = act(U, HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES, setup: TIDE_SETUP.filter((e) => !e.group) }) });
  ok([bid, 'dead0001'].includes(dup.id) && dup.notes[0] === 'That box is already on this table' && Object.keys(U.state.boxes).length === nb, `a new registration of it deduplicates (${dup.id})`);
  const rr = act(U, HOST, { t: 'reset' });
  ok(rr.lines.includes('reset «Tidewater»') && !rr.fx.some((e) => e.t === 'enable') && !rr.enabled && U.state.rules.enabled && U.state.rules.data.tides === 1 && TIDE_IDS.every((x) => U.state.items[x]) && !U.state.items.dead1001,
    `Reset: laid out again (its ids), the rules left as they run — not restarted (${J(rr.lines.slice(-1))})`);

  section('(6′) a v5 save resumed: Reset clears, lays out lastSetup again and restarts the box\'s rules when they ran (§4c, §4h)');
  const V = hostTable({ seed: 53, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const vb = act(V, HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES, setup: TIDE_SETUP.filter((e) => !e.group) }) }).id;
  act(V, HOST, { t: 'setup', box: vb, rules: true });
  const laid = privateOf(V);
  act(V, HOST, { t: 'rulesBtn', id: 'tide' });
  act(V, HOST, { t: 'rulesBtn', id: 'tide' });
  act(V, holderOf(V, 'south'), { t: 'move', id: 'feed1003', x: 1500, y: 1500 });
  act(V, HOST, { t: 'del', id: 'feed1004' });
  const { U: W, save } = reload(V, 54);
  ok(save.lastSetup === vb && save.rules.box === vb && W.state.lastSetup === vb && W.state.rules.box === vb && W.state.rules.enabled && W.state.rules.data.tides === 2, 'the save holds lastSetup and rules.box; resumed, both stand');
  const sig = (P) => J(Object.entries(P.items).map(([id, x]) => J([TIDE_IDS.includes(id) ? id : '', { ...x, owner: x.owner }])).sort());
  const wr = act(W, HOST, { t: 'reset' });
  ok(wr.lines.includes('reset «Tidewater»') && W.state.lastSetup === vb && sig(privateOf(W)) === sig(laid) && J(privateOf(W).hands) === J(laid.hands),
    'Reset after the reload: the table cleared and laid out as the setup first did (the asked ids too)');
  ok(!!wr.enabled && W.state.rules.enabled && W.state.rules.box === vb && W.state.rules.data.tides === 0 && W.state.rules.data.ready === true,
    `…and the box's rules restarted afresh, still the box's (tides ${W.state.rules.data.tides})`);
  act(W, HOST, { t: 'setRules', enabled: false });
  ok(W.state.rules.box === vb && !W.state.rules.enabled, 'a Disable keeps rules.box (D182)');
  const wd = act(W, HOST, { t: 'reset' });
  ok(wd.lines.includes('reset «Tidewater»') && !wd.enabled && !W.state.rules.enabled, 'Reset with the rules off: laid out, the rules stay off');
  const other = act(W, HOST, { t: 'addBox', box: { name: 'Other', pieces: [{ id: 'x', kind: 'die' }], setup: [{ piece: 'x', at: [10, 10] }] } }).id;
  const w0 = canon(W.state), wo = act(W, HOST, { t: 'reset', box: other });
  ok(/^🚫 /.test(wo.notes[0] || '') && canon(W.state) === w0, `reset {box} naming a box that isn't lastSetup: refused, nothing changed ("${wo.notes[0]}")`);
  act(W, HOST, { t: 'setRules', enabled: true, reset: true, code: TIDE_RULES });
  const wn = act(W, HOST, { t: 'reset' });
  ok(W.state.rules.enabled && !('box' in W.state.rules) && !wn.enabled && wn.lines.includes('reset «Tidewater»'),
    "the box's very code enabled from the 📜 dialog (no box named): no rules.box, so Reset doesn't restart them (D182, §4c)");
  const wc = act(W, HOST, { t: 'reset', box: vb });
  ok(wc.lines.includes('reset «Tidewater»'), 'reset {box: lastSetup} (the compatible form): reset');
  const B0 = hostTable({ seed: 55, players: [[BOB, 'Bob']] }), b0 = canon(B0.state), nr = act(B0, HOST, { t: 'reset' }), br = act(B0, BOB, { t: 'reset' });
  ok(/^🚫 /.test(nr.notes[0] || '') && /^🚫 /.test(br.notes[0] || '') && canon(B0.state) === b0, `Reset with no lastSetup, and Bob's: refused, nothing changed ("${nr.notes[0]}", "${br.notes[0]}")`);
  const gB = hostTable({ seed: 56, players: [[BOB, 'Bob'], [CAROL, 'Carol']] });
  const gid = act(gB, BOB, { t: 'addBox', box: tide({ id: undefined, setup: TIDE_SETUP.filter((e) => !e.group) }), cost: 20000 }).id;
  act(gB, HOST, { t: 'setup', box: gid });
  const { U: gU } = reload(gB, 57), gs = [];
  for (let k = 0; k < 4; k++) { act(gU, HOST, { t: 'reset' }); gs.push(J(gU.state.items.feed1004.cards.map((c) => c.i))); }
  ok(gU.state.boxSrc[gid]?.src === 'upload' && gs.some((d) => d !== '[0,1,2,3,4,5]'), `a guest's box after a reload: still an upload, its Reset shuffled (${gs.join(' ')})`);
}

// -----------------------------------------------------------------------------
// (W′) The Worker contract: box jobs while rules run (§4f, §3f.6, D181–D183)
// -----------------------------------------------------------------------------
/** "Skiff", a guest's small box with rules whose state names its own items. */
const skiff = () => ({
  name: 'Skiff', imgs: [], backs: [{ id: 'tarp', color: '#555555' }],
  pieces: [{ id: 'oar', kind: 'token', w: 30, faces: ['O'] }, { id: 'hull', kind: 'tile', w: 60, back: 'tarp', faces: ['H', 'h'] }],
  decks: [{ name: 'Wind', back: '#222222', imgs: [], cards: [{ n: 'N' }, { n: 'E' }, { n: 'S' }, { n: 'W' }] }],
  setup: [{ piece: 'oar', at: [300, 300], id: 'faced001' }, { deck: 'Wind', at: [500, 300], id: 'faced002' }, { pile: [{ piece: 'hull', f: 0 }, { piece: 'hull', f: 1 }], at: [700, 300], id: 'faced003' }],
  rules: "({ name: 'Skiff rules', setup(t) { t.data.boot = (t.data.boot || 0) + 1; } })",
  rulesState: { data: { oar: 'faced001', wind: 'faced002', boot: 0 }, public: {}, asks: {}, secret: {} },
});
function indepWorker() {
  section('(W′) with rules running, every honest box job runs in the mirror and the host takes its patch (§4f; digests agree)');
  const R = room(HOST, 'Alice', [[BOB, 'Bob'], [CAROL, 'Carol']], '8'), H = R.H;
  /** Job (p, a) through the room; a refused patch is a failed check. */
  const honest = (what, p, a, check = () => true) => {
    let r = null, threw = null;
    try { r = a.t === 'addBox' ? R.add(p, a.box, a.cost) : R.job(p, a); } catch (e) { threw = e; }
    const fine = !threw && R.same() && check(r);
    ok(fine, `${what}: taken${threw ? ` — REFUSED: ${threw.message}` : R.same() ? '' : ' — the digests differ'}`);
    return r || {};
  };
  /** A script that watches box jobs; with `tb`, it also defines and lays out boxes from its buttons. */
  const lookout = (tb) => `({ name: 'Lookout',
    setup(t) { t.data.setups = (t.data.setups || 0) + 1; },
    onAction(t, a) { if (a.t === 'addBox') t.say('a box came aboard'); },
    buttons: () => [{ id: 'make', label: 'Make' }, { id: 'lay', label: 'Lay' }],
    onButton(t, id) {
      if (id === 'make') t.data.made = t.newBox({ name: 'Flags', pieces: [{ id: 'flag', kind: 'token', faces: ['F'] }] });
      if (id === 'lay') t.data.laid = t.layout(${J(tb ?? null)}, [{ piece: 'buoy', at: [2000, 1800] }, { piece: 'buoy', at: 'quay' }]);
    } })`;
  honest('Enable a script', HOST, { t: 'setRules', enabled: true, reset: true, code: lookout() }, () => !!R.M);
  const tb = honest("the host's addBox", HOST, { t: 'addBox', box: tide({ rules: TIDE_RULES }) }, (r) => H.state.boxSrc[r.id]?.src === 'host' && r.lines.includes('a box came aboard')).id;
  const sk = honest("Bob's addBox (an upload, the budget spent)", BOB, { t: 'addBox', box: skiff(), cost: 3000 }, (r) => H.state.boxSrc[r.id]?.src === 'upload' && H.state.guestDeckChars >= 3000).id;
  honest("Carol's addBox of a box already there", CAROL, { t: 'addBox', box: tide({ rules: TIDE_RULES }), cost: 3000 }, (r) => r.id === tb && r.notes[0] === 'That box is already on this table');
  honest('setup (clearing)', HOST, { t: 'setup', box: tb }, () => H.state.lastSetup === tb && Object.keys(H.state.items).length === 24);
  const four = honest("the host's addBox of a box for four", HOST, { t: 'addBox', box: { name: 'Four', pieces: [{ id: 'p', kind: 'die' }], setup: [{ piece: 'p', at: [10, 10] }, { piece: 'p', at: [90, 10], owner: '#4' }] } }).id;
  honest('its setup, refused in the mirror (a "#4" with three at the table): the patch taken, the host told, nothing changed', HOST, { t: 'setup', box: four },
    (r) => /^🚫 .*4 seated players/.test(r.notes[0] || '') && H.state.lastSetup === tb && Object.keys(H.state.items).length === 24 && !r.lines.length);
  honest('Enable it again, knowing the box', HOST, { t: 'setRules', enabled: true, reset: true, code: lookout(tb) }, () => !!R.M);
  honest('t.newBox in a hook', HOST, { t: 'rulesBtn', id: 'make' }, () => !!H.state.boxes[H.state.rules.data.made] && H.state.boxSrc[H.state.rules.data.made].src === 'script');
  honest('t.layout in a hook', HOST, { t: 'rulesBtn', id: 'lay' }, () => H.state.rules.data.laid === 2 && Object.keys(H.state.items).length === 26);
  honest('loadBox of the built-in draughts, set up', HOST, { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true }, () => isBuiltin(H.state.boxes[H.state.lastSetup]));
  const dId = H.state.lastSetup;
  honest('reset of it (the rules running are not its own: no restart)', HOST, { t: 'reset' }, (r) => !r.enabled && H.state.lastSetup === dId && H.state.rules.name === 'Lookout');
  honest("setup of Bob's box (its face-down piles shuffled)", HOST, { t: 'setup', box: sk }, (r) => r.lines.some((l) => /face-down piles shuffled/.test(l)) && !!H.state.items.faced001);
  const kept = honest("setup of it again, kept, with its rules (its 3 ids taken: remapped)", HOST, { t: 'setup', box: sk, clear: false, rules: true },
    (r) => !!r.enabled && !r.enabled.error && H.state.rules.box === sk && H.state.rules.name === 'Skiff rules' && r.toasts.includes('3 ids had to change; a running script that stored them may misbehave'));
  const d = H.state.rules.data;
  ok(d.oar !== 'faced001' && H.state.items[d.oar]?.t === `${sk}/oar` && d.wind !== 'faced002' && H.state.items[d.wind]?.k === 'p' && d.boot === 1,
    `the rules' state names the new items: the remap reached them (${J(d)}, ${J(kept.toasts)})`);
  honest('reset with the box\'s rules running: restarted after it', HOST, { t: 'reset' }, (r) => !!r.enabled && H.state.rules.box === sk && H.state.rules.data.oar === 'faced001' && H.state.rules.data.boot === 1);
  honest('Disable', HOST, { t: 'setRules', enabled: false }, () => !H.state.rules.enabled && H.state.rules.box === sk);

  section('(W′) a forged patch that sets rules.box, lastSetup or a box record outside the job that may is refused whole (checkPatch, D181–D183)');
  const L = room(HOST, 'Alice', [[BOB, 'Bob']], '9'), LH = L.H;
  const t1 = L.add(HOST, tide({ rules: TIDE_RULES })).id, s1 = L.add(HOST, { ...skiff(), name: 'Skiff (host)' }).id;
  L.job(HOST, { t: 'setup', box: t1 });
  const PLAIN = '({ name: "Plain" })';
  L.job(HOST, { t: 'setRules', enabled: true, reset: true, code: PLAIN });
  let minis = 0;
  const mini = () => ({ name: `Mini ${++minis}`, pieces: [{ id: 'p', kind: 'die' }] });
  const shape = () => canon({ items: LH.state.items, boxes: LH.state.boxes, boxSrc: LH.state.boxSrc, decks: LH.state.decks, lastSetup: LH.state.lastSetup ?? null, rules: LH.state.rules, players: LH.state.players });
  const forged = (what, p, a, forge) => {
    const r0 = quietly(() => L.M.job(p, a)).value, P = structuredClone(r0.patch || {}), O = structuredClone(r0.out || { effects: [] });
    forge(P, O);
    const was = shape();
    let threw = null;
    try { quietly(() => LH.applyStatePatch(P, O, { p, a })); } catch (e) { threw = e; }
    ok(!!threw && shape() === was, `${what}: refused, nothing applied${threw ? ` (${threw.message})` : ' — TAKEN'}`);
    L.job(HOST, { t: 'setRules', enabled: true, reset: true, code: PLAIN }); // (a fresh mirror from the host's table)
  };
  const rot = { t: 'rot', id: 'feed1003', rot: 90 }, box = (by, src) => ({ ab0de001: { box: cleanBox({ name: 'Forged', types: { a: { kind: 'die', name: 'A' } } }), src, by } });
  forged("rules.box set in the host's rot", HOST, rot, (P) => { P.rules = { ...P.rules, box: t1 }; });
  forged("lastSetup set in Bob's chat", BOB, { t: 'chat', msg: 'ahoy' }, (P) => { P.lastSetup = s1; });
  forged("a box record (the host's) in the host's rot", HOST, rot, (P) => { P.boxes = box(HOST, 'host'); });
  forged("a box record (Bob's upload) in Bob's chat", BOB, { t: 'chat', msg: 'ahoy' }, (P) => { P.boxes = box(BOB, 'upload'); });
  forged("lastSetup set in Bob's addBox", BOB, { t: 'addBox', box: mini(), cost: 200 }, (P) => { P.lastSetup = s1; });
  forged("Bob's addBox recorded as the host's", BOB, { t: 'addBox', box: mini(), cost: 200 }, (P) => { for (const x of Object.values(P.boxes || {})) { x.src = 'host'; x.by = HOST; } });
  forged("the host's addBox recorded as an upload", HOST, { t: 'addBox', box: mini() }, (P) => { for (const x of Object.values(P.boxes || {})) x.src = 'upload'; });
  forged('lastSetup set to another box in a setup', HOST, { t: 'setup', box: t1 }, (P) => { P.lastSetup = s1; });
  forged('a box record added in a setup', HOST, { t: 'setup', box: t1 }, (P) => { P.boxes = box(HOST, 'host'); });
  forged('rules.box set in a setup', HOST, { t: 'setup', box: t1 }, (P) => { P.rules = { ...P.rules, box: t1 }; });
  forged('lastSetup set to another box in a reset', HOST, { t: 'reset' }, (P) => { P.lastSetup = s1; });
  forged("rules.box set in an Enable whose code isn't that box's rules", HOST, { t: 'setRules', enabled: true, reset: true, code: '({ name: "Other" })', box: t1 }, (P) => { P.rules = { ...P.rules, box: t1 }; });
  forged("a setup's `enable` naming another box", HOST, { t: 'setup', box: t1, rules: true }, (P, O) => { for (const e of O.effects) if (e.t === 'enable') e.box = s1; });
  forged('an `enable` in a reset whose box\'s rules are not running', HOST, { t: 'reset' }, (P, O) => { O.effects.push({ t: 'enable', box: t1, remap: {} }); });
  forged("Bob's addBox rewriting a box the catalog holds", BOB, { t: 'addBox', box: mini(), cost: 200 }, (P) => { P.boxes = { ...P.boxes, [s1]: { box: cleanBox({ name: 'Swapped', types: { a: { kind: 'die', name: 'A' } } }), src: 'upload', by: BOB } }; });
  forged('a setup whose lastSetup is no box', HOST, { t: 'setup', box: t1 }, (P) => { P.lastSetup = 'ab0de999'; });
}

// -----------------------------------------------------------------------------
// (3′) group (§4l item 3: §4c, §3f.4, §3f.5, §3f.6, §2c; D217–D219), written
//      apart from the implementation. §4c expands a group into "one
//      sub-action per member", each the player's own single action — so a
//      twin table sent those single actions one by one, bottom to top, must
//      end the same (positions, turns, faces, addresses), and a member its
//      single action would refuse is skipped alone. Then the ruled pipeline
//      per member from a savepoint of its own, the whole job failing closed
//      on a handle or validate that throws, the ONE line and the ONE notice,
//      the costs (flood control, the watchdog's budget), and the host's
//      checks of a Worker's group patch. "Muster" is an original test box.
// -----------------------------------------------------------------------------
/** Muster's item ids, by role (setup order: bottom to top). */
const MU = Object.fromEntries(['field', 'p1', 'p2', 'f1', 'f2', 'f3', 'f9', 'b1', 'l1', 'plank', 'hexa', 'wedge', 'crate', 'd1', 'd2', 'd3', 'gem', 'pebble', 'spare', 'sack', 'c1', 'c2']
  .map((k, j) => [k, `ba5e10${j.toString(16).padStart(2, '0')}`]));
/** The face-down die's faces: never in a line or a notice while it lies face down. */
const GEM_FACES = ['Ruby', 'Opal', 'Jade', 'Onyx'];
/** Each Muster piece type's side (all are square: §2a, h defaults to w) and
 *  rotStep (§2a's defaults: a token 0, a tile 90, a die 0). */
const SIDE = { pawn: 60, plank: 80, hexa: 60, wedge: 50, crate: 80, d4: 56, gem: 56, pebble: 56 };
const STEP = { pawn: 0, plank: 90, hexa: 60, wedge: 45, crate: 90, d4: 0, gem: 0, pebble: 0 };
/** Where each Muster item is laid out (top-left), and its type. */
const MU_AT = {
  p1: [1220, 720], p2: [1520, 920], f1: [300, 300], f2: [400, 300], f3: [500, 300], f9: [600, 300], b1: [300, 500], l1: [400, 500],
  plank: [300, 800], hexa: [420, 800], wedge: [540, 800], crate: [660, 800], d1: [2400, 300], d2: [2480, 300], d3: [1333, 777],
  gem: [2560, 300], pebble: [2640, 300], spare: [800, 300],
};
const MU_TYPE = { p1: 'pawn', p2: 'pawn', f1: 'pawn', f2: 'pawn', f3: 'pawn', f9: 'pawn', b1: 'pawn', l1: 'pawn', plank: 'plank', hexa: 'hexa', wedge: 'wedge', crate: 'crate', d1: 'd4', d2: 'd4', d3: 'd4', gem: 'gem', pebble: 'pebble', spare: 'pawn' };
/** "Muster": a 10 × 8 square field (cells of 100) centred on a 3000 × 2000
 *  table — so at (1000, 600) — with pawns (two faces, free turns) on it
 *  (p1, p2) and off it; a tile, a hex token (60°) and a wedge (45°); a crate
 *  (a tile with a back) face down; dice with labelled faces, one (d3) on the
 *  field; a face-down die ("gem") and a face-down token ("pebble") under ONE
 *  back, alike from outside (§2a: the back carries the flags); a locked pawn
 *  (l1); a bag; two face-down cards. Anyone may lock (§2c). */
const muster = () => ({
  name: 'Muster', id: 'ba5e0001', players: [2, 4], imgs: [], lockable: 'anyone',
  table: { shape: 'rect', w: 3000, h: 2000 },
  backs: [{ id: 'tarp', color: '#3f3f46' }, { id: 'cup', color: '#7c2d12', label: '?' }],
  pieces: [
    { id: 'field', kind: 'board', w: 1000, h: 800, grid: { type: 'square', cols: 10, rows: 8, cell: 100 } },
    { id: 'pawn', kind: 'token', w: 60, faces: ['P', 'p'] },
    { id: 'plank', kind: 'tile', w: 80, faces: ['L'] },
    { id: 'hexa', kind: 'token', shape: 'hex', w: 60, rotStep: 60, faces: ['H'] },
    { id: 'wedge', kind: 'token', shape: 'rect', w: 50, rotStep: 45, faces: ['W'] },
    { id: 'crate', kind: 'tile', w: 80, back: 'tarp', faces: ['salt', 'silk'] },
    { id: 'd4', kind: 'die', faces: ['I', 'II', 'III', 'IV'] },
    { id: 'gem', kind: 'die', back: 'cup', faces: GEM_FACES },
    { id: 'pebble', kind: 'token', shape: 'rect', w: 56, stack: 'none', back: 'cup', faces: ['Grit'] },
  ],
  decks: [{ name: 'Omens', id: 'ba5e0002', back: '#1e293b', imgs: [], cards: [{ n: 'Zephyr Crown' }, { n: 'Quiet Lantern' }] }],
  setup: [
    { piece: 'field', at: 'center', id: MU.field },
    ...Object.entries(MU_TYPE).map(([k, t]) => ({ piece: t, at: MU_AT[k], id: MU[k], ...(['crate', 'gem', 'pebble'].includes(k) && { up: false }), ...(k === 'l1' && { lock: true }) })),
    { bag: ['pawn'], name: 'Sack', at: [2400, 1600], id: MU.sack },
    { card: { deck: 'Omens', i: 0 }, up: false, at: [2700, 900], id: MU.c1 },
    { card: { deck: 'Omens', i: 1 }, up: false, at: [2820, 900], id: MU.c2 },
  ],
});
/** A Muster table (hostTable: the rules off): Alice hosts, Bob and Carol
 *  join; set up; Bob given the pawn b1 and the card c1 (the host may give
 *  anything, §2c). The same seed makes a twin, randomness included. */
function mustered(seed = 31) {
  const T = hostTable({ seed, players: [[BOB, 'Bob'], [CAROL, 'Carol']], prefix: '7' });
  T.box = act(T, HOST, { t: 'addBox', box: muster() }).id;
  act(T, HOST, { t: 'setup', box: T.box });
  for (const id of [MU.b1, MU.c1]) act(T, HOST, { t: 'owner', id, to: BOB });
  return T;
}
/** A Muster room (room(): the host's table, and a mirror while rules run), set up as mustered() does. */
function musterRoom(prefix) {
  const R = room(HOST, 'Alice', [[BOB, 'Bob'], [CAROL, 'Carol']], prefix);
  R.box = R.add(HOST, muster()).id;
  R.job(HOST, { t: 'setup', box: R.box });
  for (const id of [MU.b1, MU.c1]) R.job(HOST, { t: 'owner', id, to: BOB });
  return R;
}
/** Player p's action `a` on table T, as the host's own table runs it:
 *  {changed, lines: [[who, txt]], notes: p's [[msg, ruled]], bulbs (the fx
 *  markers), sent (the items the next state re-sends)}. */
function play(T, p, a) {
  const q = quietly(() => T.apply(p, a)), fx = T.drain(), d = T.takeDirty();
  return { changed: q.value, lines: d.log.map((e) => [e.p, e.txt]), notes: fx.filter((e) => e.t === 'note' && e.p === p).map((e) => [e.msg, e.ruled === true]), bulbs: fx.filter((e) => e.t === 'fx').map((e) => e.f), sent: d.items };
}
/** Room R's job (p, a) (room().job), with the lines it added as [who, txt] and p's notices as [msg, ruled]. */
function rjob(R, p, a) {
  const n0 = R.H.state.log.length, r = R.job(p, a);
  return { ...r, said: R.H.state.log.slice(n0).map((e) => [e.p, e.txt]), told: r.fx.filter((e) => e.t === 'note' && e.p === p).map((e) => [e.msg, e.ruled === true]) };
}
/** What the eye compares of item `id` on table T: position, turn, face, side, address, lock, count — or 'gone'. */
const look = (T, id) => { const x = own(T.state.items, id); return x ? J([x.x, x.y, x.rot ?? 0, x.f ?? null, x.up ?? null, x.at ?? null, !!x.lock, x.n ?? 1]) : 'gone'; };
/** A refusal's words without its leading mark ("🚫 ", "🔒 "). */
const bare = (msg) => msg.replace(/^(?:🚫|🔒) /u, '');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `msg` is a group's one notice (§4c, D218): "{k} of {N} were
 *  skipped: {reason}" ("was" taken for one too), "🚫 " first exactly when
 *  `none` applied; the reason with or without its own leading mark. */
const isSkip = (msg, k, N, reason, none = false) => new RegExp(`^${none ? '🚫 ' : ''}${k} of ${N} (?:were|was) skipped: (?:🚫 |🔒 )?${reEsc(bare(reason))}$`, 'u').test(msg || '');
/** Where Muster item `id` of table T lands moved by (dx, dy) (§3a, D112): a
 *  piece (not a die) whose new centre lies on the field is centred on the
 *  cell holding that centre; anything else lands at (x + dx, y + dy). */
function landing(T, id, dx, dy) {
  const it = T.state.items[id], ty = tid(it.t), w = SIDE[ty], x = it.x + dx, y = it.y + dy, cx = x + w / 2, cy = y + w / 2;
  if (ty === 'd4' || ty === 'gem' || cx < 1000 || cx >= 2000 || cy < 600 || cy >= 1400) return [x, y];
  return [1000 + 100 * Math.floor((cx - 1000) / 100) + 50 - w / 2, 600 + 100 * Math.floor((cy - 600) / 100) + 50 - w / 2];
}
/** §2c's turn: rotation `r` snapped to `step` (step ? round(r/step)·step : r), as an angle in [0, 360). */
const turned = (r, step) => (((step ? Math.round(r / step) * step : r) % 360) + 360) % 360;
/** app.js's watchdog budget for an action (spec §3f.5): app.js is a page,
 *  so its `budget` is cut from its text (as h.js cuts WholeOffers) and run
 *  here, on the engine's own groupIds. */
function appBudget() {
  const src = fs.readFileSync(path.join(APP_ROOT, 'cardtable/app.js'), 'utf8');
  const fn = /^function budget\(a\) \{\n[\s\S]*?\n\}$/m.exec(src)?.[0], ms = /\bRULES_TIMEOUT_MS = (\d+)/.exec(src)?.[1];
  if (!fn || !ms) throw new Error("app.js: no `function budget(a)` or no RULES_TIMEOUT_MS — the watchdog's budget can't be checked");
  return new Function('RULES_TIMEOUT_MS', 'groupIds', 'own', 'countSetup', 'T', `${fn}\nreturn budget;`)(Number(ms), groupIds, own, () => 0, { state: { boxes: {}, players: {}, items: {} }, rulesChars: () => 0 });
}

function indepGroup() {
  const I = MU, it = (T, k) => T.state.items[k];
  section("(3′) a group is one sub-action per member, each the player's own single action: the table ends as those single moves leave a twin, each piece snapping on its own (§4c, §3a, D112)");
  {
    const T = mustered(), U = mustered();
    ok(J([it(T, I.field).x, it(T, I.field).y]) === J([1000, 600]) && canon(T.state.items) === canon(U.state.items) && it(T, I.b1).owner === BOB && it(T, I.l1).lock === true,
      'twin tables, laid out alike: the field at (1000, 600), Bob\'s pawn, the locked pawn');
    const mem = [I.p1, I.p2, I.f1, I.d3], dx = 130, dy = -20, want = mem.map((k) => landing(T, k, dx, dy));
    const r = play(T, CAROL, { t: 'group', op: 'move', ids: mem, dx, dy });
    ok(J(mem.map((k) => [it(T, k).x, it(T, k).y])) === J(want),
      `each member where its own move puts it: the pawns on the field centred on the cell under them, the pawn off it and the die (dice never snap) moved by (${dx}, ${dy}) (${J(mem.map((k) => [it(T, k).x, it(T, k).y]))})`);
    const singles = [...mem].sort((a, b) => it(U, a).z - it(U, b).z).map((k) => play(U, CAROL, { t: 'move', id: k, x: it(U, k).x + dx, y: it(U, k).y + dy }));
    ok(mem.every((k) => look(T, k) === look(U, k)), `…exactly as the four single moves {id, x: it.x + dx, y: it.y + dy} leave the twin (position, turn, face, address: ${J(mem.map((k) => JSON.parse(look(T, k))[5]))})`);
    ok(J(r.lines) === J([[CAROL, 'moved 4 items']]) && singles.every((s) => s.lines.length === 1), `ONE line, the actor's, where the singles wrote four (${J(r.lines)})`);
    const b = r.bulbs[0];
    ok(r.bulbs.length === 1 && b.p === CAROL && mem.includes(b.id) && b.x === it(T, b.id).x && b.y === it(T, b.id).y, `one name bulb, on a member, where it lies now (${J(r.bulbs)})`);
    ok(r.changed && !r.notes.length, 'nothing skipped: no notice');
    const near0 = [I.p1, I.d1], edge = play(T, CAROL, { t: 'group', op: 'move', ids: near0, dx: 5000, dy: 0 });
    const shift = near0.map((k, j) => it(T, k).x - [it(U, I.p1).x, it(U, I.d1).x][j]);
    ok(edge.changed && shift[0] > 0 && it(T, I.d1).x + 56 <= 3000 && it(T, I.d1).y === it(U, I.d1).y, `a shift past the table's edge: the group slides only as far as its members stay on the table (§3c, D118: the shift ${J(shift)})`);
  }

  section("(3′) every member takes its single action's checks — owner, lock — and only it is skipped; ONE notice, \"{k} of {N} were skipped: {the first reason}\", a refusal only when none applied (§4c, §2c, D218)");
  {
    const T = mustered(), U = mustered(), single = (p, a) => play(U, p, a).notes.map(([m]) => m);
    const owned = single(CAROL, { t: 'move', id: I.b1, x: 300, y: 600 }), locked = single(CAROL, { t: 'move', id: I.l1, x: 400, y: 600 });
    ok(J(owned) === J(['🚫 That belongs to Bob']) && J(locked) === J(['🔒 That is locked in place']), `the single moves' refusals, on the twin (§2c: ${J([owned, locked])})`);
    const was = Object.fromEntries(Object.values(I).map((k) => [k, look(T, k)]));
    let r = play(T, CAROL, { t: 'group', op: 'move', ids: [I.f1, I.b1, I.l1, I.f2], dx: 0, dy: 100 });
    ok(it(T, I.f1).y === 400 && it(T, I.f2).y === 400 && look(T, I.b1) === was[I.b1] && look(T, I.l1) === was[I.l1], "Carol's group: her two free pawns moved; Bob's pawn and the locked one stayed");
    ok(r.notes.length === 1 && isSkip(r.notes[0][0], 2, 4, owned[0]) && r.notes[0][1] === false,
      `one notice; its reason the lowest skipped member's (Bob's pawn lies under the locked one); no "🚫": some applied; not the rules' (${J(r.notes)})`);
    ok(J(r.lines) === J([[CAROL, 'moved 2 items']]), `one line, counting the members moved (${J(r.lines)})`);
    ok(r.sent.has(I.b1) && r.sent.has(I.l1), 'the skipped members are re-sent: an optimistic drop of them snaps back (the refusal touch, §2c)');
    const st = canon(T.state.items);
    r = play(T, CAROL, { t: 'group', op: 'move', ids: [I.l1, I.b1], dx: 50, dy: 0 });
    ok(canon(T.state.items) === st && !r.lines.length && r.notes.length === 1 && isSkip(r.notes[0][0], 2, 2, owned[0], true) && r.sent.has(I.b1) && r.sent.has(I.l1),
      `none of them Carol's to move: nothing changes, one refusal ("🚫 …"), both re-sent (${J(r.notes)})`);
    const one = play(T, CAROL, { t: 'group', op: 'move', ids: [I.l1], dx: 50, dy: 0 }).notes.map(([m]) => m);
    ok(J(one) === J(locked), `a group of one says what its single action says (D218: ${J(one)}; the single move: ${J(locked)})`);
    r = play(T, BOB, { t: 'group', op: 'move', ids: [I.b1, I.l1], dx: 0, dy: 100 });
    ok(it(T, I.b1).y === 600 && look(T, I.l1) === was[I.l1] && r.notes.length === 1 && isSkip(r.notes[0][0], 1, 2, locked[0]), `Bob's group: his own pawn moves, the locked one is skipped (${J(r.notes)})`);
    r = play(T, CAROL, { t: 'group', op: 'lock', ids: [I.f3, I.b1], on: true });
    ok(it(T, I.f3).lock === true && !it(T, I.b1).lock && J(r.lines) === J([[CAROL, 'locked 1 item']]) && r.notes.length === 1 && isSkip(r.notes[0][0], 1, 2, owned[0]),
      `lock (anyone may, on what they may handle): Carol locks the free pawn, not Bob's (${J(r.lines)}, ${J(r.notes)})`);
    r = play(T, CAROL, { t: 'group', op: 'move', ids: [I.f3, I.f1], dx: 10, dy: 0 });
    ok(it(T, I.f3).x === 500 && it(T, I.f1).x === 310 && r.notes.length === 1 && isSkip(r.notes[0][0], 1, 2, locked[0]), `…and it no longer moves with a group (${J(r.notes)})`);
    r = play(T, CAROL, { t: 'group', op: 'lock', ids: [I.f3], on: false });
    ok(!it(T, I.f3).lock && J(r.lines) === J([[CAROL, 'unlocked 1 item']]), `unlocked (${J(r.lines)})`);
  }

  section('(3′) the hidden-item rule, per member: a group rolls ONE roll of the dice among its members that the player sees; a face-down die is no die to them — the outcome word for word a face-down pebble\'s under the same back — and its value never shows (§4c, §2c, D217, D218)');
  {
    const T = mustered(), U = mustered(), g0 = it(T, I.gem).f;
    const rT = play(T, CAROL, { t: 'group', op: 'roll', ids: [I.f1, I.gem, I.d2, I.d1] }), rU = play(U, CAROL, { t: 'group', op: 'roll', ids: [I.f1, I.pebble, I.d2, I.d1] });
    const lab = (k) => ['I', 'II', 'III', 'IV'][it(T, k).f];
    ok(J(rT.lines) === J([[CAROL, `rolled 2 dice: ${lab(I.d1)} · ${lab(I.d2)}`]]), `one line, the two dice's faces in id order, as a roll says them (§2c: ${J(rT.lines)})`);
    ok(it(T, I.gem).f === g0 && it(T, I.gem).up === false && look(T, I.f1) === look(U, I.f1), 'the face-down die is not rolled, the pawn neither');
    ok(J([rT.lines, rT.notes]) === J([rU.lines, rU.notes]) && it(T, I.d1).f === it(U, I.d1).f, `the twin, where a face-down pebble stood in for that die, said the same: nothing tells a hidden die from a hidden token (${J(rU.lines)}, ${J(rU.notes)})`);
    ok(rT.bulbs.length === 1 && J([...(rT.bulbs[0].roll || [])].sort()) === J([I.d1, I.d2]), `one bulb, tumbling the two dice (${J(rT.bulbs)})`);
    const alone = play(T, CAROL, { t: 'group', op: 'roll', ids: [I.gem] }), twin = play(U, CAROL, { t: 'group', op: 'roll', ids: [I.pebble] });
    ok(!alone.lines.length && alone.notes.length === 1 && /^🚫 /u.test(alone.notes[0][0]) && J(alone.notes) === J(twin.notes) && it(T, I.gem).f === g0,
      `a group of the face-down die alone: refused, word for word as the pebble's (${J(alone.notes)} / ${J(twin.notes)})`);
    const all = J([rT.lines, rT.notes, rU.lines, alone, twin, T.state.log, U.state.log]);
    ok(!GEM_FACES.some((w) => all.includes(w)), 'no face of the hidden die in any line or notice');
  }

  section("(3′) rot is a per-member DELTA, each member's new turn snapped to its own rotStep (a hidden one's: its back's) — as the single rot {rot: it.rot + delta} turns it (§4c, §2c)");
  {
    const T = mustered(), U = mustered(), turn = [I.plank, I.hexa, I.wedge, I.f1, I.crate];
    for (const d of [50, 50, -100, 120]) {
      const was = turn.map((k) => it(T, k).rot ?? 0), r = play(T, CAROL, { t: 'group', op: 'rot', ids: turn, rot: d });
      const got = turn.map((k) => it(T, k).rot ?? 0), want = turn.map((k, j) => turned(was[j] + d, STEP[tid(it(T, k).t)]));
      for (const k of turn) play(U, CAROL, { t: 'rot', id: k, rot: (it(U, k).rot ?? 0) + d });
      ok(J(got) === J(want) && J(turn.map((k) => it(U, k).rot ?? 0)) === J(got) && J(r.lines) === J([[CAROL, 'rotated 5 items']]),
        `rot ${d > 0 ? '+' : ''}${d}: tile (90°), hex (60°), wedge (45°), free pawn, face-down crate ${J(was)} → ${J(got)} (want ${J(want)}); the singles agree; one line (${J(r.lines)})`);
    }
  }

  section('(3′) flip, into a bag, remove: each member as its single action does it, one line each (§4c, §2c, D218)');
  {
    const T = mustered(), U = mustered(), f0 = it(T, I.p1).f;
    let r = play(T, CAROL, { t: 'group', op: 'flip', ids: [I.p1, I.crate, I.d1] });
    const die = play(U, CAROL, { t: 'flip', id: I.d1 }).notes.map(([m]) => m);
    for (const k of [I.p1, I.crate]) play(U, CAROL, { t: 'flip', id: k });
    ok(it(T, I.p1).f === 1 - f0 && it(T, I.crate).up !== false && [I.p1, I.crate, I.d1].every((k) => look(T, k) === look(U, k)), 'the pawn turned to its other face, the crate face up, the die as it was — as the single flips left the twin');
    ok(J(r.lines) === J([[CAROL, 'flipped 2 items']]) && r.notes.length === 1 && isSkip(r.notes[0][0], 1, 3, die[0]), `one line; the die skipped with its single flip's reason (${J(r.notes)}; the single: ${J(die)})`);
    const n0 = it(T, I.sack).of.length;
    r = play(T, CAROL, { t: 'group', op: 'toBag', ids: [I.f1, I.f2, I.pebble], bag: I.sack });
    ok([I.f1, I.f2, I.pebble].every((k) => !own(T.state.items, k)) && it(T, I.sack).of.length === n0 + 3 && J(r.lines) === J([[CAROL, 'put 3 items into the bag Sack']]),
      `into the bag: three pieces in, gone from the table; one line (${J(r.lines)})`);
    r = play(T, CAROL, { t: 'group', op: 'del', ids: [I.p2, 'dead0001', I.b1] });
    ok(!own(T.state.items, I.p2) && !!own(T.state.items, I.b1) && J(r.lines) === J([[CAROL, 'removed 1 item']]) && r.notes.length === 1 && /^2 of 3 (?:were|was) skipped: /u.test(r.notes[0][0]),
      `remove: Carol's one goes; an id that names nothing and Bob's pawn are skipped (${J(r.notes)})`);
  }

  section('(3′) the payload: the first 200 ids, each once — 500 ids, duplicates, someone else\'s, a locked one, a face-down card of Bob\'s, ids that name nothing; a malformed group changes nothing (§4c, §4j case 8, D217)');
  {
    const T = mustered(), fake = Array.from({ length: 47 }, (_, k) => `dead${k.toString(16).padStart(4, '0')}`);
    const ids = [...Array(150).fill(I.f1), I.b1, I.l1, I.c1, ...fake, I.f9, ...Array(299).fill(I.f2)];
    const was = Object.fromEntries(Object.values(I).map((k) => [k, look(T, k)]));
    const r = play(T, CAROL, { t: 'group', op: 'move', ids, dx: 0, dy: 50 });
    ok(ids.length === 500 && it(T, I.f1).y === 350, `500 ids: the pawn named 150 times moved once, by 50 (y ${it(T, I.f1).y})`);
    ok(look(T, I.f9) === was[I.f9] && look(T, I.f2) === was[I.f2], 'the ids past the 200th — a free pawn at 201, another 299 times — are never looked at');
    ok([I.b1, I.l1, I.c1].every((k) => look(T, k) === was[k]) && it(T, I.c1).up === false, "Bob's pawn, the locked one and Bob's face-down card: untouched");
    ok(r.notes.length === 1 && /^50 of 51 (?:were|was) skipped: /u.test(r.notes[0][0]) && J(r.lines) === J([[CAROL, 'moved 1 item']]),
      `one notice counting the 51 distinct members of the first 200 ids, 50 skipped (${J(r.notes)}); one line (${J(r.lines)})`);
    ok(!/Zephyr|Quiet Lantern/.test(J([r.notes, T.state.log])), 'the face-down card is never named');
    for (const a of [{ op: 'shuffle', ids: [I.f1] }, { op: 'spin', ids: [I.f1] }, { op: 'move', ids: [] }, { op: 'move' }, { op: 'lock', ids: [I.f1] }, { op: 'toBag', ids: [I.f1], bag: I.f9 }, { op: 'toBag', ids: [I.f1], bag: 'dead0001' }]) {
      const s0 = canon(T.state), q = play(T, CAROL, { t: 'group', dx: 5, dy: 5, ...a });
      ok(canon(T.state) === s0 && !q.lines.length && q.notes.length === 1 && /^🚫 /u.test(q.notes[0][0]), `${J(a)}: refused with a notice, nothing changed (${J(q.notes)})`);
    }
  }

  section("(3′) the live drag's group form {ids, dx, dy} (§3c): what the player may move — each id once, the first 200 — relayed as ONE live fx; no state change, no notice; a drag with nothing left relays nothing");
  {
    const T = mustered(), s0 = canon(T.state), dragged = (p, a) => { const q = quietly(() => T.apply(p, { t: 'drag', ...a })), fx = T.drain(); return { fx, warn: q.warn }; };
    let r = dragged(CAROL, { ids: [I.f1, I.b1, I.l1, 'dead0001', I.f1, I.f2, I.f1], dx: 30, dy: 40 });
    const live = r.fx.filter((e) => e.t === 'fx');
    ok(live.length === 1 && live[0].f.p === CAROL && live[0].f.live && J([...live[0].f.ids].sort()) === J([I.f1, I.f2].sort()) && live[0].f.dx === 30 && live[0].f.dy === 40,
      `one live fx naming the two free pawns once each, by (30, 40); Bob's, the locked and the missing dropped (${J(live)})`);
    ok(!r.fx.some((e) => e.t === 'note') && r.warn.length > 0 && canon(T.state) === s0, 'no notice (live traffic: console.warn), and the table unchanged');
    r = dragged(CAROL, { ids: [I.b1, I.l1, 'dead0001'], dx: 30, dy: 40 });
    ok(!r.fx.length && canon(T.state) === s0, `nothing Carol may move: nothing relayed (${J(r.fx)})`);
    r = dragged(CAROL, { ids: [...Array(200).fill(I.b1), I.f1], dx: 5, dy: 5 });
    ok(!r.fx.filter((e) => e.t === 'fx').length, 'a free pawn past the 200th id is never looked at');
  }

  section('(3′) flood control: a group costs 1 + ⌊N/20⌋ of the 40-token burst, N its members (the first 200 ids, each once); a group drag one, whatever its size (§4c, §3c, §0.1, D219)');
  {
    /** How many of action `a` a guest gets through a fresh bucket (the clock stopped: no refill). */
    const passes = (a) => {
      const F = quietly(() => createTable({}, { pid: HOST, now: () => 1.7e12, uid: () => 'f0000001' })).value;
      let n = 0;
      while (n < 100 && F.mayAct(BOB, a)) n++;
      return n;
    };
    const many = (n) => Array.from({ length: n }, (_, k) => `ab${k.toString(16).padStart(6, '0')}`);
    for (const [n, N] of [[1, 1], [19, 19], [20, 20], [39, 39], [40, 40], [199, 199], [200, 200], [500, 200]]) {
      const want = Math.floor(40 / (1 + Math.floor(N / 20))), got = passes({ t: 'group', op: 'move', ids: many(n), dx: 1, dy: 0 });
      ok(got === want, `a group of ${n} ids (${N} members) costs ${1 + Math.floor(N / 20)}: ${got} pass a burst of 40 (want ${want})`);
    }
    ok(passes({ t: 'group', op: 'del', ids: Array(300).fill('ab000001') }) === 40, '300 copies of one id: one member, one token');
    ok(passes({ t: 'drag', ids: many(200), dx: 3, dy: 4 }) === 40 && passes({ t: 'move', id: 'ab000001', x: 0, y: 0 }) === 40, "a group drag of 200 and a single move: one token each, 40 pass");
  }

  section("(3′) the watchdog's budget: 4000 ms, and for a group 10 ms more per member — the members as the engine counts them, the first 200 ids each once (§3f.5, §4c, D219; app.js's budget, run here)");
  {
    const budget = appBudget(), many = (n) => Array.from({ length: n }, (_, k) => `ab${k.toString(16).padStart(6, '0')}`);
    for (const [what, a, ms] of [
      ['a single move', { t: 'move', id: 'ab000001', x: 0, y: 0 }, 4000],
      ['a group of 1', { t: 'group', op: 'move', ids: many(1) }, 4010],
      ['a group of 7', { t: 'group', op: 'rot', ids: many(7), rot: 90 }, 4070],
      ['a group of 200', { t: 'group', op: 'del', ids: many(200) }, 6000],
      ['500 ids (Mallory\'s: only the first 200 count)', { t: 'group', op: 'move', ids: many(500) }, 6000],
      ['300 copies of one id', { t: 'group', op: 'flip', ids: Array(300).fill('ab000001') }, 4010],
    ]) {
      const got = budget(a);
      ok(got === ms, `${what}: ${got} ms (want ${ms})`);
    }
  }

  section('(3′) the rules on: each member through handle and validate from a savepoint of its own — a veto, or the engine\'s refusal, rolls back that member\'s writes alone, the rest apply; onAction per member; buttons() once (§4c, §3f.4, D217)');
  {
    const R = musterRoom('b'), H = R.H;
    const QM = (o = {}) => `({ name: 'Quartermaster',
      handle(t, a) {
        if (a.t !== 'move') return;
        (t.data.h ||= []).push(a.id);
        if (a.id === ${J(o.veto ?? '')}) t.flip(${J(I.spare)});
        ${o.handle ? `if (a.id === ${J(o.handle)}) throw new Error('handle broke');` : ''}
      },
      ${o.async ? 'async ' : ''}validate(t, a) {
        if (a.t === 'move' && a.id === ${J(o.veto ?? '')}) return 'Not that one';
        ${o.validate ? `if (a.id === ${J(o.validate)}) throw new Error('validate broke');` : ''}
      },
      onAction(t, a) {
        (t.data.seen ||= []).push([a.t, a.id ?? null, a.group ?? null, a.x ?? null, a.y ?? null]);
        ${o.onAction ? `if (a.id === ${J(o.onAction)}) { t.data.bad = 1; throw new Error('onAction broke'); }` : ''}
      },
      buttons(t) { t.data.b = (t.data.b || 0) + 1; return []; },
    })`;
    rjob(R, HOST, { t: 'setRules', enabled: true, reset: true, code: QM({ veto: I.f2 }) });
    const mem = [I.f1, I.f2, I.f3, I.b1], pre = Object.fromEntries(mem.map((k) => [k, [H.state.items[k].x, H.state.items[k].y]])), spare = look(H, I.spare), b0 = H.state.rules.data.b;
    const r = rjob(R, CAROL, { t: 'group', op: 'move', ids: mem, dx: 0, dy: 100 });
    const d = H.state.rules.data;
    ok(R.same() && !r.error && H.state.rules.enabled, "the host took the mirror's patch (the digests agree); the rules still on");
    ok(H.state.items[I.f1].y === 400 && H.state.items[I.f3].y === 400 && J([H.state.items[I.f2].x, H.state.items[I.f2].y]) === J(pre[I.f2]) && J([H.state.items[I.b1].x, H.state.items[I.b1].y]) === J(pre[I.b1]),
      'the vetoed pawn and Bob\'s (the engine\'s refusal) stayed; the other two moved');
    ok(!d.h.includes(I.f2) && d.h.includes(I.f1) && d.h.includes(I.f3) && look(H, I.spare) === spare, `the vetoed member's handle writes (its push, its flip of another pawn) were rolled back with it; the members done kept theirs (t.data.h ${J(d.h)})`);
    ok(!d.h.includes(I.b1), `…and so were those of the member the engine refused (Bob's pawn): "a veto or a refusal calls rollbackTo for that member only" (§4c, D217; t.data.h ${J(d.h)})`);
    ok(J(d.seen) === J([I.f1, I.f3].map((k) => ['move', k, 4, pre[k][0], pre[k][1] + 100])),
      `onAction ran for each member applied, as its single move {t: 'move', id, x: it.x + dx, y: it.y + dy, group: N} (${J(d.seen)})`);
    ok(d.b === b0 + 1, `buttons() ran once for the group (${b0} → ${d.b})`);
    ok(J(r.said.filter(([p]) => p === CAROL)) === J([[CAROL, 'moved 2 items']]) && r.said.filter(([p, txt]) => p === RULES && txt.startsWith('blocked Carol: Not that one')).length === 1,
      `one line in Carol's name; one "blocked" line for the veto (${J(r.said)})`);
    ok(r.told.length === 1 && isSkip(r.told[0][0], 2, 4, 'Not that one') && r.told[0][1] === true, `one notice, its first reason the veto (it lies lowest), marked as the rules' (D211: ${J(r.told)})`);
    rjob(R, CAROL, { t: 'move', id: I.f1, x: 300, y: 500, group: 9 });
    ok(J(H.state.rules.data.seen.at(-1)) === J(['move', I.f1, null, 300, 500]) && R.same(), `a single move that says {group: 9}: the hooks never see it (only the host sets it, D217: ${J(H.state.rules.data.seen.at(-1))})`);

    section('(3′) a handle or validate that throws — or returns a thenable — fails the WHOLE group closed, as it fails a single action: nothing of it applies, the rules go off (§4c, §3f.4)');
    const three = [I.f1, I.f2, I.f3], order = [...three].sort((a, b) => H.state.items[a].z - H.state.items[b].z); // (bottom to top: the order the members run in)
    for (const [hook, o] of [['handle', { handle: order[2] }], ['validate', { validate: order[2] }], ['validate', { async: true }]]) {
      const what = o.async ? 'an async validate (a thenable)' : `${hook}() throwing at the last member (the first two done)`;
      /** The same script, the same move of f3 alone, in a twin room. */
      const V = musterRoom('d');
      rjob(R, HOST, { t: 'setRules', enabled: true, reset: true, code: QM(o) });
      rjob(V, HOST, { t: 'setRules', enabled: true, reset: true, code: QM(o) });
      const xy = (Z) => J(three.map((k) => [Z.H.state.items[k].x, Z.H.state.items[k].y]));
      const p0 = xy(R), data0 = canon(H.state.rules.data);
      const g = rjob(R, CAROL, { t: 'group', op: 'move', ids: three, dx: 0, dy: 100 });
      const s = rjob(V, CAROL, { t: 'move', id: order[2], x: V.H.state.items[order[2]].x, y: V.H.state.items[order[2]].y + 100 });
      ok(xy(R) === p0 && canon(H.state.rules.data) === data0 && !H.state.rules.enabled, `${what}: no member moved, not even those before it; none of the hooks' writes kept; the rules off`);
      ok(J(g.told.map(([m]) => m)) === J(['🚫 rules script error']) && J(g.told) === J(s.told) && J(g.said) === J(s.said) && /handle|validate/.test(g.error?.hook || ''),
        `…said as the single move's failure is, word for word (${J(g.told)}, ${J(g.said)}; error ${J(g.error)})`);
    }

    section('(3′) an onAction that throws keeps the members done (its own writes undone); the rest are skipped, the rules off (§3f.4\'s atomicity table, D217)');
    rjob(R, HOST, { t: 'setRules', enabled: true, reset: true, code: QM({ onAction: order[1] }) });
    const ys = order.map((k) => H.state.items[k].y), q = rjob(R, CAROL, { t: 'group', op: 'move', ids: three, dx: 0, dy: 100 });
    ok(J(order.map((k, j) => H.state.items[k].y - ys[j])) === J([100, 100, 0]) && J(H.state.rules.data.seen) === J([['move', order[0], 3, H.state.items[order[0]].x, ys[0] + 100]]) && !('bad' in H.state.rules.data) && !H.state.rules.enabled,
      `the first member, and the second's own move, kept; the failing onAction's writes undone; the third skipped; the rules off (${J(H.state.rules.data)})`);
    ok(q.told.length === 1 && isSkip(q.told[0][0], 1, 3, 'rules script error') && q.said.some(([p, txt]) => p === CAROL && txt === 'moved 2 items'), `said once (${J(q.told)}, ${J(q.said)})`);

    section('(3′) strict, per member: a move no `allow` lists is refused for each; a rot it lists goes through (§3c, §4c)');
    rjob(R, HOST, { t: 'setRules', enabled: true, reset: true, code: "({ name: 'Strict', strict: true, allow: ['rot'] })" });
    const s0 = J([I.f1, I.f3].map((k) => look(H, k))), m = rjob(R, CAROL, { t: 'group', op: 'move', ids: [I.f1, I.f3], dx: 0, dy: 100 });
    ok(J([I.f1, I.f3].map((k) => look(H, k))) === s0 && m.told.length === 1 && isSkip(m.told[0][0], 2, 2, 'Not a move in this game', true) && R.same(), `the move: refused for both, said once (${J(m.told)})`);
    const t1 = rjob(R, CAROL, { t: 'group', op: 'rot', ids: [I.plank, I.hexa], rot: 90 });
    ok(J(t1.said.filter(([p]) => p === CAROL)) === J([[CAROL, 'rotated 2 items']]) && !t1.told.length && R.same(), `the rot: done (${J(t1.said)})`);
  }

  section("(3′) the host takes an honest group job's patch whole — every op, the rules on — and refuses a forged one, applying nothing (§3f.6 checkPatch, D144, D219)");
  {
    const R = musterRoom('e'), H = R.H, WATCH = "({ name: 'Watch', onAction(t, a) { t.data.n = (t.data.n || 0) + 1; } })";
    rjob(R, HOST, { t: 'setRules', enabled: true, reset: true, code: WATCH });
    for (const [what, p, a, line] of [
      ["Carol's move", CAROL, { op: 'move', ids: [I.f1, I.f2, I.b1], dx: 0, dy: 100 }, /^moved 2 items$/],
      ["Bob's rot", BOB, { op: 'rot', ids: [I.plank, I.hexa, I.wedge, I.crate], rot: 50 }, /^rotated 4 items$/],
      ["Carol's flip", CAROL, { op: 'flip', ids: [I.p1, I.crate, I.d1] }, /^flipped 2 items$/],
      ["Bob's roll", BOB, { op: 'roll', ids: [I.d1, I.d2, I.gem, I.f1] }, /^rolled 2 dice: \S+ · \S+$/],
      ["Carol's lock", CAROL, { op: 'lock', ids: [I.f3, I.b1], on: true }, /^locked 1 item$/],
      ["the host's into the bag", HOST, { op: 'toBag', ids: [I.f1, I.f2], bag: I.sack }, /^put 2 items into the bag Sack$/],
      ["Carol's remove", CAROL, { op: 'del', ids: [I.p2, 'dead0001', I.b1] }, /^removed 1 item$/],
    ]) {
      let r = null, threw = '';
      try { r = rjob(R, p, { t: 'group', ...a }); } catch (e) { threw = e.message; }
      ok(!threw && R.same() && H.state.rules.enabled && r.said.filter(([q, txt]) => q === p && line.test(txt)).length === 1, `${what}: taken, the digests agree${threw ? ` — REFUSED: ${threw}` : ''} (${J(r?.said)})`);
    }
    const ga = { t: 'group', op: 'move', ids: [I.p1, I.d2], dx: 0, dy: 100 };
    const state = () => canon({ items: H.state.items, players: H.state.players, rules: H.state.rules, log: H.state.log, lastSetup: H.state.lastSetup ?? null });
    const forged = (what, p, a, forge) => {
      const r0 = quietly(() => R.M.job(p, a)).value, P = structuredClone(r0.patch), O = structuredClone(r0.out);
      forge(P, O);
      const was = state();
      let threw = '';
      try { quietly(() => H.applyStatePatch(P, O, { p, a })); } catch (e) { threw = e.message; }
      ok(!!threw && state() === was, `${what}: refused, nothing applied (${threw || 'TAKEN'})`);
      rjob(R, HOST, { t: 'setRules', enabled: true, reset: true, code: WATCH }); // (a fresh mirror, from the host's table)
    };
    const line = (P) => (Array.isArray(P.log) ? P.log : []).find((e) => e.txt === 'moved 2 items');
    forged("the group's line said in Bob's name", CAROL, ga, (P) => { line(P).p = BOB; });
    forged("the group's name bulb in Bob's name", CAROL, ga, (P, O) => { for (const e of O.effects) if (e.t === 'fx') e.f.p = BOB; });
    forged('a chat line in the group', CAROL, ga, (P) => { P.log.push({ ...line(P), txt: 'Carol: psst', c: 1 }); });
    forged("a peek at Bob's face-down card, for Carol, in her group", CAROL, ga, (P, O) => { O.effects.push({ t: 'peek', p: CAROL, c: { d: 'ba5e0002', i: 0 } }); });
    forged('Carol renamed by her group', CAROL, ga, (P) => { P.players = { ...P.players, [CAROL]: { ...H.state.players[CAROL], name: 'Queen' } }; });
    forged('Bob sent offline by Carol\'s group', CAROL, ga, (P) => { P.players = { ...P.players, [BOB]: { ...H.state.players[BOB], online: false } }; });
    forged('lastSetup dropped in a group', CAROL, ga, (P) => { P.lastSetup = null; });
    forged("an `enable` (a box's rules to start) in a group", CAROL, ga, (P, O) => { O.effects.push({ t: 'enable', box: R.box, remap: {} }); });
    const before = [I.p1, I.d2].map((k) => H.state.items[k].y), honest = rjob(R, CAROL, ga);
    ok(R.same() && J([I.p1, I.d2].map((k, j) => H.state.items[k].y - before[j])) === J([100, 100]) && honest.said.some(([q, txt]) => q === CAROL && txt === 'moved 2 items'), 'the same group, honest: taken');
  }
}

// -----------------------------------------------------------------------------
// (F) The 4A fix-up's regressions (D196–D203)
// -----------------------------------------------------------------------------
function testFixup() {
  section('(F) a shuffled group deals out the identities of its hidden pieces: the ids an uploader gave stay with the places (D196)');
  {
    const KINDS = ['general', 'scout', 'spy', 'miner'], IDS = ['0000000a', '0000000b', '0000000c', '0000000d'];
    const veiled = {
      name: 'Veiled Front', backs: [{ id: 'blue', color: '#1e3a8a' }], pieces: KINDS.map((k) => ({ id: k, kind: 'token', w: 50, back: 'blue', faces: [{ label: k }] })),
      setup: [{ group: KINDS.map((k, i) => ({ piece: k, up: false, at: [200 + 100 * i, 300], id: IDS[i] })), shuffle: true }],
    };
    const T = hostTable({ seed: 61, players: [[BOB, 'Bob']] }), bid = act(T, BOB, { t: 'addBox', box: veiled, cost: 3000 }).id;
    let declared = 0, places = true;
    const kinds = IDS.map(() => new Set());
    for (let n = 0; n < 40; n++) {
      act(T, HOST, { t: 'setup', box: bid });
      IDS.forEach((id, i) => {
        const it = T.state.items[id];
        places &&= !!it && it.x === 200 + 100 * i && it.y === 300 && it.up === false;
        if (tid(it?.t) === KINDS[i]) declared++;
        kinds[i].add(tid(it?.t));
      });
    }
    ok(T.state.boxSrc[bid]?.src === 'upload' && places, "Bob's box, set up 40 times: each asked-for id stays at the place its entry gave it, face down");
    ok(declared < 64 && kinds.every((s) => s.size >= 3), `and names no piece: ${declared} of 160 ids held the piece their entry declared (≈ 40 by chance; 160 before), each id held ${kinds.map((s) => s.size).join(', ')} of the 4 kinds`);
  }

  section('(F) a piece on its spot, off the centre: "off" keeps its address; an "off" out of reach is refused (D197)');
  {
    const T = hostTable({ seed: 62, players: [[BOB, 'Bob']] });
    const set = (setup) => act(T, HOST, { t: 'setup', box: act(T, HOST, { t: 'addBox', box: tide({ id: undefined, name: `Off ${setup.length}${setup.at(-1).off}`, decks: [], setup }) }).id });
    const r = set([{ piece: 'chart', at: 'center', id: 'feed3001' }, { piece: 'buoy', at: 'c3', off: [20, -12], id: 'feed3002' }]);
    const chart = T.state.items.feed3001, buoy = T.state.items.feed3002, c3 = plus([chart.x, chart.y], chessXY(CHART, 'c3'));
    ok(!r.notes.length && buoy?.at === 'feed3001:c3' && centredOn(buoy, 40, 40, plus(c3, [20, -12])), `on c3 by its address, its centre 20 right and 12 up of c3's (${J(buoy && [buoy.x, buoy.y, buoy.at])})`);
    const far = set([{ piece: 'chart', at: 'center' }, { piece: 'buoy', at: 'c3', off: [300, 0] }]);
    ok(/^🚫 Couldn't set up «.*»: "off" \[300,0\] takes the piece out of reach of its spot 'c3'$/.test(far.notes[0] || ''), `out of its spot's reach: refused, said (${far.notes[0]})`);
    ok(/off is only for a piece whose "at" is an address/.test(thrown(() => boxOfDef(tide({ setup: [{ piece: 'buoy', at: [10, 10], off: [1, 1] }] })))), 'with "at" as [x, y]: refused by the box\'s gate');
  }

  section('(F) {board, at} names a board an entry BEFORE it places — checked when the box is read, not at Set up (D198)');
  {
    const why = thrown(() => boxOfDef(tide({ setup: [{ piece: 'buoy', at: { board: 'reef', at: '2,1' } }, { piece: 'reef', at: [100, 1300] }] })));
    ok(/^setup\[0\]\.at: board "reef" is never placed by this setup before this entry/.test(why), `the board listed after the entry set on it: refused, naming the entry (${why})`);
    ok(/is never placed by this setup before this entry/.test(thrown(() => boxOfDef(tide({ setup: [{ piece: 'reef', at: { board: 'reef', at: '2,1' } }] })))), 'a board set on itself: refused');
    ok(!thrown(() => boxOfDef(tide({ setup: [{ piece: 'reef', at: [100, 1300] }, { piece: 'buoy', at: { board: 'reef', at: '2,1' } }] }))), 'listed first: fine');
  }

  section("(F) a saved state's key that names no player is invalid, not a player away (D199, §4j case 11)");
  {
    const T = hostTable({ seed: 63, players: [[BOB, 'Bob']] });
    for (const [what, secret, want] of [
      ['"__proto__"', JSON.parse('{"__proto__": {"text": "x"}}'), ['Some saved game state was invalid and was dropped']],
      ['"mallory"', { mallory: { text: 'x' } }, ['Some saved game state was invalid and was dropped']],
      ['a pid nobody has', { ['f'.repeat(16)]: { text: 'x' } }, ["Some saved state referred to players who weren't seated; it was dropped"]],
      ['"@#3" with two seated', { '@#3': { text: 'x' } }, ["Some saved state referred to players who weren't seated; it was dropped"]],
    ]) {
      const b = act(T, HOST, { t: 'addBox', box: { ...skiff(), name: `Keys ${what}`, rulesState: { data: {}, public: {}, asks: {}, secret } } }).id;
      const r = act(T, HOST, { t: 'setup', box: b, rules: true });
      ok(J(r.enabled?.toasts) === J(want) && !Object.keys(T.state.rules.secret).length, `a secret keyed ${what}: dropped, "${want[0]}" (${J(r.enabled?.toasts)})`);
    }
    const b = act(T, HOST, { t: 'addBox', box: { ...skiff(), name: 'Keys asks', rulesState: { data: {}, public: {}, asks: { mallory: [{ id: 'q', prompt: 'Go?', options: ['yes'] }] }, secret: {} } } }).id;
    ok(J(act(T, HOST, { t: 'setup', box: b, rules: true }).enabled?.toasts) === J(['Some saved game state was invalid and was dropped']), 'asks keyed "mallory": the invalid toast too');
  }

  section('(F) a clear ends the box set up: lastSetup goes — on the host and through a Worker patch, and only there (D200)');
  {
    const T = hostTable({ seed: 64, players: [[BOB, 'Bob']] }), b = act(T, HOST, { t: 'addBox', box: tide() }).id;
    act(T, HOST, { t: 'setup', box: b });
    act(T, HOST, { t: 'clear' });
    ok(T.state.lastSetup === undefined && act(T, HOST, { t: 'reset' }).notes[0] === '🚫 Nothing to reset: no game box was set up', 'cleared: no box set up, nothing to reset');
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'a'), H = R.H, tb = R.add(HOST, tide({ rules: TIDE_RULES })).id;
    R.job(HOST, { t: 'setup', box: tb, rules: true });
    R.job(HOST, { t: 'clear' });
    ok(H.state.lastSetup === undefined && R.same() && H.state.rules.enabled, 'a clear in the Worker: its patch says lastSetup: null, and the host takes it (digests agree)');
    R.job(HOST, { t: 'setup', box: tb });
    const r0 = quietly(() => R.M.job(BOB, { t: 'chat', msg: 'ahoy' })).value, P = structuredClone(r0.patch);
    P.lastSetup = null;
    let threw = '';
    try { quietly(() => H.applyStatePatch(P, structuredClone(r0.out), { p: BOB, a: { t: 'chat', msg: 'ahoy' } })); } catch (e) { threw = e.message; }
    ok(threw === 'the script set the last setup outside a setup' && H.state.lastSetup === tb, `a forged lastSetup: null in Bob's chat: refused (${threw})`);
    // 🎲's demos clear, then start their rules: the chess game exported is chess's, not the box set up before it
    R.job(HOST, { t: 'clear' });
    R.job(HOST, { t: 'setRules', enabled: true, reset: true, code: RULES_TEMPLATES.chess });
    const x = quietly(() => H.exportBox({})).value.box;
    ok(H.state.lastSetup === undefined && x.name !== 'Tidewater' && x.id !== tb && !x.pieces.some((p) => p.id === 'chart'), `the export after 🎲 chess is chess's (${x.name}, ${x.pieces.length} piece types)`);
  }

  section('(F) a second set laid out with clear: false is said again (D201)');
  {
    const T = hostTable({ seed: 65, players: [[BOB, 'Bob']] }), b = act(T, HOST, { t: 'addBox', box: tide({ seats: undefined, setup: [{ piece: 'buoy', at: [400, 400] }] }) }).id;
    const one = act(T, HOST, { t: 'setup', box: b }), two = act(T, HOST, { t: 'setup', box: b, clear: false });
    ok(J(two.lines) === J(['set up «Tidewater» (1 item)']) && one.lines.includes('set up «Tidewater» (1 item)'), `the same line, twice (${J(two.lines)})`);
  }

  section('(F) a forged lastSetup in a loadBox job: only the box it lays out, only with its setup (D202)');
  {
    const L = room(HOST, 'Alice', [[BOB, 'Bob']], 'b'), LH = L.H, other = L.add(HOST, skiff()).id;
    L.job(HOST, { t: 'setRules', enabled: true, reset: true, code: '({ name: "Plain" })' });
    for (const [what, a] of [['set up', { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true }], ['only added', { t: 'loadBox', box: BOXES.backgammon }]]) {
      const r0 = quietly(() => L.M.job(HOST, a)).value, P = structuredClone(r0.patch);
      P.lastSetup = other;
      let threw = '';
      const was = LH.state.lastSetup;
      try { quietly(() => LH.applyStatePatch(P, structuredClone(r0.out), { p: HOST, a })); } catch (e) { threw = e.message; }
      ok(threw === 'the script set the last setup outside a setup' && LH.state.lastSetup === was, `a loadBox (${what}) whose patch points lastSetup at another box: refused (${threw})`);
      L.job(HOST, { t: 'setRules', enabled: true, reset: true, code: '({ name: "Plain" })' });
    }
    L.job(HOST, { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true });
    ok(isBuiltin(LH.state.boxes[LH.state.lastSetup]) && L.same(), 'the honest one: lastSetup is the draughts box it laid out');
  }

  section("(F) errors named as the author wrote the box; isBuiltin's quick no and its memo (D203)");
  {
    const grid = thrown(() => boxOfDef(tide({ pieces: tide().pieces.map((p) => (p.id === 'reef' ? { ...p, grid: { ...p.grid, cols: 99 } } : p)) })));
    ok(/^pieces\[1\] \(«reef»\)\.grid: cols must be 1–64/.test(grid), `a board's grid: "${grid}"`);
    const back = thrown(() => boxOfDef(tide({ backs: [{ id: 'fog', color: 'not a colour' }, { id: 'crate', img: 2 }] })));
    ok(/^backs\[0\] \(«fog»\)/.test(back), `a back: "${back}"`);
    ok(thrown(() => boxOfDef({ name: 'X', pieces: [{ id: 'a', kind: 'die' }, { kind: 'die' }] })) === 'pieces[1]: "id" is required (a text id)', 'a piece without an id: its index');
    const big = { ...cleanBox(json(BOXES.draughts)), name: 'Big', rulesState: { data: { pad: 'x'.repeat(3e6) }, public: {}, asks: {}, secret: {} } };
    let t0 = performance.now();
    for (let k = 0; k < 50; k++) publicBox(big);
    const quick = performance.now() - t0, dr = { ...big, name: 'Draughts' };
    isBuiltin(dr);
    t0 = performance.now();
    for (let k = 0; k < 50; k++) publicBox(dr);
    const memo = performance.now() - t0;
    ok(quick < 25 && memo < 25 && !isBuiltin(dr), `a 3 M-char box: 50 publicBox calls in ${quick.toFixed(1)} ms (its name is no built-in's), ${memo.toFixed(1)} ms named "Draughts" once known`);
  }
}

/** The second fix-up's regressions (G). */
function testFixup2() {
  section('(G) a die and a token under one back in a shuffled group: refused — a die never snaps, so its place would show it (D210)');
  {
    const tiles = (group) => ({
      name: 'Mystery Tiles', backs: [{ id: 'bk', color: '#334455' }],
      pieces: [
        { id: 'board', kind: 'board', w: 400, h: 140, board: { grid: { type: 'square', cols: 3, rows: 1, cell: 100, x: 50, y: 20, labels: 'chess' } } },
        { id: 'gem', kind: 'token', w: 60, shape: 'rect', stack: 'none', back: 'bk', faces: [{ label: 'G' }] },
        { id: 'pebble', kind: 'token', w: 60, shape: 'rect', stack: 'none', back: 'bk', faces: [{ label: 'P' }] },
        { id: 'die', kind: 'die', w: 60, shape: 'rect', back: 'bk', faces: [{ label: '1' }, { label: '2' }] },
      ],
      setup: [{ piece: 'board', at: [100, 100] }, group],
    });
    const mixed = tiles({ shuffle: true, group: [{ piece: 'gem', up: false, at: 'a1' }, { piece: 'die', up: false, at: 'b1' }] });
    const why = thrown(() => boxOfDef(mixed));
    ok(/^setup\[1\]\.group\[1\]: being a die differs from setup\[1\]\.group\[0\], which shares its back — the shuffle would show which is which$/.test(why), `boxOfDef refuses it, naming both entries (${why})`);
    const T = hostTable({ seed: 71, players: [[BOB, 'Bob']] }), r = act(T, BOB, { t: 'addBox', box: mixed, cost: 2000 });
    ok(!r.id && /^🚫 Box rejected: setup\[1\]\.group\[1\]: being a die differs/.test(r.notes[0] || '') && !Object.keys(T.state.boxes).length, `Bob's upload of it: rejected, said (${r.notes[0]})`);
    ok(!thrown(() => boxOfDef(tiles({ group: [{ piece: 'gem', up: false, at: 'a1' }, { piece: 'die', up: false, at: 'b1' }] }))), 'unshuffled, the two may share the back (alike from outside, §2c)');
    // tokens alone: every place keeps its address through the shuffle, whatever was dealt to it
    const b = act(T, HOST, { t: 'addBox', box: tiles({ shuffle: true, group: ['gem', 'pebble', 'gem'].map((k, i) => ({ piece: k, up: false, at: 'abc'[i] + '1', id: `0000c0d${i}` })) }) }).id;
    let kept = true;
    const seen = new Set();
    for (let n = 0; n < 20; n++) {
      act(T, HOST, { t: 'setup', box: b });
      [0, 1, 2].forEach((i) => { const it = T.state.items[`0000c0d${i}`]; kept &&= it?.at?.endsWith(`:${'abc'[i]}1`); seen.add(`${i}${tid(it?.t)}`); });
    }
    ok(kept && seen.size === 6, `tokens alone: 20 shuffles, every place keeps its address (${kept}); each place held both kinds (${seen.size} of 6 place-kind pairs)`);
  }

  section("(G) a refusal the rules made says so (`ruled`) — the engine's own and a storage failure never do (D211)");
  {
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'c'), H = R.H;
    R.job(HOST, { t: 'setRules', enabled: true, reset: true, code: "({ name: 'No boxes', handle(t, a) { if (a.t === 'addBox') return 'no boxes here'; } })" });
    const v = R.job(BOB, { t: 'addBox', box: skiff(), cost: 1500 }), vn = v.fx.filter((e) => e.t === 'note' && e.p === BOB);
    ok(J(vn) === J([{ t: 'note', p: BOB, msg: '🚫 no boxes here', ruled: true }]) && !Object.keys(H.state.boxes).length, `a script's veto of Bob's box, through the Worker: its notice carries ruled (${J(vn)})`);
    R.job(HOST, { t: 'setRules', enabled: false });
    R.job(HOST, { t: 'setRules', enabled: true, reset: true, code: RULES_TEMPLATES.chess });
    const st = R.job(BOB, { t: 'addBox', box: skiff(), cost: 1500 }), sn = st.fx.filter((e) => e.t === 'note' && e.p === BOB);
    ok(J(sn) === J([{ t: 'note', p: BOB, msg: '🚫 Not a move in this game', ruled: true }]), `strict chess refusing it: ruled too (${J(sn)})`);
    R.job(HOST, { t: 'setRules', enabled: false });
    R.job(HOST, { t: 'setRules', enabled: true, reset: true, code: skiff().rules });
    const e = R.job(BOB, { t: 'addBox', box: { name: 'Broken', pieces: [{ id: 'x', kind: 'nope' }] }, cost: 100 }), en = e.fx.filter((x) => x.t === 'note' && x.p === BOB);
    ok(en.length === 1 && /^🚫 Box rejected: /.test(en[0].msg) && !('ruled' in en[0]), `the engine's own gate, rules running: no ruled (${J(en)})`);
    const r0 = quietly(() => R.M.job(BOB, { t: 'chat', msg: 'hi' })).value, out = structuredClone(r0.out);
    out.effects.push({ t: 'note', p: BOB, msg: '🚫 forged', ruled: 'yes' });
    quietly(() => H.applyStatePatch(structuredClone(r0.patch), out, { p: BOB, a: { t: 'chat', msg: 'hi' } }));
    R.M.drain();
    const f = H.drain().find((x) => x.t === 'note' && x.msg === '🚫 forged');
    ok(f && !('ruled' in f), `a Worker's note with ruled: "yes" loses it (only true passes) (${J(f)})`);
  }

  section("(G) after a clear, the box whose rules still run leads the export (D212)");
  {
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'd'), H = R.H, tb = R.add(HOST, tide({ rules: TIDE_RULES })).id;
    R.job(HOST, { t: 'setup', box: tb, rules: true });
    R.job(HOST, { t: 'clear' });
    let x, why = '';
    try { x = quietly(() => H.exportBox({ rules: true, state: true })).value.box; } catch (err) { why = err.message; }
    ok(!why && H.state.lastSetup === undefined && H.state.rules.box === tb && x.name === 'Tidewater' && x.id === tb && x.pieces.some((p) => p.id === 'chart') && x.rules === H.state.rules.code,
      `the table cleared, Tidewater's rules running: the export is Tidewater, its types and rules (${why || J(x && { name: x.name, id: x.id, types: x.pieces.length })})`);
    const T = hostTable({ seed: 72, players: [[BOB, 'Bob']] }), sb = act(T, HOST, { t: 'addBox', box: skiff() }).id;
    act(T, HOST, { t: 'setup', box: sb });
    act(T, HOST, { t: 'clear' });
    ok(thrown(() => T.exportBox({})) === 'types needs at least 1 entry (or the box a deck)', 'no rules running: an empty table still has nothing to export (as before)');
  }
}

/** The third fix-up's regressions (H). */
function testFixup3() {
  section("(H) a box without a layout is set up or reset only with its rules starting — never a table cleared for nothing (D215)");
  {
    const LAY = { name: 'Laid by its rules', pieces: [{ id: 'gem', kind: 'token', w: 50, faces: [{ label: 'G' }] }],
      rules: "({ name: 'Laid by its rules', setup(t) { if (!t.data.laid) { t.data.laid = true; t.layout(t.boxes().find((b) => b.name === 'Laid by its rules').id, [{ piece: 'gem', at: [600, 500] }]); } } })" };
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'e'), H = R.H, lb = R.add(HOST, LAY).id, n = () => Object.keys(H.state.items).length;
    const no = R.job(HOST, { t: 'setup', box: lb });
    ok(J(no.notes) === J(['🚫 «Laid by its rules» has no layout — its rules lay the table out: set it up with them']) && !no.lines.length && H.state.lastSetup === undefined,
      `Set up without its rules (the API, past the page's checks): refused, nothing cleared or marked set up (${J(no.notes)})`);
    R.job(HOST, { t: 'setup', box: lb, rules: true });
    ok(n() === 1 && H.state.rules.enabled && H.state.rules.box === lb && H.state.lastSetup === lb, `with its rules: they lay out one gem (${n()} items)`);
    const again = R.job(HOST, { t: 'reset' });
    ok(n() === 1 && H.state.rules.enabled && again.lines.includes('reset «Laid by its rules»') && R.same(), `Reset while they run: cleared, the rules started afresh lay it out again (${n()} items, ${J(again.lines)})`);
    R.job(HOST, { t: 'setRules', enabled: false });
    const off = R.job(HOST, { t: 'reset' });
    ok(J(off.notes) === J(["🚫 «Laid by its rules» is laid out by its rules, which aren't running: Set up starts them again"]) && !off.lines.length && n() === 1 && H.state.lastSetup === lb,
      `its rules switched off in 📜, then Reset: refused — the gem stays, nothing logged, still the box set up (${J(off.notes)}; before: the table cleared, "reset «…»", nothing laid out)`);
    R.job(HOST, { t: 'setRules', enabled: true, reset: true, code: '({ name: "Other" })' });
    const other = R.job(HOST, { t: 'reset' });
    ok(/^🚫 «Laid by its rules» is laid out by its rules, which aren't running/.test(other.notes[0] || '') && n() === 1 && H.state.rules.name === 'Other',
      `other rules running: Reset refused the same way, in the Worker too (${other.notes[0]})`);
    const T = hostTable({ seed: 81 }), bare = act(T, HOST, { t: 'addBox', box: { name: 'Bare', pieces: [{ id: 'x', kind: 'token', faces: ['X'] }] } }).id;
    act(T, HOST, { t: 'setup', box: act(T, HOST, { t: 'addBox', box: skiff() }).id });
    const k = Object.keys(T.state.items).length, b = act(T, HOST, { t: 'setup', box: bare });
    ok(J(b.notes) === J(['🚫 «Bare» has nothing to set up (no layout, no rules)']) && Object.keys(T.state.items).length === k && k > 0, `a box with neither: refused, Skiff's ${k} items stay (${J(b.notes)})`);
  }

  section('(H) only rules that run lead the export: a Disable keeps rules.box, a later export is not that box (D216)');
  {
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'f'), H = R.H, tb = R.add(HOST, tide({ rules: TIDE_RULES })).id;
    R.job(HOST, { t: 'setup', box: tb, rules: true });
    R.job(HOST, { t: 'setRules', enabled: false });
    R.job(HOST, { t: 'clear' });
    R.job(HOST, { t: 'addDeck', deck: { name: 'Plain', cards: [{ n: 'A' }, { n: 'B' }] } });
    const x = quietly(() => H.exportBox({})).value.box;
    ok(H.state.rules.box === tb && !H.state.rules.enabled && x.name !== 'Tidewater' && x.id !== tb && !x.players && !x.pieces.length && J(x.decks?.map((d) => d.name)) === J(['Plain']),
      `Tidewater's rules off, the table cleared, a plain deck added: the export is just the deck (${J({ name: x.name, id: x.id, players: x.players, types: x.pieces.length, decks: x.decks?.map((d) => d.name) })})`);
    // the box set up, its rules off, its pieces all gone without a clear: no longer its position either
    const one = R.add(HOST, tide({ name: 'Tide One', id: 'feed0009', decks: [], rules: TIDE_RULES, setup: [{ piece: 'buoy', at: [400, 400], id: 'feed9001' }] })).id;
    R.job(HOST, { t: 'setup', box: one, rules: true });
    R.job(HOST, { t: 'setRules', enabled: false });
    R.job(HOST, { t: 'del', id: 'feed9001' });
    R.job(HOST, { t: 'addDeck', deck: { name: 'Plain', cards: [{ n: 'A' }, { n: 'B' }] } });
    const y = quietly(() => H.exportBox({})).value.box;
    ok(H.state.lastSetup === one && !Object.keys(H.state.items).some((id) => id === 'feed9001') && y.name !== 'Tide One' && !y.pieces.length,
      `still the box set up, but its one buoy deleted and its rules off: the export isn't named after it (${y.name}, ${y.pieces.length} types)`);
  }
}

// =============================================================================
// (I) 4B fix-up regressions
// =============================================================================
function testFixup4B() {
  section('(I) a group roll whose onAction takes a rolled die away: one line, from the faces rolled; the rules stay on (D218)');
  {
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'f'), H = R.H, bid = R.add(HOST, squad()).id;
    R.job(HOST, { t: 'setup', box: bid });
    R.job(HOST, { t: 'setRules', enabled: true, code: "({ name: 'Tidy', onAction(t, a) { if (a.t === 'roll') t.remove(a.ids.at(-1)); } })" });
    const q = R.job(BOB, { t: 'group', op: 'roll', ids: [C(11), C(12)] });
    ok(H.state.rules.enabled && !q.error && !H.state.items[C(12)] && R.same(), `the rules still run, the second die removed by the script (${J(q.error)})`);
    ok(q.lines.filter((l) => /^rolled/.test(l)).length === 1 && /^rolled 2 dice: \d · \d$/.test(q.lines.find((l) => /^rolled/.test(l))), `one line, its faces as they were rolled (${J(q.lines)})`);
  }

  section("(I) a built-in box's face-down piles are shuffled wherever it is laid out without its rules: everyone has read its order (D232)");
  {
    const order = (H) => H.state.items[Object.keys(H.state.items).find((id) => H.state.items[id].name === 'Events')].cards.map((c) => c.f);
    const src = J(Array.from({ length: 24 }, (_, f) => f));
    for (const [k, prefix] of [[1, '2'], [2, '3']]) {
      const R = room(HOST, 'Alice', [[BOB, 'Bob']], prefix), H = R.H;
      for (let j = 0; j < k; j++) Math.random(); // (another draw of the crypto RNG each room: the orders differ)
      let q = R.job(HOST, { t: 'loadBox', box: json(BOXES.hexfront), setup: true, clear: true });
      ok(J(order(H)) !== src && /, face-down piles shuffled$/.test(q.lines.find((l) => l.startsWith('set up')) || ''), `room ${k}: loadBox without its rules — the Events pile in another order than templates.js's (${J(order(H).slice(-3))} on top; "${q.lines.find((l) => l.startsWith('set up'))}")`);
      const bid = H.state.lastSetup;
      q = R.job(HOST, { t: 'setup', box: bid });
      ok(J(order(H)) !== src && q.lines.some((l) => /, face-down piles shuffled$/.test(l)), `room ${k}: Set up without its rules — shuffled (${J(q.lines)})`);
      R.job(HOST, { t: 'setup', box: bid, rules: true });
      R.job(HOST, { t: 'setRules', enabled: false });
      q = R.job(HOST, { t: 'reset' });
      ok(J(order(H)) !== src && q.lines.includes('reset «Hexfront»') && !H.state.rules.enabled, `room ${k}: Reset after its rules were switched off — shuffled (${J(order(H).slice(-3))})`);
      q = R.job(HOST, { t: 'setup', box: bid, shuffle: false });
      ok(J(order(H)) === src, "…and the host may still lay it out in the box's own order, asked to (shuffle: false)");
    }
    const D = room(HOST, 'Alice', [[BOB, 'Bob']], '4'), dq = D.job(HOST, { t: 'loadBox', box: json(BOXES.draughts), setup: true, clear: true });
    ok(dq.lines.some((l) => /^set up «Draughts» \(\d+ pieces\)$/.test(l)), `a built-in box without face-down piles says nothing of a shuffle (${J(dq.lines)})`);
  }

  section("(I) Hexfront's turn script guards every way to an event card, not the draw alone: out of turn, and one a turn");
  {
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], '5'), H = R.H;
    R.job(HOST, { t: 'loadBox', box: json(BOXES.hexfront), setup: true, clear: true, rules: true });
    const holder = (side) => Object.keys(H.state.players).find((p) => H.state.players[p].seatId === side), az = holder('azure'), em = holder('ember');
    const ev = Object.keys(H.state.items).find((id) => H.state.items[id].name === 'Events'), n0 = H.state.items[ev].cards.length, nItems = Object.keys(H.state.items).length;
    for (const a of [{ t: 'deal', id: ev, x: 100, y: 100, up: false }, { t: 'peek', id: ev }, { t: 'flip', id: ev }, { t: 'shuffle', id: ev }, { t: 'del', id: ev }]) {
      const q = R.job(em, a);
      ok(q.notes.length === 1 && /^🚫 Only Azure (draws an event|touches the events) this turn$/.test(q.notes[0]), `Ember's ${a.t} of the Events pile out of turn: refused (${J(q.notes)})`);
    }
    ok(H.state.items[ev]?.cards.length === n0 && Object.keys(H.state.items).length === nItems && !H.state.players[em].hand.length && R.same(), 'the pile is whole, nothing dealt, nothing in Ember\'s hand');
    let q = R.job(az, { t: 'deal', id: ev, x: 100, y: 100, up: false });
    const dealt = Object.keys(H.state.items).find((id) => !(id in R.M.state.items) || (H.state.items[id].t?.endsWith('/event') && H.state.items[id].k === 'g'));
    ok(H.state.items[ev].cards.length === n0 - 1 && dealt && H.state.rules.data.drew, `Azure deals the top event out: the turn's event (${J(q.lines)})`);
    q = R.job(em, { t: 'toHand', id: dealt });
    ok(J(q.notes) === J(['🚫 Only Azure touches the events this turn']) && !H.state.players[em].hand.length, `Ember can't take the dealt event into hand (${J(q.notes)})`);
    q = R.job(az, { t: 'draw', id: ev });
    ok(J(q.notes) === J(['🚫 One event a turn']) && R.same(), `a draw after the deal: "One event a turn" (${J(q.notes)})`);
    q = R.job(az, { t: 'toHand', id: dealt });
    ok(!q.notes.length && H.state.players[az].hand.length === 1, 'Azure takes the dealt event into hand');
  }

  section('(I) a patch sends an item that only moved as its new place (pos), anything else whole; folded, it is the snapshot (D233)');
  {
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], '9'), H = R.H, bid = R.add(HOST, squad()).id;
    R.job(HOST, { t: 'setup', box: bid });
    H.takeDirty();
    const V = { items: json(H.snapContent().items), log: [] };
    const fold = (c) => applyViewPatch(V, { ...c, seq: 0 });
    const step = (p, a) => { quietly(() => H.apply(p, a)); H.drain(); const c = H.patchContent(H.takeDirty()); fold(json(c)); return c; };
    let c = step(HOST, { t: 'group', op: 'move', ids: [1, 2, 3].map(C), dx: 100, dy: 0 });
    ok(!c.items && J(Object.keys(c.pos)) === J([1, 2, 3].map(C)) && c.pos[C(1)].length === 5 && typeof c.pos[C(1)][4] === 'string', `a group move: three places, no whole item (${J(c.pos[C(1)])})`);
    c = step(HOST, { t: 'flip', id: C(1) });
    ok(c.items?.[C(1)] && !c.pos, 'a flip: the item whole');
    c = step(HOST, { t: 'move', id: C(8), x: 2200, y: 1700 });
    ok(c.pos?.[C(8)]?.length === 4, `a move off the board: its place, no address (${J(c.pos)})`);
    H.refreshFor(BOB, { t: 'move', id: C(9) });
    H.drain();
    c = H.patchContent(H.takeDirty());
    fold(json(c));
    ok(c.items?.[C(9)] && !c.pos, 'a refusal\'s re-send of an unchanged item: whole');
    ok(canon(V.items) === canon(json(H.snapContent().items)), 'the patches folded give the snapshot');
    const forged = { items: { ...V.items }, log: [] }, err = quietly(() => applyViewPatch(forged, { pos: { zz000001: [1, 2, 0, 3] }, seq: 1 })).error;
    ok(err.length === 1 && canon(forged.items) === canon(V.items), `a place for an item the view lacks: dropped, loudly (${J(err)})`);
  }

  section("(I) a group with the rules on: its price and its watchdog budget grow with t.data; members refused or with no hook after them pass over it once (D234)");
  {
    const BIG = "({ name: 'Big', setup(t) { t.data.big = Array.from({ length: 125000 }, (_, k) => 1000000 + k); }, validate() {} })";
    let n = 0;
    const clock = { t: 1.7e12 }, T = quietly(() => createTable({}, { pid: HOST, now: () => clock.t, uid: () => `b${(++n).toString(16).padStart(7, '0')}` })).value;
    T.open('Alice');
    const g5 = { t: 'group', op: 'move', ids: [1, 2, 3, 4, 5].map(C), dx: 100, dy: 0 }, g200 = { t: 'group', op: 'move', ids: Array.from({ length: 200 }, (_, k) => C(k)) };
    const drain = () => { let k = 0; while (T.mayAct(EVE, { t: 'move' })) k++; return k; }; // (the clock stands still: no token comes back meanwhile)
    ok(T.mayAct(EVE, g5) && drain() === 39, 'the rules off: a group of 5 costs 1 token');
    quietly(() => T.apply(HOST, { t: 'setRules', enabled: true, code: BIG }));
    const chars = T.rulesChars();
    ok(T.state.rules.enabled && chars > 900e3 && chars < 1.1e6, `the rules on, t.data is ${chars} characters (rulesChars)`);
    clock.t += 2000; // (the burst back: 40 tokens)
    const w = Math.ceil(chars / 100e3), left = T.mayAct(EVE, g5) && drain();
    ok(w >= 10 && left === 40 - w, `a group of 5 costs ${40 - left} tokens at ${chars} characters of t.data: (1 + ⌊5/20⌋) × ⌈chars / 100,000⌉`);
    clock.t += 2000;
    ok(T.mayAct(EVE, g200) && drain() === 0, 'a group of 200: it can always be sent from a full burst, and takes all of it (D241: and more — section J)');
    ok(appBudget()(g5) === 4050, 'with no rules state, the budget is 4000 + 10 ms a member');
    const src = /^function budget\(a\) \{\n[\s\S]*?\n\}$/m.exec(fs.readFileSync(path.join(APP_ROOT, 'cardtable/app.js'), 'utf8'))[0];
    const budget = new Function('RULES_TIMEOUT_MS', 'groupIds', 'own', 'countSetup', 'T', `${src}\nreturn budget;`)(4000, groupIds, own, () => 0, T);
    ok(budget(g200) === Math.round(4000 + 200 * (10 + 20 * chars / 1e6)), `with ${chars} characters of t.data, a group of 200's budget is ${budget(g200)} ms: 20 ms more a member for each MB`);
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'a'), H = R.H, bid = R.add(HOST, squad()).id;
    R.job(HOST, { t: 'setup', box: bid });
    R.job(HOST, { t: 'setRules', enabled: true, code: BIG });
    const t0 = performance.now(), q = R.job(BOB, { t: 'group', op: 'move', ids: [1, 2, 3, 4, 5, 6, 7].map(C), dx: 0, dy: 100 }), ms = performance.now() - t0;
    ok(q.lines.includes('moved 6 items') && H.state.rules.enabled && R.same(), `Bob's group of 7 at 1 MB (one locked): ${ms.toFixed(0)} ms, the rules on (${J(q.lines)})`);
  }
}

// =============================================================================
// (J) 4B fix-up 2 regressions
// =============================================================================
function testFixup4B2() {
  section("(J) a group whose members leave t.data's JSON as the job found it, a function added: refused, as a single action's is (D129, D241)");
  {
    // member 1's validate sets x to 1; member 2's sets it back (and n), and hides a function in t.data: its JSON ends the job as it began
    const SNEAK = "({ name: 'Sneak', setup(t) { t.data.x = 0; t.data.n = 0; }, validate(t, a) { if (a.t !== 'move') return; t.data.n++; if (t.data.n === 1) t.data.x = 1; else { t.data.x = 0; t.data.n = 0; t.data.fn = function () { return 1; }; } } })";
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'j'), H = R.H, bid = R.add(HOST, squad()).id;
    R.job(HOST, { t: 'setup', box: bid });
    R.job(HOST, { t: 'setRules', enabled: true, code: SNEAK });
    const M = R.M, q = R.job(BOB, { t: 'group', op: 'move', ids: [C(1), C(2)], dx: 0, dy: 100 });
    ok(!H.state.rules.enabled && q.error?.message === 't.data.fn is a function, not JSON', `the rules go off, saying so: ${J(q.error)}`);
    ok(!('fn' in M.state.rules.data) && !('fn' in H.state.rules.data) && H.state.items[C(1)].y === M.state.items[C(1)].y, 'nothing of the job is left in the Worker or on the host (it failed closed)');
  }

  section('(J) a ruled group is priced past the burst: it overdraws the bucket, and its sender waits the rest out (D241)');
  {
    const BIG = "({ name: 'Big', setup(t) { t.data.big = Array.from({ length: 125000 }, (_, k) => 1000000 + k); }, validate() {} })";
    let n = 0;
    const clock = { t: 1.7e12 }, T = quietly(() => createTable({}, { pid: HOST, now: () => clock.t, uid: () => `b${(++n).toString(16).padStart(7, '0')}` })).value;
    T.open('Alice');
    quietly(() => T.apply(HOST, { t: 'setRules', enabled: true, code: BIG }));
    const g200 = { t: 'group', op: 'move', ids: Array.from({ length: 200 }, (_, k) => C(k)) }, price = floodCost(g200) * Math.ceil(T.rulesChars() / 100e3);
    ok(price > 100 && T.mayAct(EVE, g200), `a group of 200 at ${T.rulesChars()} characters costs ${price} tokens, and goes from a full burst of 40`);
    ok(!T.mayAct(EVE, g200) && !T.mayAct(EVE, { t: 'move' }), 'then nothing more goes');
    clock.t += ((price - 40) / 20) * 1000 - 100; // (just short of paying it back: 20 tokens a second)
    ok(!T.mayAct(EVE, { t: 'move' }), `${((price - 40) / 20).toFixed(1)} s later, less 0.1 s: still nothing`);
    clock.t += 300;
    const back = [1, 2, 3, 4, 5].filter(() => T.mayAct(EVE, { t: 'move' })).length;
    ok(back === 4, `0.2 s past it: the 4 tokens it has back, and no more (${back})`);
    clock.t += 2000;
    ok(T.mayAct(EVE, g200), 'a burst later, the group goes again');
  }

  section("(J) a guest's sustained flood of ruled groups buys no more of the Worker's time than one of single moves (D241: I5)");
  {
    const BIG = "({ name: 'Big', setup(t) { t.data.big = Array.from({ length: 250000 }, (_, k) => 1000000 + k); }, validate() {} })";
    const R = room(HOST, 'Alice', [[BOB, 'Bob']], 'k'), H = R.H;
    R.job(HOST, { t: 'loadBox', box: { name: 'Many', imgs: [], table: { shape: 'rect', w: 4000, h: 3000 }, types: { tok: { kind: 'token', name: 'Unit', shape: 'rect', w: 40, faces: [{ label: 'U' }] } }, setup: Array.from({ length: 10 }, (_, r) => ({ piece: 'tok', count: 20, spread: [60, 0], at: [300, 300 + 80 * r] })) }, setup: true, clear: true });
    R.job(HOST, { t: 'setRules', enabled: true, code: BIG });
    const ids = Object.keys(H.state.items).filter((id) => H.state.items[id].t?.endsWith('/tok')).slice(0, 200), chars = H.rulesChars();
    const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
    const single = Math.min(...[0, 1, 2].map((k) => time(() => R.job(BOB, { t: 'move', id: ids[k], x: 900 + 50 * k, y: 2500 }))));
    const grp = time(() => R.job(BOB, { t: 'group', op: 'move', ids, dx: 0, dy: 40 }));
    const price = floodCost({ t: 'group', ids }) * Math.ceil(chars / 100e3), groups = (20 / price) * grp / 1000, singles = 20 * single / 1000;
    ok(H.state.rules.enabled && ids.length === 200 && R.same(), `t.data ${(chars / 1e6).toFixed(2)} MB: a single move ${single.toFixed(1)} ms, a group of 200 ${grp.toFixed(0)} ms (${price} tokens)`);
    ok(groups <= singles, `a flood of groups buys ${groups.toFixed(2)} s of the Worker a second, one of single moves ${singles.toFixed(2)} s (was ${(0.5 * grp / 1000).toFixed(2)} s with the price capped at the burst)`);
  }

  section('(J) a fresh id is never digits alone: an object lists such a key first, out of the order it was added (D244)');
  {
    const ids = Array.from({ length: 100000 }, () => core.uid());
    ok(ids.every((id) => /^[0-9a-f]{8}$/.test(id) && !/^\d+$/.test(id)), 'uid(): 100,000 ids, each 8 hex digits, none all digits');
    const T = quietly(() => createTable({}, { pid: HOST })).value, names = Array.from({ length: 12 }, (_, k) => `Box ${k}`); // (core's own uid)
    T.open('Alice');
    for (const name of names) quietly(() => T.apply(HOST, { t: 'addBox', box: { name, imgs: [], pieces: [{ id: 'tok', kind: 'token', faces: [{ label: 'T' }] }] } }));
    ok(J(Object.values(T.state.boxes).map((b) => b.name)) === J(names), `the catalog lists its 12 boxes in the order they were added (${J(Object.keys(T.state.boxes))})`);
  }
}

(async () => {
  await guard('(1) format', testFormat);
  await guard('(2) setup', testSetup);
  await guard('(3) group', testGroup);
  await guard('(Hx) Hexfront', testHexfront);
  await guard('(4) round trip', testRoundTrip);
  await guard('(4) resume elsewhere', testResumeElsewhere);
  await guard('(5)(6) dedup, migrate', testDedupMigrate);
  await guard('(7) seeding', testSeed);
  await guard('(8) addBox', testAddBox);
  await guard('(8) ingestBox', testIngest);
  await guard('(9) Worker path', testWorkerPath);
  await guard('(10) facade', testFacade);
  await guard("(1′) format", indepFormat);
  await guard("(1′) rulesState's gates", indepGates);
  await guard("(2′) setup", indepSetup);
  await guard("(4′) round trip", indepRoundTrip);
  await guard("(5′) dedup", indepDedup);
  await guard("(6′) MIGRATE[4], reset after a reload", indepMigrate);
  await guard("(W′) Worker contract", indepWorker);
  await guard("(3′) group", indepGroup);
  await guard('(F) fix-up regressions', testFixup);
  await guard('(G) fix-up 2 regressions', testFixup2);
  await guard('(H) fix-up 3 regressions', testFixup3);
  await guard('(I) 4B fix-up regressions', testFixup4B);
  await guard('(J) 4B fix-up 2 regressions', testFixup4B2);
  report();
})().catch(crash);
