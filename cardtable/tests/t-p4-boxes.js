// E2E: game boxes through the 📦 dialog (spec §4g, §4j, §4l t-p4-boxes; Phase
// 4A). Alice hosts on a desktop (1280 × 800, the mouse), Bob plays on an
// iPhone 13 held upright (a finger), Carol watches on one held sideways;
// Mallory is a raw peer. Every upload is a file picked in the dialog (the
// fixtures of tests/fixtures: "Harbor Run", game.json + 6 PNGs, and as a
// zip; "Beacon Watch", a box with rules), and every Set up, Reset and
// Export a press in it.
//  1  game.json + 6 PNGs: "This clears the table", set up; pieces on every
//     screen (the guests pull the images by hash), stored as WebP; JSZip
//     not loaded yet.
//  2  the same game as a .zip (one top-level folder): the same box ("That
//     box is already on this table"); JSZip loaded from the CDN only now,
//     and its build pinned (_data.uncompressedSize, internalStream).
//  3  malformed uploads fail loudly, inline and in a toast, naming the file
//     or field — attacker cases 1–4, 9 and 12 of §4j, bad JSON, a missing
//     plain file — on the desktop and on a phone; nothing registers.
//  M  Mallory (cases 5, 6, 10, 11): a 2 M-char box (the budget), "__proto__"
//     ids, setup and reset (host only), a forged "Draughts" (src upload, not
//     built in: the trust dialog asks), forged engine state (dropped on Set
//     up, the toast).
//  4  Bob's box with rules registers only (by Bob, 📜 on every screen); the
//     host's Set up names Bob, ticks "Enable its rules" and "Shuffle"; the
//     trust dialog; "Set up without rules" leaves the rules off.
//  5  the trust dialog: Cancel changes nothing; Enable rules starts the
//     box's rules on its state (rules.box).
//  6  Reset restores the layout and restarts the box's rules, also after
//     a host reload.
//  7  Export (a .zip) → clear → upload it → set up: the same position on
//     every screen and in the host's state (box and deck ids aside: the
//     catalog keeps the first box in this room); case 7: a re-imported
//     game's setup, rules and state never reach Mallory or Bob.
//  9  a guest's box sets up shuffled, the confirm naming him; the guests'
//     budget is shared with decks.
//  11 a 4,000 × 3,000 PNG board is encoded to 2,048 px; a board too detailed
//     for 2 MB steps down (quality, then size); with toDataURL('image/webp')
//     answering PNG (Safari), an opaque image is stored as JPEG and a
//     transparent one as PNG; each records its real type.
//  12 the same built-in box twice from 📦: one catalog entry.
//  13 a game running when a box is set up: its rules switched off first;
//     a strict game refuses an upload, saying what to do; the README's and
//     Help's examples set up as written.
//  14 the trust dialog's Cancel where the confirm's Set up was, at four
//     sizes (its buttons wrapped at 320 px); a box its rules lay out (no
//     rules checkbox, no "Set up without rules"); a storage failure with
//     rules running is not blamed on them.
//  8  resume elsewhere: chess and Hold'em exported mid-game (rules and
//     state) and imported into a fresh room with two new players (its host
//     on a phone): set up through the trust dialog, play goes on.
// Screenshots: shots/p4-boxes-*.png.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const A = require('./assets-lib');
const { HOSTILE, zip, photoPNG, game } = require('./zip-lib');
const { mallory } = require('./final-lib');
const { shot } = require('./fun-lib');
const { pickGame } = require('./stones-lib');
const core = require(path.join(h.APP_ROOT, 'cardtable/core.js'));
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const { devices } = h.playwright;
const J = JSON.stringify;
const FX = path.join(__dirname, 'fixtures');
const HARBOR = fs.readdirSync(path.join(FX, 'harbor')).sort().map((f) => path.join(FX, 'harbor', f));
const BEACON = ['game.json', 'rules.js'].map((f) => path.join(FX, 'beacon', f));
const HARBOR_JSON = JSON.parse(fs.readFileSync(path.join(FX, 'harbor', 'game.json'), 'utf8'));
const MARK = 'QZXK-hidden-box-state';
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
/** A file to pick, made here: {name, mimeType, buffer}. */
const file = (name, data, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.isBuffer(data) ? data : Buffer.from(data) });
/** The Harbor Run fixture under another name (its game.json changed), with its 6 PNGs: another box. */
const harborAs = (name, more = {}) => [file('game.json', J({ ...HARBOR_JSON, name, ...more }), 'application/json'),
  ...HARBOR.filter((f) => f.endsWith('.png')).map((f) => file(path.basename(f), fs.readFileSync(f), 'image/png'))];

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-boxes-'));
  const alice = await P.join(env, 'Alice', env.url);
  const bob = await P.join(env, 'Bob', alice.url(), { ctx: { ...devices['iPhone 13'] } });
  const carol = await P.join(env, 'Carol', alice.url(), { ctx: { ...devices['iPhone 13 landscape'] } });
  bob.touch = carol.touch = true;
  Object.assign(alice, { who: 'Alice' }); Object.assign(bob, { who: 'Bob' }); Object.assign(carol, { who: 'Carol' });
  await carol.evaluate(() => window.__ct.act({ t: 'seat', watch: true }));
  const pages = [alice, bob, carol];
  const jszip = []; // the requests for JSZip, on Alice's page
  alice.on('request', (r) => { if (/jszip/.test(r.url())) jszip.push(r.url()); });
  const confirms = [];
  alice.on('dialog', (d) => { confirms.push(d.message()); d.accept().catch((err) => console.error('confirm failed', err)); });

  // --- helpers -------------------------------------------------------------------
  /** A press on `sel`: a tap on a phone, else a click. */
  const press = (p, sel) => (p.touch ? p.locator(sel).first().tap() : p.locator(sel).first().click());
  /** Opens page p's 📦 dialog (if it isn't). */
  async function openBoxes(p) {
    if (await p.$('#box-dialog[open]')) return;
    await press(p, '#box-btn');
    await p.waitForSelector('#box-dialog[open]');
  }
  const closeBoxes = (p) => p.evaluate(() => document.getElementById('box-dialog').close());
  /** What page p's dialog says: {progress, err, msg, ask: the open #box-ask's kind}. */
  const says = (p) => p.evaluate(() => ({
    progress: document.getElementById('box-progress').textContent, err: document.getElementById('box-err').textContent,
    msg: document.getElementById('box-msg').textContent, ask: document.querySelector('#box-ask[open]')?.dataset.kind || null,
  }));
  /** Page p picks `files` in its 📦 dialog, "Set up now" set to `now` where it
   *  shows (the host's), and waits until the upload is over: the dialog asks
   *  something, shows an error, closes (the box set up), or says how it went —
   *  for a guest, once the host has answered. Returns says(). */
  async function upload(p, files, now = false) {
    await openBoxes(p);
    if (await p.isVisible('#box-now')) await p.setChecked('#box-now', now);
    await p.evaluate(() => { for (const id of ['box-progress', 'box-err', 'box-msg']) document.getElementById(id).textContent = ''; });
    await p.setInputFiles('#box-files', files);
    await p.waitForFunction(() => {
      const $ = (id) => document.getElementById(id), text = $('box-progress').textContent;
      return !!document.querySelector('#box-ask[open]') || !document.querySelector('#box-dialog[open]') || !!$('box-err').textContent
        || (!$('box-up').disabled && /^(Added|That box|«)/.test(text));
    }, null, { timeout: 60000 });
    return says(p);
  }
  /** Page p's open #box-ask once it is of `kind`: {kind, title, text, checks: {id: ticked}, buttons}, or null within 15 s. */
  const asked = (p, kind) => p.waitForSelector(`#box-ask[open][data-kind="${kind}"]`, { timeout: 15000 }).then(() => p.evaluate(() => {
    const d = document.getElementById('box-ask');
    return {
      kind: d.dataset.kind, title: document.getElementById('box-ask-title').textContent, text: [...d.querySelectorAll('#box-ask-body p')].map((e) => e.textContent).join(' '),
      checks: Object.fromEntries([...d.querySelectorAll('[data-c]')].map((c) => [c.dataset.c, c.checked])), buttons: [...d.querySelectorAll('#box-ask-btns button')].map((b) => b.textContent),
    };
  }), () => null);
  /** Page p answers the open #box-ask with button `value`, ticking `checks` ({id: on}) first. */
  async function reply(p, value, checks = {}) {
    for (const [k, on] of Object.entries(checks)) await p.setChecked(`#box-ask [data-c="${k}"]`, on);
    await press(p, `#box-ask-btns button[value="${value}"]`);
  }
  /** The host's state (seat keys left out). */
  const S = () => alice.evaluate(() => window.__ct.hostState());
  /** Waits until page p's (a host's) queue has been empty for 300 ms on end: a press's action reaches the queue a task after the press (a dialog's close event). */
  const settle = (p = alice) => p.waitForFunction(() => {
    if (window.__ct.jobs()) window.__idle = null;
    else window.__idle ??= performance.now();
    return window.__idle != null && performance.now() - window.__idle >= 300;
  }, null, { timeout: 20000, polling: 50 }).finally(() => p.evaluate(() => { window.__idle = null; }));
  /** The ids of the boxes named `name` in the host's catalog. */
  const named = async (name, st) => Object.entries((st || await S()).boxes).filter(([, b]) => b.name === name).map(([id]) => id);
  /** Page p's 📦 row of box `id`: what it says and which buttons it has. */
  const row = (p, id) => p.evaluate((id) => {
    const r = document.querySelector(`.box-row[data-box="${id}"]`);
    return r && { text: r.querySelector('.box-info').textContent.replace(/\s+/g, ' ').trim(), btns: [...r.querySelectorAll('button')].map((b) => b.textContent) };
  }, id);
  /** How many piece images page p draws (decoded). */
  const drawn = (p) => p.$$eval('#table .item .pimg img', (els) => els.filter((e) => e.complete && e.naturalWidth > 0).length);
  /** The types (mime) and pixel sizes of images `ids`, as the host stores them. */
  const stored = (ids) => alice.evaluate(async ({ ids, v }) => {
    const St = await import(`/cardtable/store.js?v=${v}`);
    return Promise.all(ids.map(async (h) => {
      const a = await St.getAsset(h), bmp = await createImageBitmap(new Blob([a.data], { type: a.mime }));
      const r = { mime: a.mime, real: St.imageType(new Uint8Array(a.data)), bytes: a.data.byteLength, w: bmp.width, h: bmp.height };
      bmp.close();
      return r;
    }));
  }, { ids, v: h.MODULE_V });
  /** A position as the host keeps it, comparable across a re-import: items bottom to top without z, each piece's type
   *  by its own id (its box's id read away), cards by their deck's name; the hands the same way. */
  const position = (st) => {
    const deck = (d) => st.decks[d]?.name ?? d, local = (t) => t.slice(t.indexOf('/') + 1);
    const m = (x) => ({ ...x, ...(x.t && { t: local(x.t) }), ...(x.d && { d: deck(x.d) }) });
    return J({
      items: Object.entries(st.items).sort(([, a], [, b]) => a.z - b.z).map(([id, it]) => ({ id, ...m(it), z: undefined, cards: it.cards?.map(m), of: it.of?.map(m) })),
      hands: Object.fromEntries(Object.entries(st.players).map(([q, pl]) => [q, pl.hand.map(m)])),
    });
  };
  /** Page p's public view the same way: its items' kinds, places, faces, piles' sizes and tops (types by their own ids). */
  const viewPos = (p) => p.evaluate(() => {
    const v = window.__ct.view(), local = (t) => (typeof t === 'string' ? t.slice(t.indexOf('/') + 1) : t);
    return JSON.stringify(Object.entries(v.items).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, it]) => [id, it.k, Math.round(it.x), Math.round(it.y), local(it.t), it.f, it.up, it.n, it.owner, it.at, it.top?.up]));
  });

  section('1 game.json and its 6 PNGs, picked in 📦 on the desktop: "This clears the table", set up on every screen');
  {
    let r = await upload(alice, HARBOR, true);
    const q = r.ask && await asked(alice, 'setup');
    ok(q && q.title === 'Set up «Harbor Run»?' && q.text === 'This clears the table.' && !Object.keys(q.checks).length && J(q.buttons) === J(['Cancel', 'Set up']),
      `the host's own box, no rules: only the table to clear is asked (${J(q)})`);
    await shot(alice, 'p4-boxes-setup-desk');
    await reply(alice, 'ok');
    await alice.waitForFunction(() => !document.querySelector('#box-dialog[open]'), null, { timeout: 15000 });
    await settle();
    const st = await S(), [id] = await named('Harbor Run', st), seated = Object.values(st.players).filter((pl) => pl.seat != null).length;
    ok(id && st.lastSetup === id && st.boxSrc[id].src === 'host' && Object.keys(st.items).length === 5 + seated && st.log.some((e) => e.txt === `set up «Harbor Run» (${5 + seated} items)`),
      `registered and set up: board, ${seated} boats, two crates, a die, the Tides (${Object.keys(st.items).length} items)`);
    ok(await alice.evaluate(() => document.getElementById('game-strip').classList.contains('hidden')), 'the "What are we playing?" strip is answered');
    const imgs = await stored(st.boxes[id].imgs);
    ok(imgs.length === 4 && imgs.every((x) => x.mime === 'image/webp' && x.real === 'image/webp' && x.bytes <= 2e6) && imgs[0].w === 600 && imgs[1].w === 64,
      `its 4 piece images (board, two boats, a crate) stored as WebP, by their real type, at their own sizes (${J(imgs.map((x) => `${x.w}×${x.h} ${x.mime}`))})`);
    const deck = st.decks[st.boxes[id].decks.Tides];
    ok(deck?.cards.length === 6 && deck.imgs.length === 2 && J(deck.cards.map((c) => c.n)) === J(['Calm', 'Calm', 'Calm', 'Storm', 'Storm', 'Fog']), 'its deck, Tides: 6 cards, 2 images, a text card');
    for (const p of pages) {
      const n = await p.waitForFunction((k) => Object.keys(window.__ct.view().items).length === k, 5 + seated, { timeout: 20000 }).then(() => true, () => false);
      const d = await p.waitForFunction(() => document.querySelectorAll('#table .item .pimg img').length >= 3 && [...document.querySelectorAll('#table .item .pimg img')].every((e) => e.complete && e.naturalWidth > 0), null, { timeout: 20000 }).then(() => true, () => false);
      ok(n && d, `${p.who}'s screen: the ${5 + seated} items, the board and boats drawn from their images (${await drawn(p)})`);
    }
    ok(jszip.length === 0, 'no zip picked yet: JSZip was not loaded');
    await shot(bob, 'p4-boxes-harbor-phone');
  }

  section('2 the same game as a .zip (in one top-level folder): the same box; JSZip loaded from the CDN only now');
  {
    const r = await upload(alice, path.join(FX, 'harbor.zip'));
    ok(r.progress === 'That box is already on this table' && !r.err && (await named('Harbor Run')).length === 1,
      `the zip's images re-encode to the same bytes: one box (${J(r)})`);
    ok(jszip.length === 1 && jszip[0] === JSZIP_URL, `JSZip fetched once, from ${jszip[0]}`);
    const pin = await alice.evaluate(async (url) => {
      const JSZip = (await import(url)).default, z = new JSZip();
      z.file('../x.png', 'abc');
      const back = await JSZip.loadAsync(await z.generateAsync({ type: 'uint8array' })), f = Object.values(back.files).find((x) => !x.dir);
      return { size: f._data?.uncompressedSize, stream: typeof f.internalStream, unsafe: f.unsafeOriginalName, name: f.name };
    }, JSZIP_URL);
    ok(pin.size === 3 && pin.stream === 'function' && pin.unsafe === '../x.png', `the build boxio.js relies on: _data.uncompressedSize, internalStream, unsafeOriginalName (${J(pin)})`);
    // (the 4A fix-up, D207) empty files in a zip — a README, a folder's .keep — are read as empty, not refused
    const withEmpty = zip([...HARBOR.map((f) => ({ name: path.basename(f), data: fs.readFileSync(f) })), { name: 'README.txt', data: '' }, { name: 'notes/.keep', data: '', store: true }]);
    const re = await upload(alice, file('empty.zip', withEmpty));
    ok(re.progress === 'That box is already on this table' && !re.err, `a zip holding an empty README.txt and notes/.keep: read ("${re.progress || re.err}")`);
    // a deck's back given as a colour's name ("navy", which export may write) is a colour, not a file
    const rn = await upload(alice, harborAs('Harbor Navy', { decks: [{ ...HARBOR_JSON.decks[0], back: 'navy' }] }));
    const navy = (await S()).decks[(await S()).boxes[(await named('Harbor Navy'))[0]]?.decks?.Tides];
    ok(rn.progress === 'Added «Harbor Navy»' && navy?.back === 'navy', `a deck back "navy": a colour (${rn.progress || rn.err}, back ${navy?.back})`);
  }

  section('3 malformed uploads fail loudly — inline, naming the file or field, and in a toast; nothing registers');
  {
    const before = Object.keys((await S()).boxes).length;
    const cases = [
      ['case 1, a zip bomb (100 MB of zeros, declared)', file('bomb.zip', HOSTILE.bomb()), /map\.png is 100\.0 MB unzipped \(max 16\.0 MB a file\)/],
      ['case 9, a directory that lies (1 KB declared, 100 MB inside)', file('liar.zip', HOSTILE.liar()), /map\.png unzips to more than the 1,024 bytes its zip entry declares — refused/],
      ['case 2, "../../evil.png" and "/abs.png"', file('slip.zip', HOSTILE.slip()), /"\.\.\/\.\.\/evil\.png" points outside the zip — refused/],
      ['case 3, an SVG named map.png', file('svg.zip', HOSTILE.svg()), /map\.png: not a PNG, JPEG, WebP or GIF image/],
      ['case 4, a file the zip lacks', file('missing.zip', HOSTILE.missing()), /game\.json: pieces\[0\]\.img names "gone\.png", which isn't in the upload/],
      ['case 12, a 30,000 × 30,000 PNG', file('huge.zip', HOSTILE.huge()), /map\.png: the image is 30000 × 30000 px \(max 4096 px a side, 16 Mpx\)/],
      ['game.json that is no JSON', file('game.json', '{"name": "Broken",', 'application/json'), /game\.json is not valid JSON/],
      ['an image the game.json names, not picked', [file('game.json', J({ name: 'Gappy', pieces: [{ id: 'a', kind: 'token', img: 'a.png' }] }), 'application/json')], /game\.json: pieces\[0\]\.img names "a\.png", which isn't in the upload/],
      ['a field the box refuses', [file('game.json', J({ name: 'Odd', pieces: [{ id: 'a', kind: 'blob' }] }), 'application/json')], /pieces\[0\] \(«a»\): kind must be one of/],
      // (the 4A fix-up: D207)
      ['two game.json at its root, told apart by case alone', file('twice.zip', zip([{ name: 'GAME.JSON', data: game() }, { name: 'game.json', data: game() }, { name: 'map.png', data: photoPNG(8, 8) }])),
        /twice\.zip has more than one game\.json at its root \(GAME\.JSON, game\.json\)/],
      ['a game.json without its name', [file('game.json', J({ pieces: [{ id: 'a', kind: 'die' }] }), 'application/json')], /game\.json: "name" is required/],
      ['a deck of 5,500 cards, 11 lines of "count": 500', [file('game.json', J({ name: 'Big deck', decks: [{ name: 'D', cards: Array.from({ length: 11 }, () => ({ name: 'x', count: 500 })) }] }), 'application/json')],
        /decks\[0\] \(«D»\): a deck holds at most 5,000 cards \(cards\[10\] goes past it\)/],
    ];
    for (const [what, f, re] of cases) {
      const t0 = Date.now(), r = await upload(alice, f), ms = Date.now() - t0;
      const t = await alice.evaluate(() => document.getElementById('toast').textContent);
      ok(re.test(r.err) && r.err.startsWith("Couldn't add the game: ") && t === r.err && !r.ask, `${what}: "${r.err}" (in the dialog and the toast, ${ms} ms)`);
    }
    ok(Object.keys((await S()).boxes).length === before && await alice.evaluate(() => window.HACKED === undefined), 'nothing registered; the SVG ran nothing');
    await shot(alice, 'p4-boxes-error-desk');
    const r = await upload(bob, file('svg.zip', HOSTILE.svg()));
    ok(/map\.png: not a PNG, JPEG, WebP or GIF image/.test(r.err), `on Bob's phone too: "${r.err}"`);
    ok(await bob.evaluate(() => { const e = document.getElementById('box-err').getBoundingClientRect(); return e.top >= 0 && e.bottom <= innerHeight && e.height > 10; }), "the error shows on Bob's screen, scrolled into view");
    await shot(bob, 'p4-boxes-error-phone');
    await closeBoxes(bob);
  }

  section('M Mallory: a 2 M-char box, "__proto__" ids, setup and reset; a forged built-in; forged engine state (§4j cases 5, 6, 10, 11)');
  const M = await mallory(env, alice.url(), 3);
  const mPid = 'ffffffffffffffff';
  {
    await M.act({ t: 'chat', msg: 'hi' }); // (she sits down: a seat, a name)
    await h.logHas(alice, 'Mallory');
    const n0 = Object.keys((await S()).boxes).length;
    await M.act({ t: 'addBox', box: { name: 'Big', pieces: [{ id: 'a', kind: 'die' }], rulesState: { data: { pad: 'x'.repeat(2e6) }, public: {}, asks: {}, secret: {} } } });
    await M.act({ t: 'addBox', box: JSON.parse('{"name": "Proto", "pieces": [{"id": "__proto__", "kind": "token"}]}') });
    const st0 = await S();
    await M.act({ t: 'setup', box: (await named('Harbor Run', st0))[0] });
    await M.act({ t: 'reset' });
    await h.sleep(1500);
    const notes = await M.notes(), st = await S();
    ok(notes.some((x) => /^🚫 Box rejected: this table's budget for guests is full \(\d+ kB left\) — ask the host to add it$/.test(x)), `case 5: the 2 M-char box is over the guests' budget (${J(notes[0])})`);
    ok(notes.some((x) => /^🚫 Box rejected: pieces: "__proto__" is not an id/.test(x)), `case 5: "__proto__" ids are refused (${J(notes[1])})`);
    ok(notes.includes('🚫 Only the host can do that') && st.lastSetup === st0.lastSetup && st.seq === st0.seq && Object.keys(st.boxes).length === n0,
      `case 6: her setup and reset are the host's alone, refused at the door (one notice in 10 s): nothing changed (${J(notes.slice(2))})`);
    // case 10: Draughts in the authoring format, one piece renamed, claiming to be built in and the host's
    const dr = core.cleanBox(BOXES.draughts);
    const fake = {
      ...dr, types: undefined, backs: Object.entries(dr.backs).map(([id, b]) => ({ id, ...b })),
      pieces: Object.entries(dr.types).map(([id, { board, ...t }], k) => ({ id, ...t, ...board, ...(k === 1 && { name: 'Mallory’s man' }) })),
      rules: '({ name: "Not draughts", setup(t) { t.say("gotcha"); } })', src: 'builtin', by: await alice.evaluate(() => localStorage.getItem('ct-pid')), builtin: true,
    };
    await M.act({ t: 'addBox', box: fake });
    await h.logHas(alice, 'added the box «Draughts»');
    const st2 = await S(), [fid] = (await named('Draughts', st2)).filter((x) => st2.boxSrc[x].by === mPid);
    ok(fid && st2.boxSrc[fid].src === 'upload' && st2.boxSrc[fid].by === mPid && !(await alice.evaluate(async ({ b, v }) => (await import(`/cardtable/core.js?v=${v}`)).isBuiltin(b), { b: st2.boxes[fid], v: h.MODULE_V })),
      `case 10: the forged "Draughts" is Mallory's upload, not built in (${J(st2.boxSrc[fid])})`);
    await openBoxes(alice);
    ok((await row(alice, fid))?.text.includes('by Mallory'), `the 📦 row says who added it: "${(await row(alice, fid))?.text}"`);
    await press(alice, `.box-row[data-box="${fid}"] [data-act="setup"]`);
    let q = await asked(alice, 'setup');
    ok(q?.checks.rules === true && q.checks.shuffle === true && q.text.includes('Mallory added this box and knows its starting layout.'), `Set up asks: rules and shuffle ticked, Mallory named (${J(q)})`);
    await reply(alice, 'ok');
    q = await asked(alice, 'trust');
    ok(q?.text.startsWith('«Draughts» comes with rules written by its author, added by Mallory.'), `the trust dialog asks before its rules run (${q?.text.slice(0, 60)}…)`);
    await reply(alice, 'cancel');
    await h.sleep(300);
    ok((await S()).lastSetup === st0.lastSetup, 'Cancel: nothing set up');
    // case 11: forged engine state, dropped on Set up
    const many = Array.from({ length: 500 }, (_, k) => `o${k}`);
    await M.act({
      t: 'addBox',
      box: JSON.parse(J({ name: 'Forged state', pieces: [{ id: 'p', kind: 'die' }], setup: [{ piece: 'p', at: 'center' }], rules: '({ name: "Forged", setup(t) { t.data.ran = true; } })',
        rulesState: { data: { _timers: [{ at: 'x', tag: 'boom' }], keep: 1 }, public: {}, asks: { '@#1': [{ id: 'big', prompt: 'Pick', options: many }] }, secret: { SECRET: 0 } } })
        .replace('"SECRET":0', '"__proto__":{"text":"x"}')), // (an own "__proto__" key, as JSON from the wire makes one)
    });
    await h.logHas(alice, 'added the box «Forged state»');
    const [sid] = await named('Forged state');
    await alice.evaluate(() => { window.__toasts = []; const el = document.getElementById('toast'); new MutationObserver(() => window.__toasts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
    await openBoxes(alice);
    await press(alice, `.box-row[data-box="${sid}"] [data-act="setup"]`);
    await asked(alice, 'setup');
    await reply(alice, 'ok');
    await asked(alice, 'trust');
    await reply(alice, 'enable');
    await settle();
    await alice.waitForFunction(() => window.__toasts.some((t) => /invalid and was dropped/.test(t)), null, { timeout: 10000 }).catch(() => {});
    const st3 = await S(), toasts = await alice.evaluate(() => window.__toasts);
    ok(st3.rules?.enabled && st3.rules.data.ran && st3.rules.data.keep === 1 && !st3.rules.data._timers?.length && !Object.values(st3.rules.asks || {}).flat().length && !Object.keys(st3.rules.secret || {}).length,
      `case 11: the timer at "x", the ask of 500 options and the secret keyed __proto__ dropped; the rest seeded (${J(st3.rules?.data)})`);
    ok(toasts.includes('Some saved game state was invalid and was dropped'), `the host is told: "${toasts.find((t) => /dropped/.test(t))}"`);
    await alice.evaluate(() => window.__ct.act({ t: 'setRules', enabled: false }));
    await settle();
  }

  section("4 Bob's box with rules registers only; Set up names him, ticks the rules and the shuffle; the trust dialog; set up without rules");
  let beacon;
  {
    const r = await upload(bob, BEACON);
    ok(r.progress === '«Beacon Watch» is on the table — the host can set it up from 📦' && !r.err, `Bob's phone: "${r.progress}"`);
    const st = await S();
    [beacon] = await named('Beacon Watch', st);
    ok(beacon && st.boxSrc[beacon].src === 'upload' && st.boxSrc[beacon].by === bob.pid && st.boxes[beacon].rules?.includes("name: 'Beacon Watch'") && st.lastSetup !== beacon,
      'registered as his upload, with its rules; nothing laid out');
    ok(await bob.waitForFunction((id) => /📜/.test(document.querySelector(`.box-row[data-box="${id}"]`)?.textContent || ''), beacon, { timeout: 10000 }).then(() => true, () => false)
      && !(await bob.$('.box-row [data-act]')) && !(await bob.isVisible('#box-export')) && !(await bob.isVisible('#box-builtin')),
      `Bob's 📦: "${(await row(bob, beacon))?.text}" (📜: it has rules), no Set up, no export, no built-in list`);
    await shot(bob, 'p4-boxes-guest-phone');
    await closeBoxes(bob);
    await openBoxes(carol);
    ok((await row(carol, beacon))?.text.includes('by Bob') && !(await carol.$('.box-row [data-act]')), `Carol (watching, sideways) reads the same list: "${(await row(carol, beacon))?.text}"`);
    await shot(carol, 'p4-boxes-watcher-landscape');
    await closeBoxes(carol);
    await openBoxes(alice);
    ok(J((await row(alice, beacon))?.btns) === J(['Set up']) && (await row(alice, beacon)).text.includes('📜'), `the host's row: "${(await row(alice, beacon))?.text}" [Set up]`);
    await press(alice, `.box-row[data-box="${beacon}"] [data-act="setup"]`);
    let q = await asked(alice, 'setup');
    ok(q?.title === 'Set up «Beacon Watch»?' && q.text === 'This clears the table. Bob added this box and knows its starting layout.' && J(q.checks) === J({ rules: true, shuffle: true }),
      `Set up asks: the table cleared, "Enable its rules" and "Shuffle face-down piles" ticked under Bob's name (${J(q)})`);
    await reply(alice, 'ok');
    q = await asked(alice, 'trust');
    ok(q?.title === '«Beacon Watch» has rules' && q.text === '«Beacon Watch» comes with rules written by its author, added by Bob. A rules script sees every hand and hidden piece and can reveal them. Enable the rules?'
      && J(q.buttons) === J(['Enable rules', 'Set up without rules', 'Cancel']), `the trust dialog: ${J(q)}`);
    await shot(alice, 'p4-boxes-trust-desk');
    await reply(alice, 'without');
    await settle();
    const st2 = await S();
    ok(st2.lastSetup === beacon && !st2.rules?.enabled && st2.log.some((e) => /^set up «Beacon Watch» \(\d+ items\)/.test(e.txt)), 'set up without its rules: the rules stay off');
  }

  section('5 the trust dialog: Cancel changes nothing; Enable rules starts the box\'s rules on its state');
  {
    const n0 = (await S()).log.length;
    await openBoxes(alice);
    // A double click on the confirm's Set up answers the confirm only: the trust dialog that follows in the
    // same element wakes half a second later, and Cancel stands where Set up was (D204)
    await press(alice, `.box-row[data-box="${beacon}"] [data-act="setup"]`);
    await asked(alice, 'setup');
    await alice.dblclick('#box-ask-btns button[value="ok"]');
    ok(!!await asked(alice, 'trust'), '(a double click on Set up: the trust dialog shows)');
    await h.sleep(800);
    let st0 = await S();
    ok(!!await alice.$('#box-ask[open][data-kind="trust"]') && !st0.rules?.enabled && st0.log.length === n0, 'and still waits for its answer: nothing set up, no rules');
    await reply(alice, 'cancel');
    await h.sleep(400);
    ok((await S()).log.length === n0 && await alice.$('#box-dialog[open]'), 'Cancel: no line, no change; the 📦 dialog stays open');
    await press(alice, `.box-row[data-box="${beacon}"] [data-act="setup"]`);
    await asked(alice, 'setup');
    await reply(alice, 'ok');
    await asked(alice, 'trust');
    await reply(alice, 'enable');
    await settle();
    const st = await S();
    ok(st.rules?.enabled && st.rules.name === 'Beacon Watch' && st.rules.box === beacon && st.rules.data.watches === 1, `Enable rules: the box's rules run, as its (rules.box), on its state (watches ${st.rules?.data.watches})`);
    ok(await bob.waitForSelector('#rules-btns button:has-text("Keep watch")', { timeout: 10000 }).then(() => true, () => false), "Bob's screen shows the rules' button");
  }

  section('6 Reset restores the layout and restarts the box\'s rules — also after a host reload');
  {
    const beacons = (st) => Object.values(st.items).filter((it) => it.t?.endsWith('/beacon') && !it.owner).map((it) => it.at.slice(it.at.indexOf(':') + 1)).sort(); // (a reset mints the board a new id)
    const st0 = await S(), [bid] = Object.entries(st0.items).filter(([, it]) => it.t?.endsWith('/beacon') && !it.owner).map(([id]) => id), at0 = st0.items[bid].at, laid = J(beacons(st0));
    await alice.evaluate((id) => window.__ct.act({ t: 'move', id, x: 100, y: 100 }), bid);
    await alice.evaluate(() => window.__ct.act({ t: 'rulesBtn', id: 'watch' }));
    await bob.evaluate(() => window.__ct.act({ t: 'rulesBtn', id: 'watch' }));
    await settle();
    let st = await S();
    ok(st.rules.data.watches === 3 && st.items[bid].at !== at0, `a beacon moved off ${at0}, two watches kept (${st.rules.data.watches})`);
    await openBoxes(alice);
    ok(J((await row(alice, beacon))?.btns) === J(['↺ Reset', 'Set up']) && (await row(alice, beacon)).text.includes('set up'), `the box set up last offers Reset: "${(await row(alice, beacon))?.text}"`);
    await press(alice, `.box-row[data-box="${beacon}"] [data-act="reset"]`);
    const q = await asked(alice, 'reset');
    ok(q?.title === 'Reset «Beacon Watch»?' && q.text === 'The table is cleared and «Beacon Watch» laid out again, its rules started afresh.', `Reset asks: ${J(q)}`);
    await reply(alice, 'ok');
    await settle();
    st = await S();
    ok(J(beacons(st)) === laid && st.rules.enabled && st.rules.box === beacon && st.rules.data.watches === 1 && st.log.some((e) => e.txt === 'reset «Beacon Watch»'),
      `reset: the beacons back on ${laid}, the rules restarted on the box's state (watches ${st.rules.data.watches})`);
    await alice.evaluate(() => window.__ct.act({ t: 'rulesBtn', id: 'watch' }));
    await settle();
    await h.sleep(1500); // (the save is deferred)
    await alice.reload();
    await alice.waitForFunction(() => window.__ct?.hostState()?.rules?.enabled && window.__ct.jobs() === 0, null, { timeout: 20000 });
    await openBoxes(alice);
    ok(J((await row(alice, beacon))?.btns) === J(['↺ Reset', 'Set up']), 'after a host reload, Reset is still offered (lastSetup is saved)');
    await press(alice, `.box-row[data-box="${beacon}"] [data-act="reset"]`);
    await asked(alice, 'reset');
    await reply(alice, 'ok');
    await settle();
    st = await S();
    ok(st.rules.enabled && st.rules.box === beacon && st.rules.data.watches === 1 && J(beacons(st)) === laid, `and it restarts the box's rules (rules.box is saved too: watches ${st.rules.data.watches})`);
    await alice.evaluate(() => window.__ct.act({ t: 'setRules', enabled: false }));
    await settle();
  }

  section('7 Export (.zip) → clear → upload it → set up: the same position everywhere; a re-imported game\'s hidden state reaches no guest (case 7)');
  {
    const [hid] = await named('Harbor Run');
    await openBoxes(alice);
    await press(alice, `.box-row[data-box="${hid}"] [data-act="setup"]`);
    await asked(alice, 'setup');
    await reply(alice, 'ok');
    await settle();
    let st = await S();
    const tides = Object.entries(st.items).find(([, it]) => it.name === 'Tides')[0], boat = Object.entries(st.items).find(([, it]) => it.owner === bob.pid)[0];
    await bob.evaluate((id) => window.__ct.act({ t: 'draw', id }), tides);
    await alice.evaluate((id) => window.__ct.act({ t: 'move', id, x: 300, y: 300 }), boat);
    await settle();
    await P.waitView(bob, 'v.hand.length === 1');
    st = await S();
    const pos0 = position(st), views0 = await Promise.all(pages.map(viewPos));
    await openBoxes(alice);
    ok(!(await alice.isChecked('#box-x-rules')) && !(await alice.isChecked('#box-x-state')), "the rules are off (Beacon Watch's): the export leaves them out by default");
    const t0 = Date.now(), [dl] = await Promise.all([alice.waitForEvent('download'), press(alice, '#box-x-go')]), out = path.join(tmp, dl.suggestedFilename());
    await dl.saveAs(out);
    const msg = await alice.textContent('#box-x-msg'), bytes = fs.readFileSync(out);
    ok(dl.suggestedFilename() === 'Harbor Run.zip' && bytes.subarray(0, 2).toString() === 'PK' && msg === 'Saved Harbor Run.zip', `exported in ${Date.now() - t0} ms: ${dl.suggestedFilename()}, ${bytes.length} B ("${msg}")`);
    await shot(alice, 'p4-boxes-export-desk');
    const JSZip = (await import(path.join(__dirname, '.cdn-cache/jszip_3.10.1__esm.js'))).default, z = await JSZip.loadAsync(bytes);
    const names = Object.keys(z.files).filter((n) => !z.files[n].dir).sort(), game = JSON.parse(await z.file('game.json').async('string'));
    ok(J(names) === J(['game.json', 'images/0.webp', 'images/1.webp', 'images/2.webp', 'images/3.webp', 'images/deck1-0.webp', 'images/deck1-1.webp'])
      && game.id === hid && J(Object.values(game.setup.at(-1).hands || {}).map((l) => l.length)) === '[1]' && game.decks[0].id === st.boxes[hid].decks.Tides && game.setup.every((e) => e.hands || /^[0-9a-f]{8}$/.test(e.id)) && !game.rules,
      `the zip: game.json and its 6 images; the box's, the deck's and every item's id, Bob's hand by his "#k" (${J(names)}, hands ${J(game.setup.at(-1).hands && Object.keys(game.setup.at(-1).hands))}, id ${game.id})`);
    // The export unzipped, its files picked: a picker gives no folders, so images/… are found by their own names (D207)
    const unz = path.join(tmp, 'unzipped'), picked = [];
    fs.mkdirSync(unz);
    for (const n of names) { const f = path.join(unz, path.basename(n)); fs.writeFileSync(f, await z.file(n).async('uint8array')); picked.push(f); }
    const rp = await upload(alice, picked);
    ok(!rp.err && rp.progress === 'Added «Harbor Run»', `the export unzipped, its 7 files picked: read, its images/… by their own names ("${rp.progress || rp.err}")`);
    await alice.evaluate(() => window.__ct.act({ t: 'clear' }));
    await settle();
    const r = await upload(alice, out, true);
    await settle();
    st = await S();
    const [, again] = await named('Harbor Run', st);
    ok(!r.err && !r.ask && again && st.lastSetup === again && position(st) === pos0, `uploaded and set up (the table was empty: nothing asked): the same position, ids included, in the host's state (${again})`);
    for (const [k, p] of pages.entries()) {
      await P.waitView(p, 'Object.keys(v.items).length === a', JSON.parse(views0[k]).length);
      ok(await viewPos(p) === views0[k], `${p.who}'s screen shows the same position (${JSON.parse(views0[k]).length} items)`);
    }
    // case 7: a game re-imported with its rules and state: none of it reaches a guest
    game.name = 'Harbor Run (kept)';
    game.rules = 'rules.js';
    game.rulesState = { data: { mark: MARK }, public: {}, asks: {}, secret: {} };
    z.file('game.json', J(game));
    z.file('rules.js', `({ name: 'Harbor keeper', setup(t) { t.data.seen = t.data.mark; } })`);
    const kept = path.join(tmp, 'kept.zip');
    fs.writeFileSync(kept, await z.generateAsync({ type: 'uint8array' }));
    await upload(alice, kept, true);
    await asked(alice, 'setup');
    await reply(alice, 'ok');
    await asked(alice, 'trust');
    await reply(alice, 'enable');
    await settle();
    st = await S();
    ok(st.rules?.enabled && st.rules.data.seen === MARK && st.boxes[st.lastSetup].setup.length > 5, 'the kept game set up with its rules, on its state');
    await h.sleep(1500);
    const mSeen = await M.evaluate(() => JSON.stringify(window.M.got)), bSeen = await bob.evaluate(() => JSON.stringify([window.__ct.view(), window.__ct.boxes(), window.__ct.log()]));
    const mBoxes = await M.evaluate(() => window.M.got.boxes.map(({ m }) => (typeof m.b === 'string' ? JSON.parse(m.b) : m)));
    ok(!mSeen.includes(MARK) && !bSeen.includes(MARK), "case 7: the planted state reaches neither Mallory's raw messages nor Bob's view, catalog or log");
    ok(mBoxes.length > 0 && mBoxes.every((d) => Object.values(d).every((b) => !('setup' in b) && !('rules' in b) && !('rulesState' in b))), `the boxes Mallory received (${mBoxes.length} messages) carry no setup, rules or rulesState`);
    await alice.evaluate(() => window.__ct.act({ t: 'setRules', enabled: false }));
    await settle();
    await closeBoxes(alice);
  }

  section("9 a guest's box sets up with its face-down piles shuffled, the confirm naming him; the guests' budget is shared with decks");
  {
    const r = await upload(bob, harborAs("Bob's harbor"));
    ok(/^«Bob's harbor» is on the table/.test(r.progress), `Bob's harbor sent and registered: "${r.progress}"`);
    await closeBoxes(bob);
    const [bh] = await named("Bob's harbor");
    await openBoxes(alice);
    await press(alice, `.box-row[data-box="${bh}"] [data-act="setup"]`);
    const q = await asked(alice, 'setup');
    ok(q?.text === "This clears the table. Bob added this box and knows its starting layout." && J(q.checks) === J({ shuffle: true }), `the confirm names Bob, "Shuffle face-down piles" ticked (${J(q)})`);
    await reply(alice, 'ok');
    await settle();
    const st = await S();
    ok(st.lastSetup === bh && st.log.some((e) => /^set up «Bob's harbor» \(\d+ items\), face-down piles shuffled$/.test(e.txt)), 'set up, its face-down piles shuffled');
    const used = st.guestDeckChars, deck = A.imgDeck('Bricks', [A.png(560, 560, { seed: 9 })]), size = J(deck).length;
    ok(used > 0, `the guests' budget spent so far: ${used} chars (Bob's two boxes)`);
    const pad = Math.max(0, core.GUEST_DECK_CHARS - used - size - 5000), fat = { ...deck, cards: [{ g: 0, n: 'brick', txt: 'x'.repeat(250) }, ...Array.from({ length: Math.floor(pad / 300) }, () => ({ txt: 'y'.repeat(280) }))] };
    await bob.evaluate((d) => window.__ct.act({ t: 'addDeck', deck: d, x: 100, y: 100 }), fat);
    await h.logHas(alice, 'added deck "Bricks"');
    const r2 = await upload(bob, harborAs("Bob's other harbor"));
    ok(/^🚫 Box rejected: this table's budget for guests is full \(\d+ kB left\) — ask the host to add it$/.test(r2.err), `a deck spent the rest: Bob's next box is refused, in his dialog ("${r2.err}")`);
    ok(!(await named("Bob's other harbor")).length, 'nothing registered');
    await shot(bob, 'p4-boxes-budget-phone');
    await closeBoxes(bob);
  }

  section('11 a 4,000 × 3,000 board image and a board too detailed for 2 MB: stepped down, real types; the Safari fallback (JPEG, PNG)');
  {
    const game = { name: 'Big pictures', pieces: [{ id: 'map', kind: 'board', w: 1200, h: 900, img: 'photo.png' }, { id: 'static', kind: 'board', w: 800, h: 800, img: 'static.png' }], setup: [{ piece: 'map', at: 'center' }] };
    const photo = photoPNG(4000, 3000), noise = A.png(2048, 2048, { seed: 5 });
    let t0 = Date.now();
    let r = await upload(alice, [file('game.json', J(game)), file('photo.png', photo, 'image/png'), file('static.png', noise, 'image/png')], true);
    const ms = Date.now() - t0;
    if (r.ask) { await asked(alice, 'setup'); await reply(alice, 'ok'); }
    await settle();
    let st = await S();
    const [big] = await named('Big pictures', st), imgs = await stored(st.boxes[big].imgs);
    ok(imgs[0].mime === 'image/webp' && imgs[0].real === 'image/webp' && imgs[0].w === 2048 && imgs[0].h === 1536 && imgs[0].bytes <= 2e6,
      `the ${(photo.length / 1e6).toFixed(1)} MB 4,000 × 3,000 PNG: a board image of ${imgs[0].w} × ${imgs[0].h}, ${(imgs[0].bytes / 1e3).toFixed(0)} kB WebP (${ms} ms)`);
    ok(imgs[1].real === 'image/webp' && imgs[1].bytes <= 2e6 && imgs[1].w < 2048 && imgs[1].w >= 1024,
      `the ${(noise.length / 1e6).toFixed(1)} MB of static: over 2 MB at 2,048 px whatever the quality, stepped down to ${imgs[1].w} px (${(imgs[1].bytes / 1e6).toFixed(2)} MB)`);
    for (const p of [alice, bob]) {
      ok(await p.waitForFunction(() => { const i = document.querySelector('#table .item .pimg img'); return i?.complete && i.naturalWidth === 2048; }, null, { timeout: 30000 }).then(() => true, () => false),
        `${p.who}'s screen draws the board from it`);
    }
    await alice.evaluate(() => {
      const td = HTMLCanvasElement.prototype.toDataURL;
      window.__unstub = () => { HTMLCanvasElement.prototype.toDataURL = td; };
      HTMLCanvasElement.prototype.toDataURL = function (t, q) { return td.call(this, t === 'image/webp' ? 'image/png' : t, q); }; // (what Safari may do)
    });
    t0 = Date.now();
    r = await upload(alice, [file('game.json', J({ name: 'Safari pictures', pieces: [{ id: 'map', kind: 'board', w: 1200, h: 900, img: 'photo.png' }, { id: 'boat', kind: 'token', w: 70, img: 'boat.png' }] })),
      file('photo.png', photo, 'image/png'), file('boat.png', fs.readFileSync(path.join(FX, 'harbor', 'boat-red.png')), 'image/png')]);
    await alice.evaluate(() => window.__unstub());
    st = await S();
    const [saf] = await named('Safari pictures', st), sImgs = saf ? await stored(st.boxes[saf].imgs) : [];
    ok(sImgs[0]?.mime === 'image/jpeg' && sImgs[0].real === 'image/jpeg' && sImgs[0].w === 2048 && sImgs[0].bytes <= 2e6 && sImgs[1]?.mime === 'image/png' && sImgs[1].real === 'image/png',
      `a canvas without WebP: the opaque photo stored as JPEG, the boat (transparent) as PNG, by their real types (${J(sImgs.map((x) => x.mime))}, ${Date.now() - t0} ms)`);
  }

  section('12 the same built-in box twice from 📦: one catalog entry');
  {
    for (let k = 0; k < 2; k++) {
      await openBoxes(alice);
      await press(alice, '#box-builtins [data-builtin="draughts"]');
      await alice.waitForFunction(() => !document.querySelector('#box-dialog[open]'), null, { timeout: 15000 });
      await settle();
    }
    const st = await S(), ids = (await named('Draughts', st)).filter((x) => st.boxSrc[x].by !== mPid);
    ok(ids.length === 1 && st.lastSetup === ids[0] && confirms.filter((c) => /set up Draughts/.test(c)).length === 2, `Draughts set up twice (each confirmed): one box (${J(ids)})`);
  }
  section('13 a game running when a box is set up: its rules switched off first, and said; a strict game refuses an upload, saying what to do; the README\'s and Help\'s examples as written');
  {
    const [hid] = await named('Harbor Run');
    await pickGame(alice, 'chess');
    await settle();
    let st = await S();
    ok(st.rules?.enabled && st.rules.name === 'Chess' && !st.lastSetup, `🎲 chess cleared the table: no box is set up any more (lastSetup: ${st.lastSetup ?? 'none'}) (D200)`);
    await openBoxes(alice);
    ok(!(await alice.$('#box-list [data-act="reset"]')) && !(await row(alice, hid)).text.includes('set up'), 'so 📦 offers no Reset, and marks no box "set up"');
    const r = await upload(alice, path.join(FX, 'harbor.zip'));
    ok(/^Couldn't add the game: 🚫 Not a move in this game — the rules running \(«Chess»\) refused the box; the host can switch them off in 📜/.test(r.err), `a strict game refuses the host's upload, and the dialog says why and what to do ("${r.err}")`);
    const rb = await upload(bob, [file('game.json', J({ name: 'Bob tiny', pieces: [{ id: 'a', kind: 'die' }] }), 'application/json')]); // (tiny: the guests' budget is nearly spent, section 9)
    ok(/^🚫 Not a move in this game — the rules running \(«Chess»\) refused the box/.test(rb.err) && !rb.progress, `…and Bob's: his dialog stops waiting and says so ("${rb.err}")`);
    await closeBoxes(bob);
    await press(alice, `.box-row[data-box="${hid}"] [data-act="setup"]`);
    const q = await asked(alice, 'setup');
    ok(q?.text === 'This clears the table. The rules running now («Chess») are switched off.', `Set up says the game running stops (${J(q)})`);
    await shot(alice, 'p4-boxes-stops-desk');
    await reply(alice, 'ok');
    await settle();
    st = await S();
    const [die] = Object.entries(st.items).find(([, it]) => it.t?.endsWith('/d6')) || [];
    ok(st.lastSetup === hid && !st.rules.enabled && die, 'Harbor Run set up; the chess rules are off');
    const l0 = st.log.length;
    await bob.evaluate((id) => window.__ct.act({ t: 'move', id, x: 1300, y: 900 }), die);
    await settle();
    st = await S();
    ok(st.items[die]?.x === 1300 && !st.log.slice(l0).some((e) => /blocked/.test(e.txt)), `Bob moves its die freely: no chess rules refuse it (D205) (${J(st.items[die] && [st.items[die].x, st.items[die].y])}, ${J(st.log.slice(l0).map((e) => e.txt))})`);
    // README's game.json and Help's, uploaded as they are written (with images of the fixture's)
    const dir = path.join(tmp, 'examples'), img = (f) => fs.readFileSync(path.join(FX, 'harbor', f));
    fs.mkdirSync(dir);
    const readme = fs.readFileSync(path.join(h.APP_ROOT, 'cardtable/README.md'), 'utf8'), html = fs.readFileSync(path.join(h.APP_ROOT, 'cardtable/index.html'), 'utf8');
    const rj = JSON.parse(/## Game boxes[\s\S]*?```jsonc\n([\s\S]*?)```/.exec(readme)[1].replace(/\s*\/\/.*$/gm, ''));
    const hj = JSON.parse(/<li><b>📦 Game boxes<\/b>[\s\S]*?<pre>([\s\S]*?)<\/pre>/.exec(html)[1]);
    const files = (o, imgs) => [file('game.json', J(o), 'application/json'), ...Object.entries(imgs).map(([n, f]) => file(n, img(f), 'image/png'))];
    const r1 = await upload(alice, [...files(rj, { 'board.png': 'board.png', 'boat-red.png': 'boat-red.png', 'boat-blue.png': 'boat-blue.png', 'crate.png': 'crate.png', 'calm.png': 'tide-calm.png', 'storm.png': 'tide-storm.png' }),
      file('rules.js', "({ name: 'Harbor Run rules' })", 'text/javascript')], true);
    ok(r1.ask === 'setup', `README's example: read, and Set up asks (${J(r1)})`);
    await reply(alice, 'ok');
    await asked(alice, 'trust');
    await reply(alice, 'without');
    await settle();
    st = await S();
    const first = Object.values(st.players).filter((pl) => pl.seat != null).sort((a, b) => ((a.seat - 90 + 360) % 360) - ((b.seat - 90 + 360) % 360))[0];
    const pile = Object.values(st.items).find((it) => it.k === 'p');
    ok(st.boxes[st.lastSetup]?.name === 'Harbor Run' && Object.keys(st.items).length === 5 && pile?.cards.length === 2 && first?.hand.length === 1 && st.seats?.length === 2,
      `set up as written: the board, a boat a seat, the crate, a pile of 2 Tides and the third in #1's hand (${Object.keys(st.items).length} items)`);
    const r2 = await upload(alice, files(hj, { 'sea.png': 'board.png' }), true);
    if (r2.ask) await reply(alice, 'ok');
    await settle();
    st = await S();
    ok(st.boxes[st.lastSetup]?.name === 'Two Fleets' && Object.keys(st.items).length === 3, `Help's example: set up as written (${Object.keys(st.items).length} items: the sea and a ship a seat)`);
    await closeBoxes(alice);
  }

  section("14 the trust dialog's Cancel stands where Set up was at every size, its buttons wrapped too; a box its rules lay out; a storage failure isn't blamed on the rules");
  {
    // #box-ask stands on its bottom edge: the last button — Set up, then Cancel — sits at the bottom right, wrapped or not (D214)
    for (const [w, ht] of [[1280, 800], [390, 664], [844, 390], [320, 568]]) {
      await alice.setViewportSize({ width: w, height: ht });
      await openBoxes(alice);
      await press(alice, `.box-row[data-box="${beacon}"] [data-act="setup"]`);
      await asked(alice, 'setup');
      const b = await alice.locator('#box-ask-btns button.main').boundingBox(), at = [b.x + b.width / 2, b.y + b.height / 2];
      await reply(alice, 'ok');
      await asked(alice, 'trust');
      const r = await alice.evaluate(([x, y]) => ({
        at: document.elementFromPoint(x, y)?.closest('button')?.value ?? null,
        rows: new Set([...document.querySelectorAll('#box-ask-btns button')].map((e) => Math.round(e.getBoundingClientRect().top))).size,
      }), at);
      ok(r.at === 'cancel' && (w > 320 || r.rows > 1), `${w} × ${ht}: where the confirm's Set up was, the trust dialog has ${r.at} (its buttons in ${r.rows} row${r.rows > 1 ? 's' : ''})`);
      if (w === 320) await shot(alice, 'p4-boxes-trust-narrow');
      await reply(alice, 'cancel');
    }
    await alice.setViewportSize({ width: 1280, height: 800 });
    // A box without a layout: its rules lay the table out (t.layout) — no "Enable its rules" to untick, no "Set up without rules" (D213)
    const LAY = "({ name: 'Laid by its rules', setup(t) { if (!t.data.laid) { t.data.laid = true; t.layout(t.boxes().find((b) => b.name === 'Laid by its rules').id, [{ piece: 'gem', at: [600, 500] }]); } } })";
    const r = await upload(alice, [file('game.json', J({ name: 'Laid by its rules', pieces: [{ id: 'gem', kind: 'token', w: 50, faces: [{ color: '#22c55e', label: 'G' }] }], rules: 'rules.js' }), 'application/json'),
      file('rules.js', LAY, 'text/javascript')]);
    const [lid] = await named('Laid by its rules'), n0 = Object.keys((await S()).items).length;
    ok(/^Added «Laid by its rules»/.test(r.progress) && J((await row(alice, lid))?.btns) === J(['Set up']), `added; its row offers Set up (${r.progress})`);
    await press(alice, `.box-row[data-box="${lid}"] [data-act="setup"]`);
    let q = await asked(alice, 'setup');
    ok(q?.text === 'This clears the table.' && J(q.checks) === '{}', `the confirm: the table cleared, no "Enable its rules" to untick (${J(q)})`);
    await reply(alice, 'ok');
    q = await asked(alice, 'trust');
    ok(J(q?.buttons) === J(['Enable rules', 'Cancel']), `the trust dialog: no "Set up without rules" — there would be nothing to set up (${J(q?.buttons)})`);
    await reply(alice, 'cancel');
    await h.sleep(400);
    let st = await S();
    ok(Object.keys(st.items).length === n0 && st.lastSetup !== lid && !st.rules?.enabled, 'Cancel: nothing cleared, nothing set up');
    await press(alice, `.box-row[data-box="${lid}"] [data-act="setup"]`);
    await asked(alice, 'setup');
    await reply(alice, 'ok');
    await asked(alice, 'trust');
    await reply(alice, 'enable');
    await settle();
    st = await S();
    const items = Object.values(st.items);
    ok(st.lastSetup === lid && st.rules?.enabled && st.rules.box === lid && items.length === 1 && items[0].t === `${lid}/gem`, `Enable rules: the table cleared, its rules lay out the one gem (${items.length} item${items.length === 1 ? '' : 's'})`);
    // The host's images can't be stored, with rules running: the dialog says so, and blames no rules (D211)
    await alice.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.__put = put;
      IDBObjectStore.prototype.put = function (...a) {
        if (this.name === 'assets') throw new DOMException('the test fills the disk', 'QuotaExceededError');
        return put.apply(this, a);
      };
    });
    const full = await upload(alice, [file('game.json', J({ ...JSON.parse(game()), name: 'Quota Test' }), 'application/json'), file('map.png', photoPNG(96, 64, 23), 'image/png')]);
    await alice.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
    ok(full.err === "Couldn't add the game: Couldn't store the box's images: storage is full" && !(await named('Quota Test')).length,
      `the disk full, «Laid by its rules» running: "${full.err}" — not "the rules running … refused the box"`);
    await closeBoxes(alice);
  }
  for (const p of [alice, bob, carol, M]) await p.context().close();

  section("8 resume elsewhere: chess and Hold'em exported mid-game, imported into a fresh room (its host on a phone), played on");
  {
    const dave = await P.join(env, 'Dave', env.url), erin = await P.join(env, 'Erin', dave.url(), { ctx: { ...devices['iPhone 13 landscape'] } });
    const fay = await P.join(env, 'Fay', env.url, { ctx: { ...devices['iPhone 13'] } }), gus = await P.join(env, 'Gus', fay.url());
    Object.assign(dave, { who: 'Dave' }); Object.assign(erin, { who: 'Erin', touch: true }); Object.assign(fay, { who: 'Fay', touch: true }); Object.assign(gus, { who: 'Gus' });
    const room1 = [dave, erin], room2 = [fay, gus];
    const st1 = () => dave.evaluate(() => window.__ct.hostState()), st2 = () => fay.evaluate(() => window.__ct.hostState());
    /** Who of `room` holds seat `seat` (its page). */
    const holder = async (room, seat) => { const st = await room[0].evaluate(() => window.__ct.hostState()); return room.find((p) => st.players[p.pid]?.seatId === seat); };
    /** Page p moves its chess piece on `from` to `to` (what a drop there sends); resolves when every screen of `room` shows it there. */
    async function chessMove(room, p, from, to) {
      await p.evaluate(([from, to]) => {
        const v = window.__ct.view(), a = window.__ct.resolve(from).at, c = window.__ct.resolve(to), [id] = Object.entries(v.items).find(([, it]) => it.at === a);
        const w = document.querySelector(`#table [data-id="${id}"]`).offsetWidth;
        return window.__ct.act({ t: 'move', id, x: c.x - w / 2, y: c.y - w / 2 });
      }, [from, to]);
      return (await Promise.all(room.map((q) => q.waitForFunction((to) => { const v = window.__ct.view(), a = window.__ct.resolve(to)?.at; return Object.values(v.items).some((it) => it.at === a && it.t); }, to, { timeout: 10000 }).then(() => true, () => false)))).every(Boolean);
    }
    /** The host page `host` exports its table with the rules and their state, through 📦: the file's path. */
    async function exportGame(host) {
      await openBoxes(host);
      await host.setChecked('#box-x-rules', true);
      await host.setChecked('#box-x-state', true);
      const [dl] = await Promise.all([host.waitForEvent('download'), press(host, '#box-x-go')]), out = path.join(tmp, `${Date.now()}-${dl.suggestedFilename()}`);
      await dl.saveAs(out);
      await closeBoxes(host);
      return out;
    }
    /** Fay imports file `f` from her phone's 📦 and sets it up with its rules, through the trust dialog; `twice`: her
     *  Set up is a double tap, which must leave the trust dialog waiting (D204). */
    async function importGame(f, what, twice) {
      await upload(fay, f, true);
      const q = await asked(fay, 'setup');
      if (twice) {
        const b = await fay.locator('#box-ask-btns button[value="ok"]').boundingBox(), at = [b.x + b.width / 2, b.y + b.height / 2];
        await fay.locator('#box-ask-btns button[value="ok"]').tap();
        await fay.touchscreen.tap(...at);
        await h.sleep(800);
        ok(!!await fay.$('#box-ask[open][data-kind="trust"]') && (await st2()).rules?.name !== what, `a double tap on Set up on Fay's phone: the trust dialog still waits, «${what}» not started`);
      } else await reply(fay, 'ok');
      const t = await asked(fay, 'trust');
      ok(q?.checks.rules && t?.text.startsWith(`«${what}» comes with rules written by its author.`), `Fay's phone: Set up (rules ticked), then the trust dialog for «${what}»`);
      await shot(fay, `p4-boxes-trust-phone-${what.replace(/\W+/g, '')}`);
      await reply(fay, 'enable');
      await settle(fay);
    }

    await pickGame(dave, 'holdem');
    await settle(dave);
    await dave.evaluate(() => window.__ct.act({ t: 'rulesBtn', id: 'new' }));
    await settle(dave);
    await Promise.all(room1.map((p) => P.waitView(p, 'v.hand.length === 2')));
    const d1 = (await st1()).rules.data, f2 = await exportGame(dave), seat1 = (await st1()).players[d1.turn]?.seat;
    ok(d1.stage === 'hand' && seat1 != null && /Hold'em \(chips\)\.json$/.test(f2), `room 1: a hand dealt, ${room1.find((p) => p.pid === d1.turn)?.who} to act; exported (${J({ stage: d1.stage, turn: d1.turn })})`);
    await importGame(f2, "Hold'em (chips)");
    let st = await st2();
    const toAct = room2.find((p) => p.pid === st.rules.data.turn), btn = toAct && (st.rules.public.buttons || []).find((b) => b.pid === toAct.pid && /^(call|check)$/.test(b.id));
    ok(st.rules.enabled && st.rules.data.stage === 'hand' && toAct && st.players[toAct.pid].seat === seat1 && J(Object.values(st.rules.data.stacks).sort()) === J(Object.values(d1.stacks).sort()),
      `room 2: the hand goes on, the same seat to act (${toAct?.who}), the stacks the same, keyed by the new players`);
    await Promise.all(room2.map((p) => P.waitView(p, 'v.hand.length === 2')));
    await toAct.evaluate((id) => window.__ct.act({ t: 'rulesBtn', id }), btn?.id);
    await settle(fay);
    st = await st2();
    ok(st.rules.enabled && st.log.slice(-6).some((e) => /calls|checks/.test(e.txt)) && !(await fay.evaluate(() => window.__ct.lastRulesError)), `${toAct?.who} ${btn?.id}s: no script error (${J(st.log.slice(-2).map((e) => e.txt))})`);

    await pickGame(dave, 'chess');
    await settle(dave);
    const W = await holder(room1, 'white'), B = await holder(room1, 'black');
    ok(await chessMove(room1, W, 'e2', 'e4') && await chessMove(room1, B, 'e7', 'e5') && await chessMove(room1, W, 'g1', 'f3'), 'room 1: 1. e4 e5 2. Nf3 — Black to move');
    const chessBox = (await st1()).rules.data.box, f1 = await exportGame(dave);
    ok(/\.json$/.test(f1) && JSON.parse(fs.readFileSync(f1, 'utf8')).rulesState.data.box === chessBox, `exported (no images: a .json) with the rules and their state, chess's box id ${chessBox} in it`);
    await importGame(f1, 'Chess', true);
    st = await st2();
    ok(st.rules?.enabled && st.rules.data.box === chessBox && st.boxes[chessBox] && st.rules.data.turn === 'b', 'room 2: set up with its rules, the box id kept (t.data.box finds it), Black to move');
    const B2 = await holder(room2, 'black');
    ok(B2 && await chessMove(room2, B2, 'b8', 'c6') && (await st2()).rules.data.turn === 'w' && !(await fay.evaluate(() => window.__ct.lastRulesError)), `${B2?.who} (Black now) plays Nc6: legal, no script error`);
    // A guest whose host has gone hears so, rather than waiting on "Sent… to the host" for ever (D209)
    gus.watchdogOK = true;
    await fay.context().close();
    await upload(gus, harborAs('Harbor for nobody')).catch((err) => console.error('upload with the host gone', err));
    const gone = await gus.waitForFunction(() => document.getElementById('box-err').textContent, null, { timeout: 45000 }).then((x) => x.jsonValue(), () => '');
    ok(/the host isn't here|The host left before answering|No answer from the host/.test(gone), `Gus's host left: his dialog says so ("${gone}")`);

  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
