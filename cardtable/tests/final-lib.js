// Shared helpers for the final-review suites (t-final-*.js); not a suite itself.
const fs = require('fs');
const h = require('./h');

/** Mallory: a RAW Trystero peer (no app code) in the room, seated with her own key. */
async function mallory(env, invite) {
  const page = await env.page('Mallory');
  await page.goto(`${env.base}/cardtable/cah-cards.js`); // any same-origin page; the app does not run
  await page.evaluate(async ({ invite, relay }) => {
    const { joinRoom } = await import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm');
    const [, roomId, password] = invite.match(/#room~([0-9a-f]+)~([0-9a-f]+)/);
    const room = joinRoom({ appId: 'gk-cardtable', password, relayConfig: { urls: [relay] } }, roomId);
    const M = (window.M = { room, got: { state: [], note: [] }, send: {} });
    for (const ch of ['act', 'state', 'decks', 'log', 'note', 'rules']) {
      const a = room.makeAction(ch);
      M.send[ch] = (data, target) => a.send(data, target ? { target } : {});
      a.onMessage = (m, { peerId }) => (M.got[ch] ||= []).push({ m, peerId });
    }
    const body = (m) => (typeof m.b === 'string' ? JSON.parse(m.b) : m);
    M.notes = () => M.got.note.map(({ m }) => body(m));
    M.act = (a) => a && M.send.act({ ...a, _pid: 'ffffffffffffffff', _name: 'Mallory', _key: 'm'.repeat(32) });
    await new Promise((r) => { const t = setInterval(() => { if (Object.keys(room.getPeers()).length >= 2) { clearInterval(t); r(); } }, 100); });
  }, { invite, relay: env.relayUrl });
  page.act = (a) => page.evaluate((x) => window.M.act(x), a);
  page.notes = () => page.evaluate(() => window.M.notes().map((n) => n.msg || (n.peek ? 'PEEK' : '')));
  return page;
}

/** The rules templates, read from APP_ROOT's app.js. */
function templates() {
  const src = fs.readFileSync(h.APP_ROOT + '/cardtable/app.js', 'utf8');
  const s0 = src.indexOf('const RULES_TEMPLATES = {'), s1 = src.indexOf('\n};\n', s0);
  return eval('(' + src.slice(s0 + 'const RULES_TEMPLATES = '.length, s1 + 2) + ')');
}

const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const STD = SUITS.flatMap((s) => RANKS.map((r) => ({ r, s })));

/** A Node port of the rules facade (as t-holdem-logic's), for any template:
 *  players named in seat order (the first is the host), one 'std' deck pile.
 *  Decks other than 'std' are text cards. */
function table(tpl, names, o = {}) {
  const W = 1300, R = W / 2 - 110;
  let n = 0; const uid = () => 'id' + (++n);
  const log = [], tells = [], timers = [];
  const host = { players: {}, items: {}, rules: { data: {}, public: {} } };
  names.forEach((nm, k) => { host.players[nm] = { name: nm, online: true, hand: [], seat: (o.seats || [])[k] ?? k * (360 / names.length) + 90 }; });
  host.items.deck = { k: 'p', x: W / 2 - 50, y: W / 2 - 70, cards: STD.map((_, i) => ({ d: 'std', i, up: false })) };
  const dealTop = (pileId, o2 = {}) => {
    const pile = host.items[pileId], c = pile?.k === 'p' && pile.cards.pop();
    if (!c) return false;
    let nid = null;
    if (o2.to) host.players[o2.to].hand.push({ d: c.d, i: c.i });
    else { nid = uid(); host.items[nid] = { k: 'c', x: o2.x ?? 0, y: o2.y ?? 0, rot: o2.rot || 0, d: c.d, i: c.i, up: !!o2.up }; }
    if (!pile.cards.length) delete host.items[pileId];
    return o2.to ? { d: c.d, i: c.i } : { id: nid, d: c.d, i: c.i };
  };
  const t = {
    get data() { return host.rules.data; }, get public() { return host.rules.public; }, set public(v) { host.rules.public = v || {}; },
    hostId: names[0],
    players: () => Object.entries(host.players).map(([id, p]) => ({ id, name: p.name, seat: p.seat, online: p.online, handCount: p.hand.length, host: id === names[0] })).sort((a, b) => a.seat - b.seat),
    hand: (p) => (host.players[p]?.hand || []).map((c) => ({ ...c })),
    items: () => Object.entries(host.items).map(([id, it]) => structuredClone({ id, ...it })),
    piles() { return this.items().filter((x) => x.k === 'p'); },
    deal: (p, o2) => dealTop(p, o2),
    dealToAll(p, k = 1) { for (let i = 0; i < k; i++) for (const x of this.players()) if (x.online) dealTop(p, { to: x.id }); },
    takeHand(p, pileId, only = () => true) {
      const pl = host.players[p], pile = host.items[pileId];
      if (!pl || pile?.k !== 'p') return false;
      const out = pl.hand.filter((c) => only({ ...c }));
      pl.hand = pl.hand.filter((c) => !out.includes(c));
      for (const c of out) pile.cards.push({ d: c.d, i: c.i, up: false });
      return true;
    },
    playFromHand(p, i, o2 = {}) { const c = host.players[p]?.hand.splice(i, 1)[0]; if (!c) return false; const nid = uid(); host.items[nid] = { k: 'c', x: o2.x ?? 0, y: o2.y ?? 0, rot: o2.rot || 0, d: c.d, i: c.i, up: o2.up !== false }; return nid; },
    shuffle(id) { const p = host.items[id]; for (let i = p.cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p.cards[i], p.cards[j]] = [p.cards[j], p.cards[i]]; } },
    flip: (id) => { const it = host.items[id]; if (it) it.up = !it.up; },
    toPile: (cid, pid) => { const it = host.items[cid], p = host.items[pid]; if (it?.k !== 'c' || p?.k !== 'p') return false; p.cards.push({ d: it.d, i: it.i, up: it.up }); delete host.items[cid]; return true; },
    newPile: (cards, o2 = {}) => { const id = uid(); host.items[id] = { k: 'p', x: o2.x ?? 600, y: o2.y ?? 580, name: o2.name || '', cards: cards.map((c) => ({ d: c.d, i: c.i, up: !!c.up })) }; return id; },
    merge: (f, to) => { const a = host.items[f], b = host.items[to]; if (a?.k !== 'p' || b?.k !== 'p' || a === b) return false; b.cards.push(...a.cards); delete host.items[f]; return true; },
    move: (id, x, y) => { const it = host.items[id]; if (!it) return false; Object.assign(it, { x, y }); return true; },
    remove: (id) => { if (!host.items[id]) return false; delete host.items[id]; return true; },
    geom: () => ({ size: W, cx: W / 2, cy: W / 2, r: R }),
    say: (m) => log.push(m), announce: (m) => log.push('📣 ' + m),
    win(w, m) { host.rules.public.winners = [].concat(w); this.announce(m); },
    tell: (p, m) => tells.push(p + ': ' + m),
    schedule: (sec, tag) => timers.push(String(tag)),
    nextSeat(p) { const ps = this.players().filter((x) => x.online || x.id === p); const i = ps.findIndex((x) => x.id === p); return ps.length ? ps[(i + 1) % ps.length].id : p; },
    cardName: (r) => (r.d === 'std' ? STD[r.i].r + STD[r.i].s : '“' + r.d + ' card ' + r.i + '”'),
    card: (r) => (r.d === 'std' ? { name: STD[r.i].r + STD[r.i].s, rank: STD[r.i].r, suit: STD[r.i].s } : { name: '“' + r.d + ' card ' + r.i + '”', text: r.d + ' card ' + r.i }),
  };
  const script = new Function(`"use strict"; return (\n${templates()[tpl]}\n);`)();
  const m = {
    t, host, script, log, tells,
    d: () => host.rules.data, pub: () => host.rules.public,
    buttons: () => (script.buttons ? script.buttons(t) : []),
    btn(p, id) { const b = m.buttons().find((x) => x.id === id && (!x.pid || x.pid === p)); if (b) script.onButton(t, id, p); return !!b; },
    chat: (p, msg) => script.onChat?.(t, msg, p),
    expire() { for (const tag of timers.splice(0)) script.onTimer?.(t, tag); },
    lastTell: (p) => tells.filter((x) => x.startsWith(p + ':')).pop() || '',
    /** Gives player p `k` cards of a foreign deck `d` (another game's). */
    foreign(p, d, k) { for (let i = 0; i < k; i++) host.players[p].hand.push({ d, i }); },
  };
  script.setup?.(t);
  return m;
}

/** Bounding rect of every element matching sel: [{l, t, r, b, txt}]. */
const rects = (p, sel) => p.$$eval(sel, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, txt: el.textContent.trim().slice(0, 30) }; }));
const overlap = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;

module.exports = { mallory, templates, table, STD, rects, overlap };
