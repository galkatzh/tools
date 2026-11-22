// Shared helpers for the Phase 1 browser suites (t-p1-delta.js, t-p1-bench.js);
// not a suite itself. The WebRTC hook below is the "RTC byte counter" of spec
// §1k (B1'), and the incoming-state dropper of §1l (t-p1-delta case 2).
'use strict';
const path = require('path');
const h = require('./h');

const core = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

/** Init script (runs in every page before the app): wraps the WebRTC data
 *  channels and exposes window.__rtc =
 *    sent / recv   bytes per Trystero action ('state', 'act', …), framing
 *                  included (a chunk's 36-byte header names its action);
 *    drop          a queue of kinds ('patch' | 'snap' | 'any', or 'reg': a
 *                  snapshot addressed to a player, i.e. with its hand): the
 *                  next incoming `state` message of the kind at its head is
 *                  swallowed whole (every chunk of it) before the app sees it;
 *    dropped       the kinds ('patch' | 'snap') swallowed so far;
 *    keep / bodies while keep is true, every incoming `state` body
 *                  (unsealed JSON) is recorded as {at, body}.
 *  Trystero 0.25 wraps each frame for its room: byte 0 = 1 (room data; 2 is
 *  room presence), bytes 1–2 the room token's length, then the token, then
 *  the action frame: bytes 0–31 the action name (NUL-padded), 32–33 a
 *  per-message nonce, 34 flags (bit 0: last chunk), 35 progress, 36… payload. */
function rtcHook() {
  const R = (window.__rtc = { sent: {}, recv: {}, drop: [], dropped: [], keep: false, bodies: [] });
  const dec = new TextDecoder();
  const u8 = (d) => (d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null);
  /** The action frame inside a data-channel message, and its action name ('presence': Trystero's own). */
  const frame = (d) => {
    const u = u8(d);
    if (!u || u.length < 3) return { type: '?', u };
    if (u[0] === 2) return { type: 'presence', u };
    const f = u[0] === 1 ? u.subarray(3 + ((u[1] << 8) | u[2])) : u;
    return { type: f.length >= 36 ? dec.decode(f.subarray(0, 32)).replace(/\0+$/, '') : '?', u: f };
  };
  const size = (d) => (typeof d === 'string' ? d.length : d?.byteLength ?? d?.size ?? 0);
  const add = (m, k, n) => { m[k] = (m[k] || 0) + n; };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (d) {
    add(R.sent, frame(d).type, size(d));
    return send.call(this, d);
  };
  const inflight = new WeakMap(); // channel → Map(nonce → {drop, kind, parts})
  const on = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    enumerable: on.enumerable,
    get() { return on.get.call(this); },
    set(fn) {
      on.set.call(this, typeof fn !== 'function' ? fn : function (e) {
        const { u, type } = frame(e.data);
        if (type === 'state') {
          if (!inflight.has(this)) inflight.set(this, new Map());
          const msgs = inflight.get(this), nonce = (u[32] << 8) | u[33], last = u[34] & 1;
          let m = msgs.get(nonce);
          if (!m) { // a message's first chunk: its body starts with the recipient's fields, then the kind
            const head = dec.decode(u.subarray(36)), kind = /kind\\?":\\?"(\w+)/.exec(head)?.[1] || '?';
            const reg = kind === 'snap' && /\bto\\?":\\?"\w/.test(head); // "to":"<pid>", not "to":null
            const drop = R.drop.length > 0 && (R.drop[0] === 'any' || R.drop[0] === kind || (R.drop[0] === 'reg' && reg));
            if (drop) R.drop.shift();
            msgs.set(nonce, (m = { drop, kind, parts: [] }));
          }
          if (last) msgs.delete(nonce);
          if (m.drop) {
            if (last) R.dropped.push(m.kind);
            return undefined;
          }
          if (R.keep) {
            m.parts.push(u.slice(36));
            if (last) {
              try {
                const bytes = new Uint8Array(m.parts.reduce((n, p) => n + p.length, 0));
                m.parts.reduce((o, p) => (bytes.set(p, o), o + p.length), 0);
                const w = JSON.parse(dec.decode(bytes));
                R.bodies.push({ at: performance.now(), body: typeof w?.b === 'string' ? JSON.parse(w.b) : w });
              } catch (err) { console.error('rtc hook: unreadable state body', err); }
            }
          }
        }
        add(R.recv, type, size(e.data));
        return fn.call(this, e);
      });
    },
  });
}

/** A seated player: its own context with the RTC hook, joined as `name`. */
async function player(env, name, url, o = {}) {
  const p = await env.page(name, o);
  await p.addInitScript(rtcHook);
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
  return p;
}
/** Host Alice and guests Bob and Carol, all seated and synced. */
async function trio(env, o = {}) {
  const host = await player(env, 'Alice', env.url, o.host);
  const a = await player(env, 'Bob', host.url(), o.a);
  const b = await player(env, 'Carol', host.url(), o.b);
  await host.waitForFunction(() => document.querySelectorAll('.seat').length >= 3, null, { timeout: 30000 });
  return { host, a, b };
}

/** A page's window.__ct view as plain JSON: {seq, boot, host, size, rules,
 *  items, players, log, hand, perf}. */
const view = (p) => p.evaluate(() => JSON.parse(JSON.stringify({ ...window.__ct.view(), hand: window.__ct.hand(), perf: window.__ct.perf })));
const pidOf = (p) => p.evaluate(() => localStorage.getItem('ct-pid'));
const act = (p, a) => p.evaluate((x) => window.__ct.act(x), a);

/** The host's latest save record ({room, ts, v, state}, from IndexedDB), or null. */
const saved = async (host) => h.idb(host, 'saves', await host.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]));
/** Ground truth from the host's save, recomputed in Node by core.js itself:
 *  the full public items and players (publicItems/publicPlayers, no
 *  incremental cache), the log, the rules, and every player's hand. */
function truthOf(rec, hostPid) {
  const s = JSON.parse(JSON.stringify(rec.state));
  const T = core.createTable(s, { pid: hostPid });
  const hands = Object.fromEntries(Object.entries(s.players).map(([p, pl]) => [p, pl.hand]));
  return { items: T.publicItems(), players: T.publicPlayers(), log: s.log, rules: s.rules, hands, handy: T.handy > 0 };
}

/** JSON with sorted keys at every level: equal values ⇔ equal strings. */
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
const same = (a, b) => canon(a) === canon(b);
/** Where two values first differ, for a failure message ('' when equal). */
function diff(a, b, at = '') {
  if (same(a, b)) return '';
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = diff(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at || '(root)'}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`;
}

/** Seeded PRNG (mulberry32): the same seed replays the same choices. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The p-th percentile of a list of numbers (nearest rank). */
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };

/** Resolves true once fn() (async) is truthy, polling; false after `ms`. */
async function until(fn, ms = 15000, every = 150) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await h.sleep(every);
  }
}

module.exports = { rtcHook, player, trio, view, pidOf, act, saved, truthOf, same, diff, prng, pct, until };
