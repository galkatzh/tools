// Card Table — drawing pieces, supplies, bags and boards (spec §2g).
//
// DOM markup only, no state: app.js hands each public item (core.js pubItem:
// never a hidden identity) and the box map ({boxId: Box}, every box passed
// core.js cleanBox), and gets back what to draw. Everything a box or a peer
// supplies is escaped (esc) or checked (safeColor); sizes, coordinates and
// pips are cleanBox's validated numbers, written through num(); images come
// only as the markup the app's `img(h)` makes from a verified asset (a blob
// URL, or its loading look). Only luma (a colour name) and tumble touch the
// DOM, so Node can import it and draw boards (B11).
import { COLOR_RE, CARD_W, CARD_H, typeAt, backAt, sizeOf, flagsOf, num } from './core.js?v=1';
import { cellCenter, hexCorners, gridExtent, parseAddr, formatAddr, labelsOf, toAxial } from './grid.js?v=1';

/** The code version (see core.js MODULE_V): the same in every cardtable module. */
export const MODULE_V = 1;

/** Text for markup: every character that could open a tag or an attribute escaped. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A colour that is safe in a style attribute (a string COLOR_RE accepts), else the fallback. */
export const safeColor = (v, fallback = '#64748b') => (typeof v === 'string' && COLOR_RE.test(v) ? v : fallback);
let colorCtx = null;
const lumas = new Map(); // colour → its luma (a 1,000-piece table asks for a handful of colours a thousand times)
/** A CSS colour's luma, 0 (black) to 255 (white): #rgb, #rrggbb and
 *  #rrggbbaa are read here; a colour name is normalized by a canvas (in a
 *  page; Node, which draws boards for B11, reads names as white). */
export function luma(color) {
  if (lumas.has(color)) return lumas.get(color);
  let hex = /^#([0-9a-f]{3,8})$/i.exec(color)?.[1];
  if (!hex && typeof document !== 'undefined') {
    colorCtx ||= document.createElement('canvas').getContext('2d');
    colorCtx.fillStyle = '#000';
    colorCtx.fillStyle = color;
    hex = /^#([0-9a-f]{6})$/i.exec(colorCtx.fillStyle)?.[1];
  }
  if (hex && hex.length < 6) hex = [...hex.slice(0, 3)].map((c) => c + c).join('');
  const [r, g, b] = hex ? [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16)) : [255, 255, 255];
  const out = 0.299 * r + 0.587 * g + 0.114 * b;
  lumas.set(color, out);
  return out;
}
/** Light or dark text for a CSS background colour. */
export const contrastFor = (color) => (luma(color) < 140 ? '#f8fafc' : '#1e293b');

/** The box a "<boxId>/<id>" ref belongs to (or undefined). */
export const boxIdOf = (ref) => (typeof ref === 'string' && ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : undefined);
/** The piece-like part of a public item that shows: a pile's top, else the item. */
const shownPart = (it) => (it.k === 'p' ? it.top : it);
/** What a public piece-like part {t, f} (shown) or {b} (hidden) draws: {face,
 *  box (whose imgs the face's `img` indexes), back: bool}, or null for a
 *  placeholder — its box, type, face or back isn't here. */
function lookOf(m, boxes) {
  if (!m || 'd' in m) return null;
  if ('b' in m) {
    const back = m.b && backAt(boxes, m.b);
    return back && { face: back.face, box: boxes[boxIdOf(m.b)], back: true };
  }
  const face = typeAt(boxes, m.t)?.faces[m.f];
  return face && { face, box: boxes[boxIdOf(m.t)], back: false };
}
/** The box a public item's look comes from (late arrivals: app.js's itemsByBox), or undefined. */
export function boxOf(it) {
  const m = shownPart(it);
  return m && !('d' in m) ? boxIdOf(m.b ?? m.t) : undefined;
}
/** The asset id of the image a public item's face shows, or undefined (late arrivals: itemsByAsset). */
export function imageOf(it, boxes) {
  if (it.k === 'b' || it.k === 'c') return undefined;
  const L = lookOf(shownPart(it), boxes);
  return L && L.face.img !== undefined ? L.box?.imgs[L.face.img] ?? undefined : undefined;
}
/** Whether public item `it` is a board: a shown one's type says so; a hidden
 *  one lies in the boards' z band (core's BOARD_Z0: boards alone are below 0). */
