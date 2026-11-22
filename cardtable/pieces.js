// Card Table — drawing pieces, supplies, bags and boards (spec §2g).
//
// DOM markup only, no state: app.js hands each public item (core.js pubItem:
// never a hidden identity) and the box map ({boxId: Box}, every box passed
// core.js cleanBox), and gets back what to draw. Everything a box or a peer
// supplies is escaped (esc) or checked (safeColor); sizes and pips are
// cleanBox's validated numbers; images come only as the markup the app's
// `img(h)` makes from a verified asset (a blob URL, or its loading look).
import { COLOR_RE, CARD_W, CARD_H, typeAt, backAt, sizeOf, flagsOf, num } from './core.js?v=1';

/** The code version (see core.js MODULE_V): the same in every cardtable module. */
export const MODULE_V = 1;

/** Text for markup: every character that could open a tag or an attribute escaped. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A colour that is safe in a style attribute (a string COLOR_RE accepts), else the fallback. */
export const safeColor = (v, fallback = '#64748b') => (typeof v === 'string' && COLOR_RE.test(v) ? v : fallback);
const colorCtx = document.createElement('canvas').getContext('2d');
/** Light or dark text for any CSS background colour (the canvas normalizes
 *  names, #rgb, #rrggbbaa… to #rrggbb for opaque colours). */
export function contrastFor(color) {
  colorCtx.fillStyle = '#000';
  colorCtx.fillStyle = color;
  const m = colorCtx.fillStyle.match(/^#(..)(..)(..)$/);
  if (!m) return '#1e293b';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? '#f8fafc' : '#1e293b';
}

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

// Pips: the dots of a die face (0–9) on a 3 × 3 grid, by cell.
const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8], [0, 2, 3, 4, 5, 6, 8], [0, 1, 2, 3, 5, 6, 7, 8], [0, 1, 2, 3, 4, 5, 6, 7, 8]];
const pipField = (n) => `<div class="pips">${Array.from({ length: 9 }, (_, k) => (PIPS[n]?.includes(k) ? '<i class="pip on"></i>' : '<i class="pip"></i>')).join('')}</div>`;

/** A face drawn in layers (spec §2g), w × h: its colour, its image (`img(h)`,
 *  the app's), its label (at 0.55 · min(w, h), in a colour that reads on
 *  it), its text (small, cut to a few lines) and its pips ([a, b]: two
 *  fields split along the long side). A back without a colour is slate. */
export function faceHTML(face, w, h, box, img, back) {
  const bg = safeColor(face.color, back ? '#475569' : '#f8fafc');
  let s = `<div class="pface${back ? ' pback' : ''}" style="background:${bg};color:${contrastFor(bg)}">`;
  if (face.img !== undefined && box?.imgs[face.img]) s += `<div class="pimg">${img(box.imgs[face.img])}</div>`;
  if (face.label) s += `<b class="plabel" style="font-size:${Math.round(0.55 * Math.min(num(w), num(h)))}px">${esc(face.label)}</b>`;
  if (face.text) s += `<span class="ptext">${esc(face.text)}</span>`;
  if (face.pips !== undefined) s += Array.isArray(face.pips) ? `<div class="pips2${w >= h ? '' : ' tall'}">${pipField(face.pips[0])}${pipField(face.pips[1])}</div>` : pipField(face.pips);
  return `${s}</div>`;
}
/** A piece whose box (or type, or back) isn't here: a "?" (PLACEHOLDER units square). */
const PLACEHOLDER_HTML = '<div class="pface placeholder">?</div>';

/** How to draw a public item that isn't a card nor a pile of cards: a piece,
 *  a supply, a bag, a board or a pile of pieces. Returns {html, cls (the
 *  item element's classes), w, h}. `img(h)`: markup for image h. */
export function itemView(it, boxes, img) {
  const { w, h } = sizeOf(it, boxes);
  if (it.k === 'b') {
    const html = `<div class="bagbox" style="background:${safeColor(it.color, '#8b5e34')}"><span class="bname">${esc(it.name || 'Bag')}</span><span class="bn">${num(it.n)}</span></div>`;
    return { html, cls: ['bag'], w, h };
  }
  const m = shownPart(it), L = lookOf(m, boxes), F = flagsOf(m || {}, boxes);
  const board = !L?.back && typeAt(boxes, m?.t)?.kind === 'board';
  let html = L ? faceHTML(L.face, w, h, L.box, img, L.back) : PLACEHOLDER_HTML;
  if (it.k === 'p') html += `<span class="count">${num(it.n)}</span>${it.name ? `<span class="pname">${esc(it.name)}</span>` : ''}`;
  else if (it.k === 's') html += '<span class="count">∞</span>';
  else if (it.n >= 2) html += `<span class="count">×${num(it.n)}</span>`;
  const cls = ['piece', `shape-${L ? F.shape : 'rect'}`, ...(it.k === 'p' ? ['pile', ...(it.n > 1 ? ['multi'] : [])] : []), ...(it.k === 's' ? ['supply'] : []), ...(board ? ['board'] : [])];
  return { html, cls, w, h };
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
