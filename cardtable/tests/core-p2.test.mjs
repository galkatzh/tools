// Phase 2 core in plain Node (spec §2l, core-p2.test.mjs), checked against
// the spec rather than against the core itself:
//  (G) grid.js: every geometry formula of §2a (square cells and points,
//      pointy and flat hexes, axial coordinates), hex tiling, and
//      parseAddr / formatAddr round trips for every label scheme.
//  (1) cleanBox: defaults by kind (h = w), the faces shorthand, every cap at
//      n and n + 1 (the error names the field), back equality, fills and
//      marks as addresses, address-like space ids, src / by dropped, bad
//      colours, labels and ids, a 2,000-mutation fuzz (only Error is thrown,
//      no invalid field is returned); canon, boxKey and isBuiltin.
//  (2) Every new action and every changed one, with its refusals: the
//      mayHandle / notLocked table of §2c row by row, cap() on every op that
//      adds items, split {onto} atomicity, piles of pieces, the hidden-item
//      rule (byte-identical refusals), the fixed bag hand flag, claim and
//      lock limits, item labels in the log, the facade (§2e).
//  (3) Setup order: over 20 seeds, hidden pieces' z and key order are
//      uncorrelated with their declaration order (Spearman), and a group
//      {shuffle} permutes their places.
//  (4) The public reduction (§2d): hidden pieces, missing boxes, bags, piles
//      of pieces, handy through put and remove, and T.pub equal to a full
//      recompute (and to the spec's table) after 500 random piece ops, with
//      the patches folded into the next snapshot.
//  (5) Seats: named placement on round and rect tables, automatic perimeter
//      seating, joining, setting and clearing named seats, seat-bound owners,
//      sitting down again.
//  (6) MIGRATE[2] and the board z band.
//  (7) randInt: χ² on 60,000 draws of randInt(6), and no modulo bias.
//  (8) The built-in boxes as §2g describes them.
// Every random sequence is seeded and every failure names its seed.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { APP_ROOT, core, ok, section, report, crash, guard, rng, json, canon as sortedJSON, keyOf, HOST, BOB, CAROL, DAVE } from './node-lib.mjs';

const grid = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/grid.js')));
const { BOXES } = await import(pathToFileURL(path.join(APP_ROOT, 'cardtable/templates.js')));
const { createTable, cleanBox, canon, boxKey, isBuiltin, COLOR_RE, MIGRATE, migrate, STATE_V, RULED_ACTIONS, PUBLIC_ACTIONS, randInt } = core;

// --- small tools ----------------------------------------------------------------
const range = (n) => Array.from({ length: n }, (_, k) => k);
const cps = (s) => [...s].length;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/, CTRL_NL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const ID = /^[A-Za-z0-9_-]{1,24}$/, TYPE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const H64 = 'ab'.repeat(32); // an asset id (64 hex digits)
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
/** Runs fn with console.warn / console.error collected, not printed; returns {value, warn, error} (each a list of first arguments). */
function quietly(fn) {
  const got = { warn: [], error: [] }, keep = [console.warn, console.error];
  console.warn = (...a) => got.warn.push(a.map(String).join(' '));
  console.error = (...a) => got.error.push(a.map(String).join(' '));
  try { got.value = fn(); } finally { [console.warn, console.error] = keep; }
  return got;
}
/** cleanBox(b)'s error, or null when it accepts b. */
const boxError = (b) => { try { cleanBox(b); return null; } catch (e) { return e; } };
/** A seeded env whose ids are random hex (as the app's uid() is), not sequential. */
function renv(seed) {
  const r = rng(seed ^ 0x5eed), u = rng(seed ^ 0x1d5);
  let clock = 1.7e12;
  return { pid: HOST, now: () => (clock += 250), random: r, uid: () => Math.floor(u() * 2 ** 32).toString(16).padStart(8, '0') };
}
/** Spearman's rank correlation of two equally long lists of distinct numbers. */
function spearman(a, b) {
  const rank = (xs) => { const o = xs.map((x, k) => [x, k]).sort((p, q) => p[0] - q[0]), r = []; o.forEach(([, k], j) => { r[k] = j; }); return r; };
  const ra = rank(a), rb = rank(b), n = a.length, m = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < n; k++) { num += (ra[k] - m) * (rb[k] - m); da += (ra[k] - m) ** 2; db += (rb[k] - m) ** 2; }
  return num / Math.sqrt(da * db);
}

// =============================================================================
// (G) grid.js
// =============================================================================
/** §2a's grid formulas, written out: the centre of cell (or point) (c, r). */
function specCenter(g, c, r) {
  if (g.type === 'hex') {
    const R = g.cell / Math.sqrt(3);
    return g.hex === 'flat'
      ? { x: g.x + R + c * 1.5 * R, y: g.y + g.cell * (r + 0.5 * (c & 1)) + g.cell / 2 }
      : { x: g.x + g.cell * (c + 0.5 * (r & 1)) + g.cell / 2, y: g.y + R + r * 1.5 * R };
  }
  return g.snap === 'point' ? { x: g.x + c * g.cell, y: g.y + r * g.cell } : { x: g.x + (c + 0.5) * g.cell, y: g.y + (r + 0.5) * g.cell };
}
/** §2a's axial coordinates of offset (c, r). */
const specAxial = (g, c, r) => (g.hex === 'flat' ? { q: c, r: r - (c - (c & 1)) / 2 } : { q: c - (r - (r & 1)) / 2, r });
/** The six offset neighbours of hex (c, r): odd-r rows (pointy) or odd-q columns (flat). */
function hexNeighbours(g, c, r) {
  if (g.hex === 'flat') {
    const d = c & 1 ? [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, 1], [1, 1]] : [[0, -1], [0, 1], [-1, -1], [1, -1], [-1, 0], [1, 0]];
    return d.map(([dc, dr]) => [c + dc, r + dr]);
  }
  const d = r & 1 ? [[-1, 0], [1, 0], [0, -1], [1, -1], [0, 1], [1, 1]] : [[-1, 0], [1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];
  return d.map(([dc, dr]) => [c + dc, r + dr]);
}
const CHESS = 'abcdefghijklmnopqrstuvwxyz', GO = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
/** The address §2a's table gives cell (c, r) of grid g, written independently of grid.js. */
function specAddr(g, c, r) {
  const L = g.labels || (g.type === 'hex' ? 'axial' : 'xy');
  if (L === 'chess') return CHESS[c] + (g.rows - r);
  if (L === 'go') return GO[c] + (g.rows - r);
  if (L === 'axial') { const a = specAxial(g, c, r); return `${a.q},${a.r}`; }
  return `${c},${r}`;
}

