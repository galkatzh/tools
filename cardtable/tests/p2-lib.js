// Phase 2 helpers for the hidden-information and CLI suites (t-p2-hidden.js,
// t-p2-cli.js); not a suite itself. Mallory is final-lib's raw peer; arm()
// gives her page a view folded from what she received, a barrier, and the
// recursive scan of every body she received.
const h = require('./h');
const { until } = require('./p1-lib');

/** The host's own action (its click path): resolves {ok, error?}. */
const act = (page, a) => page.evaluate((x) => window.__ct.act(x), a);

/** Loads `box` on the host (loadBox, `o`: {setup, clear}, both true by
 *  default) and returns its catalog id: the box of that name in the host's
 *  catalog. Throws if the host refused it. */
async function loadBox(host, box, o = {}) {
  const r = await act(host, { t: 'loadBox', box, setup: o.setup ?? true, clear: o.clear ?? true });
  if (!r?.ok) throw new Error(`loadBox «${box.name}» failed: ${JSON.stringify(r)}`);
  const id = await host.evaluate((name) => Object.keys(window.__ct.boxes()).find((k) => window.__ct.boxes()[k].name === name), box.name);
  if (!id) throw new Error(`loadBox «${box.name}»: not in the host's catalog`);
  return id;
}

/** The host's public items, as plain JSON ({id: item}). */
const items = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__ct.view().items)));
/** The id of the item at top-left (x, y) in `its` that passes `pred` (null when none, or several). */
function at(its, x, y, pred = () => true) {
  const ids = Object.keys(its).filter((id) => its[id].x === x && its[id].y === y && pred(its[id]));
  return ids.length === 1 ? ids[0] : null;
}

/** Arms Mallory's page (final-lib mallory()): in-page helpers over what she
 *  received — M.fold() (her view: snapshots and the patches that follow
 *  them, as a guest folds them), M.scan(needles) (the recursive scan of
 *  every body on `state`, `note` and `boxes`), M.forms(hiddenIds) (the
 *  public forms of §2d) — and returns Node-side helpers. Every action she
 *  sends is paced under the flood limit (20 a second). */
