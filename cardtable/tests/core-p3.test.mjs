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
// Phase 3B (the rules engine: the journal, the pipeline, asks, answer,
// select, internal actions, per-recipient parts, guards, T.digest) has its own
// sections, after 3A's: see "Phase 3B" below.
// Every random sequence is seeded and every failure names its seed.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { APP_ROOT, core, ok, section, report, crash, guard, rng, json, env, seeds, canon, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

const grid = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/grid.js')));
const pieces = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/pieces.js')));
const templates = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js'))), { BOXES } = templates;
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
  ok(PUBLIC_ACTIONS.includes('drag') && !RULED_ACTIONS.includes('drag'), 'drag is a public action, never a ruled one');

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

function testReviewEdgeKept() {
  section('(R) a piece centred on a spot past the playing area\'s margin (D112) stays there across a reload, a new felt and a resize (D119)');
  const BB = cleanBox({ name: 'Big board', imgs: [], types: { b11: { kind: 'board', name: 'B11', w: 1120, board: { grid: { type: 'square', cols: 11, rows: 11, cell: 100, x: 10, y: 10 } } }, man: SPACE_BOX.types.man } });
  const T = table({ B: { k: 'g', t: 'bx000003/b11', f: 0, x: 90, y: 90, rot: 0, z: BOARD_Z0 + 1 }, m: { k: 'g', t: 'bx000003/man', f: 0, x: 610, y: 610, rot: 0, z: 1 },
    n: { k: 'g', t: 'bx000003/man', f: 0, x: 600, y: 600, rot: 0, z: 2 } }, { boxes: { bx000003: BB }, table: { shape: 'round', w: 1300, h: 1300 } });
  act(T, BOB, { t: 'move', id: 'm', x: 200, y: 200 });
  const at = (U, id) => [U.state.items[id].x, U.state.items[id].y, U.state.items[id].at];
  const was = at(T, 'm');
  ok(J(was) === J([210, 210, 'B:1,1']), `dropped toward cell 1,1: centred on it, past the margin (${J(was)})`);
  // a reload: the save, a fresh table from it, the host resumes
  const R = quietly(() => createTable({ ...json(T.snapshot()), boxes: json(T.state.boxes), decks: json(T.state.decks), boxSrc: {} }, env(3))).value;
  const q = quietly(() => R.resume('Alice')), fx = R.drain();
  ok(J(at(R, 'm')) === J(was) && !containmentProblems(R).length && !q.error.length, `after a reload (snapshot → createTable → resume) it is where it was, with its address (${J(at(R, 'm'))}) ${J(q.error)}`);
  ok(!fx.some((e) => e.t === 'note' || e.t === 'toast'), 'and nothing was said about it');
  // a new felt moves nothing at all
  T.takeDirty();
  const felt = act(T, HOST, { t: 'table', shape: 'round', w: 1300, felt: '#224466' }), d = T.takeDirty();
  ok(J(at(T, 'm')) === J(was) && T.state.table.felt === '#224466' && !d.items.size, `a new felt: nothing moves, nothing is re-sent (${J(at(T, 'm'))}, ${d.items.size} re-sent; ${J(felt.log)})`);
  // a resize: everything shifts alike — the man still centred on its spot, the board as well
  act(T, HOST, { t: 'table', shape: 'round', w: 1800 });
  ok(J(at(T, 'm')) === J([460, 460, 'B:1,1']) && T.state.items.B.x === 340 && !containmentProblems(T).length, `round 1800: the board and the man shifted by 250 together (${J(at(T, 'm'))})`);
  act(T, HOST, { t: 'table', shape: 'round', w: 1300 });
  ok(J(at(T, 'm')) === J(was) && !containmentProblems(T).length, `round 1300 again: back where it was, still on 1,1 (${J(at(T, 'm'))})`);
  // a piece past the margin that is NOT centred on its spot is clamped as before
  const n0 = at(T, 'n'), n = T.state.items.n;
  n.x = 150; n.y = 150; // (off its spot's centre and past the margin, as a v3 save may leave it)
  const R2 = quietly(() => createTable({ ...json(T.snapshot()), boxes: json(T.state.boxes), decks: json(T.state.decks), boxSrc: {} }, env(3))).value;
  quietly(() => R2.resume('Alice'));
  const q2 = clampToTable(T.state.table, 150, 150, 80, 80);
  ok(near(R2.state.items.n.x, q2.x) && near(R2.state.items.n.y, q2.y) && J(at(R2, 'm')) === J(was) && !containmentProblems(R2).length,
    `an off-centre piece past the margin is clamped on resume, the centred one beside it is not (${J(at(R2, 'n'))}, was ${J(n0)})`);
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

// =============================================================================
// Phase 3B: the rules engine in core (spec §3f.4, §3a, §3b, §3c, §3e, §3f.3,
// §3f.6, §3f.7, §3h, §3j), checked against the spec:
//  (2)   The journal: begin, then every mutation helper, then rollback (the
//        table as it was, its indexes too; data, public, asks, secret, hints);
//        savepoint / rollbackTo nesting; checkpoint; commit's StatePatch.
//  (3)   The ruled-action pipeline with a fake script: every row of §3f.4's
//        atomicity table (group: Phase 4), strict with and without allow,
//        seat under strict, handle before validate, onAction after handled
//        actions (a.handled), a frozen, thenables fail closed, the handled
//        drop's refresh touch, the hint a veto puts back.
//  (4)   Asks: cleanAsk for every form (accepted, refused), plain-string
//        options, t.ask / cancelAsk / asks; the engine-state gates on load
//        (asks, secret, _timers, hints) and at commit (secret, _timers).
//  (A)   answer: only the asked player, a pending id, an offered value (each
//        form), the right number of hand cards; no hook on a refusal.
//  (Sel) select: hidden pieces, wants, 5 a second per player; no state
//        change but what the script does.
//  (I)   Internal actions: never public; _join, _leave, _tick (due timers),
//        _rulesOff, _name.
//  (P)   Per-recipient parts: ask, hint and sec for their player alone; a
//        peer that is not registered gets none; hints never saved.
//  (G)   "Hooks must be synchronous": the live facade, guard().
//  (7)   T.digest equal on a Worker-like mirror and a host that applies its
//        patches (applyStatePatch), after 300 seeded random jobs; the
//        patch's own gates.
// The fake script hands every hook to a function of the test (F, below), so
// each check states its script's behaviour next to its expectations.
const { RULES, STRICT_ACTIONS, cleanAsk, scriptHooks, own } = core;
const EVE = 'e'.repeat(16); // a player id nobody registered
const F = (globalThis.__p3b = {});
const HOOK_NAMES = ['setup', 'handle', 'validate', 'onAction', 'onChat', 'onButton', 'onAnswer', 'onSelect', 'onJoin', 'onLeave', 'onTimer', 'buttons'];
/** The default Go button's hook: runs F.fn (see run()), keeping what it returned or threw. */
function goButton(t, id, p) {
  if (!F.fn) return;
  try { F.ret = F.fn(t, p); } catch (e) { F.err = e; }
}
/** A fake script's code: name "Fake", the flags given (strict, allow) as its
 *  own properties, and one method per hook in `hooks`, each handing over to
 *  that function (kept in F, with the script as `this`). Unless o.bare, a Go
 *  button (buttons) and its onButton (run()) come first: `hooks` may replace them. */
function fake(hooks, flags = {}, o = {}) {
  const all = o.bare ? hooks : { buttons: () => [{ id: 'go', label: 'Go' }], onButton: goButton, ...hooks };
  for (const k of Object.keys(F)) delete F[k];
  Object.assign(F, all);
  const parts = ["name: 'Fake'", ...Object.entries(flags).map(([k, v]) => `${k}: ${J(v)}`),
    ...Object.keys(all).filter((h) => HOOK_NAMES.includes(h)).map((h) => `${h}(...args) { return globalThis.__p3b.${h}.apply(this, args); }`)];
  return `({ ${parts.join(',\n  ')} })`;
}
/** A seated table's state (v3: MIGRATE[3] reads every piece's address):
 *  Alice (the host), Bob and Carol, online; the test box and a standard deck. */
function state3b(items, hands = {}) {
  const s = {
    v: 3, seq: 1, table: { shape: 'rect', w: 5000, h: 3600 }, seats: null, boardSeq: 0, zMax: 0,
    items: json(items), keys: {}, log: [], rules: null, guestDeckChars: 0,
    players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270), [CAROL]: player('Carol', 0) },
    decks: { [DK]: core.standardDeck(false) }, boxes: { [BX]: cleanBox(SPACE_BOX) }, boxSrc: {},
  };
  for (const [p, hand] of Object.entries(hands)) s.players[p].hand = json(hand);
  return s;
}
/** A host table over state3b(items) whose clock stands still until a test
 *  moves it (T.clk.t), with the fake script of `hooks` enabled (none: no
 *  rules) through a job, as a rules Worker runs it. o: {hands, flags, bare, seed}. */
function rtable(items, hooks, o = {}) {
  const clk = { t: 1.7e12 };
  const T = quietly(() => createTable(state3b(items, o.hands), { ...env(o.seed ?? 7), now: () => clk.t })).value;
  T.clk = clk;
  if (hooks) {
    const r = job(T, HOST, { t: 'setRules', enabled: true, code: fake(hooks, o.flags, o) });
    if (!T.state.rules?.enabled) ok(false, `the fake script is enabled (${T.rulesError || J(r.error)})`);
  }
  T.drain();
  T.takeDirty();
  return T;
}
/** Runs action `a` of player p as a rules Worker does (T.job): its result
 *  ({patch, out} or {fatal}) plus the effects, the notes ({p, msg}), the log
 *  lines it added (texts; `rules`: the Rules ones; `entries`: whole) and what
 *  went to console.warn / console.error. */
function job(T, p, a) {
  T.drain();
  const last = T.state.log.at(-1), q = quietly(() => T.job(p, a)), r = q.value || {};
  const added = T.state.log.slice(last ? T.state.log.lastIndexOf(last) + 1 : 0), effects = r.out?.effects || [];
  return {
    ...r, effects, notes: effects.filter((e) => e.t === 'note'), log: added.map((e) => e.txt), entries: added,
    rules: added.filter((e) => e.p === RULES).map((e) => e.txt), warn: q.warn, error: q.error,
  };
}
/** Runs fn(t, p) inside a hook (player p presses Go): job()'s result, with ret and err. */
function run(T, fn, p = HOST) {
  F.fn = fn;
  F.ret = F.err = undefined;
  const r = job(T, p, { t: 'rulesBtn', id: 'go' });
  F.fn = null;
  return { ...r, ret: F.ret, err: F.err };
}
const noted = (r, p, msg) => r.notes.some((n) => n.p === p && n.msg === msg);
/** What a rollback puts back (spec §3f.4), as canonical JSON: items, players,
 *  the rules (data, public, asks, secret, hints included), the table, the
 *  seats, the log, the catalog's ids and records, the counters. */
const STATE_KEYS = ['items', 'players', 'rules', 'table', 'seats', 'log', 'boxSrc', 'zMax', 'boardSeq', 'guestDeckChars', 'lastSetup'];
const stateOf = (T) => canon({ ...Object.fromEntries(STATE_KEYS.map((k) => [k, T.state[k] ?? null])), decks: Object.keys(T.state.decks).sort(), boxes: Object.keys(T.state.boxes).sort() });
/** What differs between two stateOf() strings, by top-level key (for messages). */
function stateDiff(a, b) {
  const A = JSON.parse(a), B = JSON.parse(b);
  return Object.keys({ ...A, ...B }).filter((k) => J(A[k]) !== J(B[k])).map((k) => (k === 'items' || k === 'players'
    ? `${k}: ${Object.keys({ ...A[k], ...B[k] }).filter((id) => J(A[k][id]) !== J(B[k][id])).join(', ')}` : k)).join('; ');
}
/** The table's indexes (byKind, byType, byOwner, byAt, byZone) and T.pub
 *  against the items as they are: [] when all agree, else what differs. */
function indexProblems(T) {
  const bad = [...containmentProblems(T)], items = Object.entries(T.state.items);
  const want = (f) => {
    const m = new Map();
    for (const [id, it] of items) for (const k of f(it)) (m.get(k) || m.set(k, new Set()).get(k)).add(id);
    return m;
  };
  const cmp = (name, got, w) => {
    for (const k of new Set([...got.keys(), ...w.keys()])) if (J([...(got.get(k) || [])].sort()) !== J([...(w.get(k) || [])].sort())) bad.push(`${name}[${k}]`);
  };
  cmp('byKind', new Map([...T.byKind].filter(([, s]) => s.size)), want((it) => [it.k]));
  cmp('byType', T.byType, want((it) => ((it.k === 'g' || it.k === 's') && it.t ? [it.t] : [])));
  cmp('byOwner', T.byOwner, want((it) => (it.owner ? [it.owner] : [])));
  const pub = T.publicItems(); // (a full recompute)
  for (const id of new Set([...T.pub.keys(), ...Object.keys(pub)])) if (canon(T.pub.get(id)) !== canon(pub[id])) bad.push(`T.pub[${id}]`);
  return bad.slice(0, 6);
}
const deepFrozen = (o) => Object.isFrozen(o) && Object.values(o).every((v) => v === null || typeof v !== 'object' || deepFrozen(v));

// The pipeline's table: a chess board B (addresses), two men, a die, a card,
// a pile, a supply, a bag and a hidden piece; Bob holds two cards.
const PIPE = () => ({
  B: BRD('chess', 100, 100), m: PC('man', 1500, 300), n: PC('man', 1700, 300), dd: PC('die', 1900, 300), c: CARD(3, 2100, 300),
  p: PILE([{ d: DK, i: 10, up: false }, { d: DK, i: 11, up: false }], 2300, 300), s: SUP('gem', 2500, 300), bg: BAG(['gem', 'gem'], 2700, 300),
  h: PC('spy', 2900, 300, { up: false }),
});
const HANDS = { [BOB]: [{ d: DK, i: 20 }, { d: DK, i: 21 }] };
/** Bob's drop of man m on address `at` of board B. */
const dropOn = (T, at, id = 'm') => ({ t: 'move', id, ...tl(T, 'man', T.api.spot(at)) });
/** What a failing hook does before it fails: none of it may survive. */
function partial(t) {
  t.move('n', 'a1');
  t.data.k = 1;
  t.public.k = 1;
  t.say('partial');
  t.secret[CAROL] = { text: 'p' };
  t.hint(CAROL, { items: ['n'] });
  t.ask(CAROL, { id: 'pk', prompt: 'P?', options: ['x'] });
  t.spawn(ref('man'), { at: 'h1' });
  t.newDeck({ name: 'Partial', cards: [{ name: 'x' }] });
}
const mark3b = (T) => ({ items: json(T.state.items), decks: Object.keys(T.state.decks).length, log: T.state.log.length });
/** What partial() left on T since mark3b() took `b`: [] when nothing. */
function leftovers(T, b) {
  const bad = [], I = T.state.items, r = T.state.rules || {};
  if (I.n?.x !== b.items.n.x || I.n?.y !== b.items.n.y || (I.n?.at ?? null) !== (b.items.n.at ?? null)) bad.push('n moved');
  const extra = Object.keys(I).filter((id) => !(id in b.items));
  if (extra.length) bad.push(`new items ${J(extra)}`);
  if (Object.keys(T.state.decks).length !== b.decks) bad.push('a new deck');
  if ('k' in (r.data || {}) || 'k' in (r.public || {})) bad.push('t.data.k / t.public.k');
  if (own(r.secret || {}, CAROL) || own(r.hints || {}, CAROL) || own(r.asks || {}, CAROL)) bad.push("Carol's secret, hint or ask");
  if (T.state.log.slice(b.log).some((e) => e.txt === 'partial')) bad.push('the "partial" line');
  return bad;
}

// =============================================================================
// (2) The journal
// =============================================================================
const JOURNAL_ITEMS = () => ({
  B: BRD('chess', 100, 100), m: PC('man', 1500, 300), n: PC('man', 1700, 300), dd: PC('die', 1900, 300), g1: PC('gem', 2000, 600),
  c: CARD(3, 2100, 300), c2: CARD(4, 2100, 600), p: PILE([{ d: DK, i: 10, up: false }, { d: DK, i: 11, up: true }, { d: DK, i: 12, up: false }], 2300, 300),
  q: PILE([{ d: DK, i: 13, up: true }, { d: DK, i: 14, up: true }], 2500, 300), s: SUP('gem', 2500, 700), bg: BAG(['gem', 'tile'], 2700, 300),
  sp: PC('spy', 2900, 300, { up: false }),
});
/** The journal's table over `items` (the makers number z as they go: twins
 *  share one set): Carol has an ask and a secret, Bob a hint, data and public
 *  hold something (set up by setup). */
function journalTable(items = JOURNAL_ITEMS()) {
  return rtable(items, {
    setup(t) {
      t.data.y = 1;
      t.data.obj = { a: 1 };
      t.public.score = 5;
      t.ask(CAROL, { id: 'c1', prompt: 'Carol?', options: ['a', 'b'] });
      t.secret[CAROL] = { text: 'c' };
      t.hint(BOB, { items: ['m'], spaces: ['e4'] });
    },
  }, { hands: HANDS });
}
/** Every mutation helper of §3f.4, through the facade (T.api: the host's plain facade). */
const MUTATIONS = [
  ['put (t.spawn)', (t) => t.spawn(ref('man'), { at: 'd4' })],
  ['put (t.newPile)', (t) => t.newPile([{ d: DK, i: 30, up: true }], { x: 3000, y: 900 })],
  ['put (t.newBag)', (t) => t.newBag([{ t: ref('gem') }], { at: { x: 3200, y: 900 } })],
  ['put (t.take from a supply)', (t) => t.take('s', { at: 'c3' })],
  ['put and touch (t.pull from a bag)', (t) => t.pull('bg', { at: { x: 3300, y: 1300 } })],
  ['remove (t.remove)', (t) => t.remove('n')],
  ['touch (t.move to an address)', (t) => t.move('m', 'e4')],
  ['touch (t.move to x, y)', (t) => t.move('m', 1200, 1400)],
  ['touch (t.flip)', (t) => t.flip('c')],
  ['touch (t.rot)', (t) => t.rot('m', 90)],
  ['touch (t.lock)', (t) => t.lock('m', true)],
  ['touch (t.setFace)', (t) => t.setFace('g1', 2)],
  ['touch (t.setCount)', (t) => t.setCount('g1', 3)],
  ['touch (t.setOwner)', (t) => t.setOwner('m', BOB)],
  ['touch (t.roll)', (t) => { for (let k = 0; k < 4; k++) t.roll('dd'); }],
  ['touch (t.shuffle)', (t) => t.shuffle('p')],
  ['touch and remove (t.merge)', (t) => t.merge('q', 'p')],
  ['touch and remove (t.toPile)', (t) => t.toPile('c', 'p')],
  ['put and remove (t.stack)', (t) => t.stack('c', 'c2')],
  ['touchPlayer (t.deal to a hand)', (t) => t.deal('p', { to: BOB })],
  ['touchPlayer (t.draw)', (t) => t.draw(CAROL, 'q', 2)],
  ['touchPlayer (t.toHand)', (t) => t.toHand(CAROL, 'c')],
  ['touchPlayer and put (t.playFromHand)', (t) => t.playFromHand(BOB, 0, { x: 3000, y: 1200 })],
  ['touchPlayer and remove (t.takeHand)', (t) => t.takeHand(BOB, 'p')],
  ['touchPlayer (t.dealToAll)', (t) => t.dealToAll('p', 1, { onlineOnly: false })],
  ['a catalog add: a deck (t.newDeck)', (t) => t.newDeck({ name: 'Extra', cards: [{ name: 'x' }] })],
  ['a catalog add: a box, and a standard deck', (t) => { t.newBox({ name: 'Journal box', pieces: [{ id: 'pawn', kind: 'token', faces: ['P'] }] }); t.addStandardDeck({ x: 3600, y: 1600 }); }],
  ['the table set (t.setTable)', (t) => t.setTable({ shape: 'rect', w: 4400, h: 3000 })],
  ['the seats set (t.setSeats)', (t) => t.setSeats([{ id: 'north', name: 'North' }, { id: 'south', name: 'South', edge: 'top' }])],
  ['a hint set (t.hint)', (t) => t.hint(CAROL, { items: ['n'], spaces: ['e4'] })],
  ['a hint cleared (t.hint null)', (t) => t.hint(BOB, null)],
  ['log pushes (t.say, t.announce, t.win)', (t) => { t.say('hello'); t.announce('Big news'); t.win(BOB, 'Bob wins'); }],
  ['t.data written', (t) => { t.data.x = 1; delete t.data.y; t.data.obj.a = 2; }],
  ['t.public written, then replaced', (t) => { t.public.score = 6; t.public = { other: 1 }; }],
  ['t.ask and t.cancelAsk', (t) => { t.ask(BOB, { id: 'b1', prompt: 'B?', pick: 'space', among: ['e4', 'd5'] }); t.cancelAsk(CAROL); }],
  ['t.secret set and deleted', (t) => { t.secret[BOB] = { text: 'b' }; delete t.secret[CAROL]; }],
  ['a timer (t.schedule)', (t) => t.schedule(3, 'later')],
  ['a board spawned (boardSeq)', (t) => t.spawn(ref('tray'), { at: { x: 3500, y: 2500 } })],
  ['t.random and t.random-driven aggregation', (t) => { t.random(); for (let k = 0; k < 5; k++) t.spawn(ref('gem'), { at: { x: 3000 + 90 * k, y: 3000 } }); }],
];

