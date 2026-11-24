// Phase 3A (space) in plain Node (spec §3l, core-p3.test.mjs), checked
// against the spec rather than against the core itself: every expectation
// comes from a small reference model written here from §2a's grid formulas
// and §3a's rules (refSpot, refBoards, refSnap, refZones), never from grid.js.
//  (1) grid.js: parse and format round trips (every label system, the cell
//      extremes), cell centres = §2a's formulas, snapping inside and outside
//      reach (square cells, square points, pointy and flat hexes 20 × 14 with
//      every centre → pixel → axial round trip, spaces first), boards turned
//      by 90, 180 and 270°, neighbors (4, 8, 6; corners, edges, interior; a
//      space's links), distance (chebyshev, manhattan, hex), line (ranks,
//      files, diagonals, unaligned → null, hex lines), point-in-polygon at
//      zone edges, linked (undirected).
//  (5) Aggregation of Rules log lines (runs of ≥ 4 of one op in one action,
//      the first 8 addresses or labels; B16).
//  (6) MIGRATE[3]: secret / asks / hints, the _timers gate, `at` by
//      containment with nothing moved, v 4; the load-time gates.
//  (8) Addresses: the primary board (zones-only racks never, even marked
//      primary), display forms (bare, map:c3, tray#1:bar / tray#2:bar,
//      chess#2:e4; zones too), bare resolution, ambiguity, renumbering, two
//      boxes sharing a board type id (D107).
//  (9) Board moves, turns, deletion and table resizes: nothing else moves;
//      at, byAt and byZone follow by containment — and the very next read of
//      an address (a hook's a.from, a log line, t.item) sees it (D106).
// (10) Action preparation: a.to / a.from / a.pick before the hooks, the
//      prospective piece of take, split and play, pull's member, the veto.
//  (F) The 3A facade rows of §3e (components from code, spatial helpers):
//      TypeErrors, false on a vanished item, logs, newBox dedup.
//  (S) Every snapping caller of §3a; free: true; only pieces snap; the
//      topmost board under a piece, an explicit address under another (D105);
//      turned boards; cleanBox's rotStep 90 on structured boards; setups (the
//      built-in boxes, a shuffled group); the fan (§3g, pieces.js fanOffsets).
//  (D) The drag action in core (§3c): no state, one live fx, the gates, a
//      group's resulting positions on the table; liveFx.
//  (B17) A 361-stone go board's snapshot ≤ 70 KB.
// Every random sequence is seeded and every failure names its seed.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { APP_ROOT, core, ok, section, report, crash, guard, rng, json, env, HOST, BOB, CAROL } from './node-lib.mjs';

const grid = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/grid.js')));
const pieces = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/pieces.js')));
const { BOXES } = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));
const { createTable, cleanBox, MIGRATE, migrate, STATE_V, PROTO, BOARD_Z0, PUBLIC_ACTIONS, RULED_ACTIONS, liveFx, clampToTable, sharedText } = core;

// --- small tools ----------------------------------------------------------------
const range = (n) => Array.from({ length: n }, (_, k) => k);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fix = (v) => Math.round(v * 1e6) / 1e6; // (quarter turns in floating point leave 1e-13 crumbs)
const J = (v) => JSON.stringify(v);
/** Runs fn with console.warn / console.error collected, not printed: {value, warn, error}. */
function quietly(fn) {
  const got = { warn: [], error: [] }, keep = [console.warn, console.error];
  console.warn = (...a) => got.warn.push(a.map(String).join(' '));
  console.error = (...a) => got.error.push(a.map(String).join(' '));
  try { got.value = fn(); } finally { [console.warn, console.error] = keep; }
  return got;
}
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

// =============================================================================
// The reference model: §2a's geometry and §3a's snapping, written from the spec
// =============================================================================
const GO = 'ABCDEFGHJKLMNOPQRSTUVWXYZ', CHESS = 'abcdefghijklmnopqrstuvwxyz';
/** §2a: the centre of cell (or point) (c, r), board-local. */
function specCenter(g, c, r) {
  if (g.type === 'hex') {
    const R = g.cell / Math.sqrt(3);
    return g.hex === 'flat'
      ? { x: g.x + R + c * 1.5 * R, y: g.y + g.cell * (r + 0.5 * (c & 1)) + g.cell / 2 }
      : { x: g.x + g.cell * (c + 0.5 * (r & 1)) + g.cell / 2, y: g.y + R + r * 1.5 * R };
  }
  return g.snap === 'point' ? { x: g.x + c * g.cell, y: g.y + r * g.cell } : { x: g.x + (c + 0.5) * g.cell, y: g.y + (r + 0.5) * g.cell };
}
/** §2a: axial {q, r} of offset (c, r), and back. */
const specAxial = (g, c, r) => (g.hex === 'flat' ? { q: c, r: r - (c - (c & 1)) / 2 } : { q: c - (r - (r & 1)) / 2, r });
const specOffset = (g, q, r) => (g.hex === 'flat' ? { c: q, r: r + (q - (q & 1)) / 2 } : { c: q + (r - (r & 1)) / 2, r });
const labelsOf = (g) => g.labels || (g.type === 'hex' ? 'axial' : 'xy');
/** §2a's address table: cell (c, r) of grid g as an address. */
function specAddr(g, c, r) {
  const L = labelsOf(g);
  if (L === 'chess') return CHESS[c] + (g.rows - r);
  if (L === 'go') return GO[c] + (g.rows - r);
  if (L === 'axial') { const a = specAxial(g, c, r); return `${a.q},${a.r}`; }
  return `${c},${r}`;
}
const inBounds = (g, c, r) => c >= 0 && r >= 0 && c < g.cols && r < g.rows;
/** §2a's address grammar, read: {c, r} or null. */
function specParse(g, s) {
  const L = labelsOf(g);
  let m, c, r;
  if (L === 'chess' || L === 'go') {
    if (!(m = /^([a-z])(\d+)$/i.exec(s))) return null;
    c = (L === 'go' ? GO : CHESS).indexOf(L === 'go' ? m[1].toUpperCase() : m[1].toLowerCase());
    r = g.rows - Number(m[2]);
  } else if (!(m = /^(-?\d+),(-?\d+)$/.exec(s))) return null;
  else if (L === 'axial') ({ c, r } = specOffset(g, +m[1], +m[2]));
  else [c, r] = [+m[1], +m[2]];
  return c >= 0 && inBounds(g, c, r) ? { c, r } : null;
}
/** A point turned by `deg` (clockwise on screen, y down, as CSS rotate()). */
function turnPt(x, y, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [fix(x * c - y * s), fix(x * s + y * c)];
}
/** Board b {x, y, w, h, rot}: local → table and table → local, about its centre. */
function L2T(b, lx, ly) { const [dx, dy] = turnPt(lx - b.w / 2, ly - b.h / 2, b.rot); return { x: fix(b.x + b.w / 2 + dx), y: fix(b.y + b.h / 2 + dy) }; }
function T2L(b, px, py) { const [dx, dy] = turnPt(px - b.x - b.w / 2, py - b.y - b.h / 2, -b.rot); return { x: fix(dx + b.w / 2), y: fix(dy + b.h / 2) }; }
/** Point-in-polygon with its edges and corners inside (written apart from grid.js). */
function refPip(poly, x, y) {
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % n];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax), len = Math.hypot(bx - ax, by - ay);
    if (Math.abs(cross) <= 1e-9 * (len + 1) && x >= Math.min(ax, bx) - 1e-9 && x <= Math.max(ax, bx) + 1e-9 && y >= Math.min(ay, by) - 1e-9 && y <= Math.max(ay, by) + 1e-9) return true;
  }
  let wn = 0; // winding number (any non-zero is inside)
  for (let k = 0; k < n; k++) {
    const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % n], side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && side > 0) wn++;
    else if (ay > y && by <= y && side < 0) wn--;
  }
  return wn !== 0;
}
/** §3a, Snapping, steps 3–4 on structure B at board-local (x, y): the
 *  nearest space with dist ≤ r (D104: 0 inside a space's w × h rectangle;
 *  between two holding the point, the nearer centre), else the grid's spot —
 *  a square cell holding it, the nearest square point within cell/2, the
 *  nearest hex centre within R (by brute force over every cell). {local, x,
 *  y, c?, r?} or null. */
function refSpot(B, x, y) {
  let best = null, bd = Infinity, bc = Infinity;
  for (const sp of B.spaces || []) {
    const c = Math.hypot(sp.x - x, sp.y - y), inRect = sp.w !== undefined && sp.h !== undefined && Math.abs(x - sp.x) <= sp.w / 2 && Math.abs(y - sp.y) <= sp.h / 2;
    const d = inRect ? 0 : c;
    if (d <= sp.r && (d < bd || (d === bd && c < bc))) [best, bd, bc] = [sp, d, c];
  }
  if (best) return { local: best.id, x: best.x, y: best.y };
  const g = B.grid;
  if (!g) return null;
  let c, r;
  if (g.type === 'hex') {
    let bdist = Infinity;
    for (const cc of range(g.cols)) for (const rr of range(g.rows)) {
      const p = specCenter(g, cc, rr), d = Math.hypot(p.x - x, p.y - y);
      if (d < bdist) [bdist, c, r] = [d, cc, rr];
    }
    if (bdist > g.cell / Math.sqrt(3) + 1e-9) return null;
  } else if (g.snap === 'point') {
    [c, r] = [Math.round((x - g.x) / g.cell), Math.round((y - g.y) / g.cell)];
    if (!inBounds(g, c, r)) return null;
    const p = specCenter(g, c, r);
    if (Math.hypot(p.x - x, p.y - y) > g.cell / 2 + 1e-9) return null;
  } else {
    [c, r] = [Math.floor((x - g.x) / g.cell), Math.floor((y - g.y) / g.cell)];
    if (!inBounds(g, c, r)) return null;
  }
  const p = specCenter(g, c, r);
  return { local: specAddr(g, c, r), x: p.x, y: p.y, c, r };
}
/** The board-local centre of local address `s` on B (a space id or a grid address), or null. */
function refLocalSpot(B, s) {
  const sp = (B.spaces || []).find((x) => x.id === s);
  if (sp) return { x: sp.x, y: sp.y, local: sp.id };
  const cr = B.grid && specParse(B.grid, s);
  return cr ? { ...specCenter(B.grid, cr.c, cr.r), local: specAddr(B.grid, cr.c, cr.r) } : null;
}
/** The type item `it` names (host or test boxes). */
const typeIn = (boxes, ref) => { const k = ref.indexOf('/'); return boxes[ref.slice(0, k)]?.types[ref.slice(k + 1)]; };
/** §3a: the table's structured boards from a host item map, oldest first
 *  (by z: BOARD_Z0 + boardSeq), its primary board (primary: true, else the
 *  oldest with a grid, else with spaces; zones-only never) and every board's
 *  display prefix (typeId, or typeId#n when several of that type lie there). */
function refBoards(items, boxes) {
  const list = [];
  for (const [id, it] of Object.entries(items)) {
    if (it.k !== 'g' || !(it.z < 0) || it.up === false) continue;
    const ty = typeIn(boxes, it.t), B = ty?.kind === 'board' && ty.board;
    if (B && (B.grid || B.spaces?.length || B.zones?.length)) list.push({ id, x: it.x, y: it.y, w: ty.w, h: ty.h, rot: it.rot || 0, z: it.z, typeId: it.t.slice(it.t.indexOf('/') + 1), B });
  }
  list.sort((a, b) => a.z - b.z);
  const spots = list.filter((b) => b.B.grid || b.B.spaces?.length);
  const primary = (spots.find((b) => b.B.primary) || spots.find((b) => b.B.grid) || spots[0])?.id ?? null;
  const prefix = new Map(), n = new Map();
  for (const b of list) {
    const all = list.filter((x) => x.typeId === b.typeId).length;
    n.set(b.typeId, (n.get(b.typeId) || 0) + 1);
    prefix.set(b.id, all > 1 ? `${b.typeId}#${n.get(b.typeId)}` : b.typeId);
  }
  return { list, primary, prefix, byId: new Map(list.map((b) => [b.id, b])) };
}
/** The display form of qualified address `q` (§3a). */
function refDisplay(RB, q) {
  const k = q.indexOf(':'), id = q.slice(0, k);
  return id === RB.primary ? q.slice(k + 1) : `${RB.prefix.get(id)}:${q.slice(k + 1)}`;
}
const onRect = (b, px, py) => { const l = T2L(b, px, py); return l.x >= 0 && l.y >= 0 && l.x <= b.w && l.y <= b.h; };
/** §3a, Snapping, steps 1–5 for a centre (cx, cy): the topmost structured
 *  board under it, the spot in reach there: {b, local, at (qualified), x, y
 *  (the spot's centre on the table)} or null. */
function refSnap(RB, cx, cy) {
  const b = RB.list.filter((x) => onRect(x, cx, cy)).at(-1);
  if (!b) return null;
  const l = T2L(b, cx, cy), s = refSpot(b.B, l.x, l.y);
  if (!s) return null;
  const p = L2T(b, s.x, s.y);
  return { b, local: s.local, at: `${b.id}:${s.local}`, x: p.x, y: p.y };
}
/** The qualified zones holding table point (cx, cy): the topmost board's under it. */
function refZones(RB, cx, cy) {
  const b = RB.list.filter((x) => onRect(x, cx, cy)).at(-1);
  if (!b?.B.zones) return [];
  const l = T2L(b, cx, cy);
  return b.B.zones.filter((z) => refPip(z.poly, l.x, l.y)).map((z) => `${b.id}:${z.id}`);
}
/** Where address `addr` (a board's item id and a local address) is on the table: {x, y}. */
function refAt(T, boardId, local) {
  const RB = refBoards(T.state.items, T.state.boxes), b = RB.byId.get(boardId), s = refLocalSpot(b.B, local);
  return L2T(b, s.x, s.y);
}
/** A piece-like item's size: its type's w × h (its back's, the same size by §2a, when hidden). */
const sizeIn = (T, it) => { const ty = typeIn(T.state.boxes, it.t); return { w: ty.w, h: ty.h }; };
/** Whether host item `it` is a piece that snaps (a piece, neither a board nor — D112 — a die). */
const snapper = (T, it) => it.k === 'g' && !(it.z < 0) && !['board', 'die'].includes(typeIn(T.state.boxes, it.t)?.kind);

/** Checks every piece's `at`, T.byAt and T.byZone against §3a's containment
 *  rule (the reference model): [] when all agree, else what differs. Reads
 *  the indexes first: D106 recomputes the addresses lazily, at the next read
 *  of an address or an index (and every broadcast tick and save). */
function containmentProblems(T) {
  const byAt = T.byAt, byZone = T.byZone; // (read first: D106, the next read of an index re-reads every address)
  const RB = refBoards(T.state.items, T.state.boxes), bad = [], wantAt = new Map(), wantZone = new Map();
  const add = (m, k, id) => (m.get(k) || m.set(k, new Set()).get(k)).add(id);
  for (const [id, it] of Object.entries(T.state.items)) {
    if (!snapper(T, it)) {
      if (it.at !== undefined) bad.push(`${id} (${it.k}${it.z < 0 ? ', a board' : ''}) has at ${it.at}`);
      continue;
    }
    const { w, h } = sizeIn(T, it), s = refSnap(RB, it.x + w / 2, it.y + h / 2);
    if ((it.at ?? null) !== (s?.at ?? null)) bad.push(`${id}: at ${it.at}, containment gives ${s?.at}`);
    if (s) add(wantAt, s.at, id);
    for (const z of refZones(RB, it.x + w / 2, it.y + h / 2)) add(wantZone, z, id);
  }
  const mapDiff = (name, got, want) => {
    const keys = new Set([...got.keys(), ...want.keys()]);
    for (const k of keys) if (!isDeepStrictEqual([...(got.get(k) || [])].sort(), [...(want.get(k) || [])].sort())) bad.push(`${name}[${k}]: ${J([...(got.get(k) || [])])}, want ${J([...(want.get(k) || [])])}`);
  };
  mapDiff('byAt', byAt, wantAt);
  mapDiff('byZone', byZone, wantZone);
  return bad.slice(0, 6);
}

// =============================================================================
// The test box, items and tables
// =============================================================================
const BX = 'bx000001', DK = 'dk000001';
const SPACE_BOX = {
  name: 'Space test', imgs: [],
  backs: { hb: { face: { color: '#333333' } } },
  types: {
    chess: { kind: 'board', name: 'Chess board', w: 840, board: { grid: { type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, labels: 'chess' } } },
    map: { kind: 'board', name: 'Map', w: 520, board: { grid: { type: 'square', cols: 10, rows: 10, cell: 50, x: 10, y: 10, labels: 'chess' } } },
    pmap: { kind: 'board', name: 'Primary map', w: 520, board: { primary: true, grid: { type: 'square', cols: 10, rows: 10, cell: 50, x: 10, y: 10, labels: 'chess' } } },
    // not square, its grid off-centre: a turn about anything but its centre shows
    wide: { kind: 'board', name: 'Wide', w: 700, h: 500, board: { grid: { type: 'square', cols: 6, rows: 4, cell: 100, x: 30, y: 40, labels: 'xy' } } },
    rack: {
      kind: 'board', name: 'Rack', w: 400, h: 120,
      board: { zones: [{ id: 'left', poly: [[0, 0], [200, 0], [200, 120], [0, 120]] }, { id: 'right', poly: [[200, 0], [400, 0], [400, 120], [200, 120]] }] },
    },
    tray: { kind: 'board', name: 'Tray', w: 300, h: 200, board: { spaces: [{ id: 'bar', x: 150, y: 100, r: 60 }, { id: 'well', x: 40, y: 100, r: 30 }], links: [['bar', 'well']] } },
    dock: {
      kind: 'board', name: 'Dock', w: 300, h: 200,
      board: { spaces: [{ id: 'quay', x: 80, y: 100, r: 50 }, { id: 'pier', x: 220, y: 100, r: 50 }, { id: 'buoy', x: 150, y: 30, r: 20 }], links: [['quay', 'pier'], ['pier', 'quay'], ['buoy', 'pier']] },
    },
    goban: { kind: 'board', name: 'Go board', w: 1200, board: { grid: { type: 'square', cols: 19, rows: 19, cell: 60, x: 60, y: 60, snap: 'point', labels: 'go', draw: 'lines', marks: ['D4', 'K10', 'Q16'] } } },
    hexp: { kind: 'board', name: 'Pointy hexes', w: 1260, h: 780, board: { grid: { type: 'hex', hex: 'pointy', cols: 20, rows: 14, cell: 60, x: 10, y: 10 } } },
    plain: { kind: 'board', name: 'Plain board', w: 300 },
    // zones only, yet marked primary: zones-only boards never count
    pzone: { kind: 'board', name: 'Mat', w: 400, h: 200, board: { primary: true, zones: [{ id: 'home', poly: [[0, 0], [400, 0], [400, 200], [0, 200]] }] } },
    // a grid and zones on one board
    field: { kind: 'board', name: 'Field', w: 420, board: { grid: { type: 'square', cols: 4, rows: 4, cell: 100, x: 10, y: 10, labels: 'chess' }, zones: [{ id: 'north', poly: [[0, 0], [420, 0], [420, 210], [0, 210]] }] } },
    man: { kind: 'token', name: 'Man', w: 80, stack: 'none', faces: [{ color: '#eeeeee' }] },
    big: { kind: 'token', name: 'Big', w: 180, stack: 'none', faces: [{ color: '#aa0000' }] },
    gem: { kind: 'token', name: 'Gem', faces: ['A', 'B', 'C'] },
    spy: { kind: 'token', name: 'Spy', w: 70, stack: 'none', back: 'hb', faces: ['S1', 'S2'] },
    tile: { kind: 'tile', name: 'Tile', faces: ['T1', 'T2'] },
    die: { kind: 'die', name: 'Die' },
    stone: { kind: 'token', name: 'Stone', w: 56, stack: 'none', faces: [{ color: '#111111' }, { color: '#f5f5f5' }] },
  },
};
const ref = (t) => `${BX}/${t}`;
let zc = 0, bz = 0;
/** Item makers (host shapes): a board (in the boards' band, oldest first), a piece, a supply, a bag, a card, a pile. */
const BRD = (t, x, y, o = {}) => ({ k: 'g', t: ref(t), f: 0, x, y, rot: 0, z: BOARD_Z0 + ++bz, ...o });
const PC = (t, x, y, o = {}) => ({ k: 'g', t: ref(t), f: 0, x, y, rot: 0, z: ++zc, ...o });
const SUP = (t, x, y, o = {}) => ({ k: 's', t: ref(t), f: 0, x, y, rot: 0, z: ++zc, ...o });
const BAG = (of, x, y, o = {}) => ({ k: 'b', of: of.map((m) => (typeof m === 'string' ? { t: ref(m), f: 0 } : { f: 0, ...m, t: ref(m.t) })), name: 'Sack', x, y, rot: 0, z: ++zc, ...o });
const CARD = (i, x, y, o = {}) => ({ k: 'c', d: DK, i, up: true, x, y, rot: 0, z: ++zc, ...o });
const PILE = (cards, x, y, o = {}) => ({ k: 'p', name: 'Pile', cards, x, y, rot: 0, z: ++zc, ...o });
const player = (name, seat) => ({ name, color: '#30bced', online: true, hand: [], seat });

