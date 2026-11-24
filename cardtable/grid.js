// Card Table — board grids: their geometry and their address grammar.
//
// Pure maths, no DOM and no state: core.js (cleanBox, and from Phase 3
// snapping), pieces.js (drawing) and the Node tests all use these exact
// formulas (spec §2a). Everything is in BOARD-LOCAL units: a grid's origin
// (x, y) and its cell size are measured from the board's top-left corner.
//
// A grid is {type: 'square' | 'hex', cols, rows, cell, x, y, hex?, snap?,
// labels?} as cleanBox leaves it (hex defaults to 'pointy', snap to 'cell',
// labels to 'xy' on a square grid and 'axial' on a hex one).
//  • square, snap 'cell': cell (c, r) is the square at (x + c·cell, y + r·cell);
//  • square, snap 'point': cols × rows POINTS, (c, r) at (x + c·cell, y + r·cell);
//  • hex 'pointy' (odd-r offset rows) and 'flat' (odd-q offset columns), of
//    radius R = cell/√3: a pointy hex is `cell` wide, a flat one `cell` tall.

/** The code version (see core.js MODULE_V): the same in every cardtable module. */
export const MODULE_V = 1;

/** A hex's radius (centre to corner) for a grid of this cell size (its width across the flats). */
export const hexR = (g) => g.cell / Math.sqrt(3);

/** The centre of cell (or point) (c, r), board-local. */
export function cellCenter(g, c, r) {
  if (g.type === 'hex') {
    const R = hexR(g);
    return g.hex === 'flat'
      ? { x: g.x + R + c * 1.5 * R, y: g.y + g.cell * (r + 0.5 * (c & 1)) + g.cell / 2 }
      : { x: g.x + g.cell * (c + 0.5 * (r & 1)) + g.cell / 2, y: g.y + R + r * 1.5 * R };
  }
  const k = g.snap === 'point' ? 0 : 0.5;
  return { x: g.x + (c + k) * g.cell, y: g.y + (r + k) * g.cell };
}

/** The six corners of hex (c, r), board-local, clockwise from the right-hand side: [[x, y], …]. */
export function hexCorners(g, c, r) {
  const { x, y } = cellCenter(g, c, r), R = hexR(g), a0 = g.hex === 'flat' ? 0 : 30;
  return Array.from({ length: 6 }, (_, k) => {
    const a = ((a0 + 60 * k) * Math.PI) / 180;
    return [x + R * Math.cos(a), y + R * Math.sin(a)];
  });
}

/** Where the grid's drawing ends, board-local: {w, h} from the board's top-left. */
export function gridExtent(g) {
  if (g.type === 'hex') {
    const R = hexR(g);
    return g.hex === 'flat'
      ? { w: g.x + R * (1.5 * g.cols + 0.5), h: g.y + g.cell * (g.rows + (g.cols > 1 ? 0.5 : 0)) }
      : { w: g.x + g.cell * (g.cols + (g.rows > 1 ? 0.5 : 0)), h: g.y + R * (1.5 * g.rows + 0.5) };
  }
  const n = g.snap === 'point' ? -1 : 0; // points: cols − 1 gaps
  return { w: g.x + (g.cols + n) * g.cell, h: g.y + (g.rows + n) * g.cell };
}

/** Offset (c, r) → axial {q, r} (hex grids). */
export const toAxial = (g, c, r) => (g.hex === 'flat' ? { q: c, r: r - (c - (c & 1)) / 2 } : { q: c - (r - (r & 1)) / 2, r });
/** Axial (q, r) → offset {c, r} (hex grids). */
export const fromAxial = (g, q, r) => (g.hex === 'flat' ? { c: q, r: r + (q - (q & 1)) / 2 } : { c: q + (r - (r & 1)) / 2, r });

/** Go's column letters: A…T without I (and on, for boards up to 25 wide). */
export const GO_FILES = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
const CHESS_FILES = 'abcdefghijklmnopqrstuvwxyz';
/** The grid's label scheme, its default filled in. */
export const labelsOf = (g) => g.labels || (g.type === 'hex' ? 'axial' : 'xy');
/** Whether (c, r) is a cell (or point) of the grid. */
export const inGrid = (g, c, r) => Number.isInteger(c) && Number.isInteger(r) && c >= 0 && r >= 0 && c < g.cols && r < g.rows;

