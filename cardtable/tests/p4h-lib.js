// Helpers for the independent Phase 4B Hexfront suites (t-p4-hexplay.js,
// t-p4-hexbox.js, t-p4-hex-bench.js); not a suite itself. What a page shows
// of Hexfront is read from its own view and its own catalog (__ct.view(),
// __ct.boxes()): a unit is a piece whose type names a side in its `meta`,
// the map is the board with a hex grid, the dice are the die-kind pieces and
// the events are the pile named "Events" — the spec's §4 demo (one map, 400
// counters in ×N stacks, dice, a deck of event cards, a turn script) and
// D222's account of it, never app.js's code. Gestures are real: a mouse
// (with Shift, the wheel) on a desktop, CDP touches on a phone.
'use strict';
const h = require('./h');
const L = require('./p1-lib');
const P3 = require('./p3-lib');
const B = require('./p4-lib');

/** Init script: every dialog shown modally, as {id, kind (its data-kind), at} in window.__modals. */
function modalLog() {
  const W = (window.__modals = []), show = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...a) {
    W.push({ id: this.id, kind: this.dataset.kind || '', at: Date.now() });
    return show.apply(this, a);
  };
}
/** Init script: the bytes of every whole message this page receives on the
 *  `state` and `boxes` channels, as it arrives on the wire (each chunk's
 *  framing included, as p1-lib's rtcHook counts them), in window.__wire:
 *  {type, bytes, kind ('snap' | 'patch' for a state body), items (the ids
 *  the body carries), chars (the body's JSON), itemChars (its items'), at}. It wraps whatever `onmessage` setter is there
 *  (rtcHook's), so an init script added after rtcHook sees what it passes on. */
function wireLog() {
  const W = (window.__wire = []), dec = new TextDecoder(), parts = new WeakMap();
  const u8 = (d) => (d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null);
  const on = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    enumerable: on.enumerable,
    get() { return on.get.call(this); },
    set(fn) {
      on.set.call(this, typeof fn !== 'function' ? fn : function (e) {
        const u = u8(e.data);
        if (u && u.length > 3 && u[0] === 1) { // (room data: the action frame after the room's token)
          const f = u.subarray(3 + ((u[1] << 8) | u[2])), type = f.length >= 36 ? dec.decode(f.subarray(0, 32)).replace(/\0+$/, '') : '';
          if (type === 'state' || type === 'boxes') {
            if (!parts.has(this)) parts.set(this, new Map());
            const m = parts.get(this), nonce = `${type}:${(f[32] << 8) | f[33]}`, rec = m.get(nonce) || { bytes: 0, chunks: [] };
            m.set(nonce, rec);
            rec.bytes += u.length;
            rec.chunks.push(f.slice(36));
            if (f[34] & 1) {
              m.delete(nonce);
              const all = new Uint8Array(rec.chunks.reduce((n, c) => n + c.length, 0));
              rec.chunks.reduce((o, c) => (all.set(c, o), o + c.length), 0);
              let kind = null, items = [], chars = 0, itemChars = 0;
              try {
                const w = JSON.parse(dec.decode(all)), body = typeof w?.b === 'string' ? JSON.parse(w.b) : w;
                kind = body?.kind ?? null;
                items = Object.keys(body?.items || {});
                chars = typeof w?.b === 'string' ? w.b.length : JSON.stringify(w).length;
                itemChars = JSON.stringify(body?.items || {}).length;
              } catch (err) { console.error('wireLog: an unreadable message', type, err); }
              W.push({ type, bytes: rec.bytes, kind, items, chars, itemChars, at: performance.now() });
            }
          }
        }
        return fn.call(this, e);
      });
    },
  });
}
/** A player in its own context (`o.ctx`: a device descriptor) with p1-lib's
 *  rtcHook (window.__rtc, keeping every state body it receives), p3-lib's
 *  actTap (window.__acts: what it sends), wireLog, modalLog and p4-lib's
 *  watchers (window.__toasts), joined as `name` once the host knows it.
 *  page.pid is its player id, page.touch whether it is a phone. */
async function player(env, name, url, o = {}) {
  const p = await env.page(name, o);
  for (const s of [L.rtcHook, P3.actTap, wireLog, modalLog, B.watchers]) await p.addInitScript(s);
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
  p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
  p.touch = !!o.ctx?.hasTouch;
  p.who = name;
  await p.evaluate(() => { window.__rtc.keep = true; });
  return p;
}