// The probe script: every hook hands over to the test (globalThis.__p3), so
// the facade is only ever used inside a hook, as a script would use it.
const G = (globalThis.__p3 = {});
const PROBE = `({ name: 'P3 probe',
  buttons: () => [{ id: 'go', label: 'Go' }],
  setup(t) { const G = globalThis.__p3; if (G.setup) G.setup(t); },
  onButton(t, id, p) { const G = globalThis.__p3; try { G.ret = G.fn(t, p); } catch (e) { G.err = e; } },
  validate(t, a) { const G = globalThis.__p3; return G.validate ? G.validate(t, a) : undefined; },
  onAction(t, a) { const G = globalThis.__p3; if (G.onAction) G.onAction(t, a); },
  onTimer(t, tag) { const G = globalThis.__p3; if (G.onTimer) G.onTimer(t, tag); } })`;
const resetProbe = () => { for (const k of Object.keys(G)) delete G[k]; };

/** A host table holding `items` (a v3 save: MIGRATE[3] reads every piece's
 *  address by containment), the test box and a standard deck, Alice (the
 *  host), Bob and Carol seated and online, and the probe script enabled.
 *  o: {table, rules: false, hands, boxes, seed, v}. */
function table(items = {}, o = {}) {
  resetProbe();
  const s = {
    v: o.v ?? 3, seq: 1, table: o.table || { shape: 'rect', w: 5000, h: 3600 }, seats: null, boardSeq: 0, zMax: 0,
    items: json(items), keys: {}, log: [], rules: null, guestDeckChars: 0,
    players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270), [CAROL]: player('Carol', 0) },
    decks: { [DK]: core.standardDeck(false) }, boxes: o.boxes || { [BX]: cleanBox(SPACE_BOX) }, boxSrc: {},
  };
  for (const [p, hand] of Object.entries(o.hands || {})) s.players[p].hand = json(hand);
  const T = quietly(() => createTable(s, env(o.seed ?? 3))).value;
  if (o.rules !== false) quietly(() => T.apply(HOST, { t: 'setRules', enabled: true, code: PROBE }));
  T.drain();
  T.takeDirty();
  return T;
}
/** Applies action `a` as player p: {ret, fx, notes, log (texts added), rules (the Rules lines' texts), warn, error}. */
function act(T, p, a) {
  T.drain();
  const last = T.state.log.at(-1);
  const q = quietly(() => T.apply(p, a));
  const fx = T.drain(), added = T.state.log.slice(last ? T.state.log.lastIndexOf(last) + 1 : 0);
  return {
    ret: q.value, fx, notes: fx.filter((e) => e.t === 'note').map((e) => e.msg), log: added.map((e) => e.txt),
    rules: added.filter((e) => e.p === 'RULES').map((e) => e.txt), entries: added, warn: q.warn, error: q.error,
  };
}
/** Runs fn(t, p) inside a rules hook (the host presses the probe's button):
 *  act()'s result plus `ret` (what fn returned) and `err` (what it threw). */
function script(T, fn) {
  G.fn = fn;
  G.ret = G.err = undefined;
  const r = act(T, HOST, { t: 'rulesBtn', id: 'go' });
  if (!T.state.rules?.enabled) ok(false, `the probe script is still enabled (${T.rulesError})`);
  return { ...r, ret: G.ret, err: G.err };
}
/** A script call that must throw a TypeError naming the call (`name`, e.g. 't.move'). */
function typeErr(T, name, fn, what) {
  const r = script(T, fn);
  ok(r.err instanceof TypeError && r.err.message.startsWith(`${name}:`) && !r.log.length,
    `${name}: ${what} throws a TypeError naming the call, and changes nothing (${r.err ? `${r.err.name}: ${r.err.message}` : `returned ${J(r.ret)}`})`);
  return r;
}
/** The top-left that centres a piece of type `t` on table point P. */
const tl = (T, t, P) => { const ty = typeIn(T.state.boxes, ref(t)); return { x: P.x - ty.w / 2, y: P.y - ty.h / 2 }; };
/** Item `id`'s centre. */
const centre = (T, id) => { const it = T.state.items[id], { w, h } = it.k === 'g' || it.k === 's' ? sizeIn(T, it) : core.sizeOf(it, T.state.boxes); return { x: it.x + w / 2, y: it.y + h / 2 }; };
const newIds = (T, before) => Object.keys(T.state.items).filter((id) => !before.includes(id));

// =============================================================================
// (1) grid.js
// =============================================================================
const sqG = (o = {}) => ({ type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, snap: 'cell', ...o });
const hexG = (hex, o = {}) => ({ type: 'hex', hex, cols: 20, rows: 14, cell: 60, x: 10, y: 10, ...o });

function testGridAddresses() {
  section('(1) grid.js: parse and format round trips, every label system, the cell extremes');
  const grids = [
    sqG({ labels: 'chess' }), sqG({ labels: 'chess', cols: 26, rows: 64, cell: 10 }), sqG({ labels: 'chess', cols: 1, rows: 1 }),
    sqG({ labels: 'go', snap: 'point', cols: 19, rows: 19 }), sqG({ labels: 'go', snap: 'point', cols: 25, rows: 25 }), sqG({ labels: 'go', cols: 9, rows: 9 }),
    sqG({ labels: 'xy', cols: 64, rows: 64, cell: 8 }), sqG({ cols: 3, rows: 5 }),
    hexG('pointy'), hexG('flat'), hexG('pointy', { cols: 1, rows: 1 }), hexG('flat', { cols: 64, rows: 64, cell: 9 }),
  ];
  for (const g of grids) {
    const tag = `${labelsOf(g)} on ${g.type} ${g.hex || g.snap} ${g.cols}×${g.rows}`;
    let bad = '';
    for (const c of range(g.cols)) for (const r of range(g.rows)) {
      const s = grid.formatAddr(g, c, r), p = grid.parseAddr(g, s), other = s === s.toLowerCase() ? s.toUpperCase() : s.toLowerCase(), q = grid.parseAddr(g, other);
      if (!bad && !(s === specAddr(g, c, r) && p?.c === c && p?.r === r)) bad = `(${c}, ${r}) → ${J(s)} (spec ${specAddr(g, c, r)}) → ${J(p)}`;
      if (!bad && !(q?.c === c && q?.r === r)) bad = `${other} (the other case) → ${J(q)}`;
    }
    ok(!bad, `${tag}: every cell's address is §2a's, and parses back (either case) ${bad}`);
    const corners = [[0, 0], [g.cols - 1, 0], [0, g.rows - 1], [g.cols - 1, g.rows - 1]];
    const past = [[-1, 0], [0, -1], [g.cols, 0], [0, g.rows]].map(([c, r]) => {
      const L = labelsOf(g);
      if (L === 'axial') { const a = specAxial(g, c, r); return `${a.q},${a.r}`; }
      if (L === 'xy') return `${c},${r}`;
      const files = L === 'go' ? GO : CHESS;
      return c < 0 || c >= files.length ? null : `${files[c]}${g.rows - r}`;
    }).filter((s) => s !== null);
    ok(corners.every(([c, r]) => J(grid.parseAddr(g, specAddr(g, c, r))) === J({ c, r })) && past.every((s) => grid.parseAddr(g, s) === null),
      `${tag}: the four corner cells parse; one step past any edge is no address (${past.join(' ')})`);
  }
  const ch = sqG({ labels: 'chess' }), go = sqG({ labels: 'go', snap: 'point', cols: 19, rows: 19 });
  ok(grid.formatAddr(ch, 4, 4) === 'e4' && grid.formatAddr(go, 3, 15) === 'D4' && J(grid.parseAddr(go, 'j10')) === J({ c: 8, r: 9 }) && grid.parseAddr(go, 'I5') === null,
    'chess e4 (lower case), go D4 (upper case, no I: j10 is the 9th column)');
}

function testGridCentres() {
  section('(1) grid.js: cell centres are §2a\'s drawing formulas, for every cell');
  for (const g of [sqG(), sqG({ snap: 'point', labels: 'go', cols: 19, rows: 19, cell: 60, x: 60, y: 60 }), sqG({ cols: 5, rows: 3, cell: 37.5, x: -10, y: 4 }), hexG('pointy'), hexG('flat'), hexG('pointy', { x: 3.5, y: 7 })]) {
    let bad = '';
    for (const c of range(g.cols)) for (const r of range(g.rows)) {
      const got = grid.cellCenter(g, c, r), want = specCenter(g, c, r);
      if (!bad && !(near(got.x, want.x) && near(got.y, want.y))) bad = `(${c}, ${r}): ${J(got)}, the formula gives ${J(want)}`;
      if (!bad && g.type === 'hex' && !grid.hexCorners(g, c, r).every(([x, y]) => near(Math.hypot(x - want.x, y - want.y), g.cell / Math.sqrt(3)))) bad = `hexCorners (${c}, ${r}) are not R from the centre`;
    }
    ok(!bad, `${g.type} ${g.hex || g.snap} ${g.cols}×${g.rows}: cellCenter follows §2a${g.type === 'hex' ? ', hexCorners lie R = cell/√3 from it' : ''} ${bad}`);
  }
}

function testGridSnapping() {
  section('(1) grid.js: snapping inside and outside reach');
  const r = rng(31);
  // Square cells: the cell holding the point, in bounds; nothing off the grid.
  {
    const g = sqG({ labels: 'chess' }), B = { grid: g };
    let bad = '';
    for (let k = 0; k < 3000; k++) {
      const x = -100 + r() * 1100, y = -100 + r() * 1100, got = grid.spotAt(B, x, y), want = refSpot(B, x, y);
      if (!bad && J(got && [got.local, fix(got.x), fix(got.y)]) !== J(want && [want.local, fix(want.x), fix(want.y)])) bad = `(${x.toFixed(2)}, ${y.toFixed(2)}): ${J(got)}, want ${J(want)}`;
    }
    ok(!bad, `square cells: 3,000 points in and around the grid snap to the cell holding them, off the grid to nothing (seed 31) ${bad}`);
    ok(grid.spotAt(B, 470, 470)?.local === 'e4' && grid.spotAt(B, 21, 819)?.local === 'a1' && grid.spotAt(B, 19, 500) === null && grid.spotAt(B, 821, 500) === null,
      'square cells: (470, 470) is e4, a1\'s far corner is a1; just left or right of the grid is no spot');
  }
  // Square points: the nearest point within cell/2.
  {
    const g = sqG({ snap: 'point', labels: 'go', cols: 19, rows: 19, cell: 60, x: 60, y: 60 }), B = { grid: g };
    const P = (c, rr, dx, dy) => grid.spotAt(B, 60 + c * 60 + dx, 60 + rr * 60 + dy)?.local ?? null;
    ok(P(3, 15, 0, 0) === 'D4' && P(3, 15, 29, 0) === 'D4' && P(3, 15, -20, 20) === 'D4' && P(3, 15, 0, -29.9) === 'D4',
      'square points: within cell/2 of D4 (on it, 29 units right, 28 units diagonally) snaps to D4');
    ok(P(3, 15, 27, 27) === null && P(3, 15, 21.3, 21.3) === null && P(0, 0, -31, 0) === null && P(18, 18, 0, 31) === null,
      'square points: 38 and 30.1 units off diagonally (past cell/2 = 30), or 31 units past an edge point, is no spot');
    let bad = '';
    for (let k = 0; k < 3000; k++) {
      const x = r() * 1240, y = r() * 1240, got = grid.spotAt(B, x, y), want = refSpot(B, x, y);
      if (!bad && (got?.local ?? null) !== (want?.local ?? null)) bad = `(${x.toFixed(2)}, ${y.toFixed(2)}): ${J(got)}, want ${J(want)}`;
    }
    ok(!bad, `square points: 3,000 random points agree with "the nearest point within cell/2" (seed 31) ${bad}`);
  }
  // Hexes, pointy and flat, 20 × 14: every centre → pixel → axial round trip.
  for (const hex of ['pointy', 'flat']) {
    const g = hexG(hex), B = { grid: g }, R = g.cell / Math.sqrt(3);
    let bad = '';
    for (const c of range(g.cols)) for (const rr of range(g.rows)) {
      const p = specCenter(g, c, rr), want = specAddr(g, c, rr);
      const probes = [[0, 0], ...range(12).map((k) => [0.98 * (g.cell / 2) * Math.cos((k * Math.PI) / 6), 0.98 * (g.cell / 2) * Math.sin((k * Math.PI) / 6)])];
      for (const [dx, dy] of probes) {
        const s = grid.spotAt(B, p.x + dx, p.y + dy);
        if (!bad && !(s?.local === want && near(s.x, p.x) && near(s.y, p.y))) bad = `(${c}, ${rr}) + (${dx.toFixed(1)}, ${dy.toFixed(1)}) → ${J(s)}, want ${want}`;
      }
      for (const [x, y] of grid.hexCorners(g, c, rr)) { // 95% of the way to each corner: still this hex
        const s = grid.spotAt(B, p.x + 0.95 * (x - p.x), p.y + 0.95 * (y - p.y));
        if (!bad && s?.local !== want) bad = `(${c}, ${rr}) toward a corner → ${J(s)}, want ${want}`;
      }
      const back = grid.parseAddr(g, want);
      if (!bad && !(back?.c === c && back?.r === rr)) bad = `${want} parses to ${J(back)}`;
    }
    ok(!bad, `hex ${hex} 20×14: every cell's centre, and points across its inner circle and toward its corners, snap to that cell, whose axial address parses back ${bad}`);
    let bad2 = '', n = 0;
    for (let k = 0; k < 4000; k++) {
      const x = -40 + r() * 1320, y = -40 + r() * 960, want = refSpot(B, x, y);
      // (the edge case the spec leaves open — a point in an off-grid hex yet within R of an edge centre — is skipped)
      let lattice = Infinity, gridNear = Infinity;
      for (let c = -2; c < g.cols + 2; c++) for (let rr = -2; rr < g.rows + 2; rr++) {
        const p = specCenter(g, c, rr), d = Math.hypot(p.x - x, p.y - y);
        lattice = Math.min(lattice, d);
        if (inBounds(g, c, rr)) gridNear = Math.min(gridNear, d);
      }
      if (lattice < gridNear - 1e-9 && gridNear <= R) continue;
      n++;
      const got = grid.spotAt(B, x, y);
      if (!bad2 && (got?.local ?? null) !== (want?.local ?? null)) bad2 = `(${x.toFixed(2)}, ${y.toFixed(2)}): ${J(got)}, want ${J(want)}`;
    }
    ok(!bad2 && n > 3000, `hex ${hex}: ${n} random points snap to the nearest centre within R (brute force), outside the grid to nothing (seed 31) ${bad2}`);
  }
  // Spaces first: the nearest space in reach, then the grid.
  {
    const g = sqG({ labels: 'chess' }), spaces = [{ id: 'den', x: 470, y: 470, r: 40 }, { id: 'nest', x: 540, y: 470, r: 40 }, { id: 'bar', x: 900, y: 420, r: 30, w: 40, h: 600 }, { id: 'pt', x: 960, y: 420, r: 30, w: 40, h: 600 }];
    const B = { grid: g, spaces }, at = (x, y) => grid.spotAt(B, x, y)?.local ?? null;
    ok(at(470, 470) === 'den' && at(470, 509) === 'den' && at(495, 470) === 'den' && at(515, 470) === 'nest',
      'spaces first: on a grid cell, a space within its reach wins; of two in reach, the nearer');
    ok(at(470, 511) === 'e4' && at(400, 400) === 'd5' && at(600, 600) === 'f3', 'spaces first: past every space\'s reach r, the grid cell holding the point');
    ok(at(900, 690) === 'bar' && at(919, 150) === 'bar' && at(941, 150) === 'pt' && at(900, 731) === null,
      'D104: anywhere inside a space\'s w × h rectangle is in its reach (the bar\'s far end, 270 from its centre); past it, its r; off the grid, nothing');
    const spot = grid.spotAt(B, 495, 470);
    ok(spot && near(spot.x, 470) && near(spot.y, 470), `a space's spot is its centre (${J(spot)})`);
    ok(grid.spotAt({ spaces: [{ id: 's', x: 100, y: 100, r: 50 }] }, 149.9, 100)?.local === 's' && grid.spotAt({ spaces: [{ id: 's', x: 100, y: 100, r: 50 }] }, 150.1, 100) === null,
      'a space alone: in reach up to r (49.9 off), out past it (50.1 off)');
  }
}

function testGridTurns() {
  section('(1) grid.js: boards turned by 90, 180 and 270° (the inverse turn about the board\'s centre)');
  const b0 = { x: 1000, y: 700, w: 700, h: 500, rot: 0 }, r = rng(17);
  let bad = '';
  for (const rot of [0, 90, 180, 270]) {
    const b = { ...b0, rot };
    for (let k = 0; k < 200; k++) {
      const lx = r() * 700, ly = r() * 500, P = L2T(b, lx, ly), got = grid.fromLocal(b, lx, ly), back = grid.toLocal(b, P.x, P.y);
      if (!bad && !(near(got.x, P.x) && near(got.y, P.y) && near(back.x, lx) && near(back.y, ly))) bad = `rot ${rot}: local (${lx}, ${ly}) → ${J(got)}, want ${J(P)}; back ${J(back)}`;
      if (!bad && !grid.onBoard(b, P.x, P.y)) bad = `rot ${rot}: (${P.x}, ${P.y}) is on the board`;
    }
    const corner = grid.fromLocal(b, 0, 0);
    if (!bad && rot === 90 && !(near(corner.x, 1600) && near(corner.y, 600))) bad = `a 700 × 500 board at (1000, 700) turned 90° puts its local (0, 0) at ${J(corner)}, want (1600, 600): clockwise about the centre`;
    // turned a quarter, the board spans x 1100–1600, y 600–1300; else x 1000–1700, y 700–1200
    const off = rot % 180 ? [1020, 760] : [1010, 1205];
    if (!bad && grid.onBoard(b, off[0], off[1])) bad = `rot ${rot}: (${off}) lies off the turned rectangle, yet onBoard says it is on`;
  }
  ok(!bad, `fromLocal / toLocal / onBoard turn about the board's centre, clockwise as on screen, and invert each other ${bad}`);
}

function testGridNeighbors() {
  section('(1) grid.js: neighbors (4, 8, 6) at corners, edges and the interior; a space\'s links');
  const ch = { grid: sqG({ labels: 'chess' }) }, N = (B, s, o) => grid.neighbors(B, s, o);
  const cases = [['a1', ['a2', 'b1'], ['a2', 'b2', 'b1']], ['h8', ['h7', 'g8'], ['h7', 'g7', 'g8']], ['e1', ['e2', 'f1', 'd1'], ['e2', 'f2', 'f1', 'd1', 'd2']],
    ['a5', ['a6', 'b5', 'a4'], ['a6', 'b6', 'b5', 'b4', 'a4']], ['e4', ['e5', 'f4', 'e3', 'd4'], ['e5', 'f5', 'f4', 'f3', 'e3', 'd3', 'd4', 'd5']]];
  for (const [s, four, eight] of cases) {
    ok(sameSet(N(ch, s), four) && sameSet(N(ch, s, { diag: true }), eight), `square ${s}: ${four.length} orthogonal (${N(ch, s)}), ${eight.length} with diagonals (${N(ch, s, { diag: true })})`);
  }
  for (const hex of ['pointy', 'flat']) {
    const g = hexG(hex), B = { grid: g };
    let bad = '';
    for (const c of range(g.cols)) for (const r of range(g.rows)) {
      const p = specCenter(g, c, r);
      // §2a geometry: the neighbours of a hex are the cells one cell-width away
      const want = [];
      for (const cc of range(g.cols)) for (const rr of range(g.rows)) { const q = specCenter(g, cc, rr); if (near(Math.hypot(q.x - p.x, q.y - p.y), g.cell, 1e-6)) want.push(specAddr(g, cc, rr)); }
      const got = N(B, specAddr(g, c, r));
      if (!bad && !sameSet(got || [], want)) bad = `(${c}, ${r}) ${specAddr(g, c, r)}: ${J(got)}, want ${J(want)}`;
    }
    const inner = N(B, specAddr(g, 5, 5)), corner = N(B, specAddr(g, 0, 0));
    ok(!bad && inner.length === 6 && corner.length < 6, `hex ${hex}: every cell's neighbours are the cells one cell-width away, in bounds (6 inside, ${corner.length} at the corner) ${bad}`);
  }
  const dock = { spaces: [{ id: 'a', x: 0, y: 0, r: 9 }, { id: 'b', x: 50, y: 0, r: 9 }, { id: 'c', x: 99, y: 0, r: 9 }, { id: 'd', x: 150, y: 0, r: 9 }], links: [['a', 'b'], ['c', 'a'], ['b', 'a'], ['b', 'c']] };
  ok(sameSet(N(dock, 'a'), ['b', 'c']) && sameSet(N(dock, 'b'), ['a', 'c']) && sameSet(N(dock, 'c'), ['a', 'b']) && J(N(dock, 'd')) === '[]',
    'a space\'s neighbours are its links, both ways, each once; an unlinked space has none');
  ok(sameSet(grid.linked(dock, 'a'), ['b', 'c']) && grid.linked(dock, 'a').length === 2 && sameSet(grid.linked(dock, 'c'), ['a', 'b']) && J(grid.linked(dock, 'd')) === '[]',
    'linked: undirected (c lists a from [c, a], a lists c), duplicates once, an unlinked space []');
  ok(N(ch, 'i9') === null || N(ch, 'i9')?.length === 0, 'no neighbours for what is no address');
}

