// E2E, Phase 4A: what an upload may not do, and what an attacker may not
// do — written from spec §4j (the import limits, attacker cases 1–7 and
// 9–12; case 8 is 4B's `group`), §4l t-p4-boxes items 3 and 11, §4c and
// the decisions D176–D195; independent of the implementer's suites. Alice
// hosts on an iPhone 13 held upright (her fingers press every button), Bob
// plays on a desktop, Mallory is a raw peer. Every upload is files picked in
// the 📦 dialog's file input; JSZip is served through a spy (p4-lib zipSpy)
// that records what the app asks of it.
//  3  every malformed upload fails loudly, in the dialog (on the phone's
//     screen) and a toast, naming the file or the field, and registers
//     nothing: a zip bomb (case 1, nothing inflated), "../" and "/" paths
//     (2), an SVG and an HTML page named .png (3), a missing file (4), a
//     directory that understates a size (9: the stream stops, it never
//     inflates 100 MB), a 30,000 × 30,000 PNG (12: never decoded), a zip
//     over 64 MB (never opened), 2,101 entries, 75 MB declared, two
//     game.json, a 700 KB rules file, bad JSON; a guest's too. A zip with
//     "./" names and macOS's __MACOSX/ copies is read (D188).
//  11 a 4,000 × 3,000 photographic PNG board is drawn at 2,048 px within
//     2 MB; a 2,048² noise board steps down (quality, then size) to fit;
//     with toDataURL('image/webp') answering PNG (Safari), an opaque image
//     is stored as JPEG and a transparent one as PNG — a deck's too; each
//     records the type its bytes are, and renders on both screens.
//  M  Mallory: case 5 (a 2 M-char box, "__proto__" ids), 6 (setup, reset),
//     10 (a forged built-in: stored as hers, not built in, the trust dialog
//     asks), 11 (forged rules state: each entry dropped with console.error
//     on Set up, and the toast).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const A = require('./assets-lib');
const X = require('./p4-lib');
const { mallory } = require('./final-lib');
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const { devices } = h.playwright;
const J = JSON.stringify;
const MPID = 'ffffffffffffffff';
const FX = path.join(__dirname, 'fixtures', 'lantern');
const SHOTS = path.join(__dirname, 'shots');
const ONLY_HOST = '🚫 Only the host can do that';
const INVALID = 'Some saved game state was invalid and was dropped';
/** The game.json of a hostile upload: a board showing `img`. */
const hostile = (img = 'map.png', more = {}) => J({ name: 'Hostile', pieces: [{ id: 'map', kind: 'board', img, w: 400, h: 300 }], setup: [{ piece: 'map', at: 'center' }], ...more });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.__pwned = 1</script><rect width="10" height="10"/></svg>';
const HTML = '<!doctype html><html><body><img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script></body></html>';
/** Draughts (templates.js BOXES) in the game.json authoring format: its types as pieces, a board's structure on its piece. */
function draughtsDef() {
  const b = BOXES.draughts;
  return {
    name: b.name, table: b.table, seats: b.seats, players: b.players, setup: b.setup, imgs: [],
    pieces: Object.entries(b.types).map(([id, { board, ...t }]) => ({ id, ...t, ...board })),
  };
}

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-box-files-'));
  const big = (name, buf) => { const f = path.join(tmp, name); fs.writeFileSync(f, buf); return f; };
  const errors = [];
  async function join(name, url, o = {}) {
    const p = await env.page(name, o);
    await p.addInitScript(X.watchers);
    await p.addInitScript(A.decodeWatch);
    await p.addInitScript(h.quotaStub);
    await X.zipSpy(p);
    await p.goto(url);
    await h.joinAs(p, name);
    await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
    p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
    p.touch = !!o.ctx?.hasTouch;
    return p;
  }
  const alice = await join('Alice', env.url, { ctx: devices['iPhone 13'] });
  alice.on('console', (m) => { if (m.type() === 'error') errors.push({ at: Date.now(), text: m.text() }); });
  const bob = await join('Bob', alice.url());
  const S = () => X.S(alice);
  async function until(pred, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
      const st = await S();
      if (pred(st)) return st;
      if (Date.now() > end) return null;
      await h.sleep(100);
    }
  }
  const named = (st, name) => Object.keys(st.boxes).filter((id) => st.boxes[id].name === name);
  const zipState = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__zip || { loads: [], calls: [], bytes: {} })));
  /** Whether page p decoded (made an object URL or a bitmap of) anything that starts like markup ("<"). */
  const decodedMarkup = (p) => p.evaluate(async () => {
    for (const b of window.__decode.blobs) if (new Uint8Array(await b.slice(0, 1).arrayBuffer())[0] === 0x3c) return true;
    return false;
  });

  // ---------------------------------------------------------------------------------
  section('3. malformed uploads, picked on the host\'s phone: each refused loudly, naming the file or field; nothing registers');
  const cat0 = Object.keys((await S()).boxes).length;
  /** Alice picks `files`; the upload must fail: inline (on her screen) and in a toast, both saying `names`. Returns {err, z (the zip spy's record of this upload)}. */
  async function refused(label, files, names, o = {}) {
    const z0 = await zipState(alice), t0 = Date.now(), r = await X.upload(alice, files, { now: false });
    const tw = await X.toasts(alice, t0), z1 = await zipState(alice);
    const z = { loads: z1.loads.slice(z0.loads.length), calls: z1.calls.slice(z0.calls.length), bytes: Object.fromEntries(Object.entries(z1.bytes).map(([k, v]) => [k, v - (z0.bytes[k] || 0)]).filter(([, v]) => v)) };
    ok(!!r.err && names.every((n) => r.err.includes(n)), `${label}: refused in the dialog, naming ${names.join(', ')} — "${r.err}"`);
    ok(tw.some((m) => names.every((n) => m.includes(n))), `${label}: and in a toast`);
    if (r.err && !o.noView) ok(await X.inView(alice, '#box-err'), `${label}: the error is on the phone's screen`);
    return { err: r.err, z };
  }
  // 1. a zip bomb: 100 MB of zeros in a 98 KB zip, its size declared honestly
  const zeros = Buffer.alloc(100e6);
  const bombZip = big('bomb.zip', X.zip([{ name: 'game.json', data: hostile() }, { name: 'map.png', data: zeros }]));
  let r = await refused('case 1, a zip bomb', [bombZip], ['map.png']);
  ok(r.z.loads.length === 1 && !r.z.calls.some(([, n]) => n === 'map.png'), `case 1: refused before it was inflated: map.png was never read (${J(r.z.calls)})`);
  // 2. paths that point outside the zip
  for (const bad of ['../../evil.png', '/abs.png']) {
    r = await refused(`case 2, "${bad}"`, [big('slip.zip', X.zip([{ name: 'game.json', data: hostile() }, { name: 'map.png', data: X.noise(8, 8) }, { name: bad, data: X.noise(8, 8, 2) }]))], [bad]);
    ok(!r.z.calls.length, `case 2: nothing in it was read (${J(r.z.calls)})`);
  }
  // 3. markup named .png, in a zip and as plain files
  for (const [kind, text] of [['an SVG', SVG], ['an HTML page', HTML]]) {
    await refused(`case 3, ${kind} named map.png, zipped`, [big('markup.zip', X.zip([{ name: 'game.json', data: hostile() }, { name: 'map.png', data: text }]))], ['map.png']);
    await refused(`case 3, ${kind} named map.png, picked as a file`, [X.file('game.json', hostile(), 'application/json'), X.file('map.png', text, 'image/png')], ['map.png']);
  }
  ok(!(await decodedMarkup(alice)) && !(await alice.evaluate(() => window.__pwned)), 'case 3: no markup was ever decoded or run');
  // 4. a file that isn't there
  await refused('case 4, game.json names gone.png (zip)', [big('gone.zip', X.zip([{ name: 'game.json', data: hostile('gone.png') }, { name: 'map.png', data: X.noise(8, 8) }]))], ['gone.png', 'pieces[0]']);
  await refused('case 4, game.json names gone.png (files)', [X.file('game.json', hostile('gone.png'), 'application/json'), X.file('map.png', X.noise(8, 8), 'image/png')], ['gone.png', 'pieces[0]']);
  // 9. a directory that understates a size: 1 KB declared, 100 MB inside
  r = await refused('case 9, map.png declared 1 KB, 100 MB inside', [big('liar.zip', X.zip([{ name: 'game.json', data: hostile() }, { name: 'map.png', data: zeros, declared: 1024 }]))], ['map.png']);
  const inflated = r.z.bytes['map.png'] || 0;
  ok(r.z.calls.some(([m, n]) => m === 'internalStream' && n === 'map.png') && !r.z.calls.some(([m]) => m !== 'internalStream'), `case 9: map.png was streamed, never inflated whole (${J(r.z.calls)})`);
  ok(inflated > 1024 && inflated < 20e6, `case 9: the stream stopped just past what it declared: ${inflated.toLocaleString('en-US')} bytes came out of 100,000,000 (one compressed block's output at most, D188)`);
  // 12. a 30,000 × 30,000 PNG
  await refused('case 12, a 30,000 × 30,000 PNG', [big('huge.zip', X.zip([{ name: 'game.json', data: hostile() }, { name: 'map.png', data: X.hugePNG(30000, 30000) }]))], ['map.png']);
  ok(!(await A.decodedBomb(alice)), 'case 12: refused by its header, never decoded');
  // the other zip limits (§4j, D188)
  const huge = path.join(tmp, 'huge-file.zip');
  fs.writeFileSync(huge, Buffer.alloc(64e6 + 1));
  r = await refused('a zip of 64 MB + 1 byte', [huge], ['huge-file.zip']);
  ok(!r.z.loads.length, `refused on its size before JSZip read it (loadAsync calls: ${r.z.loads.length})`);
  r = await refused('2,101 entries', [big('many.zip', X.zip([{ name: 'game.json', data: hostile() }, ...Array.from({ length: 2100 }, (_, k) => ({ name: `f${k}.txt`, data: 'x', store: true }))]))], ['many.zip']);
  ok(!r.z.calls.length, 'refused on the count, nothing read');
  r = await refused('75 MB declared in 5 entries of 15 MB', [big('sum.zip', X.zip([{ name: 'game.json', data: hostile() }, ...[1, 2, 3, 4, 5].map((k) => ({ name: `part${k}.png`, data: Buffer.alloc(15e6) }))]))], ['sum.zip']);
  ok(!r.z.calls.some(([, n]) => n.startsWith('part')), `refused on the declared sizes, before inflating any (${J(r.z.calls)})`);
  await refused('game.json in two folders', [big('two.zip', X.zip([{ name: 'a/game.json', data: hostile() }, { name: 'b/game.json', data: hostile() }, { name: 'a/map.png', data: X.noise(8, 8) }]))], ['game.json']);
  await refused('a 700 KB rules.js', [big('rules.zip', X.zip([{ name: 'game.json', data: hostile('map.png', { rules: 'rules.js' }) }, { name: 'map.png', data: X.noise(8, 8) }, { name: 'rules.js', data: `// ${'x'.repeat(700e3)}\n({ name: 'Big' })` }]))], ['rules.js']);
  await refused('bad JSON', [X.file('game.json', '{ "name": "Broken", ', 'application/json'), X.file('map.png', X.noise(8, 8), 'image/png')], ['game.json']);
  await alice.screenshot({ path: path.join(SHOTS, 'p4x-error-phone.png') });
  let st = await S();
  ok(Object.keys(st.boxes).length === cat0, `nothing of these registered (${Object.keys(st.boxes).length} boxes)`);
  // A zip as macOS Finder writes one: "./" names, a __MACOSX/ folder of copies (D188: skipped, not refused)
  const lit = fs.readFileSync(path.join(FX, 'lantern-lit.png'));
  r = await X.upload(alice, [big('finder.zip', X.zip([
    { name: './game.json', data: J({ name: 'Dot Isle', pieces: [{ id: 'lamp', kind: 'token', w: 60, img: './lamp.png' }], setup: [{ piece: 'lamp', at: [200, 200] }] }) },
    { name: './lamp.png', data: lit }, { name: '__MACOSX/', dir: true }, { name: '__MACOSX/._game.json', data: Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]) },
  ]))], { now: false });
  st = await until((s) => named(s, 'Dot Isle').length === 1);
  ok(!r.err && !!st, `a zip with "./" names and a __MACOSX/ folder is read: «Dot Isle» registers (${r.err || r.progress})`);
  // §4h all or nothing: images that can't be stored, no box
  await alice.evaluate(() => { window.__quota = 'assets'; });
  let t1 = Date.now();
  r = await X.upload(alice, [X.file('game.json', J({ name: 'Full Isle', pieces: [{ id: 'gem', kind: 'token', w: 50, img: 'gem.png' }] }), 'application/json'), X.file('gem.png', X.noise(64, 64, 77), 'image/png')], { now: false });
  const full = [...(await X.toasts(alice, t1)), r.err];
  await alice.evaluate(() => { window.__quota = null; });
  ok(full.some((m) => m?.includes("Couldn't store the box's images: storage is full")), `storage full: "Couldn't store the box's images: storage is full" (${full.filter(Boolean).slice(-2).join(' | ')})`);
  await h.sleep(500);
  ok(named(await S(), 'Full Isle').length === 0, 'and the box is not registered: all or nothing');
  await X.closeBoxes(alice);
  // a guest's malformed upload fails on his own screen and never reaches the host
  const log0 = (await S()).log.length;
  const t0 = Date.now();
  r = await X.upload(bob, [bombZip]);
  ok(!!r.err && r.err.includes('map.png') && (await X.toasts(bob, t0)).some((m) => m.includes('map.png')), `a guest's (Bob's) zip bomb: refused in his dialog and a toast (${r.err})`);
  await h.sleep(500);
  ok((await S()).log.length === log0 && Object.keys((await S()).boxes).length === cat0 + 1, 'nothing reached the host');
  await X.closeBoxes(bob);

  // ---------------------------------------------------------------------------------
  section('11. oversized board images step down to fit 2 MB; the Safari fallback (JPEG / PNG); each records its real type');
  const photoPNG = X.photo(4000, 3000, 3);
  ok(photoPNG.length > 2e6 && photoPNG.length < 16e6, `the photograph is a 4,000 × 3,000 PNG of ${(photoPNG.length / 1e6).toFixed(1)} MB (over 2 MB): precondition`);
  /** Alice uploads a box `name` with a board showing `file` (a path), sets it up; resolves the stored board image (X.asset) and the box id. */
  async function boardBox(name, file, w, ht) {
    r = await X.upload(alice, [big('game.json', J({ name, table: { shape: 'rect', w: 2000, h: 1500 }, pieces: [{ id: 'map', kind: 'board', img: path.basename(file), w, h: ht }], setup: [{ piece: 'map', at: 'center', id: 'b0a4d000' }] })), file], { now: true, timeout: 120000 }); // (files on disk: a path and a buffer can't be mixed)
    ok(r.ask === 'setup', `«${name}» read (${r.err || r.progress})`);
    await X.reply(alice, 'Set up');
    st = await until((s) => named(s, name).length === 1 && s.lastSetup === named(s, name)[0]);
    await X.settle(alice);
    st = await S();
    const id = named(st, name)[0], img = st.boxes[id]?.imgs?.[0];
    return { id, img, a: img && await X.asset(alice, img) };
  }
  let b = await boardBox('Big Map', big('photo.png', photoPNG), 1200, 900);
  ok(b.a && Math.max(b.a.w, b.a.h) === 2048 && b.a.w / b.a.h === 4 / 3, `the photograph's board image is 2,048 px on its long side (${b.a?.w} × ${b.a?.h})`);
  ok(b.a && b.a.size <= 2e6, `and within 2 MB (${b.a?.size.toLocaleString('en-US')} bytes)`);
  ok(b.a && b.a.mime === b.a.magic && b.a.magic === 'image/webp', `stored as WebP, typed by its bytes (${b.a?.mime} / ${b.a?.magic})`);
  for (const [p, who] of [[alice, 'Alice (phone)'], [bob, 'Bob (desktop)']]) {
    const ok2 = await p.waitForFunction((id) => { const i = document.querySelector(`.item[data-id="${id}"] img`); return i?.complete && i.naturalWidth > 0; }, 'b0a4d000', { timeout: 20000 }).then(() => true, () => false);
    ok(ok2, `it renders on ${who}'s screen`);
  }
  const noiseFile = big('static.png', X.noise(2048, 2048, 11));
  const pre = await alice.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
    const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    c.getContext('2d').drawImage(bmp, 0, 0);
    const u = c.toDataURL('image/webp', 0.6);
    return { webp: u.startsWith('data:image/webp'), bytes: Math.floor(((u.length - u.indexOf(',') - 1) * 3) / 4) };
  }, fs.readFileSync(noiseFile).toString('base64'));
  ok(pre.webp && pre.bytes > 2e6, `the noise board can't fit 2 MB at 2,048 px even as WebP 0.6 (${pre.bytes.toLocaleString('en-US')} bytes): precondition`);
  b = await boardBox('Static Map', noiseFile, 1000, 1000);
  ok(b.a && b.a.size <= 2e6, `stepped down to fit: ${b.a?.size.toLocaleString('en-US')} bytes ≤ 2 MB`);
  ok(b.a && b.a.w < 2048 && b.a.w >= 1024 && b.a.w === b.a.h, `by its size once its quality is spent: ${b.a?.w} × ${b.a?.h} px (between 1,024 and 2,048)`);
  ok(b.a && b.a.mime === b.a.magic, `typed by its bytes (${b.a?.mime})`);
  const bigBoard = b.id;
  // Safari: toDataURL('image/webp') answers a PNG
  await alice.evaluate(() => {
    const o = HTMLCanvasElement.prototype.toDataURL;
    window.__realToDataURL = o;
    HTMLCanvasElement.prototype.toDataURL = function (type, q) { return o.call(this, type === 'image/webp' ? 'image/png' : type, q); };
  });
  const clear = X.png(300, 300, X.pixels(300, 300, (x, y) => [200, 120, 40, (x + y) % 256 < 128 ? 0 : 255]), { alpha: true });
  r = await X.upload(alice, [X.file('game.json', J({ name: 'Safari Isle', pieces: [{ id: 'view', kind: 'tile', w: 120, img: 'view.png' }, { id: 'glass', kind: 'token', w: 60, img: 'glass.png' }], setup: [{ piece: 'view', at: [100, 100] }, { piece: 'glass', at: [300, 100] }] }), 'application/json'),
    X.file('view.png', X.photo(800, 600, 21), 'image/png'), X.file('glass.png', clear, 'image/png')], { now: false });
  st = await until((s) => named(s, 'Safari Isle').length === 1);
  const sb = st && st.boxes[named(st, 'Safari Isle')[0]], types = sb && Object.fromEntries(Object.entries(sb.types).map(([k, t]) => [k, sb.imgs[t.faces[0].img]]));
  const view = types && await X.asset(alice, types.view), glass = types && await X.asset(alice, types.glass);
  ok(view?.mime === 'image/jpeg' && view.magic === 'image/jpeg', `Safari: the opaque photograph is stored as JPEG (${view?.mime} / ${view?.magic}, ${view?.w} × ${view?.h})`);
  ok(glass?.mime === 'image/png' && glass.magic === 'image/png', `Safari: the transparent one as PNG (${glass?.mime} / ${glass?.magic})`);
  ok(view?.w === 560 && glass?.w === 300, `each at most 560 px for a piece (${view?.w}, ${glass?.w})`);
  // the + Deck dialog encodes its images the same way (it replaced fileToDataURL)
  await X.closeBoxes(alice);
  const decks0 = Object.keys(st.decks || {});
  await X.press(alice, '#add-deck-btn');
  await alice.waitForSelector('#deck-dialog[open]');
  await alice.locator('input[name="deck-kind"][value="img"]').tap();
  await alice.setInputFiles('#deck-files', [X.file('dawn.png', X.photo(400, 560, 31), 'image/png')]);
  await X.press(alice, '#deck-add');
  st = await until((s) => Object.keys(s.decks || {}).length > decks0.length, 30000);
  const nd = st && Object.keys(st.decks).find((k) => !decks0.includes(k));
  let dimg = null; // (a host's own deck images are held, and stored with its next save: a second or so)
  for (let k = 0; k < 50 && nd && !dimg; k++) { dimg = await X.asset(alice, st.decks[nd].imgs[0]); if (!dimg) await h.sleep(200); }
  ok(dimg?.mime === 'image/jpeg' && dimg.magic === 'image/jpeg', `Safari: a deck's opaque card image too is stored as JPEG (${dimg?.mime} / ${dimg?.magic}${dimg ? '' : `; deck ${J(nd && st.decks[nd]).slice(0, 200)}`})`);
  await alice.evaluate(() => { HTMLCanvasElement.prototype.toDataURL = window.__realToDataURL; });

  // ---------------------------------------------------------------------------------
  section('M. Mallory: case 5 (the budget, "__proto__"), 6 (setup, reset), 10 (a forged built-in), 11 (forged rules state)');
  const M = await mallory(env, alice.url(), 2);
  await M.act({ t: 'hello' });
  st = await until((s) => s.players[MPID]?.seat != null);
  ok(!!st, 'Mallory (a raw peer) sits at the table');
  const notes = () => M.notes();
  /** Mallory sends `a` (an action, or its JSON text: an own "__proto__" key survives only as text); resolves the notes she got for it (waits for one, up to 15 s). */
  async function attempt(a, wait = true) {
    const n0 = (await notes()).length;
    await M.evaluate((t) => window.M.act(JSON.parse(t)), typeof a === 'string' ? a : J(a));
    if (wait) await M.waitForFunction((n) => window.M.notes().length > n, n0, { timeout: 15000 }).catch(() => null);
    else await h.sleep(1500);
    return (await notes()).slice(n0);
  }
  const before = await S(), d0 = await alice.evaluate(() => window.__ct.digest());
  // case 5: a box of 2 M characters: the guests' budget
  let got = await attempt({ t: 'addBox', box: { name: 'Bloat', imgs: [`data:image/png;base64,${'A'.repeat(2e6)}`], pieces: [{ id: 'blob', kind: 'token', img: 0 }] } });
  ok(got.some((m) => /^🚫 Box rejected: this table's budget for guests is full \(\d+ kB left\) — ask the host to add it$/.test(m)), `case 5: a 2 M-char box is refused by the budget (${got})`);
  // case 5: "__proto__" type ids
  got = await attempt('{"t":"addBox","box":{"name":"Proto","imgs":[],"pieces":[{"id":"__proto__","kind":"token","faces":[{"color":"#ff0000"}]}],"setup":[{"piece":"__proto__","at":[10,10]}]}}');
  ok(got.some((m) => m.startsWith('🚫 Box rejected: ')), `case 5: a "__proto__" type id is refused by cleanBox (${got})`);
  got = await attempt('{"t":"addBox","box":{"name":"Proto2","imgs":[],"pieces":[{"id":"chip","kind":"token","back":"__proto__","faces":[{"color":"#ff0000"}]}],"backs":[{"id":"__proto__","color":"#000000"}]}}');
  ok(got.some((m) => m.startsWith('🚫 Box rejected: ')), `case 5: a "__proto__" back id too (${got})`);
  st = await S();
  ok(Object.keys(st.boxes).length === Object.keys(before.boxes).length && (st.guestDeckChars || 0) === (before.guestDeckChars || 0), 'nothing registered, nothing charged to the budget');
  ok(await alice.evaluate(() => ({}).kind === undefined && ({}).faces === undefined && Object.getPrototypeOf({}) === Object.prototype), "the host's objects are untouched");
  // case 6: setup and reset are the host's
  got = await attempt({ t: 'setup', box: bigBoard, clear: true });
  ok(got.includes(ONLY_HOST), `case 6: Mallory's setup is refused: "${got}"`);
  await h.sleep(10500); // (the host answers a peer's refused host action once in 10 s: app.js refuse())
  got = await attempt({ t: 'reset' });
  ok(got.includes(ONLY_HOST), `case 6: and her reset: "${got}"`);
  st = await S();
  ok((await alice.evaluate(() => window.__ct.digest())) === d0 && st.lastSetup === before.lastSetup, 'the table and lastSetup are as they were');
  // case 10: a forged built-in: Draughts with one piece changed, claiming to be built in and the host's
  const fake = draughtsDef();
  fake.pieces.find((p) => p.id === 'dark').faces[0].color = '#1c1918';
  got = await attempt({ t: 'addBox', box: { ...fake, src: 'builtin', by: alice.pid, builtin: true, rules: "({ name: 'Draughts', setup(t) { t.data.mine = true; } })" } }, false);
  st = await until((s) => Object.keys(s.boxes).some((id) => s.boxes[id].name === 'Draughts' && s.boxSrc[id]?.by === MPID));
  const forged = st && Object.keys(st.boxes).find((id) => st.boxes[id].name === 'Draughts' && st.boxSrc[id]?.by === MPID);
  ok(!!forged && J(st.boxSrc[forged]) === J({ src: 'upload', by: MPID }), `case 10: stored as Mallory's upload, whatever she claimed (${J(st?.boxSrc[forged])})`);
  ok(await bob.waitForFunction((id) => !!window.__ct.boxes()[id], forged, { timeout: 15000 }).then(() => true, () => false), 'Bob holds it');
  await X.openBoxes(bob);
  const brow = await X.row(bob, forged);
  ok(brow && brow.text.includes('by Mallory') && !brow.text.includes('built in'), `case 10: Bob's 📦 says "by Mallory", not built in (${brow?.text})`);
  await X.closeBoxes(bob);
  await X.openBoxes(alice);
  const arow = await X.row(alice, forged);
  ok(arow && arow.text.includes('by Mallory') && !arow.text.includes('built in') && arow.text.includes('📜'), `case 10: so does Alice's, with 📜 (${arow?.text})`);
  await X.press(alice, `#box-list .box-row[data-box="${forged}"] button[data-act="setup"]`);
  let q = await X.asked(alice, 'setup');
  ok(q && q.lines.includes('Mallory added this box and knows its starting layout.') && q.checks.rules === true && q.checks.shuffle === true, `case 10: the confirm names Mallory (${q?.lines})`);
  await X.reply(alice, 'Set up');
  q = await X.asked(alice, 'trust');
  ok(q && q.lines.join(' ').startsWith('«Draughts» comes with rules written by its author, added by Mallory.'), `case 10: Set up with rules: the trust dialog asks (${q?.lines})`);
  await alice.screenshot({ path: path.join(SHOTS, 'p4x-trust-phone.png') });
  ok(await X.inView(alice, '#box-ask-btns button'), "its buttons are on the phone's screen");
  await X.reply(alice, 'Cancel');
  await X.settle(alice);
  ok((await alice.evaluate(() => window.__ct.digest())) === d0, 'Cancel: nothing changed');
  // case 11: forged engine state, set up with rules: each bad entry dropped with console.error, and the toast
  const future = Date.now() + 1e9;
  const ask = (id, n) => ({ id, prompt: 'Pick one', options: Array.from({ length: n }, (_, k) => `opt ${k}`) });
  const FORGED = {
    'Forged state': `{"data":{"keep":"ok","_timers":[{"at":"x","tag":"bad"},{"at":${future},"tag":"good"}]},"public":{},"asks":{"@#1":[${J(ask('many', 500))},${J(ask('fine', 2))}]},"secret":{"@#1":"fine","__proto__":"evil"}}`,
    'Forged ask': `{"data":{},"public":{},"asks":{"@#1":[${J(ask('many', 500))}]},"secret":{}}`,
    'Forged timer': '{"data":{"_timers":[{"at":"x","tag":"bad"}]},"public":{},"asks":{},"secret":{}}',
    'Forged secret': '{"data":{},"public":{},"asks":{},"secret":{"__proto__":"evil"}}',
  };
  for (const [name, rs] of Object.entries(FORGED)) {
    const rest = J({ name, imgs: [], pieces: [{ id: 'stone', kind: 'token', faces: [{ color: '#888888' }] }], setup: [{ piece: 'stone', at: [400, 400] }], rules: "({ name: 'Forged', onTimer() {} })" });
    await attempt(`{"t":"addBox","box":{"rulesState":${rs},${rest.slice(1)}}`, false);
  }
  st = await until((s) => Object.keys(FORGED).every((n) => named(s, n).length === 1));
  ok(!!st, 'Mallory\'s four boxes with forged rules state register (cleanBox checks its shape; the gates run on Set up, D177)');
  const one = st && named(st, 'Forged state')[0];
  ok(!!one && (await alice.evaluate((id) => JSON.stringify(window.__ct.hostState().boxes[id].rulesState.secret), one)).includes('"__proto__":"evil"'), 'the forged "__proto__" secret arrived as an own key (a real attack)');
  for (const name of Object.keys(FORGED)) {
    const id = named(await S(), name)[0], e0 = errors.length, t0 = Date.now();
    await X.openBoxes(alice);
    await X.press(alice, `#box-list .box-row[data-box="${id}"] button[data-act="setup"]`);
    await X.asked(alice, 'setup');
    await X.reply(alice, 'Set up');
    await X.asked(alice, 'trust');
    await X.reply(alice, 'Enable rules');
    st = await until((s) => s.rules?.enabled && s.rules.box === id);
    await X.settle(alice);
    st = await S();
    const R = st.rules || {}, first = X.ranked(st)[0], logged = errors.slice(e0).map((e) => e.text);
    const secretText = await alice.evaluate(() => JSON.stringify(window.__ct.hostState().rules?.secret ?? {}));
    ok(!!R.enabled && R.box === id, `case 11 «${name}»: set up, its rules running`);
    const tw = await X.toasts(alice, t0);
    ok(tw.includes(INVALID), `case 11 «${name}»: the toast "${INVALID}"${tw.includes(INVALID) ? '' : ` (shown: ${J(tw.filter((m) => /state/.test(m)))})`}`);
    if (name === 'Forged state') {
      ok(R.data?.keep === 'ok' && J(R.data._timers) === J([{ at: future, tag: 'good' }]), `the bad timer dropped, the good one and the rest of t.data kept (${J(R.data)})`);
      ok(J((R.asks?.[first] || []).map((a) => a.id)) === J(['fine']), `the 500-option ask dropped, the good one kept (${J(Object.values(R.asks || {}).map((l) => l.map((a) => a.id)))})`);
      ok(R.secret?.[first] === 'fine' && !secretText.includes('__proto__'), `the "__proto__" secret dropped, the good one kept (${secretText})`);
      ok(logged.length >= 3, `each dropped with console.error (${logged.length}: ${logged.slice(0, 3).map((t) => t.slice(0, 60)).join(' | ')})`);
    } else {
      ok(logged.length >= 1, `case 11 «${name}»: dropped with console.error (${logged.slice(0, 2).map((t) => t.slice(0, 70)).join(' | ')})`);
      ok(!(R.data?._timers || []).length && !Object.keys(R.asks || {}).length && !secretText.includes('__proto__'), `case 11 «${name}»: none of it was seeded (${J({ timers: R.data?._timers, asks: R.asks })}, secret ${secretText})`);
    }
  }
  ok(await alice.evaluate(() => ({}).evil === undefined), "the host's objects are untouched");
  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