function testGrid() {
  section('(G) grid.js: the geometry formulas of §2a');
  const grids = [
    { type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, snap: 'cell', labels: 'chess' },
    { type: 'square', cols: 19, rows: 19, cell: 40, x: 30, y: 30, snap: 'point', labels: 'go' },
    { type: 'square', cols: 5, rows: 3, cell: 37.5, x: -10, y: 4, snap: 'cell', labels: 'xy' },
    { type: 'hex', cols: 7, rows: 6, cell: 60, x: 5, y: 7, hex: 'pointy', labels: 'axial' },
    { type: 'hex', cols: 6, rows: 7, cell: 52, x: 0, y: 0, hex: 'flat', labels: 'axial' },
  ];
  for (const g of grids) {
    const tag = `${g.type} ${g.hex || g.snap} ${g.cols}×${g.rows}`;
    let bad = '';
    for (const c of range(g.cols)) for (const r of range(g.rows)) {
      const got = grid.cellCenter(g, c, r), want = specCenter(g, c, r);
      if (!bad && !(near(got.x, want.x) && near(got.y, want.y))) bad = `(${c}, ${r}): ${JSON.stringify(got)}, the formula gives ${JSON.stringify(want)}`;
    }
    ok(!bad, `${tag}: cellCenter follows §2a's formula for every cell ${bad}`);
    if (g.type !== 'hex') continue;
    let axial = '', dist = '', corners = '', shared = '';
    const R = g.cell / Math.sqrt(3);
    for (const c of range(g.cols)) for (const r of range(g.rows)) {
      const a = grid.toAxial(g, c, r), w = specAxial(g, c, r), back = grid.fromAxial(g, a.q, a.r);
      if (!axial && !(a.q === w.q && a.r === w.r && back.c === c && back.r === r)) axial = `(${c}, ${r}) → ${JSON.stringify(a)} (formula ${JSON.stringify(w)}), back ${JSON.stringify(back)}`;
      const p = grid.cellCenter(g, c, r), cs = grid.hexCorners(g, c, r);
      if (!corners && !(cs.length === 6 && cs.every(([x, y]) => near(Math.hypot(x - p.x, y - p.y), R)))) corners = `(${c}, ${r}): ${JSON.stringify(cs)}`;
      for (const [nc, nr] of hexNeighbours(g, c, r)) {
        if (!grid.inGrid(g, nc, nr)) continue;
        const q = grid.cellCenter(g, nc, nr), b = grid.toAxial(g, nc, nr), dq = b.q - a.q, dr = b.r - a.r;
        if (!dist && !(near(Math.hypot(q.x - p.x, q.y - p.y), g.cell) && (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1)) dist = `(${c}, ${r}) and (${nc}, ${nr})`;
        const common = grid.hexCorners(g, nc, nr).filter(([x, y]) => cs.some(([u, v]) => near(x, u, 1e-6) && near(y, v, 1e-6))).length;
        if (!shared && common !== 2) shared = `(${c}, ${r}) and (${nc}, ${nr}) share ${common} corners`;
      }
    }
    ok(!axial, `${tag}: toAxial follows §2a (${g.hex === 'flat' ? 'q = c, r = row − (c − (c&1))/2' : 'q = c − (r − (r&1))/2'}) and fromAxial inverts it ${axial}`);
    ok(!corners, `${tag}: hexCorners are six points at R = cell/√3 from the centre ${corners}`);
    ok(!dist, `${tag}: the six neighbours of every hex are one cell apart, and one axial step away ${dist}`);
    ok(!shared, `${tag}: neighbouring hexes share exactly one edge (two corners): the grid tiles ${shared}`);
  }
  // The drawing extent holds every cell (the drawing helpers boardSVG will use).
  for (const g of grids) {
    const e = grid.gridExtent(g), R = g.cell / Math.sqrt(3);
    let out = '';
    for (const c of range(g.cols)) for (const r of range(g.rows)) {
      const p = grid.cellCenter(g, c, r);
      const pts = g.type === 'hex' ? grid.hexCorners(g, c, r) : g.snap === 'point' ? [[p.x, p.y]] : [[p.x - g.cell / 2, p.y - g.cell / 2], [p.x + g.cell / 2, p.y + g.cell / 2]];
      if (!out && pts.some(([x, y]) => x > e.w + 1e-6 || y > e.h + 1e-6)) out = `(${c}, ${r}) reaches past ${JSON.stringify(e)}`;
    }
    ok(!out && e.w > 0 && e.h > 0, `${g.type} ${g.hex || g.snap}: gridExtent ${JSON.stringify(e)} holds every cell${g.type === 'hex' ? ` (R ${R.toFixed(2)})` : ''} ${out}`);
  }

  section('(G) parseAddr / formatAddr: the address grammar of §2a');
  for (const g of grids) {
    const tag = `${g.labels} on ${g.type} ${g.cols}×${g.rows}`;
    let bad = '';
    for (const c of range(g.cols)) for (const r of range(g.rows)) {
      const s = grid.formatAddr(g, c, r), p = grid.parseAddr(g, s);
      if (!bad && !(s === specAddr(g, c, r) && p && p.c === c && p.r === r)) bad = `(${c}, ${r}) → ${JSON.stringify(s)} (spec ${specAddr(g, c, r)}) → ${JSON.stringify(p)}`;
      const flip = s === s.toLowerCase() ? s.toUpperCase() : s.toLowerCase(), q = grid.parseAddr(g, flip);
      if (!bad && s !== flip && !(q && q.c === c && q.r === r)) bad = `${flip} (other case) → ${JSON.stringify(q)}`;
    }
    ok(!bad, `${tag}: every cell's canonical address round-trips (case ignored when parsing) ${bad}`);
  }
  const [ch, go, xy, pointy, flat] = grids, P = (g, s) => JSON.stringify(grid.parseAddr(g, s));
  ok(P(ch, 'e4') === '{"c":4,"r":4}' && P(ch, 'a1') === '{"c":0,"r":7}' && P(ch, 'h8') === '{"c":7,"r":0}' && P(ch, 'E4') === '{"c":4,"r":4}',
    'chess: e4 is column 4, row 4 from the top (rank 4 counted from the bottom); a1 bottom-left, h8 top-right; E4 = e4');
  ok(grid.formatAddr(ch, 4, 4) === 'e4' && grid.formatAddr(ch, 0, 7) === 'a1', 'chess output is lower case: e4, a1');
  ok(P(go, 'D4') === '{"c":3,"r":15}' && P(go, 'd4') === '{"c":3,"r":15}' && P(go, 'J10') === '{"c":8,"r":9}' && P(go, 'T19') === '{"c":18,"r":0}' && grid.formatAddr(go, 8, 9) === 'J10',
    'go: A…T without I — D4, J10 (the 9th column), T19; d4 reads as D4, output upper case');
  ok(grid.parseAddr(go, 'I5') === null && grid.parseAddr(go, 'U1') === null, 'go: I is no column, and U is past a 19-wide board');
  ok(P(xy, '3,2') === '{"c":3,"r":2}' && grid.formatAddr(xy, 3, 2) === '3,2', "xy: '3,2' is column 3, row 2 from the top-left, zero-based");
  ok(grid.formatAddr(pointy, 3, 2) === '2,2' && grid.formatAddr(pointy, 0, 3) === '-1,3' && grid.formatAddr(flat, 3, 2) === '3,1' && P(pointy, '-1,3') === '{"c":0,"r":3}',
    "axial: pointy (3, 2) → '2,2', (0, 3) → '-1,3'; flat (3, 2) → '3,1'");
  const off = [[ch, 'i1'], [ch, 'a9'], [ch, 'a0'], [ch, 'e'], [ch, '4e'], [ch, 'e4x'], [ch, ''], [xy, '5,0'], [xy, '0,3'], [xy, '-1,0'], [xy, '1;1'], [pointy, '9,9'], [flat, '0,-1']];
  const accepted = off.filter(([g, s]) => grid.parseAddr(g, s) !== null).map(([, s]) => s);
  ok(!accepted.length, `parseAddr refuses what is no cell of the grid (off it, or not an address): ${accepted.join(' ') || 'none accepted'}`);
  ok([null, undefined, 4, {}, ['e', 4]].every((v) => grid.parseAddr(ch, v) === null), 'parseAddr(non-string) is null, never a throw');
  ok(grid.MODULE_V === core.MODULE_V && core.MODULE_V === 1 && core.PROTO === 3, `grid.js exports MODULE_V like core.js (${grid.MODULE_V}, ${core.MODULE_V}); PROTO is 3 (${core.PROTO})`);
  const wide = { type: 'square', cols: 26, rows: 3, cell: 10, x: 0, y: 0, labels: 'chess' }, goWide = { type: 'square', cols: 25, rows: 3, cell: 10, x: 0, y: 0, snap: 'point', labels: 'go' };
  ok(grid.formatAddr(wide, 25, 0) === 'z3' && grid.formatAddr(goWide, 24, 2) === 'Z1' && P(goWide, 'z1') === '{"c":24,"r":2}', 'the widest boards: chess to z (26 columns), go to Z (25)');
}

// =============================================================================
// (1) cleanBox, canon, boxKey, isBuiltin
// =============================================================================
/** A box around `types` (and any other top-level fields). */
const boxOf = (types, extra = {}) => ({ name: 'Test', imgs: [], ...extra, types });
const T1 = { a: { kind: 'token', name: 'A', faces: ['x'] } };
/** A board type with structure `board` (w 800). */
const boardBox = (board, extra) => boxOf({ m: { kind: 'board', name: 'M', w: 800, board } }, extra);
const sq = (o = {}) => ({ type: 'square', cols: 8, rows: 8, cell: 100, x: 0, y: 0, ...o });

/** The first ways cleaned box `o` breaks §2a (and §2j's caps), checked
 *  field by field without core: [] when it is a valid box. A setup owner
 *  may also be "seat:<a declared seat>" (the built-in boxes need it). */
function boxProblems(o) {
  const bad = [], fail = (m) => { if (bad.length < 5) bad.push(m); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max, min = 0, nl = false) => typeof v === 'string' && cps(v) <= max && cps(v) >= min && !(nl ? CTRL_NL_RE : CTRL_RE).test(v);
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const color = (v) => typeof v === 'string' && COLOR_RE.test(v);
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(fin);
  const only = (v, allowed, at) => { for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${at}: unexpected field ${JSON.stringify(k)}`); };
  const id = (v, re = ID) => typeof v === 'string' && re.test(v) && v !== '__proto__';
  if (!isObj(o)) return ['not an object'];
  only(o, ['name', 'imgs', 'types', 'backs', 'table', 'seats', 'players', 'lockable', 'setup'], 'box');
  if (!str(o.name, 40, 1)) fail('name');
  const imgs = o.imgs;
  if (!Array.isArray(imgs) || imgs.length > 2000 || !imgs.every((h) => h === null || /^[0-9a-f]{64}$/.test(h))) fail('imgs');
  const face = (f, at) => {
    if (!isObj(f)) return fail(`${at} is not a face`);
    only(f, ['img', 'color', 'text', 'label', 'pips'], at);
    if ('img' in f && !(Number.isInteger(f.img) && Array.isArray(imgs) && imgs[f.img])) fail(`${at}.img`);
    if ('color' in f && !color(f.color)) fail(`${at}.color`);
    if ('text' in f && !str(f.text, 300, 0, true)) fail(`${at}.text`);
    if ('label' in f && !str(f.label, 8)) fail(`${at}.label`);
    if ('pips' in f && !(int(f.pips, 0, 9) || (Array.isArray(f.pips) && f.pips.length === 2 && f.pips.every((p) => int(p, 0, 9))))) fail(`${at}.pips`);
  };
  const FL = { w: (v) => int(v, 8, 6000), h: (v) => int(v, 8, 6000), shape: (v) => ['rect', 'round', 'disc', 'hex', 'meeple', 'pawn'].includes(v),
    rotStep: (v) => [0, 15, 30, 45, 60, 90].includes(v), hand: (v) => typeof v === 'boolean', stack: (v) => ['pile', 'count', 'none'].includes(v) };
  const backs = isObj(o.backs) ? o.backs : (o.backs === undefined ? {} : (fail('backs'), {}));
  if (Object.keys(backs).length > 50) fail('backs: over 50');
  for (const [k, b] of Object.entries(backs)) {
    if (!id(k)) fail(`backs: bad id ${k}`);
    if (!isObj(b)) { fail(`backs.${k}`); continue; }
    only(b, ['w', 'h', 'shape', 'rotStep', 'hand', 'stack', 'face'], `backs.${k}`);
    for (const [f, okf] of Object.entries(FL)) if (!okf(b[f])) fail(`backs.${k}.${f}`);
    face(b.face, `backs.${k}.face`);
  }
  const types = isObj(o.types) ? o.types : (fail('types'), {});
  const n = Object.keys(types).length;
  if (n < 1 || n > 500) fail(`types: ${n}`);
  for (const [k, t] of Object.entries(types)) {
    const at = `types.${k}`;
    if (!id(k, TYPE_ID)) fail(`types: bad id ${k}`);
    if (!isObj(t)) { fail(at); continue; }
    only(t, ['kind', 'name', 'w', 'h', 'shape', 'faces', 'back', 'rotStep', 'hand', 'stack', 'meta', 'board'], at);
    if (!['token', 'tile', 'die', 'board'].includes(t.kind)) fail(`${at}.kind`);
    if (!str(t.name, 40, 1)) fail(`${at}.name`);
    for (const [f, okf] of Object.entries(FL)) if (!okf(t[f])) fail(`${at}.${f}`);
    const die = t.kind === 'die';
    if (!Array.isArray(t.faces) || t.faces.length < (die ? 2 : 1) || t.faces.length > (die ? 100 : 64)) fail(`${at}.faces`);
    else t.faces.forEach((f, j) => face(f, `${at}.faces[${j}]`));
    if ('back' in t) {
      const b = isObj(backs[t.back]) && Object.hasOwn(backs, t.back) ? backs[t.back] : null;
      if (!b) fail(`${at}.back`);
      else for (const f of Object.keys(FL)) if (b[f] !== t[f]) fail(`${at}: back ${t.back} has another ${f}`);
    }
    if ('meta' in t && !((JSON.stringify(t.meta) ?? '').length <= 2000)) fail(`${at}.meta`);
    if ('board' in t) {
      if (t.kind !== 'board') fail(`${at}.board on a ${t.kind}`);
      const s = t.board;
      if (!isObj(s)) { fail(`${at}.board`); continue; }
      only(s, ['primary', 'grid', 'spaces', 'zones', 'links'], `${at}.board`);
      if ('primary' in s && s.primary !== true) fail(`${at}.board.primary`);
      const g = s.grid;
      if (g !== undefined) {
        const gat = `${at}.board.grid`;
        if (!isObj(g)) fail(gat);
        else {
          only(g, ['type', 'cols', 'rows', 'cell', 'x', 'y', 'hex', 'snap', 'labels', 'draw', 'colors', 'fills', 'marks'], gat);
          if (!['square', 'hex'].includes(g.type) || !int(g.cols, 1, 64) || !int(g.rows, 1, 64) || g.cols * g.rows > 4096) fail(`${gat} shape`);
          if (!(fin(g.cell) && g.cell >= 8 && g.cell <= 400) || !fin(g.x) || !fin(g.y)) fail(`${gat} numbers`);
          if ('hex' in g && !['pointy', 'flat'].includes(g.hex)) fail(`${gat}.hex`);
          if ('snap' in g && !['cell', 'point'].includes(g.snap)) fail(`${gat}.snap`);
          const L = g.labels ?? (g.type === 'hex' ? 'axial' : 'xy');
          if (!(g.type === 'hex' ? ['axial'] : ['chess', 'go', 'xy']).includes(L) || (L === 'chess' && g.cols > 26) || (L === 'go' && g.cols > 25)) fail(`${gat}.labels`);
          if ('draw' in g && !['checker', 'lines', 'cells', 'none'].includes(g.draw)) fail(`${gat}.draw`);
          if ('colors' in g && !(Array.isArray(g.colors) && g.colors.length === 2 && g.colors.every(color))) fail(`${gat}.colors`);
          const canonical = (a) => { const p = grid.parseAddr(g, a); return !!p && grid.formatAddr(g, p.c, p.r) === a; };
          if ('fills' in g && !(isObj(g.fills) && Object.keys(g.fills).length <= 4096 && Object.entries(g.fills).every(([a, c]) => canonical(a) && color(c)))) fail(`${gat}.fills`);
          if ('marks' in g && !(Array.isArray(g.marks) && g.marks.length <= 64 && g.marks.every(canonical))) fail(`${gat}.marks`);
        }
      }
      const ids = new Set();
      if ('spaces' in s) {
        if (!Array.isArray(s.spaces) || s.spaces.length > 1000) fail(`${at}.board.spaces`);
        else s.spaces.forEach((sp, j) => {
          const sat = `${at}.board.spaces[${j}]`;
          if (!isObj(sp)) return fail(sat);
          only(sp, ['id', 'x', 'y', 'r', 'mark', 'w', 'h', 'dir', 'color', 'label'], sat);
          if (!id(sp.id) || ids.has(sp.id) || (isObj(g) && grid.parseAddr(g, sp.id))) fail(`${sat}.id`);
          ids.add(sp.id);
          if (!fin(sp.x) || !fin(sp.y) || !(fin(sp.r) && sp.r >= 4 && sp.r <= 400)) fail(`${sat} numbers`);
          if ('mark' in sp && !['dot', 'ring', 'tri', 'rect', 'none'].includes(sp.mark)) fail(`${sat}.mark`);
          for (const k of ['w', 'h']) if (k in sp && !(fin(sp[k]) && sp[k] >= 0)) fail(`${sat}.${k}`);
          if ('dir' in sp && !['up', 'down', 'left', 'right'].includes(sp.dir)) fail(`${sat}.dir`);
          if ('color' in sp && !color(sp.color)) fail(`${sat}.color`);
          if ('label' in sp && !str(sp.label, 12)) fail(`${sat}.label`);
        });
      }
      if ('zones' in s) {
        const zids = new Set();
        if (!Array.isArray(s.zones) || s.zones.length > 100) fail(`${at}.board.zones`);
        else s.zones.forEach((z, j) => {
          const zat = `${at}.board.zones[${j}]`;
          if (!isObj(z)) return fail(zat);
          only(z, ['id', 'poly', 'owner', 'private', 'color', 'label'], zat);
          if (!id(z.id) || zids.has(z.id)) fail(`${zat}.id`);
          zids.add(z.id);
          if (!(Array.isArray(z.poly) && z.poly.length >= 3 && z.poly.length <= 64 && z.poly.every(pair))) fail(`${zat}.poly`);
          if ('owner' in z && !(z.owner === 'board' || (typeof z.owner === 'string' && z.owner.startsWith('seat:') && id(z.owner.slice(5))))) fail(`${zat}.owner`);
          if ('private' in z && !['reveal', 'keep'].includes(z.private)) fail(`${zat}.private`);
          if ('color' in z && !color(z.color)) fail(`${zat}.color`);
          if ('label' in z && !str(z.label, 24)) fail(`${zat}.label`);
        });
      }
      if ('links' in s && !(Array.isArray(s.links) && s.links.length <= 4000 && s.links.every((l) => Array.isArray(l) && l.length === 2 && l.every((x) => ids.has(x))))) fail(`${at}.board.links`);
    }
  }
  if ('table' in o) {
    const t = o.table;
    if (!isObj(t)) fail('table');
    else {
      only(t, ['shape', 'w', 'h', 'felt'], 'table');
      if (t.shape === 'round') { if (!([1300, 1800, 2400].includes(t.w) && t.h === t.w)) fail('table: round size'); } else if (t.shape === 'rect') { if (!(int(t.w, 800, 6000) && int(t.h, 600, 4000))) fail('table: rect size'); } else fail('table.shape');
      if ('felt' in t && !color(t.felt)) fail('table.felt');
    }
  }
  const seatIds = new Set();
  if ('seats' in o) {
    if (!Array.isArray(o.seats) || o.seats.length > 12) fail('seats');
    else o.seats.forEach((s, j) => {
      const sat = `seats[${j}]`;
      if (!isObj(s)) return fail(sat);
      only(s, ['id', 'name', 'color', 'edge', 'at', 'angle'], sat);
      if (!id(s.id) || seatIds.has(s.id)) fail(`${sat}.id`);
      seatIds.add(s.id);
      if (!str(s.name, 24, 1)) fail(`${sat}.name`);
      if ('color' in s && !color(s.color)) fail(`${sat}.color`);
      if (['edge', 'at', 'angle'].filter((k) => k in s).length > 1) fail(`${sat}: two placements`);
      if ('edge' in s && !['bottom', 'top', 'left', 'right'].includes(s.edge)) fail(`${sat}.edge`);
      if ('at' in s && !pair(s.at)) fail(`${sat}.at`);
      if ('angle' in s && !fin(s.angle)) fail(`${sat}.angle`);
    });
  }
  if ('players' in o && !(Array.isArray(o.players) && o.players.length === 2 && o.players.every((x) => int(x, 1, 99)) && o.players[0] <= o.players[1])) fail('players');
  if ('lockable' in o && o.lockable !== 'anyone') fail('lockable');
  if ('setup' in o) {
    const perSeat = Math.max(1, seatIds.size);
    let items = 0;
    const where = (v, inSeat, at) => {
      if (v === 'center' || pair(v)) return;
      if (inSeat && (v === 'seat' || (isObj(v) && Object.keys(v).join() === 'seat' && pair(v.seat)))) return;
      fail(`${at}.at`);
    };
    const owner = (v, inSeat, at) => { if (!((v === 'seat' && inSeat) || (typeof v === 'string' && v.startsWith('seat:') && seatIds.has(v.slice(5))))) fail(`${at}.owner`); };
    const tyOf = (tid) => (typeof tid === 'string' && Object.hasOwn(types, tid) ? types[tid] : null);
    const entry = (e, at, inSeat, mult) => {
      if (!isObj(e)) return fail(at);
      const kinds = ['piece', 'supply', 'bag', 'forEachSeat', 'group'].filter((k) => k in e);
      if (kinds.length !== 1) return fail(`${at}: ${kinds.length} kinds`);
      const [kind] = kinds;
      if (kind === 'forEachSeat' || kind === 'group') {
        only(e, kind === 'group' ? ['group', 'shuffle'] : ['forEachSeat'], at);
        if (kind === 'forEachSeat' && inSeat) fail(`${at}: nested forEachSeat`);
        if ('shuffle' in e && e.shuffle !== true) fail(`${at}.shuffle`);
        if (!Array.isArray(e[kind])) return fail(`${at}.${kind}`);
        e[kind].forEach((x, j) => entry(x, `${at}.${kind}[${j}]`, inSeat || kind === 'forEachSeat', kind === 'forEachSeat' ? mult * perSeat : mult));
        return;
      }
      if (kind === 'bag') {
        only(e, ['bag', 'name', 'at', 'owner', 'hand', 'lock'], at);
        if (!Array.isArray(e.bag)) return fail(`${at}.bag`);
        let size = 0;
        e.bag.forEach((m, j) => {
          const x = typeof m === 'string' ? { t: m } : m, ty = isObj(x) && tyOf(x.t);
          if (!ty) return fail(`${at}.bag[${j}]`);
          only(x, ['t', 'f', 'n', 'up'], `${at}.bag[${j}]`);
          if ('f' in x && !int(x.f, 0, ty.faces.length - 1)) fail(`${at}.bag[${j}].f`);
          if ('n' in x && !int(x.n, 1, 999)) fail(`${at}.bag[${j}].n`);
          if ('up' in x && (typeof x.up !== 'boolean' || (x.up === false && !ty.back))) fail(`${at}.bag[${j}].up`);
          size += x.n ?? 1;
        });
        if (size > 1000) fail(`${at}: bag of ${size}`);
        if ('name' in e && !str(e.name, 24)) fail(`${at}.name`);
        if ('hand' in e && typeof e.hand !== 'boolean') fail(`${at}.hand`);
        items += mult;
      } else {
        only(e, kind === 'piece' ? ['piece', 'at', 'f', 'n', 'count', 'spread', 'owner', 'lock', 'up', 'rot'] : ['supply', 'at', 'f', 'up', 'lock', 'owner'], at);
        const ty = tyOf(e[kind]);
        if (!ty) return fail(`${at}.${kind}`);
        if ('f' in e && !int(e.f, 0, ty.faces.length - 1)) fail(`${at}.f`);
        if ('up' in e && (typeof e.up !== 'boolean' || (e.up === false && !ty.back))) fail(`${at}.up`);
        if ('n' in e && !(int(e.n, 2, 999) && ty.stack === 'count')) fail(`${at}.n`);
        if ('count' in e && !int(e.count, 1, 200)) fail(`${at}.count`);
        if ('spread' in e && !pair(e.spread)) fail(`${at}.spread`);
        if ('rot' in e && !fin(e.rot)) fail(`${at}.rot`);
        items += mult * (e.count ?? 1);
      }
      if ('lock' in e && typeof e.lock !== 'boolean') fail(`${at}.lock`);
      where(e.at, inSeat, at);
      if ('owner' in e) owner(e.owner, inSeat, at);
    };
    if (!Array.isArray(o.setup) || o.setup.length > 2000) fail('setup');
    else o.setup.forEach((e, j) => entry(e, `setup[${j}]`, false, 1));
    if (items > 3000) fail(`setup spawns ${items} items`);
  }
  return bad;
}

/** A box using every field of §2a: the fuzz's starting point. */
const RICH = {
  name: 'Rich box', imgs: [null, H64],
  backs: { hb: { face: { color: '#345', label: '?' } }, tb: { w: 100, face: { img: 1 } } },
  types: {
    tok: { kind: 'token', name: 'Gem', faces: ['A', 2, { color: '#c00', text: 'line\nnext', pips: [1, 2] }], meta: { v: 1, tags: ['x'] } },
    spy: { kind: 'token', name: 'Spy', back: 'hb', faces: ['S'] },
    tile: { kind: 'tile', name: 'Tile', back: 'tb', faces: [{ img: 1 }, 'T'], rotStep: 90 },
    die: { kind: 'die', name: 'Die' },
    board: {
      kind: 'board', name: 'Board', w: 800, h: 600, board: {
        primary: true,
        grid: { type: 'square', cols: 8, rows: 6, cell: 90, x: 40, y: 30, labels: 'chess', draw: 'checker', colors: ['#fff', '#000'], fills: { a1: '#f00', H6: 'blue' }, marks: ['d3', 'E4'] },
        spaces: [{ id: 'bar', x: 10, y: 10, r: 20, mark: 'ring', color: '#0f0', label: 'Bar', dir: 'up' }, { id: 'home', x: 50, y: 50, r: 30, w: 40, h: 50, mark: 'rect' }],
        zones: [{ id: 'z1', poly: [[0, 0], [100, 0], [0, 100]], owner: 'seat:n', private: 'keep', color: 'red', label: 'North' }],
        links: [['bar', 'home']],
      },
    },
    hexmap: { kind: 'board', name: 'Hex map', w: 600, board: { grid: { type: 'hex', cols: 5, rows: 5, cell: 60, x: 0, y: 0, hex: 'flat', fills: { '0,0': '#abc' } } } },
  },
  table: { shape: 'rect', w: 2000, h: 1500, felt: '#123456' },
  seats: [{ id: 'n', name: 'North', edge: 'top', color: '#eee' }, { id: 's', name: 'South' }, { id: 'e', name: 'East', angle: 0 }, { id: 'w', name: 'West', at: [100, 750] }],
  players: [2, 4],
  lockable: 'anyone',
  setup: [
    { piece: 'board', at: 'center' },
    { forEachSeat: [{ piece: 'tok', at: 'seat', n: 3, owner: 'seat' }, { supply: 'tile', at: { seat: [100, 50] }, up: false }] },
    { group: [{ piece: 'spy', at: [10, 10], up: false, count: 3, spread: [70, 0] }, { piece: 'tile', at: [10, 200], f: 1, up: false, rot: 90, lock: true }], shuffle: true },
    { bag: ['tok', { t: 'spy', up: false, n: 4 }, { t: 'tile', f: 1 }], name: 'Sack', at: [500, 500], hand: false },
    { piece: 'die', at: [900, 900], count: 2, spread: [60, 0] },
  ],
};

/** Every [parent, key] of a JSON tree (the root excluded). */
function slots(v, out = []) {
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.push([v, k]); slots(v[k], out); }
  return out;
}
/** Leaf paths (lists of keys) of a JSON tree. */
function leaves(v, at = [], out = []) {
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) leaves(v[k], [...at, k], out); } else out.push(at);
  return out;
}
const getAt = (v, p) => p.reduce((o, k) => o[k], v);
const setAt = (v, p, x) => { getAt(v, p.slice(0, -1))[p.at(-1)] = x; };

function testCleanBox() {
  section('(1) cleanBox: defaults by kind, h = w, the faces shorthand');
  const c = cleanBox(boxOf({ a: { kind: 'token', name: 'A', faces: ['x'] }, b: { kind: 'tile', name: 'B', faces: ['y'] }, d: { kind: 'die', name: 'D' }, m: { kind: 'board', name: 'M', w: 500 } }));
  const flags = (t) => ({ shape: t.shape, w: t.w, h: t.h, stack: t.stack, rotStep: t.rotStep, hand: t.hand });
  ok(isDeepStrictEqual(flags(c.types.a), { shape: 'disc', w: 60, h: 60, stack: 'count', rotStep: 0, hand: false }), `token: disc, 60 × 60, count, rotStep 0, no hand (${JSON.stringify(flags(c.types.a))})`);
  ok(isDeepStrictEqual(flags(c.types.b), { shape: 'rect', w: 100, h: 100, stack: 'pile', rotStep: 90, hand: true }), `tile: rect, 100 × 100, pile, rotStep 90, hand (${JSON.stringify(flags(c.types.b))})`);
  ok(isDeepStrictEqual(flags(c.types.d), { shape: 'rect', w: 56, h: 56, stack: 'none', rotStep: 0, hand: false }) && isDeepStrictEqual(c.types.d.faces, [1, 2, 3, 4, 5, 6].map((n) => ({ pips: n }))),
    `die: rect, 56 × 56, none, rotStep 0, no hand, faces 1–6 as pips (${JSON.stringify(flags(c.types.d))}, ${JSON.stringify(c.types.d.faces)})`);
  ok(isDeepStrictEqual(flags(c.types.m), { shape: 'rect', w: 500, h: 500, stack: 'none', rotStep: 90, hand: false }) && isDeepStrictEqual(c.types.m.faces, [{ color: '#d6b98c' }]),
    `board: rect, h = w, none, rotStep 90, no hand, one #d6b98c face (${JSON.stringify(flags(c.types.m))}, ${JSON.stringify(c.types.m.faces)})`);
  const hw = cleanBox(boxOf({ a: { kind: 'token', name: 'A', w: 80, faces: ['x'] }, b: { kind: 'tile', name: 'B', w: 30, faces: ['y'] }, d: { kind: 'die', name: 'D', w: 70 }, m: { kind: 'board', name: 'M', w: 840 }, n: { kind: 'board', name: 'N', w: 840, h: 300 } }));
  ok(['a', 'b', 'd', 'm'].every((k) => hw.types[k].h === hw.types[k].w) && hw.types.n.h === 300, 'h defaults to w for every kind when only w is given (80, 30, 70, 840), and an explicit h stays (300)');
  for (const [what, b, field] of [
    ['a token without faces', boxOf({ a: { kind: 'token', name: 'A' } }), 'faces'],
    ['a tile without faces', boxOf({ a: { kind: 'tile', name: 'A' } }), 'faces'],
    ['a board without w', boxOf({ a: { kind: 'board', name: 'A' } }), 'w'],
    ['a die with one face', boxOf({ a: { kind: 'die', name: 'A', faces: [3] } }), 'faces'],
    ['a token with no faces', boxOf({ a: { kind: 'token', name: 'A', faces: [] } }), 'faces'],
    ['a "card" kind', boxOf({ a: { kind: 'card', name: 'A', faces: ['x'] } }), 'kind'],
    ['no types at all', boxOf({}), 'types'],
    ['a type without a name', boxOf({ a: { kind: 'token', faces: ['x'] } }), 'name'],
  ]) {
    const e = boxError(b);
    ok(e instanceof Error && e.message.includes(field), `${what} throws, naming ${field} (${e?.message})`);
  }
  const sh = cleanBox(boxOf({ t: { kind: 'token', name: 'T', faces: [3, 'x', { label: 'y' }, 1] }, d: { kind: 'die', name: 'D', faces: [1, 6, 7, 'a', 0, { label: 'z' }] } }));
  ok(isDeepStrictEqual(sh.types.t.faces, [{ label: '3' }, { label: 'x' }, { label: 'y' }, { label: '1' }]), `faces shorthand on a token: a number n → {label: "n"}, a string s → {label: s} (${JSON.stringify(sh.types.t.faces)})`);
  ok(isDeepStrictEqual(sh.types.d.faces, [{ pips: 1 }, { pips: 6 }, { label: '7' }, { label: 'a' }, { label: '0' }, { label: 'z' }]), `on a die, 1–6 → {pips: n}; other numbers and strings → labels (${JSON.stringify(sh.types.d.faces)})`);

  section('(1) cleanBox: every cap — n is accepted, n + 1 throws naming the field');
  const types = (n) => Object.fromEntries(range(n).map((k) => [`t${k}`, { kind: 'token', name: `T${k}`, faces: ['a'] }]));
  const space = (k) => ({ id: `s${k}`, x: k, y: 0, r: 10 });
  const tri = [[0, 0], [10, 0], [0, 10]];
  const xy64 = range(64 * 64).map((k) => `${k % 64},${Math.floor(k / 64)}`);
  const chess64 = range(64).map((k) => CHESS[k % 8] + (Math.floor(k / 8) + 1));
  const seatList = (n) => range(n).map((k) => ({ id: `s${k}`, name: `Seat ${k}` }));
  const caps = [
    ['types', 500, (n) => boxOf(types(n)), ['types']],
    ['backs', 50, (n) => boxOf(T1, { backs: Object.fromEntries(range(n).map((k) => [`b${k}`, { face: {} }])) }), ['backs']],
    ['faces per type', 64, (n) => boxOf({ a: { kind: 'token', name: 'A', faces: range(n).map(String) } }), ['faces']],
    ['faces per die', 100, (n) => boxOf({ a: { kind: 'die', name: 'A', faces: range(n).map((k) => `f${k}`) } }), ['faces']],
    ['grid columns (cells: 64 × 64 = 4,096)', 64, (n) => boardBox({ grid: sq({ cols: n, rows: 64, cell: 10 }) }), ['cols', 'cells', 'grid']],
    ['grid rows (cells: 64 × 64 = 4,096)', 64, (n) => boardBox({ grid: sq({ cols: 64, rows: n, cell: 10 }) }), ['rows', 'cells', 'grid']],
    ['spaces', 1000, (n) => boardBox({ spaces: range(n).map(space) }), ['spaces']],
    ['zones', 100, (n) => boardBox({ zones: range(n).map((k) => ({ id: `z${k}`, poly: tri })) }), ['zones']],
    ['points per zone polygon', 64, (n) => boardBox({ zones: [{ id: 'z', poly: range(n).map((k) => [k, k * k]) }] }), ['poly']],
    ['links', 4000, (n) => boardBox({ spaces: range(10).map(space), links: range(n).map((k) => [`s${k % 10}`, `s${(k + 1) % 10}`]) }), ['links']],
    // (a 64 × 64 grid has 4,096 addresses: the 4,097th fill can only be one more key)
    ['fills', 4096, (n) => boardBox({ grid: { ...sq({ cols: 64, rows: 64, cell: 10 }), fills: Object.fromEntries([...xy64, 'a1'].slice(0, n).map((a) => [a, '#fff'])) } }), ['fills']],
    ['marks', 64, (n) => boardBox({ grid: { ...sq({ labels: 'chess' }), marks: [...chess64, 'a1'].slice(0, n) } }), ['marks']],
    ['setup entries', 2000, (n) => boxOf(T1, { setup: range(n).map(() => ({ piece: 'a', at: [0, 0] })) }), ['setup']],
    ['items spawned by a setup', 3000, (n) => boxOf(T1, { setup: [...range(15).map(() => ({ piece: 'a', at: [0, 0], count: 200 })), ...range(n - 3000).map(() => ({ piece: 'a', at: [0, 0] }))] }), ['setup']],
    ['items spawned by a setup, forEachSeat × 2 named seats', 1500, (n) => boxOf(T1, { seats: seatList(2), setup: [{ forEachSeat: [...range(7).map(() => ({ piece: 'a', at: 'seat', count: 200 })), { piece: 'a', at: 'seat', count: n - 1400 }] }] }), ['setup']],
    ['seats', 12, (n) => boxOf(T1, { seats: seatList(n) }), ['seats']],
    ['meta (2,000 chars of JSON)', 1998, (n) => boxOf({ a: { kind: 'token', name: 'A', faces: ['x'], meta: 'x'.repeat(n) } }), ['meta']],
    ['the box name (40)', 40, (n) => ({ ...boxOf(T1), name: 'n'.repeat(n) }), ['name']],
    ['a type name (40)', 40, (n) => boxOf({ a: { kind: 'token', name: 'é'.repeat(n), faces: ['x'] } }), ['name']],
    ['a face label (8 code points)', 8, (n) => boxOf({ a: { kind: 'token', name: 'A', faces: [{ label: '♛'.repeat(n) }] } }), ['label']],
    ['a face text (300)', 300, (n) => boxOf({ a: { kind: 'token', name: 'A', faces: [{ text: 't'.repeat(n) }] } }), ['text']],
    ['a space label (12)', 12, (n) => boardBox({ spaces: [{ id: 'sp', x: 0, y: 0, r: 10, label: 'l'.repeat(n) }] }), ['label']],
    ['a zone label (24)', 24, (n) => boardBox({ zones: [{ id: 'z', poly: tri, label: 'l'.repeat(n) }] }), ['label']],
    ['a seat name (24)', 24, (n) => boxOf(T1, { seats: [{ id: 's', name: 'n'.repeat(n) }] }), ['name']],
    ['images', 2000, (n) => boxOf(T1, { imgs: range(n).map(() => null) }), ['imgs']],
    ['a setup count', 200, (n) => boxOf(T1, { setup: [{ piece: 'a', at: [0, 0], count: n }] }), ['count']],
    ['a setup stack n', 999, (n) => boxOf(T1, { setup: [{ piece: 'a', at: [0, 0], n }] }), ['n']],
    ['a bag member n', 999, (n) => boxOf(T1, { setup: [{ bag: [{ t: 'a', n }], at: [0, 0] }] }), ['n']],
    ['a bag (1,000 pieces)', 1000, (n) => boxOf(T1, { setup: [{ bag: [{ t: 'a', n: 999 }, ...range(n - 999).map(() => 'a')], at: [0, 0] }] }), ['bag']],
  ];
  for (const [what, n, make, fields] of caps) {
    const atCap = boxError(make(n)), over = boxError(make(n + 1));
    ok(!atCap, `${what}: ${n} is accepted${atCap ? ` — threw ${atCap.message}` : ''}`);
    ok(over instanceof Error && fields.some((f) => over.message.includes(f)), `${what}: ${n + 1} throws, naming ${fields.join(' or ')} (${over?.message ?? 'accepted'})`);
  }

  section('(1) cleanBox: back equality (size, shape, rotStep, hand, stack)');
  const twoOnBack = (diff, backFlags = {}) => boxOf({ x: { kind: 'token', name: 'X', faces: ['a'], back: 'b' }, y: { kind: 'token', name: 'Y', faces: ['a'], back: 'b', ...diff } }, { backs: { b: { face: { color: '#222' }, ...backFlags } } });
  const same = cleanBox(twoOnBack({}));
  ok(isDeepStrictEqual(same.backs.b, { w: 60, h: 60, shape: 'disc', rotStep: 0, hand: false, stack: 'count', face: { color: '#222' } }),
    `two tokens on one back: the back takes their w, h, shape, rotStep, hand and stack (${JSON.stringify(same.backs.b)})`);
  for (const [diff, why] of [[{ w: 61 }, 'w'], [{ h: 61 }, 'h'], [{ shape: 'round' }, 'shape'], [{ rotStep: 90 }, 'rotStep'], [{ hand: true }, 'hand'], [{ stack: 'none' }, 'stack']]) {
    const e = boxError(twoOnBack(diff));
    ok(e instanceof Error, `a second type on the back with another ${why} throws (${e?.message ?? 'accepted'})`);
  }
  const e1 = boxError(twoOnBack({}, { w: 80 })), e2 = boxError(boxOf({ x: { kind: 'token', name: 'X', faces: ['a'], back: 'nope' } }));
  const e3 = boxError(boxOf({ x: { kind: 'token', name: 'X', faces: ['a'], back: 'b' }, y: { kind: 'tile', name: 'Y', faces: ['a'], back: 'b' } }, { backs: { b: { face: {} } } }));
  ok(e1 instanceof Error, `a back that declares w 80 under 60-wide tokens throws (${e1?.message ?? 'accepted'})`);
  ok(e2 instanceof Error && e2.message.includes('back'), `a type naming no back of the box throws, naming back (${e2?.message ?? 'accepted'})`);
  ok(e3 instanceof Error, `a token and a tile can't share a back (${e3?.message ?? 'accepted'})`);

  section('(1) cleanBox: fills and marks are addresses; address-like space ids are refused');
  const ch = cleanBox(boardBox({ grid: { ...sq({ labels: 'chess' }), fills: { E4: '#fff', a1: 'red' }, marks: ['D5', 'h8'] } })).types.m.board.grid;
  ok(isDeepStrictEqual(Object.keys(ch.fills).sort(), ['a1', 'e4']) && isDeepStrictEqual(ch.marks, ['d5', 'h8']), `chess: fills and marks parse, and are kept canonical (lower case): ${JSON.stringify(ch.fills)} ${JSON.stringify(ch.marks)}`);
  const goG = cleanBox(boardBox({ grid: { ...sq({ cols: 19, rows: 19, cell: 40, snap: 'point', labels: 'go' }), fills: { d4: '#000' }, marks: ['d4', 'q16', 'K10'] } })).types.m.board.grid;
  ok(isDeepStrictEqual(Object.keys(goG.fills), ['D4']) && isDeepStrictEqual(goG.marks, ['D4', 'Q16', 'K10']), `go: canonical upper case (${JSON.stringify(goG.fills)} ${JSON.stringify(goG.marks)})`);
  const hexG = boxError(boardBox({ grid: { type: 'hex', cols: 4, rows: 4, cell: 50, x: 0, y: 0, hex: 'pointy', fills: { '0,0': '#abc', '-1,3': '#abc' }, marks: ['1,1'] } }));
  ok(!hexG, `hex: axial fills and marks ('0,0', '-1,3', '1,1') are accepted ${hexG?.message ?? ''}`);
  for (const [what, b, field] of [
    ['a fill off a chess board (i1)', boardBox({ grid: { ...sq({ labels: 'chess' }), fills: { i1: '#fff' } } }), 'fills'],
    ['a fill off an xy board (8,8)', boardBox({ grid: { ...sq(), fills: { '8,8': '#fff' } } }), 'fills'],
    ['a fill that is no address (x)', boardBox({ grid: { ...sq(), fills: { x: '#fff' } } }), 'fills'],
    ['a fill with a bad colour', boardBox({ grid: { ...sq(), fills: { '1,1': 'url(x)' } } }), 'fills'],
    ['a go mark on column I', boardBox({ grid: { ...sq({ cols: 19, rows: 19, cell: 40, labels: 'go' }), marks: ['I5'] } }), 'marks'],
    ['an axial mark off the grid', boardBox({ grid: { type: 'hex', cols: 4, rows: 4, cell: 50, x: 0, y: 0, marks: ['9,9'] } }), 'marks'],
    ['a space id that reads as a chess address (e4)', boardBox({ grid: sq({ labels: 'chess' }), spaces: [{ id: 'e4', x: 0, y: 0, r: 10 }] }), 'e4'],
    ['a space id E4 (case is ignored)', boardBox({ grid: sq({ labels: 'chess' }), spaces: [{ id: 'E4', x: 0, y: 0, r: 10 }] }), 'E4'],
    ['a space id D4 on a go board', boardBox({ grid: sq({ cols: 19, rows: 19, cell: 40, labels: 'go' }), spaces: [{ id: 'D4', x: 0, y: 0, r: 10 }] }), 'D4'],
    ['a space id with a comma (3,4)', boardBox({ grid: sq(), spaces: [{ id: '3,4', x: 0, y: 0, r: 10 }] }), 'id'],
    ['two spaces with one id', boardBox({ spaces: [space(1), space(1)] }), 'id'],
    ['a link to no space', boardBox({ spaces: [space(1)], links: [['s1', 'nope']] }), 'links'],
    ['a zone polygon of two points', boardBox({ zones: [{ id: 'z', poly: [[0, 0], [1, 1]] }] }), 'poly'],
    ['a zone point that is not finite', boardBox({ zones: [{ id: 'z', poly: [[0, 0], [1, NaN], [0, 1]] }] }), 'poly'],
    ['a chess grid 27 columns wide', boardBox({ grid: sq({ cols: 27, labels: 'chess' }) }), 'labels'],
    ['a go grid 26 columns wide', boardBox({ grid: sq({ cols: 26, labels: 'go' }) }), 'labels'],
    ['a board structure on a token', boxOf({ a: { kind: 'token', name: 'A', faces: ['x'], board: {} } }), 'board'],
  ]) {
    const e = boxError(b);
    ok(e instanceof Error && e.message.includes(field), `${what} throws, naming ${field} (${e?.message ?? 'accepted'})`);
  }
  for (const [what, b] of [['bar', boardBox({ grid: sq({ labels: 'chess' }), spaces: [{ id: 'bar', x: 0, y: 0, r: 10 }] })],
    ['a9 on an 8-row chess board (no such square)', boardBox({ grid: sq({ labels: 'chess' }), spaces: [{ id: 'a9', x: 0, y: 0, r: 10 }] })],
    ['I4 on a go board (go has no I)', boardBox({ grid: sq({ cols: 19, rows: 19, cell: 40, labels: 'go' }), spaces: [{ id: 'I4', x: 0, y: 0, r: 10 }] })],
    ['e4 on a board without a grid', boardBox({ spaces: [{ id: 'e4', x: 0, y: 0, r: 10 }] })]]) {
    const e = boxError(b);
    ok(!e, `a space id that is no address of its board's grid is fine: ${what} ${e?.message ?? ''}`);
  }

  section('(1) cleanBox: host-only and unknown fields are dropped');
  const dirty = { ...boxOf({ a: { kind: 'token', name: 'A', faces: [{ label: 'x', html: '<b>' }], evil: 1 } }, { seats: [{ id: 's', name: 'S', onclick: 'x' }] }), src: 'host', by: HOST, builtin: true, extra: { a: 1 } };
  const cd = cleanBox(dirty);
  ok(!('src' in cd) && !('by' in cd) && !('builtin' in cd) && !('extra' in cd), `src, by, builtin and unknown top-level fields are dropped (${Object.keys(cd)})`);
  ok(!('evil' in cd.types.a) && !('html' in cd.types.a.faces[0]) && !('onclick' in cd.seats[0]), 'unknown fields of a type, a face and a seat are dropped');
  ok(canon(cd) === canon(cleanBox(boxOf({ a: { kind: 'token', name: 'A', faces: [{ label: 'x' }] } }, { seats: [{ id: 's', name: 'S' }] }))), 'so the cleaned box is the same as one never given them');

  section('(1) cleanBox: bad colours, labels, strings, ids and references');
  const face = (f) => boxOf({ a: { kind: 'token', name: 'A', faces: [f] } });
  for (const col of ['javascript:alert(1)', 'url(x)', '#12', '#123456789', 'red;x', 'expression(x)', 'red blue', '', 12345, null, {}]) {
    const e = boxError(face({ color: col }));
    ok(e instanceof Error && e.message.includes('color'), `face colour ${JSON.stringify(col)} throws, naming color (${e?.message ?? 'accepted'})`);
  }
  for (const [what, b, field] of [
    ['a seat colour', boxOf(T1, { seats: [{ id: 's', name: 'S', color: 'url(x)' }] }), 'color'],
    ['a felt', boxOf(T1, { table: { shape: 'rect', w: 1000, h: 800, felt: 'x;y' } }), 'felt'],
    ['grid colours', boardBox({ grid: { ...sq(), colors: ['#fff', 'nope!'] } }), 'colors'],
    ['a space colour', boardBox({ spaces: [{ id: 'sp', x: 0, y: 0, r: 10, color: '#gg' }] }), 'color'],
    ['a zone colour', boardBox({ zones: [{ id: 'z', poly: tri, color: '1px' }] }), 'color'],
    ['a back face colour', boxOf(T1, { backs: { b: { face: { color: 'url(x)' } } } }), 'color'],
    ['a label that is not a string', face({ label: { x: 1 } }), 'label'],
    ['a label of 9 code points', face({ label: '123456789' }), 'label'],
    ['pips that are not numbers', face({ pips: 'x' }), 'pips'],
    ['a type id "__proto__"', boxOf(JSON.parse('{"__proto__": {"kind": "token", "name": "P", "faces": ["x"]}}')), 'types'],
    ['a type id with a space', boxOf({ 'a b': T1.a }), 'types'],
    ['a type id of 33 characters', boxOf({ ['t'.repeat(33)]: T1.a }), 'types'],
    ['a back id of 25 characters', boxOf(T1, { backs: { ['b'.repeat(25)]: { face: {} } } }), 'backs'],
    ['two seats with one id', boxOf(T1, { seats: [{ id: 's', name: 'A' }, { id: 's', name: 'B' }] }), 'id'],
    ['a seat with two placements', boxOf(T1, { seats: [{ id: 's', name: 'A', edge: 'top', angle: 3 }] }), 'seats[0]'],
    ['an empty box name', { ...boxOf(T1), name: '' }, 'name'],
    ['a box name of control characters only', { ...boxOf(T1), name: '\u0000\u001b' }, 'name'],
    ['an image id that is no asset id', boxOf(T1, { imgs: ['data:image/png;base64,AAAA'] }), 'imgs'],
    ['a face image index on a null image', boxOf({ a: { kind: 'token', name: 'A', faces: [{ img: 0 }] } }, { imgs: [null, H64] }), 'img'],
    ['a face image index past the images', boxOf({ a: { kind: 'token', name: 'A', faces: [{ img: 2 }] } }, { imgs: [null, H64] }), 'img'],
    ['a face image index as a string', boxOf({ a: { kind: 'token', name: 'A', faces: [{ img: '1' }] } }, { imgs: [null, H64] }), 'img'],
    ['a round table 1500 across', boxOf(T1, { table: { shape: 'round', w: 1500, h: 1500 } }), 'table'],
    ['a table of no shape', boxOf(T1, { table: { shape: 'oval', w: 1500, h: 1500 } }), 'shape'],
    ['lockable "everyone"', boxOf(T1, { lockable: 'everyone' }), 'lockable'],
  ]) {
    const e = boxError(b);
    ok(e instanceof Error && e.message.includes(field), `${what} throws, naming ${field} (${e?.message ?? 'accepted'})`);
  }
  const strip = cleanBox(boxOf({ a: { kind: 'token', name: 'A\u0000B', faces: [{ label: 'a\u0000b\u001b', text: 'one\ntwo\u0007' }] } }));
  ok(strip.types.a.faces[0].label === 'ab' && strip.types.a.faces[0].text === 'one\ntwo' && strip.types.a.name === 'AB', `control characters are stripped (CTRL; text keeps its newline): ${JSON.stringify(strip.types.a)}`);
  const img = cleanBox(boxOf({ a: { kind: 'token', name: 'A', faces: [{ img: 1 }] } }, { imgs: [null, H64] }));
  ok(img.types.a.faces[0].img === 1 && isDeepStrictEqual(img.imgs, [null, H64]), 'a face image indexing a non-null image is kept');

  section('(1) cleanBox: setup references and grammar');
  for (const [what, setup, field, seats] of [
    ['a piece of no type', [{ piece: 'nope', at: [0, 0] }], 'piece'],
    ['a face out of range', [{ piece: 'a', at: [0, 0], f: 1 }], 'f'],
    ['up: false on a type without a back', [{ piece: 'a', at: [0, 0], up: false }], 'up'],
    ['n on a type that does not stack by count', [{ piece: 'b', at: [0, 0], n: 3 }], 'n'],
    ['owner "seat" outside forEachSeat', [{ piece: 'a', at: [0, 0], owner: 'seat' }], 'owner'],
    ['owner "seat:ghost" (no such seat)', [{ piece: 'a', at: [0, 0], owner: 'seat:ghost' }], 'owner', [{ id: 'n', name: 'N' }]],
    ['at "seat" outside forEachSeat', [{ piece: 'a', at: 'seat' }], 'at'],
    ['at {seat} outside forEachSeat', [{ piece: 'a', at: { seat: [0, 10] } }], 'at'],
    ['an entry with two kinds', [{ piece: 'a', supply: 'a', at: [0, 0] }], 'setup[0]'],
    ['an entry with no kind', [{ at: [0, 0] }], 'setup[0]'],
    ['a forEachSeat inside a forEachSeat', [{ forEachSeat: [{ forEachSeat: [] }] }], 'forEachSeat'],
    ['a bag member of no type', [{ bag: ['a', 'zz'], at: [0, 0] }], 'bag'],
    ['an at of three numbers', [{ piece: 'a', at: [0, 0, 0] }], 'at'],
  ]) {
    const e = boxError(boxOf({ a: T1.a, b: { kind: 'tile', name: 'B', faces: ['x'] } }, { setup, ...(seats && { seats }) }));
    ok(e instanceof Error && e.message.includes(field), `setup: ${what} throws, naming ${field} (${e?.message ?? 'accepted'})`);
  }
  const rich = quietly(() => cleanBox(RICH)).value, problems = boxProblems(rich);
  ok(!problems.length, `the rich test box (every field of §2a) cleans into a valid box ${problems.join('; ')}`);
  ok(canon(cleanBox(rich)) === canon(rich), 'cleanBox is idempotent on it');
  // The fuzz's oracle must see what it is there to see: faults planted in a cleaned box.
  const plant = (f) => { const x = json(rich); f(x); return boxProblems(x).length > 0; };
  const caught = [
    ['an unknown field', (x) => { x.src = 'host'; }], ['a 9-code-point label', (x) => { x.types.tok.faces[0].label = '123456789'; }],
    ['a back mismatch', (x) => { x.types.spy.w = 61; }], ['a non-canonical fill', (x) => { x.types.board.board.grid.fills = { E4: '#fff' }; }],
    ['an address-like space id', (x) => { x.types.board.board.spaces[0].id = 'e4'; }], ['a setup type that is missing', (x) => { x.setup[0].piece = 'nope'; }],
    ['a bad colour', (x) => { x.types.tok.faces[2].color = 'url(x)'; }], ['a control character', (x) => { x.name = 'a\u001bb'; }],
    ['a round table 1500 wide', (x) => { x.table = { shape: 'round', w: 1500, h: 1500 }; }], ['too many setup items', (x) => { x.setup.push(...range(16).map(() => ({ piece: 'tok', at: [0, 0], count: 200 }))); }],
  ].filter(([, f]) => !plant(f)).map(([w]) => w);
  ok(!caught.length, `the field-by-field oracle catches every planted fault (missed: ${caught.join(', ') || 'none'})`);

  section('(1) cleanBox: a fuzz of 2,000 random mutations of a valid box');
  const VALUES = [undefined, null, 0, -1, 1, 2, 1.5, 7, 63, 64, 65, 99, 100, 4096, 1e9, -1e9, NaN, Infinity, -Infinity, '', 'x', 'A', 'e4', 'Z9', '3,4', '-1,2', 'bar',
    'seat', 'seat:n', 'seat:ghost', 'center', 'board', 'anyone', 'token', 'tile', 'die', 'card', 'rect', 'hex', 'pointy', 'flat', 'chess', 'go', 'xy', 'axial', 'cell', 'point',
    'lines', 'pile', 'count', 'none', '#fff', '#12', 'red', 'url(javascript:alert(1))', '<img src=x onerror=alert(1)>', '\u0000\u001b[2J', 'x'.repeat(301), '♛'.repeat(9),
    '__proto__', 'constructor', 'toString', true, false, [], {}, [1, 2], [0, 0, 0], [[0, 0], [1, 1]], { a: 1 }, { seat: [1, 2] }, { t: 'tok' }, { toString: 1 }, H64];
  const r = rng(2024), proto = Object.getOwnPropertyNames(Object.prototype).join();
  let refused = 0, accepted = 0, wrongThrow = '', invalid = '', unstable = '';
  for (let k = 0; k < 2000; k++) {
    const b = json(RICH), muts = [];
    for (let m = 1 + (r() < 0.3); m > 0; m--) {
      const all = slots(b), [obj, key] = r.pick(all), op = r();
      if (op < 0.6) { const v = json([r.pick(VALUES)])[0] ?? r.pick([undefined, null]); obj[key] = v; muts.push(`${key}=${JSON.stringify(v)?.slice(0, 20)}`); }
      else if (op < 0.75) { if (Array.isArray(obj)) obj.splice(+key, 1); else delete obj[key]; muts.push(`-${key}`); }
      else {
        const into = obj[key] && typeof obj[key] === 'object' ? obj[key] : obj;
        if (Array.isArray(into)) { into.push(into.length && r() < 0.6 ? json(r.pick(into)) : json([r.pick(VALUES)])[0]); muts.push(`${key}+[]`); }
        else { const extra = JSON.parse(`{${JSON.stringify(r.pick(['__proto__', 'src', 'by', 'builtin', 'zz', 'x9', 'constructor']))}: ${JSON.stringify(json([r.pick(VALUES)])[0] ?? null)}}`); for (const q of Object.keys(extra)) Object.defineProperty(into, q, { value: extra[q], enumerable: true, writable: true, configurable: true }); muts.push(`${key}+{}`); }
      }
    }
    const got = quietly(() => { try { return { box: cleanBox(b) }; } catch (e) { return { e }; } }).value;
    if (got.e) {
      refused++;
      if (!wrongThrow && !(got.e?.constructor === Error && typeof got.e.message === 'string' && got.e.message)) wrongThrow = `mutation ${k} (${muts.join(', ')}) threw ${got.e?.constructor?.name}: ${got.e?.message ?? got.e}`;
      continue;
    }
    accepted++;
    const p = boxProblems(got.box);
    if (!invalid && p.length) invalid = `mutation ${k} (${muts.join(', ')}): ${p.join('; ')}`;
    if (!unstable) { const again = quietly(() => { try { return canon(cleanBox(got.box)); } catch (e) { return `threw ${e.message}`; } }).value; if (again !== canon(got.box)) unstable = `mutation ${k} (${muts.join(', ')}): ${again.slice(0, 120)}`; }
  }
  console.log(`    2,000 mutations: ${accepted} accepted, ${refused} refused`);
  ok(!wrongThrow, `every refusal is a plain Error with a message — never a TypeError, RangeError or a non-Error ${wrongThrow}`);
  ok(!invalid, `every accepted box is valid field by field (§2a, the caps of §2j) ${invalid}`);
  ok(!unstable, `cleaning an accepted box again changes nothing ${unstable}`);
  ok(accepted > 200 && refused > 200, `the fuzz exercises both outcomes (${accepted} accepted, ${refused} refused)`);
  ok(Object.getOwnPropertyNames(Object.prototype).join() === proto && ({}).zz === undefined && ({}).src === undefined, 'no prototype pollution after the fuzz');

  section('(1) canon, boxKey and isBuiltin');
  const reversed = (v) => (Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reversed(v[k])])) : v);
  const a = cleanBox(RICH), b = cleanBox(reversed(json(RICH)));
  ok(canon(a) === canon(b) && boxKey(a) === boxKey(b), 'key order does not matter: the same box with every object\'s keys reversed has the same canon and boxKey');
  ok(canon(a) === sortedJSON(a) && isDeepStrictEqual(JSON.parse(canon(a)), json(a)), 'canon is the cleaned box as JSON with sorted keys');
  const k = boxKey(a), k2 = boxKey(cleanBox({ ...RICH, name: 'Rich box 2' }));
  ok(Number.isSafeInteger(k) && k >= 0 && k < 2 ** 53 && k !== k2, `boxKey is a 53-bit hash (${k}), and another box has another (${k2})`);
  for (const [name, box] of Object.entries(BOXES)) {
    ok(isBuiltin(json(box)) && isBuiltin(cleanBox(json(box))), `isBuiltin(BOXES.${name}) is true, raw or cleaned`);
    ok(isBuiltin({ ...json(box), src: 'upload', by: BOB, builtin: false }), `BOXES.${name} with src/by/builtin fields is still built in (by content alone)`);
    const clean = cleanBox(json(box)), paths = leaves(clean);
    let still = '', tried = 0;
    for (const p of paths) {
      const v = getAt(clean, p), m = json(clean);
      let nv;
      if (typeof v === 'number') nv = v + 1;
      else if (typeof v === 'boolean') nv = !v;
      else if (typeof v === 'string') nv = /^#[0-9a-f]{6}$/i.test(v) ? v.slice(0, 6) + (v[6] === '0' ? '1' : '0') : cps(v) < 8 ? `${v}x` : v.slice(0, -1) + 'x';
      else continue;
      setAt(m, p, nv);
      tried++;
      if (!still && quietly(() => isBuiltin(m)).value) still = `${p.join('.')}: ${JSON.stringify(v)} → ${JSON.stringify(nv)}`;
    }
    ok(!still && tried > 20, `BOXES.${name}: any one-field change makes it not built in (${tried} leaves changed one at a time) ${still}`);
  }
  ok(!isBuiltin(RICH) && !quietly(() => isBuiltin({ name: 'x' })).value, 'another box, or no box at all, is not built in');
}