function testGridDistanceLine() {
  section('(1) grid.js: distance (chebyshev, manhattan, hex) and line');
  const ch = { grid: sqG({ labels: 'chess' }), spaces: [] }, D = (B, a, b, o) => grid.distance(B, a, b, o);
  ok(D(ch, 'a1', 'h8') === 7 && D(ch, 'a1', 'b3') === 2 && D(ch, 'e4', 'e4') === 0 && D(ch, 'a1', 'h8', { metric: 'chebyshev' }) === 7,
    `square: chebyshev by default (a1–h8 ${D(ch, 'a1', 'h8')}, a1–b3 ${D(ch, 'a1', 'b3')})`);
  ok(D(ch, 'a1', 'h8', { metric: 'manhattan' }) === 14 && D(ch, 'a1', 'b3', { metric: 'manhattan' }) === 3, 'square: manhattan on request (a1–h8 14, a1–b3 3)');
  const withSp = { grid: sqG({ labels: 'chess' }), spaces: [{ id: 'bar', x: 900, y: 400, r: 30 }, { id: 'off', x: 950, y: 400, r: 30 }] };
  ok(D(withSp, 'bar', 'e4') === null && D(withSp, 'bar', 'off') === null, 'distance involving a space is null');
  for (const hex of ['pointy', 'flat']) {
    const g = hexG(hex, { cols: 12, rows: 9 }), B = { grid: g }, cells = [];
    for (const c of range(g.cols)) for (const r of range(g.rows)) cells.push([c, r]);
    // BFS over §2a's geometry (neighbours one cell-width apart) — no cube maths
    const adj = (c, r) => cells.filter(([cc, rr]) => near(Math.hypot(specCenter(g, cc, rr).x - specCenter(g, c, r).x, specCenter(g, cc, rr).y - specCenter(g, c, r).y), g.cell));
    const bfs = (c0, r0) => {
      const dist = new Map([[`${c0},${r0}`, 0]]), queue = [[c0, r0]];
      while (queue.length) { const [c, r] = queue.shift(); for (const [cc, rr] of adj(c, r)) if (!dist.has(`${cc},${rr}`)) { dist.set(`${cc},${rr}`, dist.get(`${c},${r}`) + 1); queue.push([cc, rr]); } }
      return dist;
    };
    let bad = '';
    for (const [c0, r0] of [[0, 0], [5, 4], [11, 8], [3, 7]]) {
      const dist = bfs(c0, r0);
      for (const [c, r] of cells) {
        const got = D(B, specAddr(g, c0, r0), specAddr(g, c, r));
        if (!bad && got !== dist.get(`${c},${r}`)) bad = `${specAddr(g, c0, r0)} → ${specAddr(g, c, r)}: ${got}, steps ${dist.get(`${c},${r}`)}`;
      }
    }
    ok(!bad, `hex ${hex}: the cube distance equals the steps between neighbours (BFS over the grid's geometry) ${bad}`);
    // Hex lines: cube-lerp, strictly between, each step to a neighbour, never far from the segment.
    let lbad = '';
    const R = g.cell / Math.sqrt(3), r2 = rng(5);
    for (let k = 0; k < 300; k++) {
      const [a, b] = [cells[Math.floor(r2() * cells.length)], cells[Math.floor(r2() * cells.length)]], A = specAddr(g, ...a), Bd = specAddr(g, ...b);
      const L = grid.line(B, A, Bd), n = D(B, A, Bd), path = [A, ...(L || []), Bd], pa = specCenter(g, ...a), pb = specCenter(g, ...b);
      if (!Array.isArray(L) || L.length !== Math.max(0, n - 1) || L.includes(A) || L.includes(Bd)) { lbad ||= `${A} → ${Bd}: ${J(L)} (distance ${n})`; continue; }
      for (let j = 1; j < path.length && n > 0; j++) if (D(B, path[j - 1], path[j]) !== 1) lbad ||= `${A} → ${Bd}: ${path[j - 1]} and ${path[j]} are not neighbours`;
      for (const s of L) {
        const cr = specParse(g, s), p = specCenter(g, cr.c, cr.r), t = Math.max(0, Math.min(1, ((p.x - pa.x) * (pb.x - pa.x) + (p.y - pa.y) * (pb.y - pa.y)) / ((pb.x - pa.x) ** 2 + (pb.y - pa.y) ** 2)));
        if (Math.hypot(pa.x + t * (pb.x - pa.x) - p.x, pa.y + t * (pb.y - pa.y) - p.y) > R + 1e-6) lbad ||= `${A} → ${Bd}: ${s} lies more than R from the segment`;
      }
    }
    ok(!lbad, `hex ${hex}: 300 lines (seed 5) hold distance − 1 cells strictly between the ends, each a neighbour of the next, each within R of the segment ${lbad}`);
    // along the axial q direction from cell (1, 4): q + 1 … q + 4 lie between it and q + 5
    const a = specAxial(g, 1, 4), step = (dq) => { const o = specOffset(g, a.q + dq, a.r); return specAddr(g, o.c, o.r); };
    ok(J(grid.line(B, step(0), step(5))) === J([1, 2, 3, 4].map(step)), `hex ${hex}: along one axial direction the line is exactly the cells between (${step(0)} → ${step(5)}: ${J(grid.line(B, step(0), step(5)))})`);
  }
  const L = (a, b) => grid.line(ch, a, b);
  ok(J(L('a1', 'h1')) === J(['b1', 'c1', 'd1', 'e1', 'f1', 'g1']) && J(L('e2', 'e7')) === J(['e3', 'e4', 'e5', 'e6']) && J(L('h1', 'a1')) === J(['g1', 'f1', 'e1', 'd1', 'c1', 'b1']),
    'square: along a rank or a file, the cells strictly between, in order from a');
  ok(J(L('a1', 'h8')) === J(['b2', 'c3', 'd4', 'e5', 'f6', 'g7']) && J(L('h1', 'a8')) === J(['g2', 'f3', 'e4', 'd5', 'c6', 'b7']) && J(L('e4', 'b1')) === J(['d3', 'c2']),
    'square: along either diagonal, the cells strictly between');
  ok(J(L('e4', 'e5')) === '[]' && J(L('e4', 'f5')) === '[]' && L('a1', 'b3') === null && L('a1', 'h7') === null && L('e4', 'g5') === null,
    'square: neighbours have nothing between ([]); a knight\'s step or any unaligned pair is null');
  ok(grid.line(withSp, 'bar', 'e4') === null, 'line involving a space is null');
}

function testGridPolygons() {
  section('(1) grid.js: point-in-polygon at zone edges');
  const sqr = [[0, 0], [100, 0], [100, 100], [0, 100]], tri = [[0, 0], [100, 0], [50, 80]], ell = [[0, 0], [60, 0], [60, 40], [30, 40], [30, 100], [0, 100]];
  const P = grid.pointInPoly;
  ok(P(sqr, 50, 50) && P(sqr, 0, 0) && P(sqr, 100, 100) && P(sqr, 50, 0) && P(sqr, 100, 37) && P(sqr, 0, 99.999), 'square: inside, on each corner and on each edge is inside');
  ok(!P(sqr, -0.001, 50) && !P(sqr, 100.001, 50) && !P(sqr, 50, -0.001) && !P(sqr, 50, 100.001) && !P(sqr, 101, 101), 'square: a hair past any edge is outside');
  ok(P(tri, 25, 40) && P(tri, 75, 40) && P(tri, 50, 80) && P(tri, 50, 1) && !P(tri, 24, 41) && !P(tri, 50, 80.01), 'triangle: on its slanted edges and apex inside, just past them outside');
  ok(P(ell, 30, 70) && P(ell, 45, 40) && P(ell, 15, 90) && !P(ell, 45, 41) && !P(ell, 31, 70) && !P(ell, 45, 70), 'a concave L: its inner corner\'s edges are inside, the notch is outside');
  const r = rng(11);
  let bad = '';
  for (let k = 0; k < 2000; k++) { const x = -10 + r() * 120, y = -10 + r() * 120; if (!bad && P(ell, x, y) !== refPip(ell, x, y)) bad = `(${x}, ${y})`; }
  ok(!bad, `2,000 random points agree with a winding-number test on the L (seed 11) ${bad}`);
  const B = { zones: [{ id: 'left', poly: [[0, 0], [200, 0], [200, 120], [0, 120]] }, { id: 'right', poly: [[200, 0], [400, 0], [400, 120], [200, 120]] }] };
  ok(sameSet(grid.zonesAt(B, 200, 60), ['left', 'right']) && J(grid.zonesAt(B, 199, 60)) === '["left"]' && J(grid.zonesAt(B, 401, 60)) === '[]', 'zones: a point on the shared edge is in both zones; off the rack, in none');
}


// =============================================================================
// (8) Addresses: the primary board, display forms, resolution
// =============================================================================
/** A human move of piece `id` (of type `t`) by p to centre it near table point P (off by dx, dy). */
const moveNear = (T, p, id, t, P, dx = 13, dy = -9) => { const q = tl(T, t, P); return act(T, p, { t: 'move', id, x: q.x + dx, y: q.y + dy }); };
const pubAt = (T, id) => T.pub.get(id)?.at;

