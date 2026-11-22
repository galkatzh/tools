// E2E: Phase 1 storage (spec §1h; §1l t-p1-store). The host saves in
// IndexedDB (database `cardtable`: saves, catalog, assets). Every check reads
// what the browser stored (h.idb) and what the page shows, and takes what it
// expects from the spec, not from store.js:
//   (1) save     the table goes to IndexedDB: {room, ts, v, state}, its decks apart in
//                the room's catalog (each written once, in one transaction with a
//                save), its images by the SHA-256 of their bytes; a reload resumes
//                the decks, images, log, rules (public and private state) and hands
//   (2) migrate  a pre-Phase 1 save (localStorage ct-save- / ct-decks-: an image deck
//                and the standard deck, seat keys inside players) resumes with its
//                images and its returning guest, and its keys go — but stay when the
//                new storage refuses it; a legacy lost marker migrates and resets loudly
//   (3) quota    full storage prunes another room's old save (its catalog and images
//                too; a save written moments ago is spared) and says so; with nothing
//                to prune: a lost marker, one toast, and a reload resets loudly; a
//                guest whose image cache is full keeps its images in memory, said once
//   (4) no IDB   indexedDB.open fails: the toast, the table plays unsaved with no
//                fallback, and after a reload the tab still hosts its room (its host
//                key) and its guest reconnects
//   (5) pending  a ct-pending-<room> marker ahead of the save warns at boot (not one
//                the save caught up with); a reload right after a move keeps the move
//                or says it was lost
//   (6) newer    a save of state v STATE_V + 1: the pinned toast, the tab hosts, and
//                the record (and its catalog) are byte for byte the same after play
//   (7) skew     a core.js, store.js or templates.js of another MODULE_V: the banner,
//                and the page does not start
//   (8) upkeep   the idle image GC deletes the images no catalog shows that went
//                unused for 14 days, and nothing else; persistent storage is asked
//                for once, from the host's first upload, never at boot; a database
//                upgrade in another tab is let through, and the tab says so
'use strict';
const path = require('path');
const h = require('./h');
const L = require('./p1-lib');
const I = require('./img-lib');
const { ok, section } = h;
const { STATE_V, cleanDeck } = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

const DAY = 864e5;
/** Three real PNGs (50 × 70 px each, one colour each) and their asset ids. */
const IMG = { red: I.png(50, 70, [220, 40, 40]), green: I.png(50, 70, [40, 160, 60]), back: I.png(50, 70, [40, 60, 200]) };
const H = Object.fromEntries(Object.entries(IMG).map(([k, b]) => [k, I.sha256(b)]));
/** An image deck as an upload carries it (data URLs, the v1 transport shape).
 *  Dealt from the top: Red (imgs[0]), Green (imgs[1]), Copy (its own img:
 *  Red's bytes again), Plain (no image). Its back is an image. */
const PICS = {
  name: 'Pics', back: I.dataURL(IMG.back), imgs: [I.dataURL(IMG.red), I.dataURL(IMG.green)],
  cards: [{ n: 'Plain' }, { img: I.dataURL(IMG.red), n: 'Copy' }, { g: 1, n: 'Green' }, { g: 0, n: 'Red' }],
};
/** A rules script whose state lives in both t.data (host-private) and t.public: it counts moves. */
const KEEPER = '({ name: "Keeper", setup(t) { t.data.moves ??= 0; t.public.moves ??= 0; }, onAction(t, a) { if (a.t === "move") t.public.moves = ++t.data.moves; } })';

// --- init scripts (they run in the page, before the app) ------------------------
/** Every toast the page shows, in order: window.__toasts (each text #toast is given). */
function toastLog() {
  window.__toasts = [];
  const d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', {
    ...d,
    set(v) { if (this.id === 'toast') window.__toasts.push(String(v)); d.set.call(this, v); },
  });
}
/** Every IndexedDB put, in order: window.__puts = [{store, tx (one number per transaction), id, room, ts, lost}]. */
function putLog() {
  const put = IDBObjectStore.prototype.put, txs = new WeakMap();
  let n = 0;
  window.__puts = [];
  IDBObjectStore.prototype.put = function (v, ...rest) {
    if (!txs.has(this.transaction)) txs.set(this.transaction, ++n);
    window.__puts.push({ store: this.name, tx: txs.get(this.transaction), id: v?.id, room: v?.room, ts: v?.ts, lost: v?.lost });
    return put.call(this, v, ...rest);
  };
}
/** Storage is full (h.quotaStub, added before this) for one page load, when the
 *  test asks for it: sessionStorage.__fullOnce = the JSON of window.__quota. */
function fullOnce() {
  const q = sessionStorage.getItem('__fullOnce');
  if (q) { sessionStorage.removeItem('__fullOnce'); window.__quota = JSON.parse(q); }
}
/** Counts navigator.storage.persist() calls: window.__persist. */
function persistLog() {
  window.__persist = 0;
  const sm = navigator.storage, f = sm?.persist;
  if (f) sm.persist = (...a) => { window.__persist++; return f.apply(sm, a); };
}
/** indexedDB.open always fails (fires `error`), as in a browser that blocks storage. */
function noIDB() {
  IDBFactory.prototype.open = function () {
    const req = new EventTarget(), error = new DOMException('blocked by the test', 'UnknownError');
    Object.assign(req, { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null });
    Object.defineProperty(req, 'error', { get: () => error });
    Object.defineProperty(req, 'result', { get() { throw new DOMException('the request failed', 'InvalidStateError'); } });
    setTimeout(() => { const e = new Event('error'); req.dispatchEvent(e); req.onerror?.call(req, e); });
    return req;
  };
}