const INT = '-?(?:0|[1-9]\\d*)', NAT = '(?:0|[1-9]\\d*)';
const PAIR = new RegExp(`^(${INT}),(${INT})$`), XY = new RegExp(`^(${NAT}),(${NAT})$`);
/** Parses address `s` on grid g ({c, r}, offset coordinates), or null when
 *  it isn't one of this grid's cells (wrong form, or off the grid). Case is
 *  ignored: chess `e4` from the bottom-left, go `D4` (no I), `xy` `3,4` from
 *  the top-left, hex axial `q,r`. */
export function parseAddr(g, s) {
  if (typeof s !== 'string') return null;
  let c, r, m;
  const L = labelsOf(g);
  if (L === 'chess' || L === 'go') {
    if (!(m = /^([a-z])([1-9]\d*)$/i.exec(s))) return null;
    c = (L === 'go' ? GO_FILES : CHESS_FILES).indexOf(L === 'go' ? m[1].toUpperCase() : m[1].toLowerCase());
    r = g.rows - +m[2];
    if (c < 0) return null;
  } else if (L === 'axial') {
    if (!(m = PAIR.exec(s))) return null;
    ({ c, r } = fromAxial(g, +m[1], +m[2]));
  } else {
    if (!(m = XY.exec(s))) return null;
    [c, r] = [+m[1], +m[2]];
  }
  return inGrid(g, c, r) ? { c, r } : null;
}
/** The canonical address of (c, r) on grid g: chess lower case, go upper case. */
export function formatAddr(g, c, r) {
  const L = labelsOf(g);
  if (L === 'chess') return CHESS_FILES[c] + (g.rows - r);
  if (L === 'go') return GO_FILES[c] + (g.rows - r);
  if (L === 'axial') { const a = toAxial(g, c, r); return `${a.q},${a.r}`; }
  return `${c},${r}`;
}

// --- Phase 3: snapping and the spatial helpers (spec §3a, §3e) -----------------
// A board's structure B is {grid?, spaces?, zones?, links?} (cleanBox). On it a
// LOCAL address is a space's id or one of the grid's addresses (cleanBox
// keeps the two apart); a spot is {local, x, y}: the address and its centre,
// board-local.

/** Point (x, y) turned by `deg` about the origin (screen axes, clockwise as
 *  CSS rotate()); quarter turns are exact. */
export function turn(x, y, deg) {
  const q = (((deg % 360) + 360) % 360) / 90;
  if (q === 0) return [x, y];
  if (q === 1) return [-y, x];
  if (q === 2) return [-x, -y];
  if (q === 3) return [y, -x];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
/** Table point (px, py) in the frame of board b ({x, y (its top-left), w, h,
 *  rot}): the inverse of its turn about its centre, as the page draws it. */
export function toLocal(b, px, py) {
  const [x, y] = turn(px - b.x - b.w / 2, py - b.y - b.h / 2, -b.rot);
  return { x: x + b.w / 2, y: y + b.h / 2 };
}
/** Board b's local point (lx, ly) on the table. */
export function fromLocal(b, lx, ly) {
  const [x, y] = turn(lx - b.w / 2, ly - b.h / 2, b.rot);
  return { x: x + b.x + b.w / 2, y: y + b.y + b.h / 2 };
}
/** Whether table point (px, py) lies on board b's (turned) rectangle, edges included. */
export function onBoard(b, px, py) {
  const { x, y } = toLocal(b, px, py);
  return x >= 0 && y >= 0 && x <= b.w && y <= b.h;
}

/** Cube rounding: fractional axial (q, r) → the axial hex holding it. */
export function hexRound(q, r) {
  const s = -q - r;
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(s), dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 }; // (+ 0: never -0)
}
/** The hex of grid g holding board-local (x, y), by pixel → axial → cube
 *  rounding (the inverse of cellCenter's formulas): axial {q, r}, maybe off the grid. */