function testAddresses() {
  section('(8) addresses: a primary chess board, then two racks, a second map, two trays and a dock');
  const T = table({ CB: BRD('chess', 700, 100), ...Object.fromEntries(range(6).map((k) => [`m${k + 1}`, PC('man', 100 + 100 * k, 3200)])) });
  let r = moveNear(T, BOB, 'm1', 'man', refAt(T, 'CB', 'e4'));
  const e4 = refAt(T, 'CB', 'e4'), c1 = centre(T, 'm1');
  ok(T.state.items.m1.at === 'CB:e4' && near(c1.x, e4.x) && near(c1.y, e4.y), `a man dropped near e4 snaps onto it: centred, at = the qualified "CB:e4" (${T.state.items.m1.at}, centre ${J(c1)})`);
  ok(J(r.log) === J(['moved Man to e4']) && pubAt(T, 'm1') === 'e4' && script(T, (t) => t.where('m1')).ret === 'e4', `the log, the public view and t.where read the bare "e4" (${J(r.log)}, ${pubAt(T, 'm1')})`);

  // Two racks, a second map, two trays and a dock join the table (spawned by the script: boards, locked).
  const before = Object.keys(T.state.items);
  const spawned = script(T, (t) => [['rack', 100, 100], ['rack', 100, 300], ['map', 1700, 100], ['tray', 100, 600], ['tray', 100, 900], ['dock', 100, 1200]]
    .map(([ty, x, y]) => t.spawn(ref(ty), { at: { x, y } })));
  const [, , MP, T1, T2, DQ] = spawned.ret; // (the two racks first)
  ok(spawned.ret.every((id) => typeof id === 'string' && T.state.items[id].z < 0 && T.state.items[id].lock === true) && newIds(T, before).length === 6,
    `t.spawn of a board puts it in the boards' z band, locked (${J(spawned.ret.map((id) => [T.state.items[id]?.z, T.state.items[id]?.lock]))})`);
  ok(script(T, (t) => t.where('m1')).ret === 'e4' && pubAt(T, 'm1') === 'e4', 'e4 stays bare in t.where and the public view once racks and a second map lie on the table');
  r = moveNear(T, BOB, 'm1', 'man', refAt(T, 'CB', 'e5'));
  ok(J(r.log) === J(['moved Man e4 → e5']) && pubAt(T, 'm1') === 'e5', `…and in the log: "moved Man e4 → e5" (${J(r.log)})`);
  r = moveNear(T, BOB, 'm2', 'man', refAt(T, MP, 'c3'));
  ok(T.state.items.m2.at === `${MP}:c3` && J(r.log) === J(['moved Man to map:c3']) && pubAt(T, 'm2') === 'map:c3' && script(T, (t) => t.where('m2')).ret === 'map:c3',
    `the second map's spots read "map:c3" (log ${J(r.log)}, view ${pubAt(T, 'm2')})`);
  moveNear(T, BOB, 'm3', 'man', refAt(T, T1, 'bar'));
  moveNear(T, BOB, 'm4', 'man', refAt(T, T2, 'bar'), -20, 25);
  ok(pubAt(T, 'm3') === 'tray#1:bar' && pubAt(T, 'm4') === 'tray#2:bar' && T.state.items.m3.at === `${T1}:bar` && T.state.items.m4.at === `${T2}:bar`,
    `two trays: "tray#1:bar" and "tray#2:bar", oldest first (${pubAt(T, 'm3')}, ${pubAt(T, 'm4')})`);
  r = script(T, (t) => [t.at('tray#1:bar').map((x) => x.id), t.at('tray#2:bar').map((x) => x.id), t.at(`${T2}:bar`).map((x) => x.id), t.at('tray#2:bar')[0]?.at]);
  ok(J(r.ret) === J([['m3'], ['m4'], ['m4'], 'tray#2:bar']), `t.at takes both display forms and the qualified one, and returns copies whose at is the display form (${J(r.ret)})`);

  section('(8) bare addresses: the primary board first, then the one other board that has it; ambiguity throws');
  r = script(T, (t) => [t.spot('quay'), t.move('m5', 'quay'), t.where('m5'), t.spot('j10'), t.move('m6', 'j10'), t.where('m6'), t.spot('c3')]);
  const [quay, moved5, where5, j10, moved6, where6, c3] = r.ret || [];
  const wq = refAt(T, DQ, 'quay'), wj = refAt(T, MP, 'j10'), wc = refAt(T, 'CB', 'c3');
  ok(near(quay?.x, wq.x) && near(quay?.y, wq.y) && moved5 === true && where5 === 'dock:quay', `"quay" (a space only the dock has) is the dock's: t.spot ${J(quay)}, t.where after t.move "${where5}"`);
  ok(near(j10?.x, wj.x) && near(j10?.y, wj.y) && moved6 === true && where6 === 'map:j10', `"j10" (only the 10 × 10 map has it) is the map's: t.where "${where6}"`);
  ok(near(c3?.x, wc.x) && near(c3?.y, wc.y), `"c3" (the chess board and the map both have it) is the primary board's (${J(c3)}, the chess board's ${J(wc)})`);
  r = typeErr(T, 't.move', (t) => t.move('m5', 'bar'), "an address two trays have ('bar')");
  const msg = r.err?.message || '', sugg = [...msg.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((s) => s !== 'bar');
  ok(msg.startsWith("t.move: address 'bar' is ambiguous — use '") && sugg.length === 2, `the message names the address and how to say it ("${msg}")`);
  const spots = script(T, (t) => sugg.map((s) => t.spot(s))).ret || [];
  const w1 = refAt(T, T1, 'bar'), w2 = refAt(T, T2, 'bar');
  ok(spots.length === 2 && spots.some((p) => near(p.x, w1.x) && near(p.y, w1.y)) && spots.some((p) => near(p.x, w2.x) && near(p.y, w2.y)),
    `each suggested form resolves, one to each tray's bar (${J(sugg)} → ${J(spots)})`);
  for (const [name, fn] of [['t.spot', (t) => t.spot('bar')], ['t.at', (t) => t.at('bar')], ['t.find', (t) => t.find({ at: 'bar' })], ['t.neighbors', (t) => t.neighbors('bar')],
    ['t.spawn', (t) => t.spawn(ref('man'), { at: 'bar' })], ['t.linked', (t) => t.linked('bar')]]) {
    const e = typeErr(T, name, fn, "the ambiguous 'bar'").err;
    ok(/ambiguous/.test(e?.message || ''), `${name}: the TypeError says it is ambiguous (${e?.message})`);
  }

  section('(8) every address-taking API takes the display and the qualified forms (and any case)');
  r = script(T, (t) => [t.move('m1', 'CB:e6'), t.where('m1'), t.move('m2', `${MP}:c4`), t.where('m2'), t.move('m1', 'E7'), t.where('m1'), t.at('map:c4').map((x) => x.id), t.find({ at: `${MP}:c4` }).map((x) => x.id)]);
  ok(J(r.ret) === J([true, 'e6', true, 'map:c4', true, 'e7', ['m2'], ['m2']]), `qualified "CB:e6" and "${MP}:c4", upper-case "E7" (out: canonical "e7"), display "map:c4" (${J(r.ret)})`);

  section('(8) renumbering: the older tray goes, the other reads "tray:bar" and is re-sent');
  T.takeDirty();
  r = script(T, (t) => t.remove(T1));
  const d = T.takeDirty();
  ok(r.ret === true && pubAt(T, 'm4') === 'tray:bar' && d.items.has('m4') && T.patchContent(d).items?.m4?.at === 'tray:bar',
    `m4's display form changed with no move of its own: the next patch carries it as "tray:bar" (${pubAt(T, 'm4')}, in the patch: ${d.items.has('m4')})`);
  ok(T.state.items.m3.at === undefined && pubAt(T, 'm3') === undefined, 'the man on the removed tray stays where it was, with no address');

  section('(8) several boards of one type: the oldest keeps the primary\'s bare addresses, the next reads "chess#2:e4"');
  const CB2 = script(T, (t) => t.spawn(ref('chess'), { at: { x: 2400, y: 1200 } })).ret;
  moveNear(T, BOB, 'm6', 'man', refAt(T, CB2, 'e4'));
  ok(pubAt(T, 'm6') === 'chess#2:e4' && pubAt(T, 'm1') === 'e7' && script(T, (t) => t.where('m6')).ret === 'chess#2:e4', `${pubAt(T, 'm6')} and the primary board's ${pubAt(T, 'm1')}`);
  ok(containmentProblems(T).length === 0, `every address and index agrees with containment ${J(containmentProblems(T))}`);
}

function testPrimaryRule() {
  section('(8) the primary board: zones-only racks never; else primary: true, the oldest with a grid, the oldest with spaces');
  const T = table({ R1: BRD('rack', 100, 100), R2: BRD('rack', 100, 300), p1: PC('man', 140, 120), p2: PC('man', 100, 3200), p3: PC('man', 200, 3200), p4: PC('man', 300, 3200) });
  let r = script(T, (t) => [t.zones('p1'), t.where('p1'), t.find({ zone: 'left' }).map((x) => x.id), t.find({ zone: 'rack#1:left' }).map((x) => x.id), t.find({ zone: 'rack#2:left' }).map((x) => x.id)]);
  ok(J(r.ret) === J([['rack#1:left'], null, ['p1'], ['p1'], []]), `with racks alone there is no primary board: zones read "rack#1:left"; t.find({zone}) takes a bare zone id or a board's (${J(r.ret)})`);
  const TR = script(T, (t) => t.spawn(ref('tray'), { at: { x: 800, y: 100 } })).ret;
  moveNear(T, BOB, 'p2', 'man', refAt(T, TR, 'bar'));
  ok(pubAt(T, 'p2') === 'bar' && script(T, (t) => t.zones('p1')).ret?.[0] === 'rack#1:left', `a tray (spaces) added after the racks is primary: "bar" bare (${pubAt(T, 'p2')})`);
  T.takeDirty();
  const CB = script(T, (t) => t.spawn(ref('chess'), { at: { x: 1400, y: 100 } })).ret;
  const d = T.takeDirty();
  ok(pubAt(T, 'p2') === 'tray:bar' && d.items.has('p2'), `a board with a grid outranks the older spaces board: now "tray:bar", re-sent (${pubAt(T, 'p2')})`);
  moveNear(T, BOB, 'p3', 'man', refAt(T, CB, 'e4'));
  const PM = script(T, (t) => t.spawn(ref('pmap'), { at: { x: 2400, y: 100 } })).ret;
  moveNear(T, BOB, 'p4', 'man', refAt(T, PM, 'c3'));
  ok(pubAt(T, 'p3') === 'chess:e4' && pubAt(T, 'p4') === 'c3', `a newer board whose type says primary: true is primary: "chess:e4", "c3" (${pubAt(T, 'p3')}, ${pubAt(T, 'p4')})`);
  r = script(T, (t) => [t.spot('e4'), t.spot('chess:e4')]);
  const want = refAt(T, PM, 'e4'), e4 = refAt(T, CB, 'e4');
  ok(near(r.ret?.[0]?.x, want.x) && near(r.ret?.[0]?.y, want.y) && near(r.ret?.[1]?.x, e4.x) && near(r.ret?.[1]?.y, e4.y), `bare "e4" (both boards have it) is now the primary map's, "chess:e4" the chess board's (${J(r.ret)})`);
  const T2 = table({ A: BRD('pmap', 100, 100), B: BRD('pmap', 800, 100), q: PC('man', 100, 3200) });
  moveNear(T2, BOB, 'q', 'man', refAt(T2, 'B', 'c3'));
  ok(pubAt(T2, 'q') === 'pmap#2:c3', `of two primary: true boards the oldest is primary (${pubAt(T2, 'q')})`);
}

// =============================================================================
// (9) Board moves: nothing else moves; at, byAt and byZone by containment
// =============================================================================
/** {id: [x, y]} of every item but the boards. */
const places = (T) => Object.fromEntries(Object.entries(T.state.items).filter(([, it]) => !(it.z < 0)).map(([id, it]) => [id, [it.x, it.y]]));

function testBoardMoves() {
  section('(9) moving, turning and deleting a structured board, and resizing the table, move nothing else');
  const items = { CB: BRD('chess', 700, 100), MP: BRD('map', 1700, 100), RK: BRD('rack', 100, 100), WD: BRD('wide', 2500, 100) };
  const T0 = table(items, { rules: false });
  const on = (b, s, t = 'man') => tl(T0, t, refAt(T0, b, s));
  Object.assign(items, {
    a: PC('man', on('CB', 'e4').x, on('CB', 'e4').y), b: PC('man', on('CB', 'a1').x, on('CB', 'a1').y), c: PC('spy', on('CB', 'h8', 'spy').x, on('CB', 'h8', 'spy').y, { up: false }),
    d: PC('man', 100, 3000), e: PC('man', on('MP', 'c3').x, on('MP', 'c3').y), f: PC('gem', 130, 130), g: PC('gem', 330, 130),
    h: PC('man', on('WD', '2,1').x, on('WD', '2,1').y), i: PC('big', on('WD', '4,2', 'big').x, on('WD', '4,2', 'big').y),
    card: CARD(3, 1100, 400), sup: SUP('man', 1300, 300), bag: BAG(['man'], 1000, 600), pile: PILE([{ t: ref('tile'), f: 0, up: true }], 1400, 600),
  });
  const T = table(items);
  ok(containmentProblems(T).length === 0 && T.state.items.a.at === 'CB:e4' && T.state.items.c.at === 'CB:h8' && T.state.items.h.at === 'WD:2,1',
    `the starting table: every address and index by containment (a ${T.state.items.a.at}, the hidden c ${T.state.items.c.at}, h ${T.state.items.h.at}) ${J(containmentProblems(T))}`);
  ok(T.state.items.card.at === undefined && T.state.items.sup.at === undefined && T.state.items.bag.at === undefined && T.state.items.pile.at === undefined,
    'a card, a supply, a bag and a pile lying on the chess board have no address (only pieces get one)');
  const steps = [
    ['the host moves the chess board one cell right', () => act(T, HOST, { t: 'move', id: 'CB', x: 800, y: 100 })],
    ['the host turns the map 90°', () => act(T, HOST, { t: 'rot', id: 'MP', rot: 90 })],
    ['the host turns the wide board 90°', () => act(T, HOST, { t: 'rot', id: 'WD', rot: 90 })],
    ['…180°', () => act(T, HOST, { t: 'rot', id: 'WD', rot: 180 })],
    ['…270°', () => act(T, HOST, { t: 'rot', id: 'WD', rot: 270 })],
    ['the host moves the rack 200 right (a zone boundary passes under a gem)', () => act(T, HOST, { t: 'move', id: 'RK', x: 300, y: 100 })],
    ['a script moves the chess board (t.move)', () => script(T, (t) => t.move('CB', 900, 300))],
    ['a script turns the chess board (t.rot)', () => script(T, (t) => t.rot('CB', 90))],
    ['the host deletes the map', () => act(T, HOST, { t: 'del', id: 'MP' })],
  ];
  for (const [what, run] of steps) {
    const was = places(T), r = run(), now = places(T);
    const moved = Object.keys(was).filter((id) => !isDeepStrictEqual(was[id], now[id]));
    ok(!r.notes.length && !moved.length, `${what}: no other item moved ${moved.length ? J(moved) : ''}${r.notes.length ? J(r.notes) : ''}`);
    const bad = containmentProblems(T);
    ok(!bad.length, `${what}: every piece's at, T.byAt and T.byZone follow by containment ${J(bad)}`);
    if (what.startsWith('the host moves the chess board')) {
      const d = T.takeDirty();
      ok(T.state.items.a.at === 'CB:d4' && T.state.items.b.at === undefined && pubAt(T, 'a') === 'd4' && d.items.has('a') && d.items.has('b'),
        `the man on e4 now reads d4 (the board moved under it), the one on a1 is off the board: both re-sent (${T.state.items.a.at}, ${T.state.items.b.at})`);
    }
  }
  ok(T.state.items.e.at === undefined && [...T.byAt.keys()].every((k) => !k.startsWith('MP:')), 'the man on the deleted map has no address, and byAt holds none of the map\'s');

  section('(9) a table resize shifts everything alike; addresses follow by containment');
  {
    const was = Object.fromEntries(Object.entries(T.state.items).map(([id, it]) => [id, [it.x, it.y]])), ats = Object.fromEntries(Object.entries(T.state.items).map(([id, it]) => [id, it.at]));
    const r = act(T, HOST, { t: 'table', shape: 'rect', w: 5600, h: 4000 });
    const shifted = Object.entries(T.state.items).filter(([id, it]) => !(near(it.x, was[id][0] + 300) && near(it.y, was[id][1] + 200))).map(([id]) => id);
    ok(!r.notes.length && !shifted.length, `every item (boards too) shifted by (300, 200) ${J(shifted)}`);
    ok(Object.entries(T.state.items).every(([id, it]) => it.at === (ats[id] === undefined ? undefined : ats[id])) && !containmentProblems(T).length,
      `every address kept (all moved together) and agrees with containment ${J(containmentProblems(T))}`);
  }
  {
    // a board at the far edge is clamped harder than the piece on it: the piece's spot follows by containment
    script(T, (t) => t.move('WD', 4700, 1500));
    script(T, (t) => t.move('h', 'WD:2,1'));
    const tb0 = T.state.table, was = Object.fromEntries(Object.entries(T.state.items).map(([id, it]) => [id, { ...it }]));
    const r = act(T, HOST, { t: 'table', shape: 'rect', w: 4000, h: 3000 }), tb = T.state.table, dx = (tb.w - tb0.w) / 2, dy = (tb.h - tb0.h) / 2;
    const off = Object.entries(T.state.items).filter(([id, it]) => {
      const o = was[id], { w, h } = core.sizeOf(o, T.state.boxes), q = clampToTable(tb, o.x + dx, o.y + dy, w, h);
      return !(near(it.x, q.x) && near(it.y, q.y));
    }).map(([id]) => id);
    ok(!r.notes.length && !off.length, `shrunk to 4000 × 3000: each item shifted by (${dx}, ${dy}) then clamped, nothing more ${J(off)}`);
    ok(!containmentProblems(T).length && T.state.items.h.at !== 'WD:2,1', `the wide board was clamped harder than h: h's address re-read by containment (${T.state.items.h.at}) ${J(containmentProblems(T))}`);
  }
  {
    const was = places(T);
    const r = act(T, HOST, { t: 'move', id: 'RK', x: 650, y: 150 }); // a board dropped onto another board does not snap
    ok(!r.notes.length && isDeepStrictEqual(places(T), was) && T.state.items.RK.at === undefined && near(T.state.items.RK.x, 650) && near(T.state.items.RK.y, 150),
      'a board moved onto another board lies where it was dropped, with no address (boards never snap)');
    ok(!containmentProblems(T).length, `pieces under the rack now read the rack's zones, and the topmost board's spots ${J(containmentProblems(T))}`);
  }
  section('(9) the indexes after a delete');
  {
    const r = act(T, HOST, { t: 'del', id: 'CB' });
    ok(!r.notes.length && [...T.byAt.keys()].every((k) => !k.startsWith('CB:')) && ['a', 'b', 'c'].every((id) => T.state.items[id].at === undefined) && !containmentProblems(T).length,
      'deleting the chess board leaves its pieces where they were, with no address, and none of its spots in byAt');
  }
}

// =============================================================================
// (10) Action preparation: a.to, a.from and a.pick before the hooks
// =============================================================================
function testPrepare() {
  section('(10) move: the host sets a.to and a.from before validate and onAction; a payload to is overwritten');
  const hands = { [BOB]: [{ t: ref('tile'), f: 1 }, { d: DK, i: 5 }, { t: ref('tile'), f: 0 }] };
  const T0 = table({ CB: BRD('chess', 700, 100) }, { rules: false });
  const on = (s, t = 'man') => tl(T0, t, refAt(T0, 'CB', s));
  const T = table({
    CB: BRD('chess', 700, 100), mv: PC('man', on('e2').x, on('e2').y),
    sb: SUP('big', 100, 2000), sh: SUP('spy', 400, 2000, { up: false }), st: PC('gem', on('b7', 'gem').x, on('b7', 'gem').y, { n: 3 }),
    bg: BAG([{ t: 'man' }, { t: 'big' }, { t: 'gem', f: 1 }, { t: 'gem', f: 2 }, { t: 'spy', up: false }, { t: 'tile', f: 1 }], 700, 2000),
    tp: PILE([{ t: ref('tile'), f: 0, up: true }, { t: ref('tile'), f: 1, up: true }], 1000, 2000),
  }, { hands });
  const seen = [];
  G.validate = (t, a) => { seen.push({ hook: 'validate', ...json(a) }); return G.veto; };
  G.onAction = (t, a) => { if (a.t !== 'rulesBtn') seen.push({ hook: 'onAction', ...json(a) }); };
  const hooksSaw = (pred) => seen.filter((x) => x.hook === 'validate').every(pred) && seen.filter((x) => x.hook === 'onAction').every(pred) && seen.some((x) => x.hook === 'onAction');
  const P = (s, t = 'man') => tl(T, t, refAt(T, 'CB', s));
  let q = P('e4');
  let r = act(T, BOB, { t: 'move', id: 'mv', x: q.x + 12, y: q.y + 20, to: 'h8', from: 'a1' });
  ok(seen.length === 2 && hooksSaw((a) => a.to === 'e4' && a.from === 'e2') && T.state.items.mv.at === 'CB:e4', `validate and onAction both see a.to "e4", a.from "e2" (the forged to "h8", from "a1" overwritten): ${J(seen.map((x) => [x.hook, x.to, x.from]))}`);
  seen.length = 0;
  r = act(T, BOB, { t: 'move', id: 'mv', x: 200, y: 1500, to: 'e4' });
  ok(seen.length === 2 && hooksSaw((a) => a.to === undefined && a.from === 'e4') && T.state.items.mv.at === undefined && J(r.log) === J(['moved Man from e4']),
    `a move off the board: a.to undefined (the payload's "e4" dropped), a.from "e4"; logged "moved Man from e4" (${J(seen.map((x) => [x.to, x.from]))}, ${J(r.log)})`);
  seen.length = 0;
  q = P('d4');
  r = act(T, BOB, { t: 'move', id: 'mv', x: q.x - 25, y: q.y + 30 });
  ok(hooksSaw((a) => a.to === 'd4' && a.from === undefined) && J(r.log) === J(['moved Man to d4']), `onto the board: a.to "d4", no a.from; "moved Man to d4" (${J(r.log)})`);
  seen.length = 0;
  G.veto = 'not there';
  q = P('d5');
  r = act(T, BOB, { t: 'move', id: 'mv', x: q.x, y: q.y });
  ok(seen.length === 1 && seen[0].to === 'd5' && seen[0].from === 'd4' && T.state.items.mv.at === 'CB:d4' && J(r.notes) === J(['🚫 not there']), `a veto sees a.to "d5" and a.from "d4", and the man stays on d4 (${J(seen.map((x) => [x.to, x.from]))})`);
  delete G.veto;

  section('(10) take, split and play: a.to is where the PROSPECTIVE piece would snap, in its type\'s size (its back\'s when hidden)');
  seen.length = 0;
  // top-left (1140, 360): a 180-wide piece's centre (1230, 450) is on f5; an 80-wide one's (1180, 400) on e6
  const RB = refBoards(T.state.items, T.state.boxes), forBig = refSnap(RB, 1140 + 90, 360 + 90), forMan = refSnap(RB, 1140 + 40, 360 + 40);
  ok(forBig?.local === 'f5' && forMan && forMan.local !== 'f5', `(the probe discriminates: a big piece there lands on ${forBig?.local}, a man-sized one would land on ${forMan?.local})`);
  let ids = Object.keys(T.state.items);
  r = act(T, BOB, { t: 'take', id: 'sb', x: 1140, y: 360, to: 'a1' });
  let nid = newIds(T, ids)[0];
  ok(hooksSaw((a) => a.to === 'f5' && a.from === undefined) && T.state.items[nid]?.at === 'CB:f5' && J(r.log) === J(['took Big from the Big supply to f5']),
    `take from a supply of 180-wide pieces: a.to "f5" (its own size), and there it lands (${J(seen.map((x) => x.to))}, ${T.state.items[nid]?.at}, ${J(r.log)})`);
  seen.length = 0;
  ids = Object.keys(T.state.items);
  q = P('g2', 'spy');
  r = act(T, BOB, { t: 'take', id: 'sh', x: q.x + 20, y: q.y + 20 });
  nid = newIds(T, ids)[0];
  ok(hooksSaw((a) => a.to === 'g2') && T.state.items[nid]?.up === false && T.state.items[nid]?.at === 'CB:g2' && pubAt(T, nid) === 'g2' && !('t' in T.pub.get(nid)),
    `take from a hidden supply: a.to "g2" by the back's size; the hidden piece's address is public, its type is not (${J(T.pub.get(nid))})`);
  seen.length = 0;
  ids = Object.keys(T.state.items);
  q = P('c6', 'gem');
  r = act(T, BOB, { t: 'split', id: 'st', n: 1, x: q.x + 15, y: q.y - 15 });
  nid = newIds(T, ids)[0];
  ok(hooksSaw((a) => a.to === 'c6') && T.state.items[nid]?.at === 'CB:c6' && T.state.items.st.n === 2, `split one off a ×3 stack: a.to "c6" for the new piece, which lands there (${J(seen.map((x) => [x.to, x.from]))})`);
  seen.length = 0;
  ids = Object.keys(T.state.items);
  q = P('h1', 'tile');
  r = act(T, BOB, { t: 'play', idx: 0, type: ref('tile'), f: 1, x: q.x - 30, y: q.y + 30, up: true, to: 'a8' });
  nid = newIds(T, ids)[0];
  ok(hooksSaw((a) => a.to === 'h1') && T.state.items[nid]?.at === 'CB:h1' && T.state.items[nid].f === 1, `play a tile from the hand: a.to "h1", where it lands (${J(seen.map((x) => x.to))})`);
  seen.length = 0;
  q = P('h2');
  r = act(T, BOB, { t: 'play', idx: 0, d: DK, i: 5, x: q.x, y: q.y, up: true, to: 'h2' });
  ok(hooksSaw((a) => a.to === undefined), `play a card onto the board: no a.to (cards never snap; the payload's "h2" dropped) (${J(seen.map((x) => x.to))})`);

  section('(10) pull: the member is drawn first (a.pick), a.to is for it, and the default effect takes exactly of[a.pick]; a veto leaves the bag unchanged');
  const picks = [];
  for (let k = 0; k < 6; k++) {
    seen.length = 0;
    const of0 = json(T.state.items.bg.of), x = 1140, y = 760; // a big member's centre (1230, 850) lies on f1, a man's (1180, 800) on e2
    ids = Object.keys(T.state.items);
    G.veto = k === 2 ? 'not yet' : undefined;
    r = act(T, BOB, { t: 'pull', id: 'bg', x, y, pick: 0, to: 'a1' });
    const v = seen.find((s) => s.hook === 'validate'), pick = v?.pick;
    if (k === 2) {
      ok(Number.isInteger(pick) && isDeepStrictEqual(T.state.items.bg.of, of0) && !newIds(T, ids).length && J(r.notes) === J(['🚫 not yet']),
        `a vetoed pull saw a.pick ${pick}, and the bag is unchanged (same members, same order), nothing placed`);
      continue;
    }
    nid = newIds(T, ids)[0];
    const m = of0[pick], it = T.state.items[nid], RB2 = refBoards(T.state.items, T.state.boxes), { w, h } = sizeIn(T, m), want = refSnap(RB2, x + w / 2, y + h / 2);
    const rest = of0.filter((_, j) => j !== pick);
    ok(Number.isInteger(pick) && pick >= 0 && pick < of0.length && it && it.t === m.t && it.f === m.f && (it.up === false) === (m.up === false) && isDeepStrictEqual(T.state.items.bg.of, rest),
      `pull #${k + 1}: a.pick ${pick} of ${of0.length}, and the piece placed is exactly of[${pick}] (${m.t.slice(m.t.indexOf('/') + 1)} face ${m.f}${m.up === false ? ', hidden' : ''}), the rest stay in order`);
    ok(v.to === (want ? refDisplay(RB2, want.at) : undefined) && it.at === want?.at && hooksSaw((a) => a.pick === pick && a.to === v.to && a.from === undefined),
      `pull #${k + 1}: a.to "${v.to}" is where that member (${w} wide) snaps, and where it lands (${it.at}); onAction sees the same`);
    picks.push(pick);
  }
  delete G.veto;
  ok(picks.some((p) => p !== 0), `the payload's pick (0) is never the host's: the picks were ${J(picks)}`);
  seen.length = 0;
  {
    const T2 = table({ hb: BAG([{ t: 'tile', f: 0 }, { t: 'tile', f: 1 }], 100, 2000, { hand: true }) });
    const s2 = [];
    G.validate = (t, a) => { s2.push(json(a)); };
    const of0 = json(T2.state.items.hb.of);
    act(T2, BOB, { t: 'pull', id: 'hb', hand: true });
    const pick = s2[0]?.pick, hand = T2.state.players[BOB].hand;
    ok(Number.isInteger(pick) && s2[0].to === undefined && hand.length === 1 && hand[0].t === of0[pick].t && hand[0].f === of0[pick].f,
      `a pull into the hand: a.pick ${pick}, no a.to, and the hand gets exactly of[a.pick] (${J(hand)})`);
  }
}

// =============================================================================
// (F) The facade rows of 3A (§3e): components from code and the spatial helpers
// =============================================================================
const CODE_BOX = {
  name: 'Code box',
  pieces: [
    { id: 'board', kind: 'board', w: 500, rotStep: 45, grid: { type: 'square', cols: 4, rows: 4, cell: 100, x: 50, y: 50, labels: 'chess' } },
    { id: 'pawn', kind: 'token', faces: ['P', 'Q'] },
    { id: 'card', kind: 'tile', back: 'cb', faces: ['X'] },
  ],
  backs: [{ id: 'cb', color: '#224466' }],
};

function testComponents() {
  section('(F) t.newBox: registered once (src: script, broadcast on boxes), deduplicated by content, decks too, no images');
  const T = table();
  let r = script(T, (t) => t.newBox(CODE_BOX));
  const id = r.ret, box = T.state.boxes[id];
  ok(typeof id === 'string' && box && T.state.boxSrc[id]?.src === 'script' && r.fx.some((e) => e.t === 'box' && e.id === id),
    `a new box: its id, in the catalog with src "script", sent on the boxes channel (${id}, ${J(T.state.boxSrc[id])})`);
  ok(J(r.rules) === J(['defined the box «Code box» (3 piece types)']), `logged "defined the box «Code box» (3 piece types)" (${J(r.rules)})`);
  ok(box?.types.board.rotStep === 90 && box.types.board.board?.grid?.cols === 4 && box.types.card.back === 'cb' && box.types.pawn.name === 'pawn',
    `the game.json shape: a board's structure on its piece (rotStep forced to 90), backs as a list, names default to ids (${J(box?.types.board.rotStep)})`);
  const nBoxes = Object.keys(T.state.boxes).length;
  r = script(T, (t) => t.newBox(json(CODE_BOX)));
  ok(r.ret === id && Object.keys(T.state.boxes).length === nBoxes && !r.log.length && !r.fx.some((e) => e.t === 'box'), `the same box again (a reset re-running setup): the same id, nothing registered, sent or logged (${r.ret})`);
  r = script(T, (t) => t.newBox({ ...json(CODE_BOX), pieces: [...CODE_BOX.pieces.slice(1), CODE_BOX.pieces[0]] }));
  ok(r.ret === id && !r.log.length, 'the same content in another order is the same box (boxKey)');
  const DECKS = { name: 'With decks', pieces: [{ id: 'pawn', kind: 'token', faces: ['P'] }], decks: [{ name: 'Events', back: '#112233', cards: [{ name: 'Storm', text: 'Lose a turn' }, { name: 'Calm', count: 2 }] }] };
  const nDecks = Object.keys(T.state.decks).length;
  r = script(T, (t) => t.newBox(DECKS));
  const dbox = T.state.boxes[r.ret], did = dbox?.decks?.Events;
  ok(did && T.state.decks[did]?.cards.length === 3 && r.fx.some((e) => e.t === 'deck' && e.id === did) && Object.keys(T.state.decks).length === nDecks + 1,
    `decks: registered as ordinary decks, named in the box's decks (Events → ${did}, ${T.state.decks[did]?.cards.length} cards)`);
  const before = Object.keys(T.state.decks).length;
  r = script(T, (t) => t.newBox(json(DECKS)));
  ok(T.state.boxes[r.ret] === dbox && Object.keys(T.state.decks).length === before && !r.log.length && !r.fx.length, 'the same box with its decks again: the same box, no new deck, nothing logged or sent');
  for (const [what, def] of [
    ['a face image', { pieces: [{ id: 'p', kind: 'token', faces: [{ img: 0 }] }] }],
    ['an img shorthand on a piece', { pieces: [{ id: 'p', kind: 'token', img: 'p.png', faces: ['P'] }] }],
    ['a back image', { pieces: [{ id: 'p', kind: 'token', back: 'b', faces: ['P'] }], backs: [{ id: 'b', img: 'b.png' }] }],
    ['a deck card image', { pieces: [{ id: 'p', kind: 'token', faces: ['P'] }], decks: [{ name: 'D', cards: [{ name: 'x', img: 'x.png' }] }] }],
    ['no def', undefined], ['a string', 'box'], ['pieces that are no list', { pieces: 'pawn' }], ['a piece with no id', { pieces: [{ kind: 'token', faces: ['P'] }] }],
    ['an unknown kind', { pieces: [{ id: 'p', kind: 'card', faces: ['P'] }] }], ['an unknown field', { pieces: [{ id: 'p', kind: 'token', faces: ['P'] }], rules: 'x' }],
  ]) typeErr(T, 't.newBox', (t) => t.newBox(def), what);
  ok(Object.keys(T.state.boxes).length === nBoxes + 1, 'none of the refused boxes reached the catalog');
  r = script(T, (t) => { const pid = t.spawn(`${id}/pawn`, { at: 'center' }); return [pid, t.item(pid)?.t]; });
  ok(typeof r.ret?.[0] === 'string' && r.ret[1] === `${id}/pawn`, `its types spawn by "box/type" (${J(r.ret)})`);

  section('(F) t.spawn: a piece or supply of a type, placed by address, centre or {x, y, free}; TypeErrors; false at the cap');
  const T2 = table({ CB: BRD('chess', 700, 100), m: PC('man', 100, 3000) });
  const e4 = refAt(T2, 'CB', 'e4');
  r = script(T2, (t) => { const a = t.spawn(ref('man'), { at: 'e4' }), b = t.spawn(ref('gem'), { at: 'CB:e5', f: 2, n: 4, owner: BOB }), c = t.spawn(ref('man'), { as: 'supply', at: 'e6' }); return [a, b, c]; });
  const [sa, sb, sc] = r.ret || [];
  const A = T2.state.items, ca = sa && centre(T2, sa);
  ok(A[sa]?.at === 'CB:e4' && near(ca.x, e4.x) && near(ca.y, e4.y) && A[sb]?.at === 'CB:e5' && A[sb].f === 2 && A[sb].n === 4 && A[sb].owner === BOB,
    `t.spawn at an address: centred, addressed; f, n and owner taken (${A[sa]?.at}, ${A[sb]?.at} ×${A[sb]?.n})`);
  ok(A[sc]?.k === 's' && A[sc].at === undefined && near(centre(T2, sc).x, refAt(T2, 'CB', 'e6').x) && near(centre(T2, sc).y, refAt(T2, 'CB', 'e6').y),
    'as: supply: centred on the address (an address centres any item), but only pieces get one');
  ok(r.rules.length === 3 && r.rules[0].startsWith('placed Man') && r.rules[1].startsWith('placed C ×4') && r.rules.every((l) => !/ \d+ pieces:/.test(l)),
    `three spawns: three "placed …" lines (under 4: not aggregated) (${J(r.rules)})`);
  r = script(T2, (t) => [t.spawn(ref('man')), t.spawn(ref('man'), { at: { x: 1135, y: 525, free: true } }), t.spawn(ref('man'), { at: { x: 1135, y: 525 } })]);
  const [cc, ff, gg] = r.ret || [];
  ok(near(centre(T2, cc).x, 2500) && near(centre(T2, cc).y, 1800) && A[cc].at === undefined, `no at: the table's centre (${J(centre(T2, cc))})`);
  ok(A[ff].at === undefined && A[ff].x === 1135 && A[ff].y === 525 && A[gg].at === 'CB:e4' && near(centre(T2, gg).x, e4.x), 'at {x, y, free: true}: exactly there, no address; {x, y}: snapped (e4)');
  r = script(T2, (t) => t.spawn(ref('plain'), { at: { x: 1135, y: 525 } }));
  ok(A[r.ret]?.z < 0 && A[r.ret].lock === true && A[r.ret].x === 1135 && A[r.ret].at === undefined, 'a board: the boards\' band, locked by default, never snapped');
  for (const [what, fn] of [['an unknown type', (t) => t.spawn('nobox/man')], ['a bare type id', (t) => t.spawn('man')], ['a face out of range', (t) => t.spawn(ref('gem'), { f: 3 })],
    ['n on a type that does not stack by count', (t) => t.spawn(ref('man'), { n: 2 })], ['n = 1000', (t) => t.spawn(ref('gem'), { n: 1000 })], ['up: false without a back', (t) => t.spawn(ref('man'), { up: false })],
    ['no such address', (t) => t.spawn(ref('man'), { at: 'z9' })], ['at {x: "a"}', (t) => t.spawn(ref('man'), { at: { x: 'a', y: 1 } })], ['as: bag', (t) => t.spawn(ref('man'), { as: 'bag' })],
    ['an owner who is nobody', (t) => t.spawn(ref('man'), { owner: 'nobody' })], ['o = 5', (t) => t.spawn(ref('man'), 5)]]) typeErr(T2, 't.spawn', fn, what);
  {
    const full = Object.fromEntries(range(core.MAX_ITEMS).map((k) => [`c${k}`, CARD(k % 52, 100 + (k % 50) * 20, 100 + Math.floor(k / 50) * 20)]));
    const T3 = table(full);
    r = script(T3, (t) => t.spawn(ref('man'), { at: 'center' }));
    ok(r.ret === false && Object.keys(T3.state.items).length === core.MAX_ITEMS, `at the item cap (${core.MAX_ITEMS}) t.spawn returns false and places nothing`);
  }

  section('(F) t.newBag, t.take, t.pull');
  r = script(T2, (t) => t.newBag([{ t: ref('gem'), f: 1, n: 3 }, { t: ref('spy'), up: false }], { name: 'Loot', at: 'center' }));
  const bag = A[r.ret];
  ok(bag?.k === 'b' && bag.of.length === 4 && bag.of[3].up === false && bag.name === 'Loot' && bag.hand === undefined && J(r.rules) === J(['made the bag Loot (4 pieces)']),
    `t.newBag: a bag of 4 (one hidden), not for hands (gems aren't); "made the bag Loot (4 pieces)" (${J(r.rules)})`);
  r = script(T2, (t) => A[t.newBag([], { hand: true })]?.hand);
  ok(r.ret === true, 'an empty bag made for hands keeps hand: true');
  for (const [what, fn] of [['contents that are no list', (t) => t.newBag('gem')], ['an unknown type', (t) => t.newBag([{ t: 'x/y' }])], ['a face out of range', (t) => t.newBag([{ t: ref('gem'), f: 7 }])],
    ['n = 0', (t) => t.newBag([{ t: ref('gem'), n: 0 }])], ['1,001 pieces', (t) => t.newBag([{ t: ref('gem'), n: 1001 }])], ['up: false without a back', (t) => t.newBag([{ t: ref('gem'), up: false }])],
    ['hand: "yes"', (t) => t.newBag([], { hand: 'yes' })], ['a name that is no string', (t) => t.newBag([], { name: 5 })]]) typeErr(T2, 't.newBag', fn, what);
  const T4 = table({ CB: BRD('chess', 700, 100), sm: SUP('man', 100, 3000), st: SUP('tile', 300, 3000), bg: BAG([{ t: 'man' }, { t: 'man' }, { t: 'big' }], 500, 3000), hb: BAG(['tile', 'tile'], 700, 3000, { hand: true }) });
  const B4 = T4.state.items;
  r = script(T4, (t) => [t.take('sm', { at: 'e4' }), t.take('st', { to: BOB }), t.take('sm')]);
  const [tk, th, tn] = r.ret || [];
  ok(B4[tk]?.at === 'CB:e4' && near(centre(T4, tk).x, refAt(T4, 'CB', 'e4').x) && r.rules[0] === 'took Man from the Man supply to e4',
    `t.take(supply, {at}): a new piece centred on that address; logged "took Man from the Man supply to e4" (${J(r.rules[0])})`);
  ok(th?.hand === true && th.t === ref('tile') && T4.state.players[BOB].hand.length === 1 && typeof tn === 'string' && B4[tn].at === undefined,
    `t.take(supply, {to}): into that hand ({hand: true, t, f}); with no at, next to the supply (${J(th)})`);
  r = script(T4, (t) => [t.pull('bg', { at: 'f3' }), t.pull('hb', { to: CAROL })]);
  const [pl, ph] = r.ret || [];
  ok(B4[pl]?.at === 'CB:f3' && near(centre(T4, pl).x, refAt(T4, 'CB', 'f3').x) && near(centre(T4, pl).y, refAt(T4, 'CB', 'f3').y) && B4.bg.of.length === 2 && /^drew (Man|Big) from the bag Sack to f3$/.test(r.rules[0]),
    `t.pull(bag, {at}): a random member, centred on the address by its own size; logged as a human pull (${J(r.rules[0])})`);
  ok(ph?.hand === true && T4.state.players[CAROL].hand.length === 1 && B4.hb.of.length === 1, 't.pull(bag, {to}): into that player\'s hand');
  for (const [name, fn, what] of [['t.take', (t) => t.take('sm', 5), 'o = 5'], ['t.take', (t) => t.take('sm', { to: 'nobody' }), 'a player who is nobody'], ['t.take', (t) => t.take('sm', { at: 'e4', to: BOB }), 'both at and to'],
    ['t.take', (t) => t.take('sm', { at: 'z9' }), 'no such address'], ['t.take', (t) => t.take('bg'), 'a bag'], ['t.take', (t) => t.take(5), 'an id that is no string'],
    ['t.pull', (t) => t.pull('sm'), 'a supply'], ['t.pull', (t) => t.pull('bg', { at: 'nowhere' }), 'no such address'], ['t.pull', (t) => t.pull('bg', 'x'), 'o = "x"']]) typeErr(T4, name, fn, what);

  section('(F) t.setFace, t.setCount, t.lock, t.setOwner, t.setSeats, t.setTable');
  const T5 = table({ g: PC('gem', 100, 100), d: PC('die', 300, 100), m: PC('man', 500, 100), c: CARD(1, 700, 100) });
  const I5 = T5.state.items;
  r = script(T5, (t) => [t.setFace('g', 2), t.setFace('d', 5), t.setFace('g', 2)]);
  ok(J(r.ret) === J([true, true, true]) && I5.g.f === 2 && I5.d.f === 5 && r.rules.length === 2 && r.rules[0].startsWith('turned A to C') && !r.fx.some((e) => e.t === 'fx' && e.f.roll),
    `t.setFace: any piece (a die too, never rolled), true; one "turned …" line per change (${J(r.rules)})`);
  for (const [what, fn] of [['a face out of range', (t) => t.setFace('g', 3)], ['a face that is no integer', (t) => t.setFace('g', '1')], ['a card', (t) => t.setFace('c', 0)], ['an id that is no string', (t) => t.setFace(7, 0)]]) typeErr(T5, 't.setFace', fn, what);
  r = script(T5, (t) => [t.setCount('g', 5), I5.g.n, t.setCount('g', 1), I5.g.n ?? null, t.setCount('g', 0), 'g' in I5]);
  ok(J(r.ret) === J([true, 5, true, null, true, false]), `t.setCount: 5 → ×5; 1 → no n; 0 removes it (${J(r.ret)})`);
  for (const [what, fn] of [['n = 1000', (t) => t.setCount('m', 1000)], ['n = -1', (t) => t.setCount('m', -1)], ['n = 2.5', (t) => t.setCount('m', 2.5)], ['n ≥ 2 on a type that does not stack by count', (t) => t.setCount('m', 2)]]) typeErr(T5, 't.setCount', fn, what);
  r = script(T5, (t) => [t.lock('m', true), I5.m.lock, t.lock('m', false), I5.m.lock ?? null]);
  ok(J(r.ret) === J([true, true, true, null]) && r.rules.length === 2, `t.lock: true, locked; then unlocked (${J(r.ret)}, ${J(r.rules)})`);
  typeErr(T5, 't.lock', (t) => t.lock('m', 'yes'), 'on = "yes"');
  r = script(T5, (t) => [t.setOwner('m', BOB), I5.m.owner, t.setOwner('m', null), I5.m.owner ?? null]);
  ok(J(r.ret) === J([true, BOB, true, null]), `t.setOwner: to Bob, then to nobody (${J(r.ret)})`);
  for (const [what, fn] of [['a player who is nobody', (t) => t.setOwner('m', 'nobody')], ['a seat that does not exist', (t) => t.setOwner('m', 'seat:white')], ['an owner that is a number', (t) => t.setOwner('m', 5)]]) typeErr(T5, 't.setOwner', fn, what);
  r = script(T5, (t) => t.setSeats([{ id: 'white', name: 'White' }, { id: 'black', name: 'Black', edge: 'top' }]));
  ok(r.rules[0]?.startsWith('set the seats: White — Alice, Black — Bob') && T5.state.players[HOST].seatId === 'white' && T5.state.players[BOB].seatId === 'black',
    `t.setSeats: "set the seats: White — Alice, Black — Bob…" (${J(r.rules)})`);
  r = script(T5, (t) => [t.setOwner('m', 'seat:white'), I5.m.owner]);
  ok(r.ret?.[1] === 'seat:white', 'a seat-bound owner once the seat exists');
  for (const [what, fn] of [['a seat with a bad id', (t) => t.setSeats([{ id: 'a b', name: 'X' }])], ['seats that are no list', (t) => t.setSeats('white')]]) typeErr(T5, 't.setSeats', fn, what);
  r = script(T5, (t) => t.setSeats(null));
  ok(T5.state.seats === null && r.rules[0] === 'removed the named seats: everyone sits where they like' && T5.state.items.m.owner === undefined,
    `t.setSeats(null): automatic seating; what the gone seat owned is released (${J(r.rules)})`);
  r = script(T5, (t) => t.setTable({ shape: 'rect', w: 3000, h: 2000 }));
  ok(T5.state.table.w === 3000 && J(r.rules) === J(['set the table to a 3000 × 2000 rectangle']), `t.setTable: logged as the table action (${J(r.rules)})`);
  for (const [what, fn] of [['a hex table', (t) => t.setTable({ shape: 'hex', w: 3000, h: 2000 })], ['a round table of 1500', (t) => t.setTable({ shape: 'round', w: 1500 })], ['no def', (t) => t.setTable()]]) typeErr(T5, 't.setTable', fn, what);

  section('(F) a vanished item: false, never a throw');
  r = script(T5, (t) => { t.remove('d'); return [t.move('d', 'e4'), t.move('d', { x: 1, y: 1 }), t.move('d', 100, 100), t.where('d'), t.zones('d'), t.setFace('d', 1), t.setCount('d', 2), t.lock('d', true), t.setOwner('d', null), t.take('d'), t.pull('d')]; });
  ok(!r.err && J(r.ret) === J(Array(11).fill(false)), `t.move (each form), t.where, t.zones, t.setFace, t.setCount, t.lock, t.setOwner, t.take, t.pull on a removed item: false (${r.err?.message || J(r.ret)})`);
}

function testSpatialFacade() {
  section('(F) t.move, t.where, t.at, t.find, t.zones, t.spot, t.neighbors, t.distance, t.line, t.linked');
  const T = table({
    CB: BRD('chess', 700, 100), MP: BRD('map', 1700, 100), RK: BRD('rack', 100, 100), DQ: BRD('dock', 100, 600),
    a: PC('man', 100, 3000), b: PC('man', 200, 3000), c: PC('gem', 130, 130), d: PC('gem', 330, 130), e: PC('man', 300, 3000), card: CARD(2, 500, 3000),
  });
  const I = T.state.items;
  let r = script(T, (t) => t.move('a', 'e4'));
  ok(r.ret === true && J(r.rules) === J(['moved Man to e4']), `t.move logs as a human move does, with its address (${J(r.rules)})`);
  r = script(T, (t) => [t.move('b', 'e4'), t.move('e', { x: 1131, y: 531 }), t.where('a'), t.where('card'), t.where('c')]);
  ok(J(r.ret) === J([true, true, 'e4', null, null]) && I.e.at === 'CB:e4', `t.move to an address and to {x, y} (snapped); t.where: the display address, null off any spot or for a card (${J(r.ret)})`);
  r = script(T, (t) => t.at('e4'));
  ok(J(r.ret?.map((x) => x.id)) === J(['a', 'b', 'e']) && r.ret.every((x) => x.at === 'e4') && r.ret[0].z < r.ret[1].z && r.ret[1].z < r.ret[2].z, `t.at("e4"): the three men, copies sorted by z, each at "e4" (${J(r.ret?.map((x) => [x.id, x.z]))})`);
  r = script(T, (t) => { const x = t.at('e4')[0]; x.x = -999; x.at = 'h8'; return [I.a.x !== -999, I.a.at]; });
  ok(J(r.ret) === J([true, 'CB:e4']), 't.at returns copies: changing one changes nothing');
  r = script(T, (t) => [t.move('a', { x: 1131, y: 531, free: true }), I.a.at ?? null, I.a.x, I.a.y, t.at('e4').map((x) => x.id)]);
  ok(J(r.ret) === J([true, null, 1131, 531, ['b', 'e']]), `t.move(id, {x, y, free: true}): exactly there, no address, out of byAt (${J(r.ret)})`);
  r = script(T, (t) => [t.move('a', 1131, 531), I.a.at]);
  ok(r.ret?.[1] === 'CB:e4', 't.move(id, x, y) still works, and snaps like every placement');
  r = script(T, (t) => [t.find({ at: 'e4' }).map((x) => x.id).sort(), t.find({ at: 'e4', kind: 'token' }).length, t.find({ zone: 'left' }).map((x) => x.id), t.find({ zone: 'rack:right' }).map((x) => x.id), t.find({ zone: 'RK:right' }).map((x) => x.id)]);
  ok(J(r.ret) === J([['a', 'b', 'e'], 3, ['c'], ['d'], ['d']]), `t.find({at}), with kind; t.find({zone}) by a bare zone id, a display or a qualified one (${J(r.ret)})`);
  typeErr(T, 't.find', (t) => t.find({ zone: 'nowhere' }), 'an unknown zone');
  typeErr(T, 't.find', (t) => t.find({ at: 'z9' }), 'no such address');
  r = script(T, (t) => [t.zones('c'), t.zones('a'), t.zones('card')]);
  ok(J(r.ret) === J([['rack:left'], [], []]), `t.zones: the zones holding the piece, in display form (${J(r.ret)})`);
  r = script(T, (t) => [t.spot('e4'), t.spot('map:c3'), t.spot('quay')]);
  const s1 = refAt(T, 'CB', 'e4'), s2 = refAt(T, 'MP', 'c3'), s3 = refAt(T, 'DQ', 'quay');
  ok(r.ret && near(r.ret[0].x, s1.x) && near(r.ret[0].y, s1.y) && near(r.ret[1].x, s2.x) && near(r.ret[1].y, s2.y) && near(r.ret[2].x, s3.x) && near(r.ret[2].y, s3.y), `t.spot: the centre, in table coordinates (${J(r.ret)})`);
  r = script(T, (t) => [t.neighbors('a1'), t.neighbors('e4', { diag: true }).length, t.neighbors('map:a1'), t.neighbors('quay'), t.neighbors('buoy')]);
  ok(r.ret && sameSet(r.ret[0], ['a2', 'b1']) && r.ret[1] === 8 && sameSet(r.ret[2], ['map:a2', 'map:b1']) && sameSet(r.ret[3], ['dock:pier']) && sameSet(r.ret[4], ['dock:pier']),
    `t.neighbors: in display form — the primary board's bare, the map's "map:…", a space's links (${J(r.ret)})`);
  r = script(T, (t) => [t.distance('a1', 'h8'), t.distance('a1', 'h8', { metric: 'manhattan' }), t.distance('e4', 'map:c3'), t.distance('quay', 'pier'), t.distance('map:a1', 'map:c3')]);
  ok(J(r.ret) === J([7, 14, null, null, 2]), `t.distance: chebyshev by default, manhattan on request; null across boards or for spaces (${J(r.ret)})`);
  r = script(T, (t) => [t.line('a1', 'd4'), t.line('map:a1', 'map:a4'), t.line('a1', 'b3'), t.line('e4', 'map:e5'), t.linked('quay'), t.linked('pier')]);
  ok(J(r.ret?.slice(0, 4)) === J([['b2', 'c3'], ['map:a2', 'map:a3'], null, null]) && sameSet(r.ret[4], ['dock:pier']) && sameSet(r.ret[5], ['dock:quay', 'dock:buoy']),
    `t.line in display form, null unaligned or across boards; t.linked undirected (${J(r.ret)})`);
  for (const [name, fn, what] of [
    ['t.move', (t) => t.move('a', 'z9'), 'no such address'], ['t.move', (t) => t.move('a', { x: 'a', y: 2 }), 'at {x: "a"}'], ['t.move', (t) => t.move(5, 'e4'), 'an id that is no string'],
    ['t.where', (t) => t.where(5), 'an id that is no string'], ['t.at', (t) => t.at('z9'), 'no such address'], ['t.at', (t) => t.at(5), 'an address that is no string'],
    ['t.zones', (t) => t.zones({}), 'an id that is no string'], ['t.spot', (t) => t.spot('z9'), 'no such address'], ['t.neighbors', (t) => t.neighbors('k11'), 'no such address'],
    ['t.distance', (t) => t.distance('a1', 'h8', { metric: 'euclid' }), 'an unknown metric'], ['t.distance', (t) => t.distance('a1', 'z9'), 'no such address'],
    ['t.line', (t) => t.line('a1', 'z9'), 'no such address'], ['t.linked', (t) => t.linked('nowhere'), 'no such address'],
  ]) typeErr(T, name, fn, what);
}

// =============================================================================
// (S) Snapping: every caller of §3a, free: true, only pieces, rotated boards
// =============================================================================
/** Whether item `id` lies centred on spot `local` of board `b`, with that qualified address. */
function snapped(T, id, b, local) {
  const it = T.state.items[id], P = refAt(T, b, local), c = it && centre(T, id);
  return !!it && it.at === `${b}:${local}` && near(c.x, P.x) && near(c.y, P.y);
}
const why = (T, id) => J(T.state.items[id] && { at: T.state.items[id].at, ...centre(T, id) });

function testSnappingCallers() {
  section('(S) snapping runs in place(), for every caller of §3a "When snapping runs"');
  const hands = { [BOB]: [{ t: ref('tile'), f: 0 }, { t: ref('tile'), f: 1 }, { t: ref('tile'), f: 0 }] };
  const T = table({
    CB: BRD('chess', 700, 100), mv: PC('man', 100, 3000), hid: PC('spy', 200, 3000, { up: false }),
    sm: SUP('man', 300, 3000), bg: BAG(['man', 'man', 'man'], 500, 3000), gs: PC('gem', 700, 3000, { n: 5 }),
    pp: PILE([{ t: ref('tile'), f: 0, up: true }, { t: ref('tile'), f: 1, up: true }, { t: ref('tile'), f: 0, up: true }, { t: ref('tile'), f: 1, up: true }], 900, 3000),
    card: CARD(7, 1100, 3000), sup: SUP('gem', 1300, 3000), sack: BAG(['gem'], 1500, 3000), tp: PILE([{ t: ref('tile'), f: 0, up: true }], 1700, 3000),
  }, { hands });
  /** The top-left of a piece of type t placed 18 right and 14 up of `local`'s centre. */
  const nearSpot = (t, local) => { const q = tl(T, t, refAt(T, 'CB', local)); return { x: q.x + 18, y: q.y - 14 }; };
  const last = (ids) => newIds(T, ids)[0];
  let ids, q, nid, r;
  q = nearSpot('man', 'c3');
  act(T, BOB, { t: 'move', id: 'mv', ...q });
  ok(snapped(T, 'mv', 'CB', 'c3'), `human move: centred on c3 ${why(T, 'mv')}`);
  q = nearSpot('spy', 'c2');
  act(T, BOB, { t: 'move', id: 'hid', ...q });
  ok(snapped(T, 'hid', 'CB', 'c2') && T.pub.get('hid').at === 'c2' && !('t' in T.pub.get('hid')), `human move of a hidden piece: snapped by its back's size; its address public, its type not ${J(T.pub.get('hid'))}`);
  for (const [what, t, a, local] of [
    ['human take', 'man', (p) => ({ t: 'take', id: 'sm', ...p }), 'c4'],
    ['human pull', 'man', (p) => ({ t: 'pull', id: 'bg', ...p }), 'c5'],
    ['human split', 'gem', (p) => ({ t: 'split', id: 'gs', n: 2, ...p }), 'c6'],
    ['human play (a piece)', 'tile', (p) => ({ t: 'play', idx: 0, type: ref('tile'), f: 0, up: true, ...p }), 'd3'],
    ['human deal from a piece pile', 'tile', (p) => ({ t: 'deal', id: 'pp', up: true, ...p }), 'd4'],
  ]) {
    ids = Object.keys(T.state.items);
    r = act(T, BOB, a(nearSpot(t, local)));
    nid = last(ids);
    ok(nid && snapped(T, nid, 'CB', local) && !r.notes.length, `${what}: the new piece is centred on ${local} ${nid ? why(T, nid) : J(r.notes)}`);
  }
  for (const [what, t, fn, local] of [
    ['t.move(id, x, y)', 'man', (t, p) => (t.move('mv', p.x, p.y), 'mv'), 'e3'],
    ['t.move(id, {x, y})', 'man', (t, p) => (t.move('mv', { x: p.x, y: p.y }), 'mv'), 'e4'],
    ['t.spawn(type, {at: {x, y}})', 'man', (t, p) => t.spawn(ref('man'), { at: p }), 'e5'],
    ['t.take(supply, {at: {x, y}})', 'man', (t, p) => t.take('sm', { at: p }), 'e6'],
    ['t.pull(bag, {at: {x, y}})', 'man', (t, p) => t.pull('bg', { at: p }), 'f3'],
    ['t.playFromHand(p, idx, {x, y})', 'tile', (t, p) => t.playFromHand(BOB, 0, { x: p.x, y: p.y }), 'f4'],
    ['t.deal(piece pile, {x, y})', 'tile', (t, p) => t.deal('pp', { x: p.x, y: p.y, up: true })?.id, 'f5'],
  ]) {
    const p = nearSpot(t, local);
    r = script(T, (tt) => fn(tt, p));
    ok(typeof r.ret === 'string' && snapped(T, r.ret, 'CB', local), `${what}: centred on ${local} ${typeof r.ret === 'string' ? why(T, r.ret) : J(r.ret ?? r.err?.message)}`);
  }

  section('(S) only pieces snap: cards, supplies, bags and piles stay where they are dropped');
  for (const id of ['card', 'sup', 'sack', 'tp']) {
    const it = T.state.items[id], { w, h } = core.sizeOf(it, T.state.boxes), P = refAt(T, 'CB', 'g5'), x = P.x - w / 2 + 18, y = P.y - h / 2 - 14;
    act(T, BOB, { t: 'move', id, x, y });
    ok(T.state.items[id].x === x && T.state.items[id].y === y && T.state.items[id].at === undefined && T.pub.get(id).at === undefined, `a ${{ c: 'card', s: 'supply', b: 'bag', p: 'pile' }[it.k]} moved over g5: exactly where dropped, no address`);
  }
  ok(!containmentProblems(T).length, `the whole table agrees with containment ${J(containmentProblems(T))}`);
  q = nearSpot('man', 'g3');
  r = script(T, (t) => [t.move('mv', { ...q, free: true }), t.spawn(ref('man'), { at: { ...q, free: true } })]);
  ok(T.state.items.mv.at === undefined && T.state.items.mv.x === q.x && T.state.items.mv.y === q.y && T.state.items[r.ret?.[1]]?.at === undefined && T.state.items[r.ret[1]].x === q.x,
    '{x, y, free: true} skips snapping (t.move, t.spawn): exactly there, no address (D105: until a board change re-reads it)');

  section('(S) setups snap (loadBox): the built-in draughts and backgammon');
  {
    const T2 = table({}, { table: { shape: 'rect', w: 2000, h: 2000 } });
    act(T2, HOST, { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true });
    const RB = refBoards(T2.state.items, T2.state.boxes), board = RB.list[0], men = Object.entries(T2.state.items).filter(([, it]) => it.z >= 0);
    const want = new Set();
    for (const r0 of [0, 1, 2, 5, 6, 7]) for (const c of range(8)) if ((c + r0) % 2 === 1) want.add(CHESS[c] + (8 - r0));
    const got = men.map(([id, it]) => T2.pub.get(id).at);
    ok(men.length === 24 && sameSet(got, [...want]) && men.every(([id, it]) => it.at === `${board.id}:${T2.pub.get(id).at}`) && !containmentProblems(T2).length,
      `draughts: its 24 men snap to the dark squares (${got.slice(0, 6).join(' ')} …), the board primary (bare addresses)`);
    act(T2, HOST, { t: 'loadBox', box: BOXES.backgammon, setup: true, clear: true });
    const counts = {};
    for (const [id, it] of Object.entries(T2.state.items)) if (it.z >= 0 && /checker/i.test(core.itemLabel(it, {}, T2.state.boxes))) { const k = `${T2.pub.get(id).at}:${it.t.endsWith('/light') ? 'L' : 'D'}`; counts[k] = (counts[k] || 0) + 1; }
    const START = { 'p24:L': 2, 'p13:L': 5, 'p8:L': 3, 'p6:L': 5, 'p1:D': 2, 'p12:D': 5, 'p17:D': 3, 'p19:D': 5 };
    ok(isDeepStrictEqual(counts, START), `backgammon: every checker snaps to its point of the standard start (${J(counts)})`);
    const p6 = Object.entries(T2.state.items).filter(([id]) => T2.pub.get(id).at === 'p6').map(([id]) => centre(T2, id));
    ok(p6.length === 5 && p6.every((c) => near(c.x, p6[0].x) && near(c.y, p6[0].y)), 'the state keeps all five checkers of p6 centred on its spot (fanned only when drawn, §3g)');
    const others = Object.entries(T2.state.items).filter(([, it]) => it.z >= 0 && !/checker/i.test(core.itemLabel(it, {}, T2.state.boxes)));
    ok(others.length === 3 && others.every(([, it]) => it.at === undefined), `the dice and the doubling cube lie off every space (D108: no address) (${J(others.map(([, it]) => it.at))})`);
    const pts = BOXES.backgammon.types.board.board.spaces.filter((s) => /^p\d+$/.test(s.id));
    ok(pts.length === 24 && pts.every((s) => (s.dir === 'up' || s.dir === 'down') && s.h > s.w && s.w > 0), 'every backgammon point has a dir (its fan direction, §3g) and its w × h');
  }

  section('(S) a structured board turned 90, 180 and 270°: a piece snaps through the inverse turn about its centre');
  for (const rot of [90, 180, 270]) {
    const T3 = table({ WD: BRD('wide', 1000, 700), CB: BRD('chess', 2400, 300), p: PC('man', 100, 3000) });
    act(T3, HOST, { t: 'rot', id: 'WD', rot });
    act(T3, HOST, { t: 'rot', id: 'CB', rot });
    let bad = '';
    for (const [b, local] of [['WD', '0,0'], ['WD', '5,0'], ['WD', '0,3'], ['WD', '5,3'], ['WD', '2,1'], ['CB', 'a1'], ['CB', 'h1'], ['CB', 'a8'], ['CB', 'e4']]) {
      const P = refAt(T3, b, local), qq = tl(T3, 'man', P);
      act(T3, BOB, { t: 'move', id: 'p', x: qq.x + 21, y: qq.y - 17 });
      if (!bad && !snapped(T3, 'p', b, local)) bad = `${b}:${local} at ${J(P)} → ${why(T3, 'p')}`;
    }
    ok(!bad, `turned ${rot}°: the corners and an inner cell of a 700 × 500 board with an off-centre grid, and of the chess board, snap where the turned drawing puts them ${bad}`);
  }

  section('(S) cleanBox: a structured board turns by quarter turns only (rotStep 90)');
  const rs = (board, rotStep) => cleanBox({ name: 'R', imgs: [], types: { b: { kind: 'board', name: 'B', w: 400, rotStep, ...(board && { board }) } } }).types.b.rotStep;
  ok(rs({ grid: { type: 'square', cols: 4, rows: 4, cell: 100, x: 0, y: 0 } }, 45) === 90 && rs({ spaces: [{ id: 's', x: 10, y: 10, r: 10 }] }, 15) === 90
    && rs({ zones: [{ id: 'z', poly: [[0, 0], [10, 0], [0, 10]] }] }, 0) === 90 && rs({ grid: { type: 'hex', cols: 4, rows: 4, cell: 60, x: 0, y: 0 } }, 60) === 90,
    'grid, spaces-only, zones-only and hex boards: rotStep forced to 90 (from 45, 15, 0, 60)');
  ok(rs(null, 45) === 45, 'a board with no structure keeps its rotStep (45)');
  {
    const T4 = table({ CB: BRD('chess', 700, 100) });
    act(T4, HOST, { t: 'rot', id: 'CB', rot: 30 });
    const a = T4.state.items.CB.rot;
    act(T4, HOST, { t: 'rot', id: 'CB', rot: 130 });
    ok([0, 90, 180, 270].includes(a) && [0, 90, 180, 270].includes(T4.state.items.CB.rot), `a structured board turned to 30° or 130° lands on a quarter turn (${a}, ${T4.state.items.CB.rot})`);
  }
}

// =============================================================================
// (6) MIGRATE[3] and the load-time gates
// =============================================================================
function v3save(extra = {}) {
  const T0 = table({ CB: BRD('chess', 700, 100) }, { rules: false }), on = (s, t, dx = 17, dy = -12) => { const q = tl(T0, t, refAt(T0, 'CB', s)); return [q.x + dx, q.y + dy]; };
  return {
    v: 3, seq: 9, table: { shape: 'rect', w: 5000, h: 3600 }, seats: null, boardSeq: 0, zMax: 0, keys: {}, log: [], guestDeckChars: 0,
    players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270) },
    items: {
      CB: BRD('chess', 700, 100), on: PC('man', ...on('e4', 'man')), hid: PC('spy', ...on('h8', 'spy'), { up: false }), off: PC('man', 100, 3000),
      stale: PC('man', 300, 3000, { at: 'CB:a1' }), card: CARD(1, ...on('d4', 'man')), sup: SUP('man', ...on('c4', 'man')), bag: BAG(['man'], ...on('b4', 'man')),
    },
    rules: {
      code: PROBE, name: 'P3 probe', enabled: true, public: { turn: 1 }, hints: { [BOB]: { items: ['on'] } }, secret: { [BOB]: { text: 'kept' } },
      data: { score: 3, _timers: [{ at: 1e12, tag: 'a' }, { at: NaN, tag: 'nan' }, { at: 'soon', tag: 'str' }, { at: 5, tag: 'x'.repeat(101) }, { at: 6, tag: 7 }, null, 'tick', { at: 2e12, tag: 'b', extra: 1 }] },
    },
    decks: { [DK]: core.standardDeck(false) }, boxes: { [BX]: cleanBox(SPACE_BOX) }, boxSrc: {},
    ...extra,
  };
}