// =============================================================================
// (2) Actions
// =============================================================================
const BX = 'b0000001', LBX = 'b0000002', DK = 'd0000001';
/** The test box: one type for each behaviour §2c distinguishes. */
const TESTBOX = {
  name: 'Test box', imgs: [],
  backs: { hb: { face: { color: '#334455', label: '?' } }, tb: { face: { color: '#223344' } }, db: { face: { color: '#111111' } } },
  types: {
    tok: { kind: 'token', name: 'Gem', faces: ['A', 'B', 'C'], meta: { points: 3 } }, // 3 faces: turned; stacks by count
    coin: { kind: 'token', name: 'Coin', faces: ['H', 'T'] },                 // 2 faces: flipped
    chip: { kind: 'token', name: 'Chip', faces: [{ color: '#cc0000' }] },     // one face, no label: its name is the type's
    pawn: { kind: 'token', name: 'Pawn', shape: 'pawn', hand: true, faces: [{ color: '#00aa00' }] }, // a token for hands
    spy: { kind: 'token', name: 'Spy', back: 'hb', faces: ['S1', 'S2'] },     // hidden-able
    mole: { kind: 'token', name: 'Mole', back: 'hb', faces: ['M1', 'M2', 'M3'] }, // another type on that back
    tile: { kind: 'tile', name: 'Tile', back: 'tb', faces: ['T1', 'T2'] },
    tile2: { kind: 'tile', name: 'Tile two', back: 'tb', faces: ['U1'] },
    open: { kind: 'tile', name: 'Open tile', faces: ['O1', 'O2'] },          // no hidden side
    heavy: { kind: 'tile', name: 'Heavy tile', hand: false, faces: ['H1'] }, // stacks as a pile, never in a hand
    big: { kind: 'tile', name: 'Big tile', w: 120, faces: ['B1'] },          // another size
    die: { kind: 'die', name: 'Die' },
    hdie: { kind: 'die', name: 'Cup die', back: 'db' },
    d8: { kind: 'die', name: 'D8', faces: [1, 2, 3, 4, 5, 6, 7, 8] },
    board: { kind: 'board', name: 'Mat', w: 400, h: 300 },
  },
};
/** A box whose pieces anyone may lock. */
const LOCKBOX = { name: 'Lockable', imgs: [], lockable: 'anyone', types: { peg: { kind: 'token', name: 'Peg', faces: ['P'] } } };
const ref = (t, box = BX) => `${box}/${t}`;
let zc = 0;
const placed = (o) => ({ x: 800, y: 800, rot: 0, z: ++zc, ...o });
/** Item makers (host shapes): a piece, a supply, a bag, a card, a pile. */
const P = (t, o = {}) => placed({ k: 'g', t: ref(t), f: 0, ...o });
const S = (t, o = {}) => placed({ k: 's', t: ref(t), f: 0, ...o });
const BAG = (of, o = {}) => placed({ k: 'b', of: of.map((m) => (typeof m === 'string' ? { t: ref(m), f: 0 } : { f: 0, ...m, t: ref(m.t) })), name: 'Sack', ...o });
const C = (i, o = {}) => placed({ k: 'c', d: DK, i, up: true, ...o });
const PILE = (cards, o = {}) => placed({ k: 'p', name: 'Pile', cards, ...o });
const cardsOf = (n, up = false) => range(n).map((i) => ({ d: DK, i, up }));
const piecesOf = (t, n, up = true, f = 0) => range(n).map(() => ({ t: ref(t), f, up }));
const player = (name, seat, o = {}) => ({ name, color: '#30bced', online: true, hand: [], seat, ...o });
const NAMES = { [HOST]: 'Alice', [BOB]: 'Bob', [CAROL]: 'Carol', [DAVE]: 'Dave' };

/** A host table (state v3) holding `items`, the test boxes and a standard
 *  deck, with Alice (the host, at the bottom), Bob (top) and Carol (right)
 *  seated and online. o: {hands: {pid: entries}, table, seats, players, env, boxes}. */
function mk(items = {}, o = {}) {
  const s = {
    v: 3, seq: 1, table: o.table || { shape: 'round', w: 1800, h: 1800 }, seats: o.seats || null, boardSeq: 0, zMax: 0,
    items: json(items), keys: {}, log: [], rules: null, guestDeckChars: 0,
    players: o.players || { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270), [CAROL]: player('Carol', 0) },
    decks: { [DK]: core.standardDeck(false) }, boxes: o.boxes || { [BX]: cleanBox(TESTBOX), [LBX]: cleanBox(LOCKBOX) }, boxSrc: {},
  };
  for (const [p, hand] of Object.entries(o.hands || {})) s.players[p].hand = json(hand);
  const T = quietly(() => createTable(s, o.env || renv(o.seed ?? 7))).value;
  T.drain();
  T.takeDirty();
  return T;
}
/** What a table holds that an action can change: items, hands, seats, the table. */
const sig = (T) => JSON.stringify([T.state.items, Object.entries(T.state.players).map(([p, x]) => [p, x.hand, x.seat ?? null, x.seatId ?? null, x.online]), T.state.table, T.state.seats]);
/** Applies action `a` as player p (or runs `a(t)` with the facade, p = 'RULES'): what came of it. */
function run(T, p, a) {
  T.drain();
  const before = sig(T), last = T.state.log.at(-1), seq0 = T.state.seq;
  const q = quietly(() => (p === 'RULES' ? a(T.api) : T.apply(p, a)));
  const fx = T.drain(), added = T.state.log.slice(T.state.log.lastIndexOf(last) + 1); // (the log is trimmed, so count from the last old entry)
  return {
    ret: q.value, fx, notes: fx.filter((e) => e.t === 'note').map((e) => e.msg), noteFx: fx.filter((e) => e.t === 'note'),
    changed: sig(T) !== before, log: added.map((e) => e.txt), logEntries: added, warn: q.warn, error: q.error, seq: T.state.seq - seq0,
  };
}
/** Refused: nothing changed, nothing logged, and (when `msg` is given) exactly that one notice to the actor. */
const refusedBy = (r, msg) => !r.changed && !r.log.length && (msg === undefined || (r.notes.length === 1 && r.notes[0] === msg));
/** It happened: logged, and no notice. */
const happened = (r) => r.log.length > 0 && !r.notes.length;
const why = (r) => `notes ${JSON.stringify(r.notes)}, log ${JSON.stringify(r.log)}, changed ${r.changed}${r.warn.length ? `, warn ${JSON.stringify(r.warn.slice(0, 2))}` : ''}`;
const items = (T) => T.state.items;
const newIds = (T, before) => Object.keys(items(T)).filter((id) => !before.includes(id));
const BELONGS = (name) => `🚫 That belongs to ${name}`, LOCKED = '🔒 That is locked in place', HIDDEN = '🚫 That piece is hidden', FULL = '🚫 The table is full (5,000 items)';

function testCheckTable() {
  section('(2) the shared checks, row by row (§2c): mayHandle on every item an action reads or changes — the host not exempt — and notLocked where listed');
  const hands = { [BOB]: [{ d: DK, i: 10 }], [HOST]: [{ d: DK, i: 10 }], [CAROL]: [{ d: DK, i: 10 }] };
  /** [action, items, payload, mayHandle ids, notLocked ids, ids a lock does not block] */
  const ROWS = [
    ['move', { a: P('tok') }, { t: 'move', id: 'a', x: 500, y: 500 }, ['a'], ['a'], []],
    ['rot', { a: P('tok') }, { t: 'rot', id: 'a', rot: 90 }, ['a'], ['a'], []],
    ['flip', { a: P('tok') }, { t: 'flip', id: 'a' }, ['a'], ['a'], []],
    ['face', { a: P('tok') }, { t: 'face', id: 'a', f: 2 }, ['a'], ['a'], []],
    ['del', { a: P('tok') }, { t: 'del', id: 'a' }, ['a'], ['a'], []],
    ['toHand', { a: P('pawn') }, { t: 'toHand', id: 'a' }, ['a'], ['a'], []],
    ['split', { a: P('tok', { n: 3 }) }, { t: 'split', id: 'a', n: 1, x: 400, y: 400 }, ['a'], ['a'], []],
    ['split {onto}', { a: P('tok', { n: 3 }), b: P('tok', { n: 2, x: 870 }) }, { t: 'split', id: 'a', n: 1, onto: 'b' }, [], ['a'], ['b']],
    ['join (back to a supply)', { a: P('chip'), s: S('chip', { x: 900 }) }, { t: 'join', id: 'a', onto: 's' }, ['a', 's'], ['a'], ['s']],
    ['join (×N stacks)', { a: P('tok'), b: P('tok', { n: 3, x: 870 }) }, { t: 'join', id: 'a', onto: 'b' }, [], ['a'], ['b']],
    ['stack', { a: P('tile'), b: P('tile', { x: 920 }) }, { t: 'stack', id: 'a', onto: 'b' }, ['a', 'b'], ['a'], ['b']],
    ['toPile', { a: P('tile'), p: PILE(piecesOf('tile', 2), { x: 920 }) }, { t: 'toPile', id: 'a', pile: 'p' }, ['a', 'p'], ['a'], ['p']],
    ['merge', { p: PILE(piecesOf('tile', 2)), q: PILE(piecesOf('tile', 3), { x: 920 }) }, { t: 'merge', id: 'p', pile: 'q' }, ['p', 'q'], ['p'], ['q']],
    ['toBag', { a: P('tok'), g: BAG(['tok'], { x: 920 }) }, { t: 'toBag', id: 'a', bag: 'g' }, ['a', 'g'], ['a'], ['g']],
    ['draw', { p: PILE(cardsOf(3)) }, { t: 'draw', id: 'p' }, ['p'], [], ['p']],
    ['deal', { p: PILE(cardsOf(3)) }, { t: 'deal', id: 'p', x: 400, y: 400, up: true }, ['p'], [], ['p']],
    ['shuffle', { p: PILE(cardsOf(20)) }, { t: 'shuffle', id: 'p' }, ['p'], [], ['p']],
    ['peek', { p: PILE(cardsOf(3)) }, { t: 'peek', id: 'p' }, ['p'], [], ['p']],
    ['handPile', { p: PILE(cardsOf(3)) }, { t: 'handPile', idx: 0, d: DK, i: 10, pile: 'p' }, ['p'], [], ['p']],
    ['take', { s: S('chip') }, { t: 'take', id: 's', x: 400, y: 400 }, ['s'], [], ['s']],
    ['pull', { g: BAG(['tok', 'coin']) }, { t: 'pull', id: 'g', x: 400, y: 400 }, ['g'], [], ['g']],
    ['roll', { d: P('die'), e: P('die', { x: 870 }) }, { t: 'roll', ids: ['d', 'e'] }, ['d', 'e'], [], ['d', 'e']],
  ];
  const withIt = (its, id, o) => ({ ...json(its), [id]: { ...its[id], ...o } });
  for (const [name, its, a, handle, lock, free] of ROWS) {
    const base = run(mk(its, { hands }), BOB, a);
    ok(happened(base), `${name}: Bob may do it on what nobody owns or locks — ${why(base)}`);
    for (const id of handle) {
      const r1 = run(mk(withIt(its, id, { owner: HOST }), { hands }), BOB, a);
      ok(refusedBy(r1, BELONGS('Alice')), `${name}: Bob is refused when Alice owns ${id} ("${BELONGS('Alice')}") — ${why(r1)}`);
      const r2 = run(mk(withIt(its, id, { owner: BOB }), { hands }), HOST, a);
      ok(refusedBy(r2, BELONGS('Bob')), `${name}: the host is refused too when Bob owns ${id} (the host is not exempt) — ${why(r2)}`);
      const r3 = run(mk(withIt(its, id, { owner: BOB }), { hands }), BOB, a);
      ok(happened(r3), `${name}: Bob may when he owns ${id} — ${why(r3)}`);
    }
    for (const id of lock) {
      const r1 = run(mk(withIt(its, id, { lock: true }), { hands }), BOB, a), r2 = run(mk(withIt(its, id, { lock: true }), { hands }), HOST, a);
      ok(refusedBy(r1, LOCKED) && refusedBy(r2, LOCKED), `${name}: refused for Bob and for the host while ${id} is locked ("${LOCKED}") — ${why(r1)} / ${why(r2)}`);
      if (name !== 'move') continue;
      const r3 = run(mk(withIt(its, id, { lock: true, owner: HOST })), 'RULES', (t) => t.move(id, 300, 300));
      ok(r3.ret === true && r3.changed, 'move: a script op (t.move) skips the owner and lock checks');
    }
    for (const id of free) {
      const r = run(mk(withIt(its, id, { lock: true }), { hands }), BOB, a);
      ok(happened(r), `${name}: a lock on ${id} does not block it — ${why(r)}`);
    }
  }
  // Rows whose two items must share an owner (join (a), split {onto}): both owned.
  for (const [name, its, a] of [['join (×N stacks)', { a: P('tok', { owner: HOST }), b: P('tok', { n: 3, x: 870, owner: HOST }) }, { t: 'join', id: 'a', onto: 'b' }],
    ['split {onto}', { a: P('tok', { n: 3, owner: HOST }), b: P('tok', { n: 2, x: 870, owner: HOST }) }, { t: 'split', id: 'a', n: 1, onto: 'b' }]]) {
    const r1 = run(mk(its), BOB, a), r2 = run(mk(its), HOST, a);
    ok(refusedBy(r1, BELONGS('Alice')) && happened(r2), `${name}: of two stacks Alice owns, Bob is refused and Alice may — ${why(r1)} / ${why(r2)}`);
  }

  section('(2) a refusal re-sends what the action named (the refusal touch) and runs no hook');
  const T = mk({ a: P('tok', { owner: HOST }), d: P('die', { lock: true, owner: HOST }), b: P('tok', { lock: true }) });
  run(T, HOST, { t: 'setRules', enabled: true, code: "({ name: 'Count', setup(t) { t.data.n = 0; }, onAction(t) { t.data.n++; } })" });
  T.takeDirty();
  for (const a of [{ t: 'move', id: 'a', x: 300, y: 300 }, { t: 'roll', ids: ['d'] }, { t: 'rot', id: 'b', rot: 90 }]) {
    const r = run(T, BOB, a), c = T.patchContent(T.takeDirty()), id = a.id || a.ids[0];
    ok(r.notes.length === 1 && !r.log.length && c.items && isDeepStrictEqual(c.items[id], T.pub.get(id)), `a refused ${a.t} re-sends ${id} unchanged in the next patch (${JSON.stringify(Object.keys(c.items || {}))})`);
  }
  ok(T.api.data.n === 0, `no onAction ran for them (${T.api.data.n})`);
  run(T, HOST, { t: 'move', id: 'a', x: 300, y: 300 });
  ok(T.api.data.n === 1, 'one that happens runs it');
}

/** Every die an action's fx announce as rolled: per-die markers ({id, roll: 1}) or one listing them ({roll: [ids]}). */
const rolledIn = (r) => new Set(r.fx.filter((e) => e.t === 'fx' && e.f.roll).flatMap((e) => (Array.isArray(e.f.roll) ? e.f.roll : [e.f.id])));

