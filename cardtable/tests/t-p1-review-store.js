// E2E: the storage regressions the Phase 1B review found (spec §1h), one
// section each:
//   (1) migrate   a legacy save whose images can't be stored (the asset store
//                 is full): its keys stay, the host is told, and plays from
//                 memory; its saves fail too (a lost marker), and a reload with
//                 storage still full resumes the legacy table, loudly, its keys
//                 kept; once storage frees up, the next save stores the table
//                 with its images, a reload resumes it, and only then the keys go
//   (2) read      one failed read of the save at boot: the tab still hosts, says
//                 so (pinned), and never writes over the save — the next boot
//                 resumes it whole
//   (3) lost      a lost marker drops the room's catalog: a fresh table started
//                 after it holds only its own decks
//   (4) clone     a rules script leaves a function in t.data: the rules disable
//                 loudly, the save is never a lost marker, and the next save
//                 keeps t.data's JSON part
//   (5) gc first  full storage first evicts the image cache (it downloads
//                 again), and deletes another table's save only when that is
//                 not enough
//   (6) no BroadcastChannel (an old Safari): the app still boots, hosts and saves
//   (7) lost+old  a lost marker with a legacy save still in localStorage (its
//                 migration couldn't be written, nor any save since): a boot
//                 with room resumes the legacy table, loudly, and migrates it
//   (8) no table  a save record that holds no table: the fresh table that
//                 replaces it never inherits the old table's catalog
//   (9) old tab   a legacy save made AFTER the room's IndexedDB save (a tab of
//                 the previous Card Table played on after the move, D303): it
//                 is resumed, loudly, and replaces the IndexedDB save (its
//                 catalog too) — never kept aside, then deleted
//   (10) old lost a newer legacy save that holds no table (that tab's lost
//                 marker: its own save failed): the IndexedDB table is resumed,
//                 loudly, and kept — never replaced by the marker (D317)
//   (11) …pending the same, with a state left pending over that IndexedDB
//                 table, ahead of it: the state is resumed, as D308 says (D318)
//   (12) old+pending a newer legacy save, and a state left pending over the
//                 IndexedDB table it replaces: the legacy save is resumed, the
//                 mark dropped — even ahead by seq, it is another table's (D318)
//   (13) …seq alone as (11), with a pending seq alone: one toast says both
//                 that an older save was resumed and that the last moment of
//                 play was lost — never two, the second replacing the first (D319)
//   (14) no record a legacy save and no IndexedDB record (its migration, and
//                 every save since, failed): what a tab left pending over it
//                 applies — a seq alone is said, as the play since the move
//                 lost and the previous Card Table's save resumed (D320); a
//                 whole state is resumed (D319)
//   (15) …swept  the same, after another page's upkeep ran first: the mark is
//                 kept for that boot, not swept as "no table" (D320)
//   (16) still full the lineage of (14) and of (7) played out — boot 1's
//                 migration and saves fail, it plays on — with storage still
//                 full at boot 2: what boot 2 says, the move that failed, the
//                 table it resumed and its first save failing, is one toast,
//                 a line each, all of it on screen; the console says why a
//                 mark over the save IndexedDB lost goes (D320)
// A toast holds a line per notice while the boot's are up (app.js toast,
// D320): `onScreen` reads the one up as its lines; `toasts` is assets-lib's
// log, an entry per notice said — (1) and (16) check that a gathered boot's
// are each recorded once (D322).
'use strict';
const h = require('./h');
const L = require('./p1-lib');
const A = require('./assets-lib');
const { ok, section } = h;

const DAY = 864e5;
// --- init scripts ----------------------------------------------------------------------
/** Storage is full for one page load, when the test asks: sessionStorage.__fullOnce = the JSON of window.__quota (h.quotaStub). */
function fullOnce() {
  const q = sessionStorage.getItem('__fullOnce');
  if (q) { sessionStorage.removeItem('__fullOnce'); window.__quota = JSON.parse(q); }
}
/** The first get() on the `saves` store throws, once the test set sessionStorage.__failGet. */
function failGetOnce() {
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (...a) {
    if (this.name === 'saves' && sessionStorage.getItem('__failGet')) {
      sessionStorage.removeItem('__failGet');
      throw new DOMException('a transient read failure (test)', 'UnknownError');
    }
    return get.apply(this, a);
  };
}
/** While window.__fullSaves is set, `saves` refuses everything but a lost
 *  marker (QuotaExceededError) — until any image is deleted (GC made room). */
function fullUntilGC() {
  const { put, delete: del } = IDBObjectStore.prototype;
  window.__fullSaves = !!sessionStorage.getItem('__fullSaves');
  sessionStorage.removeItem('__fullSaves');
  IDBObjectStore.prototype.put = function (v, ...r) {
    if (window.__fullSaves && this.name === 'saves' && typeof v?.lost !== 'string') throw new DOMException('quota (test)', 'QuotaExceededError');
    return put.call(this, v, ...r);
  };
  IDBObjectStore.prototype.delete = function (...a) {
    if (this.name === 'assets') window.__fullSaves = false;
    return del.apply(this, a);
  };
}
/** While sessionStorage.__savesFull is set (it outlives reloads), `saves`
 *  refuses every put ('all': a lost marker too; 'data': all but a lost
 *  marker) with a QuotaExceededError. */