// --- helpers ----------------------------------------------------------------------
/** A page whose every load runs `inits` (functions, or [fn, arg]) after the toast log. */
async function newPage(env, name, ...inits) {
  const p = await env.page(name);
  for (const f of [toastLog, ...inits]) await p.addInitScript(...[].concat(f));
  return p;
}
/** Opens the app at `url` on page p as player `name`, seated and showing the table. */
async function open(p, url, name) {
  await p.goto(url);
  await h.joinAs(p, name);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
  return p;
}
/** Goes back to the invite (the room's save is read at boot), and waits for the table. */
async function back(p, invite) {
  await p.goto(invite);
  await p.waitForSelector('.item.pile .count', { timeout: 30000 });
}
const roomOf = (p) => p.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
const isHost = (p) => p.evaluate(() => !document.getElementById('size-sel').classList.contains('hidden'));
const toasts = (p) => p.evaluate(() => window.__toasts);
/** How many toasts page p has shown that match re. */
const shown = async (p, re) => (await toasts(p)).filter((t) => re.test(t)).length;
/** Resolves true once page p has shown a toast matching re. */
const toasted = (p, re, ms = 15000) => L.until(async () => (await shown(p, re)) > 0, ms, 150);
/** Waits until the host's save in IndexedDB holds the table it shows (saves are throttled to one a second). */
async function settled(p, ms = 15000) {
  const room = await roomOf(p);
  return L.until(async () => (await h.idb(p, 'saves', room))?.state?.seq === await p.evaluate(() => window.__ct.view().seq), ms, 200);
}
/** Whether two pages show the same public table: items, players and log. */
/** How many times a log says the host resumed the table (once per boot that resumed a save). */
const resumes = (log) => log.filter((e) => e.txt === 'resumed the table').length;
const sameTable = async (x, y) => { const [a, b] = [await L.view(x), await L.view(y)]; return ['items', 'players', 'log'].every((k) => L.same(a[k], b[k])); };
const pileNamed = (p, name) => p.evaluate((n) => { const v = window.__ct.view(); return Object.keys(v.items).find((id) => v.items[id].k === 'p' && v.items[id].name === n) || null; }, name);
/** Waits for page p to show a pile named `name`; resolves its id. */
async function waitPile(p, name) {
  let id = null;
  await L.until(async () => (id = await pileNamed(p, name)), 15000, 100);
  return id;
}
/** The decoded images page p draws as card faces (in `sel`: the table's
 *  items or the hand's .hcard), as 'w×h' each; and its image backs. */
const faces = (p, sel = '.item') => p.$$eval(`${sel} img.face[src^="blob:"]`, (els) => els.filter((e) => e.complete && e.naturalWidth).map((e) => `${e.naturalWidth}×${e.naturalHeight}`));
const backs = (p) => p.$$eval('.item img.back[src^="blob:"]', (els) => els.filter((e) => e.complete && e.naturalWidth).length);
/** The legacy (pre-Phase 1) save keys in page p's localStorage, sorted. */
const legacyKeys = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => /^ct-(save|decks)-/.test(k)).sort());
/** Deletes this origin's whole database (on a page with no app on it). */
const dropDB = (p) => p.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.deleteDatabase('cardtable');
  r.onsuccess = res;
  r.onerror = () => rej(r.error);
  r.onblocked = () => console.warn('deleting the database waits for another connection');
}));
const hasDB = (p) => p.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'cardtable'));
/** Plants image records in IndexedDB as the app stores them ({h, mime, size, data, used}), with `used` chosen by the test. */
const plantAssets = (p, list) => h.withStore(p, async (S, list) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('cardtable'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const t = db.transaction('assets', 'readwrite');
  for (const a of list) t.objectStore('assets').put({ h: a.h, mime: 'image/png', size: a.bytes.length, data: new Uint8Array(a.bytes).buffer, used: a.used });
  await new Promise((res, rej) => { t.oncomplete = res; t.onabort = () => rej(t.error); });
  db.close();
}, list.map((a) => ({ ...a, bytes: [...a.bytes] })));
/** A tiny v2 table state (another room's save), padded to about `pad` chars. */
const tinyState = (pad = 0) => ({ v: STATE_V, seq: 1, size: 1300, items: {}, players: {}, keys: {}, log: [], guestDeckChars: 0, zMax: 0, pad: 'x'.repeat(pad) });
/** A one-card v2 deck showing image h. */
const deckOf = (h) => ({ name: 'Other', back: null, imgs: [h], cards: [{ g: 0 }] });
/** Asserts a check that waits: ok(await …) with the message. */
const okWait = async (promise, msg) => ok(await promise.then((x) => x !== false, () => false), msg);