function testNewActions() {
  section('(2) roll: 1 to 20 different dice, the crypto RNG, no forged result');
  {
    const dice = Object.fromEntries(range(21).map((k) => [`d${String(k).padStart(2, '0')}`, P('die', { x: 300 + 60 * (k % 10), y: 400 + 60 * Math.floor(k / 10) })]));
    const ids = Object.keys(dice), T = mk({ ...dice, tk: P('tok'), d8: P('d8', { x: 1200 }) });
    for (const [what, a] of [['no dice', { t: 'roll', ids: [] }], ['21 dice', { t: 'roll', ids }], ['one die twice', { t: 'roll', ids: ['d00', 'd00'] }], ['ids that are no list', { t: 'roll', ids: 'd00' }], ['no ids', { t: 'roll' }],
      ['50 copies of one die (attacker case 3)', { t: 'roll', f: 6, ids: range(50).map(() => 'd00') }]]) {
      const r = run(T, BOB, a);
      ok(refusedBy(r) && r.notes.length === 1, `roll of ${what} is refused with a notice — ${why(r)}`);
    }
    const r20 = run(T, BOB, { t: 'roll', ids: ids.slice(0, 20) }), faces = ids.slice(0, 20).map((id) => items(T)[id].f);
    ok(happened(r20) && r20.log.length === 1 && faces.every((f) => Number.isInteger(f) && f >= 0 && f < 6), `20 dice roll at once: one log line, every face in 0–5 (${faces.join(',')})`);
    ok(ids.slice(0, 20).every((id) => rolledIn(r20).has(id)) && r20.fx.filter((e) => e.t === 'fx').every((e) => e.f.p === BOB), 'every rolled die is announced (fx roll) for the tumble, as Bob');
    const f0 = items(T).d00.f, mixed = run(T, BOB, { t: 'roll', ids: ['d00', 'tk'] });
    ok(refusedBy(mixed) && items(T).d00.f === f0, `a token among the dice: the roll is refused whole, no die changes — ${why(mixed)}`);
    ok(refusedBy(run(T, BOB, { t: 'roll', ids: ['tk'] })), 'a token alone: refused (only dice roll)');
    ok(refusedBy(run(T, BOB, { t: 'roll', ids: ['nope'] })), 'an id that is no item: nothing happens');
    const seen = range(6).map(() => 0);
    let bad = 0;
    for (let k = 0; k < 300; k++) {
      run(T, BOB, { t: 'roll', ids: ['d01'], f: 5 });
      const f = items(T).d01.f;
      if (Number.isInteger(f) && f >= 0 && f < 6) seen[f]++; else bad++;
    }
    ok(!bad && seen.every((c) => c >= 20), `a forged f: 5 is ignored — 300 rolls of one die spread over every face (${seen.join(' ')})`);
    const rl = run(T, BOB, { t: 'roll', ids: ['d03', 'd02'] }), want = `rolled ${items(T).d02.f + 1} · ${items(T).d03.f + 1}`;
    ok(rl.log.length === 1 && rl.log[0] === want && rl.logEntries[0].p === BOB, `the log names the faces in id order, joined with " · ": "${rl.log[0]}" (want "${want}")`);
    const d8 = new Set();
    let mislabelled = '';
    for (let k = 0; k < 120; k++) {
      const r = run(T, k % 2 ? BOB : CAROL, { t: 'roll', ids: ['d8'] }), f = items(T).d8.f; // (two actors: the log folds a repeated line)
      d8.add(f);
      if (!mislabelled && r.log[0] !== `rolled ${f + 1}`) mislabelled = `face ${f} logged ${JSON.stringify(r.log)}`;
    }
    ok(d8.size === 8 && !mislabelled, `a d8 (1–6 as pips, 7 and 8 as labels): every face comes up, logged by its label (faces ${[...d8].sort()}) ${mislabelled}`);
    ok(RULED_ACTIONS.has('roll') && PUBLIC_ACTIONS.has('roll'), 'roll is a ruled action guests may send');
  }

  section('(2) face: a piece or supply, not a die; f in range');
  {
    const its = { a: P('tok'), s: S('tok', { x: 900 }), d: P('die', { x: 1000 }), g: BAG(['tok']), c: C(0), p: PILE(cardsOf(2)) };
    const T = mk(its), r = run(T, BOB, { t: 'face', id: 'a', f: 2 });
    ok(happened(r) && items(T).a.f === 2 && r.log[0] === 'turned A to C', `face sets f, logged "turned {label} to {face label}": ${JSON.stringify(r.log)}`);
    for (const f of [-1, 3, 1.5, '1', undefined, null, NaN, 1e9]) ok(refusedBy(run(T, BOB, { t: 'face', id: 'a', f })) && items(T).a.f === 2, `face f = ${String(f)} is refused`);
    ok(refusedBy(run(T, BOB, { t: 'face', id: 'd', f: 5 })), 'face on a die is refused (dice are rolled: no forged result)');
    for (const id of ['g', 'c', 'p']) ok(refusedBy(run(T, BOB, { t: 'face', id, f: 0 })), `face on a ${{ g: 'bag', c: 'card', p: 'pile' }[id]} is refused`);
    const rs = run(T, BOB, { t: 'face', id: 's', f: 1 }), n0 = Object.keys(items(T));
    run(T, BOB, { t: 'take', id: 's', x: 300, y: 300 });
    const took = newIds(T, n0).map((id) => items(T)[id]);
    ok(happened(rs) && items(T).s.f === 1 && took.length === 1 && took[0].f === 1, 'face on a supply changes what it hands out (a take then gives face 1)');
  }

  section('(2) split: n ≥ 2, 1 ≤ k < n; a new stack, or onto another — atomically');
  {
    const T = mk({ a: P('tok', { n: 5, f: 1, owner: BOB, rot: 0 }) }), z0 = T.state.zMax, n0 = Object.keys(items(T));
    const r = run(T, BOB, { t: 'split', id: 'a', n: 2, x: 400, y: 410 }), [nid] = newIds(T, n0), nu = items(T)[nid];
    ok(happened(r) && items(T).a.n === 3 && nu && nu.k === 'g' && nu.t === ref('tok') && nu.f === 1 && nu.n === 2 && nu.owner === BOB && nu.up === undefined,
      `split 2 off ×5: 3 stay, a new ×2 of the same t, f and owner (${JSON.stringify(nu)})`);
    ok(nu && nu.x === 400 && nu.y === 410 && nu.z > z0, 'it lands at (x, y), on top (zTop)');
    ok(r.log[0] === 'took 2 from B ×5', `logged "took {k} from {label}": ${JSON.stringify(r.log)}`);
    const r1 = run(T, BOB, { t: 'split', id: 'a', x: 300, y: 300 }), last = items(T)[newIds(T, [...n0, nid])[0]];
    ok(happened(r1) && items(T).a.n === 2 && last && !('n' in last), 'n defaults to 1: one piece comes off, with no n (omitted when 1)');
    run(T, BOB, { t: 'split', id: 'a', n: 1, x: 300, y: 300 });
    ok(!('n' in items(T).a), 'a stack split down to one piece drops its n');
    const U = mk({ a: P('tok', { n: 5 }), s: S('tok', { x: 900 }), one: P('tok', { x: 1000 }) });
    for (const n of [-3, 0, 5, 6, 1e9, 1.5, '2', true]) ok(refusedBy(run(U, BOB, { t: 'split', id: 'a', n })) && items(U).a.n === 5, `split n = ${String(n)} is refused (1 ≤ k < 5)`);
    ok(refusedBy(run(U, BOB, { t: 'split', id: 'one', n: 1 })), 'a single piece (no n) is no stack to split');
    ok(refusedBy(run(U, BOB, { t: 'split', id: 's', n: 1 })), 'a supply is no stack to split');
    const H = mk({ h: P('spy', { n: 3, up: false }) }), h0 = Object.keys(items(H)), rh = run(H, BOB, { t: 'split', id: 'h', n: 1, x: 300, y: 300 });
    const hn = items(H)[newIds(H, h0)[0]];
    ok(happened(rh) && hn?.up === false && items(H).h.n === 2 && rh.log[0] === 'took 1 from a hidden piece ×3', `a hidden stack splits face down, logged without its type: ${JSON.stringify(rh.log)}`);
    // onto
    const O = mk({ a: P('tok', { n: 5 }), b: P('tok', { n: 3, x: 900 }) }), o0 = Object.keys(items(O));
    const ro = run(O, BOB, { t: 'split', id: 'a', n: 2, onto: 'b' });
    ok(happened(ro) && items(O).a.n === 3 && items(O).b.n === 5 && !newIds(O, o0).length && ro.log[0] === 'moved 2 from A ×5 onto A ×3',
      `split {onto}: k move to the other stack, no new item; "moved {k} from {label} onto {label}": ${JSON.stringify(ro.log)}`);
    for (const [what, b] of [['of another face', P('tok', { n: 3, f: 1 })], ['of another owner', P('tok', { n: 3, owner: CAROL })], ['of another type', P('coin', { n: 3 })],
      ['that would pass 999', P('tok', { n: 998 })], ['a supply of the type', S('tok')], ['face down', P('spy', { up: false, n: 2 })]]) {
      const A = mk({ a: P('tok', { n: 5 }), b: { ...b, x: 900 } }), before = sig(A);
      const rr = run(A, BOB, { t: 'split', id: 'a', n: 2, onto: 'b' });
      ok(refusedBy(rr) && sig(A) === before, `split {onto} a stack ${what} is refused as a whole: the source keeps its 5, nothing is created — ${why(rr)}`);
    }
    ok(refusedBy(run(O, BOB, { t: 'split', id: 'a', n: 1, onto: 'nope' })) && items(O).a.n === 3, 'split {onto} a missing item changes nothing');
  }

  section('(2) join: (a) two ×N stacks of one t, f, up and owner, ≤ 999; (b) back to a supply of its t');
  {
    const T = mk({ a: P('tok'), b: P('tok', { n: 3, x: 900 }) }), r = run(T, BOB, { t: 'join', id: 'a', onto: 'b' });
    ok(happened(r) && !items(T).a && items(T).b.n === 4 && r.log[0] === 'stacked A (×4)', `join (a): onto.n += 1, the piece is gone; "stacked {label} (×N)": ${JSON.stringify(r.log)}`);
    const U = mk({ a: P('tok', { n: 2 }), b: P('tok', { n: 3, x: 900 }) });
    ok(happened(run(U, BOB, { t: 'join', id: 'a', onto: 'b' })) && items(U).b.n === 5 && !items(U).a, 'a ×2 joins a ×3: ×5');
    for (const [what, a, b] of [['across types', P('tok'), P('coin', { n: 2 })], ['across faces', P('tok', { f: 1 }), P('tok', { n: 2 })], ['across owners', P('tok', { owner: BOB }), P('tok', { n: 2 })],
      ['past 999', P('tok', { n: 2 }), P('tok', { n: 998 })], ['of tiles (they pile, not count)', P('tile'), P('tile')], ['of dice (stack none)', P('die'), P('die')],
      ['onto a card', P('tok'), C(1)], ['onto a supply of another type', P('tok'), S('coin')]]) {
      const A = mk({ a, b: { ...b, x: 900 } }), rr = run(A, BOB, { t: 'join', id: 'a', onto: 'b' });
      ok(refusedBy(rr), `join ${what} is refused — ${why(rr)}`);
    }
    ok(refusedBy(run(mk({ a: P('tok', { n: 2 }) }), BOB, { t: 'join', id: 'a', onto: 'a' })), 'a stack does not join itself');
    const B = mk({ a: P('chip'), s: S('chip', { x: 900 }), b: P('chip', { n: 3, x: 1000 }), c: P('tok', { f: 2 }), ts: S('tok', { x: 1100 }) });
    const rb = run(B, BOB, { t: 'join', id: 'a', onto: 's' });
    ok(happened(rb) && !items(B).a && items(B).s && rb.log[0] === 'returned Chip to the Chip supply', `join (b): the piece goes back to its supply; "returned {label} to {supply label}": ${JSON.stringify(rb.log)}`);
    ok(happened(run(B, BOB, { t: 'join', id: 'b', onto: 's' })) && !items(B).b, 'a ×3 stack goes back whole');
    ok(happened(run(B, BOB, { t: 'join', id: 'c', onto: 'ts' })) && !items(B).c, 'any face of the type goes back to its supply');
  }

  section('(2) take: a new piece from a supply, to the table or the hand');
  {
    const T = mk({ s: S('chip', { owner: BOB }), h: S('spy', { up: false, x: 900 }), ph: S('pawn', { x: 1000 }), th: S('tile', { up: false, x: 1100 }), g: P('tok', { x: 600 }) });
    const n0 = Object.keys(items(T)), r = run(T, BOB, { t: 'take', id: 's', x: 500, y: 520, n: 50 }), made = newIds(T, n0).map((id) => items(T)[id]);
    ok(happened(r) && made.length === 1 && isDeepStrictEqual({ k: made[0].k, t: made[0].t, f: made[0].f, owner: made[0].owner, n: made[0].n, up: made[0].up }, { k: 'g', t: ref('chip'), f: 0, owner: BOB, n: undefined, up: undefined }),
      `take: one new piece of the supply's t and f, owned by the supply's owner (a forged n: 50 is ignored): ${JSON.stringify(made)}`);
    ok(made[0]?.x === 500 && made[0]?.y === 520 && r.log[0] === 'took Chip from the Chip supply', `at (x, y); "took {label} from {supply label}": ${JSON.stringify(r.log)}`);
    const n1 = Object.keys(items(T)), rh = run(T, BOB, { t: 'take', id: 'h', x: 400, y: 400 }), hid = newIds(T, n1).map((id) => items(T)[id]);
    ok(happened(rh) && hid[0]?.up === false && hid[0]?.t === ref('spy') && rh.log[0] === 'took a hidden piece from a supply of hidden pieces', `a hidden supply gives a hidden piece, logged without its type: ${JSON.stringify(rh.log)}`);
    const n2 = Object.keys(items(T)), rp = run(T, BOB, { t: 'take', id: 'ph', hand: true });
    ok(happened(rp) && !newIds(T, n2).length && isDeepStrictEqual(T.state.players[BOB].hand, [{ t: ref('pawn'), f: 0 }]) && rp.log[0] === 'took Pawn into hand', `take {hand}: into the hand as {t, f}; "took {label} into hand": ${JSON.stringify(rp.log)}`);
    const rt = run(T, BOB, { t: 'take', id: 'th', hand: true });
    ok(happened(rt) && isDeepStrictEqual(T.state.players[BOB].hand.at(-1), { t: ref('tile'), f: 0, up: false }) && rt.log[0] === 'took a hidden piece into hand', `a hidden one goes in as {t, f, up: false}, logged hidden: ${JSON.stringify(rt.log)}`);
    ok(refusedBy(run(T, BOB, { t: 'take', id: 's', hand: true })), 'take {hand} of a type that is not for hands is refused');
    ok(refusedBy(run(T, BOB, { t: 'take', id: 'g' })), 'take from a piece (not a supply) is refused');
    ok(RULED_ACTIONS.has('take') && PUBLIC_ACTIONS.has('take'), 'take is ruled');
  }

  section('(2) pull: a random piece out of a bag, as it was put in');
  {
    const T = mk({ g: BAG([{ t: 'tok', f: 0 }, { t: 'tok', f: 1 }, { t: 'tile', up: false }]), e: BAG([], { name: 'Empty', x: 1000 }) });
    const n0 = Object.keys(items(T)), r = run(T, BOB, { t: 'pull', id: 'g', x: 450, y: 460 }), [nid] = newIds(T, n0), nu = items(T)[nid];
    ok(happened(r) && items(T).g.of.length === 2 && nu?.k === 'g' && nu.x === 450 && nu.y === 460, `pull: one member leaves the bag and lands at (x, y) (${JSON.stringify(nu)})`);
    ok(nu && (nu.up === false ? r.log[0] === 'drew a piece from the bag Sack' : r.log[0] === `drew ${'ABC'[nu.f]} from the bag Sack`), `logged "drew {label} from {bag}" face up, "drew a piece from {bag}" face down: ${JSON.stringify(r.log)} for ${JSON.stringify(nu)}`);
    const all = [...T.state.items.g.of, { t: nu.t, f: nu.f, ...(nu.up === false && { up: false }) }].map((m) => JSON.stringify({ t: m.t, f: m.f, up: m.up ?? true }));
    ok(isDeepStrictEqual(all.sort(), [{ t: ref('tok'), f: 0, up: true }, { t: ref('tok'), f: 1, up: true }, { t: ref('tile'), f: 0, up: false }].map((m) => JSON.stringify(m)).sort()), 'the piece keeps its stored t, f and side');
    ok(refusedBy(run(T, BOB, { t: 'pull', id: 'e' })), 'an empty bag: refused');
    ok(refusedBy(run(T, BOB, { t: 'pull', id: 'g', hand: true })), 'pull {hand} from a bag not made for hands: refused');
    const seen = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      const U = mk({ g: BAG([{ t: 'tok', f: 0 }, { t: 'tok', f: 1 }, { t: 'tok', f: 2 }]) }, { seed }), u0 = Object.keys(items(U));
      run(U, BOB, { t: 'pull', id: 'g', x: 300, y: 300 });
      seen.add(items(U)[newIds(U, u0)[0]]?.f);
    }
    ok(seen.size === 3, `the member is drawn at random (over 40 tables, faces ${[...seen].sort()} came out first)`);
    const Hb = mk({ g: BAG([{ t: 'tile', up: false }], { hand: true }) }), rh = run(Hb, BOB, { t: 'pull', id: 'g', hand: true });
    ok(happened(rh) && isDeepStrictEqual(Hb.state.players[BOB].hand, [{ t: ref('tile'), f: 0, up: false }]) && Hb.state.items.g.of.length === 0 && rh.log[0] === 'drew a piece from the bag Sack',
      `pull {hand} from a hand bag: into the hand, "drew a piece from {bag}": ${JSON.stringify(rh.log)}`);
  }

  section('(2) toBag: every piece of a stack goes in; the bag cap; a hand bag stays for hands');
  {
    const T = mk({ a: P('tok', { n: 3 }), h: P('spy', { up: false, x: 900 }), g: BAG([], { x: 1000 }), c: C(1), s: S('tok', { x: 600 }) });
    const r = run(T, BOB, { t: 'toBag', id: 'a', bag: 'g' });
    ok(happened(r) && !items(T).a && isDeepStrictEqual(items(T).g.of, range(3).map(() => ({ t: ref('tok'), f: 0 }))) && r.log[0] === 'put A ×3 into the bag Sack', `a ×3 stack: three {t, f} go in, the stack goes; "put {label} into {bag}": ${JSON.stringify(r.log)}`);
    const rh = run(T, BOB, { t: 'toBag', id: 'h', bag: 'g' });
    ok(happened(rh) && isDeepStrictEqual(items(T).g.of.at(-1), { t: ref('spy'), f: 0, up: false }) && rh.log[0] === 'put a hidden piece into the bag Sack', `a hidden piece goes in face down: ${JSON.stringify(rh.log)}`);
    ok(refusedBy(run(T, BOB, { t: 'toBag', id: 'c', bag: 'g' })) && refusedBy(run(T, BOB, { t: 'toBag', id: 's', bag: 'g' })), 'a card or a supply does not go into a bag');
    const full = (n) => mk({ g: BAG(range(n).map(() => 'tok')), a: P('tok', { n: 3, x: 900 }), b: P('tok', { n: 2, x: 1000 }) });
    const F = full(998), rf = run(F, BOB, { t: 'toBag', id: 'a', bag: 'g' });
    ok(refusedBy(rf) && rf.notes.length === 1 && items(F).g.of.length === 998, `998 + a ×3 stack would pass 1,000: refused whole — ${why(rf)}`);
    ok(happened(run(F, BOB, { t: 'toBag', id: 'b', bag: 'g' })) && items(F).g.of.length === 1000, '998 + a ×2 stack makes exactly 1,000: allowed');
    const Hb = mk({ g: BAG(['tile'], { hand: true }), a: P('tok', { x: 900 }), t: P('tile', { x: 1000 }), h: P('spy', { up: false, x: 1100 }) });
    ok(refusedBy(run(Hb, BOB, { t: 'toBag', id: 'a', bag: 'g' })) && refusedBy(run(Hb, BOB, { t: 'toBag', id: 'h', bag: 'g' })), 'a bag made for hands refuses a piece that is not (shown, or hidden: its back says so)');
    ok(happened(run(Hb, BOB, { t: 'toBag', id: 't', bag: 'g' })) && items(Hb).g.hand === true && items(Hb).g.of.length === 2, 'and takes one that is; its hand flag stays');
  }

  section('(2) lock: the host; or, in a lockable: "anyone" box, whoever may handle the piece');
  {
    const its = { a: P('tok'), peg: P('peg', { x: 900 }), alp: P('peg', { x: 950, owner: HOST }), bp: P('peg', { x: 1000, owner: BOB }), c: C(1), p: PILE(cardsOf(2)),
      ps: S('peg', { x: 600 }), pb: BAG([{ t: 'peg' }], { x: 500 }) };
    for (const k of ['peg', 'alp', 'bp', 'ps', 'pb']) its[k].t &&= ref('peg', LBX);
    its.pb.of = [{ t: ref('peg', LBX), f: 0 }];
    const T = mk(its), r = run(T, HOST, { t: 'lock', id: 'a', on: true });
    ok(happened(r) && items(T).a.lock === true && r.log[0] === 'locked A', `the host locks: lock: true, "locked {label}": ${JSON.stringify(r.log)}`);
    const u = run(T, HOST, { t: 'lock', id: 'a', on: false });
    ok(happened(u) && !('lock' in items(T).a) && u.log[0] === 'unlocked A', `and unlocks: the field goes, "unlocked {label}": ${JSON.stringify(u.log)}`);
    ok(refusedBy(run(T, BOB, { t: 'lock', id: 'a', on: true })), 'Bob may not lock a piece of a box that is not lockable by anyone');
    ok(happened(run(T, BOB, { t: 'lock', id: 'peg', on: true })) && items(T).peg.lock === true, 'Bob locks a piece of a lockable: "anyone" box');
    const mine = ['bp', 'ps', 'pb'].map((id) => run(T, BOB, { t: 'lock', id, on: true })); // ("locked P" twice in a row folds into one log line)
    ok(mine.every((x) => x.changed && !x.notes.length) && ['bp', 'ps', 'pb'].every((id) => items(T)[id].lock === true), 'his own piece, a supply and a bag of that box too');
    const ra = run(T, BOB, { t: 'lock', id: 'alp', on: true });
    ok(refusedBy(ra) && !items(T).alp.lock, `but not a piece Alice owns (attacker case 14) — ${why(ra)}`);
    ok(refusedBy(run(T, BOB, { t: 'lock', id: 'c', on: true })) && refusedBy(run(T, BOB, { t: 'lock', id: 'p', on: true })), 'cards and piles: only the host');
    ok(happened(run(T, HOST, { t: 'lock', id: 'c', on: true })) && happened(run(T, HOST, { t: 'lock', id: 'bp', on: false })), 'the host locks a card, and unlocks a piece Bob owns');
    ok(RULED_ACTIONS.has('lock') && RULED_ACTIONS.has('owner') && RULED_ACTIONS.has('seat'), 'lock, owner and seat are ruled');
  }

  section('(2) owner: the host gives anything; an owner passes it on or releases it; anyone claims what is free');
  {
    const its = () => ({ a: P('tok'), l: P('tok', { lock: true, x: 850 }), b: P('board', { lock: true, x: 300 }), u: P('board', { x: 300, y: 300 }), al: P('tok', { owner: HOST, x: 900 }), mine: P('tok', { owner: BOB, x: 950 }), c: C(1) });
    const go = (p, a) => { const T = mk(its()); return [T, run(T, p, a)]; };
    let [T, r] = go(BOB, { t: 'owner', id: 'a', to: BOB });
    ok(happened(r) && items(T).a.owner === BOB && r.log[0] === 'claimed A', `Bob claims a free piece: "claimed {label}": ${JSON.stringify(r.log)}`);
    [T, r] = go(BOB, { t: 'owner', id: 'c', to: BOB });
    ok(happened(r) && items(T).c.owner === BOB, 'a card can be claimed too (owner on every kind)');
    for (const [what, a] of [['a locked piece', { id: 'l', to: BOB }], ['a locked board', { id: 'b', to: BOB }], ['an unlocked board', { id: 'u', to: BOB }], ["Alice's piece", { id: 'al', to: BOB }],
      ['a free piece for Carol', { id: 'a', to: CAROL }], ['his own piece for a seat', { id: 'mine', to: 'seat:x' }], ['his piece for nobody that exists', { id: 'mine', to: 'f'.repeat(16) }],
      ['his piece for "__proto__"', { id: 'mine', to: '__proto__' }]]) {
      [T, r] = go(BOB, { t: 'owner', ...a });
      ok(refusedBy(r) && r.notes.length === 1, `Bob may not give ${what} — ${why(r)}`);
    }
    [T, r] = go(BOB, { t: 'owner', id: 'mine', to: CAROL });
    ok(happened(r) && items(T).mine.owner === CAROL && r.log[0] === 'gave A to Carol', `an owner gives his piece to a player: "gave {label} to {name}": ${JSON.stringify(r.log)}`);
    [T, r] = go(BOB, { t: 'owner', id: 'mine', to: null });
    ok(happened(r) && !('owner' in items(T).mine) && r.log[0] === 'released A', `an owner releases his piece: "released {label}": ${JSON.stringify(r.log)}`);
    [T, r] = go(HOST, { t: 'owner', id: 'b', to: BOB });
    ok(happened(r) && items(T).b.owner === BOB, 'the host gives a locked board to Bob');
    [T, r] = go(HOST, { t: 'owner', id: 'mine', to: null });
    ok(happened(r) && !('owner' in items(T).mine), "the host releases Bob's piece");
    [T, r] = go(HOST, { t: 'owner', id: 'a', to: 'seat:nope' });
    ok(refusedBy(r), 'no such seat (automatic seating): refused');
  }

  section('(2) table: host only; items shift with the centre and are clamped; logged');
  {
    const T = mk({ a: P('tok', { x: 800, y: 800 }) }), r = run(T, HOST, { t: 'table', shape: 'rect', w: 3200, h: 2200 });
    ok(happened(r) && isDeepStrictEqual(T.state.table, { shape: 'rect', w: 3200, h: 2200 }) && r.log.includes('set the table to a 3200 × 2200 rectangle'), `a 3200 × 2200 rectangle: ${JSON.stringify(T.state.table)} ${JSON.stringify(r.log)}`);
    ok(items(T).a.x === 800 + 700 && items(T).a.y === 800 + 200, `items shift by ((w'−w)/2, (h'−h)/2) = (700, 200): ${items(T).a.x}, ${items(T).a.y}`);
    ok(T.state.players[BOB].seat === 270 && T.state.players[CAROL].seat === 0, 'seat angles are kept');
    const r2 = run(T, HOST, { t: 'table', shape: 'round', w: 1300, h: 1300 }), a = items(T).a, d = Math.hypot(a.x + 30 - 650, a.y + 30 - 650);
    ok(happened(r2) && r2.log.includes('set the table to round (small)') && d <= 540 + 1e-6, `back to a small round table: "set the table to round (small)", the piece pulled within PLAY_R (${d.toFixed(1)} ≤ 540)`);
    const r3 = run(T, HOST, { t: 'table', shape: 'round', w: 2400, h: 2400 });
    ok(r3.log.includes('set the table to round (large)'), `"set the table to round (large)": ${JSON.stringify(r3.log)}`);
    const rb = run(T, BOB, { t: 'table', shape: 'rect', w: 1000, h: 1000 });
    ok(refusedBy(rb, '🚫 Only the host can do that') && rb.warn.length > 0, `a guest's table is refused with "🚫 Only the host can do that" and a console.warn — ${why(rb)}`);
    run(T, HOST, { t: 'table', shape: 'round', w: 1500, h: 1500 });
    ok(isDeepStrictEqual(T.state.table, { shape: 'round', w: 2400, h: 2400 }), 'a round table 1500 across is no table: unchanged');
    run(T, HOST, { t: 'table', shape: 'rect', w: 100, h: 100000 });
    const tb = T.state.table;
    ok(tb.shape === 'round' || (tb.w >= 800 && tb.w <= 6000 && tb.h >= 600 && tb.h <= 4000), `out-of-bounds rect sizes never make a table outside 800–6000 × 600–4000 (${JSON.stringify(tb)})`);
    run(T, HOST, { t: 'table', shape: 'rect', w: 1400, h: 1200, felt: 'url(javascript:x)' });
    ok(T.state.table.felt === undefined, `a bad felt colour never reaches the state (${JSON.stringify(T.state.table)})`);
    run(T, HOST, { t: 'table', shape: 'rect', w: 1400, h: 1200, felt: '#224466' });
    ok(T.state.table.felt === '#224466', 'a good felt colour is kept');
    ok(!RULED_ACTIONS.has('table') && !PUBLIC_ACTIONS.has('table') && !PUBLIC_ACTIONS.has('loadBox') && !PUBLIC_ACTIONS.has('clear') && !RULED_ACTIONS.has('loadBox') && !RULED_ACTIONS.has('clear'),
      'table, loadBox and clear are neither ruled nor public');
  }

  section('(2) size: becomes a round table');
  {
    const T = mk({});
    run(T, HOST, { t: 'size', size: 2400 });
    ok(isDeepStrictEqual(T.state.table, { shape: 'round', w: 2400, h: 2400 }) && !('size' in T.state), `size 2400 → table {round, 2400, 2400} (${JSON.stringify(T.state.table)})`);
    run(T, BOB, { t: 'size', size: 1300 });
    ok(T.state.table.w === 2400, "a guest's size changes nothing");
  }

  section('(2) loadBox: cleanBox, dedup by content, clear, table, seats, setup; host only');
  {
    const SMALL = {
      name: 'Small', imgs: [], table: { shape: 'rect', w: 1600, h: 1000 }, seats: [{ id: 'n', name: 'North', edge: 'top' }, { id: 's', name: 'South' }],
      types: { m: { kind: 'token', name: 'Man', faces: ['M'] }, b: { kind: 'board', name: 'Plank', w: 300 } },
      setup: [{ piece: 'b', at: 'center' }, { forEachSeat: [{ piece: 'm', at: 'seat', owner: 'seat' }] }],
    };
    const T = mk({ a: P('tok') }, { hands: { [BOB]: [{ d: DK, i: 3 }] } }), boxes0 = Object.keys(T.boxes);
    const r = run(T, HOST, { t: 'loadBox', box: json(SMALL), setup: true, clear: true }), [id] = Object.keys(T.boxes).filter((k) => !boxes0.includes(k));
    const its = Object.values(items(T));
    ok(happened(r) && id && /^[0-9a-f]{8}$/.test(id) && r.fx.some((e) => e.t === 'box' && e.id === id), `a new box gets a host-minted id (${id}) and goes out to everyone (the 'box' effect)`);
    ok(T.state.boxSrc[id]?.src === 'host' && canon(T.boxes[id]) === canon(cleanBox(SMALL)), `its catalog record says src 'host' (${JSON.stringify(T.state.boxSrc[id])}) and holds the cleaned box`);
    ok(its.length === 3 && !items(T).a && !T.state.players[BOB].hand.length, `clear: the old piece and Bob's hand are gone; the setup placed 3 items (${its.length})`);
    ok(isDeepStrictEqual(T.state.table, { shape: 'rect', w: 1600, h: 1000 }) && isDeepStrictEqual(T.state.seats, cleanBox(SMALL).seats), "the box's table and named seats are set");
    ok(T.state.lastSetup === id && r.log.includes('set up «Small» (3 pieces)'), `lastSetup = the box; logged "set up «Small» (3 pieces)": ${JSON.stringify(r.log)}`);
    const board = its.find((it) => it.t === `${id}/b`), men = its.filter((it) => it.t === `${id}/m`);
    ok(board?.lock === true && men.every((m) => !m.lock) && isDeepStrictEqual(men.map((m) => m.owner).sort(), ['seat:n', 'seat:s']), 'a board spawns locked, tokens do not; owner "seat" resolves to each named seat');
    const r2 = run(T, HOST, { t: 'loadBox', box: (function rev(v) { return Array.isArray(v) ? v.map(rev) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, rev(v[k])])) : v; })(json(SMALL)) });
    ok(Object.keys(T.boxes).length === boxes0.length + 1 && !r2.fx.some((e) => e.t === 'box') && r2.log.includes('added the box «Small»') && Object.keys(items(T)).length === 3,
      `the same box again (keys in another order) reuses its id: no new box, nothing sent; "added the box «Small»" without setup: ${JSON.stringify(r2.log)}`);
    const bad = run(T, HOST, { t: 'loadBox', box: { name: '', types: {} } });
    ok(refusedBy(bad) && bad.notes.length === 1 && bad.notes[0].startsWith('🚫 Box rejected: ') && bad.error.length > 0 && Object.keys(T.boxes).length === boxes0.length + 1,
      `a bad box fails loudly ("🚫 Box rejected: …" and console.error) and changes nothing — ${why(bad)}`);
    const g = run(T, BOB, { t: 'loadBox', box: json(SMALL), setup: true, clear: true }), c = run(T, BOB, { t: 'clear' });
    ok(refusedBy(g, '🚫 Only the host can do that') && refusedBy(c, '🚫 Only the host can do that') && g.warn.length && c.warn.length, 'loadBox and clear from a guest: "🚫 Only the host can do that", with console.warn');
    // The 3,000-item check with the real seats, before the first op.
    const WIDE = { name: 'Wide', imgs: [], types: { m: { kind: 'token', name: 'Man', faces: ['M'] } }, setup: [{ forEachSeat: range(8).map(() => ({ piece: 'm', at: 'seat', count: 200 })) }] };
    ok(!boxError(WIDE), 'a box whose forEachSeat spawns 1,600 per seat passes cleanBox (no named seats to count)');
    const U = mk({}), rw = run(U, HOST, { t: 'loadBox', box: WIDE, setup: true });
    ok(refusedBy(rw) && rw.notes[0]?.includes('setup places too many items') && !Object.keys(items(U)).length, `with 3 players seated it would spawn 4,800: refused loudly before the first op ("setup places too many items") — ${why(rw)}`);
    const MANY = { name: 'Many', imgs: [], types: { m: { kind: 'token', name: 'Man', faces: ['M'] } }, setup: [{ piece: 'm', at: [100, 100], count: 200 }] };
    const filled = Object.fromEntries(range(4900).map((k) => [`f${k}`, C(k % 52, { up: false })])), V = mk(filled);
    const rc = run(V, HOST, { t: 'loadBox', box: MANY, setup: true });
    ok(refusedBy(rc, FULL) && Object.keys(items(V)).length === 4900, `4,900 items + a 200-item setup: refused before the first op ("${FULL}") — ${why(rc)}`);
    const rcc = run(V, HOST, { t: 'loadBox', box: MANY, setup: true, clear: true });
    ok(happened(rcc) && Object.keys(items(V)).length === 200, 'with clear, the same setup fits');
  }

  section('(2) clear: every item, every hand');
  {
    const T = mk({ a: P('tok'), p: PILE(cardsOf(3)), g: BAG(['tok']) }, { hands: { [BOB]: [{ d: DK, i: 9 }, { t: ref('pawn'), f: 0 }], [CAROL]: [{ d: DK, i: 8 }] } });
    const r = run(T, HOST, { t: 'clear' });
    ok(happened(r) && !Object.keys(items(T)).length && Object.values(T.state.players).every((p) => !p.hand.length), 'clear removes every item and empties every hand');
    ok(r.log[0] === 'cleared the table (3 items, 3 cards from hands)', `"cleared the table ({N} items, {M} cards from hands)": ${JSON.stringify(r.log)}`);
  }
}