function savesFull() {
  const { put } = IDBObjectStore.prototype;
  IDBObjectStore.prototype.put = function (v, ...r) {
    const m = sessionStorage.getItem('__savesFull');
    if (m && this.name === 'saves' && (m === 'all' || typeof v?.lost !== 'string')) throw new DOMException('quota (test)', 'QuotaExceededError');
    return put.call(this, v, ...r);
  };
}

// --- helpers -------------------------------------------------------------------------------
const roomOf = (p) => p.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
const isHost = (p) => p.evaluate(() => !document.getElementById('size-sel').classList.contains('hidden'));
const toasts = A.toastsSince; // (an entry per toast() call: toastLog records the notice each one adds, D322)
/** The notices page p's toast shows now, a line each ([] when hidden). */
const onScreen = (p) => p.evaluate(() => { const el = document.getElementById('toast'); return el.classList.contains('hidden') ? [] : el.textContent.split('\n'); });
const toasted = (p, re, ms = 15000) => L.until(async () => (await toasts(p)).some((t) => (typeof re === 'string' ? t === re : re.test(t))), ms, 150);
/** Waits until the host's save holds the table it shows. */
async function settled(p, ms = 15000) {
  const room = await roomOf(p);
  return L.until(async () => (await h.idb(p, 'saves', room))?.state?.seq === await p.evaluate(() => window.__ct.view().seq), ms, 200);
}
const pileNamed = (p, name) => A.pileOf(p, name);
async function waitPile(p, name) { let id = null; await L.until(async () => (id = await pileNamed(p, name)), 15000, 100); return id; }
/** Faces page p draws from a decoded blob: image. */
const faces = (p) => p.$$eval('.item img.face[src^="blob:"]', (els) => els.filter((e) => e.complete && e.naturalWidth).length);
const legacyKeys = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => /^ct-(save|decks)-/.test(k)).sort());
const dropDB = (p) => p.evaluate(() => new Promise((res, rej) => { const r = indexedDB.deleteDatabase('cardtable'); r.onsuccess = res; r.onerror = () => rej(r.error); }));
/** Back to the invite: the app boots on the room's save. */
async function back(p, invite) { await p.goto(invite); await p.waitForSelector('.item.pile .count', { timeout: 30000 }); }
/** The room's catalog records. */
const catalogOf = async (p, room) => (await h.idb(p, 'catalog')).filter((r) => r.room === room);
/** Every image the room's catalog names that the asset store lacks. */
async function unbacked(p, room) {
  const held = new Set((await h.idb(p, 'assets')).map((a) => a.h));
  return (await catalogOf(p, room)).flatMap((r) => [...(r.deck.imgs || []), r.deck.backImg].filter((x) => x && !held.has(x)));
}
const okWait = async (promise, msg) => ok(await promise.then((x) => x !== false, () => false), msg);

const PICS = { name: 'Pics', back: null, imgs: [A.dataURL(A.png(50, 70, { rgb: [220, 40, 40] })), A.dataURL(A.png(50, 70, { rgb: [40, 160, 60] }))], cards: [{ g: 1, n: 'Green' }, { g: 0, n: 'Red' }] };
/** A host `name` with the image deck PICS and two of its cards dealt face
 *  up, saved: {p, room, invite}. */
async function picsTable(env, name, scripts) {
  const p = await A.seat(env, name, env.url, scripts);
  const room = await roomOf(p), invite = p.url();
  await L.act(p, { t: 'addDeck', deck: PICS, x: 260, y: 820 });
  const pics = await waitPile(p, 'Pics');
  for (const x of [480, 620]) await L.act(p, { t: 'deal', id: pics, x, y: 470, up: true });
  await L.until(async () => (await faces(p)) === 2);
  ok(await settled(p), 'a table with an image deck is saved');
  return { p, room, invite };
}
/** Turns room's save into a pre-Phase 1 one, saved a minute ago: its state
 *  in the old shape in ct-save-<room>, its decks (PICS in the transport
 *  shape, with data: URLs) in ct-decks-<room>; IndexedDB is deleted. Leaves
 *  p on a page with no app (plain). */
async function toLegacy(p, env, room) {
  await p.goto(h.plain(env));
  const rec = await h.idb(p, 'saves', room), cat = await catalogOf(p, room);
  const legacy = structuredClone(rec.state);
  for (const [pid, k] of Object.entries(legacy.keys)) legacy.players[pid].key = k;
  delete legacy.keys; delete legacy.zMax; delete legacy.v;
  const save = JSON.stringify({ ts: Date.now() - 60000, state: legacy });
  const decks = JSON.stringify(Object.fromEntries(cat.map((r) => [r.id, r.deck.name === 'Pics' ? PICS : r.deck])));
  await dropDB(p);
  await p.evaluate(([room, s, d]) => { localStorage.setItem(`ct-save-${room}`, s); localStorage.setItem(`ct-decks-${room}`, d); }, [room, save, decks]);
}
const OLDER = /^Couldn't resume this table's last save \(browser storage is full\) — resumed an older one$/;
const MOVE = /^Couldn't move this table's save to the new storage: .+$/, CANT = /^Can't save this table \(browser storage is full\) — reloading the host tab would reset it$/;
const UNRECORDED = "Couldn't resume this table's last save (it isn't in this browser's storage) — resumed the previous Card Table's save";
/** Whether notices `lines` are, in order, one per pattern of `res`. */
const linesAre = (lines, res) => lines.length === res.length && res.every((re, k) => (typeof re === 'string' ? re === lines[k] : re.test(lines[k])));