function testMigrate() {
  section('(6) MIGRATE[3]: v3 → v4');
  const s = v3save(), was = json(s.items), q = quietly(() => MIGRATE[3](s));
  ok(s.v === 4 && STATE_V === 4 && PROTO === 4, `v = 4 (STATE_V ${STATE_V}, PROTO ${PROTO})`);
  ok(isDeepStrictEqual(s.rules.secret, { [BOB]: { text: 'kept' } }) && isDeepStrictEqual(s.rules.asks, {}) && !('hints' in s.rules) && s.rules.data.score === 3 && s.rules.public.turn === 1,
    `rules.secret ||= {} (an existing one kept), rules.asks ||= {}, rules.hints deleted, the rest untouched (${J(Object.keys(s.rules))})`);
  ok(isDeepStrictEqual(s.rules.data._timers.map((x) => [x.at, x.tag]), [[1e12, 'a'], [2e12, 'b']]) && q.error.length >= 1,
    `the _timers gate keeps the two good timers and drops the six bad ones (NaN, a string time, a 101-char tag, a numeric tag, null, a string) with console.error (${J(s.rules.data._timers)}; ${q.error.length} errors)`);
  const I = s.items;
  ok(I.on.at === 'CB:e4' && I.hid.at === 'CB:h8' && I.off.at === undefined && I.stale.at === undefined, `pieces get their address by containment (e4; the hidden one h8); off the board none, and a stray old "at" goes (${J([I.on.at, I.hid.at, I.off.at, I.stale.at])})`);
  ok(I.card.at === undefined && I.sup.at === undefined && I.bag.at === undefined && I.CB.at === undefined, 'cards, supplies, bags and boards get none');
  ok(Object.keys(was).every((id) => I[id].x === was[id].x && I[id].y === was[id].y && I[id].z === was[id].z), 'nothing moved: every x, y and z as saved (the man 17 units off e4 stays off-centre)');
  for (const [what, data, want] of [['_timers that is no list', { _timers: 'soon' }, undefined], ['1,500 good timers', { _timers: range(1500).map((k) => ({ at: k, tag: `t${k}` })) }, 1000]]) {
    const s2 = v3save(), qq = quietly(() => MIGRATE[3]((s2.rules.data = data, s2)));
    const n = s2.rules.data._timers?.length;
    ok(qq.error.length >= 1 && (want === undefined ? !n : n === want), `${what}: ${want === undefined ? 'dropped' : `cut to ${want}`}, with console.error (${n ?? 'none'} left)`);
  }
  {
    const s2 = v3save({ rules: null }), qq = quietly(() => MIGRATE[3](s2));
    ok(s2.v === 4 && s2.rules === null && s2.items.on.at === 'CB:e4' && !qq.error.length, 'a save with no rules migrates (rules stay null), quietly');
    const s3 = v3save();
    delete s3.rules.secret;
    quietly(() => MIGRATE[3](s3));
    ok(isDeepStrictEqual(s3.rules.secret, {}) && isDeepStrictEqual(s3.rules.asks, {}), 'missing secret and asks become {}');
  }
  {
    const s2 = v3save(), s3 = json(s2);
    s3.rules.data._timers = s2.rules.data._timers; // (JSON would turn NaN into null)
    quietly(() => { MIGRATE[3](s2); migrate(s3); });
    ok(isDeepStrictEqual(json(s2), json(s3)), 'migrate() runs MIGRATE[3] on a v3 save (the chain ends at STATE_V 4)');
  }
  section('(6) a v3 save resumed by createTable: addresses, indexes, the view');
  {
    const s2 = v3save(), xy = json(s2.items), qq = quietly(() => createTable(s2, env(5))), T = qq.value;
    ok(T.state.v === 4 && T.byAt.get('CB:e4')?.has('on') && T.pub.get('on').at === 'e4' && T.pub.get('hid').at === 'h8' && Object.keys(xy).every((id) => T.state.items[id].x === xy[id].x && T.state.items[id].y === xy[id].y),
      `v4, byAt built, the view's addresses in display form, nothing moved (${J([...T.byAt.keys()])})`);
    ok(!('hints' in T.state.rules) && T.state.rules.data._timers.length === 2, 'the resumed rules: no hints, the gated timers');
  }
  section('(6) loading a v4 save runs the _timers gate; a saved address naming no spot is dropped (D106)');
  {
    const s4 = v3save();
    quietly(() => MIGRATE[3](s4));
    s4.rules.data._timers = [{ at: 1, tag: 'ok' }, { at: Infinity, tag: 'inf' }, { tag: 'no time' }];
    s4.items.off.at = 'ZZ:e4';
    s4.items.stale.at = 'CB:z9';
    const qq = quietly(() => createTable(s4, env(6))), T = qq.value;
    ok(J(T.state.rules.data._timers) === J([{ at: 1, tag: 'ok' }]) && qq.error.some((e) => /_timers/.test(e)), `the bad timers of a v4 save are dropped on load, loudly (${J(T.state.rules.data._timers)})`);
    ok(T.state.items.off.at === undefined && T.state.items.stale.at === undefined && T.state.items.on.at === 'CB:e4' && qq.error.some((e) => /ZZ:e4/.test(e)),
      `an address on a board that isn't there ("ZZ:e4"), or no spot of its board ("CB:z9"), is dropped with console.error; a good one stands (${J(qq.error.filter((e) => !/_timers/.test(e)))})`);
    ok(!containmentProblems(T).length, `the indexes are built from the save (${J(containmentProblems(T))})`);
  }
}