function testChangedActions() {
  section('(2) move: every kind, clamped per shape; boards keep their z; labels in the log');
  {
    const rect = { shape: 'rect', w: 1400, h: 1200 };
    const T = mk({ a: P('tok', { n: 3 }), g: BAG(['tok']), b: P('board', { z: -1e6 + 1, x: 200, y: 200 }), o: P('tok', { x: 300, z: 50 }) }, { table: rect });
    run(T, BOB, { t: 'move', id: 'a', x: 5000, y: -5000 });
    ok(items(T).a.x === 1340 - 30 && items(T).a.y === 60 - 30, `a 60 × 60 piece on a 1400 × 1200 rectangle: its centre is kept in [60, 1340] × [60, 1140] (${items(T).a.x}, ${items(T).a.y})`);
    run(T, BOB, { t: 'move', id: 'g', x: -500, y: 9000 });
    ok(items(T).g.x === 60 - 45 && items(T).g.y === 1140 - 50, `a bag (90 × 100): the same rule with its size (${items(T).g.x}, ${items(T).g.y})`);
    const zb = items(T).b.z, rb = run(T, HOST, { t: 'move', id: 'b', x: 400, y: 400 });
    ok(happened(rb) && items(T).b.z === zb && items(T).b.x === 400, `a board moves and keeps its z (${zb})`);
    const zs = Math.max(...Object.values(items(T)).map((it) => it.z)), ro = run(T, BOB, { t: 'move', id: 'o', x: 300, y: 300 });
    ok(happened(ro) && items(T).o.z > zs - (items(T).o.z === zs ? 1 : 0) && items(T).o.z === Math.max(...Object.values(items(T)).map((it) => it.z)), 'any other item comes to the top (zTop)');
    const R = mk({ a: P('tok') }, { table: { shape: 'round', w: 1800, h: 1800 } });
    run(R, BOB, { t: 'move', id: 'a', x: 5000, y: 870 });
    const a = items(R).a, d = Math.hypot(a.x + 30 - 900, a.y + 30 - 900);
    ok(near(d, 790, 1e-6) && near(a.y + 30, 900, 1e-6), `on a round table its centre stays within PLAY_R = 790 of the centre, along the same ray (${d.toFixed(3)})`);
    const L = mk({ a: P('tok', { n: 3 }), h: P('spy', { up: false, n: 2, x: 900 }), c: P('chip', { x: 1000 }), s: S('chip', { x: 600 }), hs: S('spy', { up: false, x: 500 }), g: BAG([], { x: 400 }), p: PILE(piecesOf('tile', 2), { x: 300 }) });
    const lines = ['a', 'h', 'c', 's', 'hs', 'g', 'p'].map((id, k) => run(L, BOB, { t: 'move', id, x: 300 + 40 * k, y: 500 }).log[0]);
    ok(isDeepStrictEqual(lines, ['moved A ×3', 'moved a hidden piece ×2', 'moved Chip', 'moved the Chip supply', 'moved a supply of hidden pieces', 'moved the bag Sack', 'moved the Pile pile']),
      `itemLabel in every line: a face label with ×N, "a hidden piece ×N", the type name, "the {name} supply", "a supply of hidden pieces", "the bag {name}": ${JSON.stringify(lines)}`);
  }

  section('(2) rot: pieces snap to their rotStep (the back\'s when hidden)');
  {
    const T = mk({ t: P('tile'), h: P('tile', { up: false, x: 900 }), k: P('tok', { x: 1000 }), c: C(1) });
    const at = (id, rot) => { run(T, BOB, { t: 'rot', id, rot }); return items(T)[id].rot; };
    const tile = [[50, 90], [40, 0], [130, 90], [140, 180], [-80, 270], [359, 0]].map(([r, w]) => [r, at('t', r), w]);
    ok(tile.every(([, got, w]) => got === w), `a tile (rotStep 90): ${tile.map(([r, got]) => `${r}→${got}`).join(', ')}`);
    ok(at('h', 50) === 90 && at('h', 130) === 90, 'a hidden tile snaps by its back\'s step (90)');
    ok(at('k', 37) === 37 && at('c', 37) === 37, 'a token with rotStep 0, and a card, turn freely');
  }

  section('(2) flip: (1) a back toggles up, (2) two faces swap, (3) N faces turn, (4) a die is refused; supplies; bags; piles of pieces');
  {
    const T = mk({ k: P('tok'), c: P('coin', { x: 870 }), s: P('spy', { f: 1, x: 940 }), d: P('die', { x: 1010 }), hd: P('hdie', { x: 1080 }), cs: S('coin', { x: 600 }), ds: S('die', { f: 2, x: 500 }), g: BAG(['tok'], { x: 400 }), card: C(3, { x: 300 }) });
    let r = run(T, BOB, { t: 'flip', id: 'k' });
    ok(happened(r) && items(T).k.f === 1 && r.log[0] === 'turned A to B', `(3) three faces: f + 1, "turned {label} to {face label}": ${JSON.stringify(r.log)}`);
    run(T, BOB, { t: 'flip', id: 'k' }); run(T, BOB, { t: 'flip', id: 'k' });
    ok(items(T).k.f === 0, '(3) … and round again to the first face');
    r = run(T, BOB, { t: 'flip', id: 'c' });
    ok(happened(r) && items(T).c.f === 1 && /^flipped [HT]$/.test(r.log[0]), `(2) two faces: f = 1 − f, "flipped {label}": ${JSON.stringify(r.log)}`);
    r = run(T, BOB, { t: 'flip', id: 's' });
    ok(happened(r) && items(T).s.up === false && items(T).s.f === 1 && r.log[0] === 'turned S2 face down', `(1) a back: face down, labelled before the flip: ${JSON.stringify(r.log)}`);
    r = run(T, BOB, { t: 'flip', id: 's' });
    ok(happened(r) && !('up' in items(T).s) && r.log[0] === 'turned over S2', `(1) and face up again (up omitted when true), labelled after it: ${JSON.stringify(r.log)}`);
    r = run(T, BOB, { t: 'flip', id: 'd' });
    ok(refusedBy(r, '🚫 Dice are rolled, not turned'), `(4) a die: "🚫 Dice are rolled, not turned" — ${why(r)}`);
    r = run(T, BOB, { t: 'flip', id: 'hd' });
    ok(happened(r) && items(T).hd.up === false && r.log[0] === 'turned Cup die face down', `(1) before (4): a die with a back turns face down (a cup over it): ${JSON.stringify(r.log)}`);
    r = run(T, BOB, { t: 'flip', id: 'cs' });
    ok(happened(r) && items(T).cs.f === 1, 'a supply flips like a piece: it changes what it hands out');
    r = run(T, BOB, { t: 'flip', id: 'ds' });
    ok(happened(r) && items(T).ds.f === 3, 'a supply of dice has no die rule: it turns to the next face (2 → 3)');
    r = run(T, BOB, { t: 'flip', id: 'g' });
    ok(!r.changed && !r.log.length && r.warn.length > 0, `a bag has no sides: refused with a console.warn — ${why(r)}`);
    r = run(T, BOB, { t: 'flip', id: 'card' });
    ok(happened(r) && items(T).card.up === false, 'a card flips as ever');
    const Pp = mk({ p: PILE([{ t: ref('tile'), f: 0, up: true }, { t: ref('tile'), f: 1, up: true }]), q: PILE([{ t: ref('tile'), f: 0, up: true }, { t: ref('open'), f: 0, up: true }], { x: 900 }) });
    r = run(Pp, BOB, { t: 'flip', id: 'p' });
    ok(happened(r) && isDeepStrictEqual(items(Pp).p.cards, [{ t: ref('tile'), f: 1, up: false }, { t: ref('tile'), f: 0, up: false }]), `a pile of pieces flips: reversed, every side toggled (${JSON.stringify(items(Pp).p.cards)})`);
    r = run(Pp, BOB, { t: 'flip', id: 'q' });
    ok(refusedBy(r, '🚫 Some of those pieces have no hidden side'), `unless a member has no back: "🚫 Some of those pieces have no hidden side" — ${why(r)}`);
  }

  section('(2) toHand and play: pieces whose type (or back) has hand');
  {
    const T = mk({ a: P('pawn', { n: 3 }), b: P('pawn', { n: 2, x: 900 }), c: P('pawn', { x: 1000 }), k: P('tok', { x: 600 }), h: P('tile', { up: false, f: 1, x: 500 }) });
    let r = run(T, BOB, { t: 'toHand', id: 'a' });
    ok(happened(r) && items(T).a.n === 2 && isDeepStrictEqual(T.state.players[BOB].hand, [{ t: ref('pawn'), f: 0 }]), 'from a ×3 stack one goes into the hand ({t, f}); ×2 stay');
    run(T, BOB, { t: 'toHand', id: 'b' });
    ok(items(T).b && !('n' in items(T).b), 'from a ×2 stack: one stays, without n');
    run(T, BOB, { t: 'toHand', id: 'c' });
    ok(!items(T).c && T.state.players[BOB].hand.length === 3, 'a single piece leaves the table');
    r = run(T, BOB, { t: 'toHand', id: 'k' });
    ok(refusedBy(r) && r.notes.length === 1, `a token not for hands is refused — ${why(r)}`);
    r = run(T, BOB, { t: 'toHand', id: 'h' });
    ok(happened(r) && isDeepStrictEqual(T.state.players[BOB].hand.at(-1), { t: ref('tile'), f: 1, up: false }) && r.log[0] === 'took a hidden piece into hand', `a hidden tile goes in as {t, f, up: false}: "took a hidden piece into hand" (${JSON.stringify(r.log)})`);
    const n0 = Object.keys(items(T)), idx = T.state.players[BOB].hand.length - 1;
    r = run(T, BOB, { t: 'play', idx, type: ref('tile'), f: 1, x: 420, y: 430, up: false });
    const [nid] = newIds(T, n0), nu = items(T)[nid];
    ok(happened(r) && nu?.k === 'g' && nu.t === ref('tile') && nu.f === 1 && nu.up === false && nu.x === 420 && nu.y === 430 && T.state.players[BOB].hand.length === idx,
      `play of a piece entry (named {type, f}) makes a k:'g' piece face down at (x, y) (${JSON.stringify(nu)})`);
    ok(T.pub.get(nid) && !('t' in T.pub.get(nid)) && !('f' in T.pub.get(nid)), 'and everyone sees only its back');
    const U = mk({}, { hands: { [BOB]: [{ t: ref('open'), f: 1 }, { d: DK, i: 5 }] } }), u0 = Object.keys(items(U));
    run(U, BOB, { t: 'play', idx: 0, type: ref('open'), f: 0, x: 300, y: 300, up: true });
    ok(!newIds(U, u0).length && U.state.players[BOB].hand.length === 2, 'a play naming another face than the entry\'s plays nothing');
    run(U, BOB, { t: 'play', idx: 0, type: ref('open'), f: 1, x: 300, y: 300, up: false });
    const op = items(U)[newIds(U, u0)[0]];
    ok(op?.k === 'g' && op.up === undefined, `a type without a back is played face up whatever was asked (${JSON.stringify(op)})`);
    run(U, BOB, { t: 'play', idx: 0, d: DK, i: 5, x: 300, y: 300, up: true });
    ok(Object.values(items(U)).some((it) => it.k === 'c' && it.i === 5), 'cards play as ever');
  }

  section('(2) piles of pieces: stack, toPile, merge, draw, handPile, deal, peek, shuffle');
  {
    const T = mk({ a: P('tile'), b: P('tile', { x: 900, y: 700 }), card: C(2, { x: 600 }), big: P('big', { x: 500 }), t1: P('tok', { x: 400 }), t2: P('tok', { x: 350 }), o: P('open', { x: 300 }), o2: P('open', { x: 250 }) });
    const n0 = Object.keys(items(T));
    let r = run(T, BOB, { t: 'stack', id: 'a', onto: 'b' });
    const [pid] = newIds(T, n0), pile = items(T)[pid];
    ok(happened(r) && pile?.k === 'p' && isDeepStrictEqual(pile.cards, [{ t: ref('tile'), f: 0, up: true }, { t: ref('tile'), f: 0, up: true }]) && pile.x === 900 && pile.y === 700 && !items(T).a && !items(T).b,
      `stack turns two loose tiles into a pile of pieces where the target lay (${JSON.stringify(pile)})`);
    for (const [what, id, onto] of [['a tile and a card', 'big', 'card'], ['tiles of two sizes', 'big', 'o'], ['a card onto a tile', 'card', 'o']]) {
      r = run(T, BOB, { t: 'stack', id, onto });
      ok(refusedBy(r, "🚫 Those don't stack together"), `stack of ${what}: "🚫 Those don't stack together" — ${why(r)}`);
    }
    ok(refusedBy(run(T, BOB, { t: 'stack', id: 't1', onto: 't2' })), 'tokens (they stack by count) do not pile');
    ok(happened(run(T, BOB, { t: 'stack', id: 'o', onto: 'o2' })), 'two same-size tiles of different types pile');
    const U = mk({ tp: PILE(piecesOf('tile', 2)), cp: PILE(cardsOf(2), { x: 900 }), t: P('tile', { x: 600 }), big: P('big', { x: 500 }), card: C(2, { x: 400 }), tp2: PILE(piecesOf('tile', 3), { x: 300 }) });
    ok(happened(run(U, BOB, { t: 'toPile', id: 't', pile: 'tp' })) && items(U).tp.cards.length === 3, 'toPile: a tile onto a pile of tiles');
    for (const [what, a] of [['a big tile onto tiles', { t: 'toPile', id: 'big', pile: 'tp' }], ['a card onto tiles', { t: 'toPile', id: 'card', pile: 'tp' }], ['a tile pile into a card pile', { t: 'merge', id: 'tp2', pile: 'cp' }]]) {
      r = run(U, BOB, a);
      ok(refusedBy(r, "🚫 Those don't stack together"), `${what}: refused, "🚫 Those don't stack together" — ${why(r)}`);
    }
    ok(happened(run(U, BOB, { t: 'merge', id: 'tp2', pile: 'tp' })) && items(U).tp.cards.length === 6 && !items(U).tp2, 'merge: two piles of tiles');
    const V = mk({ hv: PILE(piecesOf('heavy', 3)), tp: PILE(piecesOf('tile', 3, false), { x: 900 }), op: PILE(piecesOf('open', 2), { x: 600 }) }, { hands: { [BOB]: [{ t: ref('tile'), f: 0 }] } });
    r = run(V, BOB, { t: 'draw', id: 'hv' });
    ok(refusedBy(r, "🚫 Those pieces can't be held in a hand"), `draw from a pile of pieces not for hands: "🚫 Those pieces can't be held in a hand" — ${why(r)}`);
    r = run(V, BOB, { t: 'handPile', idx: 0, type: ref('tile'), f: 0, pile: 'hv' });
    ok(refusedBy(r, "🚫 Those pieces can't be held in a hand"), `handPile onto such a pile: the same — ${why(r)}`);
    r = run(V, BOB, { t: 'handPile', idx: 0, type: ref('tile'), f: 0, pile: 'tp' });
    ok(happened(r) && items(V).tp.cards.length === 4 && !V.state.players[BOB].hand.length, 'handPile of a tile onto a pile of tiles');
    r = run(V, BOB, { t: 'draw', id: 'tp' });
    ok(happened(r) && V.state.players[BOB].hand.length === 1 && V.state.players[BOB].hand[0].t === ref('tile'), 'draw from a pile of tiles: a piece entry in the hand');
    const v0 = Object.keys(items(V));
    run(V, BOB, { t: 'deal', id: 'hv', x: 300, y: 300, up: true });
    run(V, BOB, { t: 'deal', id: 'tp', x: 400, y: 300 });
    run(V, BOB, { t: 'deal', id: 'op', x: 500, y: 300 });
    const dealt = newIds(V, v0).map((id) => items(V)[id]);
    ok(dealt.length === 3 && dealt.every((it) => it.k === 'g') && dealt.some((it) => it.t === ref('tile') && it.up === false) && dealt.some((it) => it.t === ref('open') && it.up === undefined),
      `deal from piles of pieces makes k:'g' pieces, never cards — face down only with a back (${JSON.stringify(dealt.map((it) => [it.k, it.t.split('/')[1], it.up]))})`);
    const top = items(V).tp.cards.at(-1); // (a face-down pile, and the tile handPiled onto it went face down too)
    r = run(V, BOB, { t: 'peek', id: 'tp' });
    const pk = r.fx.filter((e) => e.t === 'peek');
    ok(top.up === false && pk.length === 1 && pk[0].p === BOB && isDeepStrictEqual(pk[0].c, { t: top.t, f: top.f }), `peek at a hidden top answers the peeker alone with {t, f} (${JSON.stringify(pk)})`);
    ok(happened(run(V, BOB, { t: 'shuffle', id: 'tp' })), 'shuffle a pile of pieces');
  }

  section('(2) del: every kind; a bag says how many pieces went with it');
  {
    const T = mk({ g: BAG(['tok', 'tok', 'coin']), h: P('spy', { up: false, x: 900 }), b: P('board', { x: 300 }) });
    const lines = ['g', 'h', 'b'].map((id) => run(T, BOB, { t: 'del', id }).log[0]);
    ok(isDeepStrictEqual(lines, ['removed the bag Sack (3 pieces)', 'removed a hidden piece', 'removed Mat']) && !Object.keys(items(T)).length, `"removed {label}", plus " (N pieces)" for a bag: ${JSON.stringify(lines)}`);
  }
}

function testCaps() {
  section('(2) cap(): MAX_ITEMS = 5,000 on every op that adds items, human or script');
  const fill = (its, n = 5000) => { const o = { ...its }; for (let k = 0, m = Object.keys(o).length; m < n; k++, m++) o[`f${String(k).padStart(4, '0')}`] = C(k % 52, { up: false }); return o; };
  const fixture = { st: P('tok', { n: 3 }), st2: P('tok', { n: 2, x: 900 }), s: S('chip', { x: 1000 }), sh: S('pawn', { x: 600 }), g: BAG(['tok', 'tok']), gh: BAG([{ t: 'tile' }], { hand: true, x: 500 }),
    cp: PILE(cardsOf(3), { x: 400 }), tp: PILE(piecesOf('tile', 3), { x: 300 }), pw: P('pawn', { x: 200 }) };
  const hands = { [BOB]: [{ d: DK, i: 40 }, { t: ref('tile'), f: 0 }] };
  const at = () => mk(fill(fixture), { hands });
  ok(Object.keys(at().state.items).length === 5000, 'the test table holds exactly 5,000 items');
  for (const [what, a] of [
    ['play of a card', { t: 'play', idx: 0, d: DK, i: 40, x: 300, y: 300, up: true }],
    ['play of a piece', { t: 'play', idx: 1, type: ref('tile'), f: 0, x: 300, y: 300 }],
    ['split', { t: 'split', id: 'st', n: 1, x: 300, y: 300 }],
    ['take', { t: 'take', id: 's', x: 300, y: 300 }],
    ['pull', { t: 'pull', id: 'g', x: 300, y: 300 }],
    ['deal from a card pile', { t: 'deal', id: 'cp', x: 300, y: 300 }],
    ['deal from a pile of pieces', { t: 'deal', id: 'tp', x: 300, y: 300 }],
    ['addDeck (its pile)', { t: 'addDeck', deck: { name: 'Mini', back: null, imgs: [], cards: [{ n: 'one' }] }, x: 300, y: 300 }],
  ]) {
    const T = at(), d0 = Object.keys(T.state.decks).length, r = run(T, BOB, a);
    ok(refusedBy(r, FULL) && Object.keys(T.state.decks).length === d0, `${what} at 5,000 items: "${FULL}", nothing changes — ${why(r)}`);
  }
  for (const [what, a] of [['split {onto} (adds nothing)', { t: 'split', id: 'st', n: 1, onto: 'st2' }], ['take {hand}', { t: 'take', id: 'sh', hand: true }], ['pull {hand}', { t: 'pull', id: 'gh', hand: true }],
    ['toHand', { t: 'toHand', id: 'pw' }], ['draw', { t: 'draw', id: 'cp' }], ['del', { t: 'del', id: 'st2' }], ['move', { t: 'move', id: 'st', x: 100, y: 100 }]]) {
    const r = run(at(), BOB, a);
    ok(happened(r), `${what} at 5,000 items still works — ${why(r)}`);
  }
  {
    const T = at(), r1 = run(T, 'RULES', (t) => t.deal('cp', { x: 300, y: 300 })), r2 = run(T, 'RULES', (t) => t.newPile([{ d: DK, i: 1, up: true }], { x: 300, y: 300 }));
    ok(r1.ret === false && !r1.changed && r1.warn.length > 0, `t.deal onto the table at the cap: false, with a console.warn (${JSON.stringify(r1.warn)})`);
    ok(r2.ret === false && !r2.changed && r2.warn.length > 0, `t.newPile at the cap: false, with a console.warn (${JSON.stringify(r2.warn)})`);
    const r3 = run(T, 'RULES', (t) => t.deal('cp', { to: BOB }));
    ok(r3.ret && r3.changed && T.state.players[BOB].hand.length === 3, 't.deal to a hand at the cap still works');
  }
  {
    const T = mk(fill(fixture, 4999)), n0 = Object.keys(items(T));
    ok(happened(run(T, BOB, { t: 'take', id: 's', x: 300, y: 300 })) && newIds(T, n0).length === 1, 'at 4,999 items one take fits (5,000)');
    ok(refusedBy(run(T, BOB, { t: 'take', id: 's', x: 300, y: 300 }), FULL), 'the next one does not');
  }
  {
    const T = mk(fill(fixture, 5010));
    ok(T.pub.size === 5010 && Object.keys(T.snapContent().items).length === 5010, 'a save above the cap (5,010 items) still loads, and is shown whole');
    ok(refusedBy(run(T, BOB, { t: 'take', id: 's', x: 300, y: 300 }), FULL), 'but grows no further');
  }
}

function testHiddenRule() {
  section('(2) the hidden-item rule: one uniform refusal before any other check (attacker case 10)');
  const its = { hd: P('hdie', { up: false }), ht: P('spy', { up: false, n: 2, x: 870 }), ht2: P('spy', { up: false, n: 2, x: 940 }), hm: P('mole', { up: false, n: 2, x: 1010 }),
    vis: P('spy', { x: 600 }), sd: P('die', { x: 700 }), visn: P('spy', { n: 3, x: 650 }), hl: P('hdie', { up: false, owner: HOST, lock: true, x: 500 }), hs: S('spy', { up: false, x: 400 }) };
  const cases = [
    ['roll a hidden die', { t: 'roll', ids: ['hd'] }], ['roll a hidden token', { t: 'roll', ids: ['ht'] }], ['roll a shown die and a hidden one', { t: 'roll', ids: ['sd', 'hd'] }],
    ['face of a hidden die', { t: 'face', id: 'hd', f: 1 }], ['face of a hidden token', { t: 'face', id: 'ht', f: 1 }], ['face 99 of a hidden token', { t: 'face', id: 'ht', f: 99 }],
    ['face of a hidden supply', { t: 'face', id: 'hs', f: 1 }],
    ['join two hidden stacks of one type', { t: 'join', id: 'ht', onto: 'ht2' }], ['join two hidden stacks of two types', { t: 'join', id: 'ht', onto: 'hm' }],
    ['join a shown piece onto a hidden stack', { t: 'join', id: 'vis', onto: 'ht' }], ['join a hidden stack onto a hidden supply', { t: 'join', id: 'ht', onto: 'hs' }],
    ['roll a hidden die Alice owns and locked', { t: 'roll', ids: ['hl'] }], ['face of a hidden die Alice owns and locked', { t: 'face', id: 'hl', f: 0 }],
    ['split a shown stack onto a hidden one', { t: 'split', id: 'visn', n: 1, onto: 'ht' }],
  ];
  const seen = [];
  for (const [what, a] of cases) {
    for (const p of [BOB, HOST]) {
      const T = mk(its), r = run(T, p, a);
      seen.push(JSON.stringify(r.noteFx));
      ok(refusedBy(r, HIDDEN) && isDeepStrictEqual(r.noteFx, [{ t: 'note', p, msg: HIDDEN }]), `${what} (${NAMES[p]}): exactly {t:'note', p, msg: "${HIDDEN}"}, nothing changes — ${why(r)}`);
    }
  }
  ok(new Set(seen.filter((x, k) => k % 2 === 0)).size === 1 && new Set(seen.filter((x, k) => k % 2 === 1)).size === 1, 'byte for byte the same refusal for every hidden type and case');
  const T = mk(its), r = run(T, BOB, { t: 'split', id: 'ht', n: 1, x: 300, y: 300 });
  ok(happened(r), 'splitting a hidden stack off to the table is no oracle, and allowed');
}