export const isBoard = (it, boxes) => it.k === 'g' && (it.z < 0 || typeAt(boxes, it.t)?.kind === 'board');
/** Whether public item `it` is a die (a hidden one never is: its type is hidden). */
export const isDie = (it, boxes) => it.k === 'g' && typeAt(boxes, it.t)?.kind === 'die';
/** Whether a turn of public piece `it` would show: false for a circular
 *  (round or disc, as wide as high) piece whose side up is a plain colour
 *  (a checker, a man), which looks the same at any angle — its bar offers
 *  no ⟲ ⟳ (app.js barFor). An oval turns visibly. */
export function turnShows(it, boxes) {
  const L = lookOf(shownPart(it), boxes), f = L?.face, F = flagsOf(it, boxes);
  return !f || !['round', 'disc'].includes(F.shape) || F.w !== F.h || f.img !== undefined || !!f.label || !!f.text || f.pips !== undefined;
}
/** The face a public piece-like item shows, when it is worth enlarging (an
 *  image, a text or a label: the long-press zoom): {t, f}, or null. */
export function zoomable(it, boxes) {
  const m = shownPart(it), face = m && 't' in m && m.up !== false ? typeAt(boxes, m.t)?.faces[m.f] : null;
  return face && (face.img !== undefined || face.text || face.label) ? { t: m.t, f: m.f } : null;
}

// Pips: the dots of a die face (0–9) on a 3 × 3 grid, by cell.
const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8], [0, 2, 3, 4, 5, 6, 8], [0, 1, 2, 3, 5, 6, 7, 8], [0, 1, 2, 3, 4, 5, 6, 7, 8]];
const pipField = (n) => `<div class="pips">${Array.from({ length: 9 }, (_, k) => (PIPS[n]?.includes(k) ? '<i class="pip on"></i>' : '<i class="pip"></i>')).join('')}</div>`;

/** A face drawn in layers (spec §2g), w × h: its colour, its image (`img(h)`,
 *  the app's), its label (at 0.55 · min(w, h), in a colour that reads on
 *  it), its text (small, cut to a few lines) and its pips ([a, b]: two
 *  fields split along the long side); `extra`: markup laid over them (a
 *  board's SVG). A back without a colour is slate. `upright`: its label and
 *  text read upright on every screen (an `upright` type's: .uptext, D160). */
export function faceHTML(face, w, h, box, img, back, extra = '', upright = false) {
  const bg = safeColor(face.color, back ? '#475569' : '#f8fafc'), up = upright ? ' uptext' : '';
  let s = `<div class="pface${back ? ' pback' : ''}" style="background-color:${bg};color:${contrastFor(bg)}">`;
  if (face.img !== undefined && box?.imgs[face.img]) s += `<div class="pimg">${img(box.imgs[face.img])}</div>`;
  s += extra;
  if (face.label) s += `<b class="plabel${up}" style="font-size:${Math.round(0.55 * Math.min(num(w), num(h)))}px">${esc(face.label)}</b>`;
  if (face.text) s += `<span class="ptext${up}">${esc(face.text)}</span>`;
  if (face.pips !== undefined) s += Array.isArray(face.pips) ? `<div class="pips2${w >= h ? '' : ' tall'}">${pipField(face.pips[0])}${pipField(face.pips[1])}</div>` : pipField(face.pips);
  return `${s}</div>`;
}
/** A piece whose box (or type, or back) isn't here: a "?" (PLACEHOLDER units square). */
const PLACEHOLDER_HTML = '<div class="pface placeholder">?</div>';

/** The badges any item may carry (spec §2g): its owner's dot, in `ownerColor`
 *  (the app resolves it: a seat-bound owner's is the seat's colour), and 🔒,
 *  which CSS shows only while the item is selected. */
export const badgesHTML = (it, ownerColor) => (it.owner ? `<i class="odot" style="background:${safeColor(ownerColor)}"></i>` : '') + (it.lock ? '<i class="lockb">🔒</i>' : '');