// =============================================================================
// (5) Aggregation of Rules log lines
// =============================================================================
/** A chess board with 32 men on the first 32 squares (a8 … h5, reading order) and 6 gems off the board. */
function aggTable() {
  const T0 = table({ CB: BRD('chess', 700, 100) }, { rules: false }), items = { CB: BRD('chess', 700, 100) }, order = [];
  for (const r of range(4)) for (const c of range(8)) {
    const s = CHESS[c] + (8 - r), q = tl(T0, 'man', refAt(T0, 'CB', s));
    items[`m_${s}`] = PC('man', q.x, q.y);
    order.push(s);
  }
  for (const k of range(6)) items[`g${k}`] = PC('gem', 100 + 80 * k, 3000);
  for (const k of range(4)) items[`c${k}`] = CARD(10 + k, 100 + 120 * k, 3200);
  return { T: table(items), order };
}

function testAggregation() {
  section('(5) aggregation: a run of 4 or more Rules lines of one op in one action becomes one line (the first 8 addresses or labels)');
  let { T, order } = aggTable();
  let r = script(T, (t) => { for (const s of order.slice(0, 30)) t.remove(`m_${s}`); });
  ok(r.rules.length === 1 && r.rules[0] === `removed 30 pieces: ${order.slice(0, 8).join(', ')}, …`, `B16: 30 removals in one action write 1 line: "${r.rules[0]}"`);
  ({ T, order } = aggTable());
  r = script(T, (t) => { for (const s of order.slice(0, 4)) t.remove(`m_${s}`); });
  ok(J(r.rules) === J([`removed 4 pieces: ${order.slice(0, 4).join(', ')}`]), `exactly 4: one line, no "…" (${J(r.rules)})`);
  r = script(T, (t) => { for (const s of order.slice(4, 7)) t.remove(`m_${s}`); });
  ok(r.rules.length === 3 && r.rules.every((l, k) => l.startsWith('removed Man') && l.includes(order[4 + k])), `3 in a row stay 3 lines (${J(r.rules)})`);
  r = script(T, (t) => { for (const s of order.slice(7, 16)) t.remove(`m_${s}`); });
  ok(J(r.rules) === J([`removed 9 pieces: ${order.slice(7, 15).join(', ')}, …`]), `9: the first 8 named, then "…" (${J(r.rules)})`);
  r = script(T, (t) => { for (const s of order.slice(16, 20)) t.remove(`m_${s}`); t.say('between'); for (const s of order.slice(20, 24)) t.remove(`m_${s}`); });
  ok(J(r.rules) === J([`removed 4 pieces: ${order.slice(16, 20).join(', ')}`, 'between', `removed 4 pieces: ${order.slice(20, 24).join(', ')}`]),
    `another line ends a run: only consecutive lines merge (${J(r.rules)})`);
  r = script(T, (t) => { t.remove(`m_${order[24]}`); t.remove(`m_${order[25]}`); });
  const r2 = script(T, (t) => { t.remove(`m_${order[26]}`); t.remove(`m_${order[27]}`); });
  ok(r.rules.length === 2 && r2.rules.length === 2, `runs never span actions: 2 + 2 removals in two actions stay 4 lines (${J([...r.rules, ...r2.rules])})`);

  section('(5) aggregation: placed, turned, counted, locked, owner; moves never; cards and pieces mixed');
  ({ T, order } = aggTable());
  r = script(T, (t) => { for (const s of ['a1', 'b1', 'c1', 'd1', 'e1', 'f1']) t.spawn(ref('man'), { at: s }); });
  ok(J(r.rules) === J(['placed 6 pieces: a1, b1, c1, d1, e1, f1']), `t.spawn ×6: "placed 6 pieces: a1, …, f1", named by where they were placed (${J(r.rules)})`);
  r = script(T, (t) => { for (const k of range(5)) t.setFace(`g${k}`, 1 + (k % 2)); });
  ok(r.rules.length === 1 && /^turned 5 pieces: [ABC](, [ABC]){4}$/.test(r.rules[0]), `t.setFace ×5 (off the board): "turned 5 pieces: …", named by their labels (${J(r.rules)})`);
  r = script(T, (t) => { for (const k of range(4)) t.setCount(`g${k}`, 3 + k); });
  ok(r.rules.length === 1 && /^counted 4 pieces: /.test(r.rules[0]), `t.setCount ×4: one "counted 4 pieces: …" line (${J(r.rules)})`);
  r = script(T, (t) => { for (const s of order.slice(0, 5)) t.lock(`m_${s}`, true); });
  ok(J(r.rules) === J([`locked 5 pieces: ${order.slice(0, 5).join(', ')}`]), `t.lock ×5: "locked 5 pieces: …" (${J(r.rules)})`);
  {
    // (labels that differ line by line: the log already folds a repeat of the very same line)
    const T2 = table({ g0: PC('gem', 100, 3000), g1: PC('gem', 200, 3000, { f: 1 }), g2: PC('gem', 300, 3000, { f: 2 }), g3: PC('gem', 400, 3000, { f: 1 }), g4: PC('gem', 500, 3000), g5: PC('gem', 600, 3000, { f: 2 }) });
    script(T2, (t) => { for (const id of ['g0', 'g1']) t.lock(id, true); });
    r = script(T2, (t) => { t.lock('g0', false); t.lock('g1', false); t.lock('g4', true); t.lock('g5', true); });
    ok(J(r.rules) === J(['unlocked A', 'unlocked B', 'locked A', 'locked C']), `2 unlocks then 2 locks: locked and unlocked are two ops (D110), two runs of 2, 4 lines (${J(r.rules)})`);
  }
  r = script(T, (t) => { for (const s of order.slice(8, 12)) t.setOwner(`m_${s}`, BOB); });
  ok(r.rules.length === 1 && r.rules[0].includes(`4 pieces: ${order.slice(8, 12).join(', ')}`), `t.setOwner ×4: one line (${J(r.rules)})`);
  r = script(T, (t) => { for (const s of order.slice(12, 17)) t.move(`m_${s}`, `${s[0]}3`); });
  ok(r.rules.length === 5, `t.move ×5: moves are not an aggregating op, 5 lines (${J(r.rules)})`);
  r = script(T, (t) => { t.remove('c0'); t.remove('c1'); t.remove(`m_${order[20]}`); t.remove(`m_${order[21]}`); });
  ok(r.rules.length === 1 && r.rules[0].startsWith('removed 4 items: ') && r.rules[0].endsWith(`${order[20]}, ${order[21]}`), `2 cards then 2 pieces: "removed 4 items: …" (D110) (${J(r.rules)})`);
  r = script(T, (t) => { for (let k = 0; k < 5; k++) t.random(); });
  ok(r.rules.length === 1 && /randomness/.test(r.rules[0]) && /\b5\b/.test(r.rules[0]), `t.random ×5 in one hook: one "used randomness" line (${J(r.rules)})`);

  section('(5) aggregation: flushed at every commit — setup, timers');
  ({ T, order } = aggTable());
  G.setup = (t) => { for (const s of ['a2', 'b2', 'c2', 'd2', 'e2']) t.spawn(ref('man'), { at: s }); };
  r = act(T, HOST, { t: 'setRules', enabled: true, code: PROBE });
  const placed = r.rules.filter((l) => l.startsWith('placed'));
  ok(J(placed) === J(['placed 5 pieces: a2, b2, c2, d2, e2']), `setup() spawning 5: one line (${J(r.rules)})`);
  delete G.setup;
  G.onTimer = (t) => { for (const s of order.slice(0, 6)) t.remove(`m_${s}`); };
  script(T, (t) => t.schedule(0, 'sweep'));
  const last = T.state.log.at(-1), q = quietly(() => T.runTimers()), added = T.state.log.slice(T.state.log.lastIndexOf(last) + 1).filter((e) => e.p === 'RULES').map((e) => e.txt);
  ok(q.value && J(added) === J([`removed 6 pieces: ${order.slice(0, 6).join(', ')}`]), `onTimer removing 6: one line (${J(added)})`);
  ok(!T.state.log.some((e) => e.p === BOB && /pieces:/.test(e.txt)), 'players\' own lines are never merged');
}