function testBagFlag() {
  section('(2) the bag hand flag is fixed when the bag is made (attacker case 11)');
  const BAGBOX = {
    name: 'Bags', imgs: [], backs: { tb: { face: {} }, hb: { face: {} } },
    types: { tile: { kind: 'tile', name: 'Tile', back: 'tb', faces: ['T'] }, tok: { kind: 'token', name: 'Tok', back: 'hb', faces: ['K'] } },
    setup: [{ bag: [{ t: 'tile', n: 3 }], name: 'Tiles', at: [100, 100] }, { bag: [{ t: 'tile', n: 3, up: false }, { t: 'tok', up: false }], name: 'Mixed', at: [300, 100] },
      { bag: [{ t: 'tile', n: 2 }], name: 'Override', at: [500, 100], hand: false }],
  };
  // randInt always 0: pulls take the first member, so the hidden token is pulled last.
  const T = mk({}, { env: { ...renv(3), randInt: () => 0 } });
  run(T, HOST, { t: 'loadBox', box: BAGBOX, setup: true });
  const bag = (name) => Object.keys(items(T)).find((id) => items(T)[id].k === 'b' && items(T)[id].name === name);
  const [tiles, mixed, over] = ['Tiles', 'Mixed', 'Override'].map(bag);
  const pub = (id) => T.pub.get(id);
  ok(pub(tiles)?.hand === true && !('hand' in (pub(mixed) || { hand: 1 })) && !('hand' in (pub(over) || { hand: 1 })), `a bag of tiles is for hands; one with a token among its tiles is not; an override says not (${JSON.stringify([pub(tiles), pub(mixed), pub(over)].map((b) => b && b.hand))})`);
  const flags = [];
  for (let k = 0; k < 4; k++) {
    const r = run(T, BOB, { t: 'pull', id: mixed, x: 300 + 80 * k, y: 600 });
    flags.push(`${pub(mixed).n}:${'hand' in pub(mixed)}`);
    if (!r.changed) flags.push('refused');
  }
  const last = Object.values(items(T)).filter((it) => it.k === 'g').map((it) => it.t.split('/')[1]);
  ok(isDeepStrictEqual(flags, ['3:false', '2:false', '1:false', '0:false']) && last.at(-1) === 'tok', `pulled face down until the token was last, and after: the public flag never appears (${flags.join(' ')}; order ${last.join(', ')})`);
  const tok = Object.keys(items(T)).find((id) => items(T)[id].t?.endsWith('/tok'));
  run(T, HOST, { t: 'flip', id: tok });
  const r = run(T, BOB, { t: 'toBag', id: tok, bag: tiles });
  ok(refusedBy(r) && pub(tiles).hand === true && pub(tiles).n === 3, `toBag of a non-hand piece into a hand bag: refused — ${why(r)}`);
  for (let k = 0; k < 3; k++) run(T, BOB, { t: 'pull', id: tiles, hand: true });
  ok(pub(tiles).n === 0 && pub(tiles).hand === true && refusedBy(run(T, BOB, { t: 'toBag', id: tok, bag: tiles })), 'emptied into a hand, the bag keeps its flag, and still refuses the token');
}

function testFacade() {
  section('(2e) the facade: t.roll, t.random, t.type, t.geom, t.players, t.find, t.item, t.hand, ops on the new kinds');
  const T = mk({ d: P('die'), hd: P('hdie', { up: false, x: 870 }), k: P('tok', { owner: BOB, lock: true, x: 940 }), s: S('chip', { x: 1000 }), g: BAG(['tok', 'coin'], { x: 600 }), b: P('board', { x: 300, z: -1e6 + 1 }),
    t: P('tile', { x: 500 }), pw: P('pawn', { owner: 'seat:x', x: 450 }), c: C(1, { owner: BOB }) }, { hands: { [BOB]: [{ t: ref('pawn'), f: 0 }, { d: DK, i: 7 }] } });
  let r = run(T, 'RULES', (t) => t.roll('d'));
  ok(Number.isInteger(r.ret) && r.ret === items(T).d.f && r.ret >= 0 && r.ret < 6 && r.logEntries.length === 1 && r.logEntries[0].p === 'RULES' && r.log[0] === `rolled ${r.ret + 1}`,
    `t.roll(die) → its new face index, logged as Rules "rolled {face label}" (${r.ret}, ${JSON.stringify(r.log)})`);
  r = run(T, 'RULES', (t) => t.roll('hd'));
  ok(Number.isInteger(r.ret) && r.log[0] === 'rolled a hidden die', `t.roll of a hidden die: "rolled a hidden die", no value (${JSON.stringify(r.log)})`);
  ok(run(T, 'RULES', (t) => t.roll('k')).ret === false && run(T, 'RULES', (t) => t.roll('nope')).ret === false, 't.roll of a token, or of nothing: false');
  r = run(T, 'RULES', (t) => t.flip('d'));
  ok(r.ret === false && r.warn.length > 0 && !r.changed, `t.flip(die) → false with a console.warn (${JSON.stringify(r.warn)})`);
  const ty = T.api.type(ref('tok')), want = { kind: 'token', name: 'Gem', w: 60, h: 60, shape: 'disc', faces: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], rotStep: 0, hand: false, stack: 'count', meta: { points: 3 }, box: 'Test box' };
  ok(ty && Object.entries(want).every(([key, v]) => isDeepStrictEqual(ty[key], v)), `t.type('box/type') → a copy with kind, name, size, shape, faces, flags, meta and the box's name (${JSON.stringify(ty)})`);
  ok(T.api.type(ref('spy')).back === 'hb' && isDeepStrictEqual(T.api.type({ t: ref('tok') }), ty) && T.api.type('nope/x') === null && T.api.type(ref('zzz')) === null, 't.type takes {t} too; back is there; an unknown ref → null');
  ty.faces[0].label = 'Z';
  ty.meta.points = 99;
  ok(T.boxes[BX].types.tok.faces[0].label === 'A' && T.boxes[BX].types.tok.meta.points === 3, 't.type returns a copy: changing it changes nothing');
  ok(isDeepStrictEqual(T.api.geom(), { shape: 'round', w: 1800, h: 1800, size: 1800, cx: 900, cy: 900, r: 790 }), `t.geom on a round table (${JSON.stringify(T.api.geom())})`);
  const Rt = mk({}, { table: { shape: 'rect', w: 1400, h: 1200 } });
  ok(isDeepStrictEqual(Rt.api.geom(), { shape: 'rect', w: 1400, h: 1200, size: 1400, cx: 700, cy: 600, r: 490 }), `t.geom on a rectangle: size = w, r = min(w, h)/2 − 110 (${JSON.stringify(Rt.api.geom())})`);
  const byScan = (q) => Object.entries(items(T)).filter(([, it]) => q(it)).map(([id]) => id).sort();
  const find = (q) => T.api.find(q).map((x) => x.id).sort();
  const kindOf = (it) => T.boxes[BX].types[it.t?.split('/')[1]]?.kind;
  for (const [q, f] of [[{ kind: 'piece' }, (it) => it.k === 'g'], [{ kind: 'supply' }, (it) => it.k === 's'], [{ kind: 'bag' }, (it) => it.k === 'b'], [{ kind: 'die' }, (it) => it.k === 'g' && kindOf(it) === 'die'],
    [{ kind: 'token' }, (it) => it.k === 'g' && kindOf(it) === 'token'], [{ kind: 'tile' }, (it) => it.k === 'g' && kindOf(it) === 'tile'], [{ kind: 'board' }, (it) => it.k === 'g' && kindOf(it) === 'board'],
    [{ type: 'chip' }, (it) => it.t === ref('chip')], [{ type: ref('tok') }, (it) => it.t === ref('tok')], [{ owner: BOB }, (it) => it.owner === BOB], [{ kind: 'card', owner: BOB }, (it) => it.k === 'c' && it.owner === BOB]]) {
    ok(isDeepStrictEqual(find(q), byScan(f)), `t.find(${JSON.stringify(q)}) → ${JSON.stringify(find(q))} (a scan says ${JSON.stringify(byScan(f))})`);
  }
  let threw = null;
  try { T.api.find({ colour: 'red' }); } catch (e) { threw = e; }
  ok(threw instanceof TypeError, 'an unknown t.find filter still throws');
  const bg = T.api.item('g');
  ok(isDeepStrictEqual(bg.of, items(T).g.of) && bg.id === 'g', 't.item(bag) includes its members (scripts may know them)');
  bg.of.push({ t: ref('tok'), f: 2 });
  ok(items(T).g.of.length === 2, 'a copy: changing it changes nothing');
  const hand = T.api.hand(BOB);
  ok(isDeepStrictEqual(hand, [{ t: ref('pawn'), f: 0 }, { d: DK, i: 7 }]), 't.hand includes piece entries');
  hand[0].f = 5;
  ok(T.state.players[BOB].hand[0].f === 0, 't.hand is a copy');
  r = run(T, 'RULES', (t) => [t.move('k', 600, 600), t.rot('k', 90), t.flip('k'), t.toHand(BOB, 'pw')]);
  ok(r.ret.every((x) => x) && items(T).k.x === 600 && items(T).k.rot === 90 && items(T).k.f === 1 && !items(T).pw && T.state.players[BOB].hand.length === 3,
    `t.move, t.rot, t.flip and t.toHand work on owned and locked pieces (no owner or lock checks) (${JSON.stringify(r.ret)})`);
  const n0 = Object.keys(items(T));
  r = run(T, 'RULES', (t) => [t.playFromHand(BOB, 2, { x: 600, y: 600 }), t.newPile([{ t: ref('tile'), f: 1, up: false }, { t: ref('tile'), f: 0, up: true }], { x: 700, y: 700 }), t.remove('k')]);
  const made = newIds(T, n0).map((id) => items(T)[id]);
  ok(made.some((it) => it.k === 'g' && it.t === ref('pawn')) && made.some((it) => it.k === 'p' && isDeepStrictEqual(it.cards, [{ t: ref('tile'), f: 1, up: false }, { t: ref('tile'), f: 0, up: true }])) && !items(T).k,
    `t.playFromHand of a piece entry, t.newPile of pieces and t.remove work (${JSON.stringify(made.map((it) => it.k))})`);
  threw = null;
  try { quietly(() => T.api.newPile([{ d: DK, i: 1, up: true }, { t: ref('tile'), f: 0, up: true }])); } catch (e) { threw = e; }
  ok(threw instanceof TypeError, 't.newPile of a card with a piece throws a TypeError');
  // t.random, through a rules button: one "used randomness" line per action.
  const code = `({ name: 'Dice', buttons: () => [{ id: 'r', label: 'R' }], onButton(t) { t.data.v = [t.random(), t.random(), t.random()]; } })`;
  run(T, HOST, { t: 'setRules', enabled: true, code });
  r = run(T, BOB, { t: 'rulesBtn', id: 'r' });
  const vals = T.api.data.v;
  ok(vals?.length === 3 && vals.every((v) => typeof v === 'number' && v >= 0 && v < 1) && new Set(vals).size === 3, `t.random() → floats in [0, 1) (${JSON.stringify(vals)})`);
  ok(r.logEntries.filter((e) => /randomness/.test(e.txt)).length === 1 && r.logEntries.some((e) => e.p === 'RULES' && e.txt === 'used randomness (3 draws)'), `one "used randomness (3 draws)" line for the action (${JSON.stringify(r.log)})`);
  // A script may veto the new ruled actions.
  const veto = `({ name: 'Veto', validate(t, a) { if (a.t === 'roll' || a.t === 'take') return 'not now'; } })`;
  run(T, HOST, { t: 'setRules', enabled: true, code: veto });
  const f0 = items(T).d.f;
  r = run(T, BOB, { t: 'roll', ids: ['d'] });
  ok(items(T).d.f === f0 && r.notes.includes('🚫 not now'), `validate() vetoes a roll: "🚫 not now", the die unchanged (${JSON.stringify(r.notes)})`);
  const s0 = Object.keys(items(T));
  r = run(T, BOB, { t: 'take', id: 's', x: 300, y: 300 });
  ok(!newIds(T, s0).length && r.notes.includes('🚫 not now'), 'and a take');
  const NEW = ['roll', 'face', 'split', 'join', 'take', 'pull', 'toBag', 'lock', 'owner', 'seat'];
  ok(NEW.every((x) => RULED_ACTIONS.has(x)) && ['table', 'loadBox', 'clear', 'size', 'setRules'].every((x) => !RULED_ACTIONS.has(x)), 'RULED_ACTIONS: today\'s set plus roll, face, split, join, take, pull, toBag, lock, owner and seat; not table, loadBox or clear');
  ok(isDeepStrictEqual(new Set(PUBLIC_ACTIONS), new Set([...RULED_ACTIONS, 'hello', 'snap', 'need', 'name', 'chat', 'rulesBtn'])), 'PUBLIC_ACTIONS: the ruled actions plus hello, snap, need, name, chat and rulesBtn');
}

function testLogNamesNothingHidden() {
  section('(2d) the log never names a hidden piece (attacker case 12, in core)');
  const its = { h: P('spy', { up: false, n: 3 }), h2: P('spy', { up: false, n: 2, x: 870 }), hm: P('mole', { up: false, x: 940 }), hs: S('spy', { up: false, x: 1010 }),
    hd: P('hdie', { up: false, x: 600 }), ht: P('tile', { up: false, f: 1, x: 500 }), ht2: P('tile2', { up: false, x: 400 }), g: BAG([{ t: 'spy', up: false }, { t: 'mole', up: false }], { x: 300 }),
    hp: PILE([{ t: ref('tile'), f: 1, up: false }, { t: ref('tile2'), f: 0, up: false }], { x: 1100 }) };
  const T = mk(its, { hands: { [BOB]: [{ t: ref('tile'), f: 1, up: false }] } }), all = [];
  const acts = [
    [BOB, { t: 'move', id: 'h', x: 700, y: 700 }], [BOB, { t: 'rot', id: 'h', rot: 30 }], [BOB, { t: 'split', id: 'h', n: 1, x: 500, y: 700 }], [BOB, { t: 'join', id: 'h', onto: 'h2' }],
    [BOB, { t: 'take', id: 'hs', x: 650, y: 650 }], [BOB, { t: 'toHand', id: 'ht' }], [BOB, { t: 'pull', id: 'g', x: 900, y: 900 }], [BOB, { t: 'toBag', id: 'h2', bag: 'g' }],
    [BOB, { t: 'owner', id: 'hm', to: BOB }], [HOST, { t: 'lock', id: 'hm', on: true }], [BOB, { t: 'stack', id: 'ht2', onto: 'hp' }], [BOB, { t: 'deal', id: 'hp', x: 300, y: 600 }],
    [BOB, { t: 'peek', id: 'hp' }], [BOB, { t: 'play', idx: 0, type: ref('tile'), f: 1, x: 800, y: 500, up: false }], [BOB, { t: 'del', id: 'hd' }], [BOB, { t: 'roll', ids: ['hd'] }],
  ];
  for (const [p, a] of acts) all.push(run(T, p, a));
  const Td = mk({ hd: P('hdie', { up: false }) });
  all.push(run(Td, 'RULES', (t) => t.roll('hd')));
  const said = JSON.stringify(all.map((r) => [r.log, r.fx.filter((e) => e.t !== 'peek')])), names = ['Spy', 'Mole', 'S1', 'S2', 'M1', 'M2', 'M3', 'T1', 'T2', 'U1', 'Tile', 'Cup die', '/spy', '/mole', '/tile', '/hdie'];
  const leaked = names.filter((n) => said.includes(n));
  ok(all.filter((r) => r.log.length).length >= 12 && !leaked.length, `${all.filter((r) => r.log.length).length} actions on hidden pieces logged; no log line or effect but the peeker's own answer names a type, a face or a value (${leaked.join(', ') || 'none found'})`);
  ok(all.at(-1).log[0] === 'rolled a hidden die', 't.roll of a hidden die: "rolled a hidden die"');
}

