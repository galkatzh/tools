// Helpers for the Phase 3 space suite (t-p3-space.js); not a suite itself.
// Geometry here is the spec's own (§2a "Grid geometry", the address grammar,
// §3a "Snapping", D104), written out again by brute force rather than taken
// from grid.js: the suite checks the app against it. Screen readings go
// through the page's own transforms (#table, a board's SVG), so they hold
// under any view turn.
'use strict';
const h = require('./h');
const L = require('./p1-lib');

const R3 = Math.sqrt(3);
const FILES = 'abcdefghijklmnopqrstuvwxyz', GO = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

/** Board-local centre of cell (c, r) of grid g: a square cell's middle, a
 *  square point, or a pointy (odd-r) or flat (odd-q) hex (spec §2a). */
function spotXY(g, c, r) {
  if (g.type === 'hex') {
    const R = g.cell / R3;
    return g.hex === 'flat' ? { x: g.x + R + c * 1.5 * R, y: g.y + g.cell * (r + 0.5 * (c & 1)) + g.cell / 2 }
      : { x: g.x + g.cell * (c + 0.5 * (r & 1)) + g.cell / 2, y: g.y + R + r * 1.5 * R };
  }
  return g.snap === 'point' ? { x: g.x + c * g.cell, y: g.y + r * g.cell } : { x: g.x + (c + 0.5) * g.cell, y: g.y + (r + 0.5) * g.cell };
}
/** The address of (c, r) on grid g (spec §2a's grammar): chess and go ranks
 *  count from the bottom; hexes are axial "q,r"; else "c,r". */
function addrOf(g, c, r) {
  if (g.type === 'hex') {
    const q = g.hex === 'flat' ? c : c - (r - (r & 1)) / 2, rr = g.hex === 'flat' ? r - (c - (c & 1)) / 2 : r;
    return `${q + 0},${rr + 0}`; // (+ 0: never "-0")
  }
  if (g.labels === 'chess') return FILES[c] + (g.rows - r);
  if (g.labels === 'go') return GO[c] + (g.rows - r);
  return `${c},${r}`;
}
/** Where board-local point (lx, ly) snaps on structure B, by the spec's
 *  rules done by brute force: spaces first (the nearest with distance ≤ r,
 *  a point inside a space's w × h rectangle being at distance 0, ties to
 *  the nearer centre: D104), then the grid (the cell holding it; the
 *  nearest point within cell/2; the nearest hex centre within R) —
 *  {local, x, y} (the spot's centre), or null. */
function expectSpot(B, lx, ly) {
  let best = null;
  for (const s of B.spaces || []) {
    const c = Math.hypot(lx - s.x, ly - s.y), inside = s.w && s.h && Math.abs(lx - s.x) <= s.w / 2 && Math.abs(ly - s.y) <= s.h / 2, d = inside ? 0 : c;
    if (d <= s.r && (!best || d < best.d || (d === best.d && c < best.c))) best = { d, c, local: s.id, x: s.x, y: s.y };
  }
  if (best) return { local: best.local, x: best.x, y: best.y };
  const g = B.grid;
  if (!g) return null;
  if (g.type === 'square' && g.snap !== 'point') {
    const c = Math.floor((lx - g.x) / g.cell), r = Math.floor((ly - g.y) / g.cell);
    return c >= 0 && r >= 0 && c < g.cols && r < g.rows ? { local: addrOf(g, c, r), ...spotXY(g, c, r) } : null;
  }
  const reach = g.type === 'hex' ? g.cell / R3 : g.cell / 2;
  let near = null;
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const p = spotXY(g, c, r), d = Math.hypot(lx - p.x, ly - p.y);
      if (d <= reach && (!near || d < near.d)) near = { d, local: addrOf(g, c, r), ...p };
    }
  }
  return near && { local: near.local, x: near.x, y: near.y };
}
/** Table point of board-local point l on board item b ({x, y, w, h, rot}):
 *  turned by rot about the board's centre, as CSS turns its element. */