// =============================================================================
// (D) The drag action in core
// =============================================================================
function testDrag() {
  section('(D) drag: no state change, one live fx, quiet gates, clamped finite numbers, never ruled');
  const T = table({ CB: BRD('chess', 700, 100), m: PC('man', 100, 3000), al: PC('man', 300, 3000, { owner: HOST }), lk: PC('man', 500, 3000, { lock: true }), mine: PC('man', 700, 3000, { owner: BOB }) });
  const calls = [];
  G.validate = (t, a) => { calls.push(a.t); };
  G.onAction = (t, a) => { calls.push(a.t); };
  const state0 = J(T.state), seq0 = T.state.seq;
  let r = act(T, BOB, { t: 'drag', id: 'm', x: 1000, y: 500 });
  const live = (rr) => rr.fx.filter((e) => e.t === 'fx' && e.f.live);
  ok(J(T.state) === state0 && T.state.seq === seq0 && !r.log.length && !r.notes.length && !calls.length && !r.ret, `a drag changes nothing (state, seq, log), runs no hook (${J(calls)}), returns false`);
  ok(live(r).length === 1 && J(live(r)[0].f) === J({ p: BOB, id: 'm', x: 1000, y: 500, live: 1 }), `…and queues one fx {p, id, x, y, live: 1} (${J(live(r).map((e) => e.f))})`);
  const d = T.takeDirty();
  ok(!d.items.size && !d.removed.size && !d.log.length && !d.players.size, 'nothing is dirty after it: no patch would carry it but its fx');
  for (const [what, id] of [["Alice's piece", 'al'], ['a locked piece', 'lk'], ['an unknown id', 'nope']]) {
    r = act(T, BOB, { t: 'drag', id, x: 1000, y: 500 });
    ok(!live(r).length && !r.notes.length && r.warn.length >= 1, `Bob's drag of ${what}: nothing relayed, no notice, a console.warn`);
  }
  r = act(T, BOB, { t: 'drag', id: 'mine', x: 1e308, y: NaN });
  const f = live(r)[0]?.f, w = T.state.table.w, h = T.state.table.h;
  ok(f && Number.isFinite(f.x) && Number.isFinite(f.y) && f.x <= w && f.y <= h && f.x >= 0 && f.y >= 0, `x 1e308 and y NaN: finite, on the table (${J(f)})`);
  r = act(T, BOB, { t: 'drag', id: 'mine', x: 'left', y: { y: 1 } });
  ok(live(r).length <= 1 && live(r).every((e) => Number.isFinite(e.f.x) && Number.isFinite(e.f.y)), `strings and objects for x, y: finite numbers or nothing (${J(live(r).map((e) => e.f))})`);
  const many = [...range(250).map(() => 'mine'), 'al', 'lk', 'nope', 'm', ...range(250).map((k) => `x${k}`)];
  r = act(T, BOB, { t: 'drag', ids: many, dx: 1e308, dy: -Infinity });
  const g = live(r);
  ok(g.length === 1 && g[0].f.ids.length <= 200 && g[0].f.ids.every((id) => id === 'mine' || id === 'm') && !g[0].f.ids.includes('al') && Number.isFinite(g[0].f.dx) && Number.isFinite(g[0].f.dy),
    `a group drag of 504 ids (foreign, locked, unknown among them): one fx, at most 200 ids, only Bob's to handle, finite dx, dy (${J(g.map((e) => ({ ...e.f, ids: e.f.ids.length })))})`);
  r = act(T, BOB, { t: 'drag', ids: ['al', 'lk'], dx: 5, dy: 5 });
  ok(!live(r).length && !r.notes.length, 'a group drag with no id Bob may handle: nothing relayed');
  ok(J(T.state) === state0 && !calls.length, 'after all of them the state is unchanged and no hook ran');
  ok(PUBLIC_ACTIONS.has('drag') && !RULED_ACTIONS.has('drag'), 'drag is a public action, never a ruled one');

  section('(D) liveFx: a commit in the tick drops that item\'s live fx; one item keeps its last');
  const fx = [{ p: BOB, id: 'a', x: 1, y: 1, live: 1 }, { p: BOB, id: 'b', x: 2, y: 2, live: 1 }, { p: BOB, id: 'a', x: 3, y: 3, live: 1 }, { p: BOB, ids: ['a', 'c', 'e'], dx: 4, dy: 4, live: 1 },
    { p: BOB, ids: ['c'], dx: 1, dy: 1, live: 1 }, { p: BOB, id: 'd', x: 5, y: 5 }];
  const out = liveFx(fx, { items: new Set(['b']), removed: new Set(['c']) });
  ok(J(out) === J([fx[2], { ...fx[3], ids: ['a', 'e'] }, fx[5]]), `committed b and removed c lose their glides, a keeps its last, other fx pass (${J(out)})`);
}

// =============================================================================
// The fan (§3g, pieces.js fanOffsets): pure geometry, checked here
// =============================================================================
function testFan() {
  section('(§3g) the fan: along a space\'s dir by the size, squeezed to min(size, (L − size)/(k − 1)); elsewhere 6 units apart');
  const point = { id: 'p6', x: 0, y: 0, r: 200, w: 100, h: 420, dir: 'up' }, s80 = (k) => range(k).map(() => ({ w: 80, h: 80 }));
  for (const k of [1, 2, 3, 5, 6, 15]) {
    const o = pieces.fanOffsets(point, s80(k)), step = k > 1 ? Math.min(80, (420 - 80) / (k - 1)) : 0;
    const gaps = o.slice(1).map((p, j) => o[j].y - p.y);
    ok(o.length === k && o.every((p) => p.x === 0 && p.y - 40 >= -210 - 1e-9 && p.y + 40 <= 210 + 1e-9) && gaps.every((g) => near(g, step)),
      `${k} checkers of 80 on a 420-long point (dir up): steps of ${step.toFixed(2)} toward its tip, all inside it (${o.map((p) => p.y.toFixed(1)).join(' ')})`);
  }
  const down = pieces.fanOffsets({ ...point, dir: 'down' }, s80(4)), right = pieces.fanOffsets({ id: 't', x: 0, y: 0, r: 100, w: 300, h: 80, dir: 'right' }, range(4).map(() => ({ w: 50, h: 90 })));
  ok(down.slice(1).every((p, j) => near(p.y - down[j].y, 80)) && right.slice(1).every((p, j) => near(p.x - right[j].x, 50) && p.y === 0) && right[0].x - 25 >= -150 - 1e-9,
    'dir down runs downward by h; dir right runs rightward by w (the pieces\' widths, 50), from the far end');
  const loose = pieces.fanOffsets({ id: 'x', x: 0, y: 0, r: 30 }, s80(4));
  ok(pieces.FAN_STEP === 6 && loose.slice(1).every((p, j) => near(Math.hypot(p.x - loose[j].x, p.y - loose[j].y), 6)), `without a dir: 6 units per member (${J(loose)})`);
}

// =============================================================================
// B17: a 361-stone go board's snapshot ≤ 70 KB
// =============================================================================
function testB17() {
  section('(B17) go 19 × 19 filled with 361 stones by alternate takes: the snapshot ≤ 70 KB');
  const T = table({ GB: BRD('goban', 200, 200), bs: SUP('stone', 1500, 300, { owner: 'seat:black' }), ws: SUP('stone', 1500, 500, { f: 1, owner: 'seat:white' }) }, { table: { shape: 'rect', w: 1800, h: 1600 }, rules: false });
  act(T, HOST, { t: 'setRules', enabled: true, code: PROBE });
  script(T, (t) => t.setSeats([{ id: 'black', name: 'Black' }, { id: 'white', name: 'White', edge: 'top' }]));
  const black = Object.keys(T.state.players).find((p) => T.state.players[p].seatId === 'black'), white = Object.keys(T.state.players).find((p) => T.state.players[p].seatId === 'white');
  const g = SPACE_BOX.types.goban.board.grid;
  let k = 0, refused = 0;
  for (const r of range(19)) for (const c of range(19)) {
    const P = refAt(T, 'GB', specAddr(g, c, r)), mine = k++ % 2 === 0, q = tl(T, 'stone', P);
    const res = act(T, mine ? black : white, { t: 'take', id: mine ? 'bs' : 'ws', x: q.x + 7, y: q.y - 5 });
    if (res.notes.length) refused++;
  }
  const stones = Object.entries(T.state.items).filter(([, it]) => it.k === 'g' && it.z >= 0), ats = new Set(stones.map(([id]) => T.pub.get(id).at));
  ok(!refused && stones.length === 361 && ats.size === 361 && [...ats].every((a) => /^[A-HJ-T](1[0-9]|[1-9])$/.test(a)), `361 stones, each on its own point, addressed A1 … T19 (${ats.size} distinct; ${refused} refused)`);
  T.takeDirty();
  const body = { v: PROTO, kind: 'snap', boot: 'b'.repeat(16), seq: T.state.seq, host: HOST, ...T.snapContent(), fx: [], ann: [] };
  const bytes = Buffer.byteLength(`{"to":"${BOB}","tp":"${'k'.repeat(44)}",${sharedText(body).slice(1)}`);
  ok(bytes <= 70_000, `B17: the snapshot body is ${bytes.toLocaleString('en-US')} bytes (≤ 70,000), with the 200-line log`);
  const save = Buffer.byteLength(JSON.stringify(T.snapshot()));
  console.log(`  (the save of that table: ${save.toLocaleString('en-US')} bytes)`);
  const T2 = table({ GB: BRD('goban', 200, 200) }, { table: { shape: 'rect', w: 1800, h: 1600 } });
  const r = script(T2, (t) => { for (const r0 of range(19)) for (const c of range(19)) t.spawn(ref('stone'), { at: specAddr(g, c, r0), f: (r0 + c) % 2 }); });
  ok(Object.keys(T2.state.items).length === 362 && r.rules.length === 1 && r.rules[0].startsWith('placed 361 pieces: A19, B19, C19'), `a script laying 361 stones in one action writes one line (${J(r.rules)})`);
}

// =============================================================================
// (9) The next read after a board move sees the new addresses (D106)
// =============================================================================
function testNextRead() {
  section('(9) after a board move, the very next read of an address — a hook\'s a.from, a log line, t.item — is by containment (D106)');
  const mk = () => {
    const T0 = table({ CB: BRD('chess', 700, 100) }, { rules: false }), q = tl(T0, 'man', refAt(T0, 'CB', 'e4'));
    return table({ CB: BRD('chess', 700, 100), a: PC('man', q.x, q.y), b: PC('man', q.x + 100, q.y) });
  };
  // the chess board moves one cell right: the man on e4 now lies on d4, the one on f4 on e4
  let T = mk();
  const seen = [];
  G.validate = (t, a) => { if (a.t === 'move' && a.id === 'a') seen.push(a.from); };
  act(T, HOST, { t: 'move', id: 'CB', x: 800, y: 100 });
  let q = tl(T, 'man', refAt(T, 'CB', 'd3'));
  let r = act(T, BOB, { t: 'move', id: 'a', x: q.x, y: q.y });
  ok(seen[0] === 'd4', `the next action's a.from is where the man now lies, "d4" (got ${J(seen[0])})`);
  ok(J(r.log) === J(['moved Man d4 → d3']), `its log line reads "moved Man d4 → d3" (got ${J(r.log)})`);
  T = mk();
  r = script(T, (t) => { t.move('CB', 800, 100); return [t.item('a')?.at, t.items().find((x) => x.id === 'b')?.at, t.where('a')]; });
  ok(J(r.ret) === J(['d4', 'e4', 'd4']), `in the same hook, t.item and t.items read the new addresses as t.where does (["d4","e4","d4"], got ${J(r.ret)})`);
  T = mk();
  r = script(T, (t) => { t.move('CB', 800, 100); t.remove('a'); });
  ok(r.rules.at(-1) === 'removed Man from d4', `in the same hook, t.remove logs the address the man had then, "removed Man from d4" (got ${J(r.rules)})`);
}

// =============================================================================
// (8) More addresses: the topmost board, an explicit address under another (D105), two boxes
// =============================================================================
function testOverlaps() {
  section('(S) snapping is geometric: the topmost board under the piece, whichever is primary; an explicit address is that very spot (D105)');
  // the map (newer, so above) lies over the chess board's right half
  const T = table({ CB: BRD('chess', 700, 100), MP: BRD('map', 1100, 300), p: PC('man', 100, 3000), q: PC('man', 200, 3000) });
  const P = refAt(T, 'MP', 'c5'), RB = refBoards(T.state.items, T.state.boxes);
  ok(onRect(RB.byId.get('CB'), P.x, P.y), '(the probe: the map\'s c5 lies over the chess board too)');
  moveNear(T, BOB, 'p', 'man', P, 6, -4);
  ok(T.state.items.p.at === 'MP:c5' && T.pub.get('p').at === 'map:c5', `a man dropped there snaps to the map above, not the primary board below (${T.state.items.p.at})`);
  const e5 = refAt(T, 'CB', 'e5'), map = RB.byId.get('MP');
  const under = onRect(map, e5.x, e5.y);
  const r = script(T, (t) => [t.move('q', 'e5'), t.where('q')]);
  ok(under && J(r.ret) === J([true, 'e5']) && snapped(T, 'q', 'CB', 'e5'), `t.move(id, "e5") centres it on the chess board's e5 under the map, with that address (D105) (${J(r.ret)})`);

  section('(8) two boxes with a board type of one id: each board\'s display form names it alone (D107)');
  const B2 = 'bx000002', other = cleanBox({ name: 'Other', imgs: [], types: { tray: { kind: 'board', name: 'Other tray', w: 300, h: 200, board: { spaces: [{ id: 'bar', x: 150, y: 100, r: 60 }, { id: 'ford', x: 40, y: 40, r: 20 }] } } } });
  const T2 = table({ CB: BRD('chess', 700, 100), T1: BRD('tray', 100, 600), T2: { ...BRD('tray', 100, 900), t: `${B2}/tray` }, a: PC('man', 100, 3000), b: PC('man', 200, 3000) },
    { boxes: { [BX]: cleanBox(SPACE_BOX), [B2]: other } });
  moveNear(T2, BOB, 'a', 'man', refAt(T2, 'T1', 'bar'));
  moveNear(T2, BOB, 'b', 'man', refAt(T2, 'T2', 'bar'));
  const da = T2.pub.get('a').at, db = T2.pub.get('b').at;
  const back = script(T2, (t) => [t.at(da).map((x) => x.id), t.at(db).map((x) => x.id)]).ret;
  ok(da && db && da !== db && J(back) === J([['a'], ['b']]), `the two trays read ${da} and ${db}, and each form finds its own man (${J(back)})`);
  const ford = script(T2, (t) => [t.where('a'), t.spot('ford')]).ret, wf = refAt(T2, 'T2', 'ford');
  ok(ford && near(ford[1]?.x, wf.x) && near(ford[1]?.y, wf.y), `a space only the other box's tray has ("ford") resolves bare (${J(ford)})`);

  section('(F) the spatial helpers on a hex board (display forms)');
  const T3 = table({ CB: BRD('chess', 700, 100), HX: BRD('hexp', 1700, 100) });
  const g = SPACE_BOX.types.hexp.board.grid, a0 = specAddr(g, 5, 5), a1 = specAddr(g, 9, 5), far = specAddr(g, 12, 9);
  const out = script(T3, (t) => [t.neighbors(`hexp:${a0}`), t.distance(`hexp:${a0}`, `hexp:${far}`), t.line(`hexp:${a0}`, `hexp:${a1}`), t.distance('e4', `hexp:${a0}`)]).ret;
  const hex = { grid: g };
  ok(out && sameSet(out[0], grid.neighbors(hex, a0).map((s) => `hexp:${s}`)) && out[0].length === 6 && out[1] === grid.distance(hex, a0, far) && J(out[2]) === J(grid.line(hex, a0, a1).map((s) => `hexp:${s}`)) && out[3] === null,
    `t.neighbors (6), t.distance (cube) and t.line on "hexp:…", in display form; null across boards (${J(out)})`);
}

// =============================================================================
// (D) A group drag's resulting positions stay on the table (§3c)
// =============================================================================
function testGroupDragClamp() {
  section('(D) a group drag: "the resulting positions through clampToTable" (§3c)');
  const T = table({ a: PC('man', 4800, 1700), b: PC('man', 4700, 1800) });
  for (const [dx, dy] of [[1e6, 0], [4000, -3000], [-1e308, 1e308]]) {
    const r = act(T, BOB, { t: 'drag', ids: ['a', 'b'], dx, dy }), f = r.fx.find((e) => e.t === 'fx' && e.f.live)?.f;
    const off = f ? f.ids.filter((id) => { const it = T.state.items[id], x = it.x + f.dx, y = it.y + f.dy, c = clampToTable(T.state.table, x, y, 80, 80); return !(near(c.x, x) && near(c.y, y)); }) : ['no fx'];
    ok(!off.length, `dx ${dx}, dy ${dy}: every member's resulting position (its place + the relayed dx, dy = ${f && J([f.dx, f.dy])}) is on the table ${off.length ? `— off it: ${J(off)}` : ''}`);
  }
}

