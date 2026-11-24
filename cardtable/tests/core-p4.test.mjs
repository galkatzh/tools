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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { APP_ROOT, core, store, FIXTURES, ok, section, report, crash, guard, json, canon, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

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
  ok(/^🚫 Box rejected: types\.x: kind must be one of/.test(r.notes[0] || ''), `"${r.notes[0]}"`);

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
  report();
})().catch(crash);