// =============================================================================
// (3) Setup order
// =============================================================================
function testSetupOrder() {
  section('(3) setup order: hidden pieces carry no declaration order (20 seeds)');
  const ONE = { name: 'One entry', imgs: [], table: { shape: 'rect', w: 2200, h: 1200 }, backs: { hb: { face: {} } }, types: { u: { kind: 'token', name: 'U', back: 'hb', faces: ['U'] } },
    setup: [{ piece: 'u', up: false, count: 30, at: [100, 500], spread: [60, 0] }] };
  const rz = [], rk = [];
  for (let seed = 1; seed <= 20; seed++) {
    const T = mk({}, { env: renv(seed), seed });
    run(T, HOST, { t: 'loadBox', box: ONE, setup: true, clear: true });
    const list = Object.entries(items(T)).map(([id, it]) => ({ id, k: Math.round((it.x - 100) / 60), z: it.z }));
    const keys = [...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map((x, j) => [x.k, j]);
    if (list.length !== 30 || new Set(list.map((x) => x.k)).size !== 30) { ok(false, `seed ${seed}: 30 pieces in 30 places (${list.length})`); continue; }
    rz.push(spearman(list.map((x) => x.k), list.map((x) => x.z)));
    rk.push(spearman(keys.map((x) => x[0]), keys.map((x) => x[1])));
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, fmt = (xs) => `mean ${mean(xs).toFixed(3)}, max |ρ| ${Math.max(...xs.map(Math.abs)).toFixed(2)}`;
  ok(rz.length === 20 && Math.abs(mean(rz)) < 0.2 && rz.every((x) => Math.abs(x) < 0.75), `one entry of 30 hidden pieces: z is uncorrelated with their declared order (Spearman ${fmt(rz)})`);
  ok(rk.length === 20 && Math.abs(mean(rk)) < 0.2 && rk.every((x) => Math.abs(x) < 0.75), `and so is their key order (Spearman ${fmt(rk)})`);

  const GROUP = (shuffle) => ({
    name: `Group ${shuffle}`, imgs: [], table: { shape: 'rect', w: 2200, h: 1200 }, backs: { hb: { face: {} }, hc: { face: {} } },
    types: { ...Object.fromEntries(range(10).map((k) => [`u${k}`, { kind: 'token', name: `Unit ${k}`, back: 'hb', faces: [`U${k}`] }])),
      v: { kind: 'token', name: 'Shown', faces: ['V'] }, w: { kind: 'token', name: 'Other back', back: 'hc', faces: ['W'] } },
    setup: [{ group: [...range(10).map((k) => ({ piece: `u${k}`, up: false, at: [100 + 80 * k, 500] })), { piece: 'v', at: [100, 800] }, { piece: 'w', up: false, at: [1000, 800] }], ...(shuffle && { shuffle: true }) }],
  });
  const spots = new Set(range(10).map((k) => `${100 + 80 * k},500`));
  let fixed = 0, kept = true, others = true, places = true;
  const gz = [], gx = [];
  for (let seed = 1; seed <= 20; seed++) {
    const T = mk({}, { env: renv(seed), seed });
    run(T, HOST, { t: 'loadBox', box: GROUP(true), setup: true, clear: true });
    const units = Object.values(items(T)).filter((it) => /\/u\d$/.test(it.t)).map((it) => ({ k: +it.t.slice(-1), at: `${it.x},${it.y}`, x: it.x, z: it.z }));
    places &&= units.length === 10 && isDeepStrictEqual(new Set(units.map((u) => u.at)), spots);
    fixed += units.filter((u) => u.at === `${100 + 80 * u.k},500`).length;
    const v = Object.values(items(T)).find((it) => it.t.endsWith('/v')), w = Object.values(items(T)).find((it) => it.t.endsWith('/w'));
    others &&= v?.x === 100 && v.y === 800 && w?.x === 1000 && w.y === 800;
    gz.push(spearman(units.map((u) => u.k), units.map((u) => u.z)));
    gx.push(spearman(units.map((u) => u.k), units.map((u) => u.x)));
    const U = mk({}, { env: renv(seed), seed });
    run(U, HOST, { t: 'loadBox', box: GROUP(false), setup: true, clear: true });
    kept &&= Object.values(items(U)).filter((it) => /\/u\d$/.test(it.t)).every((it) => it.x === 100 + 80 * +it.t.slice(-1) && it.y === 500);
  }
  ok(places, 'group {shuffle}: the hidden units still fill exactly the declared places');
  ok(fixed < 60, `and are permuted among them: over 20 seeds only ${fixed} of 200 units sat where they were declared (≈ 20 expected by chance, 200 if never moved)`);
  ok(Math.abs(gx.reduce((a, b) => a + b) / 20) < 0.3 && Math.abs(gz.reduce((a, b) => a + b) / 20) < 0.3, `places and z are uncorrelated with the declared order (mean Spearman x ${(gx.reduce((a, b) => a + b) / 20).toFixed(3)}, z ${(gz.reduce((a, b) => a + b) / 20).toFixed(3)})`);
  ok(others, 'a shown piece, and a hidden one with another back, keep their places');
  ok(kept, 'without shuffle, a group lays out where declared');
}

// =============================================================================
// (4) The public reduction
// =============================================================================
/** The back ref "<box>/<back>" of type ref t, or null (no box, no type or no back), read without core. */
function specBack(boxes, t) {
  const [b, ty] = String(t).split('/'), box = Object.hasOwn(boxes, b) ? boxes[b] : null, type = box && Object.hasOwn(box.types, ty) ? box.types[ty] : null;
  return type?.back ? `${b}/${type.back}` : null;
}
/** An item as §2d's table says every viewer receives it. */
function specPub(it, boxes) {
  const pos = { x: it.x, y: it.y, rot: it.rot, z: it.z, ...(it.owner && { owner: it.owner }), ...(it.lock && { lock: true }) };
  switch (it.k) {
    case 'c': return it.up ? { k: 'c', d: it.d, i: it.i, up: true, ...pos } : { k: 'c', d: it.d, up: false, ...pos };
    case 'p': {
      const top = it.cards.at(-1);
      return { k: 'p', name: it.name, n: it.cards.length, ...pos, top: top && ('d' in top ? (top.up ? { d: top.d, i: top.i, up: true } : { d: top.d, up: false }) : (top.up ? { t: top.t, f: top.f, up: true } : { b: specBack(boxes, top.t), up: false })) };
    }
    case 'b': return { k: 'b', name: it.name, n: it.of.length, ...(it.hand && { hand: true }), ...(it.color && { color: it.color }), ...pos };
    default: return { k: it.k, ...(it.up === false ? { b: specBack(boxes, it.t) } : { t: it.t, f: it.f }), ...(it.n >= 2 && { n: it.n }), ...pos };
  }
}
/** Whether a type (or, hidden, its back) may be held in a hand, read without core. */
function specHandFlag(boxes, m) {
  const [b, ty] = String(m.t).split('/'), type = boxes[b]?.types?.[ty];
  if (!type) return false;
  return m.up === false ? !!boxes[b].backs?.[type.back]?.hand : type.hand;
}
/** T.handy as §2a counts it: cards, piles of cards, hand pieces / supplies / piles (the back's flag when hidden), hand bags. */
function specHandy(s) {
  let n = 0;
  for (const it of Object.values(s.items)) {
    if (it.k === 'c') n++;
    else if (it.k === 'b') n += !!it.hand;
    else if (it.k === 'p') { const top = it.cards.at(-1); n += !!top && ('d' in top || specHandFlag(s.boxes, top)); }
    else n += specHandFlag(s.boxes, it);
  }
  return n;
}

function testPublic() {
  section('(4) the public reduction: hidden pieces, missing boxes, bags, piles of pieces');
  {
    const T = mk({ h: P('spy', { up: false, n: 2, owner: BOB, lock: true }), hs: S('spy', { up: false, x: 870 }), sh: P('tok', { n: 3, x: 940 }), ss: S('chip', { x: 1000 }),
      g: BAG(['tok', { t: 'spy', up: false }], { color: '#123', hand: true, x: 600 }), pp: PILE(piecesOf('tile', 2), { x: 500 }), ph: PILE(piecesOf('tile', 2, false), { x: 400 }),
      nb: P('zz', { t: 'deadbeef/zz', up: false, x: 300 }), ns: P('zz', { t: 'deadbeef/zz', f: 2, x: 250 }), nt: P('zz', { t: `${BX}/gone`, up: false, x: 200 }) });
    const pub = Object.fromEntries(T.pub), keys = (o) => Object.keys(o).sort().join();
    ok(isDeepStrictEqual(pub.h, { k: 'g', b: `${BX}/hb`, x: 800, y: 800, rot: 0, z: items(T).h.z, n: 2, owner: BOB, lock: true }), `a hidden piece: {k, b, x, y, rot, z, n?, owner?, lock?} — no t, f or up (${JSON.stringify(pub.h)})`);
    ok(isDeepStrictEqual(pub.hs, { k: 's', b: `${BX}/hb`, x: 870, y: 800, rot: 0, z: items(T).hs.z }), `a hidden supply: {k, b, …} (${JSON.stringify(pub.hs)})`);
    ok(keys(pub.sh) === 'f,k,n,rot,t,x,y,z' && pub.sh.t === ref('tok') && keys(pub.ss) === 'f,k,rot,t,x,y,z', `shown: {k, t, f, x, y, rot, z, n?} exactly (${JSON.stringify(pub.sh)})`);
    ok(isDeepStrictEqual(pub.g, { k: 'b', name: 'Sack', n: 2, hand: true, color: '#123', x: 600, y: 800, rot: 0, z: items(T).g.z }), `a bag: name, n, hand, color — never of (${JSON.stringify(pub.g)})`);
    ok(isDeepStrictEqual(pub.pp.top, { t: ref('tile'), f: 0, up: true }) && pub.pp.n === 2 && !('cards' in pub.pp), `a pile of pieces shows n and its top {t, f, up: true} (${JSON.stringify(pub.pp)})`);
    ok(isDeepStrictEqual(pub.ph.top, { b: `${BX}/tb`, up: false }), `a hidden top: {b, up: false} (${JSON.stringify(pub.ph.top)})`);
    ok(isDeepStrictEqual(pub.nb, { k: 'g', b: null, x: 300, y: 800, rot: 0, z: items(T).nb.z }) && isDeepStrictEqual(pub.nt, { k: 'g', b: null, x: 200, y: 800, rot: 0, z: items(T).nt.z }),
      `a hidden piece whose box (or type) is missing: b: null, never t or f (${JSON.stringify(pub.nb)}, ${JSON.stringify(pub.nt)})`);
    ok(pub.ns.t === 'deadbeef/zz' && pub.ns.f === 2, 'a shown one keeps its t and f');
    const sc = T.snapContent(), ids = Object.keys(sc.items);
    ok(ids.join() === inOrder(ids).join(), 'the snapshot lists items in sorted-id order');
    const pl = sc.players[BOB];
    ok(keys(pl) === 'color,handCount,name,online,seat' && pl.seat === 270, `a player: {name, color, online, handCount, seat} (${JSON.stringify(pl)})`);
    ok(!/"of"|"cards"|\/spy|\/mole|S1|S2/.test(JSON.stringify(sc.items)), 'nothing in the snapshot shows a bag\'s contents, a pile\'s cards or a hidden type');
  }

  section('(4) handy counts what a hand could hold, through put and remove');
  {
    const T = mk({ cs: S('chip'), ps: S('pawn', { x: 870 }), ts: S('tile', { up: false, x: 940 }), g: BAG(['tok'], { x: 1000 }), gh: BAG(['tile'], { hand: true, x: 600 }), k: P('tok', { x: 500 }), hk: P('spy', { up: false, x: 450 }) });
    const tick = () => { const d = T.takeDirty(), c = T.patchContent(d); T.drain(); return c; };
    tick();
    const steps = [];
    const see = (what) => steps.push(`${what}: ${T.handy}/${specHandy(T.state)}`);
    see('pawn supply, hidden tile supply, hand bag');
    ok(T.handy === 3 && specHandy(T.state) === 3 && T.snapContent().handy === true, `3 (a pawn supply, a hidden tile supply — its back is for hands —, a hand bag; not a chip supply, a plain bag, a token or a hidden token): ${T.handy}`);
    run(T, HOST, { t: 'del', id: 'ps' }); see('del ps');
    const c1 = tick();
    ok(T.handy === 2 && !('handy' in c1), 'removing one: 2, and a patch carries no handy (still true)');
    run(T, HOST, { t: 'del', id: 'gh' }); run(T, HOST, { t: 'del', id: 'ts' }); see('del gh, ts');
    const c2 = tick();
    ok(T.handy === 0 && c2.handy === false && T.snapContent().handy === false, `removing the rest: 0, and the patch says handy: false (${JSON.stringify(c2.handy)})`);
    run(T, HOST, { t: 'take', id: 'cs', x: 300, y: 300 });
    ok(T.handy === 0 && !('handy' in tick()), 'a chip taken from its supply is no hand piece: still 0, no handy in the patch');
    run(T, HOST, { t: 'addDeck', deck: { name: 'One', back: null, imgs: [], cards: [{ n: 'x' }] }, x: 300, y: 300 });
    const c3 = tick();
    ok(T.handy === 1 && c3.handy === true, `a deck's pile: 1, handy: true in the patch (${JSON.stringify(c3.handy)})`);
    ok(steps.every((x) => x.split(': ')[1].split('/')[0] === x.split('/')[1]), `T.handy agrees with a count by the spec at each step (${steps.join('; ')})`);
  }
}

/** A fuzz box: the test box (no pile mixing a hand type with a non-hand one) with a setup that spawns every kind. */
const FUZZBOX = {
  ...TESTBOX, name: 'Fuzz box', types: Object.fromEntries(Object.entries(TESTBOX.types).filter(([k]) => k !== 'heavy')),
  setup: [
    { piece: 'tok', at: [300, 300], n: 3 }, { piece: 'coin', at: [380, 300] }, { piece: 'chip', at: [460, 300], count: 2, spread: [70, 0] }, { piece: 'pawn', at: [620, 300], n: 2 },
    { piece: 'spy', at: [300, 400], up: false, count: 3, spread: [70, 0] }, { piece: 'mole', at: [520, 400], up: false, n: 2 }, { piece: 'tile', at: [300, 500], count: 3, spread: [110, 0] },
    { piece: 'tile', at: [640, 500], up: false, count: 2, spread: [110, 0] }, { piece: 'open', at: [300, 620] }, { piece: 'big', at: [420, 620] }, { piece: 'die', at: [560, 620], count: 3, spread: [60, 0] },
    { piece: 'hdie', at: [760, 620], up: false }, { piece: 'd8', at: [830, 620] }, { piece: 'board', at: [900, 900], lock: false },
    { supply: 'chip', at: [300, 760] }, { supply: 'spy', at: [380, 760], up: false }, { supply: 'pawn', at: [460, 760] }, { supply: 'tile', at: [540, 760], up: false },
    { bag: ['tok', 'coin', { t: 'spy', up: false }], name: 'Mixed', at: [680, 760] }, { bag: [{ t: 'tile', n: 2 }, { t: 'tile2', up: false }], name: 'Tiles', at: [800, 760] },
  ],
};

/** The key order of an object built by inserting `ids` sorted (§0.2): what JSON shows. (JS lists integer-like
 *  keys such as "12345678" first, by value — still a function of the ids alone, never of creation order.) */
const inOrder = (ids) => Object.keys(Object.fromEntries([...ids].sort().map((id) => [id, 1])));

function testWireAndSizes() {
  section('(2b) the wire: table, seats and handy replace size; seats travel when set or cleared');
  {
    const T = mk({ a: P('tok') });
    const sc = T.snapContent();
    ok(isDeepStrictEqual(Object.keys(sc).sort(), ['handy', 'items', 'log', 'players', 'rules', 'seats', 'table']) && sc.seats === null && isDeepStrictEqual(sc.table, { shape: 'round', w: 1800, h: 1800 }),
      `a snapshot carries table, seats and handy, never size (${Object.keys(sc).sort()})`);
    const tick = () => { const c = T.patchContent(T.takeDirty()); T.drain(); return c; };
    tick();
    run(T, HOST, { t: 'loadBox', box: T1BOX({ seats: [{ id: 'n', name: 'N' }] }) });
    const c1 = tick();
    ok(isDeepStrictEqual(c1.seats, [{ id: 'n', name: 'N', edge: 'bottom' }]) && !('table' in c1) && !('size' in c1), `named seats set: the patch carries seats (${JSON.stringify(c1.seats)}), not the unchanged table`);
    run(T, HOST, { t: 'table', shape: 'rect', w: 1500, h: 900 });
    const c2 = tick();
    ok(isDeepStrictEqual(c2.table, { shape: 'rect', w: 1500, h: 900 }) && !('seats' in c2), `a new table: the patch carries table (${JSON.stringify(c2.table)})`);
    run(T, HOST, { t: 'loadBox', box: T1BOX({ name: 'Plain' }) });
    const c3 = tick();
    ok('seats' in c3 && c3.seats === null, `cleared: seats: null (${JSON.stringify(c3.seats)})`);
    ok(!Object.keys(tick()).some((k) => ['table', 'seats', 'handy'].includes(k)), 'an idle tick carries none of them');
  }

  section('(2b) sizeOf(public item): the type\'s size, the back\'s when hidden, 60 × 60 for a placeholder, 90 × 100 for a bag, a pile its top\'s');
  {
    const boxes = { [BX]: cleanBox(TESTBOX) }, sz = (it) => JSON.stringify(core.sizeOf(it, boxes));
    const cases = [
      [{ k: 'g', t: ref('big'), f: 0 }, { w: 120, h: 120 }, 'a shown big tile'], [{ k: 'g', b: `${BX}/tb` }, { w: 100, h: 100 }, 'a hidden tile (its back)'],
      [{ k: 's', b: `${BX}/db` }, { w: 56, h: 56 }, 'a hidden die supply (its back)'], [{ k: 'g', b: null }, { w: 60, h: 60 }, 'a hidden piece of a missing box'],
      [{ k: 'g', t: 'deadbeef/x', f: 0 }, { w: 60, h: 60 }, 'a shown piece of a missing box'], [{ k: 'b', name: 'x', n: 3 }, { w: 90, h: 100 }, 'a bag'],
      [{ k: 'p', n: 2, top: { t: ref('big'), f: 0, up: true } }, { w: 120, h: 120 }, 'a pile of big tiles'], [{ k: 'p', n: 2, top: { b: `${BX}/tb`, up: false } }, { w: 100, h: 100 }, 'a pile of hidden tiles'],
      [{ k: 'p', n: 2, top: { d: DK, up: false } }, { w: 100, h: 140 }, 'a pile of cards'], [{ k: 'c', d: DK, up: false }, { w: 100, h: 140 }, 'a card'],
      [{ k: 'g', t: ref('board'), f: 0 }, { w: 400, h: 300 }, 'a board'],
    ];
    for (const [it, want, what] of cases) ok(sz(it) === JSON.stringify(want), `${what}: ${sz(it)}`);
    const fl = core.flagsOf({ k: 'g', b: `${BX}/tb` }, boxes);
    ok(fl.rotStep === 90 && fl.hand === true && fl.stack === 'pile' && fl.shape === 'rect', `a hidden piece's other flags come from its back too (${JSON.stringify(fl)})`);
  }

  section('(2b) a box\'s images join assetRefs');
  {
    const H2 = 'cd'.repeat(32), withImg = { ...json(TESTBOX), name: 'Pictures', imgs: [null, H64, H2] };
    const refs = core.assetRefs({}, { x: cleanBox(withImg) });
    ok(refs.has(H64) && refs.has(H2) && refs.size === 2, `assetRefs(decks, boxes) holds the boxes' images (${refs.size})`);
    const T = mk({});
    run(T, HOST, { t: 'loadBox', box: withImg });
    ok(T.assetRefs().has(H64) && T.assetRefs().has(H2), "T.assetRefs() too, once the box is in the catalog: they are what the host serves");
  }
}

function testPubFuzz() {
  section('(4) T.pub equals a full recompute, and §2d, after each of 500 random piece ops; patches fold into the next snapshot');
  for (const seed of [11, 12]) {
    const r = rng(seed), T = mk({}, { env: renv(seed), seed });
    run(T, HOST, { t: 'loadBox', box: FUZZBOX, setup: true });
    const bx = Object.keys(T.boxes).find((id) => T.boxes[id].name === 'Fuzz box'), fref = (t) => `${bx}/${t}`;
    let V = null, first = { pub: '', spec: '', handy: '', fold: '', order: '', leak: '', index: '' };
    const kinds = new Map(), players = [HOST, BOB, CAROL];
    let nOps = 0, changed = 0;
    const tick = (at) => {
      const d = T.takeDirty(), c = T.patchContent(d);
      T.drain();
      const pids = Object.keys(c.items || {});
      if (!first.order && pids.join() !== inOrder(pids).join()) first.order = `${at}: a patch lists items in another order than sorted insertion (${pids.join()})`;
      if (!V) { const sc = json(T.snapContent()); V = { items: sc.items, table: sc.table, seats: sc.seats, handy: sc.handy }; return; }
      Object.assign(V.items, json(c.items || {}));
      for (const id of c.del || []) delete V.items[id];
      for (const k of ['table', 'seats', 'handy']) if (k in c) V[k] = json(c[k]);
      const sc = T.snapContent();
      const bad = ['items', 'table', 'seats', 'handy'].find((k) => sortedJSON(V[k]) !== sortedJSON(sc[k]));
      if (!first.fold && bad) first.fold = `${at}: the folded ${bad} differs from the snapshot`;
    };
    tick('start');
    for (let k = 0; k < 500; k++) {
      const s = T.state, ids = Object.keys(s.items), of = (kk) => ids.filter((id) => s.items[id].k === kk);
      if (ids.length < 15) run(T, HOST, { t: 'loadBox', box: FUZZBOX, setup: true });
      const p = r.pick(players), any = (list) => (list.length && r() < 0.95 ? r.pick(list) : r.pick(['nope', '__proto__'])), xy = () => ({ x: 150 + r() * 1300, y: 150 + r() * 1300 });
      const pieces = of('g'), piles = of('p'), sup = of('s'), bags = of('b'), hand = s.players[p].hand, hi = r.int(hand.length + 1), e = hand[hi] || {};
      const ops = {
        move: () => run(T, p, { t: 'move', id: any(ids), ...xy() }), rot: () => run(T, p, { t: 'rot', id: any(ids), rot: r.int(360) }),
        flip: () => run(T, p, { t: 'flip', id: any(ids) }), face: () => run(T, p, { t: 'face', id: any([...pieces, ...sup]), f: r.int(4) }),
        roll: () => run(T, p, { t: 'roll', ids: [...new Set([any(pieces), any(pieces)])] }), split: () => run(T, p, { t: 'split', id: any(pieces), n: 1 + r.int(2), ...(r() < 0.3 ? { onto: any(pieces) } : xy()) }),
        join: () => run(T, p, { t: 'join', id: any(pieces), onto: any([...pieces, ...sup]) }), take: () => run(T, p, { t: 'take', id: any(sup), ...xy(), hand: r() < 0.3 }),
        pull: () => run(T, p, { t: 'pull', id: any(bags), ...xy(), hand: r() < 0.3 }), toBag: () => run(T, p, { t: 'toBag', id: any(pieces), bag: any(bags) }),
        lock: () => run(T, r() < 0.7 ? HOST : p, { t: 'lock', id: any(ids), on: r() < 0.5 }), owner: () => run(T, r() < 0.4 ? HOST : p, { t: 'owner', id: any(ids), to: r.pick([p, null, BOB, HOST]) }),
        toHand: () => run(T, p, { t: 'toHand', id: any(pieces) }), play: () => run(T, p, { t: 'play', idx: hi, ...('d' in e ? { d: e.d, i: e.i } : { type: e.t, f: e.f }), ...xy(), up: r() < 0.5 }),
        stack: () => run(T, p, { t: 'stack', id: any(pieces), onto: any(pieces) }), toPile: () => run(T, p, { t: 'toPile', id: any(pieces), pile: any(piles) }),
        merge: () => run(T, p, { t: 'merge', id: any(piles), pile: any(piles) }), draw: () => run(T, p, { t: 'draw', id: any(piles) }),
        deal: () => run(T, p, { t: 'deal', id: any(piles), ...xy(), up: r() < 0.5 }), shuffle: () => run(T, p, { t: 'shuffle', id: any(piles) }), peek: () => run(T, p, { t: 'peek', id: any(piles) }),
        handPile: () => run(T, p, { t: 'handPile', idx: hi, ...('d' in e ? { d: e.d, i: e.i } : { type: e.t, f: e.f }), pile: any(piles) }), del: () => run(T, p, { t: 'del', id: any(ids) }),
        seat: () => run(T, r() < 0.3 ? HOST : p, r() < 0.5 ? { t: 'seat', watch: true, p: r.pick(players) } : { t: 'seat', sit: true, p: r.pick(players) }),
        table: () => run(T, HOST, r() < 0.5 ? { t: 'table', shape: 'rect', w: 1500 + r.int(1000), h: 1300 + r.int(600) } : { t: 'table', shape: 'round', w: r.pick([1800, 2400]), h: 0 }),
        't.move': () => run(T, 'RULES', (t) => t.move(any(ids), xy().x, xy().y)), 't.rot': () => run(T, 'RULES', (t) => t.rot(any(ids), r.int(360))),
        't.flip': () => run(T, 'RULES', (t) => t.flip(any(ids))), 't.remove': () => run(T, 'RULES', (t) => t.remove(any(ids))), 't.roll': () => run(T, 'RULES', (t) => t.roll(any(pieces))),
        't.toHand': () => run(T, 'RULES', (t) => t.toHand(p, any(pieces))), 't.playFromHand': () => hand.length && run(T, 'RULES', (t) => t.playFromHand(p, r.int(hand.length), { ...xy(), up: r() < 0.5 })),
        't.newPile': () => run(T, 'RULES', (t) => t.newPile([{ t: fref('tile'), f: r.int(2), up: r() < 0.5 }, { t: fref(r.pick(['tile2', 'open'])), f: 0, up: true }], xy())),
        't.deal': () => run(T, 'RULES', (t) => t.deal(any(piles), r() < 0.5 ? xy() : { to: p })),
      };
      const kind = r.pick(Object.keys(ops));
      nOps = Object.keys(ops).length;
      try { const res = ops[kind](); if (res?.changed) changed++; } catch (err) { if (!first.pub) first.pub = `op ${k} (${kind}) threw ${err.stack}`; }
      kinds.set(kind, (kinds.get(kind) || 0) + 1);
      const at = `seed ${seed}, op ${k} (${kind})`, inc = Object.fromEntries(T.pub), full = T.publicItems();
      if (!first.pub && !isDeepStrictEqual(inc, full)) { const id = Object.keys({ ...inc, ...full }).find((x) => !isDeepStrictEqual(inc[x], full[x])); first.pub = `${at}: ${id} is ${JSON.stringify(inc[id])} in T.pub, ${JSON.stringify(full[id])} in full`; }
      const spec = Object.fromEntries(Object.entries(T.state.items).map(([id, it]) => [id, specPub(it, T.state.boxes)]));
      if (!first.spec && sortedJSON(inc) !== sortedJSON(spec)) { const id = Object.keys({ ...inc, ...spec }).find((x) => sortedJSON(inc[x]) !== sortedJSON(spec[x])); first.spec = `${at}: ${id} is ${JSON.stringify(inc[id])}, §2d says ${JSON.stringify(spec[id])}`; }
      if (!first.handy && T.handy !== specHandy(T.state)) first.handy = `${at}: T.handy ${T.handy}, the spec counts ${specHandy(T.state)}`;
      if (!first.index) {
        const scan = (key) => { const m = new Map(); for (const [id, it] of Object.entries(T.state.items)) { const kk = key(it); if (kk) (m.get(kk) || m.set(kk, new Set()).get(kk)).add(id); } return m; };
        const same = (idx, want) => isDeepStrictEqual(new Map([...idx].filter(([, set]) => set.size).map(([kk, set]) => [kk, [...set].sort()])), new Map([...want].map(([kk, set]) => [kk, [...set].sort()])));
        const kindsOk = ['c', 'p', 'g', 's', 'b'].every((kk) => isDeepStrictEqual([...(T.byKind.get(kk) || [])].sort(), Object.keys(T.state.items).filter((id) => T.state.items[id].k === kk).sort()));
        const bad = !kindsOk ? 'byKind' : !same(T.byType, scan((it) => (it.k === 'g' || it.k === 's') && it.t)) ? 'byType' : !same(T.byOwner, scan((it) => it.owner)) ? 'byOwner' : '';
        if (bad) first.index = `${at}: T.${bad} disagrees with a scan of the state`;
      }
      const leak = Object.entries(inc).find(([, it]) => ((it.k === 'g' || it.k === 's') && !('t' in it) && ('f' in it || 'up' in it)) || ('b' in it && 't' in it) || 'of' in it || 'cards' in it);
      if (!first.leak && leak) first.leak = `${at}: ${JSON.stringify(leak)}`;
      if (r() < 0.35) tick(at);
    }
    tick('the end');
    console.log(`    seed ${seed}: ${kinds.size} op kinds, ${changed} of 500 ops changed the table, ${Object.keys(T.state.items).length} items at the end`);
    ok(!first.pub, `seed ${seed}: T.pub deep-equals publicItems() after every op ${first.pub}`);
    ok(!first.spec, `seed ${seed}: and equals §2d's table, item by item ${first.spec}`);
    ok(!first.handy, `seed ${seed}: T.handy equals the spec's count after every op ${first.handy}`);
    ok(!first.index, `seed ${seed}: the indexes (byKind for c, p, g, s, b; byType; byOwner) agree with a scan after every op ${first.index}`);
    ok(!first.leak, `seed ${seed}: no public item carries a hidden piece's t/f/up, a bag's of or a pile's cards ${first.leak}`);
    ok(!first.fold && !first.order, `seed ${seed}: patches (items, del, table, seats, handy), folded, reproduce the next snapshot; items in sorted order ${first.fold} ${first.order}`);
    ok(kinds.size === nOps && changed > 200, `seed ${seed}: every op kind ran (${kinds.size} of ${nOps}), ${changed} of them changing the table`);
  }
}

// =============================================================================
// (5) Seats
// =============================================================================
const RAD = Math.PI / 180, deg = (a) => ((a % 360) + 360) % 360;
const angleTo = (dx, dy) => deg(Math.atan2(dy, dx) / RAD);
const angEq = (a, b, eps = 1e-6) => Math.abs(((a - b + 540) % 360) - 180) < eps;
/** §2a's seat point for angle a: round, centre + SEAT_R·(cos, sin) with SEAT_R = size/2 − 50 (as today);
 *  rect, where the ray from the centre meets the table inset by 50. */
function rimPoint(tb, a) {
  const c = Math.cos(a * RAD), s = Math.sin(a * RAD), cx = tb.w / 2, cy = tb.h / 2;
  if (tb.shape !== 'rect') return { x: cx + (tb.w / 2 - 50) * c, y: cy + (tb.w / 2 - 50) * s };
  const t = Math.min(Math.abs(c) > 1e-12 ? (cx - 50) / Math.abs(c) : Infinity, Math.abs(s) > 1e-12 ? (cy - 50) / Math.abs(s) : Infinity);
  return { x: cx + t * c, y: cy + t * s };
}
/** Arc length of perimeter point p (the table inset by 50) from the middle of the bottom edge, toward the left first (growing angles). */
function arcOf(tb, p) {
  const L = 50, R = tb.w - 50, Tp = 50, B = tb.h - 50, cx = tb.w / 2, w = R - L, h = B - Tp, e = 1e-6;
  if (Math.abs(p.y - B) < e && p.x <= cx + e) return cx - p.x;
  if (Math.abs(p.x - L) < e) return cx - L + (B - p.y);
  if (Math.abs(p.y - Tp) < e) return cx - L + h + (p.x - L);
  if (Math.abs(p.x - R) < e) return cx - L + h + w + (p.y - Tp);
  if (Math.abs(p.y - B) < e) return cx - L + 2 * h + w + (R - p.x);
  return NaN;
}
/** Whether x sits in the middle of one of the largest gaps between `pos` on a circle of length P. */
function inLargestGap(pos, x, P, tol) {
  const s = [...pos].sort((a, b) => a - b), gaps = s.map((a, k) => { const b = k + 1 < s.length ? s[k + 1] : s[0] + P; return [b - a, (a + (b - a) / 2) % P]; });
  const max = Math.max(...gaps.map((g) => g[0]));
  return gaps.some(([len, mid]) => len >= max - tol && Math.min(Math.abs(mid - x), P - Math.abs(mid - x)) < tol);
}
const PIDS = range(9).map((k) => String(k + 1).repeat(16));
const T1BOX = (extra) => ({ name: 'Seats', imgs: [], types: { m: { kind: 'token', name: 'Man', faces: ['M'] }, n: { kind: 'token', name: 'Nan', faces: ['N'] } }, ...extra });

function testSeats() {
  section('(5) automatic seating: largest gap by angle (round), by arc length along the perimeter (rect)');
  for (const tb of [{ shape: 'round', w: 1800, h: 1800 }, { shape: 'rect', w: 1400, h: 1200 }, { shape: 'rect', w: 3000, h: 800 }]) {
    const T = createTable({ v: 3, table: json(tb) }, renv(5)), rect = tb.shape === 'rect';
    T.open('Alice');
    const P = rect ? 2 * (tb.w - 100) + 2 * (tb.h - 100) : 360, pos = (a) => (rect ? arcOf(tb, rimPoint(tb, a)) : deg(a));
    const seen = [T.state.players[HOST].seat];
    let bad = T.state.players[HOST].seat === 90 ? '' : `the first player sits at ${T.state.players[HOST].seat}, not 90`;
    for (const p of PIDS.slice(0, 7)) {
      const before = Object.values(T.state.players).map((pl) => pos(pl.seat));
      T.join(p, `P${p[0]}`, keyOf(p));
      const a = T.state.players[p].seat;
      if (!bad && !(Number.isFinite(a) && inLargestGap(before, pos(a), P, rect ? 0.5 : 1e-6))) bad = `player ${before.length + 1} sat at ${a}° (arc ${pos(a)?.toFixed(1)} of ${P}), not in the middle of a largest gap of ${before.map((x) => x.toFixed(1)).join(', ')}`;
      seen.push(a);
    }
    ok(!bad, `${tb.shape} ${tb.w} × ${tb.h}: the first sits at the bottom (90°), each next one in the middle of a largest gap${rect ? ' along the inset perimeter' : ''} (${seen.map((a) => a.toFixed(1)).join(', ')}) ${bad}`);
  }

  section('(5) named seats: placement on round and rect tables');
  {
    const players = Object.fromEntries([HOST, BOB, CAROL, DAVE, PIDS[0], PIDS[1]].map((p, k) => [p, player(NAMES[p] || `P${k}`, [90, 270, 0, 180, 45, 135][k])]));
    const SIX = T1BOX({ seats: [{ id: 'l1', name: 'L1', edge: 'left' }, { id: 'l2', name: 'L2', edge: 'left' }, { id: 't', name: 'T', edge: 'top' }, { id: 'r', name: 'R', edge: 'right' }, { id: 'g', name: 'G', angle: 45 }, { id: 'p', name: 'P', at: [900, 100] }] });
    const T = mk({}, { players: json(players) });
    run(T, HOST, { t: 'loadBox', box: SIX });
    const angle = (id) => Object.values(T.state.players).find((pl) => pl.seatId === id)?.seat;
    const want = { l1: 165, l2: 195, t: 270, r: 0, g: 45, p: 270 };
    ok(Object.entries(want).every(([id, a]) => angEq(angle(id), a)), `round: left ×2 at 180° ± 15°, top 270°, right 0°, angle 45°, at [900, 100] → atan2 = 270° (${Object.keys(want).map((id) => `${id} ${angle(id)}`).join(', ')})`);
    const U = mk({}, { players: json(players) });
    run(U, HOST, { t: 'loadBox', box: T1BOX({ seats: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] }) });
    const ua = (id) => Object.values(U.state.players).find((pl) => pl.seatId === id)?.seat;
    ok(angEq(ua('a'), 60) && angEq(ua('b'), 90) && angEq(ua('c'), 120), `round: three seats on the bottom edge spread 30° apart around 90° in declaration order (${ua('a')}, ${ua('b')}, ${ua('c')})`);
    const rt = { shape: 'rect', w: 1400, h: 1200 };
    const R = mk({}, { players: json(players) });
    run(R, HOST, { t: 'loadBox', box: T1BOX({ table: rt, seats: [{ id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2', edge: 'bottom' }, { id: 't1', name: 'T1', edge: 'top' }, { id: 'l1', name: 'L1', edge: 'left' }, { id: 'l2', name: 'L2', edge: 'left' }, { id: 'r1', name: 'R1', edge: 'right' }] }) });
    const ra = (id) => Object.values(R.state.players).find((pl) => pl.seatId === id)?.seat, pt = (id) => rimPoint(rt, ra(id));
    // (k+1)/(m+1) along the edge: of the table's edge, or of the inset one — either reading.
    const at = (f, len) => [len * f, 50 + (len - 100) * f];
    const onB = (id, f) => near(pt(id).y, 1150, 1e-6) && at(f, 1400).some((x) => near(pt(id).x, x, 1e-6));
    const onL = (id, f) => near(pt(id).x, 50, 1e-6) && at(f, 1200).some((y) => near(pt(id).y, y, 1e-6));
    ok(onB('b1', 1 / 3) && onB('b2', 2 / 3) && pt('b1').x < pt('b2').x, `rect: two bottom seats at 1/3 and 2/3 along it, by growing x (${JSON.stringify([pt('b1'), pt('b2')])})`);
    ok(onL('l1', 1 / 3) && onL('l2', 2 / 3) && pt('l1').y < pt('l2').y, `rect: two left seats at 1/3 and 2/3, by growing y (${JSON.stringify([pt('l1'), pt('l2')])})`);
    ok(angEq(ra('t1'), 270) && angEq(ra('r1'), 0), `rect: one seat on the top and the right edges, at their middles (${ra('t1')}, ${ra('r1')})`);
    run(R, HOST, { t: 'table', shape: 'rect', w: 2000, h: 1200 });
    const nb = rimPoint(R.state.table, ra('b1'));
    ok(near(nb.y, 1150, 1e-6) && [2000 / 3, 50 + 1900 / 3].some((x) => near(nb.x, x, 1e-6)), `a new table re-places the named seats (b1 now at ${nb.x.toFixed(1)}, ${nb.y})`);
  }

  section('(5) setup positions in a seat\'s frame: \'seat\' and {seat: [dx, dy]} (dx to its right, dy toward the table)');
  {
    const ONEPER = T1BOX({ table: { shape: 'rect', w: 1400, h: 1200 }, seats: ['bottom', 'top', 'left', 'right'].map((e) => ({ id: e, name: e, edge: e })),
      setup: [{ forEachSeat: [{ piece: 'm', at: { seat: [50, 120] }, owner: 'seat' }, { piece: 'n', at: 'seat', owner: 'seat' }] }] });
    const T = mk({});
    run(T, HOST, { t: 'loadBox', box: ONEPER, setup: true, clear: true });
    const centre = (t, seat) => { const it = Object.values(items(T)).find((x) => x.t.endsWith(`/${t}`) && x.owner === `seat:${seat}`); return it && [it.x + 30, it.y + 30]; };
    const want = { m: { bottom: [750, 1030], top: [650, 170], left: [170, 650], right: [1230, 550] }, n: { bottom: [700, 1030], top: [700, 170], left: [170, 600], right: [1230, 600] } };
    const got = Object.fromEntries(['m', 'n'].map((t) => [t, Object.fromEntries(Object.keys(want.m).map((sd) => [sd, centre(t, sd)]))]));
    const close = Object.keys(want).every((t) => Object.keys(want.m).every((sd) => got[t][sd] && near(got[t][sd][0], want[t][sd][0]) && near(got[t][sd][1], want[t][sd][1])));
    ok(close, `rect, one seat per edge: centres at the seat point + dx·right + dy·inward ('seat' = {seat: [0, 120]}): ${JSON.stringify(got)}`);
    const ROUND = T1BOX({ seats: [{ id: 's', name: 'S' }, { id: 'g', name: 'G', angle: 45 }], setup: [{ forEachSeat: [{ piece: 'm', at: 'seat', owner: 'seat' }] }] });
    const U = mk({});
    run(U, HOST, { t: 'loadBox', box: ROUND, setup: true, clear: true });
    const c = (seat) => { const it = Object.values(items(U)).find((x) => x.owner === `seat:${seat}`); return it && [it.x + 30, it.y + 30]; };
    const g = 900 + 730 * Math.SQRT1_2;
    ok(c('s') && near(c('s')[0], 900) && near(c('s')[1], 1630) && near(c('g')[0], g) && near(c('g')[1], g),
      `round: 'seat' is the seat point (centre + 850·(cos, sin)) moved 120 toward the centre (${JSON.stringify([c('s'), c('g')])})`);
  }

  section('(5) setting the named seats: online first, then offline, each clockwise from the bottom; the log');
  {
    const T = mk({}, { players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270), [CAROL]: player('Carol', 0, { online: false }), [DAVE]: player('Dave', 180, { online: false }) } });
    const r = run(T, HOST, { t: 'loadBox', box: T1BOX({ seats: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }, { id: 'three', name: 'Three' }] }) });
    const ids = Object.fromEntries(Object.entries(T.state.players).map(([p, pl]) => [NAMES[p], pl.seatId ?? null]));
    ok(isDeepStrictEqual(ids, { Alice: 'one', Bob: 'two', Carol: null, Dave: 'three' }) && T.state.players[CAROL].seat === null, `Alice (online, 90°), Bob (online, 270°), Dave (offline, 180°) take the seats; Carol (offline, 0°) watches (${JSON.stringify(ids)})`);
    ok(r.log.includes('Seats: One — Alice, Two — Bob, Three — Dave · watching: Carol'), `logged "Seats: One — Alice, Two — Bob, Three — Dave · watching: Carol" (${JSON.stringify(r.log)})`);
    const angles = Object.fromEntries([HOST, BOB, DAVE].map((p) => [p, T.state.players[p].seat]));
    const rc = run(T, HOST, { t: 'loadBox', box: T1BOX({ name: 'No seats' }) });
    ok(T.state.seats === null && Object.values(T.state.players).every((pl) => !('seatId' in pl)) && [HOST, BOB, DAVE].every((p) => T.state.players[p].seat === angles[p]),
      'clearing the named seats (a box without seats): seatId goes, the seated keep their angles');
    ok(Number.isFinite(T.state.players[CAROL].seat) && inLargestGap(Object.values(angles), T.state.players[CAROL].seat, 360, 1e-6), `and the watcher gets a seat: the middle of the largest gap (${T.state.players[CAROL].seat}°)`);
    ok(rc.log.length >= 1, `clearing is logged (${JSON.stringify(rc.log)})`);
  }

  section('(5) joining with named seats: keep yours, else the first free (offline seats are held), else watch');
  {
    const T = mk({}, { players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270) } });
    run(T, HOST, { t: 'loadBox', box: T1BOX({ seats: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] }) });
    const sid = (p) => T.state.players[p]?.seatId ?? null;
    ok(sid(HOST) === 'a' && sid(BOB) === 'b', 'Alice and Bob take a and b');
    T.join(CAROL, 'Carol', keyOf(CAROL));
    ok(sid(CAROL) === 'c', 'Carol joins: the first free seat, c');
    T.join(DAVE, 'Dave', keyOf(DAVE));
    ok(sid(DAVE) === null && T.state.players[DAVE].seat === null, 'Dave joins: no free seat, he watches (seat null, no seatId)');
    T.leave(BOB);
    T.join(PIDS[0], 'Eve', keyOf(PIDS[0]));
    ok(sid(BOB) === 'b' && sid(PIDS[0]) === null, "Bob leaves: his seat is held for him; Eve joins and watches");
    T.join(BOB, 'Bob', keyOf(BOB));
    ok(sid(BOB) === 'b' && T.state.players[BOB].online, 'Bob comes back to his seat');
    run(T, HOST, { t: 'seat', watch: true });
    run(T, BOB, { t: 'seat', watch: true });
    T.join(PIDS[1], 'Fay', keyOf(PIDS[1]));
    ok(sid(PIDS[1]) === 'a', `with a and b free, Fay takes a (the first in declaration order) (${sid(PIDS[1])})`);
  }

  section('(5) the seat action; seat-bound owners follow the seat; t.players and watchers');
  {
    const LD = T1BOX({ seats: [{ id: 'light', name: 'Light', edge: 'bottom' }, { id: 'dark', name: 'Dark', edge: 'top' }] });
    const T = mk({ w: P('tok', { owner: 'seat:light' }) });
    let r = run(T, HOST, { t: 'loadBox', box: LD });
    ok(r.log.includes('Seats: Light — Alice, Dark — Bob · watching: Carol'), `"Seats: Light — Alice, Dark — Bob · watching: Carol" (${JSON.stringify(r.log)})`);
    ok(happened(run(T, HOST, { t: 'move', id: 'w', x: 700, y: 700 })) && refusedBy(run(T, BOB, { t: 'move', id: 'w', x: 600, y: 600 }), BELONGS('Light')), `a piece owned by seat:light: Alice (in Light) moves it, Bob gets "${BELONGS('Light')}"`);
    ok(isDeepStrictEqual(T.api.find({ owner: HOST }).map((x) => x.id), ['w']) && !T.api.find({ owner: BOB }).length, "t.find({owner: Alice}) finds what her seat owns");
    ok(isDeepStrictEqual(T.api.players().map((x) => x.id).sort(), [HOST, BOB].sort()) && T.api.players({ all: true }).length === 3 && T.api.players({ all: true }).find((x) => x.id === CAROL).seat === null,
      't.players() leaves the watcher out; t.players({all: true}) has her, with seat null');
    ok(T.api.players().find((x) => x.id === HOST).seatId === 'light', 't.players() entries carry seatId');
    for (const [what, p, a, msg] of [["Bob takes the host's seat (attacker case 7)", BOB, { id: 'light' }, '🚫 That seat is taken'], ['Bob seats Carol (p is host-only)', BOB, { id: 'light', p: CAROL }],
      ['Carol sits in no seat', CAROL, { id: 'nope' }], ['Carol sits in "__proto__"', CAROL, { id: '__proto__' }], ['Carol asks for two things', CAROL, { id: 'dark', watch: true }],
      ['Carol sits down with named seats', CAROL, { sit: true }], ['Carol sends nothing', CAROL, {}]]) {
      r = run(T, p, { t: 'seat', ...a });
      ok(refusedBy(r, msg) && r.notes.length === 1, `${what}: refused${msg ? ` ("${msg}")` : ''} — ${why(r)}`);
    }
    ok(({}).seatId === undefined && Object.getPrototypeOf(T.state.players) === Object.prototype, 'no prototype pollution');
    r = run(T, HOST, { t: 'seat', watch: true, p: BOB });
    ok(r.log[0] === 'moved Bob to the watchers' && T.state.players[BOB].seat === null && !('seatId' in T.state.players[BOB]), `the host moves Bob to the watchers: "moved Bob to the watchers" (${JSON.stringify(r.log)})`);
    r = run(T, HOST, { t: 'seat', id: 'dark', p: CAROL });
    ok(r.log[0] === 'moved Carol to Dark' && T.state.players[CAROL].seatId === 'dark' && angEq(T.state.players[CAROL].seat, 270), `and seats Carol: "moved Carol to Dark" (${JSON.stringify(r.log)})`);
    r = run(T, HOST, { t: 'seat', watch: true });
    ok(r.log[0] === 'stood up to watch' && T.state.players[HOST].seat === null, `Alice stands up: "stood up to watch" (${JSON.stringify(r.log)})`);
    r = run(T, BOB, { t: 'seat', id: 'light' });
    ok(r.log[0] === 'sat down as Light' && T.state.players[BOB].seatId === 'light' && angEq(T.state.players[BOB].seat, 90), `Bob sits in Light: "sat down as Light" (${JSON.stringify(r.log)})`);
    ok(happened(run(T, BOB, { t: 'move', id: 'w', x: 650, y: 650 })) && refusedBy(run(T, HOST, { t: 'move', id: 'w', x: 600, y: 600 }), BELONGS('Light')), 'the seat-bound piece follows the seat: now Bob moves it, and Alice is refused');
    ok(isDeepStrictEqual(T.api.find({ owner: BOB }).map((x) => x.id), ['w']), 't.find({owner: Bob}) now finds it');
    r = run(T, HOST, { t: 'owner', id: 'w', to: 'seat:dark' });
    ok(happened(r) && items(T).w.owner === 'seat:dark' && r.log[0] === 'gave A to Dark', `the host gives it to a seat: "gave A to Dark" (${JSON.stringify(r.log)})`);
    ok(happened(run(T, CAROL, { t: 'owner', id: 'w', to: BOB })) && items(T).w.owner === BOB, "Carol (in Dark) resolves as its owner, and passes it to Bob");
  }

  section('(5) watchers under automatic seating sit down again');
  {
    const T = mk({});
    let r = run(T, BOB, { t: 'seat', watch: true });
    ok(r.log[0] === 'stood up to watch' && T.state.players[BOB].seat === null && !T.api.players().some((x) => x.id === BOB), 'Bob stands up: a watcher, out of t.players()');
    r = run(T, BOB, { t: 'seat', sit: true });
    const a = T.state.players[BOB].seat;
    ok(r.log[0] === 'sat down' && Number.isFinite(a) && inLargestGap([90, 0], a, 360, 1e-6), `{sit: true}: "sat down", in the middle of the largest gap (${a}°)`);
    ok(refusedBy(run(T, BOB, { t: 'seat', sit: true })), 'sitting down again while seated changes nothing');
    r = run(T, HOST, { t: 'seat', watch: true, p: CAROL });
    ok(r.log[0] === 'moved Carol to the watchers', `the host moves Carol to the watchers (${JSON.stringify(r.log)})`);
    r = run(T, CAROL, { t: 'seat', sit: true });
    ok(r.log[0] === 'sat down' && Number.isFinite(T.state.players[CAROL].seat), 'and she sits down again');
  }
}

