// E2E, Phase 4A game boxes through the 📦 dialog, written from spec §4l
// (t-p4-boxes items 1, 2, 4, 5, 6, 7, 9, 10, 12), §4c, §4g, §4j (attacker
// case 7) and the decisions D176–D195 — an independent suite beside the
// implementer's t-p4-boxes.js. Alice hosts on a desktop (a mouse), Bob plays
// on an iPhone 13 held upright (a finger), Carol watches on one held
// sideways; Mallory, a raw peer, joins for the export (case 7). Every upload
// is files picked in the dialog's file input, every Set up, Reset, Export
// and answer a press of the dialog's own buttons.
//  1  game.json + 6 PNGs (fixtures/lantern): the setup confirm, the layout,
//     pieces drawn with their images on every screen (the guests pull them),
//     the images as stored (a board's ≤ 2,048 px, others ≤ 560, real MIME).
//  2  the same game as a .zip in one folder: the same box (one entry), set
//     up again; 10: JSZip fetched only now, from the CDN URL (the local
//     +esm copy), read as streams, and its build pinned.
//  4  Bob's box with rules registers only (by Bob, 📜, read-only for guests,
//     no setup, rules or rulesState on the wire); the host sets it up.
//  5  the confirm names Bob and ticks rules and shuffle; the trust dialog
//     (text, buttons); "Set up without rules" leaves the rules off, Cancel
//     changes nothing, "Enable rules" runs them as the box's (rules.box).
//  9  Bob's box set up shuffles its face-down deck and pile (unticked: in
//     order); the guests' budget is shared between decks and boxes.
//  6  the host's box with rules and state: "@#k" mapped (a seat past the
//     seated players dropped, its toast); Reset restores the layout and
//     restarts the rules on the box's state — and again after a host reload.
//  7  mid-game: Export (a .zip: ids, "#k", "@#k", no pid) → play on → upload
//     the export → Set up: the host's position (items, ids, faces, places,
//     z order, hands, the rules and their state, the box id a script stored
//     remapped) and both guests' views are as exported; case 7: Mallory's
//     bodies hold no setup, rules state or hidden identity (a public mark does reach her).
//  12 the same built-in box set up twice from 📦: one catalog entry.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const L = require('./p1-lib');
const P = require('./p2t-lib');
const X = require('./p4-lib');
const { mallory } = require('./final-lib');
const { arm } = require('./p2-lib');

const { devices } = h.playwright;
const FX = path.join(__dirname, 'fixtures', 'lantern');
const PNGS = ['board.png', 'cache.png', 'lantern-dark.png', 'lantern-lit.png', 'wind-north.png', 'wind-south.png'];
const GAME = JSON.parse(fs.readFileSync(path.join(FX, 'game.json'), 'utf8'));
const RULES = fs.readFileSync(path.join(FX, 'rules.js'), 'utf8');
const SHOTS = path.join(__dirname, 'shots');
const J = JSON.stringify;
/** Hidden marks planted in Lantern Watch's rules state (§4j case 7): none may reach Mallory but the public one. */
const MARK = { vault: 'QZVAULT-7c1e', pub: 'QZPUBLIC-4b2a', sec: (k) => `QZSEC-${k}-90d3`, ask: (k) => `QZASK-${k}-51f8` };
/** Lantern Watch: the fixture game with its rules and a saved rules state (as an export writes one). */
const WATCH = {
  ...GAME, name: 'Lantern Watch', rules: 'rules.js',
  rulesState: {
    data: { lit: 0, vault: MARK.vault }, public: { lit: 0, banner: MARK.pub },
    asks: Object.fromEntries([1, 2].map((k) => [`@#${k}`, [{ id: `oath${k}`, prompt: `${MARK.ask(k)}: keep watch tonight?`, options: ['Yes', 'No'] }]])),
    secret: Object.fromEntries([1, 2, 3].map((k) => [`@#${k}`, MARK.sec(k)])),
  },
};
const pngFiles = () => PNGS.map((n) => X.file(n, fs.readFileSync(path.join(FX, n)), 'image/png'));
/** Tide Charts, Bob's box: two text decks (16 and 8 distinct cards), a whole-deck pile, a pile of the other deck, a die, rules. */
const TIDE = {
  name: 'Tide Charts', players: [2, 6],
  pieces: [{ id: 'd6', kind: 'die' }],
  decks: [
    { name: 'Charts', back: '#334155', cards: Array.from({ length: 16 }, (_, k) => ({ name: `Chart ${k + 1}`, text: `Reef ${String.fromCharCode(65 + k)}` })) },
    { name: 'Omens', back: '#4c1d95', cards: Array.from({ length: 8 }, (_, k) => ({ name: `Omen ${k + 1}`, text: `Sign ${k + 1}` })) },
  ],
  setup: [
    { deck: 'Charts', at: [300, 300] },
    { pile: [7, 3, 0, 5, 1, 6, 2, 4].map((i) => ({ deck: 'Omens', i, up: false })), at: [500, 300], name: 'Omens' },
    { piece: 'd6', at: [700, 300] },
  ],
  rules: 'rules.js',
};
const TIDE_RULES = "// Tide Charts (a test fixture)\n({ name: 'Tide Charts', setup(t) { t.data.tides ??= 0; } })\n";
const OMENS = [7, 3, 0, 5, 1, 6, 2, 4];

/** JSON with every object's keys sorted (equal content, equal text). */
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
/** A copy of v with every string (keys too) passed through f. */
const mapStr = (v, f) => (typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map((x) => mapStr(x, f))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapStr(x, f)])) : v);
/** f for mapStr: ids in `m` ({new: old}) back to the old ones, in a type ref ("<box>/<type>") too. */
const back = (m) => (s) => {
  if (Object.hasOwn(m, s)) return m[s];
  const k = s.indexOf('/');
  return k > 0 && Object.hasOwn(m, s.slice(0, k)) ? m[s.slice(0, k)] + s.slice(k) : s;
};
/** A host state's position (spec §4l item 7, D194): each item but its z (x, y apart), the z order, each
 *  player's hand and seat, the table and seats, and the rules and their state — ids through `f`. */