/** A bag: a drawn pouch (BAG_W × BAG_H units, the viewBox's) in its colour, with its name and count. */
const POUCH = '<svg class="pouch" viewBox="0 0 90 100" aria-hidden="true">'
  + '<path class="pbody" d="M33 22C12 30 3 58 9 80c6 19 66 19 72 0 6-22-3-50-24-58z"/>'
  + '<path d="M57 22c21 8 30 36 24 58-3 9-14 14-27 15 15-8 21-38 3-73z" fill="#000" fill-opacity=".2"/>'
  + '<ellipse cx="28" cy="50" rx="7" ry="14" fill="#fff" fill-opacity=".14"/>'
  + '<path class="pbody" d="M33 21C25 12 29 3 37 8c3-6 13-6 16 0 8-5 12 4 4 13z"/>'
  + '<rect x="29" y="18" width="32" height="7" rx="3.5" fill="#3b2412"/></svg>';

/** How to draw a public item that isn't a card nor a pile of cards: a piece,
 *  a supply, a bag, a board or a pile of pieces. Returns {html, cls (the
 *  item element's classes), w, h}. `img(h)`: markup for image h;
 *  `ownerColor`: the colour of its owner's dot (badgesHTML). */
export function itemView(it, boxes, img, ownerColor) {
  const { w, h } = sizeOf(it, boxes), badges = badgesHTML(it, ownerColor);
  if (it.k === 'b') {
    const html = `<div class="bagbox" style="color:${safeColor(it.color, '#8b5e34')}">${POUCH}<span class="bname">${esc(it.name || 'Bag')}</span><span class="bn">${num(it.n)}</span></div>${badges}`;
    return { html, cls: ['bag'], w, h };
  }
  const m = shownPart(it), L = lookOf(m, boxes), F = flagsOf(m || {}, boxes), board = isBoard(it, boxes);
  const ty = L && !L.back && typeAt(boxes, m.t);
  let html = L ? faceHTML(L.face, w, h, L.box, img, L.back, board && ty?.board ? boardSVG(ty) : '', !!ty?.upright) : PLACEHOLDER_HTML;
  if (it.k === 'p') html += `<span class="count">${num(it.n)}</span>${it.name ? `<span class="pname">${esc(it.name)}</span>` : ''}`;
  else if (it.k === 's') html += '<span class="count">∞</span>';
  else if (it.n >= 2) html += `<span class="count">×${num(it.n)}</span>`;
  const cls = ['piece', `shape-${L ? F.shape : 'rect'}`, ...(it.k === 'p' ? ['pile', ...(it.n > 1 ? ['multi'] : [])] : []), ...(it.k === 's' ? ['supply'] : []), ...(board ? ['board'] : []), ...(isDie(it, boxes) ? ['die'] : [])];
  return { html: html + badges, cls, w, h };
}
/** A piece in the hand ({t, f, up?}: its owner sees its face) as markup filling a hand card. */
export function handHTML(c, boxes, img) {
  const L = lookOf({ t: c.t, f: c.f }, boxes);
  return L ? faceHTML(L.face, CARD_W * 0.6, CARD_H * 0.6, L.box, img, false) : PLACEHOLDER_HTML;
}
/** A piece {t, f} enlarged (the zoom overlay, a peek): {html, w, h}. */
export function zoomView(c, boxes, img) {
  const it = { k: 'g', t: c.t, f: c.f }, { w, h } = sizeOf(it, boxes);
  return { html: itemView(it, boxes, img).html, w, h };
}

/** How far apart pieces sharing a spot with no fan direction are drawn, in table units. */
export const FAN_STEP = 6;
/** Where k pieces sharing one spot are drawn (spec §3g: fanned at render
 *  time; the state keeps them all centred on the spot): offsets from the
 *  spot's centre, in its board's frame, bottom (lowest z) first. On a space
 *  with a `dir` they run from its far end toward `dir`, a piece's size apart
 *  (its h up or down, its w left or right), squeezed to (L − size)/(k − 1)
 *  when that many would overflow the space's length L (its h or w): a
 *  backgammon point's 15 checkers stay inside its triangle. Elsewhere
 *  FAN_STEP apart, toward the board's top. `sizes`: [{w, h}], bottom first. */
export function fanOffsets(sp, sizes) {
  const k = sizes.length, d = sp?.dir;
  if (!d) return sizes.map((_, j) => ({ x: 0, y: -FAN_STEP * j }));
  const v = d === 'up' || d === 'down', s = Math.max(...sizes.map((z) => (v ? z.h : z.w)));
  const L = Math.max(s, num(v ? sp.h : sp.w) || 2 * num(sp.r)), step = k > 1 ? Math.min(s, (L - s) / (k - 1)) : 0;
  const sign = d === 'up' || d === 'left' ? -1 : 1, start = -sign * (L - s) / 2;
  return sizes.map((_, j) => { const o = start + sign * j * step; return v ? { x: 0, y: o } : { x: o, y: 0 }; });
}