// =============================================================================
// (6) MIGRATE[2] and the board z band
// =============================================================================
function testMigrate() {
  section('(6) MIGRATE[2]: size → table, seats null, boardSeq 0, v 3');
  ok(STATE_V === 3, `STATE_V is 3 (${STATE_V})`);
  const v2 = { v: 2, seq: 5, size: 1800, zMax: 3, keys: { [BOB]: keyOf(BOB) }, log: [{ p: HOST, txt: 'hi', ts: 1 }],
    items: { c1: { k: 'c', d: DK, i: 3, up: true, x: 500, y: 500, rot: 0, z: 1 }, p1: { k: 'p', name: 'Deck', cards: [{ d: DK, i: 1, up: false }], x: 600, y: 600, rot: 90, z: 3 } },
    players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270, { online: false }) } };
  const m = MIGRATE[2](json(v2));
  ok(isDeepStrictEqual(m.table, { shape: 'round', w: 1800, h: 1800 }) && !('size' in m) && m.seats === null && m.boardSeq === 0 && m.v === 3, `{size: 1800} → table {round, 1800, 1800}, no size, seats null, boardSeq 0, v 3 (${JSON.stringify({ table: m.table, seats: m.seats, boardSeq: m.boardSeq, v: m.v })})`);
  ok(isDeepStrictEqual(m.items, v2.items) && m.players[HOST].seat === 90 && m.players[BOB].seat === 270 && isDeepStrictEqual(m.keys, v2.keys) && m.seq === 5, 'items, players (their seat angles), keys and seq are untouched');
  const v1 = { size: 2400, seq: 2, items: {}, players: { [BOB]: { ...player('Bob', 270), key: keyOf(BOB) } } };
  const m1 = migrate(json(v1));
  ok(m1.v === 3 && isDeepStrictEqual(m1.table, { shape: 'round', w: 2400, h: 2400 }) && m1.keys[BOB] === keyOf(BOB) && !('key' in m1.players[BOB]) && m1.seats === null, 'a v1 save climbs the whole chain to v3');
  const T = quietly(() => createTable(json(v2), renv(1))).value;
  ok(T.state.v === 3 && isDeepStrictEqual(T.state.table, { shape: 'round', w: 1800, h: 1800 }) && T.snapContent().table.w === 1800, 'createTable over a v2 save: a v3 table, round 1800');
  let threw = null;
  try { quietly(() => createTable({ ...json(v2), v: 4 }, renv(1))); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'a save from a newer version is refused, never downgraded');

  section('(6) the board z band: BOARD_Z0 + (++boardSeq), newer boards above older, below everything else');
  const BOARDS = { name: 'Boards', imgs: [], table: { shape: 'rect', w: 2000, h: 1500 }, types: { b: { kind: 'board', name: 'Map', w: 400 }, r: { kind: 'board', name: 'Rack', w: 200, h: 80 }, k: { kind: 'token', name: 'K', faces: ['K'] } },
    setup: [{ piece: 'k', at: [100, 100] }, { piece: 'b', at: [300, 300] }, { piece: 'r', at: [400, 400] }, { piece: 'k', at: [500, 500] }] };
  const U = mk({});
  run(U, HOST, { t: 'loadBox', box: BOARDS, setup: true, clear: true });
  const of = (tid) => Object.entries(items(U)).filter(([, it]) => it.t.endsWith(`/${tid}`));
  const [[bId, b]] = of('b'), [[, rk]] = of('r'), ks = of('k').map(([, it]) => it);
  ok(core.BOARD_Z0 === -1e6 && b.z === -1e6 + 1 && rk.z === -1e6 + 2 && U.state.boardSeq === 2, `the boards take z = −1,000,000 + 1 and + 2 in setup order (${b.z}, ${rk.z}), boardSeq 2`);
  ok(ks.every((k) => k.z >= 0) && b.lock === true, 'tokens stay at z ≥ 0; a board spawns locked');
  run(U, HOST, { t: 'loadBox', box: { ...BOARDS, name: 'Boards 2', setup: [{ piece: 'b', at: [700, 700] }] }, setup: true });
  const newest = Object.values(items(U)).filter((it) => it.t.endsWith('/b')).map((it) => it.z).sort((x, y) => x - y);
  ok(isDeepStrictEqual(newest, [-1e6 + 1, -1e6 + 3]), `a newer board sits above the older ones (${newest})`);
  run(U, HOST, { t: 'lock', id: bId, on: false });
  run(U, HOST, { t: 'move', id: bId, x: 900, y: 900 });
  ok(items(U)[bId].x === 900 && items(U)[bId].z === -1e6 + 1, 'moving a board never changes its z');
  run(U, 'RULES', (t) => t.move(bId, 950, 950));
  ok(items(U)[bId].z === -1e6 + 1, 'nor does a script move');
  const saved = { ...json(U.snapshot()), boxes: json(U.state.boxes), boardSeq: 0 }, V = quietly(() => createTable(json(saved), renv(2))).value;
  ok(V.state.boardSeq === 3, `createTable restores boardSeq from the boards' z (saved 0, restored ${V.state.boardSeq})`);
  run(V, HOST, { t: 'loadBox', box: { ...BOARDS, name: 'Boards 3', setup: [{ piece: 'r', at: [100, 900] }] }, setup: true });
  ok(Object.values(items(V)).some((it) => it.z === -1e6 + 4), 'so the next board goes on top of them (−1,000,000 + 4)');
  const W = quietly(() => createTable({ ...json(saved), boardSeq: undefined }, renv(2))).value;
  ok(W.state.boardSeq === 3, 'also when the save has no boardSeq');

  section('(2h) the load order: the catalog\'s boxes, cleanBox, then the items — a missing box leaves placeholders, loudly');
  const good = cleanBox(TESTBOX), save = {
    v: 3, seq: 9, table: { shape: 'round', w: 1800, h: 1800 }, seats: null, boardSeq: 0, zMax: 5, keys: {}, log: [], rules: null, guestDeckChars: 0,
    players: { [HOST]: player('Alice', 90) }, decks: {}, boxSrc: { [BX]: { src: 'host' }, bad00000: { src: 'host' } },
    boxes: { [BX]: good, bad00000: { name: 'Bad', types: { x: { kind: 'token', name: 'X', faces: ['x'], shape: 'blob' } } } },
    items: { a: P('tok'), h: P('x', { t: 'bad00000/x', up: false }), s: P('x', { t: 'bad00000/x', f: 0, x: 600 }), m: P('y', { t: 'cafe0000/y', up: false, x: 700 }) },
  };
  const R = quietly(() => createTable(json(save), renv(4))).value;
  const q = quietly(() => R.resume('Alice'));
  ok(isDeepStrictEqual(Object.keys(R.boxes), [BX]) && q.error.some((e) => /box/i.test(e)), `a saved box that fails cleanBox is dropped, with console.error (${JSON.stringify(q.error.slice(0, 2))})`);
  ok(['a', 'h', 's', 'm'].every((id) => R.state.items[id]) && q.error.some((e) => /missing|placeholder|"\?"/i.test(e)), 'its pieces, and pieces of a box never saved, stay on the table — said with console.error');
  const pub = Object.fromEntries(R.pub);
  ok(pub.h.b === null && !('t' in pub.h) && !('f' in pub.h) && pub.m.b === null && pub.s.t === 'bad00000/x', `hidden ones show b: null, never t or f; shown ones keep t, f (${JSON.stringify([pub.h, pub.s])})`);
  ok(!Object.keys(BOXES).some((k) => Object.values(R.boxes).some((b) => b.name === BOXES[k].name)), 'built-in boxes are not pre-registered');
}

// =============================================================================
// (7) randInt
// =============================================================================
function testRandInt() {
  section('(7) randInt: uniform, crypto, rejection sampling (no modulo bias)');
  const CRIT = 20.515; // χ², 5 degrees of freedom, 99.9 %
  const chi2 = () => {
    const c = range(6).map(() => 0);
    for (let k = 0; k < 60000; k++) c[randInt(6)]++;
    return [c.reduce((s, x) => s + (x - 10000) ** 2 / 10000, 0), c];
  };
  let [x2, counts] = chi2(), note = '';
  // A χ² test at 99.9 % fails a fair source one run in 1,000: a second, fresh sample confirms a failure (a real bias fails both).
  if (x2 >= CRIT) { note = ` (first sample ${x2.toFixed(2)}: drew again)`; [x2, counts] = chi2(); }
  ok(x2 < CRIT, `χ² of 60,000 draws of randInt(6) is ${x2.toFixed(2)} < ${CRIT} (99.9 %, 5 df)${note} — counts ${counts.join(' ')}`);
  // A modulo bias shows plainly where 2^32 is far from a multiple of n: with n = 3·2^30, `word % n`
  // would put half the draws below 2^30 instead of a third.
  let low = 0;
  for (let k = 0; k < 60000; k++) if (randInt(3 * 2 ** 30) < 2 ** 30) low++;
  ok(Math.abs(low - 20000) < 600, `randInt(3·2^30): ${low} of 60,000 below 2^30 (a third is 20,000 ± 115; modulo bias would give 30,000)`);
  ok(range(100).every(() => randInt(1) === 0) && range(100).every(() => { const v = randInt(2 ** 32); return Number.isInteger(v) && v >= 0 && v < 2 ** 32; }), 'randInt(1) is 0; randInt(2^32) stays in range');
  const throws = [0, -1, 1.5, NaN, 2 ** 32 + 1, '6'].filter((n) => { try { randInt(n); return false; } catch { return true; } });
  ok(throws.length === 6, `randInt refuses n = 0, −1, 1.5, NaN, 2^32 + 1 and "6" (${throws.length} of 6 threw)`);

  section('(7) every engine draw goes through env.randInt');
  const calls = [];
  const T = mk({ d: P('die'), g: BAG([{ t: 'tok', f: 0 }, { t: 'tok', f: 1 }, { t: 'tok', f: 2 }]), p: PILE(cardsOf(5)) }, { env: { pid: HOST, now: () => 1.7e12, uid: renv(1).uid, randInt: (n) => { calls.push(n); return n - 1; } } });
  run(T, BOB, { t: 'roll', ids: ['d'] });
  const n0 = Object.keys(items(T));
  run(T, BOB, { t: 'pull', id: 'g', x: 300, y: 300 });
  const pulled = items(T)[newIds(T, n0)[0]];
  run(T, BOB, { t: 'shuffle', id: 'p' });
  const order = items(T).p.cards.map((c) => c.i).join();
  T.apply(HOST, { t: 'setRules', enabled: true, code: "({ name: 'R', buttons: () => [{ id: 'x', label: 'X' }], onButton(t) { t.data.r = t.random(); } })" });
  T.apply(BOB, { t: 'rulesBtn', id: 'x' });
  ok(items(T).d.f === 5 && pulled?.f === 2 && order === '0,1,2,3,4' && T.api.data.r === (2 ** 32 - 1) / 2 ** 32,
    `with env.randInt(n) = n − 1: the roll is 6, the pull takes the last member, the shuffle swaps nothing, t.random() = (2^32 − 1)/2^32 (${items(T).d.f}, ${pulled?.f}, ${order}, ${T.api.data.r})`);
  ok(calls.includes(6) && calls.includes(3) && calls.includes(2 ** 32), `the engine asked for randInt(6), randInt(3) and randInt(2^32) (${[...new Set(calls)].join(', ')})`);
}

// =============================================================================
// (8) The built-in boxes (§2g)
// =============================================================================
function testBuiltins() {
  section('(8) BOXES.draughts as §2g describes it');
  {
    const B = cleanBox(json(BOXES.draughts));
    ok(isDeepStrictEqual(B.table, { shape: 'rect', w: 1400, h: 1200 }), `a 1400 × 1200 rect table (${JSON.stringify(B.table)})`);
    const seat = (id) => B.seats?.find((s) => s.id === id);
    ok(B.seats?.length === 2 && seat('light')?.edge === 'bottom' && seat('light').color === '#f5f5f4' && seat('dark')?.edge === 'top' && seat('dark').color === '#1c1917', `seats light (bottom, #f5f5f4) and dark (top, #1c1917) (${JSON.stringify(B.seats)})`);
    const boards = Object.values(B.types).filter((t) => t.kind === 'board'), men = Object.entries(B.types).filter(([, t]) => t.kind === 'token');
    const g = boards[0]?.board?.grid;
    ok(boards.length === 1 && boards[0].w === 840 && boards[0].h === 840 && g && g.type === 'square' && g.cols === 8 && g.rows === 8 && g.cell === 100 && g.x === 20 && g.y === 20 && g.draw === 'checker' && isDeepStrictEqual(g.colors, ['#f0d9b5', '#b58863']) && g.labels === 'chess',
      `an 840 × 840 board, 8 × 8 grid of cell 100 at (20, 20), checker, #f0d9b5 / #b58863, chess labels (${JSON.stringify(g)})`);
    ok(men.length === 2 && men.every(([, t]) => t.shape === 'disc' && t.w === 80 && t.h === 80 && t.stack === 'none' && t.faces.length === 2 && !t.faces[0].label && t.faces[1].label === '♛'),
      `men: two token types, disc 80 × 80, stack none; face 0 plain, face 1 "♛" (${JSON.stringify(men.map(([, t]) => t.faces))})`);
    const T = mk({}, { players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270) } });
    run(T, HOST, { t: 'loadBox', box: json(BOXES.draughts), setup: true, clear: true });
    const all = Object.values(items(T)), board = all.find((it) => T.boxes[it.t.split('/')[0]].types[it.t.split('/')[1]].kind === 'board'), pieces = all.filter((it) => it !== board);
    ok(board && board.x + 420 === 700 && board.y + 420 === 600 && board.lock === true && pieces.length === 24, `loaded: the board centred and locked, 24 men (${pieces.length})`);
    const sq = (it) => [(it.x + 40 - board.x - 20) / 100 - 0.5, (it.y + 40 - board.y - 20) / 100 - 0.5];
    const off = pieces.filter((it) => { const [c, r] = sq(it); return !(Number.isInteger(c) && Number.isInteger(r) && c >= 0 && c < 8 && r >= 0 && r < 8 && (c + r) % 2 === 1); });
    ok(!off.length, `every man is centred on a dark square (a1's colour: (c + r) odd) (${off.length} are not)`);
    const side = (o) => pieces.filter((it) => it.owner === o);
    ok(side('seat:light').length === 12 && side('seat:dark').length === 12 && side('seat:light').every((it) => sq(it)[1] >= 5) && side('seat:dark').every((it) => sq(it)[1] <= 2),
      '12 men per side, owned by seat:light (the three rows nearest the bottom seat) and seat:dark (the top three)');
    const man = Object.keys(items(T)).find((id) => items(T)[id].owner === 'seat:light');
    const r = run(T, HOST, { t: 'flip', id: man });
    ok(happened(r) && items(T)[man].f === 1 && T.api.type(items(T)[man].t).faces[1].label === '♛', 'crowning is a flip: face 1, "♛"');
  }

  section('(8) BOXES.backgammon as §2g describes it');
  {
    const B = cleanBox(json(BOXES.backgammon));
    ok(isDeepStrictEqual(B.table, { shape: 'rect', w: 1800, h: 1300 }) && B.seats?.find((s) => s.id === 'light')?.edge === 'bottom' && B.seats.find((s) => s.id === 'dark')?.edge === 'top', 'an 1800 × 1300 rect table; seats light (bottom) and dark (top)');
    const types = Object.values(B.types), board = types.find((t) => t.kind === 'board'), sp = board?.board?.spaces || [];
    const tris = sp.filter((s) => s.mark === 'tri'), byId = (id) => sp.find((s) => s.id === id);
    ok(board?.w === 1400 && board.h === 1000, `a 1400 × 1000 board (${board?.w} × ${board?.h})`);
    ok(tris.length === 24 && tris.every((s) => s.w === 100 && s.h === 420) && new Set(tris.map((s) => s.color)).size === 2, `24 triangle spaces, 100 × 420, in two colours (${tris.length})`);
    ok(['bar', 'off-light', 'off-dark'].every((id) => byId(id)?.mark === 'rect'), "the bar and the trays off-light and off-dark (rect)");
    const bottom = tris.filter((s) => s.dir === 'up').sort((a, b) => a.x - b.x), top = tris.filter((s) => s.dir === 'down').sort((a, b) => a.x - b.x);
    const alt = (row) => row.every((s, k) => !k || s.color !== row[k - 1].color);
    ok(bottom.length === 12 && top.length === 12 && bottom.every((s) => s.y > 500) && top.every((s) => s.y < 500) && alt(bottom) && alt(top), 'twelve per row, pointing inward (the bottom row up, the top row down), alternating colours');
    const checkers = Object.entries(B.types).filter(([, t]) => t.kind === 'token' && t.faces.length === 1), dice = types.filter((t) => t.kind === 'die'), cube = types.find((t) => t.kind === 'token' && t.faces.length === 6);
    ok(checkers.length === 2 && checkers.every(([, t]) => t.shape === 'disc' && t.w === 80 && t.h === 80 && t.stack === 'none'), 'checkers: two token types, disc 80 × 80, stack none');
    ok(dice.length >= 1 && dice.every((d) => d.faces.length === 6), 'a d6 die type');
    ok(cube && isDeepStrictEqual(cube.faces.map((f) => f.label), ['64', '2', '4', '8', '16', '32']), `the doubling cube is a token with faces 64, 2, 4, 8, 16, 32 (${JSON.stringify(cube?.faces)})`);
    const T = mk({}, { players: { [HOST]: player('Alice', 90), [BOB]: player('Bob', 270) } });
    run(T, HOST, { t: 'loadBox', box: json(BOXES.backgammon), setup: true, clear: true });
    const bx = T.state.lastSetup, kindOf = (it) => T.boxes[bx].types[it.t.split('/')[1]];
    const all = Object.values(items(T)), bd = all.find((it) => kindOf(it).kind === 'board');
    const men = all.filter((it) => kindOf(it).kind === 'token' && kindOf(it).faces.length === 1), dz = all.filter((it) => kindOf(it).kind === 'die');
    ok(men.length === 30 && men.filter((m) => m.owner === 'seat:light').length === 15 && men.filter((m) => m.owner === 'seat:dark').length === 15, `15 checkers a side, owned by seat:light and seat:dark (${men.length})`);
    const where = (m) => { const x = m.x + 40 - bd.x, y = m.y + 40 - bd.y; return tris.find((s) => Math.abs(x - s.x) <= 50 && Math.abs(y - s.y) <= 210); };
    const count = new Map();
    for (const m of men) { const s = where(m), key = `${s?.id}|${m.owner}`; count.set(key, (count.get(key) || 0) + 1); }
    const homeLeft = count.get(`${bottom[0].id}|seat:dark`) === 2, pos = (row, i) => (homeLeft ? row[i - 1] : row[12 - i]).id;
    const want = new Map([[`${pos(bottom, 1)}|seat:dark`, 2], [`${pos(bottom, 6)}|seat:light`, 5], [`${pos(bottom, 8)}|seat:light`, 3], [`${pos(bottom, 12)}|seat:dark`, 5],
      [`${pos(top, 12)}|seat:light`, 5], [`${pos(top, 8)}|seat:dark`, 3], [`${pos(top, 6)}|seat:dark`, 5], [`${pos(top, 1)}|seat:light`, 2]]);
    ok(isDeepStrictEqual(count, want), `the standard start: light 2 on its 24, 5 on 13, 3 on 8, 5 on 6, and dark mirrored (${JSON.stringify([...count])})`);
    const [d1, d2] = dz, gap = d1 && d2 && Math.hypot(d1.x - d2.x, d1.y - d2.y);
    ok(dz.length === 2 && gap <= 2 * 56 && gap >= 56, `two dice side by side, within one die-width (one handful): centres ${gap?.toFixed(1)} apart`);
    const cubeKey = Object.keys(B.types).find((k) => B.types[k] === cube), cubeId = Object.keys(items(T)).find((id) => items(T)[id].t === `${bx}/${cubeKey}`);
    ok(cubeId && bd.lock === true, 'the cube is on the table, the board locked');
    ok(happened(run(T, HOST, { t: 'face', id: cubeId, f: 1 })) && T.api.type(items(T)[cubeId].t).faces[items(T)[cubeId].f].label === '2', 'the cube is set with face: it reads 2');
  }
}

(async () => {
  await guard('(G) grid.js', testGrid);
  await guard('(1) cleanBox', testCleanBox);
  await guard('(2) the check table', testCheckTable);
  await guard('(2) new actions', testNewActions);
  await guard('(2) changed actions', testChangedActions);
  await guard('(2) caps', testCaps);
  await guard('(2) the hidden-item rule', testHiddenRule);
  await guard('(2) the bag flag', testBagFlag);
  await guard('(2e) the facade', testFacade);
  await guard('(2d) the log', testLogNamesNothingHidden);
  await guard('(3) setup order', testSetupOrder);
  await guard('(4) the public reduction', testPublic);
  await guard('(2b) the wire and sizes', testWireAndSizes);
  await guard('(4) the public fuzz', testPubFuzz);
  await guard('(5) seats', testSeats);
  await guard('(6) MIGRATE[2] and board z', testMigrate);
  await guard('(7) randInt', testRandInt);
  await guard('(8) the built-in boxes', testBuiltins);
  report();
})().catch(crash);