/** What page p sees of Hexfront, as plain JSON: {box (its id), items (the
 *  view's), units ([id]: pieces whose type's meta names a side), side ({id:
 *  side}), size ({id: {w, h}} of every piece), map ({id, x, y, w, h, rot,
 *  grid}: the one board with a hex grid, null when not exactly one), dice
 *  ([id]), events (the "Events" pile's id), eventRef (the type ref of the
 *  pieces its back draws: "<box>/<type>"), seats ({seatId: pid}), rules,
 *  hand (this player's), types ({ref: type})}. */
const hexOf = (p) => p.evaluate(() => {
  const v = window.__ct.view(), bx = window.__ct.boxes();
  const type = (ref) => { const [b, t] = String(ref || '').split('/'); return bx[b]?.types?.[t]; };
  const out = { items: v.items, units: [], side: {}, size: {}, dice: [], map: null, events: null, eventRef: null, seats: {}, rules: v.rules, hand: window.__ct.hand(), types: {} };
  const maps = [];
  for (const [id, it] of Object.entries(v.items)) {
    const ty = it.k === 'g' && type(it.t);
    if (ty) out.size[id] = { w: ty.w, h: ty.h ?? ty.w };
    if (ty?.meta?.side) { out.units.push(id); out.side[id] = ty.meta.side; }
    if (ty?.kind === 'die') out.dice.push(id);
    if (ty?.kind === 'board' && ty.board?.grid?.type === 'hex') maps.push({ id, x: it.x, y: it.y, w: ty.w, h: ty.h, rot: it.rot, grid: ty.board.grid });
    if (it.k === 'p' && it.name === 'Events') out.events = id;
  }
  out.map = maps.length === 1 ? maps[0] : null;
  const back = out.events && v.items[out.events].top?.b; // (a face-down pile shows its back: the type whose back it is, from the box)
  if (back) {
    const [b, k] = back.split('/');
    const refs = Object.entries(bx[b]?.types || {}).filter(([, t]) => t.back === k).map(([t]) => `${b}/${t}`);
    out.eventRef = refs.length === 1 ? refs[0] : null;
  }
  for (const [b, box] of Object.entries(bx)) for (const [t, ty] of Object.entries(box.types || {})) out.types[`${b}/${t}`] = ty;
  out.box = Object.keys(bx).find((b) => out.map && v.items[out.map.id].t.startsWith(`${b}/`)) || null;
  for (const [pid, pl] of Object.entries(v.players)) if (pl.seatId) out.seats[pl.seatId] = pid;
  return JSON.parse(JSON.stringify(out));
});

const R3 = Math.sqrt(3);
/** Table point of the centre of hex (c, r) of map `m` (hexOf's; turned 0°). */
const hexAt = (m, c, r) => { const q = P3.spotXY(m.grid, c, r); return { x: m.x + q.x, y: m.y + q.y }; };
/** The hex (c, r) of map `m` whose centre is nearest table point q, with its address and centre: {c, r, at, x, y, d}. */
function hexNear(m, q) {
  let best = null;
  for (let r = 0; r < m.grid.rows; r++) {
    for (let c = 0; c < m.grid.cols; c++) {
      const s = hexAt(m, c, r), d = Math.hypot(s.x - q.x, s.y - q.y);
      if (!best || d < best.d) best = { c, r, at: P3.addrOf(m.grid, c, r), x: s.x, y: s.y, d };
    }
  }
  return best;
}
/** The centre of item `id` in hexOf's `H` (table units). */
const centre = (H, id) => { const it = H.items[id], s = H.size[id] || { w: 0, h: 0 }; return { x: it.x + s.w / 2, y: it.y + s.h / 2 }; };
/** The hex of map `m` one row towards the other side from item `id`'s
 *  (`dir` −1: up the table, +1: down), half a hex aside — staying on the
 *  map: {c, r, at, x, y}. */
function ahead(H, id, dir) {
  const m = H.map, here = hexNear(m, centre(H, id)), r = here.r + dir;
  // (a pointy hex's two neighbours in the next row: odd rows sit half a hex to the right)
  const cs = (here.r & 1 ? [here.c, here.c + 1] : [here.c - 1, here.c]).filter((c) => c >= 0 && c < m.grid.cols);
  const c = cs.find((x) => !Object.values(H.items).some((it) => it.at === P3.addrOf(m.grid, x, r))) ?? cs[0];
  return { c, r, at: P3.addrOf(m.grid, c, r), ...hexAt(m, c, r) };
}