/** A board's hint layer (spec §3g): an SVG over its w × h face, board-local,
 *  with a translucent disc on each of `spots` ([{x, y, size, ring, offer}]:
 *  a spot's centre, its size — a cell's, or a space's smaller side — and
 *  whether a piece sits there, for a ring around it instead), cyan for a
 *  hint, violet (`offer`) for what an ask offers. Numbers and fixed class
 *  names only: no text a script wrote ever reaches it. */
export function hintSVG(w, h, spots) {
  const marks = spots.map(({ x, y, size, ring, offer }) => `<circle class="${ring ? 'hr' : 'hd'}${offer ? ' o' : ''}" cx="${n2(x)}" cy="${n2(y)}" r="${n2(size * (ring ? 0.47 : 0.24))}"${
    ring ? ` stroke-width="${n2(size * 0.07)}"` : ''}/>`);
  return `<svg viewBox="0 0 ${n2(w)} ${n2(h)}" aria-hidden="true">${marks.join('')}</svg>`;
}

/** Plays the dice tumble (spec §2g: a roll, on every screen) on item element
 *  `el`: the .tumble class for 450 ms, which CSS turns into a spin and a
 *  pulse — or into nothing with reduced motion, where the face just changes. */
export function tumble(el) {
  clearTimeout(el.tumbleT);
  el.classList.remove('tumble');
  requestAnimationFrame(() => {
    el.classList.add('tumble');
    el.tumbleT = setTimeout(() => el.classList.remove('tumble'), 450);
  });
}

// --- boards: the structure as one SVG drawn from numbers --------------------
// boardSVG(type) draws a board type's grid, spaces, zones and links (cleanBox
// checked every field) as an inline <svg> laid over its face. Only numbers
// and safeColor'd colours go into it; its only text is our own coordinate
// labels (.blabels) and the spaces' and zones' labels (.slabel), escaped:
// style.css turns each by its class (the view's turn varies, the string
// doesn't). A grid of any size is a handful of <path>s (one per colour), so
// a 64 × 64 board stays cheap to build and to draw (B11). The string is
// built once per type (cached: a type is an immutable object of the box map).
const svgCache = new WeakMap();
/** A number for an SVG attribute: finite, at most two decimals. */
const n2 = (v) => Math.round(num(v) * 100) / 100;
/** A closed polygon as path data. */
const poly = (pts) => `M${pts.map(([x, y]) => `${n2(x)} ${n2(y)}`).join('L')}Z`;
/** A function drawing cell (c, r) of grid g as path data: the move to its
 *  first corner, then an outline every cell shares (a hex's six sides, or a
 *  square's four), built once as a relative path. */
function cellPather(g) {
  const c0 = cellCenter(g, 0, 0), hex = g.type === 'hex' && hexCorners(g, 0, 0), k = g.cell / 2;
  const [ox, oy] = hex ? [hex[0][0] - c0.x, hex[0][1] - c0.y] : [-k, -k];
  const rel = hex ? `${hex.slice(1).map((p, j) => `l${n2(p[0] - hex[j][0])} ${n2(p[1] - hex[j][1])}`).join('')}z` : `h${n2(g.cell)}v${n2(g.cell)}h${n2(-g.cell)}z`;
  return (c, r) => { const p = cellCenter(g, c, r); return `M${n2(p.x + ox)} ${n2(p.y + oy)}${rel}`; };
}
const LABEL_MAX = 1.6; // the most a board's coordinates grow on a table drawn small (app.js view sheet)
/** Grid g, on a board boardH units tall, drawn: its cells (draw 'checker',
 *  'cells'), its lines ('lines'), its fills, marks and edge labels (chess
 *  and go: in the margin, when the grid leaves one; .blabels). */