function testJournal() {
  section('(2) the journal: begin, a mutation helper, rollback — the table exactly as it was (its indexes and T.pub too), and an empty commit');
  const T = journalTable();
  for (const [what, fn] of MUTATIONS) {
    const before = stateOf(T), d0 = T.digest();
    T.begin();
    const q = quietly(() => fn(T.api)), mid = stateOf(T);
    T.rollback();
    const after = stateOf(T), P = T.commit(), idx = indexProblems(T);
    ok(mid !== before && after === before && T.digest() === d0 && !idx.length && !P.items && !P.players && !P.rules && !P.log && !P.decks && !P.boxes && !('table' in P) && !('seats' in P),
      `${what}: it changed the table (${mid !== before}), and the rollback put back everything (${after === before ? 'yes' : stateDiff(before, after)}); indexes ${idx.length ? J(idx) : 'agree'}; the commit after it is empty (${J(Object.keys(P))})${q.value === false ? ' — the op returned false' : ''}`);
  }

  section('(2) begin, a mutation helper, commit: the patch makes a twin table the same table (every helper, in turn)');
  const twins = JOURNAL_ITEMS(), TA = journalTable(twins), TB = journalTable(twins);
  for (const [what, fn] of MUTATIONS) {
    TA.begin();
    quietly(() => fn(TA.api));
    const P = TA.commit(), q = quietly(() => TB.applyStatePatch(structuredClone(P), { effects: [] })), idx = indexProblems(TB);
    ok(stateOf(TB) === stateOf(TA) && TB.digest() === TA.digest() && !idx.length && !q.error.length,
      `${what}: ${stateOf(TB) === stateOf(TA) ? 'the same table' : stateDiff(stateOf(TA), stateOf(TB))}; the twin's indexes ${idx.length ? J(idx) : 'agree'} (patch: ${J(Object.keys(P))})`);
  }

  section('(2) every mutation helper in one journal, then rollback');
  const T2 = journalTable(), before = stateOf(T2), d0 = T2.digest();
  T2.begin();
  for (const [, fn] of MUTATIONS) quietly(() => fn(T2.api));
  const mid = stateOf(T2);
  T2.rollback();
  const after = stateOf(T2), idx = indexProblems(T2);
  T2.commit();
  ok(mid !== before && after === before && T2.digest() === d0 && !idx.length, `all of them at once: rolled back exactly (${after === before ? 'yes' : stateDiff(before, after)}); indexes ${idx.length ? J(idx) : 'agree'}`);
  const q = quietly(() => T2.apply(BOB, { t: 'rot', id: 'm', rot: 90 }));
  ok(q.value && T2.state.items.m.rot === 90 && !indexProblems(T2).length, 'the table works on after it (a rot applies)');

  section('(2) savepoint / rollbackTo nest: each undoes only what came after its token, data, public, asks and secret as they were there; checkpoint() too');
  const T3 = journalTable(), t = T3.api, s0 = stateOf(T3);
  T3.begin();
  t.move('m', 'a1');
  t.data.s1 = 1;
  t.ask(BOB, { id: 's1', prompt: 'One?', options: ['y'] });
  t.secret[BOB] = { text: 's1' };
  const one = stateOf(T3), tok1 = T3.savepoint();
  t.move('m', 'b2');
  t.remove('n');
  t.data.s2 = 2;
  t.public.s2 = 2;
  t.ask(BOB, { id: 's2', prompt: 'Two?', options: ['y'] });
  delete t.secret[BOB];
  t.hint(CAROL, { items: ['m'] });
  t.say('two');
  const two = stateOf(T3), tok2 = T3.savepoint();
  t.move('m', 'c3');
  quietly(() => t.newDeck({ name: 'Three', cards: [{ name: 'x' }] }));
  quietly(() => t.setTable({ shape: 'rect', w: 4600, h: 3200 }));
  t.data.s3 = 3;
  t.secret[CAROL] = { text: 'three' };
  T3.rollbackTo(tok2);
  ok(stateOf(T3) === two, `rollbackTo(the second token): the third segment is undone, the first two kept (${stateOf(T3) === two ? 'yes' : stateDiff(two, stateOf(T3))})`);
  t.move('m', 'd4');
  T3.rollbackTo(tok1);
  ok(stateOf(T3) === one && !indexProblems(T3).length, `rollbackTo(the first token): only the first segment is left, its data, asks and secret as they were (${stateOf(T3) === one ? 'yes' : stateDiff(one, stateOf(T3))})`);
  const cp = T3.checkpoint();
  t.move('m', 'h8');
  t.data.s4 = 4;
  T3.rollbackTo(cp);
  ok(stateOf(T3) === one, 'checkpoint(): a later rollbackTo(it) keeps what came before it');
  const P = T3.commit();
  ok(T3.api.where('m') === 'a1' && P.items?.m && J(P.items.m) === J(T3.state.items.m) && !('n' in (P.items || {})) && J(P.rules?.data) === J({ y: 1, obj: { a: 1 }, s1: 1 })
    && J(P.rules?.asks?.[BOB]?.map((x) => x.id)) === J(['s1']) && P.rules?.secret?.[BOB]?.text === 's1' && !P.decks && !('table' in P) && !('public' in (P.rules || {})),
  `commit after them: the first segment only (${J({ items: Object.keys(P.items || {}), rules: Object.keys(P.rules || {}), data: P.rules?.data })})`);
  T3.begin();
  T3.rollback();
  T3.commit();
  ok(s0 !== stateOf(T3), '(the first segment stayed committed)');

  section('(2) commit: the StatePatch of what the job wrote — whole private items (null: removed; sorted ids), players with hands, new catalog entries, the rules fields that changed, seats, log, counters');
  const twin = JOURNAL_ITEMS(), A = journalTable(twin), Bt = journalTable(twin);
  ok(A.digest() === Bt.digest() && stateOf(A) === stateOf(Bt), 'two tables built alike are alike (the patch\'s target)');
  A.begin();
  const a = A.api;
  a.move('m', 'e4');
  a.remove('n');
  const nid = a.spawn(ref('man'), { at: 'd5' });
  a.deal('p', { to: BOB });
  const deckId = a.newDeck({ name: 'Patched', cards: [{ name: 'x' }] });
  const boxId = a.newBox({ name: 'Patch box', pieces: [{ id: 'pawn', kind: 'token', faces: ['P'] }] });
  a.data.k = 1;
  a.ask(BOB, { id: 'pb', prompt: 'Patched?', options: ['y'] });
  a.say('patched');
  quietly(() => a.setSeats([{ id: 'north', name: 'North' }, { id: 'south', name: 'South', edge: 'top' }]));
  const PA = A.commit(), I = A.state.items;
  const ids = Object.keys(PA.items || {});
  ok(J(ids) === J([...ids].sort()) && J(PA.items.m) === J(I.m) && PA.items.n === null && J(PA.items[nid]) === J(I[nid]) && J(PA.items.p) === J(I.p) && PA.items.p.cards.every((c) => Number.isInteger(c.i)),
    `items: sorted, whole and private (a pile's face-down cards with their identities), a removed one null (${J(ids)})`);
  ok(J(PA.players?.[BOB]?.hand) === J(A.state.players[BOB].hand) && PA.players[BOB].hand.length === 3, 'players: whole, hands included');
  ok(J(PA.decks?.[deckId]) === J(A.state.decks[deckId]) && PA.boxes?.[boxId]?.src === 'script' && J(PA.boxes[boxId].box) === J(A.state.boxes[boxId]), 'the new deck, and the new box as a catalog record {box, src: script}');
  ok(J(PA.rules?.data) === J(A.state.rules.data) && J(PA.rules.asks) === J(A.state.rules.asks) && ['public', 'secret', 'code', 'name', 'enabled'].every((k) => !(k in PA.rules)),
    `rules: only the fields that changed (${J(Object.keys(PA.rules || {}))})`);
  ok(PA.log?.some((e) => e.txt === 'patched' && e.p === RULES) && J(PA.seats) === J(A.state.seats) && !('table' in PA) && PA.zMax === A.state.zMax, 'the log lines, the seats, zMax; no table (unchanged)');
  quietly(() => Bt.applyStatePatch(structuredClone(PA), { effects: [] }));
  ok(Bt.digest() === A.digest() && stateOf(Bt) === stateOf(A) && !indexProblems(Bt).length, `applied to its twin, the patch makes it the same table (${stateOf(Bt) === stateOf(A) ? 'yes' : stateDiff(stateOf(A), stateOf(Bt))})`);
}

// =============================================================================
// (3) The ruled-action pipeline with a fake script
// =============================================================================
function testPipelineVeto() {
  section('(3) handle vetoes after doing ops: none of its ops, the veto line, the refresh, the hint restored');
  const calls = [];
  const T = rtable(PIPE(), {
    handle(t, a) { calls.push('handle'); if (a.t === 'move') { partial(t); t.hint(BOB, null); t.move('m', 'h8'); return 'Nope, not there'; } },
    validate() { calls.push('validate'); },
    onAction() { calls.push('onAction'); },
  });
  run(T, (t) => t.hint(BOB, { items: ['m'], spaces: ['e4'] }));
  const hint0 = json(T.state.rules.hints[BOB]);
  T.takeDirty();
  calls.length = 0;
  const b = mark3b(T), m0 = J(T.state.items.m), data0 = J(T.state.rules.data), pub0 = J(T.state.rules.public);
  const r = job(T, BOB, dropOn(T, 'e4'));
  const left = leftovers(T, b);
  ok(!left.length && J(T.state.items.m) === m0 && J(T.state.rules.data) === data0 && J(T.state.rules.public) === pub0,
    `none of handle's ops survive, and the move is not applied (${left.length ? J(left) : 'nothing left'})`);
  ok(J(r.log) === J(['blocked Bob: Nope, not there']) && J(r.rules) === J(r.log), `the one log line: "blocked Bob: Nope, not there", as Rules (${J(r.log)})`);
  ok(noted(r, BOB, '🚫 Nope, not there'), 'the actor is told: "🚫 Nope, not there"');
  ok(r.patch?.refresh?.includes('m') && !r.patch.items, `the refresh: m re-sent unchanged (refresh ${J(r.patch?.refresh)}, items ${J(Object.keys(r.patch?.items || {}))})`);
  const d = T.takeDirty();
  ok(J(T.state.rules.hints?.[BOB]) === J(hint0) && !d.hints.has(BOB), `the hint the action cleared (and handle cleared again) is back, so no part is re-sent (${J(T.state.rules.hints?.[BOB])})`);
  ok(J(calls) === J(['handle']) && T.state.rules.enabled, `no validate, no onAction; the rules stay on (${J(calls)})`);
}

function testPipelineFailClosed() {
  section('(3) handle or validate throws, or returns a thenable (an async hook, a Promise): none of its ops, the action not applied, the rules disabled (fail CLOSED)');
  const VARIANTS = [
    ['throws', (t) => { partial(t); throw new Error('boom'); }],
    ['is an async function (that would allow)', async (t) => { partial(t); }],
    ['is an async function (that would veto)', async (t) => { partial(t); return 'no'; }],
    ['returns a Promise', (t) => { partial(t); return Promise.resolve(); }],
    ['returns a thenable object', (t) => { partial(t); return { then() {} }; }],
  ];
  for (const hook of ['handle', 'validate']) {
    for (const [what, fn] of VARIANTS) {
      const calls = [];
      const T = rtable(PIPE(), { [hook]: (t, a) => (a.t === 'move' ? fn(t) : undefined), onAction() { calls.push('onAction'); } });
      const b = mark3b(T), m0 = J(T.state.items.m);
      const r = job(T, BOB, dropOn(T, 'e4'));
      const left = leftovers(T, b);
      ok(!left.length && J(T.state.items.m) === m0 && !calls.length, `${hook} ${what}: none of its ops (${left.length ? J(left) : 'nothing left'}), the move not applied, no onAction`);
      ok(!T.state.rules.enabled && r.patch?.rules?.enabled === false && r.log.includes(`rules disabled — script error in ${hook}()`) && noted(r, BOB, '🚫 rules script error')
        && r.out?.error?.hook?.startsWith(hook) && typeof r.out.error.message === 'string' && r.patch.refresh?.includes('m'),
      `${hook} ${what}: the rules disabled (in the patch); "rules disabled — script error in ${hook}()"; the actor told "🚫 rules script error"; out.error names ${hook}; m re-sent (${J(r.log)}, ${J(r.out?.error)})`);
    }
  }

  section('(3) a handle or validate that breaks the engine\'s gates (t.data over 4,000,000 chars) fails closed too (D122)');
  for (const hook of ['handle', 'validate']) {
    const T = rtable(PIPE(), { [hook]: (t, a) => { if (a.t === 'move') t.data.big = 'x'.repeat(4e6); } });
    const m0 = J(T.state.items.m), r = job(T, BOB, dropOn(T, 'e4'));
    ok(J(T.state.items.m) === m0 && !('big' in T.state.rules.data) && !T.state.rules.enabled && noted(r, BOB, '🚫 rules script error'),
      `${hook} grows t.data past 4e6 chars: the move not applied, the data dropped, the rules disabled (${J(r.log)})`);
  }
}

/** The hooks that run after the checkpoint (§3f.4's third row): each one's
 *  trigger, and what the action's own default effect leaves, which is kept. */
const AFTER_HOOKS = {
  onAction: { act: (T) => job(T, BOB, dropOn(T, 'e4')), kept: (T) => T.api.where('m') === 'e4', what: 'the move' },
  onChat: { act: (T) => job(T, BOB, { t: 'chat', msg: 'hello there' }), kept: (T, r) => r.entries.some((e) => e.p === BOB && e.txt === 'hello there' && e.c), what: 'the chat line' },
  onButton: { act: (T) => job(T, BOB, { t: 'rulesBtn', id: 'go' }), kept: () => true, what: '(no effect of its own)' },
  onAnswer: {
    prep: (t) => t.ask(BOB, { id: 'q', prompt: 'Q?', options: ['yes'] }),
    act: (T) => job(T, BOB, { t: 'answer', id: 'q', v: 0 }), kept: (T, r) => !own(T.state.rules.asks || {}, BOB) && r.entries.some((e) => e.p === BOB && e.txt === 'answered'), what: 'the ask removed, "answered"',
  },
  onSelect: { act: (T) => job(T, BOB, { t: 'select', id: 'm' }), kept: () => true, what: '(no effect of its own)' },
  onJoin: { act: (T) => job(T, DAVE, { t: '_join', name: 'Dave' }), kept: (T, r) => T.state.players[DAVE]?.online === true && T.state.players[DAVE].name === 'Dave' && r.entries.some((e) => e.p === DAVE && e.txt === 'joined the table'), what: 'the registration' },
  onLeave: { act: (T) => job(T, BOB, { t: '_leave' }), kept: (T, r) => T.state.players[BOB].online === false && r.entries.some((e) => e.p === BOB && e.txt === 'left the table'), what: 'Bob offline, "left the table"' },
  onTimer: { prep: (t) => t.schedule(0, 'now'), act: (T) => job(T, RULES, { t: '_tick' }), kept: (T) => J(T.state.rules.data._timers || []) === '[]', what: 'the timer taken off the list' },
  setup: {
    act: (T) => job(T, HOST, { t: 'setRules', enabled: true, code: fake({ setup: F.failing }) }),
    kept: (T, r) => T.state.rules?.name === 'Fake' && typeof T.state.rules.code === 'string' && r.rules.some((x) => x.startsWith('«Fake» enabled by Alice')), what: 'the rules registered, "«Fake» enabled by Alice"',
  },
};
function testPipelineAfterHooks() {
  section('(3) onAction, onChat, onButton, onAnswer, onSelect, onJoin, onLeave, onTimer or setup throws, or returns a thenable: the action\'s own effect kept, the hook\'s ops discarded, the rules disabled');
  const FAILS = [['throws', (t) => { partial(t); throw new Error('after-boom'); }], ['returns a Promise', (t) => { partial(t); return Promise.resolve(); }], ['returns a thenable object', (t) => { partial(t); return { then() {} }; }]];
  for (const [hook, c] of Object.entries(AFTER_HOOKS)) {
    for (const [what, failing] of FAILS) {
      let T;
      if (hook === 'setup') {
        T = rtable(PIPE(), null);
        F.failing = failing;
      } else {
        T = rtable(PIPE(), { [hook]: (t, ...args) => (F.armed ? failing(t, ...args) : undefined), setup: (t) => c.prep?.(t) });
        F.armed = true;
      }
      const b = mark3b(T), r = c.act(T), left = leftovers(T, b);
      ok(c.kept(T, r) && !left.length && T.state.rules && !T.state.rules.enabled && r.log.includes(`rules disabled — script error in ${hook}()`) && r.out?.error?.hook?.startsWith(hook),
        `${hook} ${what}: ${c.what} kept (${c.kept(T, r)}); its ops discarded (${left.length ? J(left) : 'yes'}); the rules disabled, "script error in ${hook}()" (${J(r.rules)})`);
    }
  }

  section('(3) buttons() throws: the action kept, the onAction before it undone too (one checkpoint), public.buttons keeps its last value, the rules disabled');
  let boom = false;
  const T = rtable(PIPE(), {
    buttons: (t) => { if (boom) { partial(t); throw new Error('buttons broke'); } return [{ id: 'go', label: 'Go' }, { id: 'more', label: 'More' }]; },
    onAction(t) { t.data.fromOnAction = 1; t.move('n', 'b2'); },
  });
  const was = J(T.state.rules.public.buttons), b = mark3b(T);
  boom = true;
  const r = job(T, BOB, dropOn(T, 'e4'));
  ok(T.api.where('m') === 'e4' && !('fromOnAction' in T.state.rules.data) && !leftovers(T, b).length && J(T.state.rules.public.buttons) === was && !T.state.rules.enabled && r.log.includes('rules disabled — script error in buttons()'),
    `the move kept; onAction's and buttons()'s ops gone (${J(leftovers(T, b))}); buttons still ${J(T.state.rules.public.buttons)}; the rules disabled (${J(r.rules)})`);

  section('(3) a hook after the checkpoint that breaks the engine\'s gates is undone back to the checkpoint (D122): the action kept');
  const T2 = rtable(PIPE(), { onAction(t) { t.move('n', 'b2'); t.data.big = 'x'.repeat(4e6); } });
  job(T2, BOB, dropOn(T2, 'e4'));
  ok(T2.api.where('m') === 'e4' && T2.api.where('n') === null && !('big' in T2.state.rules.data) && !T2.state.rules.enabled, 'onAction grows t.data past 4e6: the move stays, n is back, the data gone, the rules off');
}