(async () => {
  const env = await h.start();

  // ---------------------------------------------------------------------------------
  section('(1) the host saves in IndexedDB, and a reload resumes the table');
  const alice = await open(await newPage(env, 'Alice', putLog, h.quotaStub, fullOnce), env.url, 'Alice');
  const bob = await open(await newPage(env, 'Bob'), alice.url(), 'Bob');
  await alice.waitForFunction(() => document.querySelectorAll('.seat').length >= 2, null, { timeout: 30000 });
  const room = await roomOf(alice), invite = alice.url(), alicePid = await L.pidOf(alice), bobPid = await L.pidOf(bob);
  const bobKey = await bob.evaluate(() => localStorage.getItem('ct-pid-key'));
  ok((await L.act(alice, { t: 'addDeck', deck: PICS, x: 260, y: 820 }))?.ok, 'the host adds an image deck (data URLs, as an upload carries them)');
  const pics = await waitPile(alice, 'Pics');
  await L.act(alice, { t: 'setRules', code: KEEPER, enabled: true });
  await L.act(alice, { t: 'deal', id: pics, x: 480, y: 470, up: true }); // Red
  await L.act(alice, { t: 'deal', id: pics, x: 620, y: 470, up: true }); // Green
  await L.act(bob, { t: 'draw', id: pics }); // Copy, into Bob's hand
  const std = await pileNamed(alice, 'Standard');
  for (let k = 0; k < 3; k++) await L.act(alice, { t: 'move', id: std, x: 700 + 40 * k, y: 760 });
  await L.act(bob, { t: 'chat', msg: 'is this saved?' });
  await okWait(L.until(async () => {
    const v = await L.view(alice);
    return v.rules?.public?.moves === 3 && v.players[bobPid]?.handCount === 1 && v.log.some((e) => e.txt === 'is this saved?');
  }), 'the table plays: rules count 3 moves, Bob holds a card, his chat is in the log');
  await okWait(L.until(async () => (await faces(alice)).length === 2 && (await backs(alice)) === 1), 'the dealt image cards and the image back are drawn');
  ok(await settled(alice), 'the save catches up with the table');
  const rec = await h.idb(alice, 'saves', room);
  const view1 = await L.view(alice);
  ok(L.same(Object.keys(rec).sort(), ['room', 'state', 'ts', 'v']) && rec.room === room && Number.isFinite(rec.ts) && rec.v === STATE_V && rec.state.v === STATE_V,
    `the room's record is {room, ts, v: ${STATE_V}, state} (${JSON.stringify(Object.keys(rec))}, v ${rec.v})`);
  ok(typeof rec.state === 'object' && !('decks' in rec.state) && Object.keys(rec.state.items).length === Object.keys(view1.items).length,
    'the state is stored as an object (a structured clone), with every item and no decks');
  ok(rec.state.rules?.name === 'Keeper' && rec.state.rules.enabled && rec.state.rules.data?.moves === 3 && rec.state.rules.public?.moves === 3,
    `the rules are saved with their private and public state (${JSON.stringify({ data: rec.state.rules?.data, public: rec.state.rules?.public })})`);
  ok(rec.state.keys?.[bobPid] === bobKey && !Object.values(rec.state.players).some((pl) => 'key' in pl), "seat keys are saved in state.keys, not in players");
  const cat = (await h.idb(alice, 'catalog')).filter((r) => r.room === room);
  const picsRec = cat.find((r) => r.deck?.name === 'Pics'), picsId = picsRec?.id;
  const deckIds = [...new Set(Object.values(rec.state.items).flatMap((it) => (it.k === 'p' ? it.cards.map((c) => c.d) : [it.d])))].sort();
  ok(L.same(cat.map((r) => r.id).sort(), deckIds) && cat.every((r) => r.kind === 'deck' && r.room === room),
    `the room's catalog holds its ${deckIds.length} decks as {room, id, kind: 'deck', deck}`);
  const notV2 = (recs) => recs.map((r) => [r.deck?.name, L.diff(r.deck, cleanDeck(structuredClone(r.deck)))]).filter(([, d]) => d);
  ok(!notV2(cat).length, `each in the v2 deck shape, as cleanDeck returns it (${JSON.stringify(notV2(cat)) || 'all'})`);
  const pd = picsRec?.deck, img = (k) => pd?.imgs[pd.cards[k].g];
  ok(!!pd && pd.backImg === H.back && img(3) === H.red && img(2) === H.green && img(1) === H.red && pd.cards[1].g === pd.cards[3].g && !JSON.stringify(pd).includes('data:'),
    'the image deck names its images by the SHA-256 of their bytes (the copy shares Red\'s), its back too, with no data URL left');
  const assets = await h.idb(alice, 'assets');
  ok(['red', 'green', 'back'].every((k) => assets.some((a) => a.h === H[k] && a.mime === 'image/png' && a.size === IMG[k].length && a.used > Date.now() - 600e3)),
    `the images are stored as assets {h, mime, size, used} (${assets.length} held)`);
  const puts = await alice.evaluate(() => window.__puts);
  const catPuts = puts.filter((x) => x.store === 'catalog' && x.room === room);
  ok(deckIds.every((id) => catPuts.filter((x) => x.id === id).length === 1) && puts.filter((x) => x.store === 'saves').length >= 2,
    `each deck is written to the catalog once, however often the state is saved (${catPuts.length} catalog writes, ${puts.filter((x) => x.store === 'saves').length} saves)`);
  const picsPut = catPuts.find((x) => x.id === picsId);
  ok(!!picsPut && puts.some((x) => x.store === 'saves' && x.room === room && x.tx === picsPut.tx), 'the new deck is written in the same transaction as a save of the state');
  ok(!(await legacyKeys(alice)).length, 'nothing is written to localStorage ct-save-* or ct-decks-*');

  const truth = L.truthOf(rec, alicePid);
  await alice.reload();
  await alice.waitForSelector('.item.pile .count', { timeout: 30000 });
  await okWait(L.until(async () => resumes((await L.view(alice)).log) > resumes(truth.log)), 'after a reload the host resumes the table');
  const view2 = await L.view(alice);
  ok(await isHost(alice) && L.same(view2.items, truth.items), `every item is where it was (${L.diff(view2.items, truth.items) || 'same'})`);
  ok(L.same(view2.log.slice(0, truth.log.length), truth.log), `the log is kept (${truth.log.length} entries, then ${view2.log.length - truth.log.length} new)`);
  ok(view2.rules?.name === 'Keeper' && view2.rules.enabled && view2.rules.public?.moves === 3, `the rules are back, enabled, with their public state (${JSON.stringify(view2.rules)})`);
  await L.act(alice, { t: 'move', id: std, x: 700, y: 800 });
  await okWait(L.until(async () => (await L.view(alice)).rules?.public?.moves === 4), 'and their private state: the next move counts 4');
  await okWait(L.until(async () => L.same(await faces(alice), ['50×70', '50×70']) && (await backs(alice)) === 1), "the host draws the deck's faces and back from its own storage");
  await okWait(L.until(async () => (await L.view(alice)).players[bobPid]?.online && L.same(await bob.evaluate(() => window.__ct.hand()), truth.hands[bobPid])
    && L.same(await faces(bob, '.hcard'), ['50×70']), 20000), 'Bob reconnects with his hand, its image card drawn');
  ok(!(await shown(alice, /Couldn't resume|wasn't saved|missing from this browser|Can't save/)), `and nothing is said to be lost (${JSON.stringify(await toasts(alice))})`);

  // ---------------------------------------------------------------------------------
  section('(2) a pre-Phase 1 save (localStorage) is migrated');
  ok(await settled(alice), 'the save has caught up');
  await alice.goto(h.plain(env)); // no app here: it would save over what the test plants
  const rec2 = await h.idb(alice, 'saves', room);
  const cat2 = (await h.idb(alice, 'catalog')).filter((r) => r.room === room);
  const stdRec = cat2.find((r) => r.id !== picsId);
  // The legacy shape: {ts, state} with each seat key inside its player, no keys/zMax/v; decks apart, images as data URLs.
  const legacy = structuredClone(rec2.state);
  for (const [p, k] of Object.entries(legacy.keys)) legacy.players[p].key = k;
  delete legacy.keys; delete legacy.zMax; delete legacy.v;
  const legacySave = JSON.stringify({ ts: Date.now(), state: legacy }), legacyDecks = JSON.stringify({ [stdRec.id]: stdRec.deck, [picsId]: PICS });
  const plantLegacy = (save, decks) => alice.evaluate(([room, save, decks]) => {
    localStorage.setItem(`ct-save-${room}`, save);
    if (decks) localStorage.setItem(`ct-decks-${room}`, decks); else localStorage.removeItem(`ct-decks-${room}`);
  }, [room, save, decks]);
  const legacyNow = () => alice.evaluate((room) => [localStorage.getItem(`ct-save-${room}`), localStorage.getItem(`ct-decks-${room}`)], room);
  const truth2 = L.truthOf(rec2, alicePid);
  ok(!!(await alice.evaluate((room) => localStorage.getItem(`ct-hostkey-${room}`), room)), 'this browser holds the room\'s host key');

  // (a) the new storage refuses the migrated save: the legacy keys stay, the table resumes from memory
  await dropDB(alice);
  await plantLegacy(legacySave, legacyDecks);
  await alice.evaluate(() => sessionStorage.setItem('__fullOnce', JSON.stringify('saves')));
  await back(alice, invite);
  const moveFailed = await toasted(alice, /^Couldn't move this table's save to the new storage: .+/);
  ok(moveFailed, `when the save can't be written, the host is told ("${(await toasts(alice)).find((t) => /Couldn't move/.test(t))}")`);
  ok(L.same(await legacyNow(), [legacySave, legacyDecks]), 'the legacy keys stay as they were');
  await okWait(L.until(async () => (await isHost(alice)) && L.same((await L.view(alice)).items, truth2.items) && (await faces(alice)).length === 2),
    'the host resumes the migrated table from memory, its images included');

  // (b) the migration goes through
  await alice.goto(h.plain(env));
  await dropDB(alice); // the refused run left a lost marker behind: start from the legacy keys alone
  ok(L.same(await legacyNow(), [legacySave, legacyDecks]), 'only the legacy save is left (an empty database)');
  await back(alice, invite);
  await okWait(L.until(async () => resumes((await L.view(alice)).log) > resumes(truth2.log)), 'the host resumes the legacy save');
  ok(!(await legacyKeys(alice)).length, 'the legacy keys are gone once it is stored');
  ok(!(await shown(alice, /Couldn't resume|Couldn't move|was dropped/)), `with no failure (${JSON.stringify(await toasts(alice))})`);
  const v3 = await L.view(alice);
  ok(await isHost(alice) && L.same(v3.items, truth2.items), `every item is back (${L.diff(v3.items, truth2.items) || 'same'})`);
  ok(L.same(v3.log.slice(0, truth2.log.length), truth2.log) && v3.rules?.name === 'Keeper' && v3.rules.enabled && v3.rules.public?.moves === 4,
    'with its log and its rules');
  await okWait(L.until(async () => L.same(await faces(alice), ['50×70', '50×70']) && (await backs(alice)) === 1), 'its image faces and back are drawn (blob: URLs)');
  ok(await settled(alice), 'the migrated table is saved');
  const rec3 = await h.idb(alice, 'saves', room);
  const z = Math.max(0, ...Object.values(rec3.state.items).map((it) => it.z));
  ok(rec3.v === STATE_V && rec3.state.v === STATE_V && rec3.state.zMax === z && L.same(rec3.state.keys, rec2.state.keys)
    && !Object.values(rec3.state.players).some((pl) => 'key' in pl), `stored as v${STATE_V}: the seat keys moved to state.keys, zMax ${rec3.state.zMax} = the top z`);
  const cat3 = (await h.idb(alice, 'catalog')).filter((r) => r.room === room), pd3 = cat3.find((r) => r.id === picsId)?.deck;
  const img3 = (k) => pd3?.imgs[pd3.cards[k].g];
  ok(L.same(cat3.find((r) => r.id === stdRec.id)?.deck, cleanDeck(structuredClone(stdRec.deck))) && !!pd3 && cat3.length === 2 && !notV2(cat3).length,
    `both decks are in the catalog, as v2 decks (${JSON.stringify(notV2(cat3)) || 'both'})`);
  ok(pd3 && pd3.backImg === H.back && pd3.back === null && img3(3) === H.red && img3(2) === H.green && img3(1) === H.red
    && pd3.imgs.filter(Boolean).length === 2 && !('img' in pd3.cards[1]) && !JSON.stringify(pd3).includes('data:'),
    `the image deck is ingested: images by hash, the copy's own img into imgs + g (one entry for the same bytes), the back into backImg (${JSON.stringify(pd3)})`);
  const assets3 = await h.idb(alice, 'assets');
  ok(['red', 'green', 'back'].every((k) => assets3.some((a) => a.h === H[k] && a.size === IMG[k].length)), 'its images are in the asset store');
  await okWait(L.until(async () => (await L.view(alice)).players[bobPid]?.online && L.same(await bob.evaluate(() => window.__ct.hand()), truth2.hands[bobPid]), 20000),
    'Bob, a seat of the legacy save, comes back with his hand');
  await L.act(bob, { t: 'draw', id: std });
  await okWait(L.until(async () => (await L.view(alice)).players[bobPid]?.handCount === 2), 'and his seat key still holds: the host takes his draw');

  // (c) a legacy lost marker
  await alice.goto(h.plain(env));
  await dropDB(alice);
  const lostTs = Date.now() - 5000;
  await plantLegacy(JSON.stringify({ ts: lostTs, lost: 'the test lost it' }), null);
  await back(alice, invite);
  await okWait(toasted(alice, /^Couldn't resume this table \(the test lost it\)/), 'a legacy lost marker: the tab says it couldn\'t resume');
  ok(await isHost(alice) && (await alice.$$eval('.item', (els) => els.length)) === 1 && (await alice.textContent('.item.pile .count')) === '52', 'and hosts a fresh table');
  const lostPut = (await alice.evaluate(() => window.__puts)).find((x) => x.store === 'saves' && x.room === room && x.lost === 'the test lost it');
  ok(!!lostPut && lostPut.ts === lostTs, `the marker was migrated as a {room, ts, lost} record (${JSON.stringify(lostPut)})`);
  ok(!(await legacyKeys(alice)).length, 'and its legacy key is gone');
  await okWait(L.until(() => sameTable(bob, alice), 20000), 'Bob follows the fresh table');

  // ---------------------------------------------------------------------------------
  section('(3) full storage');
  const carol = await newPage(env, 'Carol', h.quotaStub, fullOnce);
  await carol.goto(h.plain(env));
  const [X, Z] = [I.png(9, 9, [1, 2, 3]), I.png(9, 9, [4, 5, 6])], [hX, hZ] = [I.sha256(X), I.sha256(Z)];
  await h.plantSave(carol, '0ld0', tinyState(60000), { d0: deckOf(hX) }, Date.now() - 2 * DAY);
  await h.plantSave(carol, '1ive', tinyState(), { d0: deckOf(hZ) }, Date.now()); // another tab hosts this one right now
  await plantAssets(carol, [{ h: hX, bytes: X, used: Date.now() - 2 * DAY }, { h: hZ, bytes: Z, used: Date.now() - 2 * DAY }]);
  await carol.evaluate(() => sessionStorage.setItem('__fullOnce', JSON.stringify({ store: 'saves', heal: 1 }))); // full until one save is deleted
  await open(carol, env.url, 'Carol');
  const carolRoom = await roomOf(carol);
  await okWait(toasted(carol, /^Browser storage was full — deleted 1 old table save(\(s\)|s)? to keep this one$/), 'a new table makes room by deleting an old save, and says so');
  const rooms = new Set((await h.idb(carol, 'saves')).map((r) => r.room)), cats = new Set((await h.idb(carol, 'catalog')).map((r) => r.room));
  ok(!rooms.has('0ld0') && !cats.has('0ld0'), 'the old room\'s save and its catalog are gone');
  ok(rooms.has('1ive') && cats.has('1ive'), 'a save written moments ago (another tab is hosting it) is spared');
  ok(!!(await h.idb(carol, 'saves', carolRoom))?.state && await isHost(carol), 'the new table is saved, and the tab hosts it');
  const held = new Set((await h.idb(carol, 'assets')).map((a) => a.h));
  ok(!held.has(hX) && held.has(hZ), 'the pruned room\'s image goes too (no catalog shows it), the spared room\'s stays');

  const dave = await newPage(env, 'Dave', putLog, h.quotaStub);
  await dave.goto(h.plain(env));
  await h.plantSave(dave, '5mall', tinyState(), {}, Date.now() - 2 * DAY); // old, but too small to make room for this table
  await open(dave, env.url, 'Dave');
  const daveRoom = await roomOf(dave);
  ok(await settled(dave), 'a new table is saved');
  await dave.evaluate(() => { window.__quota = 'saves'; });
  const daveStd = await pileNamed(dave, 'Standard'), lostPuts = () => dave.evaluate(() => window.__puts.filter((x) => x.store === 'saves' && x.lost).length);
  for (let k = 0; k < 3; k++) { // three saves (each failure writes a lost marker, which a full browser still takes here)
    const n = await lostPuts();
    await L.act(dave, { t: 'draw', id: daveStd });
    await L.until(async () => (await lostPuts()) > n);
  }
  const FULL = /^Can't save this table \(browser storage is full\) — reloading the host tab would reset it$/;
  ok(await lostPuts() >= 3 && await shown(dave, FULL) === 1, `when storage is full and nothing can be pruned, the host is told once (${await shown(dave, FULL)} toasts for ${await lostPuts()} failed saves)`);
  const lostRec = await h.idb(dave, 'saves', daveRoom);
  ok(L.same(Object.keys(lostRec || {}).sort(), ['lost', 'room', 'ts']) && lostRec.lost === 'browser storage is full', `the save is replaced by a lost marker (${JSON.stringify(lostRec)})`);
  ok(!!(await h.idb(dave, 'saves', '5mall'))?.state, 'an old save too small to make room is not deleted for nothing');
  await dave.reload(); // (the stub lifts: window.__quota is gone)
  await dave.waitForSelector('.item.pile .count', { timeout: 30000 });
  await okWait(toasted(dave, /^Couldn't resume this table.*browser storage is full/), 'a reload resets the table loudly');
  ok(await isHost(dave) && (await dave.textContent('.item.pile .count')) === '52' && (await h.handCount(dave)) === 0, 'the tab hosts a fresh table');

  ok((await L.act(alice, { t: 'addDeck', deck: PICS, x: 260, y: 820 }))?.ok, 'the host adds the image deck again');
  const pics4 = await waitPile(alice, 'Pics');
  await L.act(alice, { t: 'deal', id: pics4, x: 480, y: 470, up: true });
  await L.act(alice, { t: 'deal', id: pics4, x: 620, y: 470, up: true });
  const erin = await open(await newPage(env, 'Erin', h.quotaStub, () => { window.__quota = 'assets'; }), alice.url(), 'Erin');
  await okWait(L.until(async () => L.same(await faces(erin), ['50×70', '50×70']) && (await backs(erin)) === 1, 20000), 'a guest whose storage is full still draws the images');
  const CACHE = /^Couldn't cache card images on this device \(storage full\) — they'll download again next time$/;
  ok(await shown(erin, CACHE) === 1, `and says once that it couldn't cache them (${JSON.stringify(await toasts(erin))})`);
  ok(!(await h.idb(erin, 'assets')).some((a) => Object.values(H).includes(a.h)), 'none of them is in its storage');

  // ---------------------------------------------------------------------------------
  section('(4) IndexedDB refuses to open');
  const BLOCKED = /^This browser blocks storage \(IndexedDB: .+\) — the table can't be saved; reloading the host tab will reset it$/;
  const fay = await open(await newPage(env, 'Fay', noIDB), env.url, 'Fay');
  const blocked = await toasted(fay, BLOCKED);
  ok(blocked, `the host is told ("${(await toasts(fay))[0]}")`);
  const gus = await open(await newPage(env, 'Gus'), fay.url(), 'Gus');
  const fayRoom = await roomOf(fay), fayInvite = fay.url(), gusPid = await L.pidOf(gus), fayStd = await pileNamed(fay, 'Standard');
  await L.act(gus, { t: 'draw', id: fayStd });
  for (let k = 0; k < 3; k++) { await L.act(fay, { t: 'move', id: fayStd, x: 600 + 30 * k, y: 700 }); await h.sleep(800); }
  await okWait(L.until(async () => (await h.handCount(gus)) === 1 && sameTable(gus, fay)), 'the table plays: the guest draws, the host moves, both screens agree');
  ok(await shown(fay, BLOCKED) === 1 && !(await toasts(fay)).some((t) => !BLOCKED.test(t) && /sav|stor/i.test(t)), `the save is skipped quietly after that one warning (${JSON.stringify(await toasts(fay))})`);
  ok(!(await legacyKeys(fay)).length && !(await hasDB(fay)), 'with no fallback: nothing in localStorage, no database');
  await fay.reload();
  await fay.waitForSelector('.item.pile .count', { timeout: 30000 });
  ok(await isHost(fay) && (await roomOf(fay)) === fayRoom && fay.url() === fayInvite, 'after a reload (storage still blocked) the tab still hosts its room: it holds the host key');
  await okWait(toasted(fay, BLOCKED), 'and says again that it can\'t save');
  await okWait(L.until(async () => (await L.view(fay)).players[gusPid]?.online && (await h.handCount(gus)) === 0 && sameTable(gus, fay), 30000),
    'the guest reconnects to it, and shows its (fresh) table');

  // ---------------------------------------------------------------------------------
  section('(5) the pending-save marker');
  const hal = await open(await newPage(env, 'Hal'), env.url, 'Hal');
  const halRoom = await roomOf(hal), halInvite = hal.url(), halStd = await pileNamed(hal, 'Standard');
  const PENDING = /^The last moment of play before the reload wasn't saved \(the browser closed first\)$/;
  const marker = () => hal.evaluate((r) => localStorage.getItem(`ct-pending-${r}`), halRoom);
  for (const ahead of [0, 3]) {
    await L.act(hal, { t: 'move', id: halStd, x: 600, y: 600 + ahead }); // (a resume right after a resume logs nothing new)
    ok(await settled(hal), 'the save has caught up');
    await hal.goto(h.plain(env));
    const srec = await h.idb(hal, 'saves', halRoom), seq = srec.state.seq;
    await hal.evaluate(([r, s]) => localStorage.setItem(`ct-pending-${r}`, String(s)), [halRoom, seq + ahead]);
    await back(hal, halInvite);
    await okWait(L.until(async () => resumes((await L.view(hal)).log) > resumes(srec.state.log)), `the host resumes (a marker of seq ${seq + ahead}, the save at ${seq})`);
    if (ahead) await okWait(toasted(hal, PENDING), 'a marker ahead of the save: the host is warned');
    else { await h.sleep(1000); ok(!(await shown(hal, PENDING)), 'a marker the save caught up with: no warning'); }
    ok(await marker() === null, 'and the marker is gone');
  }
  for (let k = 0; k < 3; k++) { // a move, another inside the save throttle, and a reload at once
    await L.act(hal, { t: 'move', id: halStd, x: 560 + 20 * k, y: 640 });
    const to = { x: 580 + 20 * k, y: 660 };
    await L.act(hal, { t: 'move', id: halStd, ...to });
    await hal.reload();
    await hal.waitForSelector('.item.pile .count', { timeout: 30000 }); // (drawn once the host took its save: its warning is said by then)
    const it = (await L.view(hal)).items[halStd], kept = it?.x === to.x && it?.y === to.y, warned = await shown(hal, PENDING) > 0;
    ok(kept || warned, `a reload right after a move: the move is ${kept ? 'kept' : 'lost'}${warned ? ', and the host is warned' : ''}`);
  }

  // ---------------------------------------------------------------------------------
  section('(6) a save from a newer Card Table');
  const zed = await open(await newPage(env, 'Zed'), env.url, 'Zed');
  const errors = [];
  zed.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const yan = await open(await newPage(env, 'Yan'), zed.url(), 'Yan');
  const zedRoom = await roomOf(zed), zedInvite = zed.url();
  ok(await settled(zed), 'the save has caught up');
  await zed.goto(h.plain(env));
  const zrec = await h.idb(zed, 'saves', zedRoom);
  await h.plantSave(zed, zedRoom, { ...zrec.state, v: STATE_V + 1 });
  const planted = JSON.stringify(await h.idb(zed, 'saves', zedRoom));
  const zcat = async () => JSON.stringify((await h.idb(zed, 'catalog')).filter((r) => r.room === zedRoom));
  const plantedCat = await zcat();
  const NEWER = 'This table was saved by a newer Card Table — reload this page';
  const e0 = errors.length;
  await back(zed, zedInvite);
  await okWait(toasted(zed, new RegExp(`^${NEWER}$`)), 'the tab says the save is from a newer Card Table');
  ok(errors.length > e0, `and logs it (console.error: ${JSON.stringify(errors.slice(e0, e0 + 2))})`);
  ok(await isHost(zed), 'it still hosts the room');
  const zstd = await pileNamed(zed, 'Standard');
  const t0 = Date.now();
  for (let k = 0; Date.now() - t0 < 5500; k++) { // 5 s of play, a new deck included
    await L.act(zed, { t: 'move', id: zstd, x: 560 + 15 * (k % 6), y: 620 });
    await L.act(yan, { t: 'draw', id: zstd });
    if (k === 2) await L.act(zed, { t: 'addDeck', deck: { name: 'Words', back: null, imgs: [], cards: [{ n: 'one' }, { n: 'two' }] }, x: 400, y: 400 });
    await h.sleep(700);
  }
  await okWait(L.until(() => sameTable(yan, zed), 15000), 'the guest plays along');
  await okWait(zed.waitForFunction((t) => { const el = document.getElementById('toast'); return !el.classList.contains('hidden') && el.textContent === t; }, NEWER, { timeout: 8000 }),
    'after 5 s of play the toast is still up');
  ok(!(await shown(zed, /Can't save/)), 'no save is attempted (nothing to warn about)');
  await zed.goto(h.plain(env)); // pagehide
  ok(JSON.stringify(await h.idb(zed, 'saves', zedRoom)) === planted, 'the newer save is left byte for byte');
  ok(await zcat() === plantedCat, 'and so is its catalog');

  // ---------------------------------------------------------------------------------
  section('(7) a module of another version');
  for (const file of ['core.js', 'store.js', 'templates.js']) {
    const p = await env.page(`Skew ${file}`);
    await p.route(`**/cardtable/${file}?v=*`, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace('export const MODULE_V = ', 'export const MODULE_V = 1000 + ') });
    });
    await p.goto(env.url);
    const text = await p.waitForSelector('#skew-banner', { timeout: 15000 }).then((el) => el.textContent(), () => '(no banner)');
    ok(text === 'Card Table was updated while this page loaded — reload this page', `a ${file} of another MODULE_V: the page shows "${text}"`);
    await h.sleep(1000);
    ok(!(await p.isVisible('#name-dialog[open]')) && !/#room~/.test(p.url()) && !(await p.$$eval('.item', (els) => els.length)) && !(await hasDB(p)),
      'and does not start: no name dialog, no room, no table, no storage');
    await p.close();
  }

  // ---------------------------------------------------------------------------------
  section('(8) upkeep: the image cache, persistent storage, an upgrade in another tab');
  const ivy = await newPage(env, 'Ivy', persistLog);
  await ivy.goto(h.plain(env));
  const old = { unused: I.png(8, 8, [9, 9, 9]), recent: I.png(8, 8, [8, 8, 8]), shown: I.png(8, 8, [7, 7, 7]) };
  const oh = Object.fromEntries(Object.entries(old).map(([k, b]) => [k, I.sha256(b)]));
  await h.plantSave(ivy, '0th3r', tinyState(), { d0: deckOf(oh.shown) }, Date.now() - 20 * DAY);
  await plantAssets(ivy, [
    { h: oh.unused, bytes: old.unused, used: Date.now() - 20 * DAY }, // no catalog shows it, unused for 20 days
    { h: oh.recent, bytes: old.recent, used: Date.now() - 2 * DAY }, // no catalog shows it, used 2 days ago
    { h: oh.shown, bytes: old.shown, used: Date.now() - 20 * DAY }, // another room's catalog shows it
  ]);
  await open(ivy, env.url, 'Ivy');
  const gone = await L.until(async () => !(await h.idb(ivy, 'assets')).some((a) => a.h === oh.unused), 40000, 500);
  ok(gone, 'an image no catalog shows, unused for 20 days, is deleted after boot');
  const left = new Set((await h.idb(ivy, 'assets')).map((a) => a.h));
  ok(left.has(oh.recent) && left.has(oh.shown), 'one used 2 days ago, and one another room\'s catalog shows, are kept');
  ok(await ivy.evaluate(() => window.__persist) === 0, 'persistent storage is not asked for at boot');
  for (const name of ['Snaps', 'Snaps 2']) { // the deck dialog: an upload by hand
    await ivy.click('#add-deck-btn');
    await ivy.waitForSelector('#deck-dialog[open]');
    await ivy.check('input[name="deck-kind"][value="img"]');
    await ivy.fill('#deck-name', name);
    await ivy.setInputFiles('#deck-files', [{ name: 'red.png', mimeType: 'image/png', buffer: IMG.red }, { name: 'green.png', mimeType: 'image/png', buffer: IMG.green }]);
    await ivy.click('#deck-add');
    await h.logHas(ivy, `added deck "${name}"`);
  }
  ok(await ivy.evaluate(() => window.__persist) === 1, `it is asked for once, from the host's first upload (${await ivy.evaluate(() => window.__persist)} calls after two)`);
  const tab = await ivy.context().newPage(); // another tab of this browser, where a newer Card Table upgrades the database
  await tab.goto(h.plain(env));
  const upgrade = await tab.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('cardtable', 2);
    r.onsuccess = () => { r.result.close(); res('upgraded'); };
    r.onerror = () => res(`failed: ${r.error}`);
    setTimeout(() => res('still blocked after 10 s'), 10000);
  }));
  ok(upgrade === 'upgraded', `an upgrade in another tab is not blocked by this one (${upgrade})`);
  await okWait(toasted(ivy, /^Card Table was updated in another tab — reload this tab to keep saving$/), 'and this tab says so');

  await env.done();
})().catch(h.crash);