(async () => {
  const env = await h.start();

  section('(1) a legacy save whose images can\'t be stored is never lost');
  await (async () => {
    const { p: pat, room, invite } = await picsTable(env, 'Pat', [A.toastLog, h.quotaStub, fullOnce]);
    await toLegacy(pat, env, room);
    await pat.evaluate(() => sessionStorage.setItem('__fullOnce', JSON.stringify('assets'))); // the asset store is full on the next boot
    await back(pat, invite);
    await okWait(toasted(pat, /^Couldn't move this table's save to the new storage: .+/), 'its images can\'t be stored: the host is told the save couldn\'t be moved');
    ok((await legacyKeys(pat)).length === 2, 'and the legacy keys stay (they hold the only copy of the images)');
    await okWait(L.until(async () => (await faces(pat)) === 2), 'the host plays on from memory, its images drawn');
    ok(!(await unbacked(pat, room)).length, 'no catalog record names an image the store lacks');
    await okWait(L.until(async () => (await h.idb(pat, 'saves', room))?.lost === 'browser storage is full'), 'its saves fail too: the save is a lost marker');
    // A reload while storage is still full, nothing saved since: the lost
    // marker must not stand for a save that replaced the legacy one.
    await pat.evaluate(() => sessionStorage.setItem('__fullOnce', JSON.stringify('assets')));
    await pat.reload();
    await pat.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(toasted(pat, OLDER), 'a reload with storage still full says the last save is lost, and resumes an older one');
    await okWait(toasted(pat, CANT), '(and its first save fails too)');
    const up = await onScreen(pat);
    ok(linesAre(up, [MOVE, OLDER, CANT]), `the toast on screen says all three, a line each: the move, the table resumed, the save failing — none replaced another (${JSON.stringify(up)}): D320`);
    const said = await toasts(pat);
    ok(linesAre(said, [MOVE, OLDER, CANT]), `the toast log holds each once, in order — not again as the next joins it (${JSON.stringify(said)}): D322`);
    ok((await legacyKeys(pat)).length === 2, 'the legacy keys survive it');
    await okWait(L.until(async () => (await faces(pat)) === 2 && (await L.view(pat)).log.some((e) => e.txt === 'resumed the table')), 'and the legacy table is back, its images drawn');
    ok(!(await toasts(pat)).some((t) => /started a fresh one/.test(t)), 'not a fresh table');
    await pat.evaluate(() => { window.__quota = null; }); // storage frees up
    await L.act(pat, { t: 'chat', msg: 'storage is back' });
    ok(await settled(pat), 'the next save goes through');
    const stored = await catalogOf(pat, room);
    ok(stored.length === 2 && !(await unbacked(pat, room)).length && (await h.idb(pat, 'assets')).length === 2, 'with both decks and their images');
    await pat.reload();
    await pat.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(L.until(async () => (await faces(pat)) === 2 && (await L.view(pat)).log.some((e) => e.txt === 'resumed the table')), 'a reload resumes it from IndexedDB, images included');
    ok(!(await legacyKeys(pat)).length, 'and only now are the legacy keys gone (a newer save supersedes them)');
    ok(!(await toasts(pat)).some((t) => /Couldn't resume/.test(t)), 'with nothing lost');
    await pat.context().close();
  })().catch((e) => ok(false, `(1) crashed: ${e.stack}`));

  section('(2) a save that can\'t be read at boot is never written over');
  await (async () => {
    const q = await A.seat(env, 'Quinn', env.url, [A.toastLog, failGetOnce]);
    const room = await roomOf(q), std = await pileNamed(q, 'Standard');
    for (let k = 0; k < 4; k++) await L.act(q, { t: 'deal', id: std, x: 300 + 70 * k, y: 500, up: true });
    await L.act(q, { t: 'chat', msg: 'remember me' });
    ok(await settled(q), 'a table is saved');
    const before = JSON.stringify(await h.idb(q, 'saves', room));
    await q.evaluate(() => sessionStorage.setItem('__failGet', '1'));
    await q.reload();
    await q.waitForSelector('.item.pile .count', { timeout: 30000 });
    const READ = /^Couldn't read this table's save \(.*a transient read failure.*\) — this tab won't save over it; reload this page to try again$/;
    await okWait(toasted(q, READ), 'one failed read: the host is told, with the cause');
    ok(await isHost(q), 'the tab still hosts its room (its host key)');
    const std2 = await pileNamed(q, 'Standard');
    await L.act(q, { t: 'deal', id: std2, x: 600, y: 700, up: true });
    await h.sleep(2500); // saves would have happened by now
    ok(JSON.stringify(await h.idb(q, 'saves', room)) === before, 'and the save it couldn\'t read is left as it was');
    ok(await q.evaluate((re) => document.getElementById('toast').textContent.includes("won't save over it"), String(READ)), 'the notice stays up');
    await q.reload();
    await q.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(L.until(async () => { const v = await L.view(q); return v.log.some((e) => e.txt === 'remember me') && Object.values(v.items).filter((it) => it.k === 'c').length === 4; }),
      'the next boot reads it, and resumes the table whole');
    await q.context().close();
  })().catch((e) => ok(false, `(2) crashed: ${e.stack}`));

  section('(3) a lost marker drops the room\'s catalog');
  await (async () => {
    const r = await A.seat(env, 'Rae', env.url, [A.toastLog, h.quotaStub]);
    const room = await roomOf(r);
    await L.act(r, { t: 'addDeck', deck: { ...PICS, name: 'Old' }, x: 260, y: 820 });
    await waitPile(r, 'Old');
    ok(await settled(r) && (await catalogOf(r, room)).length === 2, 'a table with 2 decks is saved');
    await r.evaluate(() => { window.__quota = 'saves'; });
    await L.act(r, { t: 'chat', msg: 'x' });
    await okWait(L.until(async () => typeof (await h.idb(r, 'saves', room))?.lost === 'string'), 'storage fills up: the save becomes a lost marker');
    ok(!(await catalogOf(r, room)).length, 'and the room\'s catalog goes with it');
    await r.reload(); // (the stub lifts: window.__quota is gone)
    await r.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(toasted(r, /^Couldn't resume this table \(browser storage is full\)/), 'a reload resets the table loudly');
    ok(await settled(r), 'the fresh table is saved');
    const rec = await h.idb(r, 'saves', room), cat = await catalogOf(r, room);
    const shown = [...new Set(Object.values(rec.state.items).flatMap((it) => (it.k === 'p' ? it.cards.map((c) => c.d) : [it.d])))].sort();
    ok(L.same(cat.map((c) => c.id).sort(), shown) && cat.every((c) => c.deck.name === 'Standard'), `its catalog holds its own deck only (${cat.map((c) => c.deck.name).join(', ')})`);
    await r.context().close();
  })().catch((e) => ok(false, `(3) crashed: ${e.stack}`));

  section('(4) a function in t.data costs the rules, not the save');
  await (async () => {
    const s = await A.seat(env, 'Sam', env.url, [A.toastLog]);
    const room = await roomOf(s);
    ok(await settled(s), 'a table is saved');
    await L.act(s, { t: 'setRules', code: '({ name: "Fn", setup(t) { t.data.n = 7; t.data.fmt = (x) => String(x); t.public.shown = 1; } })', enabled: true });
    await okWait(toasted(s, /^Rules disabled — error in t\.data \/ t\.public: they hold a value that can't be saved \(.*could not be cloned.*\) — keep them JSON$/),
      'the save can\'t copy t.data: the rules disable, saying why');
    ok(await settled(s), 'and the next save goes through');
    const rec = await h.idb(s, 'saves', room);
    ok(!rec.lost && rec.state.rules?.enabled === false && L.same(rec.state.rules.data, { n: 7 }) && rec.state.rules.public?.shown === 1,
      `the save is never a lost marker, and keeps t.data's JSON part (${JSON.stringify(rec.state?.rules?.data)})`);
    ok(!(await toasts(s)).some((t) => /Can't save/.test(t)), 'with no "can\'t save" notice');
    await s.context().close();
  })().catch((e) => ok(false, `(4) crashed: ${e.stack}`));

  section('(5) full storage evicts the image cache before another table\'s save');
  await (async () => {
    const t = await env.page('Tess');
    for (const s of [L.rtcHook, A.toastLog, fullUntilGC]) await t.addInitScript(s);
    await t.goto(h.plain(env));
    const img = A.png(9, 9, { rgb: [3, 3, 3] }), id = A.sha256(img);
    await h.plantSave(t, '0ld1', { v: 2, seq: 1, size: 1300, items: {}, players: {}, keys: {}, log: [], guestDeckChars: 0, zMax: 0, pad: 'x'.repeat(60000) }, {}, Date.now() - 2 * DAY);
    await h.withStore(t, async (S, [h, bytes, used]) => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('cardtable'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const x = db.transaction('assets', 'readwrite');
      x.objectStore('assets').put({ h, mime: 'image/png', size: bytes.length, data: new Uint8Array(bytes).buffer, used });
      await new Promise((res, rej) => { x.oncomplete = res; x.onabort = () => rej(x.error); });
      db.close();
    }, [id, [...img], Date.now() - 2 * DAY]);
    await t.evaluate(() => sessionStorage.setItem('__fullSaves', '1'));
    await t.goto(env.url);
    await h.joinAs(t, 'Tess');
    await t.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await settled(t), 'a new table is saved although storage was full');
    ok(!(await h.idb(t, 'assets')).some((a) => a.h === id), 'room was made by deleting a cached image no table shows (2 days unused)');
    ok(!!(await h.idb(t, 'saves', '0ld1'))?.state, 'not another table\'s save');
    ok(!(await toasts(t)).some((x) => /deleted \d+ old table save|Can't save/.test(x)), 'and nothing is said to be deleted or lost');
    await t.context().close();
  })().catch((e) => ok(false, `(5) crashed: ${e.stack}`));

  section('(6) no BroadcastChannel');
  await (async () => {
    const u = await A.seat(env, 'Uma', env.url, [() => { delete window.BroadcastChannel; }]);
    ok(await isHost(u) && await settled(u), 'the app boots, hosts and saves without it');
    await u.context().close();
  })().catch((e) => ok(false, `(6) crashed: ${e.stack}`));

  section('(7) a lost marker never deletes the legacy save it couldn\'t replace');
  await (async () => {
    const { p: v, room, invite } = await picsTable(env, 'Vic', [A.toastLog]);
    await toLegacy(v, env, room);
    // What a failed migration and a failed save leave: the legacy keys, a lost
    // marker in IndexedDB — and a pagehide's pending seq, far ahead.
    await h.withStore(v, async (S, room) => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('cardtable'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const x = db.transaction('saves', 'readwrite');
      x.objectStore('saves').put({ room, ts: Date.now(), lost: 'browser storage is full' });
      await new Promise((res, rej) => { x.oncomplete = res; x.onabort = () => rej(x.error); });
      db.close();
      localStorage.setItem(`ct-pending-${room}`, '999');
    }, room);
    await back(v, invite);
    await okWait(toasted(v, OLDER), 'the host is told the last save is lost, and an older one resumed');
    await okWait(L.until(async () => (await faces(v)) === 2 && (await L.view(v)).log.some((e) => e.txt === 'resumed the table')), 'the legacy table is back, its images drawn');
    await okWait(L.until(async () => !!(await h.idb(v, 'saves', room))?.state), 'and migrated: IndexedDB holds it');
    ok(!(await legacyKeys(v)).length && !(await unbacked(v, room)).length && (await catalogOf(v, room)).length === 2, 'its keys gone only now, its decks and images stored');
    const said = await toasts(v);
    ok(!said.some((t) => /started a fresh one|Couldn't move|wasn't saved/.test(t)), `with no other notice (${JSON.stringify(said)})`);
    await v.context().close();
  })().catch((e) => ok(false, `(7) crashed: ${e.stack}`));

  section('(8) a save that holds no table takes its catalog with it');
  await (async () => {
    const w = await A.seat(env, 'Wren', env.url, [A.toastLog]);
    const room = await roomOf(w), invite = w.url();
    await L.act(w, { t: 'addDeck', deck: { ...PICS, name: 'Old' }, x: 260, y: 820 });
    await waitPile(w, 'Old');
    ok(await settled(w) && (await catalogOf(w, room)).length === 2, 'a table with 2 decks is saved');
    await w.goto(h.plain(env));
    await h.plantSave(w, room, { v: 2 }); // the record keeps its place, but holds no table
    await back(w, invite);
    await okWait(toasted(w, /^Couldn't resume this table \(the save is unreadable: it holds no table\) — started a fresh one$/), 'the host resets the table loudly');
    ok(await settled(w), 'the fresh table is saved');
    const cat = await catalogOf(w, room);
    ok(cat.length === 1 && cat[0].deck.name === 'Standard', `its catalog holds its own deck only (${cat.map((c) => c.deck.name).join(', ')})`);
    await w.reload();
    await w.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(L.until(async () => (await L.view(w)).log.some((e) => e.txt === 'resumed the table')), 'a reload resumes the fresh table');
    const piles = Object.values((await L.view(w)).items).filter((it) => it.k === 'p').map((it) => it.name);
    ok(L.same(piles, ['Standard']) && (await catalogOf(w, room)).length === 1, `with none of the old decks (${piles.join(', ')})`);
    await w.context().close();
  })().catch((e) => ok(false, `(8) crashed: ${e.stack}`));

  section('(9) a legacy save newer than the IndexedDB save is resumed, never dropped (D303)');
  await (async () => {
    const { p: o, room, invite } = await picsTable(env, 'Olga', [A.toastLog]);
    await L.act(o, { t: 'addDeck', deck: { ...PICS, name: 'Later' }, x: 900, y: 820 }); // (a deck the newer save never had)
    await waitPile(o, 'Later');
    ok(await settled(o), 'the IndexedDB save holds the table, with a deck added after the move');
    await o.goto(h.plain(env));
    // What the previous Card Table's tab, still open, saves after more play: its state in the old shape, newer.
    const rec = await h.idb(o, 'saves', room), cat = await catalogOf(o, room);
    const legacy = structuredClone(rec.state), card = Object.keys(legacy.items).find((id) => legacy.items[id].k === 'c'); // (a Pics card, dealt face up)
    for (const id of Object.keys(legacy.items)) if (legacy.items[id].name === 'Later') delete legacy.items[id];
    legacy.items[card].x = 333;
    legacy.seq += 5;
    for (const [pid, k] of Object.entries(legacy.keys)) legacy.players[pid].key = k;
    delete legacy.keys; delete legacy.zMax; delete legacy.v;
    const decks = Object.fromEntries(cat.filter((r) => r.deck.name !== 'Later').map((r) => [r.id, r.deck.name === 'Pics' ? PICS : r.deck]));
    await o.evaluate(([room, s, d]) => { localStorage.setItem(`ct-save-${room}`, s); localStorage.setItem(`ct-decks-${room}`, d); },
      [room, JSON.stringify({ ts: rec.ts + 60000, state: legacy }), JSON.stringify(decks)]);
    await back(o, invite);
    await okWait(toasted(o, /^Resumed this table's newer save, made by a tab of the previous Card Table$/), "the host is told it resumed the previous Card Table's newer save");
    await okWait(L.until(async () => (await L.view(o)).items[card]?.x === 333 && (await faces(o)) === 2), 'the newer play is on the table, its images drawn');
    ok(!(await pileNamed(o, 'Later')) && !(await legacyKeys(o)).length, 'the older IndexedDB table is gone (its deck too), and so are the legacy keys');
    const cat2 = await catalogOf(o, room);
    ok(cat2.length === 2 && !cat2.some((r) => r.deck.name === 'Later') && !(await unbacked(o, room)).length, `the room's catalog is the newer save's: ${cat2.map((r) => r.deck.name).join(', ')}`);
    await o.reload();
    await o.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(L.until(async () => (await L.view(o)).items[card]?.x === 333), 'a reload resumes it again: IndexedDB holds it now');
    await o.context().close();
  })().catch((e) => ok(false, `(9) crashed: ${e.stack}`));

  section('(10) a newer legacy save that holds no table never replaces the IndexedDB table (D317)');
  await (async () => {
    const q = await A.seat(env, 'Quin', env.url, [A.toastLog]);
    const room = await roomOf(q), invite = q.url(), pile = await waitPile(q, 'Standard');
    await L.act(q, { t: 'move', id: pile, x: 444, y: 333 });
    await L.act(q, { t: 'chat', msg: 'played on this version' });
    ok(await settled(q), 'the IndexedDB save holds the table');
    await q.goto(h.plain(env));
    const rec = await h.idb(q, 'saves', room);
    // The previous Card Table's tab, still open, fails its next save (its image decks filled localStorage): its lost marker, newer
    await q.evaluate(([room, s]) => localStorage.setItem(`ct-save-${room}`, s), [room, JSON.stringify({ ts: rec.ts + 60000, lost: 'browser storage is full' })]);
    await back(q, invite);
    await okWait(toasted(q, OLDER), "the host is told the last save couldn't be resumed, and an older one was");
    const v = await L.view(q);
    ok(v.items[pile]?.x === 444 && v.log.some((e) => e.txt === 'played on this version'), 'the IndexedDB table is resumed: the pile where it was moved, the chat kept');
    ok(!(await legacyKeys(q)).length && !(await toasts(q)).some((t) => /started a fresh one/.test(t)), 'the legacy marker is gone, and no fresh table was started');
    ok(await settled(q) && (await h.idb(q, 'saves', room)).state.seq > rec.state.seq, 'IndexedDB holds the table, saved on — never the marker');
    await q.reload();
    await q.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(L.until(async () => (await L.view(q)).items[pile]?.x === 444), 'a reload resumes it again');
    await q.context().close();
  })().catch((e) => ok(false, `(10) crashed: ${e.stack}`));

  section('(11) …and a state left pending over that IndexedDB table, ahead of it, is resumed as ever (D318)');
  await (async () => {
    const q = await A.seat(env, 'Rae', env.url, [A.toastLog]);
    const room = await roomOf(q), invite = q.url(), pile = await waitPile(q, 'Standard');
    await L.act(q, { t: 'move', id: pile, x: 444, y: 333 });
    ok(await settled(q), 'the IndexedDB save holds the table (the pile at 444)');
    await q.goto(h.plain(env));
    const rec = await h.idb(q, 'saves', room), st = structuredClone(rec.state);
    st.items[pile].x = 555; st.seq += 1; // (the last moment, whose pagehide write never committed in WebKit: the pile moved on to 555)
    await q.evaluate(([room, p, l]) => { localStorage.setItem(`ct-pending-${room}`, p); localStorage.setItem(`ct-save-${room}`, l); },
      [room, JSON.stringify({ seq: st.seq, at: Date.now(), state: st }), JSON.stringify({ ts: rec.ts + 60000, lost: 'browser storage is full' })]);
    await back(q, invite);
    await okWait(toasted(q, OLDER), "the host is told the last save couldn't be resumed, and an older one was");
    const x = (await L.view(q)).items[pile]?.x;
    ok(x === 555 && !(await toasts(q)).some((t) => /wasn't saved/.test(t)), `the pending state is resumed: the pile at ${x} (555), and nothing says the moment was lost`);
    ok(await q.evaluate((k) => localStorage.getItem(k) === null, `ct-pending-${room}`) && !(await legacyKeys(q)).length, 'the pending mark and the legacy marker are gone');
    ok(await settled(q) && (await h.idb(q, 'saves', room)).state.items[pile].x === 555, 'and IndexedDB holds the resumed state');
    await q.context().close();
  })().catch((e) => ok(false, `(11) crashed: ${e.stack}`));

  section('(12) a newer legacy save replaces the IndexedDB table, and with it what was left pending over that table (D318)');
  await (async () => {
    const q = await A.seat(env, 'Sid', env.url, [A.toastLog]);
    const room = await roomOf(q), invite = q.url(), pile = await waitPile(q, 'Standard');
    await L.act(q, { t: 'move', id: pile, x: 444, y: 333 });
    ok(await settled(q), 'the IndexedDB save holds the table (the pile at 444)');
    await q.goto(h.plain(env));
    const rec = await h.idb(q, 'saves', room), cat = await catalogOf(q, room), mine = structuredClone(rec.state), legacy = structuredClone(rec.state);
    mine.items[pile].x = 555; mine.seq += 5; // (this tab played on to 555, its last write left pending)
    legacy.items[pile].x = 222; legacy.seq += 1; // (the previous Card Table's tab played on too, and saved later)
    for (const [pid, k] of Object.entries(legacy.keys)) legacy.players[pid].key = k;
    delete legacy.keys; delete legacy.zMax; delete legacy.v;
    await q.evaluate(([room, p, s, d]) => { localStorage.setItem(`ct-pending-${room}`, p); localStorage.setItem(`ct-save-${room}`, s); localStorage.setItem(`ct-decks-${room}`, d); },
      [room, JSON.stringify({ seq: mine.seq, at: Date.now(), state: mine }), JSON.stringify({ ts: rec.ts + 60000, state: legacy }), JSON.stringify(Object.fromEntries(cat.map((r) => [r.id, r.deck])))]);
    await back(q, invite);
    await okWait(toasted(q, /^Resumed this table's newer save, made by a tab of the previous Card Table$/), "the host is told it resumed the previous Card Table's newer save");
    await h.sleep(500);
    const x = (await L.view(q)).items[pile]?.x;
    ok(x === 222 && await q.evaluate((k) => localStorage.getItem(k) === null, `ct-pending-${room}`), `the newer save is on the table (the pile at ${x}, 222), never the state left pending over the table it replaced (555 ahead by seq), and the mark is gone`);
    await q.context().close();
  })().catch((e) => ok(false, `(12) crashed: ${e.stack}`));

  section('(13) …and a seq alone left pending over that IndexedDB table is said in the same toast (D319)');
  await (async () => {
    const q = await A.seat(env, 'Ivo', env.url, [A.toastLog]);
    const room = await roomOf(q), invite = q.url(), pile = await waitPile(q, 'Standard');
    await L.act(q, { t: 'move', id: pile, x: 444, y: 333 });
    ok(await settled(q), 'the IndexedDB save holds the table (the pile at 444)');
    await q.goto(h.plain(env));
    const rec = await h.idb(q, 'saves', room);
    // (the last moment named a deck the saved catalog lacked, or was over PENDING_MAX: its seq alone)
    await q.evaluate(([room, p, l]) => { localStorage.setItem(`ct-pending-${room}`, p); localStorage.setItem(`ct-save-${room}`, l); },
      [room, String(rec.state.seq + 1), JSON.stringify({ ts: rec.ts + 60000, lost: 'browser storage is full' })]);
    await back(q, invite);
    const BOTH = /^Couldn't resume this table's last save \(browser storage is full\) — resumed an older one, and the last moment of play before the reload wasn't saved$/;
    await okWait(toasted(q, BOTH), 'one toast says an older save was resumed, and that the last moment of play was lost');
    const said = await toasts(q);
    ok(said.length === 1 && BOTH.test(await q.textContent('#toast')), `and it is the toast shown, the only one (${JSON.stringify(said)})`);
    ok((await L.view(q)).items[pile]?.x === 444, 'the IndexedDB table is resumed (the pile at 444)');
    await q.context().close();
  })().catch((e) => ok(false, `(13) crashed: ${e.stack}`));

  section('(14) a legacy save with no IndexedDB record: what was left pending over it applies (D319, D320)');
  await (async () => {
    const q = await A.seat(env, 'Jun', env.url, [A.toastLog]);
    const room = await roomOf(q), invite = q.url(), pile = await waitPile(q, 'Standard');
    await L.act(q, { t: 'move', id: pile, x: 444, y: 333 });
    ok(await settled(q), 'the IndexedDB save holds the table (the pile at 444)');
    // (whole: a state of a table its catalog lacks no deck of — flushSave's whole state over a table whose
    // migration failed lists every deck as unsaved, so only a table with no deck could leave one; the code path is checked)
    for (const whole of [false, true]) {
      await q.goto(h.plain(env));
      const rec = await h.idb(q, 'saves', room), st = structuredClone(rec.state);
      st.items[pile].x = 555; st.seq += 3; // (this tab played on: its migration and every save since failed, the lost marker too)
      await toLegacy(q, env, room);
      await q.evaluate(([k, p]) => localStorage.setItem(k, p), [`ct-pending-${room}`, whole ? JSON.stringify({ seq: st.seq, at: Date.now(), state: st }) : String(st.seq)]);
      const t0 = Date.now();
      await back(q, invite);
      if (whole) {
        await okWait(L.until(async () => (await L.view(q)).items[pile]?.x === 555), 'a whole state left pending is resumed over the migrated table (the pile at 555)');
        ok(!(await toasts(q, t0)).some((t) => /wasn't saved|Couldn't resume/.test(t)), 'and nothing says play was lost');
        ok(await settled(q) && (await h.idb(q, 'saves', room)).state.items[pile].x === 555, 'IndexedDB holds the resumed state');
      } else {
        await okWait(toasted(q, UNRECORDED), `a seq alone ahead of the migrated table: the host is told none of its saves since the move is in storage, and the previous Card Table's save resumed ("${UNRECORDED}"): D320`);
        ok(!(await toasts(q, t0)).some((t) => /wasn't saved \(the browser closed first\)/.test(t)), 'never "the last moment … (the browser closed first)": nothing closed early, every save failed');
        ok((await L.view(q)).items[pile]?.x === 444, 'and the migrated table is resumed (the pile at 444)');
        ok(await settled(q), '(saved again)');
      }
      ok(await q.evaluate((k) => localStorage.getItem(k) === null, `ct-pending-${room}`) && !(await legacyKeys(q)).length, 'the pending mark and the legacy keys are gone');
    }
    await q.context().close();
  })().catch((e) => ok(false, `(14) crashed: ${e.stack}`));

  section("(15) …and another page's upkeep keeps that mark for the room's boot (D320)");
  await (async () => {
    const q = await A.seat(env, 'Kai', env.url, [A.toastLog]);
    const room = await roomOf(q), invite = q.url(), pile = await waitPile(q, 'Standard');
    await L.act(q, { t: 'move', id: pile, x: 444, y: 333 });
    ok(await settled(q), 'the IndexedDB save holds the table (the pile at 444)');
    await q.goto(h.plain(env));
    const seq = (await h.idb(q, 'saves', room)).state.seq, none = 'cd'.repeat(12);
    await toLegacy(q, env, room);
    await q.evaluate(([k, p, n]) => { localStorage.setItem(k, p); localStorage.setItem(`ct-pending-${n}`, '7'); }, [`ct-pending-${room}`, String(seq + 3), none]);
    await q.goto(env.url); // (another Card Table page — a new table — whose upkeep sweeps 5 s after it settles)
    await q.waitForSelector('.item.pile .count', { timeout: 30000 });
    const mark = (r) => q.evaluate((k) => localStorage.getItem(k), `ct-pending-${r}`);
    ok(await L.until(async () => (await mark(none)) === null, 20000, 250), "(its upkeep ran: it removed a mark whose room has no table at all)");
    ok(await mark(room) === String(seq + 3), `and kept the mark ahead of the room's pre-Phase 1 table, which the room's next boot migrates (${await mark(room)})`);
    await q.goto(h.plain(env));
    await back(q, invite);
    await okWait(toasted(q, UNRECORDED), "the room's boot says its play since the move wasn't kept");
    ok((await L.view(q)).items[pile]?.x === 444 && await mark(room) === null, 'the legacy table resumed (the pile at 444), the mark gone');
    await q.context().close();
  })().catch((e) => ok(false, `(15) crashed: ${e.stack}`));

  section('(16) storage still full at the next boot: all it says is on screen, a line each (D320)');
  await (async () => {
    for (const mode of ['all', 'data']) { // all: even the lost marker fails (14's lineage); data: lost markers land (7's)
      const q = await A.seat(env, mode === 'all' ? 'Lia' : 'Mo', env.url, [A.toastLog, savesFull]);
      const room = await roomOf(q), invite = q.url(), pile = await waitPile(q, 'Standard');
      await L.act(q, { t: 'move', id: pile, x: 444, y: 333 });
      ok(await settled(q), `${mode}: the IndexedDB save holds the table (the pile at 444)`);
      await toLegacy(q, env, room);
      await q.evaluate((m) => sessionStorage.setItem('__savesFull', m), mode);
      await back(q, invite); // boot 1: the move to IndexedDB fails, so do its saves
      await okWait(toasted(q, CANT), "boot 1: the move fails, and the table's saves too");
      for (let k = 0; k < 3; k++) { await L.act(q, { t: 'move', id: pile, x: 500 + 20 * k, y: 333 }); await h.sleep(300); }
      const seq = (await L.view(q)).seq, rec = await h.idb(q, 'saves', room);
      ok(mode === 'all' ? rec === null : rec?.lost === 'browser storage is full', `(IndexedDB holds ${mode === 'all' ? 'no record' : 'a lost marker'}: ${JSON.stringify(rec)})`);
      const n0 = q.logs.length;
      await q.reload(); // boot 2, storage still full: it leaves a seq alone pending (the catalog was never saved)
      await q.waitForSelector('.item.pile .count', { timeout: 30000 });
      const want = [MOVE, mode === 'all' ? UNRECORDED : OLDER, CANT];
      await okWait(L.until(async () => linesAre(await onScreen(q), want), 5000, 50), `boot 2's toast shows the move failing, ${mode === 'all' ? 'the play since it lost' : 'the last save lost'}, and the first save failing, a line each (${JSON.stringify(await onScreen(q))})`);
      await h.sleep(2500);
      ok(linesAre(await onScreen(q), want), `…still all three 2.5 s on — the save's failure joined them, replacing none (${JSON.stringify(await onScreen(q))})`);
      const said = await toasts(q);
      ok(linesAre(said, want), `the toast log holds each once, in order (${JSON.stringify(said)}): D322`);
      ok((await L.view(q)).items[pile]?.x === 444, `the legacy table is resumed (the pile at 444; seq ${seq} was lost)`);
      if (mode === 'data') {
        const why = q.logs.slice(n0).find((l) => /dropped the save left pending/.test(l.text))?.text || '';
        ok(/it was made over this table's last save, which was lost \(browser storage is full\) — the boot says so/.test(why), `the console says why the mark goes — over the save IndexedDB lost, not "another table" ("${why}"): D320`);
      }
      await q.evaluate(() => sessionStorage.removeItem('__savesFull'));
      await q.context().close();
    }
  })().catch((e) => ok(false, `(16) crashed: ${e.stack}`));

  await env.done();
})().catch(h.crash);