function gridSVG(g, boardH) {
  const [c0, c1] = (g.colors || ['#f0d9b5', '#b58863']).map((c) => safeColor(c)), line = g.colors ? c1 : '#1f2937';
  const cell = cellPather(g), each = (f) => { for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) f(c, r); };
  let s = '';
  if (g.draw === 'checker') {
    // square: (c + r) odd is the second colour (a1 is dark on 8 × 8: chess's
    // rule); hex: a third of the cells, by axial q − r
    const odd = (c, r) => { if (g.type !== 'hex') return (c + r) % 2 === 1; const a = toAxial(g, c, r); return (((a.q - a.r) % 3) + 3) % 3 === 0; };
    const edge = g.type === 'hex' ? ` stroke="#0000002e" stroke-width="${n2(Math.max(1, g.cell / 45))}"` : ''; // (hexes of one colour need their edges)
    let even = '', other = '';
    each((c, r) => { if (odd(c, r)) other += cell(c, r); else even += cell(c, r); });
    s += `<path fill="${c0}"${edge} d="${even}"/><path fill="${c1}"${edge} d="${other}"/>`;
  } else if (g.draw === 'cells') {
    let d = '';
    each((c, r) => { d += cell(c, r); });
    s += `<path fill="${g.colors ? c0 : 'none'}" stroke="${line}" stroke-width="${n2(Math.max(1, g.cell / 40))}" d="${d}"/>`;
  } else if (g.draw === 'lines') {
    // points: lines join them; cells: the lines between them (a hex grid: its outlines)
    const pt = g.snap === 'point', x0 = g.x, y0 = g.y, nc = pt ? g.cols - 1 : g.cols, nr = pt ? g.rows - 1 : g.rows;
    let L = '';
    if (g.type === 'hex') each((c, r) => { L += cell(c, r); });
    else {
      for (let c = 0; c <= nc; c++) L += `M${n2(x0 + c * g.cell)} ${n2(y0)}v${n2(nr * g.cell)}`;
      for (let r = 0; r <= nr; r++) L += `M${n2(x0)} ${n2(y0 + r * g.cell)}h${n2(nc * g.cell)}`;
      if (g.colors) s += `<path fill="${c0}" d="M${n2(x0)} ${n2(y0)}h${n2(nc * g.cell)}v${n2(nr * g.cell)}h${n2(-nc * g.cell)}z"/>`;
    }
    s += `<path fill="none" stroke="${line}" stroke-width="${n2(Math.max(1, g.cell / 30))}" stroke-linecap="square" d="${L}"/>`;
  }
  // fills: by colour, one path each
  const byColor = new Map();
  for (const [a, color] of Object.entries(g.fills || {})) {
    const at = parseAddr(g, a);
    if (at) byColor.set(color, (byColor.get(color) || '') + cell(at.c, at.r));
  }
  for (const [color, d] of byColor) s += `<path fill="${safeColor(color)}" fill-opacity=".85" d="${d}"/>`;
  // marks: dots (go's star points)
  const marks = (g.marks || []).map((a) => parseAddr(g, a)).filter(Boolean);
  if (marks.length) s += `<g fill="${line}">${marks.map(({ c, r }) => { const p = cellCenter(g, c, r); return `<circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="${n2(g.cell * 0.09)}"/>`; }).join('')}</g>`;
  // edge labels: files along the bottom, ranks up the left (in the margin, when there is one)
  const L = labelsOf(g);
  if (g.type === 'square' && (L === 'chess' || L === 'go')) {
    const ext = gridExtent(g), mx = g.x, my = boardH - ext.h, m = Math.min(mx, my);
    const fs = n2(m >= 12 ? Math.min(m * 0.8, g.cell * 0.32) : g.cell * 0.2);
    const outside = m >= 12, files = Array.from({ length: g.cols }, (_, c) => formatAddr(g, c, g.rows - 1).replace(/\d+$/, ''));
    let t = '';
    for (let c = 0; c < g.cols; c++) {
      const p = cellCenter(g, c, g.rows - 1), y = outside ? ext.h + m / 2 : p.y + (g.snap === 'point' ? 0 : g.cell / 2) - fs * 0.35; // (in the strip the font is sized for, as the ranks are)
      t += `<text x="${n2(p.x)}" y="${n2(y)}">${esc(files[c])}</text>`;
    }
    for (let r = 0; r < g.rows; r++) {
      const p = cellCenter(g, 0, r), x = outside ? mx / 2 : p.x - (g.snap === 'point' ? 0 : g.cell / 2) + fs * 0.45;
      t += `<text x="${n2(x)}" y="${n2(p.y)}">${esc(String(g.rows - r))}</text>`;
    }
    // How much the labels may grow on a table drawn small (style.css .blabels
    // text): in a margin, as long as the widest one (an em tall, 0.6 em a
    // character wide, whichever way the view turns it) still fits its strip
    // (two-digit ranks hardly grow); inside the cells, up to LABEL_MAX.
    const n = Math.max(String(g.rows).length, ...files.map((f) => f.length));
    const lmax = outside ? Math.min(LABEL_MAX, Math.max(1, m / (fs * Math.max(1, 0.6 * n)))) : LABEL_MAX;
    s += `<g class="blabels" style="--lmax:${n2(lmax)}" font-size="${fs}" fill="currentColor" text-anchor="middle" dominant-baseline="central">${t}</g>`;
  }
  return s;
}
/** Space sp drawn by its mark (dot, ring, tri pointing along `dir`, rect, none) and its label. */
function spaceSVG(sp) {
  const x = num(sp.x), y = num(sp.y), r = num(sp.r), w = sp.w ?? 2 * r, h = sp.h ?? 2 * r, fill = safeColor(sp.color, '#e2e8f0');
  let s = '';
  switch (sp.mark || 'dot') {
    case 'dot': s = `<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(Math.min(r * 0.3, 14))}" fill="${fill}"/>`; break;
    case 'ring': s = `<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(r)}" fill="none" stroke="${fill}" stroke-width="${n2(Math.max(2, r / 12))}"/>`; break;
    case 'rect': s = `<rect x="${n2(x - w / 2)}" y="${n2(y - h / 2)}" width="${n2(w)}" height="${n2(h)}" rx="${n2(Math.min(w, h) * 0.06)}" fill="${fill}"/>`; break;
    case 'tri': { // its base on the far side, its tip toward `dir` (default up)
      const L = x - w / 2, R = x + w / 2, T = y - h / 2, B = y + h / 2;
      const pts = { up: [[L, B], [R, B], [x, T]], down: [[L, T], [R, T], [x, B]], left: [[R, T], [R, B], [L, y]], right: [[L, T], [L, B], [R, y]] }[sp.dir || 'up'];
      s = `<path fill="${fill}" d="${poly(pts)}"/>`;
      break;
    }
    default: break;
  }
  // (a label sits on the space's own colour in a rect or a triangle, else on the board's)
  const ink = (sp.mark === 'rect' || sp.mark === 'tri') && sp.color ? contrastFor(fill) : 'currentColor';
  if (sp.label) s += `<text class="slabel" x="${n2(x)}" y="${n2(y)}" font-size="${n2(Math.max(10, Math.min(r * 0.5, 40)))}" fill="${ink}" text-anchor="middle" dominant-baseline="central">${esc(sp.label)}</text>`;
  return s;
}
/** Board type `type` (a cleanBox'd type with a `board`) as an inline SVG
 *  string over its whole face, viewBox 0 0 w h in board-local units: its
 *  zones, links, grid and spaces, bottom to top. Cached per type. */