function onTable(b, l) {
  const a = (b.rot * Math.PI) / 180, dx = l.x - b.w / 2, dy = l.y - b.h / 2;
  return { x: b.x + b.w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: b.y + b.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) };
}

/** The client point of table point (x, y) on page p: a probe put in #table
 *  (its padding box is the table), so exact under any view turn and scale. */
const screenOf = (p, x, y) => p.evaluate(([x, y]) => {
  const i = document.createElement('i');
  i.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
  document.getElementById('table').appendChild(i);
  const r = i.getBoundingClientRect();
  i.remove();
  return { x: r.left, y: r.top };
}, [x, y]);
/** Board item `id`'s local coordinates of client point pt on page p, and
 *  back: through its drawn SVG's own screen matrix (what the eye sees). */
const svgLocal = (p, id, pt) => p.evaluate(([id, x, y]) => {
  const q = new DOMPoint(x, y).matrixTransform(document.querySelector(`.item[data-id="${id}"] svg.psvg`).getScreenCTM().inverse());
  return { x: q.x, y: q.y };
}, [id, pt.x, pt.y]);
const svgScreen = (p, id, l) => p.evaluate(([id, x, y]) => {
  const q = new DOMPoint(x, y).matrixTransform(document.querySelector(`.item[data-id="${id}"] svg.psvg`).getScreenCTM());
  return { x: q.x, y: q.y };
}, [id, l.x, l.y]);
/** The centre of item `id`'s element on page p (client px), or null. */
const centreOf = (p, id) => p.evaluate((id) => {
  const el = document.querySelector(`.item[data-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, id);
/** The snap preview on page p, two frames on (touch moves reach the page
 *  frame-aligned: the last one may still be on its way): {ghost: its centre
 *  and size (client px) or null when hidden, chip: {text, l, t, r, b} or
 *  null, spot: __ct.spot(), vw, vh (the viewport)}. */
const preview = (p) => p.evaluate(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const vis = (el) => el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const g = document.querySelector('#table > .snap-ghost'), c = document.querySelector('#table-wrap > .snap-chip');
  const gr = vis(g) && g.getBoundingClientRect(), cr = vis(c) && c.getBoundingClientRect();
  return {
    ghost: gr ? { x: gr.left + gr.width / 2, y: gr.top + gr.height / 2, w: gr.width, h: gr.height } : null,
    chip: cr ? { text: c.textContent, l: cr.left, t: cr.top, r: cr.right, b: cr.bottom } : null,
    spot: window.__ct.spot(), vw: innerWidth, vh: innerHeight,
  };
});
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** The table point under client point pt on page p (the inverse of screenOf). */
async function tableOf(p, pt) {
  const [o, ex, ey] = await Promise.all([screenOf(p, 0, 0), screenOf(p, 1000, 0), screenOf(p, 0, 1000)]);
  const a = (ex.x - o.x) / 1000, b = (ex.y - o.y) / 1000, c = (ey.x - o.x) / 1000, d = (ey.y - o.y) / 1000, det = a * d - b * c, dx = pt.x - o.x, dy = pt.y - o.y;
  return { x: (d * dx - c * dy) / det, y: (-b * dx + a * dy) / det };
}
/** What page p paints on top at client point pt, among the screen-space
 *  overlays that let the pointer through (the snap chip, name bulbs, seat
 *  labels: given the pointer for a moment, so elementsFromPoint sees them):
 *  the top element's class, and whether it is (inside) the snap chip. */
const topAt = (p, pt) => p.evaluate(([x, y]) => {
  const st = document.createElement('style');
  st.textContent = '.snap-chip, .fx-bulb, .seat { pointer-events: auto !important; }';
  document.head.appendChild(st);
  try {
    const el = document.elementFromPoint(x, y);
    return { cls: el?.className || String(el), chip: !!el?.closest('.snap-chip') };
  } finally { st.remove(); }
}, [pt.x, pt.y]);

/** Client points from a to b in n equal steps (a first), each to be held `wait` ms (gesture). */
const steps = (a, b, n, wait) => Array.from({ length: n + 1 }, (_, k) => ({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, wait }));
/** A drag on page p through client points `pts` (the first is the press) by
 *  the mouse or, `touch`, one finger (CDP touches: pointerType 'touch');
 *  after each move a point's own `wait` ms, else `pause`; `mid()` runs with
 *  the pointer still down, at the last point; then the release. */
async function gesture(p, pts, { touch, pause = 0, mid } = {}) {
  if (touch) {
    const cdp = await p.context().newCDPSession(p);
    const t = (type, pt) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pt ? [{ x: pt.x, y: pt.y }] : [] });
    try {
      await t('touchStart', pts[0]);
      for (const q of pts.slice(1)) { await t('touchMove', q); if (q.wait ?? pause) await h.sleep(q.wait ?? pause); }
      if (mid) await mid();
      await t('touchEnd');
    } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
    return;
  }
  await p.mouse.move(pts[0].x, pts[0].y);
  await p.mouse.down();
  for (const q of pts.slice(1)) { await p.mouse.move(q.x, q.y); if (q.wait ?? pause) await h.sleep(q.wait ?? pause); }
  if (mid) await mid();
  await p.mouse.up();
}
/** Drags item `id` on page p, pressed at its drawn centre, so that its
 *  centre is released over table point `to` (o: gesture's, plus `n` steps). */
async function dragTo(p, id, to, o = {}) {
  const a = await centreOf(p, id), b = await screenOf(p, to.x, to.y);
  await gesture(p, steps(a, b, o.n || 12), o);
}

/** Init script: records the actions this page sends to the host (its
 *  outgoing `act` frames, decoded) in window.__acts as {at, a}. A frame is
 *  read when it is one whole message (Trystero's framing as in p1-lib's
 *  rtcHook: room byte, token, then a 36-byte action header). */
function actTap() {
  const acts = (window.__acts = []), dec = new TextDecoder(), send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (d) {
    const u = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
    if (u && u[0] === 1 && u.length > 3) {
      const f = u.subarray(3 + ((u[1] << 8) | u[2]));
      if (f.length > 36 && dec.decode(f.subarray(0, 32)).replace(/\0+$/, '') === 'act' && (f[34] & 1)) {
        try { acts.push({ at: performance.now(), a: JSON.parse(dec.decode(f.subarray(36))) }); } catch (err) { console.error('actTap: an act frame that is not one whole message', err); }
      }
    }
    return send.call(this, d);
  };
}
/** A player in its own context (`o.ctx`: a device descriptor) with p1-lib's
 *  RTC hook (window.__rtc: bytes, and the incoming bodies while `keep`) and
 *  actTap, joined as `name` once the host knows it; `page.pid` is its id. */
async function join(env, name, url, o = {}) {
  const p = await env.page(name, o);
  await p.addInitScript(L.rtcHook);
  await p.addInitScript(actTap);
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
  p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
  await p.evaluate(() => { window.__rtc.keep = true; });
  return p;
}
/** The live-drag fx in page p's recorded bodies (p1-lib's rtcHook, `keep`). */
const liveFx = (p) => p.evaluate(() => window.__rtc.bodies.flatMap((b) => (Array.isArray(b.body.fx) ? b.body.fx : []).filter((f) => f && f.live)));
/** Every live-drag fx anywhere in a list of bodies (a recursive scan). */
function scanLive(bodies) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if ('live' in v) out.push(v); Object.values(v).forEach(walk); }
  };
  walk(bodies);
  return out;
}

module.exports = { R3, spotXY, addrOf, expectSpot, onTable, screenOf, tableOf, topAt, svgLocal, svgScreen, centreOf, preview, dist, steps, gesture, dragTo, actTap, join, liveFx, scanLive };