/** A tap at client point q: a finger on a phone, a click else. */
const tapAt = (p, q) => (p.touch ? p.touchscreen.tap(q.x, q.y) : p.mouse.click(q.x, q.y));
/** Presses button `sel`: a tap on a phone, a click else. */
const press = (p, sel) => (p.touch ? p.locator(sel).first().tap() : p.locator(sel).first().click());
/** Zooms page p's view in on table point q, `z` times the fit: 🧭 first (the
 *  seat view, the whole table), then the wheel at q on a desktop, two
 *  fingers spread there on a phone. */
async function focus(p, q, z = 2.5) {
  await press(p, '#view-btn');
  await h.sleep(150);
  const c = await P3.screenOf(p, q.x, q.y);
  if (!p.touch) {
    await p.mouse.move(c.x, c.y);
    await p.mouse.wheel(0, -Math.log(z) / 0.0015);
  } else {
    const cdp = await p.context().newCDPSession(p), d0 = 40, at = (d) => [{ x: c.x - d / 2, y: c.y, id: 1 }, { x: c.x + d / 2, y: c.y, id: 2 }];
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(d0) });
      for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(d0 * (1 + ((z - 1) * k) / 10)) }); await h.sleep(20); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
  }
  await h.sleep(300);
}
/** A drag on page p from client point a to b (a mouse, with Shift held when
 *  `shift`; a finger on a phone), slow enough for the page to see it, held a moment at b. */