export function boardSVG(type) {
  let s = svgCache.get(type);
  if (s !== undefined) return s;
  const B = type.board || {}, w = num(type.w), h = num(type.h);
  s = `<svg class="psvg" viewBox="0 0 ${n2(w)} ${n2(h)}" aria-hidden="true">`;
  for (const z of B.zones || []) {
    const c = safeColor(z.color, '#94a3b8');
    s += `<path d="${poly(z.poly)}" fill="${c}" fill-opacity=".22" stroke="${c}" stroke-width="3"/>`;
  }
  const at = new Map((B.spaces || []).map((sp) => [sp.id, sp]));
  if (B.links?.length) s += `<path fill="none" stroke="#0f172a" stroke-opacity=".45" stroke-width="3" d="${B.links.map(([a, b]) => `M${n2(at.get(a).x)} ${n2(at.get(a).y)}L${n2(at.get(b).x)} ${n2(at.get(b).y)}`).join('')}"/>`;
  if (B.grid) s += gridSVG(B.grid, h);
  for (const sp of B.spaces || []) s += spaceSVG(sp);
  for (const z of B.zones || []) {
    if (!z.label) continue;
    const cx = z.poly.reduce((a, p) => a + num(p[0]), 0) / z.poly.length, cy = z.poly.reduce((a, p) => a + num(p[1]), 0) / z.poly.length;
    s += `<text class="slabel" x="${n2(cx)}" y="${n2(cy)}" font-size="28" fill="currentColor" fill-opacity=".8" text-anchor="middle" dominant-baseline="central">${esc(z.label)}</text>`;
  }
  s += '</svg>';
  svgCache.set(type, s);
  return s;
}