function testStrict() {
  section('(3) strict: every ruled action but seat is refused ("Not a move in this game") unless handle returns true or allow lists it');
  const SPEC_RULED = ['move', 'rot', 'flip', 'shuffle', 'draw', 'deal', 'play', 'handPile', 'toHand', 'toPile', 'stack', 'merge', 'del', 'addDeck', 'peek',
    'roll', 'face', 'split', 'join', 'take', 'pull', 'toBag', 'lock', 'owner', 'seat'];
  ok(sameSet([...RULED_ACTIONS], SPEC_RULED) && sameSet([...STRICT_ACTIONS], SPEC_RULED.filter((t) => t !== 'seat')), 'RULED_ACTIONS is §10.1\'s list; STRICT_ACTIONS is it without seat');
  const seen = [];
  const T = rtable(PIPE(), { onAction(t, a) { seen.push(a.t); } }, { flags: { strict: true }, hands: HANDS });
  ok(T.snapContent().rules?.strict === true && !('wants' in T.snapContent().rules), `the rules view says strict: true (${J(T.snapContent().rules)})`);
  const payload = { id: 'm', ids: ['dd'], pile: 'p', onto: 'n', bag: 'bg', x: 600, y: 600, rot: 90, f: 1, n: 1, on: true, to: BOB, idx: 0, d: DK, i: 20, up: true, deck: { name: 'X', cards: [{ n: 'a' }] } };
  for (const t of SPEC_RULED.filter((x) => x !== 'seat')) {
    // (a second apart, after a line of the host's: notices are flood-limited, and the log collapses a repeated line)
    T.clk.t += 1000;
    job(T, HOST, { t: 'chat', msg: `next: ${t}` });
    const d0 = T.digest(), r = job(T, BOB, { t, ...payload });
    ok(noted(r, BOB, '🚫 Not a move in this game') && J(r.rules) === J(['blocked Bob: Not a move in this game']) && T.digest() === d0 && T.state.rules.enabled, `strict refuses ${t} (${J(r.log)})`);
  }
  const ruledSeen = () => seen.filter((x) => RULED_ACTIONS.includes(x));
  ok(!ruledSeen().length, `no refused action reached onAction (${J(ruledSeen())})`);
  let r = job(T, BOB, { t: 'seat', watch: true });
  ok(T.state.players[BOB].seat === null && !noted(r, BOB, '🚫 Not a move in this game') && J(ruledSeen()) === J(['seat']), 'seat is never refused by strict: Bob stands up to watch (and onAction sees it)');
  r = job(T, BOB, { t: 'seat', sit: true });
  ok(T.state.players[BOB].seat !== null, 'and sits down again');
  r = job(T, BOB, { t: 'chat', msg: 'still talking' });
  const r2 = job(T, BOB, { t: 'name', name: 'Robert' });
  ok(r.entries.some((e) => e.txt === 'still talking') && T.state.players[BOB].name === 'Robert' && !noted(r, BOB, '🚫 Not a move in this game') && !noted(r2, BOB, '🚫 Not a move in this game'), 'actions that are not ruled (chat, name) are not refused');

  section('(3) strict with allow: the listed types keep their default effect');
  const T2 = rtable(PIPE(), {}, { flags: { strict: true, allow: ['rot', 'flip'] } });
  job(T2, BOB, { t: 'rot', id: 'm', rot: 90 });
  const up0 = T2.state.items.c.up;
  job(T2, BOB, { t: 'flip', id: 'c' });
  r = job(T2, BOB, dropOn(T2, 'e4'));
  ok(T2.state.items.m.rot === 90 && T2.state.items.c.up !== up0 && T2.api.where('m') === null && noted(r, BOB, '🚫 Not a move in this game'), 'allow: [rot, flip] — both apply; a move is still refused');

  section('(3) strict and handle: an action handle takes (true) is not refused; one it leaves (undefined) is');
  const T3 = rtable(PIPE(), { handle(t, a) { if (a.t === 'move') { t.move(a.id, a.to); return true; } } }, { flags: { strict: true } });
  r = job(T3, BOB, dropOn(T3, 'e4'));
  ok(T3.api.where('m') === 'e4' && !noted(r, BOB, '🚫 Not a move in this game'), 'handled: the script moved it to a.to, no refusal');
  r = job(T3, BOB, { t: 'rot', id: 'm', rot: 90 });
  ok(T3.state.items.m.rot === 0 && noted(r, BOB, '🚫 Not a move in this game'), 'not handled: refused');

  section('(3) seat under strict: handle and validate may still veto it');
  const T4 = rtable(PIPE(), { handle(t, a) { if (a.t === 'seat' && a.p === CAROL) return 'Carol stays'; }, validate(t, a) { if (a.t === 'seat' && a.sit) return 'No sitting'; } }, { flags: { strict: true } });
  r = job(T4, CAROL, { t: 'seat', watch: true });
  ok(T4.state.players[CAROL].seat !== null && noted(r, CAROL, '🚫 Carol stays'), 'handle vetoes Carol\'s seat change');
  job(T4, BOB, { t: 'seat', watch: true });
  r = job(T4, BOB, { t: 'seat', sit: true });
  ok(T4.state.players[BOB].seat === null && noted(r, BOB, '🚫 No sitting'), 'validate vetoes Bob\'s sit (he stood up; he stays a watcher)');
}

function testPipelineOrder() {
  section('(3) handle runs before validate; true skips validate and the default effect; a string vetoes; any other return goes on');
  const order = [];
  let hv;
  const T = rtable(PIPE(), { handle() { order.push('handle'); return hv; }, validate() { order.push('validate'); } });
  for (const [v, want, applied, what] of [[undefined, ['handle', 'validate'], true, 'undefined'], [true, ['handle'], false, 'true'], ['No', ['handle'], false, 'a string'],
    [1, ['handle', 'validate'], true, '1'], [false, ['handle', 'validate'], true, 'false'], [null, ['handle', 'validate'], true, 'null'], [{}, ['handle', 'validate'], true, '{}']]) {
    order.length = 0;
    hv = v;
    const rot0 = T.state.items.m.rot;
    job(T, BOB, { t: 'rot', id: 'm', rot: (rot0 + 90) % 360 });
    ok(J(order) === J(want) && (T.state.items.m.rot !== rot0) === applied, `handle returns ${what}: ${J(order)}, the rot ${applied ? 'applied' : 'not applied'}`);
  }

  section('(3) onAction runs after a handled action with a.handled = true (handle\'s ops kept, no default effect), and without it otherwise');
  const seen = [];
  const T2 = rtable(PIPE(), { handle(t, a) { if (a.t === 'move') { t.move('n', 'b2'); return true; } }, onAction(t, a) { seen.push({ t: a.t, handled: a.handled, p: a.p, frozen: deepFrozen(a) }); } });
  const m0 = J(T2.state.items.m);
  job(T2, BOB, dropOn(T2, 'e4'));
  ok(J(T2.state.items.m) === m0 && T2.api.where('n') === 'b2' && J(seen) === J([{ t: 'move', handled: true, p: BOB, frozen: true }]), `handled: m stays, n is on b2, onAction saw ${J(seen)}`);
  job(T2, BOB, { t: 'rot', id: 'm', rot: 90 });
  ok(seen.length === 2 && seen[1].t === 'rot' && seen[1].handled === undefined && T2.state.items.m.rot === 90, `not handled: onAction saw ${J(seen[1])}`);

  section('(3) hooks run as methods of the script (`this`), whose own properties are not journaled: they survive a veto');
  const T5 = rtable(PIPE(), { handle(t, a) { this.tries = (this.tries || 0) + 1; F.self = this; t.data.tries = this.tries; return 'no'; } });
  job(T5, BOB, { t: 'rot', id: 'm', rot: 90 });
  job(T5, BOB, { t: 'rot', id: 'm', rot: 90 });
  ok(F.self?.name === 'Fake' && F.self.tries === 2 && !('tries' in T5.state.rules.data), `this is the script; this.tries counted both vetoed tries (${F.self?.tries}), t.data.tries was rolled back`);

  section('(3) onAction also runs after chat and rulesBtn (answer: see (A)); not after a rename');
  const after = [];
  const T4 = rtable(PIPE(), { onAction(t, a) { after.push(a.t); } });
  job(T4, BOB, { t: 'chat', msg: 'hello' });
  job(T4, BOB, { t: 'rulesBtn', id: 'go' });
  job(T4, BOB, { t: 'name', name: 'Robert' });
  ok(J(after) === J(['chat', 'rulesBtn']), `onAction saw ${J(after)}`);

  section('(3) hooks get `a` as a frozen deep copy {…a, p, to?, from?}: a script can never change the action core applies');
  const probes = {};
  const probe = (name) => (t, a) => {
    let threw = false, threwDeep = false;
    try { a.x = 0; } catch (e) { threw = e instanceof TypeError; }
    if (a.ids) try { a.ids.push('zz'); } catch (e) { threwDeep = e instanceof TypeError; }
    (probes[a.t] ||= {})[name] = { frozen: deepFrozen(a), threw, threwDeep: a.ids ? threwDeep : null, p: a.p, to: a.to };
  };
  const T3 = rtable(PIPE(), { handle: probe('handle'), validate: probe('validate'), onAction: probe('onAction') });
  const drop = dropOn(T3, 'e4'), sent = J(drop);
  job(T3, BOB, drop);
  job(T3, BOB, { t: 'roll', ids: ['dd'] });
  const want = (to, deep) => J({ frozen: true, threw: true, threwDeep: deep, p: BOB, to });
  ok(['handle', 'validate', 'onAction'].every((h) => J(probes.move?.[h]) === want('e4', null)) && T3.api.where('m') === 'e4' && J(drop) === sent,
    `a move: frozen in handle, validate and onAction, a write throws, p is Bob, to is e4; the move applied as sent, and the payload object untouched (${J(probes.move)})`);
  ok(['handle', 'validate', 'onAction'].every((h) => J(probes.roll?.[h]) === want(undefined, true)), `a roll: a.ids frozen too (${J(probes.roll)})`);
}

function testHandledRefresh() {
  section('(3) an action handle takes (true) without touching what it names refresh-touches it: the patch re-sends those items and hands');
  const T = rtable(PIPE(), { handle: () => true }, { hands: HANDS });
  for (const [a, ids, hands] of [
    [dropOn(T, 'e4'), ['m'], []],
    [{ t: 'toPile', id: 'c', pile: 'p' }, ['c', 'p'], []],
    [{ t: 'stack', id: 'c', onto: 'p' }, ['c', 'p'], []],
    [{ t: 'toBag', id: 'n', bag: 'bg' }, ['n', 'bg'], []],
    [{ t: 'roll', ids: ['dd'] }, ['dd'], []],
    [{ t: 'play', idx: 0, d: DK, i: 20, x: 3000, y: 900, up: true }, [], [BOB]],
    [{ t: 'take', id: 's', x: 3000, y: 900 }, ['s'], []],
  ]) {
    const items0 = J(T.state.items), hand0 = J(T.state.players[BOB].hand), r = job(T, BOB, a);
    ok(J(T.state.items) === items0 && J(T.state.players[BOB].hand) === hand0 && sameSet(r.patch?.refresh || [], ids) && sameSet(r.patch?.refreshHands || [], hands) && !r.patch?.items,
      `${a.t}: nothing changed; refresh ${J(r.patch?.refresh)}, refreshHands ${J(r.patch?.refreshHands)} (want ${J(ids)}, ${J(hands)})`);
  }
}

function testHints() {
  section('(3) a ruled action clears its player\'s hint as it starts: a vetoed one (validate, handle, strict) puts it back; an applied or handled one leaves it cleared');
  let mode = null;
  const hooks = { handle() { if (mode === 'handle-veto') return 'h-no'; if (mode === 'handled') return true; }, validate() { if (mode === 'veto') return 'v-no'; } };
  const T = rtable(PIPE(), hooks), TS = rtable(PIPE(), hooks, { flags: { strict: true } });
  for (const [m, kept, Tx] of [['veto', true, T], ['handle-veto', true, T], ['strict', true, TS], ['apply', false, T], ['handled', false, T]]) {
    run(Tx, (t) => { t.hint(BOB, { items: ['n'] }); t.hint(CAROL, { items: ['m'] }); });
    Tx.takeDirty();
    mode = m;
    job(Tx, BOB, { t: 'rot', id: 'm', rot: (Tx.state.items.m.rot + 90) % 360 });
    mode = null;
    const d = Tx.takeDirty(), h = Tx.state.rules.hints || {};
    ok(!!own(h, BOB) === kept && J(own(h, CAROL)?.items) === J(['m']) && d.hints.has(BOB) === !kept && !d.hints.has(CAROL),
      `${m}: Bob's hint ${kept ? 'back' : 'cleared'} (${J(own(h, BOB))}); Carol's untouched; only ${kept ? 'nobody' : 'Bob'} gets a hint part`);
  }
  run(T, (t) => t.hint(BOB, { items: ['n'] }));
  job(T, BOB, { t: 'chat', msg: 'hi' });
  ok(!!own(T.state.rules.hints, BOB), 'an action that is not ruled (chat) leaves the hint');
}

// =============================================================================
// (4) Asks, and the engine-state gates
// =============================================================================
function testCleanAsk() {
  section('(4) cleanAsk accepts each form: options (labels or {label, value}), pick item, space, hand, number');
  const opts = cleanAsk({ id: 'q', prompt: 'Pick', options: ['♕', { label: 'Rook', value: { r: 1 } }] });
  ok(J(opts.options) === J([{ label: '♕', value: '♕' }, { label: 'Rook', value: { r: 1 } }]) && opts.id === 'q' && opts.prompt === 'Pick', `plain-string options mean {label, value: label} (${J(opts.options)})`);
  const big = { id: 'Q_9-zZ'.padEnd(24, 'x'), prompt: 'p'.repeat(200), options: range(20).map((k) => `o${k}`.padEnd(30, '.')) };
  const okForms = [
    ['24-char id, 200-char prompt, 20 options of 30 chars', big],
    ['a value of 2,000 chars of JSON', { id: 'v', prompt: '', options: [{ label: 'x', value: 'v'.repeat(1998) }] }],
    ['pick item with among', { id: 'i', prompt: 'Which?', pick: 'item', among: ['a', 'b'] }],
    ['pick item with 200 among', { id: 'i', prompt: 'Which?', pick: 'item', among: range(200).map((k) => `id${k}`) }],
    ['pick space with among', { id: 's', prompt: 'Where?', pick: 'space', among: ['e4', 'map:c3'] }],
    ['pick hand (count 1 by default)', { id: 'h', prompt: 'Discard', pick: 'hand' }],
    ['pick hand, count 20', { id: 'h', prompt: 'Discard', pick: 'hand', count: 20 }],
    ['pick number, 0 to 1,000,000', { id: 'n', prompt: 'Bid', pick: 'number', min: 0, max: 1e6 }],
    ['pick number, -5 to -5', { id: 'n', prompt: 'Bid', pick: 'number', min: -5, max: -5 }],
  ];
  for (const [what, spec] of okForms) {
    let out, err;
    try { out = cleanAsk(json(spec)); } catch (e) { err = e; }
    ok(out && !err && out.id === spec.id && (spec.pick ? out.pick === spec.pick : out.options.length === spec.options.length), `${what}: accepted (${err?.message || 'ok'})`);
  }
  section('(4) cleanAsk refuses anything else with a TypeError');
  const base = { id: 'q', prompt: 'P' };
  const bad = [
    ['not an object', 'ask'], ['null', null], ['an array', []],
    ['no id', { prompt: 'P', options: ['a'] }], ['an empty id', { ...base, id: '', options: ['a'] }], ['an id with a space', { ...base, id: 'a b', options: ['a'] }],
    ['a 25-char id', { ...base, id: 'x'.repeat(25), options: ['a'] }], ['an id that is a number', { ...base, id: 5, options: ['a'] }],
    ['no prompt', { id: 'q', options: ['a'] }], ['a 201-char prompt', { ...base, prompt: 'p'.repeat(201), options: ['a'] }], ['a prompt that is a number', { ...base, prompt: 5, options: ['a'] }],
    ['both options and pick', { ...base, options: ['a'], pick: 'number', min: 0, max: 1 }], ['neither options nor pick', { ...base }],
    ['no options (empty list)', { ...base, options: [] }], ['21 options', { ...base, options: range(21).map(String) }], ['options that are no list', { ...base, options: 'a' }],
    ['an empty label', { ...base, options: [''] }], ['a 31-char label', { ...base, options: ['x'.repeat(31)] }], ['an option that is a number', { ...base, options: [5] }],
    ['an option without a label', { ...base, options: [{ value: 1 }] }], ['a value that is a function', { ...base, options: [{ label: 'a', value: () => 1 }] }],
    ['a value that is a BigInt', { ...base, options: [{ label: 'a', value: 1n }] }], ['a value of 2,001 chars of JSON', { ...base, options: [{ label: 'a', value: 'v'.repeat(1999) }] }],
    ['options with among', { ...base, options: ['a'], among: ['x'] }], ['options with count', { ...base, options: ['a'], count: 1 }], ['options with min and max', { ...base, options: ['a'], min: 0, max: 1 }],
    ['an unknown pick', { ...base, pick: 'card' }], ['pick item without among', { ...base, pick: 'item' }], ['pick space without among', { ...base, pick: 'space' }],
    ['201 among', { ...base, pick: 'item', among: range(201).map((k) => `id${k}`) }], ['among with a number in it', { ...base, pick: 'item', among: ['a', 5] }], ['among that is no list', { ...base, pick: 'space', among: 'e4' }],
    ['among with pick hand', { ...base, pick: 'hand', among: ['a'] }], ['among with pick number', { ...base, pick: 'number', min: 0, max: 1, among: ['a'] }],
    ['count 0', { ...base, pick: 'hand', count: 0 }], ['count 21', { ...base, pick: 'hand', count: 21 }], ['count 1.5', { ...base, pick: 'hand', count: 1.5 }], ['count with pick item', { ...base, pick: 'item', among: ['a'], count: 1 }],
    ['number with min > max', { ...base, pick: 'number', min: 3, max: 2 }], ['number 1,000,001 apart', { ...base, pick: 'number', min: 0, max: 1e6 + 1 }], ['number with min 0.5', { ...base, pick: 'number', min: 0.5, max: 2 }],
    ['number without max', { ...base, pick: 'number', min: 0 }], ['min and max with pick item', { ...base, pick: 'item', among: ['a'], min: 0, max: 1 }],
    ['an unknown field', { ...base, options: ['a'], extra: 1 }],
  ];
  for (const [what, spec] of bad) {
    let err = null;
    try { cleanAsk(spec); } catch (e) { err = e; }
    ok(err instanceof TypeError, `${what}: ${err ? `TypeError: ${err.message}` : 'accepted'}`);
  }
}

function testAskFacade() {
  section('(4) t.ask stores a cleaned ask in rules.asks[pid]: TypeErrors name the call; a player at the table; 8 pending at most; the same id replaces; space picks in display forms');
  const T = rtable(PIPE(), {});
  let r = run(T, (t) => t.ask(BOB, { id: 'o', prompt: 'Promote to', options: ['♕', '♖'] }));
  ok(r.ret === undefined && !r.err && J(T.state.rules.asks[BOB]) === J([{ id: 'o', prompt: 'Promote to', options: [{ label: '♕', value: '♕' }, { label: '♖', value: '♖' }] }]),
    `stored, plain-string options as {label, value} (${J(T.state.rules.asks[BOB])})`);
  ok(!r.log.length, 'asks are private: no log line');
  for (const [what, fn] of [['a bad spec', (t) => t.ask(BOB, { id: 'x', prompt: 'P' })], ['a player not at the table', (t) => t.ask(EVE, { id: 'x', prompt: 'P', options: ['a'] })],
    ['a space no board has', (t) => t.ask(BOB, { id: 'x', prompt: 'P', pick: 'space', among: ['z99'] })]]) {
    r = run(T, fn);
    ok(r.err instanceof TypeError && r.err.message.startsWith('t.ask') && T.state.rules.asks[BOB].length === 1, `${what}: a TypeError naming t.ask (${r.err?.message})`);
  }
  r = run(T, (t) => { for (let k = 1; k < 8; k++) t.ask(BOB, { id: `k${k}`, prompt: `P${k}`, options: ['a'] }); });
  ok(T.state.rules.asks[BOB].length === 8, '8 pending');
  r = run(T, (t) => t.ask(BOB, { id: 'k9', prompt: 'P9', options: ['a'] }));
  ok(r.err instanceof TypeError && r.err.message.startsWith('t.ask') && T.state.rules.asks[BOB].length === 8, `a 9th: TypeError (${r.err?.message})`);
  r = run(T, (t) => t.ask(BOB, { id: 'k3', prompt: 'Replaced', pick: 'number', min: 1, max: 2 }));
  const k3 = T.state.rules.asks[BOB].filter((x) => x.id === 'k3');
  ok(!r.err && T.state.rules.asks[BOB].length === 8 && k3.length === 1 && k3[0].prompt === 'Replaced' && k3[0].pick === 'number', 'the same id again replaces that ask, even with 8 pending');
  r = run(T, (t) => t.ask(CAROL, { id: 'sp', prompt: 'Where?', pick: 'space', among: ['E4', 'B:d5'] }));
  ok(!r.err && J(T.state.rules.asks[CAROL][0].among) === J(['e4', 'd5']), `a space pick's among in display forms (${J(T.state.rules.asks[CAROL]?.[0]?.among)}, ${r.err?.message})`);

  section('(4) t.cancelAsk(pid, id?) and t.asks(pid) (copies)');
  r = run(T, (t) => [t.cancelAsk(BOB, 'k3'), t.cancelAsk(BOB, 'k3'), t.asks(BOB).length]);
  ok(J(r.ret) === J([true, false, 7]), `one ask: true, then false (${J(r.ret)})`);
  r = run(T, (t) => { const l = t.asks(BOB); l[0].prompt = 'mutated'; l.pop(); return t.asks(BOB).length; });
  ok(r.ret === 7 && T.state.rules.asks[BOB][0].prompt !== 'mutated', 't.asks hands out copies');
  r = run(T, (t) => [t.cancelAsk(BOB), t.cancelAsk(BOB), t.asks(BOB)]);
  ok(J(r.ret) === J([true, false, []]) && !own(T.state.rules.asks, BOB), `all of a player's: true, then false; none left (${J(r.ret)})`);

  section('(4) t.hint(pid, {items?, spaces?} | null): at most 500 entries in all; a player at the table; spaces in display form; an item gone is dropped (console.warn); null clears');
  const ids = range(300).map(() => 'm');
  r = run(T, (t) => t.hint(BOB, { items: ids, spaces: range(200).map(() => 'B:e4') }));
  ok(!r.err && T.state.rules.hints[BOB].items.length === 300 && T.state.rules.hints[BOB].spaces.every((s) => s === 'e4'), `500 entries: kept, the spaces as "e4" (${r.err?.message || 'ok'})`);
  for (const [what, fn] of [['501 entries', (t) => t.hint(BOB, { items: [...ids, 'm'], spaces: range(200).map(() => 'e4') })], ['a player not at the table', (t) => t.hint(EVE, { items: ['m'] })],
    ['an unknown field', (t) => t.hint(BOB, { pieces: ['m'] })], ['a space no board has', (t) => t.hint(BOB, { spaces: ['z99'] })]]) {
    r = run(T, fn);
    ok(r.err instanceof TypeError && r.err.message.startsWith('t.hint') && T.state.rules.hints[BOB].items.length === 300, `${what}: a TypeError naming t.hint, the hint unchanged (${r.err?.message})`);
  }
  r = run(T, (t) => t.hint(BOB, { items: ['m', 'gone'] }));
  ok(J(T.state.rules.hints[BOB].items) === J(['m']) && r.warn.length, 'an item not on the table: dropped, with console.warn');
  run(T, (t) => t.hint(BOB, null));
  ok(!own(T.state.rules.hints, BOB), 'null clears it');

  section('(4) setRules: re-enabling the same game keeps data, public, asks and secret (hints start afresh); Reset clears them all; another game starts clean');
  const T2 = rtable(PIPE(), {});
  const fill = () => run(T2, (t) => { t.data.x = 1; t.public.y = 2; t.ask(BOB, { id: 'q', prompt: 'Q?', options: ['a'] }); t.secret[BOB] = { text: 's' }; t.hint(BOB, { items: ['m'] }); });
  fill();
  r = job(T2, HOST, { t: 'setRules', enabled: false });
  ok(!T2.state.rules.enabled && r.rules.includes('rules disabled by Alice'), `Disable: "rules disabled by Alice" (${J(r.rules)})`);
  job(T2, HOST, { t: 'setRules', enabled: true, code: fake({}) });
  let R2 = T2.state.rules;
  ok(R2.enabled && R2.data.x === 1 && R2.public.y === 2 && R2.asks[BOB]?.length === 1 && R2.secret[BOB]?.text === 's' && !own(R2.hints || {}, BOB), `re-enabled: the state kept, no hint (${J({ data: R2.data, hints: R2.hints })})`);
  fill();
  job(T2, HOST, { t: 'setRules', enabled: true, code: fake({}), reset: true });
  R2 = T2.state.rules;
  ok(R2.enabled && !('x' in R2.data) && !('y' in R2.public) && !own(R2.asks, BOB) && !own(R2.secret, BOB) && !own(R2.hints || {}, BOB), `Reset: data, public, asks, secret and hints cleared (${J({ data: R2.data, asks: R2.asks, secret: R2.secret })})`);
  fill();
  job(T2, HOST, { t: 'setRules', enabled: true, code: "({ name: 'Another game' })" });
  R2 = T2.state.rules;
  ok(R2.name === 'Another game' && !('x' in R2.data) && !own(R2.asks, BOB) && !own(R2.secret, BOB), 'another game: its own clean state');
}

