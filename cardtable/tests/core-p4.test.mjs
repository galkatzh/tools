// Phase 4A (game boxes) in plain Node (spec §4l, core-p4.test.mjs), on the
// state core as app.js runs it: a host table, and — while rules run — a
// Worker-like mirror whose every job's patch the host checks and takes
// (room()). The sections follow §4l's list (item 3, `group`, is Phase 4B's):
//  (1) cleanBox over the game.json authoring format (boxOfDef): the board
//      structure on the piece, the img shorthand, backs' defaults, decks,
//      rules and rulesState (shape and caps), h from w, "at": "seat", src
//      and by dropped; checkTransportBox; PublicBox; the grammar's refusals.
//  (2) The setup interpreter: every entry kind, forEachSeat over named and
//      automatic seats, "#k" (owners and hands), a "#k" past the seated
//      players failing before any op, {board, at} and address strings, the
//      item caps, a missing deck, ids reused or re-minted (remap), the
//      shuffle of face-down decks and piles; setup and reset as actions.
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
// and the Worker contract of §4f.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { APP_ROOT, core, store, FIXTURES, ok, section, report, crash, guard, json, canon, rng, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

const templates = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));
const { BOXES, RULES_TEMPLATES } = templates;
const {
  createTable, cleanBox, boxOfDef, checkTransportBox, publicBox, isBuiltin, scriptHooks, MIGRATE, migrate, STATE_V, PROTO, RULES,
  MAX_SETUP_ITEMS, GUEST_DECK_CHARS, MAX_BOX_CHARS, HOST_ACTIONS, PUBLIC_ACTIONS, RULED_ACTIONS, CATALOG_ID_RE,
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
  ok(STATE_V === 5 && PROTO === 5 && m.v === 5 && m.lastSetup === 'abcd0001' && !('box' in m.rules) && canon(migrate(json(v4))) === canon(m), `v ${m.v}, lastSetup kept, no rules.box; migrate() ends there`);

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
  ok(U.state.v === 5 && U.state.lastSetup === bid && !('box' in U.state.rules) && U.state.rules.enabled && U.state.rules.data.tides === 1, 'resumed at v5: lastSetup, the rules running on their state, no rules.box');
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

(async () => {
  await guard('(1) format', testFormat);
  await guard('(2) setup', testSetup);
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
  await guard('(F) fix-up regressions', testFixup);
  await guard('(G) fix-up 2 regressions', testFixup2);
  report();
})().catch(crash);