function position(st, f = (s) => s) {
  const ids = Object.keys(st.items).sort();
  const items = Object.fromEntries(ids.map((id) => { const { z, x, y, ...rest } = st.items[id]; return [id, mapStr(rest, f)]; }));
  const xy = Object.fromEntries(ids.map((id) => [id, [st.items[id].x, st.items[id].y]]));
  const zorder = [...ids].sort((a, b) => st.items[a].z - st.items[b].z);
  const players = Object.fromEntries(Object.entries(st.players).map(([q, pl]) => [q, { hand: mapStr(pl.hand, f), seat: pl.seat ?? null, seatId: pl.seatId ?? null }]));
  const r = st.rules;
  const rules = r && { enabled: !!r.enabled, name: r.name, box: r.box ? f(r.box) : null, ...Object.fromEntries(['data', 'public', 'asks', 'secret'].map((k) => [k, mapStr(r[k] || {}, f)])) };
  return { items, xy, zorder, players, rules, table: st.table, seats: st.seats ?? null };
}
/** Where two positions differ ('' when they don't): x, y within 0.5. */
function differ(a, b) {
  const out = [];
  for (const k of ['items', 'zorder', 'players', 'rules', 'table', 'seats']) if (canon(a[k]) !== canon(b[k])) out.push(`${k}: ${canon(a[k]).slice(0, 300)} ≠ ${canon(b[k]).slice(0, 300)}`);
  for (const [id, [x, y]] of Object.entries(a.xy)) {
    const q = b.xy[id];
    if (!q || Math.abs(q[0] - x) > 0.5 || Math.abs(q[1] - y) > 0.5) out.push(`${id} at ${x},${y} ≠ ${q}`);
  }
  return out.join('; ');
}
/** A public view's items as comparable (z left out, ids through f), and their z order. */
function pubItems(items, f = (s) => s) {
  const ids = Object.keys(items).sort();
  return { items: Object.fromEntries(ids.map((id) => { const { z, ...rest } = items[id]; return [id, mapStr(rest, f)]; })), zorder: [...ids].sort((a, b) => items[a].z - items[b].z) };
}
/** The layout of a host state without the ids it minted: a sorted list of item descriptors (z left out), plus the ids `keep` with theirs. */
const layout = (st, keep = []) => [
  ...Object.values(st.items).map(({ z, ...it }) => canon(it)).sort(),
  ...keep.map((id) => `${id} ${canon({ ...st.items[id], z: undefined })}`),
];

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-box-ui-'));
  const errors = []; // the host's console errors: {at, text}
  /** A player in its own browser (o.ctx: a device), with the 📦 watchers, the JSZip spy and (o.rtc) the byte counter. */
  async function join(name, url, o = {}) {
    const p = await env.page(name, o);
    await p.addInitScript(X.watchers);
    if (o.rtc) await p.addInitScript(L.rtcHook);
    await X.zipSpy(p);
    p.confirms = [];
    p.on('dialog', (d) => { p.confirms.push(d.message()); d.accept().catch((err) => console.error('confirm', err)); });
    await p.goto(url);
    await h.joinAs(p, name);
    await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
    p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
    p.touch = !!o.ctx?.hasTouch;
    return p;
  }
  const alice = await join('Alice', env.url);
  alice.on('console', (m) => { if (m.type() === 'error') errors.push({ at: Date.now(), text: m.text() }); });
  const bob = await join('Bob', alice.url(), { ctx: devices['iPhone 13'], rtc: true });
  const carol = await join('Carol', alice.url(), { ctx: devices['iPhone 13 landscape'] });
  // Carol watches (a precondition of this suite, not a box feature: through the action the seat menu sends)
  await carol.evaluate(() => window.__ct.act({ t: 'seat', watch: true }));
  await alice.waitForFunction((q) => window.__ct.hostState().players[q].seat == null, carol.pid);
  const guests = [bob, carol];
  const S = () => X.S(alice);
  /** Waits until host state passes `pred` (a function of the state, run here): the state, or null after `ms`. */
  async function until(pred, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
      const st = await S();
      if (pred(st)) return st;
      if (Date.now() > end) return null;
      await h.sleep(100);
    }
  }
  /** Waits until page p's view holds every item of host state st (each drawn) and its seq. */
  const synced = (p, st) => p.waitForFunction(([ids, seq]) => {
    const v = window.__ct.view();
    return v.seq >= seq && ids.every((id) => v.items[id] && document.querySelector(`.item[data-id="${id}"]`)) && Object.keys(v.items).length === ids.length;
  }, [Object.keys(st.items), st.seq], { timeout: 20000 }).then(() => true, () => false);
  /** Every image of every item of st is drawn and decoded on page p (within 20 s): the ids still missing. */
  async function imagesOn(p, st) {
    const end = Date.now() + 20000;
    let missing;
    do {
      missing = [];
      for (const id of Object.keys(st.items)) {
        const d = await X.drawnWithImages(p, id);
        if (!d.drawn || d.loaded < d.imgs) missing.push(id);
      }
      if (!missing.length) return missing;
      await h.sleep(250);
    } while (Date.now() < end);
    return missing;
  }
  /** The catalog ids of the boxes named `name`. */
  const named = (st, name) => Object.keys(st.boxes).filter((id) => st.boxes[id].name === name);
  const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `p4x-${n}.png`) });
  /** Presses button `act` (setup / reset) on box `id`'s row of page p's 📦 dialog. */
  async function rowPress(p, id, act) {
    await X.openBoxes(p);
    await X.press(p, `#box-list .box-row[data-box="${id}"] button[data-act="${act}"]`);
  }
  /** Rules buttons: page p presses its rules button `id`; resolves once the host's t.data.lit is `lit`. */
  async function light(p, lit) {
    await X.press(p, '#rules-btns button[data-rbtn="light"]');
    return !!(await until((st) => st.rules?.data?.lit === lit));
  }

  // ---------------------------------------------------------------------------------
  section('1. game.json + 6 PNGs, picked in the 📦 dialog on the desktop: set up, drawn on every screen');
  await X.openBoxes(alice);
  const hostDlg = await alice.evaluate(() => ({
    builtins: [...document.querySelectorAll('#box-builtins [data-builtin]')].map((b) => b.dataset.builtin),
    vis: ['box-builtin', 'box-export', 'box-up', 'box-now'].map((id) => { const e = document.getElementById(id); return !!e.getClientRects().length && !e.closest('.hidden'); }),
    rows: document.querySelectorAll('#box-list .box-row').length, accept: document.getElementById('box-files').accept, multiple: document.getElementById('box-files').multiple,
  }));
  ok(hostDlg.builtins.includes('draughts') && hostDlg.builtins.includes('backgammon'), `the host's 📦 lists the built-in boxes (${hostDlg.builtins})`);
  ok(hostDlg.vis.every(Boolean), 'the host sees Built in, Export, Upload a game… and "Set up now"');
  ok(hostDlg.rows === 0, 'nothing is on this table yet');
  ok(hostDlg.accept === '.json,.zip,image/*,.js' && hostDlg.multiple, `the file input takes several files: accept="${hostDlg.accept}"`);
  ok(await alice.isChecked('#box-now'), '"Set up now" is ticked by default');
  for (const g of guests) {
    await X.openBoxes(g);
    const v = await g.evaluate(() => ['box-builtin', 'box-export', 'box-up', 'box-now'].map((id) => { const e = document.getElementById(id); return !!e.getClientRects().length && !e.closest('.hidden'); }));
    ok(!v[0] && !v[1] && v[2] && !v[3], `${g === bob ? 'Bob' : 'Carol'} (a guest) sees only the list and Upload a game… (${v})`);
    ok(await X.inView(g, g === carol ? '#box-dialog .box-head button' : '#box-dialog > form menu button'), `${g === bob ? "Bob's (upright)" : "Carol's (sideways)"} close control is on the screen`);
    await X.closeBoxes(g);
  }
  let t0 = Date.now();
  let r = await X.upload(alice, [X.file('game.json', fs.readFileSync(path.join(FX, 'game.json')), 'application/json'), ...pngFiles()], { now: true });
  const progress = (await X.boxSaid(alice, t0)).filter((s) => s.el === 'box-progress').map((s) => s.msg);
  ok(PNGS.every((n) => progress.some((m) => m.includes(n))) && progress.some((m) => /\(\d+\/6\)/.test(m)), `the progress names each image as it is read, with a count (${progress.slice(0, 3).join(' | ')} …)`);
  ok(r.ask === 'setup' && !r.err, `the host's upload, "Set up now" ticked, asks to set it up (${J(r)})`);
  let q = await X.asked(alice, 'setup');
  ok(q && `${q.title} ${q.lines.join(' ')}`.includes('Set up «Lantern Isles»?') && q.lines.includes('This clears the table.'), `the confirm: "Set up «Lantern Isles»? This clears the table." (${q?.title} / ${q?.lines})`);
  ok(q && !('rules' in q.checks) && !('shuffle' in q.checks), `a box without rules, the host's own: no "Enable its rules", no "Shuffle face-down piles" (${J(q?.checks)})`);
  ok(q && q.buttons.map((b) => b.label).join() === 'Cancel,Set up', `its buttons: Cancel, Set up (${q?.buttons.map((b) => b.label)})`);
  await shot(alice, 'setup-desk');
  await X.reply(alice, 'Set up');
  await X.settle(alice);
  let st = await S();
  const isles = named(st, 'Lantern Isles');
  ok(isles.length === 1 && st.lastSetup === isles[0], `one box «Lantern Isles» in the catalog, set up (lastSetup ${st.lastSetup})`);
  ok(st.boxSrc[isles[0]]?.src === 'host', `its record says the host added it (${J(st.boxSrc[isles[0]])})`);
  ok(!(await alice.isVisible('#box-dialog')), 'the 📦 dialog closed on the table set up');
  const seated = X.ranked(st);
  ok(seated.length === 2 && seated.includes(alice.pid) && seated.includes(bob.pid), `two seated players (Carol watches): #1 ${seated[0] === alice.pid ? 'Alice' : 'Bob'}, #2 ${seated[1] === alice.pid ? 'Alice' : 'Bob'}`);
  const its = Object.entries(st.items), ref = (t) => `${isles[0]}/${t}`;
  const count = (t, pred = () => true) => its.filter(([, it]) => it.t === ref(t) && pred(it)).length;
  ok(its.length === 8, `8 items: the board, a lantern per seated player, the lit lantern, 2 caches, a die, the pile (${its.length})`);
  ok(st.items['5ea0c4a7']?.t === ref('sea') && st.items['1a7e0001']?.t === ref('lantern') && st.items['0dec0a11']?.k === 'p', 'the entries\' own ids are kept: the board 5ea0c4a7, the lantern 1a7e0001, the pile 0dec0a11');
  ok(st.items['1a7e0001']?.f === 1 && /:d3$/.test(st.items['1a7e0001']?.at || ''), `the lit lantern on d3 (f ${st.items['1a7e0001']?.f}, at ${st.items['1a7e0001']?.at})`);
  ok(count('cache', (it) => it.up === false) === 2 && count('lantern', (it) => it.owner) === 2, 'two caches face down; a lantern owned by each seated player');
  ok(seated.every((q2) => count('lantern', (it) => it.owner === q2) === 1), 'each seated player owns one lantern ("owner": "seat")');
  const winds = st.boxes[isles[0]].decks?.Winds;
  ok(winds && canon(st.items['0dec0a11'].cards.map((c) => [c.d, c.i, !!c.up])) === canon([1, 2, 4, 5].map((i) => [winds, i, false])), 'the pile holds Winds cards 1, 2, 4, 5 face down, in order');
  ok(canon(st.players[seated[0]].hand.map((c) => [c.d, c.i])) === canon([[winds, 0]]) && canon(st.players[seated[1]].hand.map((c) => [c.d, c.i])) === canon([[winds, 3]]), 'hands by "#k": #1 holds the North wind, #2 the Squall');
  ok(st.log.some((e) => e.p === alice.pid && e.txt === 'set up «Lantern Isles» (8 items)'), `the log: "set up «Lantern Isles» (8 items)" (${st.log.filter((e) => /set up/.test(e.txt)).map((e) => e.txt)})`);
  for (const [p, who] of [[alice, 'Alice'], [bob, 'Bob'], [carol, 'Carol']]) {
    ok(await synced(p, st), `${who}'s screen draws every item`);
    const miss = await imagesOn(p, st);
    ok(!miss.length, `${who}'s screen shows every piece with its picture loaded${miss.length ? ` (missing: ${miss})` : ''}`);
  }
  const bobHand = await bob.evaluate(() => window.__ct.view().hand);
  ok(canon(bobHand.map((c) => [c.d, c.i])) === canon(st.players[bob.pid].hand.map((c) => [c.d, c.i])), "Bob's screen holds his own hand");
  // The images as stored: re-encoded, each its real type, a board's at most 2,048 px a side, others 560
  const box1 = st.boxes[isles[0]], deck1 = (await alice.evaluate((d) => window.__ct.hostState().decks?.[d] ?? null, winds));
  const boxImgs = await Promise.all(box1.imgs.map((id) => X.asset(alice, id)));
  ok(boxImgs.length === 4 && boxImgs.every((a) => a && a.mime === a.magic && a.size <= 2e6), `the box's 4 images are stored, each typed by its bytes (${boxImgs.map((a) => a && `${a.mime}/${a.magic} ${a.w}×${a.h}`)})`);
  ok(boxImgs.every((a) => a?.magic === 'image/webp'), 'Chromium writes WebP: each is stored as WebP');
  const sides = boxImgs.map((a) => a && `${a.w}×${a.h}`).sort();
  ok(sides.includes('1400×1000') && sides.includes('560×560') && sides.filter((s) => s === '128×128').length === 2, `the board keeps its 1,400 px (≤ 2,048), the 700 px cache is drawn at 560, the lanterns at 128 (${sides})`);
  // Bob's screen shows the board and both lantern faces: he pulled at least their bytes from the host (1b.5)
  const shown = boxImgs.filter((a) => a && (a.w === 1400 || a.w === 128)).reduce((n, a) => n + a.size, 0), got = await bob.evaluate(() => window.__rtc.recv.asset || 0);
  ok(shown > 0 && got >= shown, `Bob pulled the images he shows from the host over the asset channel (${got} bytes received ≥ ${shown})`);
  const deckImgs = deck1 ? await Promise.all((deck1.imgs || []).map((id) => X.asset(alice, id))) : [];
  ok(deckImgs.length === 2 && deckImgs.every((a) => a && a.mime === a.magic && a.w === 250 && a.h === 350), `the deck's 2 card images too (${deckImgs.map((a) => a && `${a.mime} ${a.w}×${a.h}`)})`);
  await shot(bob, 'isles-phone');
  await X.openBoxes(alice);
  const xoff = await alice.evaluate(() => ['box-x-rules', 'box-x-state'].map((id) => ({ on: document.getElementById(id).checked, off: document.getElementById(id).disabled })));
  ok(xoff.every((o) => !o.on && o.off), `no rules on this table: Export's "Include the rules" and "Include the game state" are unticked and disabled (D191: ${J(xoff)})`);
  await X.closeBoxes(alice);

  // ---------------------------------------------------------------------------------
  section('2 + 10. the same game as a .zip (one folder): JSZip only now, from the CDN; the same box');
  ok(alice.jszipAt.length === 0 && (await alice.evaluate(() => window.__zip === undefined)), 'no page has asked for JSZip yet: a plain upload never loads it');
  ok(bob.jszipAt.length === 0 && carol.jszipAt.length === 0, "nor have the guests' pages");
  t0 = Date.now();
  r = await X.upload(alice, [path.join(__dirname, 'fixtures', 'lantern.zip')], { now: true });
  ok(r.ask === 'setup' && !r.err, `the zip is read; "Set up now" asks again (${J(r)})`);
  ok(alice.jszipAt.length === 1 && alice.jszipAt[0] >= t0, `JSZip was fetched once, after the zip was picked (${alice.jszipAt.length} requests for ${X.JSZIP_URL})`);
  const said = (await X.boxSaid(alice, t0)).map((s) => s.msg);
  ok(said.some((m) => m.includes('That box is already on this table')), `the same box: "That box is already on this table" (${said.slice(-3).join(' | ')})`);
  const spy = await alice.evaluate(() => window.__zip);
  ok(spy.loads.length === 1 && spy.loads[0] === fs.statSync(path.join(__dirname, 'fixtures', 'lantern.zip')).size, `loadAsync read the zip once (${J(spy.loads)})`);
  const reads = spy.calls.filter(([, n]) => !n.endsWith('/'));
  ok(reads.length >= 7 && reads.every(([m]) => m === 'internalStream'), `every entry was read as a stream, never with async() (${J([...new Set(spy.calls.map(([m]) => m))])}, ${reads.length} reads)`);
  await X.reply(alice, 'Set up');
  await X.settle(alice);
  st = await S();
  ok(canon(named(st, 'Lantern Isles')) === canon(isles) && st.lastSetup === isles[0], 'still one «Lantern Isles» in the catalog, set up again');
  ok(Object.keys(st.items).length === 8 && st.items['1a7e0001']?.f === 1, 'the layout is laid out again');
  ok(!(await imagesOn(bob, st)).length, "Bob's screen draws it with its pictures");
  // The build the app gets is jsdelivr's +esm wrapping of 3.10.1, and it has what the defence reads
  const cdn = path.join(__dirname, '.cdn-cache', 'jszip_3.10.1__esm.js');
  ok(fs.existsSync(cdn) && /Original file: \/npm\/jszip@3\.10\.1\/dist\/jszip\.min\.js/.test(fs.readFileSync(cdn, 'utf8').slice(0, 400)), 'the routed copy is the +esm build of jszip@3.10.1');
  const pin = await alice.evaluate(async ([url, b64]) => {
    const JSZip = (await import(`${url}?real`)).default;
    const z = await JSZip.loadAsync(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const f = z.files['lantern-isles/game.json'];
    return { version: JSZip.version, size: f?._data?.uncompressedSize, stream: typeof f?.internalStream, orig: f?.unsafeOriginalName };
  }, [X.JSZIP_URL, fs.readFileSync(path.join(__dirname, 'fixtures', 'lantern.zip')).toString('base64')]);
  ok(pin.version === '3.10.1' && pin.size === fs.statSync(path.join(FX, 'game.json')).size && pin.stream === 'function', `the build exposes file._data.uncompressedSize (${pin.size}) and internalStream (${pin.stream}), version ${pin.version}`);
  ok(pin.orig === 'lantern-isles/game.json', `and unsafeOriginalName, the name as written (${pin.orig})`);

  // ---------------------------------------------------------------------------------
  section('4 + 5 + 9. Bob uploads a box with rules from his phone: it registers only; the host sets it up');
  const before = await S();
  const tideFiles = [X.file('game.json', J(TIDE, null, 1), 'application/json'), X.file('rules.js', TIDE_RULES, 'text/javascript')];
  r = await X.upload(bob, tideFiles);
  ok(!r.err && r.progress.startsWith('«Tide Charts»'), `Bob's dialog says the box reached the table (${r.progress || r.err})`);
  st = await until((s) => named(s, 'Tide Charts').length === 1);
  const tide = st && named(st, 'Tide Charts')[0];
  ok(!!tide, 'the host\'s catalog holds «Tide Charts»');
  ok(st && canon(st.boxSrc[tide]) === canon({ src: 'upload', by: bob.pid }), `its record: a guest's upload, by Bob (${J(st?.boxSrc[tide])})`);
  ok(st && st.lastSetup === before.lastSetup && canon(st.items) === canon(before.items), 'nothing is laid out: the table and lastSetup are as they were');
  ok(st && st.log.some((e) => e.p === bob.pid && e.txt === 'added the box «Tide Charts» (1 piece type)'), `the log: Bob "added the box «Tide Charts» (1 piece type)" (${st?.log.filter((e) => /added the box/.test(e.txt)).map((e) => e.txt)})`);
  for (const [p, who] of [[bob, 'Bob'], [carol, 'Carol'], [alice, 'Alice']]) {
    await X.openBoxes(p);
    await p.waitForSelector(`#box-list .box-row[data-box="${tide}"]`, { timeout: 15000 }).catch(() => null);
    const rw = await X.row(p, tide);
    ok(rw && rw.text.includes('📜') && rw.text.includes('by Bob'), `${who}'s 📦 lists it with 📜 and "by Bob" (${rw?.text})`);
    ok(rw && (p === alice ? rw.buttons.includes('setup') && !rw.buttons.includes('reset') : rw.buttons.length === 0), `${who}: ${p === alice ? 'Set up (no Reset: it was never set up)' : 'read-only'} (${rw?.buttons})`);
    if (p !== alice) await X.closeBoxes(p);
  }
  const gbox = await bob.evaluate((id) => window.__ct.boxes()[id] ?? null, tide);
  ok(gbox && !('setup' in gbox) && !('rules' in gbox) && !('rulesState' in gbox), `a guest holds the box without its setup or rules (${gbox && Object.keys(gbox)})`);
  // the host sets it up: the confirm names Bob, rules and shuffle ticked; then the trust dialog
  await rowPress(alice, tide, 'setup');
  q = await X.asked(alice, 'setup');
  ok(q && `${q.title} ${q.lines.join(' ')}`.includes('Set up «Tide Charts»?') && q.lines.includes('This clears the table.'), `the confirm: "Set up «Tide Charts»? This clears the table." (${q?.title} / ${q?.lines})`);
  ok(q && q.lines.includes('Bob added this box and knows its starting layout.'), `it names the uploader: "Bob added this box and knows its starting layout." (${q?.lines})`);
  ok(q && q.checks.rules === true && q.checks.shuffle === true && q.labels.includes('Enable its rules') && q.labels.includes('Shuffle face-down piles'), `"Enable its rules" and "Shuffle face-down piles", both ticked (${J(q?.checks)}; ${q?.labels})`);
  await X.reply(alice, 'Set up');
  q = await X.asked(alice, 'trust');
  const TRUST = '«Tide Charts» comes with rules written by its author, added by Bob. A rules script sees every hand and hidden piece and can reveal them. Enable the rules?';
  ok(q && q.lines.join(' ') === TRUST, `the trust dialog: "${q?.lines.join(' ')}"`);
  ok(q && canon(q.buttons.map((b) => b.label).sort()) === canon(['Cancel', 'Enable rules', 'Set up without rules']), `its buttons: Enable rules, Set up without rules, Cancel (${q?.buttons.map((b) => b.label)})`);
  await shot(alice, 'trust-desk');
  await X.reply(alice, 'Set up without rules');
  await X.settle(alice);
  st = await S();
  const pileOf = (s, name) => Object.values(s.items).find((it) => it.k === 'p' && it.name === name);
  const tdecks = st.boxes[tide].decks;
  ok(st.lastSetup === tide && !st.rules?.enabled, `set up without rules: lastSetup is «Tide Charts», the rules are off (${J(st.rules && { enabled: st.rules.enabled, name: st.rules.name })})`);
  ok(st.log.some((e) => e.txt === 'set up «Tide Charts» (3 items), face-down piles shuffled'), `the log: "set up «Tide Charts» (3 items), face-down piles shuffled" (${st.log.filter((e) => /Tide/.test(e.txt)).map((e) => e.txt)})`);
  let charts = pileOf(st, 'Charts')?.cards.map((c) => c.i) || [], omens = pileOf(st, 'Omens')?.cards.map((c) => c.i) || [];
  const inOrder = (l) => l.length > 1 && (l.every((x, k) => k === 0 || x > l[k - 1]) || l.every((x, k) => k === 0 || x < l[k - 1]));
  ok(charts.length === 16 && new Set(charts).size === 16 && !inOrder(charts), `9: Bob's box: the whole-deck pile of 16 is shuffled (${charts})`);
  ok(omens.length === 8 && canon([...omens].sort()) === canon([...OMENS].sort()) && canon(omens) !== canon(OMENS) && canon(omens) !== canon([...OMENS].reverse()), `9: and the face-down pile of 8 (${omens} from ${OMENS})`);
  ok(pileOf(st, 'Charts')?.cards.every((c) => c.d === tdecks.Charts && c.up === false), 'the deck pile lies face down');
  // Reset of a box set up without its rules: laid out again (its own shuffle default), the rules stay off
  await rowPress(alice, tide, 'reset');
  q = await X.asked(alice, 'reset');
  ok(q && q.title === 'Reset «Tide Charts»?' && !q.lines.join(' ').includes('rules'), `Reset asks: "${q?.title}" (${q?.lines}): no word of rules, they aren't running`);
  await X.reply(alice, 'Reset');
  st = await until((s) => s.log.some((e) => e.txt === 'reset «Tide Charts»'));
  await X.settle(alice);
  st = await S();
  ok(!!st && !st.rules?.enabled && st.lastSetup === tide && pileOf(st, 'Charts')?.cards.length === 16 && Object.keys(st.items).length === 3, 'Reset: «Tide Charts» laid out again, its rules still off (they weren\'t running)');
  // Cancel in the trust dialog changes nothing
  let d0 = await alice.evaluate(() => window.__ct.digest()), log0 = st.log.length;
  await rowPress(alice, tide, 'setup');
  q = await X.asked(alice, 'setup');
  await X.reply(alice, 'Set up', { 'Shuffle face-down piles': false });
  q = await X.asked(alice, 'trust');
  ok(!!q, 'Set up again: the trust dialog asks again (nothing remembers the last answer)');
  await X.reply(alice, 'Cancel');
  await X.settle(alice);
  st = await S();
  ok((await alice.evaluate(() => window.__ct.digest())) === d0 && st.log.length === log0 && st.lastSetup === tide, 'Cancel: the table, the log and lastSetup are as they were');
  // Enable rules, unshuffled
  await rowPress(alice, tide, 'setup');
  await X.asked(alice, 'setup');
  await X.reply(alice, 'Set up', { 'Shuffle face-down piles': false });
  await X.asked(alice, 'trust');
  await X.reply(alice, 'Enable rules');
  st = await until((s) => s.rules?.enabled && s.rules.box === tide);
  ok(!!st, `"Enable rules": the box's rules run as its rules (rules.box = «Tide Charts»: ${J(st?.rules && { enabled: st.rules.enabled, name: st.rules.name, box: st.rules.box })})`);
  await X.settle(alice);
  st = await S();
  charts = pileOf(st, 'Charts')?.cards.map((c) => c.i) || [];
  omens = pileOf(st, 'Omens')?.cards.map((c) => c.i) || [];
  ok(inOrder(charts) && charts.length === 16, `"Shuffle" unticked: the deck pile in deck order (${charts})`);
  ok(canon(omens) === canon(OMENS) || canon(omens) === canon([...OMENS].reverse()), `and the pile as the box lists it (${omens})`);
  ok(st.log.filter((e) => /^set up «Tide Charts»/.test(e.txt)).at(-1)?.txt === 'set up «Tide Charts» (3 items)', 'the log says no shuffle this time');
  ok(st.rules?.name === 'Tide Charts' && canon(st.rules.data) === canon({ tides: 0 }), `the script ran its setup (t.data ${J(st.rules?.data)})`);
  // a table without images exports as one .json, its rules inline (§4g, D191)
  await X.openBoxes(alice);
  const [jdl] = await Promise.all([alice.waitForEvent('download', { timeout: 20000 }), alice.click('#box-x-go')]);
  const jpath = path.join(tmp, jdl.suggestedFilename());
  await jdl.saveAs(jpath);
  const tj = jdl.suggestedFilename() === 'Tide Charts.json' && JSON.parse(fs.readFileSync(jpath, 'utf8'));
  ok(!!tj, `no image on the table: the export is "${jdl.suggestedFilename()}" (a .json)`);
  ok(tj && tj.rules === TIDE_RULES && canon(tj.rulesState?.data) === canon({ tides: 0 }), 'with the rules inline and their state');
  ok(tj && tj.decks?.length === 2 && tj.decks.every((d) => d.cards.every((c) => !c.file)), 'its decks as text cards, no file named');
  await X.closeBoxes(alice);

  // ---------------------------------------------------------------------------------
  section('6. the host\'s box with rules and saved state: "@#k" mapped; Reset, and Reset after a reload');
  const watchFiles = [X.file('game.json', J(WATCH, null, 1), 'application/json'), ...pngFiles(), X.file('rules.js', RULES, 'text/javascript')];
  t0 = Date.now();
  r = await X.upload(alice, watchFiles, { now: true });
  q = await X.asked(alice, 'setup');
  ok(q && q.title.includes('Lantern Watch') && q.lines.includes('This clears the table.') && q.checks.rules === true && !('shuffle' in q.checks), `the confirm: clears the table, "Enable its rules" ticked, no shuffle for the host's own box (${J(q?.checks)})`);
  ok(q && !q.lines.some((l) => /added this box/.test(l)), 'no uploader line for the host\'s own box');
  await X.reply(alice, 'Set up');
  q = await X.asked(alice, 'trust');
  ok(q && q.lines.join(' ') === '«Lantern Watch» comes with rules written by its author. A rules script sees every hand and hidden piece and can reveal them. Enable the rules?', `the trust dialog for the host's own upload too (${q?.lines.join(' ')})`);
  await X.reply(alice, 'Enable rules');
  st = await until((s) => s.rules?.enabled && s.rules.name === 'Lantern Watch' && s.lastSetup === named(s, 'Lantern Watch')[0] && s.rules.box === s.lastSetup);
  await X.settle(alice);
  st = await S();
  const lw = named(st, 'Lantern Watch')[0];
  ok(!!lw && st.lastSetup === lw && st.rules?.enabled && st.rules.box === lw, `set up with its rules running as the box's (rules.box ${st.rules?.box})`);
  const rk = X.ranked(st);
  ok(canon(st.rules?.data) === canon({ lit: 0, vault: MARK.vault, box: lw }), `t.data is the box's saved data, and the script found its box (${J(st.rules?.data)})`);
  ok(st.rules?.public?.banner === MARK.pub && st.rules.public.lit === 0, 't.public is the box\'s saved public state');
  ok(canon(Object.keys(st.rules?.secret || {}).sort()) === canon([...rk].sort()) && rk.every((q2, k) => st.rules.secret[q2] === MARK.sec(k + 1)), `"@#1" and "@#2" are the seated players' secrets now (${J(st.rules?.secret)})`);
  ok(rk.every((q2, k) => st.rules.asks?.[q2]?.[0]?.prompt?.startsWith(MARK.ask(k + 1))), `and their asks (${J(Object.fromEntries(Object.entries(st.rules?.asks || {}).map(([k, v]) => [k, v.map((a) => a.id)])))})`);
  const tw = await X.toasts(alice, t0);
  ok(tw.includes("Some saved state referred to players who weren't seated; it was dropped"), `"@#3" (two seated players): dropped, with its toast (${tw.slice(-3).join(' | ')})`);
  ok(!tw.includes('Some saved game state was invalid and was dropped'), 'nothing in it was invalid');
  ok(await bob.waitForFunction((m) => window.__ct.view().sec === m, MARK.sec(rk.indexOf(bob.pid) + 1), { timeout: 15000 }).then(() => true, () => false), "Bob's own secret reached his screen");
  ok((await carol.evaluate(() => window.__ct.view().sec)) == null, 'Carol (watching) has none');
  const L0 = layout(st, ['5ea0c4a7', '1a7e0001', '0dec0a11']);
  // play: Alice lights two lanterns, moves the lit one
  ok(await light(alice, 1) && await light(alice, 2), "Alice's 🏮 twice: t.data.lit is 2");
  /** Alice drags the lit lantern (1a7e0001) about two cells right and one down: the host state once it moved, or null. */
  async function moveLit() {
    const was = (await S()).items['1a7e0001'], c = await P.itemXY(alice, '1a7e0001');
    await P.mouseDrag(alice, c, { x: c.x + 130, y: c.y + 70 });
    return until((s) => s.items['1a7e0001'] && (s.items['1a7e0001'].x !== was.x || s.items['1a7e0001'].y !== was.y));
  }
  st = await moveLit();
  ok(st && !/:d3$/.test(st.items['1a7e0001'].at || ''), `Alice dragged the lit lantern off d3 (now ${st?.items['1a7e0001'].at})`);
  await rowPress(alice, lw, 'reset');
  q = await X.asked(alice, 'reset');
  ok(q && q.title === 'Reset «Lantern Watch»?', `Reset asks first: "${q?.title}" (${q?.lines})`);
  await X.reply(alice, 'Reset');
  st = await until((s) => s.rules?.enabled && s.rules.data?.lit === 0 && /:d3$/.test(s.items['1a7e0001']?.at || ''));
  await X.settle(alice);
  st = await S();
  ok(canon(layout(st, ['5ea0c4a7', '1a7e0001', '0dec0a11'])) === canon(L0), 'Reset: the layout is the setup\'s again (every item, the kept ids in place)');
  ok(st.log.some((e) => e.txt === 'reset «Lantern Watch»'), 'the log: "reset «Lantern Watch»"');
  ok(st.rules?.enabled && st.rules.box === lw && st.rules.data?.lit === 0 && st.rules.data.vault === MARK.vault, `the box's rules restarted on its saved state (lit ${st.rules?.data?.lit}, rules.box ${st.rules?.box})`);
  ok(st.lastSetup === lw, 'lastSetup is still the box');
  // a host reload: lastSetup and rules.box are kept, Reset is offered and works
  ok(await light(alice, 1), 'lit once more');
  await h.sleep(1500); // (a host saves at most once a second, deferred)
  await alice.reload();
  await alice.waitForFunction(() => window.__ct?.hostState()?.rules && window.__ct.view()?.seq > 0, null, { timeout: 30000 });
  await X.settle(alice);
  st = await S();
  ok(st.lastSetup === lw && st.rules?.box === lw && st.rules.enabled && st.rules.data.lit === 1, `after a host reload: lastSetup, rules.box and the running rules are kept (lit ${st.rules?.data?.lit})`);
  for (const g of guests) await g.waitForFunction((seq) => window.__ct.view().seq >= seq, st.seq, { timeout: 30000 });
  st = await moveLit();
  ok(!!st, 'the lantern moved again');
  await X.openBoxes(alice);
  const rw = await X.row(alice, lw);
  ok(rw?.buttons.includes('reset'), `Reset is offered on «Lantern Watch» after the reload (${rw?.buttons})`);
  ok((await X.row(alice, tide))?.buttons.includes('reset') === false, 'and on no other box');
  await rowPress(alice, lw, 'reset');
  await X.asked(alice, 'reset');
  await X.reply(alice, 'Reset');
  st = await until((s) => s.rules?.enabled && s.rules.data?.lit === 0 && /:d3$/.test(s.items['1a7e0001']?.at || ''));
  await X.settle(alice);
  st = await S();
  ok(canon(layout(st, ['5ea0c4a7', '1a7e0001', '0dec0a11'])) === canon(L0), 'Reset after the reload: the setup\'s layout again');
  ok(st.rules?.enabled && st.rules.box === lw && st.rules.data.lit === 0, 'and the box\'s rules restarted on its saved state');

  // ---------------------------------------------------------------------------------
  section('7. mid-game: Export → play on → upload the export → Set up: the position comes back (case 7: Mallory)');
  const invite = alice.url();
  const M = await mallory(env, invite, 3);
  await arm(M);
  await M.act({ t: 'hello' });
  await M.waitForFunction((q2) => window.M.fold()?.players?.[q2], 'ffffffffffffffff', { timeout: 20000 });
  ok(true, 'Mallory (a raw peer) sits at the table');
  st = await until((s) => s.players.ffffffffffffffff?.seat != null);
  ok(!!st, 'the host seats her');
  // mid-game: lanterns lit by Alice and by Bob's finger, the lit lantern moved, a card drawn into Alice's hand
  ok(await light(alice, 1), "Alice's 🏮");
  await bob.waitForSelector('#rules-btns button[data-rbtn="light"]', { timeout: 15000 });
  ok(await light(bob, 2), "Bob's 🏮 (a tap on his phone)");
  st = await moveLit();
  const handBefore = st.players[alice.pid].hand.length;
  await alice.dblclick('.item[data-id="0dec0a11"]');
  st = await until((s) => s.players[alice.pid].hand.length === handBefore + 1);
  ok(!!st, 'Alice drew a card from the Winds pile (a double-click)');
  await X.settle(alice);
  const S1 = await S(), P1 = position(S1);
  const V1 = await Promise.all(guests.map((g) => g.evaluate(() => JSON.parse(JSON.stringify({ items: window.__ct.view().items, hand: window.__ct.view().hand })))));
  // Export, with the rules and the game state (ticked by default while the rules run)
  await X.openBoxes(alice);
  const xo = await alice.evaluate(() => ['box-x-rules', 'box-x-state'].map((id) => ({ on: document.getElementById(id).checked, off: document.getElementById(id).disabled })));
  ok(xo.every((o) => o.on && !o.off), `"Include the rules" and "Include the game state" are ticked while the rules run (${J(xo)})`);
  const [dl] = await Promise.all([alice.waitForEvent('download', { timeout: 20000 }), alice.click('#box-x-go')]);
  const zipPath = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(zipPath);
  ok(dl.suggestedFilename() === 'Lantern Watch.zip', `a .zip (the box has images), named after it: "${dl.suggestedFilename()}"`);
  ok(dl.url().startsWith('blob:'), `downloaded through an object URL (${dl.url().slice(0, 20)}…)`);
  ok(await alice.waitForFunction(() => document.getElementById('box-x-msg').textContent.startsWith('Saved Lantern Watch.zip'), null, { timeout: 10000 }).then(() => true, () => false), 'the dialog says it was saved');
  const files = X.unzip(fs.readFileSync(zipPath));
  ok(files['game.json'] && files['rules.js'] && Object.keys(files).some((n) => n.startsWith('images/')), `game.json, rules.js and the images (${Object.keys(files).join(', ')})`);
  const gj = JSON.parse(files['game.json'].toString('utf8')), gtext = files['game.json'].toString('utf8');
  ok(files['rules.js']?.toString('utf8') === RULES && gj.rules === 'rules.js', 'the rules go as rules.js, the script\'s own text');
  ok(gj.id === lw && gj.name === 'Lantern Watch', `the box keeps its id (${gj.id}) and name`);
  const entryIds = new Set(JSON.stringify(gj.setup).match(/"id":"([0-9a-f]{8})"/g)?.map((s) => s.slice(6, 14)));
  ok(Object.keys(S1.items).every((id) => entryIds.has(id)), `every item goes with its own id (${Object.keys(S1.items).filter((id) => !entryIds.has(id))} missing)`);
  const seatedNow = X.ranked(S1);
  ok(Object.keys(S1.players).every((q2) => !gtext.includes(q2)), 'no player id is written anywhere in game.json');
  ok(canon(Object.keys(gj.rulesState?.secret || {}).sort()) === canon(seatedNow.filter((q2) => S1.rules.secret[q2]).map((q2) => `@#${seatedNow.indexOf(q2) + 1}`).sort()), `the secrets go keyed "@#k" (${Object.keys(gj.rulesState?.secret || {})})`);
  ok(gj.rulesState?.data?.vault === MARK.vault && gj.rulesState.data.lit === 2 && gj.rulesState.data.box === lw, `the game state goes too: t.data (${J(gj.rulesState?.data)})`);
  ok(/"#\d"/.test(J(gj.setup)) && J(gj.setup).includes('"hands"'), 'owners and hands go by "#k"');
  await X.closeBoxes(alice);
  // play on, so the upload must undo it
  ok(await light(alice, 3), 'play goes on: 🏮 again');
  await moveLit();
  // upload the export, set it up with its rules
  t0 = Date.now();
  r = await X.upload(alice, [zipPath], { now: true });
  q = await X.asked(alice, 'setup');
  ok(q && q.lines.includes('This clears the table.') && q.checks.rules === true, 'the export, uploaded: its confirm clears the table, "Enable its rules" ticked');
  await X.reply(alice, 'Set up');
  q = await X.asked(alice, 'trust');
  ok(!!q, 'the trust dialog asks for its rules');
  await X.reply(alice, 'Enable rules');
  st = await until((s) => s.rules?.enabled && s.lastSetup !== lw && s.rules.box === s.lastSetup);
  await X.settle(alice);
  const S2 = await S(), nb = S2.lastSetup;
  ok(!!st && nb && S2.boxes[nb]?.name === 'Lantern Watch' && nb !== lw, `a new box (its id ${lw} was taken here, so it is ${nb}), set up with its rules running`);
  const tw2 = await X.toasts(alice, t0);
  ok(tw2.some((m) => /^\d+ ids? had to change; a running script that stored (it|them) may misbehave$/.test(m)), `the toast says ids had to change (${tw2.filter((m) => /had to change/.test(m))})`);
  const idMap = { [nb]: lw, [S2.boxes[nb].decks.Winds]: S1.boxes[lw].decks.Winds };
  const P2 = position(S2, back(idMap));
  const diff = differ(P1, P2);
  ok(!diff, `the host's position is the exported one: items, ids, faces, places, z order, hands, the rules and their state${diff ? ` — ${diff}` : ''}`);
  ok(S2.rules.data.box === nb, `the box id the script stored was remapped to the new box (${S2.rules.data.box})`);
  for (const [k, g] of guests.entries()) {
    const who = k ? 'Carol' : 'Bob';
    ok(await synced(g, S2), `${who}'s screen draws the re-imported table`);
    const V2 = await g.evaluate(() => JSON.parse(JSON.stringify({ items: window.__ct.view().items, hand: window.__ct.view().hand })));
    ok(canon(pubItems(V2.items, back(idMap))) === canon(pubItems(V1[k].items)), `${who}'s view of the table is the exported one`);
    ok(canon(mapStr(V2.hand, back(idMap))) === canon(V1[k].hand), `${who}'s hand too`);
  }
  // case 7: nothing hidden of the exported, re-imported game reached Mallory
  await h.sleep(1500);
  // (no mark is Mallory's: the box's state was seeded before she sat down — "@#1" Alice, "@#2" Bob, "@#3" dropped —
  // and the export keyed Alice's and Bob's by their places then, so every secret and ask mark is another player's)
  const scan = await M.evaluate(([needles, nb]) => {
    const body = (m) => (typeof m?.b === 'string' ? JSON.parse(m.b) : m), hits = [], keys = [];
    const walk = (o, at, ch, k) => {
      if (Array.isArray(o)) o.forEach((x, j) => walk(x, `${at}[${j}]`, ch, k));
      else if (o && typeof o === 'object') for (const [key, v] of Object.entries(o)) { if (ch === 'boxes' && ['setup', 'rules', 'rulesState'].includes(key)) keys.push(`${ch}#${k}${at}.${key}`); for (const n of needles) if (key.includes(n)) hits.push(`${ch}#${k}${at}.${key}`); walk(v, `${at}.${key}`, ch, k); }
      else if (typeof o === 'string') for (const n of needles) if (o.includes(n)) hits.push(`${ch}#${k}${at}: ${n}`);
    };
    const counts = {};
    for (const [ch, list] of Object.entries(window.M.got)) {
      counts[ch] = list.length;
      list.forEach(({ m }, k) => { let d; try { d = body(m); } catch { d = m; } walk(d, '', ch, k); });
    }
    const pub = Object.values(window.M.got).some((l) => l.some(({ m }) => JSON.stringify(m).includes('QZPUBLIC-4b2a')));
    const got = (window.M.got.boxes || []).some(({ m }) => { try { return Object.hasOwn(body(m), nb); } catch { return false; } });
    return { hits, keys, counts, pub, got };
  }, [[MARK.vault, ...[1, 2, 3].map(MARK.sec), ...[1, 2].map(MARK.ask), `${nb}/cache`, `${lw}/cache`], nb]);
  ok(scan.counts.state > 0 && scan.got, `Mallory received ${J(scan.counts)} messages, the re-imported box among them (the scan covers it)`);
  ok(!scan.keys.length, `no box she received carries a setup, rules or rulesState (${scan.keys.slice(0, 5)})`);
  ok(!scan.hits.length, `the recursive scan finds no hidden data, no other player's secret or ask, no face-down cache's type (${scan.hits.slice(0, 5)})`);
  ok(scan.pub, 'the public mark (t.public) did reach her: the scan sees the rules state that may travel');
  const forms = await M.evaluate((ids) => window.M.forms(ids), Object.keys(S2.items).filter((id) => S2.items[id].up === false && S2.items[id].k === 'g'));
  ok(!forms.length, `every face-down cache reached her as its back only (${forms.slice(0, 3)})`);

  // ---------------------------------------------------------------------------------
  section('9. the guests\' budget is shared by decks and boxes');
  const used0 = (await S()).guestDeckChars || 0;
  await X.press(bob, '#add-deck-btn');
  await bob.waitForSelector('#deck-dialog[open]');
  const line = await bob.evaluate(() => document.getElementById('deck-to-box')?.closest('p')?.textContent.replace(/\s+/g, ' ').trim());
  ok(line === 'A whole game (board, pieces, decks)? Use 📦', `the "+ Deck" dialog says: "${line}"`);
  await bob.locator('input[name="deck-kind"][value="img"]').tap();
  await bob.setInputFiles('#deck-files', [1, 2].map((k) => X.file(`spray-${k}.png`, X.noise(560, 560, 900 + k), 'image/png')));
  await X.press(bob, '#deck-add');
  st = await until((s) => (s.guestDeckChars || 0) > used0, 40000);
  const used1 = st?.guestDeckChars || 0;
  ok(used1 > used0, `Bob's image deck (+ Deck) counts against the guests' budget (${used0} → ${used1} chars)`);
  await X.press(bob, '#add-deck-btn');
  await bob.waitForSelector('#deck-dialog[open]');
  await X.press(bob, '#deck-to-box');
  ok(await bob.waitForSelector('#box-dialog[open]', { timeout: 5000 }).then(() => true, () => false) && !(await bob.$('#deck-dialog[open]')), "its 📦 opens the game boxes (and closes + Deck)");
  await X.closeBoxes(bob);
  const budgetBox = (name) => [X.file('game.json', J({ name, pieces: [1, 2].map((k) => ({ id: `rock${k}`, kind: 'token', w: 60, img: `rock-${k}.png` })), setup: [{ piece: 'rock1', at: [100, 100] }] }), 'application/json'),
    ...[1, 2].map((k) => X.file(`rock-${k}.png`, X.noise(560, 560, 700 + k), 'image/png'))];
  r = await X.upload(bob, budgetBox('Reef One'));
  st = await until((s) => named(s, 'Reef One').length === 1);
  const used2 = st?.guestDeckChars || 0, B = used2 - used1, D = used1 - used0;
  ok(!!st && B > 0, `Bob's box «Reef One» registers and counts too (${B} chars: ${used1} → ${used2})`);
  ok(used2 + B > 1.5e6 && used0 + 2 * B <= 1.5e6, `the next box of its size fits the budget alone (${used0 + 2 * B} ≤ 1.5e6 without the deck) but not beside the deck (${used2 + B}): precondition`);
  r = await X.upload(bob, budgetBox('Reef Two'), { done: /^(«|🚫)/u });
  const m1 = /^🚫 Box rejected: this table's budget for guests is full \((\d+) kB left\) — ask the host to add it$/.exec(r.err || r.progress);
  ok(!!m1 && Math.abs(+m1[1] - (1.5e6 - used2) / 1000) <= 1, `refused with the budget's words, in Bob's dialog: "${r.err || r.progress}" (${((1.5e6 - used2) / 1000).toFixed(1)} kB left)`);
  st = await S();
  ok(named(st, 'Reef Two').length === 0 && (st.guestDeckChars || 0) === used2, 'nothing registered; the budget is unchanged');
  ok(D > 0, `(the deck cost ${D} chars, the box ${B})`);
  if (await bob.isVisible('#box-err')) ok(await X.inView(bob, '#box-err'), "the refusal is on Bob's screen (upright phone)");
  await shot(bob, 'budget-phone');
  await X.closeBoxes(bob);

  // ---------------------------------------------------------------------------------
  section('12. the same built-in box set up twice from 📦: one catalog entry');
  for (let k = 0; k < 2; k++) {
    const n0 = alice.confirms.length;
    await X.openBoxes(alice);
    await X.press(alice, '#box-builtins [data-builtin="draughts"]');
    st = await until((s) => s.lastSetup && s.boxes[s.lastSetup]?.name === 'Draughts' && s.log.filter((e) => /set up «Draughts»/.test(e.txt)).length === k + 1);
    await X.settle(alice);
    ok(!!st && alice.confirms.length === n0 + 1 && /Draughts/.test(alice.confirms.at(-1)), `Draughts set up (${k + 1}), after the 🎲 confirm "${alice.confirms.at(-1)}"`);
  }
  st = await S();
  ok(named(st, 'Draughts').length === 1, `one «Draughts» in the catalog (${named(st, 'Draughts')})`);
  ok(await bob.evaluate((id) => !!window.__ct.boxes()[id], named(st, 'Draughts')[0]), 'and Bob holds it once');
  await X.openBoxes(carol);
  const drow = await X.row(carol, named(st, 'Draughts')[0]);
  ok(drow?.text.includes('built in'), `Carol's 📦 says it is built in (${drow?.text})`);
  await shot(carol, 'watcher-landscape');
  await X.closeBoxes(carol);
  ok(!errors.some((e) => /PAGEERROR|Uncaught/.test(e.text)), 'no uncaught error on the host');
  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
