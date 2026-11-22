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