function testEngineGates() {
  section('(4) loading a save runs the gates: every ask through cleanAsk (≤ 8 a player, an id once), secret keys PID_RE and own(), ≤ 8,000 chars, _timers {at: finite, tag ≤ 100}, hints dropped');
  const good = (id) => ({ id, prompt: 'P', options: [{ label: 'a', value: 'a' }] });
  const s = state3b({ m: PC('man', 1500, 300) });
  s.v = 4;
  s.rules = JSON.parse(J({
    code: "({ name: 'X' })", name: 'X', enabled: true, public: {}, hints: { [BOB]: { items: ['m'] } },
    data: { _timers: [{ at: 1.7e12, tag: 'ok' }, { at: 'x', tag: 'bad-at' }, { at: null, tag: 'null-at' }, { at: 5, tag: 7 }, { at: 5, tag: 't'.repeat(101) }, { at: 5, tag: 't'.repeat(100) }, null, 'str', { at: 5 }] },
    asks: { [BOB]: [good('a1'), { id: 'bad id', prompt: 'P', options: ['a'] }, good('a1'), good('a2')], nobody: [good('n1')], [CAROL]: 'nope', [DAVE]: range(9).map((k) => good(`d${k}`)) },
    secret: { [BOB]: { text: 'ok' }, zzzz: 1, [CAROL]: { text: 'x'.repeat(8000) }, [DAVE]: { text: 'x'.repeat(7989) } },
  }).replace('"zzzz":1', '"zzzz":1,"__proto__":{"text":"evil"}'));
  const q = quietly(() => createTable(s, { ...env(9), now: () => 1.7e12 })), T = q.value, r = T.state.rules;
  ok(J(r.asks[BOB]?.map((x) => x.id)) === J(['a1', 'a2']) && !own(r.asks, 'nobody') && !own(r.asks, CAROL) && r.asks[DAVE]?.length === 8,
    `asks: the bad one and the second a1 dropped, a non-player's and a non-list dropped, 9 → 8 (${J(Object.fromEntries(Object.entries(r.asks).map(([p, l]) => [p.slice(0, 4), l.length])))})`);
  ok(J(Object.keys(r.secret).sort()) === J([BOB, DAVE].sort()) && !Object.hasOwn(r.secret, '__proto__') && ({}).text === undefined,
    `secret: Bob's and Dave's (8,000 chars of JSON) kept; "zzzz", "__proto__" and Carol's 8,011 chars dropped, no prototype touched (${J(Object.keys(r.secret).map((k) => k.slice(0, 4)))})`);
  ok(J(r.data._timers) === J([{ at: 1.7e12, tag: 'ok' }, { at: 5, tag: 't'.repeat(100) }]), `_timers: only the well-formed entries (${J(r.data._timers).slice(0, 120)})`);
  ok(!('hints' in r), 'hints are never loaded');
  ok(q.error.some((e) => /ask/.test(e)) && q.error.some((e) => /secret/.test(e)) && q.error.some((e) => /_timers/.test(e)), `what was dropped is said with console.error (${q.error.length} errors)`);
  const s2 = state3b({});
  s2.v = 4;
  s2.rules = { code: "({ name: 'X' })", name: 'X', enabled: true, public: {}, asks: {}, secret: {}, data: { _timers: range(1001).map((k) => ({ at: k, tag: `t${k}` })) } };
  const T2 = quietly(() => createTable(s2, env(9))).value;
  ok(T2.state.rules.data._timers.length === 1000, `1,001 saved timers: 1,000 kept (${T2.state.rules.data._timers.length})`);

  section('(4) the gates at every commit: t.secret keys (attacker case 9: "__proto__", a non-player key), its size, its JSON; t.data._timers');
  for (const [what, fn] of [
    ['t.secret["__proto__"] = {} and t.secret.bob = "x"', (t) => { t.secret.__proto__ = { polluted: 1 }; t.secret.bob = 'x'; }],
    ['a secret of 8,001 chars of JSON', (t) => { t.secret[BOB] = { text: 'x'.repeat(7990) }; }],
    ['a secret that is a function', (t) => { t.secret[BOB] = () => 1; }],
    ['a secret that holds a function', (t) => { t.secret[BOB] = { text: 'x', f() {} }; }],
  ]) {
    const T3 = rtable(PIPE(), {});
    const r3 = run(T3, fn), sec = T3.state.rules.secret;
    ok(!T3.state.rules.enabled && !Object.hasOwn(sec, '__proto__') && !own(sec, 'bob') && !own(sec, BOB) && ({}).polluted === undefined && r3.rules.some((x) => x.startsWith('rules disabled — script error in')),
      `${what}: the hook fails, the rules disable, nothing of it kept, no prototype touched (${J(r3.rules)})`);
  }
  const T4 = rtable(PIPE(), {});
  let r4 = run(T4, (t) => { t.secret[BOB] = { text: 'x'.repeat(7989) }; t.secret[CAROL] = { text: 'fine' }; });
  ok(T4.state.rules.enabled && T4.state.rules.secret[BOB].text.length === 7989 && T4.state.rules.secret[CAROL].text === 'fine', 'a secret of exactly 8,000 chars, and a small one: kept');
  r4 = run(T4, (t) => { t.data._timers = [{ at: 1, tag: 'ok' }, { at: 'x', tag: 'b' }, 'junk']; });
  ok(J(T4.state.rules.data._timers) === J([{ at: 1, tag: 'ok' }]) && r4.error.length > 0, `a script's junk in t.data._timers is dropped at the commit, with console.error (${J(T4.state.rules.data._timers)})`);
}

// =============================================================================
// (A) answer
// =============================================================================
function testAnswer() {
  section('(A) answer: each form\'s offered values accepted (onAnswer gets the value, then onAction runs; the ask goes; the log says only "answered")');
  const got = [];
  const T = rtable(PIPE(), {
    onAnswer(t, p, id, v) { got.push(['onAnswer', p, id, json(v)]); },
    onAction(t, a) { if (a.t === 'answer') got.push(['onAction', a.p, a.id]); },
  }, { hands: { [BOB]: [{ d: DK, i: 0 }, { d: DK, i: 1 }, { d: DK, i: 2 }, { t: ref('gem'), f: 1 }] } });
  const askAll = () => run(T, (t) => {
    t.ask(BOB, { id: 'opt', prompt: 'Pick one', options: ['♕', { label: 'Rook', value: { piece: 'ROOK-VALUE' } }] });
    t.ask(BOB, { id: 'it', prompt: 'Which piece?', pick: 'item', among: ['m', 'n'] });
    t.ask(BOB, { id: 'sp', prompt: 'Where?', pick: 'space', among: ['e4', 'd5'] });
    t.ask(BOB, { id: 'hd', prompt: 'Two cards', pick: 'hand', count: 2 });
    t.ask(BOB, { id: 'num', prompt: 'How many?', pick: 'number', min: -3, max: 5 });
    t.ask(BOB, { id: 'one', prompt: 'One card', pick: 'hand' });
  });
  askAll();
  const refused = (p, a, what) => {
    T.clk.t += 1000; // (notices are flood-limited: 10, then 5 a second)
    const asks0 = J(T.state.rules.asks), d0 = T.digest(), n0 = got.length;
    const r = job(T, p, { t: 'answer', ...a });
    ok(noted(r, p, "🚫 That answer wasn't offered") && r.warn.length && got.length === n0 && J(T.state.rules.asks) === asks0 && T.digest() === d0 && !r.log.length,
      `${what}: refused ("🚫 That answer wasn't offered", console.warn), no hook ran, the ask stays, nothing changed`);
  };
  let sep = 0;
  const accepted = (a, want, what) => {
    run(T, (t) => t.say(`(before answer ${++sep})`)); // (the log collapses repeats: two "answered" in a row would be one line)
    const n0 = got.length, hand0 = J(T.state.players[BOB].hand), r = job(T, BOB, { t: 'answer', ...a });
    const asks = own(T.state.rules.asks || {}, BOB) || [];
    ok(J(got.slice(n0)) === J([['onAnswer', BOB, a.id, want], ['onAction', BOB, a.id]]) && !asks.some((x) => x.id === a.id) && J(r.entries.map((e) => [e.p, e.txt])) === J([[BOB, 'answered']])
      && J(T.state.players[BOB].hand) === hand0 && !J(r.log).includes('ROOK-VALUE'),
    `${what}: onAnswer(t, Bob, ${a.id}, ${J(want)}), then onAction; the ask gone; one line, "answered" (${J(got.slice(n0))}, ${J(r.log)})`);
  };
  for (const v of [-1, 2, '0', 0.5, true, null, undefined]) refused(BOB, { id: 'opt', v }, `options, v = ${J(v) ?? 'missing'}`);
  accepted({ id: 'opt', v: 1 }, { piece: 'ROOK-VALUE' }, 'options, v = 1: the option\'s value');
  for (const v of ['c', 'nope', 7]) refused(BOB, { id: 'it', v }, `pick item, v = ${J(v)} (not among)`);
  run(T, (t) => t.remove('n'));
  refused(BOB, { id: 'it', v: 'n' }, 'pick item, v = n (among, but gone)');
  accepted({ id: 'it', v: 'm' }, 'm', 'pick item, v = m');
  for (const v of ['a1', 'zz9', 5, 'B:a1']) refused(BOB, { id: 'sp', v }, `pick space, v = ${J(v)} (not among)`);
  accepted({ id: 'sp', v: 'B:d5' }, 'd5', 'pick space, the qualified B:d5: its display form');
  const C = (idx, i) => ({ idx, d: DK, i });
  for (const [v, what] of [[[], 'no card'], [[C(0, 0)], 'one card'], [[C(0, 0), C(1, 1), C(2, 2)], 'three cards'], [[C(0, 0), C(0, 0)], 'one card twice'],
    [[C(0, 0), C(1, 40)], 'a card not in the hand'], [[C(0, 0), null], 'a null entry'], ['0,1', 'a string'], [0, 'a number']]) refused(BOB, { id: 'hd', v }, `pick hand (count 2), ${what}`);
  accepted({ id: 'hd', v: [C(0, 0), { idx: 3, t: ref('gem'), f: 1 }] }, [{ d: DK, i: 0 }, { t: ref('gem'), f: 1 }], 'pick hand, a card and a piece ({idx, d, i}, {idx, t, f}): [{d, i}, {t, f}], the cards stay in the hand');
  refused(BOB, { id: 'one', v: [C(0, 0), C(1, 1)] }, 'pick hand with no count (1), two cards');
  accepted({ id: 'one', v: [C(7, 2)] }, [{ d: DK, i: 2 }], 'pick hand with no count, one card (its index stale: matched by the card)');
  for (const v of [-4, 6, 2.5, '3', null, NaN]) refused(BOB, { id: 'num', v }, `pick number [-3, 5], v = ${J(v)}`);
  accepted({ id: 'num', v: -3 }, -3, 'pick number, v = -3 (the minimum)');
  run(T, (t) => t.ask(BOB, { id: 'num', prompt: 'Again', pick: 'number', min: -3, max: 5 }));
  accepted({ id: 'num', v: 5 }, 5, 'pick number, v = 5 (the maximum)');
  run(T, (t) => t.ask(BOB, { id: 'opt', prompt: 'Again', options: ['♕', '♖'] }));
  accepted({ id: 'opt', v: 0 }, '♕', 'a plain-string option: its label is its value');

  section('(A) answer: only the asked player, only a pending id; nothing while the rules are off (D121)');
  askAll();
  refused(CAROL, { id: 'opt', v: 0 }, 'Carol answers Bob\'s ask');
  refused(HOST, { id: 'opt', v: 0 }, 'the host answers Bob\'s ask');
  refused(BOB, { id: 'nope', v: 0 }, 'Bob answers an id nobody asked');
  refused(BOB, { v: 0 }, 'an answer with no id');
  accepted({ id: 'opt', v: 0 }, '♕', 'Bob answers his own');
  refused(BOB, { id: 'opt', v: 0 }, 'Bob answers it again (no longer pending)');
  job(T, RULES, { t: '_rulesOff', reason: 'test' });
  T.clk.t += 1000;
  const n0 = got.length, r = job(T, BOB, { t: 'answer', id: 'it', v: 'm' });
  ok(noted(r, BOB, "🚫 That answer wasn't offered") && got.length === n0 && T.state.rules.asks[BOB].some((x) => x.id === 'it'), 'with the rules off, an answer is refused and the ask stays');
}

// =============================================================================
// (Sel) select
// =============================================================================
function testSelect() {
  section('(Sel) select runs onSelect(t, p, id) and nothing else: no log, no onAction, no state change but what the script does');
  const sel = [];
  const T = rtable({ ...PIPE(), hs: SUP('spy', 2600, 900, { up: false }) }, {
    onSelect(t, p, id) { sel.push([p, id]); if (F.hintOn) t.hint(p, { items: [id] }); },
    onAction(t, a) { sel.push(['onAction', a.t]); },
  });
  ok(J(T.snapContent().rules?.wants) === J(['select']) && !('strict' in T.snapContent().rules), `the rules view says wants: ['select'] (${J(T.snapContent().rules)})`);
  const look = () => [T.digest(), J(T.state.log), J(T.state.rules), J(T.state.items), J(T.state.players)].join('|');
  let s0 = look(), r = job(T, BOB, { t: 'select', id: 'm' });
  ok(J(sel) === J([[BOB, 'm']]) && look() === s0 && !r.log.length, `onSelect(t, Bob, m) ran, alone; nothing changed (${J(sel)})`);
  F.hintOn = true;
  r = job(T, BOB, { t: 'select', id: 'n' });
  ok(J(T.state.rules.hints?.[BOB]?.items) === J(['n']) && !r.log.length, 'with an onSelect that hints, the hint is the one change (the script\'s)');
  F.hintOn = false;
  sel.length = 0;
  for (const [p, id, what] of [[BOB, 'h', 'a hidden piece'], [BOB, 'hs', 'a hidden supply'], [BOB, 'zz', 'an id not on the table'], [EVE, 'm', 'someone not at the table']]) {
    s0 = look();
    r = job(T, p, { t: 'select', id });
    ok(!sel.length && look() === s0 && r.warn.length && !r.notes.length, `${what}: dropped (console.warn, no notice), onSelect not run`);
  }

  section('(Sel) at most 5 selects a second per player reach onSelect');
  const T2 = rtable(PIPE(), { onSelect(t, p, id) { sel.push([p, id]); } });
  sel.length = 0;
  for (let k = 0; k < 10; k++) job(T2, CAROL, { t: 'select', id: 'm' });
  ok(sel.length === 5, `10 at once from Carol: 5 run (${sel.length})`);
  job(T2, BOB, { t: 'select', id: 'm' });
  ok(sel.length === 6 && sel[5][0] === BOB, 'Bob has his own allowance');
  T2.clk.t += 1000;
  for (let k = 0; k < 10; k++) job(T2, CAROL, { t: 'select', id: 'n' });
  ok(sel.length === 11, `a second later, 10 more from Carol: 5 run (${sel.length - 6})`);

  section('(Sel) no selects while the rules are off, or when the script has no onSelect (no wants)');
  const T3 = rtable(PIPE(), { onAction() {} });
  r = job(T3, BOB, { t: 'select', id: 'm' });
  ok(!T3.snapContent().rules.wants && r.warn.length && !r.log.length, 'no onSelect: no wants in the view, a select is dropped');
  job(T2, RULES, { t: '_rulesOff', reason: 'test' });
  sel.length = 0;
  T2.clk.t += 5000;
  r = job(T2, BOB, { t: 'select', id: 'm' });
  ok(!sel.length && r.warn.length && !T2.snapContent().rules.wants, 'rules off: dropped, and the view has no wants');
}

// =============================================================================
// (I) Internal actions
// =============================================================================
function testInternal() {
  section('(I) internal actions are never accepted from the wire: no _* name in PUBLIC_ACTIONS (answer and select are there)');
  ok(![...PUBLIC_ACTIONS].some((t) => t.startsWith('_')) && ['_join', '_leave', '_tick', '_rulesOff', '_name'].every((t) => !PUBLIC_ACTIONS.includes(t)), 'no _join, _leave, _tick, _rulesOff, _name, nor any _* name');
  ok(['answer', 'select', 'drag'].every((t) => PUBLIC_ACTIONS.includes(t)), 'answer, select and drag are public');

  section('(I) _tick fires the due timers (by the table\'s clock) in order, each onTimer(t, tag), then buttons(); the others wait');
  const ev = [];
  const T = rtable(PIPE(), {
    setup(t) { t.schedule(0, 'a'); t.schedule(60, 'b'); t.schedule(0, 'a2'); },
    onTimer(t, tag) { ev.push(['onTimer', tag]); },
    onJoin(t, p) { ev.push(['onJoin', p]); },
    onLeave(t, p) { ev.push(['onLeave', p]); },
    onAction(t, a) { ev.push(['onAction', a.t]); },
    buttons() { ev.push(['buttons']); return []; },
  });
  ev.length = 0;
  let r = job(T, RULES, { t: '_tick' });
  ok(J(ev) === J([['onTimer', 'a'], ['onTimer', 'a2'], ['buttons']]) && J(T.state.rules.data._timers.map((x) => x.tag)) === J(['b']), `a and a2 fire, then buttons; b waits (${J(ev)})`);
  ev.length = 0;
  const seq0 = T.state.seq;
  r = job(T, RULES, { t: '_tick' });
  ok(!ev.length && !r.changed && T.state.seq === seq0, 'nothing due: no hook, no change');
  T.clk.t += 60e3;
  r = job(T, RULES, { t: '_tick' });
  ok(J(ev) === J([['onTimer', 'b'], ['buttons']]) && J(T.state.rules.data._timers) === '[]', `a minute later, b fires (${J(ev)})`);

  section('(I) _join (seated, named, "joined the table" / "is back at the table", onJoin), _leave (offline, "left the table", onLeave); no onAction');
  ev.length = 0;
  r = job(T, DAVE, { t: '_join', name: 'Dave' });
  const dv = T.state.players[DAVE];
  ok(dv?.online === true && dv.name === 'Dave' && J(r.entries.map((e) => [e.p, e.txt])) === J([[DAVE, 'joined the table']]) && J(ev) === J([['onJoin', DAVE], ['buttons']]), `a new player: ${J(r.log)}, ${J(ev)}`);
  ev.length = 0;
  r = job(T, DAVE, { t: '_join', name: 'Dave' });
  ok(!r.log.length && !ev.length, 'again while online and named: nothing');
  r = job(T, DAVE, { t: '_leave' });
  ok(T.state.players[DAVE].online === false && J(r.entries.map((e) => [e.p, e.txt])) === J([[DAVE, 'left the table']]) && J(ev) === J([['onLeave', DAVE], ['buttons']]), `_leave: ${J(r.log)}, ${J(ev)}`);
  ev.length = 0;
  r = job(T, DAVE, { t: '_join', name: 'Dave' });
  ok(T.state.players[DAVE].online && J(r.log) === J(['is back at the table']) && J(ev) === J([['onJoin', DAVE], ['buttons']]), `back: ${J(r.log)}, ${J(ev)}`);
  ev.length = 0;
  r = job(T, '__proto__', { t: '_join', name: 'X' });
  const r2 = job(T, EVE, { t: '_leave' });
  ok(!Object.hasOwn(T.state.players, '__proto__') && r.error.length && !ev.length && !r2.log.length && !own(T.state.players, EVE), '"__proto__" can\'t join (console.error); a stranger\'s _leave does nothing');

  section('(I) _name is name: renamed, logged under the old name; flood control (5 per 5 s)');
  r = job(T, BOB, { t: '_name', name: 'Robert' });
  ok(T.state.players[BOB].name === 'Robert' && r.entries.some((e) => e.p === BOB && e.txt === 'is now known as "Robert"' && e.n === 'Bob'), `"is now known as "Robert"", shown as Bob (${J(r.entries)})`);
  for (let k = 1; k <= 4; k++) job(T, BOB, { t: '_name', name: `Rob${k}` });
  r = job(T, BOB, { t: '_name', name: 'Rob5' });
  ok(T.state.players[BOB].name === 'Rob4' && r.notes.some((n) => n.p === BOB && n.msg.startsWith('🚫 Slow down')), `a 6th rename in 5 s is refused (${T.state.players[BOB].name})`);

  section('(I) _rulesOff {reason}: the rules off, "rules disabled — {reason}" as Rules; once');
  ev.length = 0;
  r = job(T, RULES, { t: '_rulesOff', reason: 'the script took longer than 4 s (stopped)' });
  ok(!T.state.rules.enabled && J(r.rules) === J(['rules disabled — the script took longer than 4 s (stopped)']) && r.patch?.rules?.enabled === false && !ev.length, `${J(r.rules)}`);
  r = job(T, RULES, { t: '_rulesOff', reason: 'again' });
  T.clk.t += 3600e3;
  const r3 = job(T, RULES, { t: '_tick' });
  ok(!r.log.length && !r3.log.length && !ev.length, 'again: nothing; a _tick with the rules off: nothing');
}