async function arm(M) {
  await M.evaluate(() => {
    const M = window.M;
    const body = (m) => (typeof m?.b === 'string' ? JSON.parse(m.b) : m);
    M.body = body;
    M.view = null;
    let folded = 0;
    M.fold = () => {
      const L = M.got.state;
      for (; folded < L.length; folded++) {
        const d = body(L[folded].m);
        const v = M.view;
        if (d.kind === 'snap') {
          M.view = { boot: d.boot, seq: d.seq, to: d.to, items: { ...d.items }, players: { ...d.players }, table: d.table, seats: d.seats, handy: d.handy, rules: d.rules, log: [...(d.log || [])], hand: d.hand || [] };
        } else if (d.kind === 'patch' && v && d.boot === v.boot && d.base === v.seq) {
          Object.assign(v.items, d.items);
          for (const [id, [x, y, rot, z, at]] of Object.entries(d.pos || {})) { // (an item that only moved: its new place, D233)
            v.items[id] = { ...v.items[id], x, y, rot, z, at };
            if (at === undefined) delete v.items[id].at;
          }
          for (const id of d.del || []) delete v.items[id];
          Object.assign(v.players, d.players);
          for (const k of ['rules', 'table', 'seats', 'handy']) if (k in d) v[k] = d[k];
          if (d.log) v.log.push(...d.log);
          if (d.hand) v.hand = d.hand;
          v.seq = d.seq;
        }
      }
      return M.view;
    };
    /** Visits every key and every string of `o`, recursively: visit(s, path, isKey). */
    const walk = (o, visit, path) => {
      if (Array.isArray(o)) o.forEach((x, k) => walk(x, visit, `${path}[${k}]`));
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { visit(k, `${path}.${k}`, true); walk(v, visit, `${path}.${k}`); }
      else if (typeof o === 'string') visit(o, path, false);
    };
    /** Every hit of the scan: a needle in any key or string of any body
     *  received on `state` and `note` (`needles`), or on `boxes` (`refs`: the
     *  catalog is public, so only full type refs count there), and any key
     *  `of` anywhere, or `setup` on the boxes channel. */
    M.scan = (needles, refs) => {
      const hits = [];
      for (const ch of ['state', 'note', 'boxes']) {
        (M.got[ch] || []).forEach(({ m }, k) => {
          let d;
          try { d = body(m); } catch (err) { hits.push(`${ch}#${k}: unreadable (${err.message})`); return; }
          const list = ch === 'boxes' ? refs : needles;
          walk(d, (s, path, isKey) => {
            for (const n of list) if (s.includes(n)) hits.push(`${ch}#${k}${path}: "${n}"`);
            if (isKey && s === 'of') hits.push(`${ch}#${k}${path}: a key "of"`);
            if (isKey && ch === 'boxes' && s === 'setup') hits.push(`${ch}#${k}${path}: a setup`);
          }, '');
        });
      }
      return hits;
    };
    /** State bodies whose items are not serialized in sorted-id order (§0.2,
     *  §2d: key order never tells creation order). The ids are read from
     *  the body's text, in order; JavaScript puts integer-like keys first
     *  whatever the insertion order, so the expected order is that of an
     *  object built from the sorted ids. */
    M.unsorted = () => M.got.state.map(({ m }, k) => {
      const text = typeof m?.b === 'string' ? m.b : JSON.stringify(m);
      const ids = [...text.matchAll(/"([0-9a-f]{8})":\{"k"/g)].map((x) => x[1]);
      const want = Object.keys(Object.fromEntries([...ids].sort().map((id) => [id, 1])));
      return ids.join() === want.join() ? null : `#${k}: ${ids.slice(0, 6).join(',')}…`;
    }).filter(Boolean);
    /** Public forms (§2d) broken in any state body: a hidden piece or supply
     *  (it has `b`) with t, f or up; one of `hiddenIds` shown; a bag with
     *  `of`; a hidden pile top with t, f or i. */
    M.forms = (hiddenIds) => {
      const bad = [];
      M.got.state.forEach(({ m }, k) => {
        const d = body(m);
        for (const [id, it] of Object.entries(d.items || {})) {
          if (!it || typeof it !== 'object') continue;
          const show = JSON.stringify(it);
          if ((it.k === 'g' || it.k === 's') && 'b' in it && ('t' in it || 'f' in it || 'up' in it)) bad.push(`#${k} ${id}: hidden with t/f/up ${show}`);
          if (hiddenIds.includes(id) && !('b' in it)) bad.push(`#${k} ${id}: should be hidden ${show}`);
          if (it.k === 'b' && 'of' in it) bad.push(`#${k} ${id}: a bag with of ${show}`);
          if (it.k === 'p' && it.top?.up === false && ('t' in it.top || 'f' in it.top || 'i' in it.top)) bad.push(`#${k} ${id}: a hidden top ${show}`);
        }
      });
      return bad;
    };
  });
  let bar = 0;
  const H = {
    /** Mallory's folded view (plain JSON) — or a part of it, `pick` run in the page. */
    view: (pick = 'v') => M.evaluate((p) => {
      const v = window.M.fold(), r = v && (0, eval)(`(v) => ${p}`)(v); // eslint-disable-line no-eval
      return r === undefined ? null : JSON.parse(JSON.stringify(r));
    }, pick),
    /** Sends action `a`, paced under the flood limit. */
    async send(a) { await M.act(a); await h.sleep(60); },
    /** How many state bodies and notes she has received. */
    marks: () => M.evaluate(() => ({ state: window.M.got.state.length, note: window.M.got.note.length })),
    /** The notes' messages from index k on. */
    notesSince: (k) => M.evaluate((k) => window.M.notes().slice(k).map((n) => n.msg ?? (n.peek ? 'PEEK' : JSON.stringify(n))), k),
    /** The state bodies from index k on (parsed). */
    bodiesSince: (k) => M.evaluate((k) => window.M.got.state.slice(k).map(({ m }) => window.M.body(m)), k),
    /** Waits until everything she sent before has been applied and its
     *  patch received: she turns `marker` to a fresh angle and waits for it
     *  in her view (the host applies her actions in order); then a moment
     *  for the notes that went out with it. */
    async barrier(marker) {
      const k = (bar++ % 350) + 1;
      await H.send({ t: 'rot', id: marker, rot: k });
      await M.waitForFunction((a) => window.M.fold()?.items[a.id]?.rot === a.k, { id: marker, k }, { timeout: 30000 });
      await h.sleep(250);
    },
    /** Sends `a`, waits for the barrier, and returns the notes it brought
     *  (waiting a little for one unless `quiet`: an action that should pass)
     *  and the index of the first state body that came after it. */
    async attempt(a, marker, quiet) {
      const m = await H.marks();
      await H.send(a);
      await H.barrier(marker);
      if (!quiet) await until(async () => (await H.marks()).note > m.note, 3000, 100);
      return { notes: await H.notesSince(m.note), since: m.state };
    },
  };
  return H;
}

// --- the test boxes ------------------------------------------------------------
/** The secret types of SPY: never shown face up in t-p2-hidden, so their type
 *  ids, face labels and names must never reach Mallory outside the catalog. */
const SECRETS = {
  qzTileX: { kind: 'tile', name: 'Treasure Map', faces: ['QZT1', 'QZT2'], back: 'tback' },
  qzUnitX: { kind: 'token', name: 'Field Marshal', faces: ['QZU1'], back: 'uback' },
  qzGem1: { kind: 'token', name: 'Ruby Shard', faces: ['QZG1'] },
  qzGem2: { kind: 'token', name: 'Jade Shard', faces: ['QZG2'] },
  qzGem3: { kind: 'token', name: 'Onyx Shard', faces: ['QZG3'] },
  // a hidden die and a hidden token under one back: alike from outside
  qzDie: { kind: 'die', name: 'Shadow Die', faces: ['QZD1', 'QZD2', 'QZD3', 'QZD4', 'QZD5', 'QZD6'], back: 'cube' },
  qzTok: { kind: 'token', name: 'Masked Token', w: 56, shape: 'rect', stack: 'none', faces: ['QZK1'], back: 'cube' },
  qzRed: { kind: 'token', name: 'Crimson Chit', faces: ['QZR1'], back: 'chit' },
  qzBlue: { kind: 'token', name: 'Azure Chit', faces: ['QZB1'], back: 'chit' },
  qzGold: { kind: 'token', name: 'Hidden Gold', faces: ['QZS1'], back: 'chit' },
  qzTileM: { kind: 'tile', name: 'Mosaic Tile', faces: ['QZM1'], back: 'mback' },
  qzTokM: { kind: 'token', name: 'Odd Pebble', faces: ['QZN1'], back: 'kback' },
};
/** Mallory's test box (t-p2-hidden): a 3000 × 2000 table, three named seats
 *  (the host sits White, Mallory Black, Green stays empty), anyone may lock
 *  its pieces; shown pieces to attack, and the SECRETS face down or in bags.
 *  Every item's top-left is distinct, so tests find them by place. */
const SPY = {
  name: 'Spy kit',
  imgs: [],
  table: { shape: 'rect', w: 3000, h: 2000 },
  seats: [{ id: 'white', name: 'White', edge: 'bottom' }, { id: 'black', name: 'Black', edge: 'top' }, { id: 'green', name: 'Green', edge: 'left' }],
  lockable: 'anyone',
  backs: {
    tback: { face: { color: '#334455' } }, uback: { face: { color: '#443322' } }, cube: { face: { color: '#222222', label: '?' } },
    chit: { face: { color: '#555555' } }, mback: { face: { color: '#345678' } }, kback: { face: { color: '#876543' } },
  },
  types: {
    marker: { kind: 'token', name: 'Marker', faces: [{ color: '#ffffff' }] },
    board: { kind: 'board', name: 'Map', w: 400, h: 300 },
    d6: { kind: 'die', name: 'Die' },
    chip: { kind: 'token', name: 'Chip', faces: [{ color: '#cc0000', label: 'C' }] },
    coin: { kind: 'token', name: 'Coin', faces: [{ color: '#cccc00', label: 'K' }] },
    plate: { kind: 'tile', name: 'Plate', faces: ['P1', 'P2'] },
    wheel: { kind: 'token', name: 'Wheel', stack: 'none', faces: ['W0', 'W1', 'W2'] },
    ...SECRETS,
  },
  setup: [
    { piece: 'board', at: [200, 200] },                            // locked (a board's default)
    { piece: 'marker', at: [1470, 1000] },                         // Mallory's barrier
    { piece: 'd6', count: 21, spread: [70, 0], at: [600, 1300] },  // 21 dice in a row
    { piece: 'chip', n: 3, at: [700, 800] },
    { piece: 'chip', n: 2, at: [800, 800] },
    { piece: 'coin', n: 2, at: [900, 800] },
    { piece: 'chip', at: [1000, 800] },                            // the host claims it
    { piece: 'plate', at: [1100, 800] },                           // the host claims it (a hand type)
    { forEachSeat: [{ piece: 'chip', n: 2, at: { seat: [0, 260] }, owner: 'seat' }] },
    { supply: 'chip', at: [1200, 800] },
    { piece: 'wheel', at: [1300, 800] },
    { piece: 'chip', at: [1400, 800] },
    { piece: 'chip', n: 999, at: [1500, 800] },                    // a full stack (MAX_N)
    { bag: [{ t: 'chip', n: 999 }], name: 'Full', at: [2000, 400] }, // a bag one short of MAX_BAG
    { piece: 'qzTileX', f: 1, up: false, at: [600, 400] },
    { piece: 'qzUnitX', up: false, at: [750, 400] },
    { bag: ['qzGem1', 'qzGem2', 'qzGem3'], name: 'Loot', at: [900, 400] },
    { piece: 'qzDie', f: 4, up: false, at: [1050, 400] },
    { piece: 'qzTok', up: false, at: [1150, 400] },
    { piece: 'qzRed', n: 3, up: false, at: [1250, 400] },
    { piece: 'qzRed', n: 2, up: false, at: [1350, 400] },
    { piece: 'qzBlue', n: 2, up: false, at: [1450, 400] },
    { supply: 'qzGold', up: false, at: [1550, 400] },
    { bag: [{ t: 'qzTileM', up: false, n: 3 }, { t: 'qzTokM', up: false }], name: 'Mixed', at: [1700, 400] },
    { bag: [{ t: 'plate', n: 2 }], name: 'Tiles', at: [1850, 400] },
  ],
};
/** A second box whose catalog record t-p2-hidden deletes (case 13): one
 *  hidden piece, one shown, and three hidden tiles (a face-down pile and a
 *  hand piece to deal and play once the box is gone); the same seats as SPY. */
const GHOST = {
  name: 'Ghost box',
  imgs: [],
  seats: SPY.seats,
  backs: { gb: { face: { color: '#101010' } }, gt: { face: { color: '#202020' } } },
  types: {
    qzGhost: { kind: 'token', name: 'Spectre', faces: ['QZH1'], back: 'gb' }, lamp: { kind: 'token', name: 'Lamp', faces: ['L'] },
    qzShade: { kind: 'tile', name: 'Shade', faces: ['QZS1'], back: 'gt' },
  },
  setup: [{ piece: 'qzGhost', up: false, at: [2500, 1500] }, { piece: 'lamp', at: [2600, 1500] }, { piece: 'qzShade', up: false, count: 3, spread: [0, 120], at: [2400, 1500] }],
};

/** The CLI suite's box (t-p2-cli): spec §2i's own `table` examples, plus a
 *  die of each owner, a 3-face token, a ×4 stack and a tile with text. */
const PARLOUR = {
  name: 'Parlour',
  imgs: [],
  table: { shape: 'rect', w: 1400, h: 1200 },
  seats: [{ id: 'white', name: 'White', edge: 'bottom' }, { id: 'black', name: 'Black', edge: 'top' }],
  backs: { ub: { face: { color: '#333333' } }, tb: { face: { color: '#444444' } } },
  types: {
    man: { kind: 'token', name: 'Light man', faces: [{ color: '#eeeeee' }, { color: '#eeeeee', label: '♛' }] },
    unit: { kind: 'token', name: 'Spy', faces: ['S'], back: 'ub' },
    gold: { kind: 'token', name: 'Gold', faces: [{ color: '#ffcc00' }] },
    tile: { kind: 'tile', name: 'Tile', faces: [{ label: 'T', text: 'A tile' }] },
    ht: { kind: 'tile', name: 'Secret tile', faces: ['X'], back: 'tb' },
    board: { kind: 'board', name: 'Chessboard', w: 400 },
    die: { kind: 'die', name: 'Die' },
    wheel: { kind: 'token', name: 'Wheel', stack: 'none', faces: ['W0', 'W1', 'W2'] },
  },
  setup: [
    { piece: 'man', f: 1, n: 3, at: [412, 620] },
    { piece: 'unit', n: 2, up: false, at: [80, 90] },
    { supply: 'gold', at: [200, 200] },
    { bag: [{ t: 'tile', n: 42 }], name: 'Tiles', at: [300, 300] },
    { piece: 'ht', up: false, count: 5, at: [500, 500] },
    { piece: 'board', at: [0, 0] },
    { piece: 'die', count: 3, spread: [80, 0], at: [700, 900] },
    { piece: 'wheel', at: [900, 300] },
    { piece: 'man', n: 4, at: [1000, 600] },
    { piece: 'tile', at: [1100, 300] },
    { piece: 'tile', count: 2, at: [1200, 900] },  // the host stacks them: a pile of shown tiles
  ],
};

module.exports = { act, loadBox, items, at, arm, until, SECRETS, SPY, GHOST, PARLOUR };