function hexAt(g, x, y) {
  const R = hexR(g);
  let q, r;
  if (g.hex === 'flat') {
    q = (x - g.x - R) / (1.5 * R);
    r = (y - g.y - g.cell / 2) / g.cell - q / 2;
  } else {
    r = (y - g.y - R) / (1.5 * R);
    q = (x - g.x - g.cell / 2) / g.cell - r / 2;
  }
  return hexRound(q, r);
}
/** The grid spot of g within reach of board-local (x, y), or null: square
 *  cells, the cell holding the point; square points, the nearest point within
 *  cell/2; hexes, the nearest centre within R (spec §3a, Snapping). */
export function gridSpot(g, x, y) {
  if (g.type === 'hex') {
    // The hex holding the point is the nearest centre (a hex is its centre's
    // Voronoi cell) — unless it is off the grid: then, at the grid's rim, an
    // edge hex next to it can still have its centre within R.
    const a = hexAt(g, x, y);
    let best = null, bd = Infinity;
    for (const [dq, dr] of [[0, 0], ...HEX6]) {
      const cr = fromAxial(g, a.q + dq, a.r + dr), p = inGrid(g, cr.c, cr.r) && cellCenter(g, cr.c, cr.r), d = p ? Math.hypot(p.x - x, p.y - y) : Infinity;
      if (d < bd) [best, bd] = [cr, d];
    }
    return bd <= hexR(g) ? best : null;
  }
  const pt = g.snap === 'point', at = pt ? Math.round : Math.floor, c = at((x - g.x) / g.cell), r = at((y - g.y) / g.cell);
  if (!inGrid(g, c, r)) return null;
  if (!pt) return { c, r };
  const p = cellCenter(g, c, r);
  return Math.hypot(p.x - x, p.y - y) <= g.cell / 2 ? { c, r } : null;
}
/** How far board-local (x, y) is from space sp: 0 inside its drawn
 *  rectangle (a space with both w and h: a backgammon point, the bar), else
 *  from its centre (D104: a tall bar's far end is nearer a point's centre
 *  than its own). */
const spaceDist = (sp, x, y) => (sp.w !== undefined && sp.h !== undefined && Math.abs(x - sp.x) <= sp.w / 2 && Math.abs(y - sp.y) <= sp.h / 2
  ? 0 : Math.hypot(sp.x - x, sp.y - y));
/** The spot of structure B within reach of board-local (x, y): the nearest
 *  space within its reach r (spaceDist; between two rectangles holding the
 *  point, the nearer centre) first, then the grid's (gridSpot); {local, x, y} or null. */
export function spotAt(B, x, y) {
  let best = null, bd = Infinity;
  for (const sp of B.spaces || []) {
    const c = Math.hypot(sp.x - x, sp.y - y), d = spaceDist(sp, x, y) || -1 / (1 + c); // (inside: below 0, the nearer centre lower)
    if (d <= sp.r && d < bd) { best = sp; bd = d; }
  }
  if (best) return { local: best.id, x: best.x, y: best.y };
  const cr = B.grid && gridSpot(B.grid, x, y);
  if (!cr) return null;
  const p = cellCenter(B.grid, cr.c, cr.r);
  return { local: formatAddr(B.grid, cr.c, cr.r), x: p.x, y: p.y };
}
/** What local address `s` names on structure B: {space} (a space), {c, r}
 *  (a grid spot, any case), or null. */
export function parseLocal(B, s) {
  const sp = typeof s === 'string' && (B.spaces || []).find((x) => x.id === s);
  if (sp) return { space: sp };
  return B.grid ? parseAddr(B.grid, s) : null;
}
/** The canonical form of local address `s` on B (a space's id, a grid address
 *  as formatAddr writes it), or null when B has no such spot. */
export function canonLocal(B, s) {
  const p = parseLocal(B, s);
  return !p ? null : p.space ? p.space.id : formatAddr(B.grid, p.c, p.r);
}
/** The board-local centre {x, y} of local address `s` on B, or null. */
export function spotOf(B, s) {
  const p = parseLocal(B, s);
  return !p ? null : p.space ? { x: p.space.x, y: p.space.y } : cellCenter(B.grid, p.c, p.r);
}
/** Whether (x, y) lies in polygon `poly` ([[x, y], …]); a point on an edge
 *  or a corner is inside. Even-odd ray casting. */