async function dragFrom(p, a, b, { shift = false } = {}) {
  if (shift) await p.keyboard.down('Shift');
  try { await P3.gesture(p, [...P3.steps(a, b, 12, 20), { ...b, wait: 150 }], { touch: p.touch }); } finally { if (shift) await p.keyboard.up('Shift'); }
}
/** One finger held still `ms` at client point q (a long press: the app's is 450 ms; the margin keeps a starved page's timer ahead of the lift). */
async function longPress(p, q, ms = 1000) {
  const cdp = await p.context().newCDPSession(p);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: q.x, y: q.y }] });
    await h.sleep(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach().catch((err) => console.error('CDP detach failed', err)); }
}
/** The client centre of item `id`'s badge `.cls` on page p, or null. */
const badgeOf = (p, id, cls = 'count') => p.evaluate(([id, cls]) => {
  const el = document.querySelector(`#table .item[data-id="${id}"] > .${cls}`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
}, [id, cls]);
/** The stack inspector page p shows: {text, k (Take's count), buttons ([data-ins])}, or null when it is hidden. */
const inspector = (p) => p.evaluate(() => {
  const el = document.getElementById('inspector');
  if (!el || el.classList.contains('hidden') || !el.getClientRects().length) return null;
  return { text: el.textContent.replace(/\s+/g, ' ').trim(), k: +(el.querySelector('output')?.textContent || 0), buttons: [...el.querySelectorAll('[data-ins]')].map((b) => b.dataset.ins) };
});
/** The bar page p shows: {text, cmds ([data-cmd])}, or null when hidden. */
const bar = (p) => p.evaluate(() => {
  const el = document.getElementById('action-bar');
  return el.classList.contains('hidden') ? null : { text: el.textContent.replace(/\s+/g, ' ').trim(), cmds: [...el.querySelectorAll('[data-cmd]')].map((b) => b.dataset.cmd) };
});
/** The rules' buttons page p shows ([{id, label}]: #rules-btns, [] when hidden). */
const ruleBtns = (p) => p.evaluate(() => {
  const row = document.getElementById('rules-btns');
  return row.classList.contains('hidden') || !row.getClientRects().length ? [] : [...row.querySelectorAll('button[data-rbtn]')].map((b) => ({ id: b.dataset.rbtn, label: b.textContent }));
});
/** How far page p zooms in on what it plays with (a phone's table is drawn far smaller). */
const zoomFor = (p) => (p.touch ? 4 : 2.5);
/** Which way side `side`'s stacks go forward on the table in `H`: −1 up, +1 down (from where they stand towards the map's middle). */
function forward(H, side) {
  const mine = H.units.filter((id) => H.side[id] === side), y = mine.reduce((s, id) => s + centre(H, id).y, 0) / mine.length;
  return y > H.map.y + H.map.h / 2 ? -1 : 1;
}
/** Side `side`'s stacks in `H`, the most forward first (then left to right); `dir`: forward(H, side) as the game began. */
const frontOf = (H, side, dir) => H.units.filter((id) => H.side[id] === side).sort((a, b) => dir * (centre(H, b).y - centre(H, a).y) || centre(H, a).x - centre(H, b).x);
/** Page p moves its whole stack `id` to table point `to`: Shift+drag on the desktop; on a phone a tap, ✥ Move all, then a drag. */
async function moveStack(p, id, to) {
  await focus(p, centre(await hexOf(p), id), zoomFor(p));
  const a = await P3.centreOf(p, id);
  if (p.touch) {
    await tapAt(p, a);
    if (!(await L.until(async () => (await bar(p))?.cmds.includes('all'), 5000, 100))) h.ok(false, `${p.who}: the stack's bar offers no ✥ Move all (${JSON.stringify(await bar(p))})`);
    await press(p, '#action-bar [data-cmd="all"]');
  }
  await dragFrom(p, a, await P3.screenOf(p, to.x, to.y), { shift: !p.touch });
}
/** Puts page p's selection away: Esc on the desktop; on a phone ⬚ off, or a tap on bare felt while a bar shows. */
async function putAway(p) {
  if (!p.touch) { await p.keyboard.press('Escape'); return; }
  if (await p.evaluate(() => document.getElementById('sel-mode').classList.contains('on'))) await press(p, '#sel-mode');
  else if (await bar(p)) await tapAt(p, await feltAt(p));
  await h.sleep(150);
}
/** A client point on bare felt on page p (nothing but #table under it), away from the seat labels, the bars and the inspector. */
const feltAt = (p) => p.evaluate(() => {
  const table = document.getElementById('table'), r = document.getElementById('table-wrap').getBoundingClientRect();
  const keep = [...document.querySelectorAll('.seat, #action-bar, #inspector, #sel-mode, #sel-chip, #rules-row')].map((el) => el.getBoundingClientRect());
  for (let k = 0; k < 6000; k++) {
    const x = r.left + 24 + ((r.width - 48) * ((k * 37) % 101)) / 101, y = r.top + 24 + ((r.height - 48) * ((k * 53) % 103)) / 103;
    if (document.elementFromPoint(x, y) === table && !keep.some((s) => x > s.left - 20 && x < s.right + 20 && y > s.top - 20 && y < s.bottom + 20)) return { x, y };
  }
  return null;
});
/** The first refusal ("🚫 …") page p showed since `at` (Date.now()), waiting up to `ms`; null when none came. */
async function refusal(p, at, ms = 8000) {
  let hit = null;
  await L.until(async () => (hit = (await B.toasts(p, at)).find((m) => /^🚫/u.test(m))), ms, 100);
  return hit || null;
}
/** The actions page p sent since performance time `t0` ([a]: actTap's). */
const sentSince = (p, t0) => p.evaluate((t0) => window.__acts.filter((x) => x.at >= t0).map((x) => x.a), t0);
const now = (p) => p.evaluate(() => performance.now());
/** The lines of page p's log by `pid` matching `re`, stamped `since` (Date.now(): the host's clock is this machine's) or later.
 *  (Not by position: the log keeps a bounded number of lines, so its length stops growing.) */
const linesBy = (p, pid, re, since = 0) => p.evaluate(([pid, src, since]) => window.__ct.view().log.filter((e) => e.ts >= since && e.p === pid && new RegExp(src, 'u').test(e.txt)).map((e) => e.txt), [pid, re.source, since]);
/** Whether page p's log has such a line. */
const logged = async (p, pid, re, since = 0) => (await linesBy(p, pid, re, since)).length > 0;

/** A public layout, ids and the box id left out: each item's kind, type (its
 *  id in the box), place, face, count, owner, address, turn, lock, name and
 *  pile top as one JSON line, sorted — two set-ups of one box compare equal
 *  whatever ids they minted. */
const layoutOf = (items) => Object.values(items).map((it) => JSON.stringify({
  k: it.k, t: it.t?.split('/')[1], x: Math.round(it.x * 10) / 10, y: Math.round(it.y * 10) / 10, f: it.f, n: it.n, owner: it.owner, at: it.at, rot: it.rot, lock: !!it.lock, name: it.name,
  top: it.top && { b: it.top.b?.split('/')[1], up: it.top.up },
})).sort();

module.exports = {
  modalLog, wireLog, player, hexOf, R3, hexAt, hexNear, centre, ahead, tapAt, press, focus, dragFrom, longPress, badgeOf, inspector, bar, ruleBtns,
  zoomFor, forward, frontOf, moveStack, putAway, feltAt, refusal, sentSince, now, linesBy, logged, layoutOf,
};