// =============================================================================
// (P) Per-recipient parts
// =============================================================================
function testParts() {
  section('(P) a player\'s own parts (ask, hint, sec) go to that player alone; options as labels only; a peer that is not registered gets none');
  const T = rtable(PIPE(), { onSelect() {} });
  run(T, (t) => {
    t.ask(BOB, { id: 'q', prompt: 'SECRET-PROMPT', options: ['a', { label: 'b', value: { v: 'OPTION-VALUE' } }] });
    t.hint(BOB, { items: ['m'], spaces: ['e4'] });
    t.secret[BOB] = { text: 'BOB-SECRET' };
    t.secret[CAROL] = { text: 'CAROL-SECRET' };
  });
  const mb = T.mine(BOB), mc = T.mine(CAROL), mh = T.mine(HOST);
  ok(mb.ask?.length === 1 && mb.ask[0].prompt === 'SECRET-PROMPT' && J(mb.ask[0].options) === J(['a', 'b']) && J(mb.hint?.items) === J(['m']) && J(mb.hint?.spaces) === J(['e4']) && mb.sec?.text === 'BOB-SECRET',
    `Bob: his ask (options ${J(mb.ask?.[0]?.options)}), his hint, his sec`);
  ok(!('ask' in mc) && !('hint' in mc) && mc.sec?.text === 'CAROL-SECRET' && !['ask', 'hint', 'sec'].some((k) => k in mh), 'Carol: her sec only; the host: none');
  ok(J(T.mine(null)) === '{}' && J(T.mine(EVE)) === '{}', 'a peer that is not registered (to null, or a stranger): nothing');
  const shared = J(T.snapContent()) + J(T.patchContent(T.takeDirty()));
  ok(!/SECRET-PROMPT|OPTION-VALUE|BOB-SECRET|CAROL-SECRET/.test(shared) && !J(mb).includes('OPTION-VALUE'), 'the shared snapshot and patch carry none of it; an option\'s value never leaves the host');

  section('(P) in a patch, a part is there when it changed for that recipient (null: cleared); nobody else\'s moves (dirty.asks, hints, secret by comparison)');
  run(T, (t) => t.ask(BOB, { id: 'q2', prompt: 'Another', pick: 'number', min: 1, max: 3 }));
  let d = T.takeDirty();
  ok(J([...d.asks]) === J([BOB]) && !d.hints.size && !d.secret.size, `a new ask for Bob: dirty.asks = {Bob} (${J([...d.asks])}, ${J([...d.hints])}, ${J([...d.secret])})`);
  const pb = T.mine(BOB, d), pc = T.mine(CAROL, d);
  ok(pb.ask?.length === 2 && !('hint' in pb) && !('sec' in pb) && !['ask', 'hint', 'sec'].some((k) => k in pc) && !J(T.patchContent(d)).includes('Another'), 'Bob\'s patch: ask only; Carol\'s: none; the shared part: none');
  run(T, (t) => t.ask(BOB, { id: 'q2', prompt: 'Another', pick: 'number', min: 1, max: 3 }));
  d = T.takeDirty();
  ok(!d.asks.size, 'the same ask again: nothing to send');
  run(T, (t) => t.cancelAsk(BOB));
  d = T.takeDirty();
  ok(T.mine(BOB, d).ask === null, 'all of Bob\'s asks withdrawn: ask: null');
  run(T, (t) => { delete t.secret[CAROL]; t.hint(BOB, null); });
  d = T.takeDirty();
  ok(J([...d.secret]) === J([CAROL]) && J([...d.hints]) === J([BOB]) && T.mine(CAROL, d).sec === null && T.mine(BOB, d).hint === null && !('sec' in T.mine(BOB, d)), 'Carol\'s secret deleted: sec: null to her; Bob\'s hint cleared: hint: null to him');

  section('(P) with the rules off, asks and hints are not sent (D121), a secret still is; hints are never saved');
  run(T, (t) => { t.ask(BOB, { id: 'q3', prompt: 'Off?', options: ['y'] }); t.hint(BOB, { items: ['n'] }); });
  T.takeDirty();
  const snap = T.snapshot();
  ok(!('hints' in snap.rules) && snap.rules.asks?.[BOB]?.length === 1 && snap.rules.secret?.[BOB]?.text === 'BOB-SECRET' && T.state.rules.hints?.[BOB], 'the save: asks and secret, no hints (the table keeps them)');
  job(T, RULES, { t: '_rulesOff', reason: 'test' });
  d = T.takeDirty();
  const off = T.mine(BOB), offP = T.mine(BOB, d);
  ok(!('ask' in off) && !('hint' in off) && off.sec?.text === 'BOB-SECRET' && offP.ask === null && offP.hint === null && !('sec' in offP), `Bob, rules off: sec only (${J(Object.keys(off))}); the patch clears ask and hint`);

  section('(P) a host reload in the middle of an ask (§3h): the save brings back the asks, the secrets and the timers — sent in the next snapshot — not the hints');
  const T3 = rtable(PIPE(), {});
  run(T3, (t) => { t.ask(BOB, { id: 'promo', prompt: 'Promote to', options: ['♕', '♘'] }); t.secret[BOB] = { text: 'role' }; t.hint(BOB, { items: ['m'] }); t.schedule(60, 'later'); });
  const saved = { ...json(T3.snapshot()), decks: json(T3.state.decks), boxes: json(T3.state.boxes), boxSrc: json(T3.state.boxSrc) };
  const page = { load: () => 'Fake', has: () => false, flag: () => undefined, call() { throw new Error('the host runs no hook'); } }; // (the host's own table: the Worker runs the script)
  const T4 = quietly(() => createTable(saved, { ...env(21), now: () => 1.7e12, hooks: page })).value;
  quietly(() => T4.resume('Alice'));
  const m4 = T4.mine(BOB);
  ok(T4.state.rules.enabled && m4.ask?.[0]?.id === 'promo' && J(m4.ask[0].options) === J(['♕', '♘']) && m4.sec?.text === 'role' && !('hint' in m4) && !own(T4.state.rules.hints || {}, BOB) && T4.state.rules.data._timers?.[0]?.tag === 'later',
    `after the reload Bob's snapshot part has his ask and his secret, no hint; the timer waits (${J(m4)})`);
}

// =============================================================================
// (G) Hooks must be synchronous
// =============================================================================
function testGuards() {
  section('(G) the live facade: a t.* call from outside a hook throws "t.{name} was called outside a hook — rules hooks must be synchronous", and the next job is fatal');
  const T = rtable(PIPE(), { onAction() {} });
  let inside = null;
  run(T, (t) => { F.saved = t; inside = T.inHook; });
  ok(inside === true && T.inHook === false, 'T.inHook: true while a hook runs, false after');
  let e = null;
  try { F.saved.say('late'); } catch (err) { e = err; }
  ok(e?.message === 't.say was called outside a hook — rules hooks must be synchronous' && !T.state.log.some((x) => x.txt === 'late'), `it throws, and says nothing (${e?.message})`);
  let r = job(T, BOB, { t: 'rot', id: 'm', rot: 90 });
  ok(/^t\.say was called outside a hook/.test(r.fatal || '') && T.state.items.m.rot === 0 && !r.patch, `the next job: {fatal: "${r.fatal}"}, nothing applied`);

  section('(G) guard(): t.data, t.public or t.secret changed outside a hook — "the script changed t.data outside a hook"');
  for (const [what, fn] of [['t.data', (t) => { t.data.x = 1; }], ['t.public', (t) => { t.public.y = 2; }], ['t.secret', (t) => { t.secret[BOB] = { text: 'late' }; }]]) {
    const T2 = rtable(PIPE(), { onAction() {} });
    run(T2, (t) => { F.saved = t; });
    ok(T2.guard() === null, 'after a clean job: guard() is null');
    fn(F.saved);
    const g = T2.guard();
    r = job(T2, BOB, { t: 'rot', id: 'm', rot: 90 });
    ok(g?.why === 'the script changed t.data outside a hook' && !g.detail && r.fatal === g.why && T2.state.items.m.rot === 0, `${what} written outside a hook: guard() says "${g?.why}", the next job is fatal`);
  }

  section('(G) on the page (T.apply), a stray call disables the rules with that reason (D125)');
  const T3 = rtable(PIPE(), { onAction() {} });
  run(T3, (t) => { F.saved = t; });
  try { F.saved.move('m', 'e4'); } catch (err) { /* (expected: checked through the table below) */ }
  const q = quietly(() => T3.apply(BOB, { t: 'rot', id: 'm', rot: 90 }));
  ok(!T3.state.rules.enabled && T3.state.log.some((x) => x.p === RULES && x.txt === 'rules disabled — t.move was called outside a hook — rules hooks must be synchronous') && q.error.length,
    'the rules are off: "rules disabled — t.move was called outside a hook — …"');
}

// =============================================================================
// (7) T.digest across applyStatePatch
// =============================================================================
const MAN = ref('man'), GEM = ref('gem');
const DIGEST_SCRIPT = `({ name: 'Digest',
  setup(t) { t.data.n = 0; t.public.score = {}; t.schedule(1, 'tick'); },
  handle(t, a) {
    if (a.t === 'rot' && a.rot === 180) { t.data.handled = (t.data.handled || 0) + 1; t.rot(a.id, 90); return true; }
    if (a.t === 'flip' && t.data.n % 7 === 3) { t.data.lost = 1; return 'not now'; }
  },
  validate(t, a) { if (a.t === 'move' && a.x < 300) return 'too far left'; },
  onAction(t, a) {
    const n = ++t.data.n;
    if (n === 25) { t.say('about to fail'); throw new Error('the 25th action since setup'); }
    t.public.score[a.p] = (t.public.score[a.p] || 0) + 1;
    if (n % 5 === 0) t.secret[a.p] = { text: 'n=' + n };
    if (n % 9 === 0) t.ask(a.p, { id: 'q' + (n % 3), prompt: 'Pick', options: ['a', { label: 'b', value: { b: n } }] });
    if (n % 11 === 0) { const ps = t.find({ kind: 'piece', type: '${MAN}' }); if (ps.length) t.move(ps[n % ps.length].id, 'c3'); }
    if (n % 13 === 0) t.say('thirteen ' + n);
    if (n % 17 === 0) t.spawn('${MAN}', { at: 'f6' });
    if (n % 19 === 0) { const ps = t.find({ kind: 'piece', type: '${MAN}' }); if (ps.length > 4) t.remove(ps[0].id); }
    if (n % 23 === 0) t.schedule(0, 'soon');
    if (n % 10 === 4) t.newDeck({ name: 'D' + n, cards: [{ name: 'x' + n }] });
    if (n % 37 === 0) t.hint(a.p, null);
    if (n % 41 === 0) t.cancelAsk(a.p);
    if (n % 6 === 0) { const g = t.find({ type: '${GEM}', kind: 'piece' })[0]; if (g) t.setFace(g.id, n % 3); }
    // facade calls given odd arguments (D152): what the engine makes of each, the host must take
    if (n % 7 === 2) for (const f of [() => t.tell(undefined, 'nobody'), () => t.tell(0, 'nobody'), () => t.tell('nobody', 'x'), () => t.tell(a.p, 7), () => t.say(5), () => t.announce({ toString: () => 'odd' })]) {
      try { f(); } catch (e) { t.data.odd = (t.data.odd || 0) + 1; }
    }
  },
  onAnswer(t, p, id, v) { t.data.answers = (t.data.answers || 0) + 1; t.public.last = id; },
  onSelect(t, p, id) { t.hint(p, { items: [id], spaces: ['e4'] }); },
  onTimer(t, tag) { t.data.timers = (t.data.timers || 0) + 1; if (tag === 'tick') t.schedule(2, 'tick'); },
  onJoin(t, p) { t.data.joins = (t.data.joins || 0) + 1; t.secret[p] = { text: 'welcome' }; },
  onLeave(t, p) { t.data.leaves = (t.data.leaves || 0) + 1; delete t.secret[p]; },
  onChat(t, msg, p) { if (msg === 'boom') throw new Error('boom'); t.data.chats = (t.data.chats || 0) + 1; },
  onButton(t, id, p) {
    const b = t.data.buttons = (t.data.buttons || 0) + 1;
    if (id === 'deal') { const ps = t.piles(); if (ps.length) t.deal(ps[0].id, { to: p }); }
    if (id === 'seats' && b % 2) t.setSeats([{ id: 'north', name: 'North' }, { id: 'south', name: 'South', edge: 'top' }, { id: 'east', name: 'East', edge: 'right' }, { id: 'west', name: 'West', edge: 'left' }]);
    else if (id === 'seats') t.setSeats(null);
  },
  buttons(t) { return [{ id: 'deal', label: 'Deal me' }, { id: 'seats', label: 'Seats' }]; } })`;
/** The host table's runner (app.js pageHooks' part a host needs): it never runs a script. */
const HOST_HOOKS = { load() { throw new Error('the host never evaluates a rules script'); }, has: () => false, flag: () => undefined, call() { throw new Error('the host never runs a hook'); } };
const DIGEST_ITEMS = () => {
  const o = { B: BRD('chess', 100, 100), s: SUP('gem', 2500, 300), bg: BAG(['gem', 'tile', 'man', 'gem'], 2700, 300), d1: PC('die', 1900, 300), d2: PC('die', 1900, 500), hp: PC('spy', 2900, 300, { up: false }),
    p: PILE(range(12).map((i) => ({ d: DK, i: 30 + i, up: false })), 2300, 300), q: PILE([{ d: DK, i: 50, up: true }], 2300, 600), c1: CARD(1, 2100, 300), c2: CARD(2, 2100, 600, { up: false }) };
  for (const [k, sq] of ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].entries()) o[`m${k}`] = PC('man', 110 + 100 * (sq.charCodeAt(0) - 97) + 10, 110 + 100 * (8 - Number(sq[1])) + 10);
  for (let k = 0; k < 3; k++) o[`g${k}`] = PC('gem', 1500 + 100 * k, 900);
  o[12] = PC('man', 1500, 1100); // (an id of digits, which an action may name as a number: D149)
  return o;
};
/** One random job for a seeded run: an actor and an action, valid or not
 *  (refusals and vetoes make patches too). */
function randomJob(M, R) {
  const I = M.state.items, ids = Object.keys(I), players = Object.keys(M.state.players), p = R.pick(players);
  const of = (f) => ids.filter((id) => f(I[id])), pick = (l) => (l.length ? R.pick(l) : 'gone');
  const pieces = of((it) => it.k === 'g' && !(it.z < 0)), cards = of((it) => it.k === 'c'), piles = of((it) => it.k === 'p');
  const xy = () => {
    if (R() < 0.5) return { x: R.int(4800), y: R.int(3400) };
    const s = M.api.spot(R.pick(['a1', 'b2', 'c3', 'e4', 'e5', 'h8', 'd4', 'g7']));
    return { x: s.x - 40, y: s.y - 40 };
  };
  const hand = M.state.players[p].hand, asks = own(M.state.rules?.asks || {}, p) || [];
  switch (R.pick(['move', 'move', 'move', 'rot', 'rot', 'flip', 'deal', 'draw', 'play', 'toHand', 'toPile', 'take', 'pull', 'toBag', 'roll', 'shuffle', 'del', 'chat', 'rulesBtn', 'rulesBtn',
    'answer', 'answer', 'select', 'select', '_tick', 'join', '_leave', 'seat', 'table', 'board', 'setRules', 'face', 'peek', 'owner', 'lock', 'name', 'byNumber'])) {
    case 'move': return [p, { t: 'move', id: pick([...pieces, ...cards, ...piles]), ...xy() }];
    case 'byNumber': return [p, R() < 0.5 ? { t: 'move', id: 12, ...xy() } : { t: R.pick(['rot', 'flip', 'roll']), id: 12, ids: [12], rot: 90 }]; // (an action naming item "12" as a number)
    case 'name': return [p, { t: 'name', name: R.pick([0, 7, 'Robert', '', ' 📜Bob', null, 'Bob']) }]; // (odd names too: the engine's cleanName, the host's the same, D152)
    case 'rot': return [p, { t: 'rot', id: pick(pieces), rot: R.pick([0, 90, 180, 270]) }];
    case 'flip': return [p, { t: 'flip', id: pick([...cards, ...piles, ...pieces]) }];
    case 'deal': return [p, { t: 'deal', id: pick(piles), ...xy(), up: R() < 0.5 }];
    case 'draw': return [p, { t: 'draw', id: pick(piles) }];
    case 'play': { const k = R.int(hand.length + 1), c = hand[k] || {}; return [p, { t: 'play', idx: k, ...('t' in c ? { type: c.t, f: c.f } : { d: c.d, i: c.i }), ...xy(), up: R() < 0.7 }]; }
    case 'toHand': return [p, { t: 'toHand', id: pick(cards) }];
    case 'toPile': return [p, { t: 'toPile', id: pick(cards), pile: pick(piles) }];
    case 'take': return [p, { t: 'take', id: 's', ...xy() }];
    case 'pull': return [p, { t: 'pull', id: 'bg', ...xy() }];
    case 'toBag': return [p, { t: 'toBag', id: pick(pieces), bag: 'bg' }];
    case 'roll': return [p, { t: 'roll', ids: of((it) => it.k === 'g' && /die$/.test(it.t)) }];
    case 'shuffle': return [p, { t: 'shuffle', id: pick(piles) }];
    case 'del': return [p, { t: 'del', id: pick([...cards, ...pieces]) }];
    case 'chat': return [p, { t: 'chat', msg: R() < 0.4 ? 'boom' : `hi ${R.int(100)}` }];
    case 'rulesBtn': return [p, { t: 'rulesBtn', id: R.pick(['deal', 'seats', 'nope']) }];
    case 'answer': return [p, { t: 'answer', id: asks.length ? R.pick(asks).id : 'q0', v: R.int(3) }];
    case 'select': return [p, { t: 'select', id: pick(ids) }];
    case '_tick': return [RULES, { t: '_tick' }];
    case 'join': { const q = R.pick([BOB, CAROL, DAVE]); return [q, { t: '_join', name: q === DAVE ? R.pick(['Dave', 0, '']) : 'X' }]; }
    case '_leave': return [R.pick([BOB, CAROL, DAVE].filter((q) => own(M.state.players, q))), { t: '_leave' }];
    case 'seat': return [p, R() < 0.5 ? { t: 'seat', watch: true } : { t: 'seat', sit: true }];
    case 'table': return [HOST, { t: 'table', shape: 'rect', w: R.pick([4800, 5000, 5200]), h: R.pick([3400, 3600]) }];
    case 'board': return [HOST, { t: 'move', id: 'B', x: 60 + R.int(200), y: 60 + R.int(200) }];
    case 'setRules': return [HOST, M.state.rules?.enabled && R() < 0.5 ? { t: 'setRules', enabled: false } : { t: 'setRules', enabled: true, code: DIGEST_SCRIPT, reset: R() < 0.3 }];
    case 'face': return [p, { t: 'face', id: pick(of((it) => it.t === GEM)), f: R.int(3) }];
    case 'peek': return [p, { t: 'peek', id: pick([...piles, ...cards]) }];
    case 'owner': return [p, { t: 'owner', id: pick(pieces), to: R() < 0.5 ? p : null }];
    default: return [HOST, { t: 'lock', id: pick(pieces), on: R() < 0.5 }];
  }
}
/** Everything but the log and seq a host and its mirror must agree on (stateOf, without the log). */
const sameTable = (T) => { const s = JSON.parse(stateOf(T)); delete s.log; return canon(s); };