function testMoreSpots() {
  section('(8) a zones-only board marked primary: true never is; zones on the primary board read bare (D107)');
  const T = table({ PZ: BRD('pzone', 100, 100), FD: BRD('field', 700, 100), a: PC('man', 100, 3000), b: PC('man', 200, 3000) });
  moveNear(T, BOB, 'a', 'man', refAt(T, 'FD', 'b4'));
  moveNear(T, BOB, 'b', 'man', { x: 300, y: 200 });
  const r = script(T, (t) => [t.where('a'), t.zones('a'), t.zones('b'), t.find({ zone: 'north' }).map((x) => x.id)]);
  ok(J(r.ret) === J(['b4', ['north'], ['pzone:home'], ['a']]), `the field (grid) is primary over the older zones-only mat marked primary: "b4", its zone "north" bare, the mat's "pzone:home" (${J(r.ret)})`);

  section('(S) a drop on a board but on no spot (its margin): exactly there, no address');
  const T2 = table({ CB: BRD('chess', 700, 100), m: PC('man', 100, 3000) });
  act(T2, BOB, { t: 'move', id: 'm', x: 702 - 40, y: 400 });
  ok(T2.state.items.m.x === 662 && T2.state.items.m.y === 400 && T2.state.items.m.at === undefined, `the man's centre on the board's 20-unit margin: it stays where dropped (${why(T2, 'm')})`);

  section('(S) a setup group {shuffle} of hidden pieces on board spots: each keeps the address of the place it got');
  const cellTL = (c, rr) => [615 + 100 * c, 415 + 100 * rr];
  const BOXS = {
    name: 'Shuffled', imgs: [], table: { shape: 'rect', w: 2000, h: 1600 }, backs: SPACE_BOX.backs,
    types: { chess: SPACE_BOX.types.chess, spy: SPACE_BOX.types.spy },
    setup: [{ piece: 'chess', at: 'center' }, { group: [[0, 0], [3, 2], [5, 5], [7, 7]].map(([c, rr], k) => ({ piece: 'spy', f: k % 2, up: false, at: cellTL(c, rr) })), shuffle: true }],
  };
  const T3 = table();
  const lr = act(T3, HOST, { t: 'loadBox', box: BOXS, setup: true, clear: true });
  const spies = Object.entries(T3.state.items).filter(([, it]) => it.z >= 0);
  ok(!lr.notes.length && spies.length === 4 && sameSet(spies.map(([id]) => T3.pub.get(id).at), ['a8', 'd6', 'f3', 'h1']) && !containmentProblems(T3).length,
    `the four hidden spies lie on a8, d6, f3 and h1, each addressed where it lies (${J(spies.map(([id]) => T3.pub.get(id).at))}) ${J(containmentProblems(T3))}`);
}

// =============================================================================
// (R) The 3A fix-up's regressions (the reviews of a001685; D112–D116)
// =============================================================================
function testReviewPull() {
  section('(R) a veto keeps a pull\'s draw (D114): a guest aiming pulls where only one size snaps can\'t fish the bag');
  // 10 Big (180 wide) and 40 Man (80) in one bag; validate vetoes a pull that
  // lands on no spot. Aimed at (640, 700), a Big's centre (730, 790) is on the
  // chess board's a2, a Man's (680, 740) left of the board: on no spot.
  const of = [...range(10).map(() => 'big'), ...range(40).map(() => 'man')];
  const T = table({ CB: BRD('chess', 700, 100), bg: BAG(of, 3000, 3000) });
  const seen = [];
  G.validate = (t, a) => { if (a.t !== 'pull') return undefined; seen.push({ pick: a.pick, t: t.item(a.id).of[a.pick].t, to: a.to }); return a.to ? undefined : 'Pull it onto the board'; };
  const got = [];
  let vetoAt = -1;
  for (let k = 0; k < 300; k++) {
    const ids = Object.keys(T.state.items), r = act(T, BOB, { t: 'pull', id: 'bg', x: 640, y: 700 }), nid = newIds(T, ids)[0];
    if (nid) got.push(T.state.items[nid].t);
    else if (vetoAt < 0 && r.notes.length) vetoAt = k;
  }
  const after = seen.slice(vetoAt), first = after[0];
  ok(vetoAt >= 0 && after.every((s) => s.pick === first.pick && s.t === first.t && s.t === ref('man')),
    `once vetoed (pull #${vetoAt + 1}: a Man would land on no spot), every later pull draws that same member again (${after.length} pulls, all index ${first?.pick}, a Man)`);
  ok(got.length === vetoAt && got.every((t) => t === ref('big')) && T.state.items.bg.of.filter((m) => m.t === ref('big')).length === 10 - got.length,
    `Bob got only the Bigs drawn before the first veto (${got.length}), and the bag keeps the other ${10 - got.length} Bigs: 300 aimed pulls fished nothing`);
  delete G.validate;
  const ids = Object.keys(T.state.items);
  act(T, CAROL, { t: 'pull', id: 'bg' });
  const nid = newIds(T, ids)[0];
  ok(T.state.items[nid]?.t === ref('man') && T.state.items.bg.of.length === 50 - got.length - 1, `the pending Man is what the next pull (Carol's, not vetoed) takes (${T.state.items[nid]?.t}): the draw was never discarded`);
}

function testReviewHostFields() {
  section('(R) only the host sets a.to, a.from, a.pick and a.handled, on every action (§3c); a deal from a piece pile is prepared');
  const T = table({ CB: BRD('chess', 700, 100), pp: PILE([{ t: ref('tile'), f: 0, up: false }, { t: ref('tile'), f: 1, up: false }], 3000, 3000), m: PC('man', 100, 3000), n: PC('man', 300, 3000), c: CARD(1, 500, 3000, { up: false }) });
  const seen = [];
  G.validate = (t, a) => { seen.push({ hook: 'validate', ...json(a) }); };
  G.onAction = (t, a) => { seen.push({ hook: 'onAction', ...json(a) }); };
  const lie = { to: 'h8', from: 'a1', pick: 0, handled: true };
  const d4 = tl(T, 'tile', refAt(T, 'CB', 'd4'));
  for (const a of [
    { t: 'deal', id: 'pp', x: d4.x + 12, y: d4.y - 9 }, { t: 'stack', id: 'm', onto: 'n' }, { t: 'rot', id: 'm', rot: 90 },
    { t: 'flip', id: 'c' }, { t: 'toHand', id: 'c' }, { t: 'del', id: 'n' },
  ]) {
    seen.length = 0;
    act(T, BOB, { ...a, ...lie });
    const v = seen.filter((s) => s.hook === 'validate'), want = a.t === 'deal' ? 'd4' : undefined;
    ok(v.length && seen.every((s) => s.to === want && s.from === undefined && s.pick === undefined && s.handled === undefined),
      `${a.t}: the payload's to/from/pick/handled never reach a hook (${J(seen.map((s) => [s.hook, s.to, s.from, s.pick, s.handled]))})${want ? '; a.to is where the dealt tile lands' : ''}`);
  }
  const dealt = Object.values(T.state.items).find((it) => it.t === ref('tile') && it.k === 'g');
  ok(dealt?.at === 'CB:d4', `the tile dealt face down landed on d4 (${dealt?.at})`);
  seen.length = 0;
  act(T, BOB, { t: 'owner', id: 'm', to: BOB, from: 'x', pick: 1, handled: true });
  ok(T.state.items.m.owner === BOB && seen.some((s) => s.to === BOB && s.from === undefined && s.pick === undefined && s.handled === undefined), `owner keeps its own \`to\` (the new owner, §2c) and loses the rest (${J(seen.map((s) => s.to))})`);
}

function testReviewNewBox() {
  section('(R) t.newBox: at most MAX_BOX_DECKS decks, no "__proto__" ids, the whole box through cleanBox before anything is sent');
  const T = table();
  const deck = (k) => ({ name: `D${k}`, cards: [{ name: 'A', text: 'a' }] });
  const pieces = [{ id: 'man', kind: 'token', w: 80, faces: [{ color: '#eeeeee' }] }];
  for (const [what, def] of [
    ['51 decks', { pieces, decks: range(core.MAX_BOX_DECKS + 1).map(deck) }],
    ['a piece id "__proto__"', { pieces: [...pieces, { id: '__proto__', kind: 'token', faces: [{ color: '#111111' }] }] }],
    ['a back id "__proto__"', { pieces, backs: [{ id: '__proto__', color: '#222222' }] }],
    ['a deck named "__proto__"', { pieces, decks: [{ name: '__proto__', cards: [{ name: 'A' }] }] }],
  ]) {
    const decks0 = Object.keys(T.state.decks).length, boxes0 = Object.keys(T.state.boxes).length;
    const r = typeErr(T, 't.newBox', (t) => t.newBox(def), what);
    ok(Object.keys(T.state.decks).length === decks0 && Object.keys(T.state.boxes).length === boxes0 && !r.fx.some((e) => e.t === 'deck' || e.t === 'box'), `${what}: no deck or box registered or sent`);
  }
  const r1 = script(T, (t) => t.newBox({ name: 'Fifty', pieces, decks: range(core.MAX_BOX_DECKS).map(deck) }));
  const box = T.state.boxes[r1.ret];
  ok(box && Object.keys(box.decks).length === 50 && core.canon(cleanBox(json(box))) === core.canon(box), `50 decks: registered, and the box passes cleanBox as a guest's copy and a resume will (${r1.err?.message || 'ok'})`);
  const decks1 = Object.keys(T.state.decks).length, r2 = script(T, (t) => t.newBox({ name: 'Fifty', pieces, decks: range(core.MAX_BOX_DECKS).map(deck) }));
  ok(r2.ret === r1.ret && Object.keys(T.state.decks).length === decks1 && !r2.log.length, 'the same again (a reset re-running setup): the same box, no deck minted, nothing logged');
}

function testReviewLoadGates() {
  section('(R) a save can\'t plant an address on an item that never snaps (§3h)');
  const T0 = table({ CB: BRD('chess', 700, 100) }, { rules: false });
  const e4 = refAt(T0, 'CB', 'e4');
  const items = {
    CB: { ...BRD('chess', 700, 100), at: {} }, s: SUP('man', 100, 3000, { at: 5 }), s2: SUP('man', 200, 3000, { at: 'zz:<img src=x onerror=alert(1)>' }),
    d: PC('die', e4.x - 32, e4.y - 32, { at: 'CB:e4' }), c: CARD(1, 300, 3000, { at: 'CB:a1' }), m: PC('man', e4.x - 40, e4.y - 40, { at: 'CB:e4' }),
  };
  const s = {
    v: STATE_V, seq: 1, table: { shape: 'rect', w: 5000, h: 3600 }, seats: null, boardSeq: 1, zMax: 100, items: json(items), keys: {}, log: [], rules: null, guestDeckChars: 0,
    players: { [HOST]: player('Alice', 90) }, decks: { [DK]: core.standardDeck(false) }, boxes: { [BX]: cleanBox(SPACE_BOX) }, boxSrc: {},
  };
  const q = quietly(() => createTable(s, env(3))), T = q.value;
  ok(['CB', 's', 's2', 'd', 'c'].every((id) => !('at' in T.state.items[id]) && !('at' in T.pub.get(id))) && T.state.items.m.at === 'CB:e4' && T.pub.get('m').at === 'e4',
    `the board's, the supplies', the die's and the card's addresses are dropped; the man's stands (${J(Object.fromEntries(Object.entries(T.state.items).map(([id, it]) => [id, it.at])))})`);
  ok(q.error.filter((e) => /never snaps/.test(e)).length === 5, `each said with console.error (${q.error.filter((e) => /never snaps/.test(e)).length} of 5)`);
  const d = quietly(() => T.takeDirty());
  ok(!d.error.length, 'the table broadcasts again: takeDirty does not throw');
  const v3 = { v: 3, items: json(items), boxes: { [BX]: cleanBox(SPACE_BOX) }, table: { shape: 'rect', w: 5000, h: 3600 }, rules: null };
  const m = quietly(() => MIGRATE[3](v3));
  ok(['CB', 's', 's2', 'd', 'c'].every((id) => !('at' in v3.items[id])) && v3.items.m.at === 'CB:e4' && m.error.length === 5, `MIGRATE[3] drops them too, loudly (${m.error.length}), and reads the man's by containment`);
}

function testReviewDice() {
  section('(R) dice never snap (D112): a die dropped on a spot keeps where it was put, and no address');
  const T = table({ CB: BRD('chess', 700, 100), d: PC('die', 100, 3000), m: PC('man', 300, 3000) });
  const e4 = refAt(T, 'CB', 'e4'), dw = typeIn(T.state.boxes, ref('die')).w, q = { x: e4.x - dw / 2 + 11, y: e4.y - dw / 2 - 7 };
  act(T, BOB, { t: 'move', id: 'd', ...q });
  ok(T.state.items.d.x === q.x && T.state.items.d.y === q.y && T.state.items.d.at === undefined && T.pub.get('d').at === undefined, `a die dropped on e4: exactly there, no address (${why(T, 'd')})`);
  moveNear(T, BOB, 'm', 'man', e4);
  const r = script(T, (t) => [t.spawn(ref('die'), { at: 'e4' }), t.at('e4').map((x) => x.id), t.where('d')]);
  const nd = T.state.items[r.ret?.[0]];
  ok(nd && near(nd.x + dw / 2, e4.x) && near(nd.y + dw / 2, e4.y) && nd.at === undefined && J(r.ret.slice(1)) === J([['m'], null]),
    `t.spawn(die, {at: 'e4'}) centres it there with no address; e4 holds only the man (${J(r.ret)})`);
  ok(!containmentProblems(T).length, `the table agrees with containment, dice left out (D112) ${J(containmentProblems(T))}`);
}

function testReviewExplicit() {
  section('(R) an explicit address under a newer board stands until a board under it changes (D105, D113)');
  // the map (the oldest grid: primary), the rack (zones only) over its top
  // rows (c9 among them), the chess board elsewhere
  const T = table({ MP: BRD('map', 100, 100), RK: BRD('rack', 100, 100), CB: BRD('chess', 2000, 100), M: PC('man', 100, 3000), n: PC('man', 300, 3000) });
  moveNear(T, BOB, 'n', 'man', refAt(T, 'CB', 'e4'));
  let r = script(T, (t) => [t.move('M', 'map:c9'), t.where('M')]);
  ok(J(r.ret) === J([true, 'c9']) && onRect(refBoards(T.state.items, T.state.boxes).byId.get('RK'), centre(T, 'M').x, centre(T, 'M').y), `t.move(M, "map:c9") under the rack: centred there, with that address (${J(r.ret)})`);
  act(T, HOST, { t: 'rot', id: 'CB', rot: 90 });
  r = script(T, (t) => [t.where('M'), t.where('n')]);
  const RB = refBoards(T.state.items, T.state.boxes), cn = centre(T, 'n'), sn = refSnap(RB, cn.x, cn.y);
  ok(r.ret[0] === 'c9' && sn && r.ret[1] === refDisplay(RB, sn.at) && r.ret[1] !== 'chess:e4', `the chess board turned across the table: M keeps "c9"; n, on the board that turned, is read by containment (${J(r.ret)})`);
  act(T, HOST, { t: 'move', id: 'RK', x: 100, y: 2000 });
  r = script(T, (t) => t.where('M'));
  ok(r.ret === 'c9' && !containmentProblems(T).length, `the rack moved off it: M is read again, by containment — the map's c9 (${r.ret}) ${J(containmentProblems(T))}`);
  act(T, HOST, { t: 'move', id: 'RK', x: 100, y: 100 });
  r = script(T, (t) => t.where('M'));
  ok(r.ret === null && !containmentProblems(T).length, `the rack moved back over it: read again, the topmost board (the rack) has no spot there: null (${r.ret})`);
}

function testReviewOneRule() {
  section('(R) one snapping rule for the host, the preview and containment (D112): a spot past the playing area\'s margin');
  // a round 1300 table (playR 540) and an 11 × 11 board of cell 100 in its middle: cell (1, 1)'s centre is 566 from the table's
  const BB = cleanBox({ name: 'Big board', imgs: [], types: { b11: { kind: 'board', name: 'B11', w: 1120, board: { grid: { type: 'square', cols: 11, rows: 11, cell: 100, x: 10, y: 10 } } }, man: SPACE_BOX.types.man } });
  const T = table({ B: { k: 'g', t: 'bx000003/b11', f: 0, x: 90, y: 90, rot: 0, z: BOARD_Z0 + 1 }, m: { k: 'g', t: 'bx000003/man', f: 0, x: 610, y: 610, rot: 0, z: 1 } }, { boxes: { bx000003: BB }, table: { shape: 'round', w: 1300, h: 1300 } });
  const view = core.tableBoards([...T.pub], T.state.boxes), want = core.snapTo(view, T.state.table, 80, 80, 200, 200);
  act(T, BOB, { t: 'move', id: 'm', x: 200, y: 200 });
  const it = T.state.items.m;
  ok(it.at === 'B:1,1' && near(it.x, 210) && near(it.y, 210) && want.at === 'B:1,1' && near(want.x, it.x) && near(want.y, it.y),
    `a man dropped toward cell 1,1 is centred on it, past the margin, with its address — as the page's preview (core.snapTo on the public view) says (host ${why(T, 'm')}, preview ${J(want)})`);
  act(T, HOST, { t: 'rot', id: 'B', rot: 180 });
  ok(T.state.items.m.x === it.x && T.byAt.get('B:9,9')?.has('m') && !containmentProblems(T).length, `the board turned: the man stays, and containment reads it on 9,9 (${T.state.items.m.at})`);
}

function testReviewHexRim() {
  section('(R) hexes at the grid\'s rim: the nearest centre within R, even when the hex holding the point is off the grid (§3a)');
  for (const [hex, pt] of [['pointy', [7, 44.64]], ['flat', [44.64, 7]]]) {
    const s = grid.gridSpot(hexG(hex), ...pt);
    ok(J(s) === J({ c: 0, r: 0 }), `${hex}: [${pt}] lies 33 from (0, 0)'s centre (R 34.64), in the off-grid hex beside it: snaps to (0, 0) (${J(s)})`);
  }
  const r = rng(77);
  for (const hex of ['pointy', 'flat']) {
    const g = hexG(hex), R = g.cell / Math.sqrt(3), cells = range(g.cols).flatMap((c) => range(g.rows).map((rr) => [c, rr, specCenter(g, c, rr)]));
    const xs = cells.map(([, , p]) => p.x), ys = cells.map(([, , p]) => p.y);
    let bad = '';
    for (let k = 0; k < 3000 && !bad; k++) {
      const x = Math.min(...xs) - R + r() * (Math.max(...xs) - Math.min(...xs) + 2 * R), y = Math.min(...ys) - R + r() * (Math.max(...ys) - Math.min(...ys) + 2 * R);
      const best = cells.map(([c, rr, p]) => [c, rr, Math.hypot(p.x - x, p.y - y)]).sort((a, b) => a[2] - b[2])[0];
      const want = best[2] <= R - 1e-9 ? { c: best[0], r: best[1] } : best[2] > R + 1e-9 ? null : undefined, got = grid.gridSpot(g, x, y);
      if (want !== undefined && J(got) !== J(want)) bad = `(${x.toFixed(2)}, ${y.toFixed(2)}): ${J(got)}, the nearest centre within R is ${J(want)}`;
    }
    ok(!bad, `${hex}: 3,000 random points around the whole grid (rim included) match a brute-force "nearest centre within R" ${bad}`);
  }
}

function testReviewGroupRound() {
  section('(R) a group drag on a round table: the shift is shortened until every member stays within playR (§3c)');
  const T = table({ a: PC('man', 610, 610), b: PC('man', 900, 610) }, { table: { shape: 'round', w: 1300, h: 1300 } });
  for (const [dx, dy] of [[1e5, 0], [-3000, 2500], [0, 0]]) {
    const r = act(T, BOB, { t: 'drag', ids: ['a', 'b'], dx, dy }), f = r.fx.find((e) => e.t === 'fx' && e.f.live)?.f;
    const off = f ? f.ids.filter((id) => { const it = T.state.items[id], x = it.x + f.dx + 40 - 650, y = it.y + f.dy + 40 - 650; return Math.hypot(x, y) > 540 + 1e-6; }) : ['no fx'];
    const along = !f || (dx === 0 && dy === 0) || Math.abs(f.dx * dy - f.dy * dx) < 1e-6 * Math.hypot(dx, dy) * Math.hypot(f.dx, f.dy) + 1e-9;
    ok(!off.length && along, `dx ${dx}, dy ${dy}: relayed (${f && J([+f.dx.toFixed(2), +f.dy.toFixed(2)])}), along the same direction, every member within playR ${off.length ? J(off) : ''}`);
  }
}

(async () => {
  await guard('(1) grid.js addresses', testGridAddresses);
  await guard('(1) grid.js centres', testGridCentres);
  await guard('(1) grid.js snapping', testGridSnapping);
  await guard('(1) grid.js turns', testGridTurns);
  await guard('(1) grid.js neighbors', testGridNeighbors);
  await guard('(1) grid.js distance and line', testGridDistanceLine);
  await guard('(1) grid.js polygons', testGridPolygons);
  await guard('(8) addresses', testAddresses);
  await guard('(8) the primary board', testPrimaryRule);
  await guard('(9) board moves', testBoardMoves);
  await guard('(9) the next read after a board move', testNextRead);
  await guard('(8) overlapping boards and two boxes', testOverlaps);
  await guard('(8) zones on boards, margins, shuffled setups', testMoreSpots);
  await guard('(10) action preparation', testPrepare);
  await guard('(F) components from code', testComponents);
  await guard('(F) the spatial helpers', testSpatialFacade);
  await guard('(S) snapping callers', testSnappingCallers);
  await guard('(6) MIGRATE[3]', testMigrate);
  await guard('(5) aggregation', testAggregation);
  await guard('(D) drag', testDrag);
  await guard('(D) a group drag stays on the table', testGroupDragClamp);
  await guard('(§3g) the fan', testFan);
  await guard('(B17) 361 stones', testB17);
  await guard('(R) pulls and vetoes', testReviewPull);
  await guard('(R) host-set action fields', testReviewHostFields);
  await guard('(R) t.newBox gates', testReviewNewBox);
  await guard('(R) load gates', testReviewLoadGates);
  await guard('(R) dice', testReviewDice);
  await guard('(R) explicit addresses', testReviewExplicit);
  await guard('(R) one snapping rule', testReviewOneRule);
  await guard('(R) hex rim', testReviewHexRim);
  await guard('(R) a round table\'s group drag', testReviewGroupRound);
  report();
})().catch(crash);
