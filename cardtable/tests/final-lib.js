// Shared helpers for the final-review suites (t-final-*.js) and the logic
// suites; not a suite itself.
const path = require('path');
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

const APP = path.join(h.APP_ROOT, 'cardtable');
const { createTable, standardDeck, cleanDeck, RULES } = require(path.join(APP, 'core.js'));
const { RULES_TEMPLATES } = require(path.join(APP, 'templates.js'));

const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const STD = SUITS.flatMap((s) => RANKS.map((r) => ({ r, s })));

/** The rules runner injected into the table (core.js env.hooks): core's own
 *  evaluation, but the script stays at hand, so a test can call its hooks
 *  and helpers directly. */
function testHooks() {
  const hooks = {
    script: null,
    load(code) {
      const s = new Function(`"use strict"; return (\n${code}\n);`)();
      if (!s || typeof s !== 'object') throw new Error('script must evaluate to an ({...}) object');
      hooks.script = s;
      return String(s.name || 'Rules').slice(0, 40);
    },
    has: (k) => typeof hooks.script?.[k] === 'function',
    call: (k, ...args) => hooks.script[k](...args),
  };
  return hooks;
}

/** Template `tpl` on a real table (core.js, the real `t` facade), enabled
 *  through setRules: players named in seat order (ids = names; the first is
 *  the host; o.seats sets the angles), one pile 'deck' of the 52 standard
 *  cards (deck 'std', whose jokers are cards 52 and 53). Hooks are called
 *  directly, as the engine does: m.btn only runs a button offered to that
 *  player. Other decks are text cards ("“<deck> card <i>”"), made on first
 *  use. The clock moves a second per reading (flood control never drops a
 *  notice); m.expire() fires every timer. */
function table(tpl, names, o = {}) {
  let clock = 1e12;
  const hooks = testHooks();
  const T = createTable({
    players: Object.fromEntries(names.map((nm, k) => [nm, { name: nm, online: true, hand: [], seat: (o.seats || [])[k] ?? k * (360 / names.length) + 90 }])),
    items: { deck: { k: 'p', x: 600, y: 580, rot: 0, z: 1, name: '', cards: STD.map((_, i) => ({ d: 'std', i, up: false })) } },
    decks: { std: standardDeck(true) },
  }, { pid: names[0], now: () => (clock += 1000), hooks });
  /** A script error the engine caught (it disables the rules): fail the scenario, loudly. */
  const loud = () => { if (T.rulesError) throw new Error(`rules script error: ${T.rulesError}`); };
  T.apply(names[0], { t: 'setRules', code: RULES_TEMPLATES[tpl], enabled: true }); // runs setup()
  loud();
  const t = T.api, script = hooks.script, host = T.state, tells = [], refused = [];
  let rig = null; // standard cards to deal next, in deal order (replaces the next shuffle's)
  const shuffle = t.shuffle;
  t.shuffle = (id) => { // a rigged shuffle: the real one, then the rigged cards on top, first-dealt last
    const done = shuffle(id);
    if (done && rig) {
      const p = host.items[id], want = rig.map((nm) => STD.findIndex((c) => c.r + c.s === nm));
      p.cards = p.cards.filter((c) => !want.includes(c.i)).concat(want.reverse().map((i) => ({ d: 'std', i, up: false })));
      rig = null;
    }
    return done;
  };
  const m = {
    t, T, host, script, tells, refused,
    /** What the script logged (t.say, t.announce as "📣 …", and its ops). */
    get log() { return host.log.filter((e) => e.p === RULES).map((e) => e.txt); },
    d: () => host.rules.data, pub: () => host.rules.public,
    buttons: () => (script.buttons ? script.buttons(t) : []),
    /** rulesBtn as the engine runs it: only a button offered to p (else refused). */
    btn(p, id) {
      const b = m.buttons().find((x) => x.id === id);
      if (b && (!b.pid || b.pid === p)) { script.onButton(t, id, p); return true; }
      refused.push(p + ':' + id);
      return false;
    },
    mine: (p) => m.buttons().filter((b) => !b.pid || b.pid === p),
    chat: (p, msg) => script.onChat?.(t, msg, p),
    leave(p) { host.players[p].online = false; script.onLeave?.(t, p); },
    join(p) { host.players[p].online = true; script.onJoin?.(t, p); },
    /** Fires every scheduled timer now (the grace periods run out). */
    expire() { clock += 1e9; T.runTimers(); loud(); },
    rig: (cards) => { rig = cards; },
    lastTell(p) {
      for (const e of T.drain()) if (e.t === 'note') tells.push(e.p + ': ' + e.msg);
      return tells.filter((x) => x.startsWith(p + ':')).pop() || '';
    },
    /** Gives player p `k` cards of a foreign deck `d` (another game's). */
    foreign(p, d, k) {
      host.decks[d] ||= cleanDeck({ name: d, cards: Array.from({ length: 200 }, (_, i) => ({ txt: `${d} card ${i}` })) });
      for (let i = 0; i < k; i++) host.players[p].hand.push({ d, i });
    },
  };
  return m;
}

/** Bounding rect of every element matching sel: [{l, t, r, b, txt}]. */
const rects = (p, sel) => p.$$eval(sel, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, txt: el.textContent.trim().slice(0, 30) }; }));
const overlap = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;

module.exports = { mallory, table, rects, overlap };