function testDigest() {
  section('(7) T.digest: a Worker-like mirror (the script, T.job) and a host that only applies its patches (structured-cloned, applyStatePatch) agree after 300 seeded random jobs');
  for (const seed of seeds([11, 12, 13])) {
    const R = rng(seed), clk = { t: 1.7e12 }, base = state3b(DIGEST_ITEMS(), { [BOB]: [{ d: DK, i: 5 }, { d: DK, i: 6 }], [CAROL]: [{ t: GEM, f: 2 }] });
    let n = 0;
    const M = quietly(() => createTable(structuredClone(base), { pid: HOST, now: () => clk.t, random: rng(seed ^ 0x77), uid: () => `m${(++n).toString(16).padStart(7, '0')}`, hooks: scriptHooks() })).value;
    const H = quietly(() => createTable(structuredClone(base), { pid: HOST, now: () => clk.t, hooks: HOST_HOOKS })).value;
    const d0 = H.digest(), same0 = M.digest() === d0;
    const seen = { items: 0, players: 0, rules: 0, decks: 0, log: 0, refresh: 0, refreshHands: 0, table: 0, seats: 0, error: 0, vetoes: 0, odd: 0, byNumber: 0, oddName: 0 };
    let first = null, fatal = null, threw = null, lost = null;
    const own3 = (e) => !['deck', 'box', 'rules'].includes(e.t); // (the effects the patch itself brings: the host makes its own)
    const step = (k, p, a) => {
      const q = quietly(() => M.job(p, a)), r = q.value;
      if (r.fatal) { fatal ||= `job ${k} (${a.t}): ${r.fatal}`; return; }
      const g = M.guard();
      if (g) fatal ||= `after job ${k}: ${g}`;
      for (const key of Object.keys(seen)) if (key in r.patch) seen[key]++;
      if (r.out.error) seen.error++;
      if (r.patch.log?.some((e) => e.txt.startsWith('blocked '))) seen.vetoes++;
      if (r.out.effects.some((e) => e.t === 'note' && e.msg === '7')) seen.odd++;
      if (r.out.effects.some((e) => e.t === 'fx' && e.f.id === '12')) seen.byNumber++;
      if (r.patch.players && (a.name === 0 || a.name === 7)) seen.oddName++;
      try { quietly(() => H.applyStatePatch(structuredClone(r.patch), structuredClone(r.out), { p, a })); } catch (e) { threw ||= `job ${k} (${a.t}): ${e.message}`; } // (the job: who acted, as app.js says)
      const fx = H.drain().filter(own3);
      if (!lost && J(fx) !== J(r.out.effects.filter(own3))) lost = `job ${k} (${a.t}): the host queued ${J(fx).slice(0, 120)}, the job ${J(r.out.effects.filter(own3)).slice(0, 120)}`;
      if (!lost && r.out.error && H.rulesError !== `${r.out.error.hook}: ${r.out.error.message}`) lost = `job ${k}: the host's rulesError is "${H.rulesError}"`;
      H.takeDirty();
      if (!first && H.digest() !== M.digest()) first = `after job ${k} (${p === RULES ? 'RULES' : p.slice(0, 4)} ${J(a).slice(0, 80)}): ${stateDiff(stateOf(M), stateOf(H))}`;
    };
    step(0, HOST, { t: 'setRules', enabled: true, code: DIGEST_SCRIPT });
    for (let k = 1; k <= 300; k++) {
      clk.t += R.int(900);
      const [p, a] = randomJob(M, R);
      step(k, p, a);
    }
    ok(same0 && !fatal && !threw, `seed ${seed}: built alike, no fatal and no throw (${fatal || threw || 'none'})`);
    ok(!lost, `seed ${seed}: every job's effects (notes, fx, announcements, peeks, toasts) reach the host's queue, and a hook failure its rulesError (${lost || 'yes'})`);
    ok(!first && H.digest() === M.digest() && H.digest() !== d0, `seed ${seed}: the digests agree after every job, and at the end (${first || `${H.digest()}`}; it moved from ${d0})`);
    ok(sameTable(H) === sameTable(M) && J(H.state.log) === J(M.state.log), `seed ${seed}: the whole tables agree too — items, players, rules, table, seats, catalog, counters, log (${sameTable(H) === sameTable(M) ? 'yes' : stateDiff(stateOf(M), stateOf(H))})`);
    ok(seen.items && seen.players && seen.rules && seen.decks && seen.log && seen.refresh && seen.table && seen.seats && seen.error && seen.vetoes, `seed ${seed}: the run covered every kind of patch, hook failures and vetoes (${J(seen)})`);
    ok(seen.odd && seen.byNumber && seen.oddName, `seed ${seed}: … and odd arguments — facade calls (t.tell(undefined), t.say(5)…), renames to 0 or 7, an item named by the number 12 — each patch taken by the host (${J({ odd: seen.odd, byNumber: seen.byNumber, oddName: seen.oddName })})`);
  }

  section('(7) applyStatePatch gates what a patch brings: decks (cleanDeck), boxes (cleanBox), "__proto__" keys, a malformed item — any one refuses the whole patch, nothing applied (D145)');
  const H = quietly(() => createTable(state3b({ m: PC('man', 1500, 300) }), { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
  const goodBox = cleanBox({ name: 'Good', imgs: [], types: { x: { kind: 'token', name: 'X', faces: ['A'] } } });
  for (const [what, src] of [
    ['a deck that is no deck', '{"decks": {"dk00bad1": {"name": "X", "cards": "nope"}}}'],
    ['a box that is no box', '{"boxes": {"bx00bad1": {"box": {"name": "B", "types": 5}, "src": "script"}}}'],
    ['a deck under "__proto__"', `{"decks": {"__proto__": ${J(core.standardDeck(false))}}}`],
    ['a box under "__proto__"', `{"boxes": {"__proto__": {"box": ${J(goodBox)}, "src": "script"}}}`],
    ['an item under "__proto__"', '{"items": {"__proto__": {"k": "g", "t": "x", "x": 0, "y": 0, "rot": 0, "z": 1}}}'],
    ['a player under "__proto__"', '{"players": {"__proto__": {"name": "x", "color": "#fff", "online": true, "hand": []}}}'],
    ['an item without x, y, rot and z', `{"items": {"zz000001": {"k": "g", "t": ${J(MAN)}}}}`],
  ]) {
    const before = stateOf(H);
    let threw = null;
    try { quietly(() => H.applyStatePatch(JSON.parse(src), { effects: [] })); } catch (e) { threw = e; }
    ok(threw && stateOf(H) === before && ({}).polluted === undefined && !Object.hasOwn(H.state.items, '__proto__') && !Object.hasOwn(H.state.decks, '__proto__'), `${what}: refused (${threw?.message}), nothing applied, no prototype touched`);
  }
  quietly(() => H.applyStatePatch(JSON.parse(`{"decks": {"dk00good": ${J(core.standardDeck(false))}}, "boxes": {"bx00good": {"box": ${J(goodBox)}, "src": "script"}}}`), { effects: [] }));
  ok(own(H.state.decks, 'dk00good') && own(H.state.boxes, 'bx00good') && H.state.boxSrc.bx00good?.src === 'script', 'a good deck and box join the catalog');

  section('(7) applyStatePatch\'s steps (§3f.6): players (hands marked only when they changed), rules (asks, hints, secret per pid; a code change said), refresh touches, seq');
  const T = rtable(PIPE(), {}, { hands: HANDS });
  const pl = (o) => ({ ...json(T.state.players[BOB]), ...o });
  let seq0 = T.state.seq;
  T.applyStatePatch({}, { effects: [] });
  let d = T.takeDirty();
  ok(T.state.seq === seq0 && !d.items.size && !d.players.size, 'an empty patch: no change, no renumbering');
  T.applyStatePatch(structuredClone({ players: { [BOB]: pl({ name: 'Robert' }) } }), { effects: [] });
  d = T.takeDirty();
  ok(T.state.players[BOB].name === 'Robert' && d.players.has(BOB) && !d.hands.has(BOB) && T.state.seq === seq0 + 1, 'a renamed player: re-sent, the hand not (unchanged), renumbered');
  T.applyStatePatch(structuredClone({ players: { [BOB]: pl({ hand: [{ d: DK, i: 20 }] }) } }), { effects: [] });
  d = T.takeDirty();
  ok(d.hands.has(BOB) && T.state.players[BOB].hand.length === 1, 'a changed hand: the hand re-sent');
  T.applyStatePatch(structuredClone({ rules: { asks: { [BOB]: [{ id: 'q', prompt: 'P', options: [{ label: 'a', value: 'a' }] }] }, secret: { [CAROL]: { text: 's' } } } }), { effects: [] });
  d = T.takeDirty();
  ok(J([...d.asks]) === J([BOB]) && J([...d.secret]) === J([CAROL]) && !d.hints.size && T.mine(BOB, d).ask?.[0]?.id === 'q' && T.mine(CAROL, d).sec?.text === 's',
    `rules fields replaced: Bob's ask and Carol's secret marked for them alone (${J([...d.asks])}, ${J([...d.secret])})`);
  T.drain();
  T.applyStatePatch(structuredClone({ rules: { code: "({ name: 'Other' })", name: 'Other' } }), { effects: [] });
  ok(T.drain().some((e) => e.t === 'rules'), 'a new rules code is said (the rules channel re-sends it)');
  seq0 = T.state.seq;
  T.applyStatePatch({ refresh: ['m', 'gone'], refreshHands: [BOB, EVE] }, { effects: [] });
  d = T.takeDirty();
  ok(J([...d.items]) === J(['m']) && J([...d.hands]) === J([BOB]) && T.state.seq === seq0 + 1, `refresh touches: m and Bob's hand re-sent unchanged (ids not on the table ignored), renumbered (${J([...d.items])}, ${J([...d.hands])})`);

  section('(7) T.digest is a structural hash of items, players and rules: seq-free and log-free, and it moves with them');
  const d0 = T.digest();
  T.state.seq += 7;
  T.state.log.push({ p: RULES, txt: 'not hashed', ts: 1 });
  const d1 = T.digest();
  T.state.items.m.x += 1;
  const d2 = T.digest();
  T.state.items.m.x -= 1;
  T.state.rules.data.z = 1;
  const d3 = T.digest();
  ok(d1 === d0 && d2 !== d0 && d3 !== d0, `seq and log: the same digest; an item or t.data: another (${d0}, ${d1}, ${d2}, ${d3})`);
}

// =============================================================================
// (RF) The 3B review fix-ups (SPEC D132–D143): app.js's Worker lifecycle in
// Node — a host table that only applies patches, and a mirror built from the
// host's state on each Enable exactly as rules-worker.js init builds it
// (structured clone minus the keys, the script loaded first, mirror: true).
// =============================================================================
/** {H, M (the running mirror), clk, start(code), job(p, a, read = true), enable(code), same()}:
 *  `read` false leaves the host unread between two patches (no takeDirty, no digest). */
function lifecycle(items, o = {}) {
  const clk = { t: 1.7e12 };
  let ready = null;
  const pageHooks = { // (app.js's)
    load: () => '', has: (h) => h === 'onSelect' && !!ready?.wants.includes('select'),
    flag: (k) => (k === 'strict' ? ready?.strict : undefined), call(h) { throw new Error(`${h}() ran on the page`); },
  };
  const H = quietly(() => createTable(state3b(items, o.hands), { pid: HOST, now: () => clk.t, hooks: pageHooks })).value;
  H.takeDirty();
  const L = { H, clk, M: null };
  L.start = (code) => {
    H.syncSpots();
    const { keys, decks, boxes, boxSrc, ...state } = H.state, m = structuredClone({ state, decks, boxes, boxSrc }), hk = scriptHooks();
    const name = hk.load(code);
    L.M = quietly(() => createTable({ ...m.state, decks: m.decks, boxes: m.boxes, boxSrc: m.boxSrc }, { pid: HOST, now: () => clk.t, hooks: hk, mirror: true })).value;
    ready = { name, wants: hk.has('onSelect') ? ['select'] : [], strict: hk.flag('strict') === true };
  };
  L.job = (p, a, read = true) => {
    const r = quietly(() => L.M.job(p, a)).value;
    if (r.fatal) throw new Error(`fatal: ${r.fatal}`);
    quietly(() => H.applyStatePatch(structuredClone(r.patch), structuredClone(r.out), { p, a }));
    H.drain();
    L.M.drain();
    if (read) H.takeDirty();
    return r;
  };
  L.enable = (code) => { L.start(code); return L.job(HOST, { t: 'setRules', enabled: true, code }); };
  L.same = () => H.digest() === L.M.digest();
  return L;
}
const atOf = (T, id) => T.state.items[id]?.at ?? null;

function testReviewFixups() {
  section('(RF) D121 across a fresh mirror (D139): an Enable clears every hint on the host too (the mirror starts with the host\'s hints, so the clear is in the patch)');
  {
    const code = fake({ onSelect(t, p, id) { t.hint(p, { items: [id] }); } });
    const L = lifecycle(PIPE());
    L.enable(code);
    L.job(BOB, { t: 'select', id: 'm' });
    ok(J(L.H.state.rules.hints?.[BOB]?.items) === J(['m']) && L.H.mine(BOB).hint && L.same(), `Bob selects m: his hint, on both sides (${J(L.H.mine(BOB).hint)})`);
    const r = L.enable(code);
    ok('hints' in (r.patch.rules || {}) && !L.H.state.rules.hints?.[BOB] && !L.H.mine(BOB).hint && L.same(), `Enable again (a fresh mirror): the patch clears the hints, Bob is sent none, the digests agree (${J(Object.keys(r.patch.rules || {}))})`);
    L.job(BOB, { t: 'select', id: 'n' });
    L.M = null;
    quietly(() => L.H.apply(HOST, { t: 'setRules', enabled: false })); // (a Disable: the host's own job, no Worker)
    L.H.takeDirty();
    L.enable(code);
    ok(!L.H.state.rules.hints?.[BOB] && !L.H.mine(BOB).hint && L.same(), 'a hint, a Disable, an Enable: no hint left, the digests agree');
  }

  section('(RF) Addresses: the host takes them as the Worker read them (D128, D132) — never re-reading by containment what the Worker left alone');
  {
    const code = fake({ setup(t) { if (F.lay) F.lay(t); } });
    // the map (primary), the rack over its top rows (c9 among them), the chess board elsewhere
    const L = lifecycle({ MP: BRD('map', 100, 100), RK: BRD('rack', 100, 100), CB: BRD('chess', 2000, 100), M: PC('man', 100, 3000), N: PC('man', 300, 3000) });
    L.enable(code);
    F.fn = (t) => t.move('M', 'map:c9');
    L.job(HOST, { t: 'rulesBtn', id: 'go' });
    ok(atOf(L.H, 'M') === 'MP:c9' && L.same(), `t.move(M, 'map:c9') under the rack: MP:c9 on both sides (${atOf(L.H, 'M')})`);
    L.job(HOST, { t: 'table', shape: 'rect', w: 5000, h: 3600, felt: '#224466' });
    ok(atOf(L.H, 'M') === 'MP:c9' && atOf(L.M, 'M') === 'MP:c9' && L.same(), `a new felt alone: the host keeps MP:c9, as the Worker does (host ${atOf(L.H, 'M')}, Worker ${atOf(L.M, 'M')})`);
    for (const [what, a] of [['a table resize', { t: 'table', shape: 'rect', w: 5200, h: 3600 }], ['the rack nudged (a board under the piece)', { t: 'move', id: 'RK', x: 110, y: 100 }]]) {
      L.job(HOST, a, false);
      F.fn = (t) => t.move('N', 'map:d9'); // (under the rack too)
      L.job(HOST, { t: 'rulesBtn', id: 'go' }, false); // (no read on the host between the two patches)
      ok(atOf(L.H, 'N') === atOf(L.M, 'N') && atOf(L.H, 'N') === 'MP:d9' && L.same(), `${what}, then t.move(N, 'map:d9'), no host read between: the same address and digest (host ${atOf(L.H, 'N')}, Worker ${atOf(L.M, 'N')})`);
      F.fn = (t) => t.move('N', { x: 300, y: 3000, free: true });
      L.job(HOST, { t: 'rulesBtn', id: 'go' });
    }
    const L2 = lifecycle({});
    F.lay = (t) => { t.spawn(ref('chess'), { at: { x: 1000, y: 1000 } }); const s = t.spot('chess:e4'); t.spawn(ref('man'), { at: { x: s.x - 40, y: s.y - 40, free: true } }); };
    L2.enable(code);
    const man = (T) => Object.keys(T.state.items).find((id) => T.state.items[id].t === ref('man'));
    ok(man(L2.H) && atOf(L2.H, man(L2.H)) === null && atOf(L2.M, man(L2.M)) === null && L2.same(), `a setup that spawns a board, then a free man on its e4: no address on either side (host ${atOf(L2.H, man(L2.H))})`);
  }

  section('(RF) A pull a script\'s handle() made itself, then vetoed or failed: the bag\'s next pull is the same member (D114, D135)');
  for (const [what, handle] of [
    ['a veto on a.pick', (t, a) => (a.t === 'pull' ? `no: ${a.pick}` : undefined)],
    ['handle t.pull()s it, then vetoes', (t, a) => { if (a.t !== 'pull') return undefined; const it = t.item(t.pull(a.id, { at: { x: a.x, y: a.y } })); return `no: ${it.t}/${it.f}`; }],
  ]) {
    const T = rtable({ bg: BAG([{ t: 'gem', f: 0 }, { t: 'gem', f: 1 }, { t: 'gem', f: 2 }, { t: 'tile', f: 0 }, { t: 'tile', f: 1 }, 'man', 'stone', 'big'], 2700, 300) }, { handle });
    const said = [];
    for (let k = 0; k < 10; k++) said.push(job(T, BOB, { t: 'pull', id: 'bg', x: 1000, y: 1000 }).notes.find((n) => n.p === BOB)?.msg);
    ok(T.state.items.bg.of.length === 8 && said.every((m) => m && m === said[0]), `${what}: 10 refusals, the bag still holds 8, every one names the same member (${said[0]})`);
  }

  section('(RF) The engine\'s gates refuse what JSON would change on its way: a typed array, a Map, a Date, NaN in t.data or t.public — loudly, naming it (D133)');
  for (const [what, fn, re] of [
    ['a Uint8Array in t.data', (t) => { t.data.board = new Uint8Array(4); }, /t\.data\.board is a Uint8Array/],
    ['a Map in t.public', (t) => { t.public.seen = new Map(); }, /t\.public\.seen is a Map/],
    ['a Date deep in t.data', (t) => { t.data.log = [{ at: new Date(0) }]; }, /t\.data\.log\[0\]\.at is a Date/],
    ['NaN in t.data', (t) => { t.data.score = 0 / 0; }, /t\.data\.score is NaN/],
    ['an object of a class in t.data', (t) => { t.data.p = new (class Point {})(); }, /t\.data\.p is a Point/],
  ]) {
    const T = rtable(PIPE(), {});
    const r = run(T, fn);
    ok(!T.state.rules.enabled && re.test(T.rulesError) && !Object.keys(T.state.rules.data).length && !Object.keys(T.state.rules.public).filter((k) => k !== 'buttons').length,
      `${what}: the hook fails, nothing of it kept, the rules off ("${T.rulesError}")`);
  }
  {
    const T = rtable(PIPE(), {});
    run(T, (t) => { t.data.n = 1; t.data.fmt = (x) => String(x); });
    ok(T.state.rules.enabled, 'a function in t.data passes the gate: it is D129\'s — the Worker can\'t post it, which disables the rules there, keeping the JSON part');
  }

  section('(RF) applyStatePatch checks the rules\' state a patch brings, in the host\'s realm (D142): a bad secret key, ask, hint or timer throws, and nothing is applied');
  const H = quietly(() => createTable(state3b(PIPE()), { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
  quietly(() => H.applyStatePatch(structuredClone({ rules: { code: '({})', name: 'X', enabled: true, data: {}, public: {}, asks: {}, secret: {} } }), { effects: [] }));
  H.takeDirty();
  for (const [what, rules] of [
    ['a secret keyed "constructor"', { secret: { constructor: { text: 'x' } } }],
    ['a secret keyed with markup', { secret: { '<img src=x onerror=alert(1)>': 1 } }],
    ['a secret too large', { secret: { [BOB]: 'x'.repeat(9000) } }],
    ['an ask of 30 options', { asks: { [BOB]: [{ id: 'q', prompt: 'P', options: range(30).map(String) }] } }],
    ['asks that are not a list', { asks: { [BOB]: 'q' } }],
    ['nine asks for one player', { asks: { [BOB]: range(9).map((k) => ({ id: `q${k}`, prompt: 'P', options: ['a'] })) } }],
    ['a timer that is not one', { data: { _timers: [{ at: 'soon', tag: 'x' }] } }],
    ['a hint of 600 items', { hints: { [BOB]: { items: range(600).map(() => 'm'), spaces: [] } } }],
    ['a hint with a megabyte of its own beside its lists (sent whole to Bob)', { hints: { [BOB]: { items: [], spaces: [], note: 'x'.repeat(1e6) } } }],
  ]) {
    const before = stateOf(H);
    let threw = null;
    try { quietly(() => H.applyStatePatch(structuredClone({ rules, items: { m: { ...H.state.items.m, x: 999 } } }), { effects: [] })); } catch (e) { threw = e; }
    ok(threw && stateOf(H) === before, `${what}: throws (${threw?.message}), and the table is as it was`);
  }
  quietly(() => H.applyStatePatch(structuredClone({ rules: { secret: { [BOB]: { text: 'ok' } }, asks: { [BOB]: [{ id: 'q', prompt: 'P', options: [{ label: 'a', value: 1 }] }] } } }), { effects: [] }));
  ok(H.state.rules.secret[BOB]?.text === 'ok' && Object.getPrototypeOf(H.state.rules.secret) === null && H.state.rules.asks[BOB]?.length === 1, 'a good secret and ask go in (the secret map with no prototype, as §3a has it)');
}

// =============================================================================
// (RF2) The second review of 3B (SPEC D144)
// =============================================================================
function testSecondReview() {
  section('(RF2) A non-JSON value whose JSON equals what was there fails the hook too (every job: D144) — the mirror never keeps what the host can\'t');
  for (const [what, json, value, re] of [
    ['-Infinity over null', null, () => Math.max(), /t\.data\.v is -Infinity, not JSON/],
    ['a Date over its own ISO string', '2026-01-01T00:00:00.000Z', () => new Date('2026-01-01T00:00:00.000Z'), /t\.data\.v is a Date, not JSON/],
    ['a Map over {}', {}, () => new Map([[1, 'x']]), /t\.data\.v is a Map, not JSON/],
    ['a Uint8Array over {"0":0,"1":0}', { 0: 0, 1: 0 }, () => new Uint8Array(2), /t\.data\.v is a Uint8Array, not JSON/],
  ]) {
    const L = lifecycle(PIPE());
    L.enable(fake({}));
    F.fn = (t) => { t.data.v = json; };
    L.job(HOST, { t: 'rulesBtn', id: 'go' });
    F.fn = (t) => { t.data.v = value(); };
    const r = L.job(HOST, { t: 'rulesBtn', id: 'go' });
    const m = L.M.state.rules, hr = L.H.state.rules;
    ok(re.test(r.out.error?.message || '') && !m.enabled && !hr.enabled, `${what}: the hook fails, naming it ("${r.out.error?.message}"), the rules off on both sides`);
    ok(J(m.data.v) === J(json) && Object.getPrototypeOf(m.data.v ?? {}) === Object.getPrototypeOf(hr.data.v ?? {}) && L.same(), `${what}: the mirror holds what the host holds (${J(m.data.v)}), the digests agree`);
  }

  section('(RF2) guard(): a write outside a hook that JSON can\'t see — a function, a Date over its ISO string — is named at once, not blamed on the next job (D144); its words are the engine\'s, the script\'s keys only in the host\'s detail (D145)');
  for (const [what, fn, why, re] of [
    ['a function into t.secret[Bob]', (t) => { t.secret[BOB] = () => 1; }, 't.secret', /^t\.secret\[b{16}\] is a function, not JSON$/],
    ['a Date over t.data.when\'s ISO string', (t) => { t.data.when = new Date('2026-01-01T00:00:00.000Z'); }, 't.data', /^t\.data\.when is a Date, not JSON/],
    ['NaN over null in t.public', (t) => { t.public.best = 0 / 0; }, 't.public', /^t\.public\.best is NaN, not JSON$/],
    ['a function under a new key of t.data (its JSON unchanged)', (t) => { t.data.f = () => 1; }, 't.data', /^t\.data\.f is a function, not JSON$/],
    ['a Map over {} under a marker key', (t) => { t.data.dealt['Alice: Q of hearts'] = new Map(); }, 't.data', /^t\.data\.dealt\["Alice: Q of hearts"\] is a Map, not JSON/],
  ]) {
    const T = rtable(PIPE(), {});
    run(T, (t) => { t.data.when = '2026-01-01T00:00:00.000Z'; t.data.dealt = { 'Alice: Q of hearts': {} }; t.public.best = null; F.saved = t; F.data = t.data; F.pub = t.public; F.sec = t.secret; });
    run(T, () => {}); // (a job whose patch carries none of the fields: a function written into one it carries is its failed post's, D129)
    ok(T.guard() === null, `${what}: after a clean job, guard() is null`);
    fn({ data: F.data, public: F.pub, secret: F.sec }); // (kept references, written from a stray continuation: no facade call)
    const g = T.guard(), r = job(T, BOB, { t: 'rot', id: 'm', rot: 90 });
    ok(g?.why === `the script changed ${why} outside a hook` && re.test(g.detail) && r.fatal === g.why && r.detail === g.detail && T.state.items.m.rot === 0 && !r.patch,
      `${what}: guard() says "${g?.why}" (the host alone: "${g?.detail}"); Bob's next move is that fatal, not his fault, and nothing of it applied`);
  }

  section('(RF2) applyStatePatch(patch, out, job): every log line and name bulb is the job\'s player\'s or the rules\'; a chat line is theirs, as sent; a frozen name only on their rename (D144)');
  {
    const L = lifecycle(PIPE());
    L.enable(fake({ onAction(t, a) { if (a.t === 'rot') t.say('turned'); } }));
    /** Job (p, a) on the mirror, then its patch, forged by `forge`, to a host that must refuse it whole. */
    const refused = (what, p, a, forge, re) => {
      const r = quietly(() => L.M.job(p, a)).value, P = structuredClone(r.patch), O = structuredClone(r.out);
      forge(P, O);
      const before = stateOf(L.H);
      let threw = null;
      try { quietly(() => L.H.applyStatePatch(P, O, { p, a })); } catch (e) { threw = e; }
      ok(threw && re.test(threw.message) && stateOf(L.H) === before, `${what}: refused (${threw?.message}), the table as it was`);
      L.start(L.H.state.rules.code); // (a fresh mirror from the host's table: the refused job never happened there)
    };
    const line = (P, f) => P.log.find(f);
    refused('Alice\'s rot, its line re-signed by Bob', HOST, { t: 'rot', id: 'm', rot: 90 }, (P) => { line(P, (e) => e.p === HOST).p = BOB; },
      /^the script put a line in Bob's name into Alice's rot$/);
    refused('Alice\'s chat, put in Bob\'s mouth', HOST, { t: 'chat', msg: 'hello' }, (P) => { line(P, (e) => e.c).p = BOB; }, /^the script put a line in Bob's name into Alice's chat$/);
    refused('Alice\'s chat, its words changed', HOST, { t: 'chat', msg: 'hello' }, (P) => { line(P, (e) => e.c).txt = 'I resign'; }, /^the script put words in Alice's chat$/);
    refused('a chat line of Alice\'s in her rot', HOST, { t: 'rot', id: 'm', rot: 90 }, (P) => { P.log.push({ p: HOST, txt: 'I resign', ts: 1, c: 1 }); }, /^the script put words in Alice's chat$/);
    refused('a chat line of the rules\'', HOST, { t: 'chat', msg: 'hello' }, (P) => { P.log.push({ p: RULES, txt: 'psst', ts: 1, c: 1 }); }, /^the script put words in the rules' chat$/);
    refused('a frozen name on Alice\'s rot line', HOST, { t: 'rot', id: 'm', rot: 90 }, (P) => { line(P, (e) => e.p === HOST).n = 'Bob'; }, /^the script renamed a line of Alice's to "Bob"$/);
    refused('Bob\'s rename, under another old name', BOB, { t: 'name', name: 'Robert' }, (P) => { line(P, (e) => e.n).n = 'Carol'; }, /^the script renamed a line of Bob's to "Carol"$/);
    refused('a name bulb of Bob\'s in Alice\'s rot', HOST, { t: 'rot', id: 'm', rot: 90 }, (P, O) => { O.effects.find((e) => e.t === 'fx').f.p = BOB; }, /^the script put Bob's name bulb into Alice's rot$/);
    refused('a log line that isn\'t one', HOST, { t: 'rot', id: 'm', rot: 90 }, (P) => { P.log.push('rotated'); }, /^the script's log lines are malformed$/);
    // the real ones go in: a rot (with the rules' own line), a chat, a rename, a departure
    for (const [p, a] of [[HOST, { t: 'rot', id: 'm', rot: 90 }], [BOB, { t: 'chat', msg: '  hi\u0007 there ' }], [BOB, { t: 'name', name: 'Robert' }], [CAROL, { t: '_leave' }]]) {
      const r = L.job(p, a);
      ok(r.patch.log?.length && L.same(), `${a.t} of ${p.slice(0, 4)}: applied (${J(r.patch.log.map((e) => [e.p.slice(0, 4), e.txt, e.n ?? null]))}), the digests agree`);
    }
  }

  section('(RF2) applyStatePatch: t.data and t.public in a patch are plain JSON (a structured clone keeps a Map, a Date, a cycle) — checked in the host\'s realm (D144)');
  {
    const H = quietly(() => createTable(state3b(PIPE()), { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
    quietly(() => H.applyStatePatch(structuredClone({ rules: { code: '({})', name: 'X', enabled: true, data: {}, public: {}, asks: {}, secret: {} } }), { effects: [] }));
    const cyc = { a: 1 };
    cyc.self = cyc;
    for (const [what, rules, re] of [
      ['a Map in t.data', { data: { seen: new Map([[1, 2]]) } }, /t\.data\.seen is a Map, not JSON/],
      ['a Date in t.public', { public: { when: new Date(0) } }, /t\.public\.when is a Date, not JSON/],
      ['NaN in t.public', { public: { n: NaN } }, /t\.public\.n is NaN, not JSON/],
      ['a cycle in t.data', { data: cyc }, /^the script's state fails the engine's gates: t\.data is not JSON \(Converting circular structure to JSON\)$/],
    ]) {
      const before = stateOf(H);
      let threw = null;
      try { quietly(() => H.applyStatePatch(structuredClone({ rules }), { effects: [] })); } catch (e) { threw = e; }
      ok(threw && re.test(threw.message) && stateOf(H) === before, `${what}: throws (${threw?.message}), the table as it was`);
    }
  }
}

// =============================================================================
// (RF3) The third review of 3B (SPEC D145–D147)
// =============================================================================
function testThirdReview() {
  const { notJSON, LOG_CAPS, LOG_TXT_MAX } = core;
  section('(RF3) notJSON sees what JSON would change that a walk by keys missed: holes, undefined in an array, a non-enumerable or symbol-keyed property (D146); a property hung on an array passes, as JSON leaves it out (D153)');
  {
    const named = [1, 2];
    named.turn = 'white';
    const when = [1, 2];
    when.when = new Date(0);
    for (const [what, v, want] of [
      ['an array with a hole (new Array(3))', { board: new Array(3) }, 'v.board[0] is a hole, not JSON (JSON writes null) — fill the array'],
      ['undefined in an array', { list: [1, undefined] }, 'v.list[1] is undefined, not JSON (JSON writes null)'],
      ["an array's named property (JSON leaves it out, as an object's undefined: D153)", { moves: named }, ''],
      ['a Date hung on an array (the same)', { list: when }, ''],
      ['a non-enumerable property', { o: Object.defineProperty({}, 'hidden', { value: 7 }) }, "v.o has a property JSON doesn't see (non-enumerable, or keyed by a symbol)"],
      ['a symbol-keyed property', { o: { [Symbol('s')]: 1 } }, "v.o has a property JSON doesn't see (non-enumerable, or keyed by a symbol)"],
      ['plain JSON (undefined as an object\'s value passes)', { a: [1, { b: null, c: 'x' }], d: undefined, e: Object.create(null) }, ''],
    ]) ok(notJSON(v, 'v') === want, `${what}: "${notJSON(v, 'v')}"`);
    for (const [what, value, re] of [
      ['a board made with new Array(64)', () => new Array(64), /t\.data\.v\[0\] is a hole/],
      ['a hidden property', () => Object.defineProperty({}, 'h', { value: 7 }), /t\.data\.v has a property JSON doesn't see/],
    ]) {
      const L = lifecycle(PIPE());
      L.enable(fake({}));
      F.fn = (t) => { t.data.v = value(); };
      const r = L.job(HOST, { t: 'rulesBtn', id: 'go' });
      ok(re.test(r.out.error?.message || '') && !L.M.state.rules.enabled && !L.H.state.rules.enabled && L.same(), `${what} in t.data: the hook fails, naming it ("${r.out.error?.message}"), the rules off on both sides, the digests agree`);
    }
  }

  section('(RF3) A function in t.data or t.public whose field\'s JSON didn\'t change fails the hook that wrote it (the patch won\'t carry it, so the Worker\'s failed post can\'t say it: D129, D146)');
  {
    const L = lifecycle(PIPE());
    L.enable(fake({}));
    F.fn = (t) => { t.data.n = 7; t.data.fmt = (x) => String(x); };
    const r = quietly(() => L.M.job(HOST, { t: 'rulesBtn', id: 'go' })).value;
    ok('data' in (r.patch.rules || {}) && L.M.guard() === null, "a function written with other changes: the job's patch carries t.data, so the guard after the job's microtasks leaves it to the post that will fail (D129)");
    F.fn = null;
    const T = rtable(PIPE(), {});
    run(T, (t) => { t.data.fmt = (x) => String(x); });
    ok(!T.state.rules.enabled && /t\.data\.fmt is a function, not JSON/.test(T.rulesError) && !('fmt' in T.state.rules.data), `a function alone (the JSON as it was): the hook fails ("${T.rulesError}")`);
    const T2 = rtable(PIPE(), {});
    run(T2, (t) => { t.public.n = 1; t.public.fmt = (x) => String(x); });
    ok(T2.state.rules.enabled, 'with the JSON changed too, it is D129\'s: the gate lets it by, and a Worker\'s post of the patch fails');
  }

  section('(RF3) applyStatePatch checks a patch against who acted, in the host\'s realm: players, the rules\' code, counters, the catalog, log lines and effects as the engine writes them — and refuses the whole patch (D145)');
  {
    const L = lifecycle(PIPE(), { hands: HANDS });
    L.enable(fake({ onAction(t, a) { if (a.t === 'rot') t.say('turned'); } }));
    const rec = (p, o = {}) => ({ ...json(L.H.state.players[p]), ...o });
    /** Job (p, a) on the mirror, then its patch and effects forged by `forge`, to a host that must refuse it whole. */
    const refused = (what, p, a, forge, re) => {
      const r = quietly(() => L.M.job(p, a)).value, P = structuredClone(r.patch), O = structuredClone(r.out);
      forge(P, O);
      const before = stateOf(L.H);
      let threw = null;
      try { quietly(() => L.H.applyStatePatch(P, O, { p, a })); } catch (e) { threw = e; }
      ok(threw && re.test(threw.message) && stateOf(L.H) === before, `${what}: refused (${threw?.message}), the table as it was`);
      L.start(L.H.state.rules.code); // (a fresh mirror from the host's table: the refused job never happened there)
    };
    const ROT = { t: 'rot', id: 'm', rot: 90 }, BIG = 'x'.repeat(LOG_TXT_MAX + 1);
    for (const [what, p, a, forge, re] of [
      ['Alice and Bob swap names on her rot', HOST, ROT, (P) => { P.players = { [HOST]: rec(HOST, { name: 'Bob' }), [BOB]: rec(BOB, { name: 'Alice' }) }; }, /^the script renamed Alice$/],
      ['a player who never joined', HOST, ROT, (P) => { P.players = { [EVE]: rec(BOB) }; }, /^the script added a player$/],
      ["Bob's colour changed", HOST, ROT, (P) => { P.players = { [BOB]: rec(BOB, { color: '#000000' }) }; }, /^the script changed Bob's colour$/],
      ['Carol taken offline on a rot of Alice\'s', HOST, ROT, (P) => { P.players = { [CAROL]: rec(CAROL, { online: false }) }; }, /^the script took Carol offline$/],
      ['Bob renamed in his own rot', BOB, ROT, (P) => { P.players = { [BOB]: rec(BOB, { name: 'Robert' }) }; }, /^the script renamed Bob$/],
      ['Bob renamed to another name than he asked', BOB, { t: 'name', name: 'Robert' }, (P) => { P.players[BOB].name = 'Bobby'; }, /^the script renamed Bob$/],
      ['a player without a hand', HOST, ROT, (P) => { P.players = { [BOB]: { ...rec(BOB), hand: undefined } }; }, /^a patched player \(Bob\) is malformed: a player without a hand$/],
      ['a pile without its cards', HOST, ROT, (P) => { P.items.zz000001 = { k: 'p', x: 300, y: 300, rot: 0, z: 50 }; }, /^a patched item \(zz000001\) is malformed: a pile without its cards$/],
      ['an item that is a number', HOST, ROT, (P) => { P.items.zz000001 = 5; }, /is malformed: not an item$/],
      ['the turned man, then a table that is none (nothing half-applied)', HOST, ROT, (P) => { P.table = { shape: 'hex' }; }, /^the patched table: /],
      ["the rules' code rewritten", HOST, ROT, (P) => { P.rules = { ...P.rules, code: "({ name: 'Fair' })" }; }, /^the script rewrote the rules' code or name$/],
      ["the rules' name of 10,000 characters", HOST, ROT, (P) => { P.rules = { ...P.rules, name: 'x'.repeat(10000) }; }, /^the patched rules are malformed$/],
      ["the rules' name, in a rot", HOST, ROT, (P) => { P.rules = { ...P.rules, name: 'Fair' }; }, /^the script rewrote the rules' code or name$/],
      ['the rules off, without a word', HOST, ROT, (P) => { P.rules = { ...P.rules, enabled: false }; }, /^the script turned the rules off without a word$/],
      ['a field of the rules of its own', HOST, ROT, (P) => { P.rules = { ...P.rules, owner: 'me' }; }, /^the patched rules have an unknown field 'owner'$/],
      ['a field of the patch of its own', HOST, ROT, (P) => { P.keys = { [BOB]: 'k' }; }, /^the patch has an unknown field 'keys'$/],
      ["the guests' deck budget spent", HOST, ROT, (P) => { P.guestDeckChars = -1e300; }, /^the patch's guestDeckChars is out of bounds$/],
      ["the guests' deck budget grown in a rot", HOST, ROT, (P) => { P.guestDeckChars = 1000; }, /^the script spent the guests' deck budget$/],
      ['zMax going back', HOST, ROT, (P) => { P.zMax = -5; }, /^the patch's zMax is out of bounds$/],
      ['a deck over a catalog entry', HOST, ROT, (P) => { P.decks = { [DK]: core.standardDeck(true) }; }, new RegExp(`^the patch rewrites the catalog's ${DK}$`)],
      ['a box that says it came from nowhere', HOST, ROT, (P) => { P.boxes = { bx000009: { box: cleanBox(SPACE_BOX), src: 'mars', by: '<b>' } }; }, /^a patched box doesn't say where it came from$/],
      ['a last setup that is no box', HOST, ROT, (P) => { P.lastSetup = 'nope'; }, /^the patch's last setup is no box$/],
      ['a log line of 1,001 characters', HOST, ROT, (P) => { P.log.push({ p: RULES, txt: BIG, ts: 1 }); }, /^the script's log lines are malformed$/],
      ['a log line with a field of its own', HOST, ROT, (P) => { P.log.push({ p: RULES, txt: 'x', ts: 1, style: 'red' }); }, /^the script's log lines are malformed$/],
      ['a frozen name that is undefined (it counts as talk)', HOST, ROT, (P) => { P.log.push({ p: RULES, txt: 'x', ts: 1, n: undefined }); }, /^the script's log lines are malformed$/],
      ['400 lines of the rules\' (more than the log keeps)', HOST, ROT, (P) => { P.log.push(...range(400).map((k) => ({ p: RULES, txt: `l${k}`, ts: 1 }))); }, /^the patch brings more log lines than the log keeps$/],
      ['50 peeks on the record in a rot', HOST, ROT, (P) => { P.log.push(...range(50).map(() => ({ p: HOST, txt: 'peeked at a face-down card', ts: 1, k: 1 }))); }, /^the script put a peek on the record in Alice's name$/],
      ["fifty renames in Bob's one", BOB, { t: 'name', name: 'Robert' }, (P) => { P.log.push(...range(50).map(() => ({ ...P.log[0] }))); }, /^the script renamed a line of Bob's to "Bob"$/],
      ['a notice that is no text', HOST, ROT, (P, O) => { O.effects.push({ t: 'note', p: BOB, msg: 5 }); }, /^the script's effects are malformed$/],
      ['an effect the engine never makes', HOST, ROT, (P, O) => { O.effects.push({ t: 'eval', code: '1' }); }, /^the script's effects are malformed$/],
      ['a peek shown to Bob in a rot of Alice\'s', HOST, ROT, (P, O) => { O.effects.push({ t: 'peek', p: BOB, c: { d: DK, i: 0 } }); }, /^the script showed Bob's eyes a card in Alice's rot$/],
      ['an error that is no error', HOST, ROT, (P, O) => { O.error = 'boom'; }, /^the script's error is malformed$/],
    ]) refused(what, p, a, forge, re);
    // what the engine does write goes in: a rename, a new player's join, a guest's deck, a peek, a Disable
    for (const [p, a] of [[BOB, { t: 'name', name: 'Robert' }], [DAVE, { t: '_join', name: 'Dave' }], [BOB, { t: 'peek', id: 'p' }], [CAROL, { t: '_leave' }],
      [BOB, { t: 'addDeck', deck: { name: 'Mini', cards: [{ n: 'A' }, { n: 'B' }] }, cost: 50 }], [HOST, { t: 'setRules', enabled: false }]]) {
      const r = L.job(p, a);
      ok(Object.keys(r.patch).length && L.same(), `${a.t} of ${p.slice(0, 4)}: applied (${J(Object.keys(r.patch))}), the digests agree`);
    }
    ok(L.H.state.players[DAVE]?.name === 'Dave' && L.H.state.players[BOB].name === 'Robert' && !L.H.state.players[CAROL].online && L.H.state.guestDeckChars >= 50, 'Dave joined, Bob is Robert, Carol is offline, the guests\' budget grew by Bob\'s deck');
  }

  section('(RF3) applyStatePatch keeps the asks as cleanAsk leaves them: a label is {label, value}, a prompt without control characters (D145)');
  {
    const H = quietly(() => createTable(state3b(PIPE()), { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
    quietly(() => H.applyStatePatch(structuredClone({ rules: { code: '({})', name: 'X', enabled: true, data: {}, public: {}, asks: {}, secret: {} } }), { effects: [] }));
    H.applyStatePatch(structuredClone({ rules: { asks: { [BOB]: [{ id: 'q', prompt: 'Pick\u001b[31m', options: ['yes', 'no'] }] } } }), { effects: [] });
    H.takeDirty();
    const ask = H.mine(BOB).ask;
    ok(J(H.state.rules.asks[BOB]) === J([{ id: 'q', prompt: 'Pick[31m', options: [{ label: 'yes', value: 'yes' }, { label: 'no', value: 'no' }] }]) && J(ask?.[0]?.options) === J(['yes', 'no']),
      `the host keeps the cleaned ask, and Bob is sent its labels (${J(ask)})`);
  }

  section('(RF3) A job\'s patch brings at most what the log keeps, and a line at most LOG_TXT_MAX (D147)');
  {
    const L = lifecycle(PIPE());
    L.enable(fake({}));
    F.fn = (t) => { for (let k = 0; k < 2000; k++) t.say(`line ${k}`); };
    const r = L.job(HOST, { t: 'rulesBtn', id: 'go' });
    const n = r.patch.log.length;
    ok(n === LOG_CAPS.act && r.patch.log.at(-1).txt === 'line 1999' && L.same() && J(L.H.state.log) === J(L.M.state.log), `2,000 t.say lines: the patch brings the newest ${n} (LOG_CAPS.act), as the log keeps them; the host's log is the mirror's`);
    const T = rtable(PIPE(), { validate: () => 'no: ' + 'z'.repeat(5000) });
    const v = job(T, BOB, { t: 'rot', id: 'm', rot: 90 });
    ok(v.rules.at(-1).length <= 320 && v.rules.at(-1).length < LOG_TXT_MAX && noted(v, BOB, `🚫 no: ${'z'.repeat(296)}`), `a veto's reason is a script's words: cut as t.say's are (${v.rules.at(-1).length} characters)`);
  }

  section('(RF3) A save with an item or a player the table can\'t show is loaded without it, loudly — one bad record never keeps a table from starting (D145)');
  {
    const s = state3b({ m: PC('man', 1500, 300), bad: { k: 'p', x: 1, y: 1, rot: 0, z: 1 }, odd: 5, worse: PILE([{ d: DK, i: 1 }, 'x'], 300, 300) });
    s.players[DAVE] = { name: 'Dave', color: '#30bced', online: true };
    s.players.junk = null;
    const q = quietly(() => createTable(s, { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })), T = q.value;
    const t = quietly(() => { T.takeDirty(); return [T.patchContent(T.takeDirty()), T.snapContent()]; });
    ok(Object.keys(T.state.items).join() === 'm' && !(DAVE in T.state.players) && !('junk' in T.state.players) && q.error.filter((e) => /^the saved (item|player) .* is unreadable \(.*\): dropped$/.test(e)).length === 5 && !t.error.length,
      `the pile without cards, the number, the pile with a stray card, Dave without a hand and a null player are dropped, each said (${q.error.length} errors); the table broadcasts`);
  }
}

// =============================================================================
// (RF4) The fourth review of 3B (SPEC D148–D153)
// =============================================================================
function testFourthReview() {
  const { Z_MAX } = core;
  section("(RF4) Every export of the modules a rules Worker loads (core.js, grid.js, templates.js) is a primitive, a function, a regex or plain data — nothing whose contents a freeze leaves open (a Set, a Map, a Date, a typed array), so the Worker's lockdown holds them all (D148)");
  {
    const open = [], seen = new Set();
    const walk = (v, at) => {
      if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) return;
      seen.add(v);
      if ([Map, Set, WeakMap, WeakSet, Date, ArrayBuffer].some((C) => v instanceof C) || ArrayBuffer.isView(v)) open.push(at);
      if (typeof v === 'object') for (const k of Reflect.ownKeys(v)) walk(Object.getOwnPropertyDescriptor(v, k).value, `${at}.${String(k)}`);
    };
    for (const [name, m] of [['core', core], ['grid', grid], ['templates', templates]]) for (const [k, v] of Object.entries(m)) walk(v, `${name}.${k}`);
    ok(!open.length, `none (${open.join(', ') || 'none'})`);
    ok([core.RULED_ACTIONS, core.STRICT_ACTIONS, core.PUBLIC_ACTIONS, core.HOST_ACTIONS, core.RANKS, core.SUITS, core.IMG_MIMES].every((l) => Array.isArray(l) && Object.isFrozen(l)),
      'the lists the engine reads are frozen arrays (as Sets, a frozen one still took Set.prototype.add.call)');
  }

  section("(RF4) A guest's deck reaches the catalog as the host's realm cleans what they sent: a patch whose deck, or whose line in the guest's name, says otherwise is refused (D148)");
  {
    const L = lifecycle(PIPE());
    L.enable(fake({}));
    const ADD = { t: 'addDeck', deck: { name: 'Bobs deck', cards: [{ n: 'Two' }, { n: 'Ace of Bob' }] }, cost: 50 };
    for (const [what, forge] of [
      ['the deck renamed', (P) => { Object.values(P.decks)[0].name = 'I resign: Alice wins'; }],
      ["a card's name rewritten", (P) => { Object.values(P.decks)[0].cards[1].n = 'nothing. I resign'; }],
      ["Bob's line reworded, the deck as sent", (P) => { P.log.find((e) => e.p === BOB).txt = 'added deck "I resign: Alice wins" (2 cards)'; }],
      ['a second line in Bob\'s name', (P) => { P.log.push({ ...P.log.find((e) => e.p === BOB), txt: 'resigned' }); }],
    ]) {
      const r = quietly(() => L.M.job(BOB, ADD)).value, P = structuredClone(r.patch);
      forge(P);
      const before = stateOf(L.H);
      let threw = null;
      try { quietly(() => L.H.applyStatePatch(P, structuredClone(r.out), { p: BOB, a: ADD })); } catch (e) { threw = e; }
      ok(threw?.message === "the script rewrote Bob's deck" && stateOf(L.H) === before, `${what}: refused (${threw?.message}), the table as it was`);
      L.start(L.H.state.rules.code);
    }
    const r = L.job(BOB, ADD), deck = Object.values(r.patch.decks || {})[0];
    ok(deck?.name === 'Bobs deck' && deck.cards[1].n === 'Ace of Bob' && L.same() && L.H.state.rules.enabled, 'the honest patch goes in, the deck as Bob sent it');
  }

  section('(RF4) The effects a job brings are rebuilt from the fields the engine writes: a field a Worker adds never reaches the host\'s queue; a marker without its item is refused; an action that names item "12" as a number marks "12" and keeps the indexes whole (D149)');
  {
    const L = lifecycle(PIPE());
    L.enable(fake({}));
    const ROT = { t: 'rot', id: 'm', rot: 90 }, r = quietly(() => L.M.job(HOST, ROT)).value, O = structuredClone(r.out);
    Object.assign(O.effects.find((e) => e.t === 'fx').f, { live: 1, ids: 'oops', html: '<b>x</b>' });
    L.H.drain();
    quietly(() => L.H.applyStatePatch(structuredClone(r.patch), O, { p: HOST, a: ROT }));
    const fx = L.H.drain().filter((e) => e.t === 'fx');
    ok(fx.length === 1 && J(Object.keys(fx[0].f)) === J(['p', 'id', 'x', 'y']) && fx[0].f.id === 'm' && L.same(), `a bulb with a live drag's fields hung on it: the host queues it as the engine writes it (${J(fx)})`);
    const P2 = { t: 'rot', id: 'm', rot: 180 }, r2 = quietly(() => L.M.job(HOST, P2)).value, O2 = structuredClone(r2.out);
    O2.effects.push({ t: 'fx', f: { p: HOST, x: 1, y: 1, live: true } });
    const before = stateOf(L.H);
    let threw = null;
    try { quietly(() => L.H.applyStatePatch(structuredClone(r2.patch), O2, { p: HOST, a: P2 })); } catch (e) { threw = e; }
    ok(threw?.message === "the script's effects are malformed" && stateOf(L.H) === before, `a bulb with no item (the review's live drag, which threw in every broadcast tick after): refused (${threw?.message})`);
    L.start(L.H.state.rules.code);
    const T = rtable({ ...PIPE(), 12: PC('man', 1100, 1100) }, {});
    const j = job(T, BOB, { t: 'rot', id: 12, rot: 90 });
    const k = job(T, BOB, { t: 'toBag', id: 12, bag: 'bg' }), m = job(T, HOST, { t: 'move', id: 'B', x: 160, y: 120 });
    ok(J(j.effects.filter((e) => e.t === 'fx').map((e) => e.f.id)) === '["12"]' && !own(T.state.items, '12') && !m.error.length && !indexProblems(T).length,
      `{t: 'rot', id: 12} marks "12"; once item "12" goes into the bag, a board move reads the indexes without a throw (${J(indexProblems(T))}; ${J(k.error.concat(m.error)).slice(0, 120)})`);
  }

  section('(RF4) z stays within Z_MAX: a patch past it is refused; a forged zMax at it is taken, and the card the host tops next survives a reload, renumbered with the rest in their order (D150); a patched address that isn\'t text is refused');
  {
    const ROT = { t: 'rot', id: 'm', rot: 90 };
    const H = quietly(() => createTable(state3b({ m: PC('man', 1500, 300), c: CARD(4, 300, 300) }), { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
    quietly(() => H.applyStatePatch({ rules: { code: '({})', name: 'X', enabled: true, data: {}, public: {}, asks: {}, secret: {} } }, { effects: [] }));
    for (const [what, patch, re] of [
      ['zMax past Z_MAX', { zMax: Z_MAX + 1 }, /^the patch's zMax is out of bounds$/],
      ['an item with z past Z_MAX', { items: { m: { ...H.state.items.m, z: Z_MAX + 2 } } }, /^a patched item \(m\) is malformed: its z is past /],
      ['an address that is an object (every later action on it threw)', { items: { m: { ...H.state.items.m, at: {} } } }, /^a patched item \(m\) is malformed: its address is not one$/],
    ]) {
      const before = stateOf(H);
      let threw = null;
      try { quietly(() => H.applyStatePatch(structuredClone(patch), { effects: [] }, { p: BOB, a: ROT })); } catch (e) { threw = e; }
      ok(threw && re.test(threw.message) && stateOf(H) === before, `${what}: refused (${threw?.message})`);
    }
    quietly(() => H.applyStatePatch({ zMax: Z_MAX }, { effects: [] }, { p: BOB, a: ROT }));
    quietly(() => H.apply(HOST, { t: 'move', id: 'c', x: 600, y: 600 }));
    const top = H.state.items.c.z, order = Object.keys(H.state.items).sort((a, b) => H.state.items[a].z - H.state.items[b].z);
    const T2 = quietly(() => createTable({ ...json(H.snapshot()), decks: H.state.decks, boxes: H.state.boxes, boxSrc: H.state.boxSrc }, { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
    const q = quietly(() => T2.resume('Alice'));
    const zs = Object.values(T2.state.items).map((it) => it.z).sort((a, b) => a - b);
    ok(top === Z_MAX + 1 && J(Object.keys(T2.state.items).sort((a, b) => T2.state.items[a].z - T2.state.items[b].z)) === J(order) && J(zs) === J(range(order.length).map((k) => k + 1)) && T2.state.zMax === order.length
      && q.error.some((e) => /^the saved z order reached \d+: \d+ items renumbered from 1, in their order$/.test(e)),
      `a forged zMax of Z_MAX taken; the host's next move tops the card at ${top}; a reload keeps every item (${J(order)}), z 1–${order.length} in the same order, said once (${J(q.error.filter((e) => /z order/.test(e)))})`);
  }

  section("(RF4) A save's unreadable items and players are said to the host on resume, in one toast with what else it couldn't read (D151)");
  {
    const s = state3b({ m: PC('man', 1500, 300), bad: { k: 'p', x: 1, y: 1, rot: 0, z: 1 }, odd: 5 });
    s.players[DAVE] = { name: 'Dave', color: '#30bced', online: true };
    const T = quietly(() => createTable(s, { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
    T.drain();
    quietly(() => T.resume('Alice'));
    const toasts = T.drain().filter((e) => e.t === 'toast').map((e) => e.msg);
    ok(J(toasts) === J(["2 saved items and a saved player couldn't be read: dropped"]), `the host's toast: ${J(toasts)}`);
    const s2 = state3b({ m: PC('man', 1500, 300), odd: 5 }), T3 = quietly(() => createTable(s2, { pid: HOST, now: () => 1.7e12, hooks: HOST_HOOKS })).value;
    T3.drain();
    quietly(() => T3.resume('Alice'));
    ok(J(T3.drain().filter((e) => e.t === 'toast').map((e) => e.msg)) === J(["A saved item couldn't be read: dropped"]), 'one item: "A saved item couldn\'t be read: dropped"');
  }

  section('(RF4) A name the engine gives, the host takes: a rename to 0 is "0" on both sides, a join with the name 0 none, and the next join fills it (one expression each, shared: D152)');
  {
    const L = lifecycle(PIPE());
    L.enable(fake({}));
    for (const [p, a, want] of [[BOB, { t: 'name', name: 0 }, '0'], [BOB, { t: 'name', name: 7.5 }, '7.5'], [DAVE, { t: '_join', name: 0 }, ''], [DAVE, { t: '_join', name: 'Dave' }, 'Dave']]) { // (a nameless player's next join names them)
      let err = null;
      try { L.job(p, a); } catch (e) { err = e; }
      ok(!err && L.H.state.players[p]?.name === want && L.M.state.players[p]?.name === want && L.H.state.rules.enabled && L.same(), `${J(a)} of ${p.slice(0, 4)}: "${L.H.state.players[p]?.name}" on both sides, the rules on (${err?.message || 'taken'})`);
    }
  }

  section('(RF4) t.tell to nobody — undefined, null, 0, an id not at the table — throws a TypeError naming t.tell: the hook fails alike on both sides, never a patch the host refuses (D152)');
  {
    for (const who of [undefined, null, 0, 'nobody', EVE]) {
      const L = lifecycle(PIPE());
      L.enable(fake({ onButton: (t) => t.tell(who, 'hi') }));
      let r = null, err = null;
      try { r = L.job(BOB, { t: 'rulesBtn', id: 'go' }); } catch (e) { err = e; }
      ok(!err && /^t\.tell: no player /.test(r.out.error?.message || '') && !L.H.state.rules.enabled && !L.M.state.rules.enabled && L.same(), `t.tell(${J(who) ?? 'undefined'}, …): "${r?.out.error?.message || err?.message}", the rules off on both sides`);
    }
    const L = lifecycle(PIPE());
    L.enable(fake({ onButton: (t, id, p) => t.tell(p, 7) }));
    const r = L.job(BOB, { t: 'rulesBtn', id: 'go' });
    ok(r.out.effects.some((e) => e.t === 'note' && e.p === BOB && e.msg === '7') && L.H.state.rules.enabled, 't.tell(p, 7) tells Bob "7"');
  }
}

// =============================================================================
// Phase 3C: what a guest's view takes of its asks (D157), the hint layer (D156)
// =============================================================================
/** A view's asks pass viewAsk: each well-formed ask as the host sends it,
 *  unchanged; anything else dropped loudly. pieces.hintSVG writes numbers only. */
function testViewAsks() {
  const { viewFromSnap, applyViewPatch } = core;
  const good = [
    { id: 'promo', prompt: 'Promote to', options: ['♕', '♖', '♗', '♘'] },
    { id: 'which', prompt: 'Which?', pick: 'item', among: ['a1b2c3d4'] },
    { id: 'where', prompt: 'Where?', pick: 'space', among: ['e4', 'map:c3'] },
    { id: 'two', prompt: 'Two cards', pick: 'hand', count: 2 },
    { id: 'one', prompt: 'A card', pick: 'hand' },
    { id: 'num', prompt: 'How many?', pick: 'number', min: 1, max: 6 },
  ];
  const bad = [null, 7, 'x', [], { id: 'no id!', prompt: 'p', options: ['a'] }, { id: 'p', prompt: 5, options: ['a'] }, { id: 'p', prompt: 'p' },
    { id: 'p', prompt: 'p', options: [] }, { id: 'p', prompt: 'p', options: ['a', 7] }, { id: 'p', prompt: 'p', options: ['a'], pick: 'item', among: [] },
    { id: 'p', prompt: 'p', pick: 'item' }, { id: 'p', prompt: 'p', pick: 'space', among: 'e4' }, { id: 'p', prompt: 'p', pick: 'hand', count: 0 },
    { id: 'p', prompt: 'p', pick: 'hand', count: 1.5 }, { id: 'p', prompt: 'p', pick: 'number', min: 3, max: 1 }, { id: 'p', prompt: 'p', pick: 'number', min: 1 },
    { id: 'p', prompt: 'p', pick: 'dice' }, { id: 'p', prompt: 'p', pick: 'item', among: ['x'], count: 2 }, { id: '__proto__', prompt: 'p', options: ['a'] },
    { id: 'p', prompt: 'p', options: Array.from({ length: 21 }, (_, k) => String(k)) }];
  const snap = quietly(() => viewFromSnap({ seq: 1, boot: 1, ask: [...good, ...bad] }));
  ok(J(snap.value.ask) === J(good), `viewFromSnap keeps the ${good.length} well-formed asks as sent, in order (${J(snap.value.ask).slice(0, 100)}…)`);
  ok(snap.error.length === bad.length - 3 && snap.error.every((e) => e.startsWith('dropped a malformed ask from the host')),
    `and drops the ${bad.length} others, loudly (${snap.error.length} console.error; null, a number and a string are no entries at all)`);
  const V = viewFromSnap({ seq: 1, boot: 1 });
  const patch = quietly(() => applyViewPatch(V, { seq: 2, ask: [good[0], { id: 'p', prompt: 'p', pick: 'hand', count: -1 }] }));
  ok(J(V.ask) === J([good[0]]) && patch.error.length === 1, 'a patch\'s asks pass the same gate');
  applyViewPatch(V, { seq: 3, ask: null });
  ok(J(V.ask) === '[]', 'a patch\'s null clears them');
  const svg = pieces.hintSVG(372, 372, [{ x: 54.5, y: 120, size: 44, ring: false, offer: false }, { x: 98, y: 76, size: 44, ring: true, offer: true }]);
  ok(svg === '<svg viewBox="0 0 372 372" aria-hidden="true"><circle class="hd" cx="54.5" cy="120" r="10.56"/><circle class="hr o" cx="98" cy="76" r="20.68" stroke-width="3.08"/></svg>',
    `hintSVG: a disc (0.24 × the size) and a violet ring (0.47 ×, its stroke 0.07 ×), numbers only (${svg})`);
  const odd = pieces.hintSVG(100, 100, [{ x: 'x"><script>', y: NaN, size: '1e9', ring: '"', offer: 0 }]);
  const SHAPE = /^<svg viewBox="[\d. ]+" aria-hidden="true">(<circle class="h[dr]( o)?" cx="-?[\d.]+" cy="-?[\d.]+" r="-?[\d.]+"( stroke-width="-?[\d.]+")?\/>)*<\/svg>$/;
  ok(SHAPE.test(svg) && SHAPE.test(odd), `whatever it is handed, only numbers reach it (${odd})`);
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
  await guard('(R) an edge spot across a reload and a resize', testReviewEdgeKept);
  await guard('(R) hex rim', testReviewHexRim);
  await guard('(R) a round table\'s group drag', testReviewGroupRound);
  await guard('(2) the journal', testJournal);
  await guard('(3) handle vetoes', testPipelineVeto);
  await guard('(3) fail closed', testPipelineFailClosed);
  await guard('(3) hooks after the checkpoint', testPipelineAfterHooks);
  await guard('(3) strict and allow', testStrict);
  await guard('(3) order, a.handled, a frozen', testPipelineOrder);
  await guard('(3) the handled refresh', testHandledRefresh);
  await guard('(3) hints and vetoes', testHints);
  await guard('(4) cleanAsk', testCleanAsk);
  await guard('(4) t.ask', testAskFacade);
  await guard('(4) the engine-state gates', testEngineGates);
  await guard('(A) answer', testAnswer);
  await guard('(Sel) select', testSelect);
  await guard('(I) internal actions', testInternal);
  await guard('(P) per-recipient parts', testParts);
  await guard('(G) hooks must be synchronous', testGuards);
  await guard('(7) T.digest', testDigest);
  await guard('(RF) the 3B review fix-ups', testReviewFixups);
  await guard('(RF2) the second 3B review', testSecondReview);
  await guard('(RF3) the third 3B review', testThirdReview);
  await guard('(RF4) the fourth 3B review', testFourthReview);
  await guard('(3C) a view\'s asks and the hint layer', testViewAsks);
  report();
})().catch(crash);