export function pointInPoly(poly, x, y) {
  let inside = false;
  for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
    const [xi, yi] = poly[k], [xj, yj] = poly[j];
    // on this edge: collinear and between its ends
    const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
    if (Math.abs(cross) <= 1e-9 * (Math.abs(xj - xi) + Math.abs(yj - yi) + 1) && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** The ids of the zones of B holding board-local (x, y), in declaration order. */
export const zonesAt = (B, x, y) => (B.zones || []).filter((z) => pointInPoly(z.poly, x, y)).map((z) => z.id);
/** The spaces linked to space `id` on B (links are undirected), each once, in link order. */
export function linked(B, id) {
  const out = [];
  for (const [a, b] of B.links || []) {
    const o = a === id ? b : b === id ? a : null;
    if (o !== null && o !== id && !out.includes(o)) out.push(o);
  }
  return out;
}

const SQ4 = [[0, -1], [1, 0], [0, 1], [-1, 0]], SQ8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const HEX6 = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]; // axial directions
/** Axial cube coordinates {q, r, s} of grid cell (c, r) (hex grids). */
const cube = (g, c, r) => { const a = toAxial(g, c, r); return { q: a.q, r: a.r, s: -a.q - a.r }; };
/** The local addresses next to `s` on B, in bounds: a square grid's 4
 *  (clockwise from above), or 8 with {diag: true}; a hex's 6; a space's
 *  links. null when `s` is no address of B. */
export function neighbors(B, s, o = {}) {
  const p = parseLocal(B, s);
  if (!p) return null;
  if (p.space) return linked(B, p.space.id);
  const g = B.grid;
  if (g.type === 'hex') {
    const a = toAxial(g, p.c, p.r);
    return HEX6.map(([dq, dr]) => fromAxial(g, a.q + dq, a.r + dr)).filter(({ c, r }) => inGrid(g, c, r)).map(({ c, r }) => formatAddr(g, c, r));
  }
  return (o.diag ? SQ8 : SQ4).map(([dc, dr]) => [p.c + dc, p.r + dr]).filter(([c, r]) => inGrid(g, c, r)).map(([c, r]) => formatAddr(g, c, r));
}
/** Steps from `a` to `b` on B's grid: square, Chebyshev (o.metric 'chebyshev',
 *  the default) or Manhattan ('manhattan'); hex, the cube distance. null when
 *  either is a space or no address of B. */
export function distance(B, a, b, o = {}) {
  const p = parseLocal(B, a), q = parseLocal(B, b);
  if (!p || !q || p.space || q.space) return null;
  const g = B.grid;
  if (g.type === 'hex') { const u = cube(g, p.c, p.r), v = cube(g, q.c, q.r); return Math.max(Math.abs(u.q - v.q), Math.abs(u.r - v.r), Math.abs(u.s - v.s)); }
  const dc = Math.abs(p.c - q.c), dr = Math.abs(p.r - q.r);
  return o.metric === 'manhattan' ? dc + dr : Math.max(dc, dr);
}
/** The local addresses strictly between `a` and `b` on B's grid, in order
 *  from a: square, only along a rank, a file or a diagonal (else null); hex,
 *  the cube-lerp line (nudged off ties). null for spaces or non-addresses;
 *  [] for neighbours or a == b. */
export function line(B, a, b) {
  const p = parseLocal(B, a), q = parseLocal(B, b);
  if (!p || !q || p.space || q.space) return null;
  const g = B.grid, out = [];
  if (g.type === 'hex') {
    const u = cube(g, p.c, p.r), v = cube(g, q.c, q.r), n = distance(B, a, b), e = 1e-6;
    for (let k = 1; k < n; k++) {
      const t = k / n, h = hexRound(u.q + e + (v.q - u.q) * t, u.r + e + (v.r - u.r) * t), cr = fromAxial(g, h.q, h.r);
      out.push(formatAddr(g, cr.c, cr.r));
    }
    return out;
  }
  const dc = q.c - p.c, dr = q.r - p.r;
  if (dc && dr && Math.abs(dc) !== Math.abs(dr)) return null;
  const n = Math.max(Math.abs(dc), Math.abs(dr));
  for (let k = 1; k < n; k++) out.push(formatAddr(g, p.c + (Math.sign(dc) * k), p.r + (Math.sign(dr) * k)));
  return out;
}
