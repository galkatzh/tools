// E2E: the storage regressions the Phase 1B review found (spec §1h), one
// section each:
//   (1) migrate   a legacy save whose images can't be stored (the asset store
//                 is full): its keys stay, the host is told, and plays from
//                 memory; once storage frees up, the next save stores the table
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

// --- helpers -------------------------------------------------------------------------------
const roomOf = (p) => p.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
const isHost = (p) => p.evaluate(() => !document.getElementById('size-sel').classList.contains('hidden'));
const toasts = (p) => A.toastsSince(p, 0);
const toasted = (p, re, ms = 15000) => L.until(async () => (await toasts(p)).some((t) => re.test(t)), ms, 150);
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

(async () => {
  const env = await h.start();

  section('(1) a legacy save whose images can\'t be stored is never lost');
  await (async () => {
    const pat = await A.seat(env, 'Pat', env.url, [A.toastLog, h.quotaStub, fullOnce]);
    const room = await roomOf(pat), invite = pat.url();
    await L.act(pat, { t: 'addDeck', deck: PICS, x: 260, y: 820 });
    const pics = await waitPile(pat, 'Pics');
    for (const x of [480, 620]) await L.act(pat, { t: 'deal', id: pics, x, y: 470, up: true });
    await L.until(async () => (await faces(pat)) === 2);
    ok(await settled(pat), 'a table with an image deck is saved');
    await pat.goto(h.plain(env));
    const rec = await h.idb(pat, 'saves', room), cat = await catalogOf(pat, room);
    const legacy = structuredClone(rec.state);
    for (const [p, k] of Object.entries(legacy.keys)) legacy.players[p].key = k;
    delete legacy.keys; delete legacy.zMax; delete legacy.v;
    const save = JSON.stringify({ ts: Date.now() - 60000, state: legacy });
    const decks = JSON.stringify(Object.fromEntries(cat.map((r) => [r.id, r.deck.name === 'Pics' ? PICS : r.deck])));
    await dropDB(pat);
    await pat.evaluate(([room, s, d]) => { localStorage.setItem(`ct-save-${room}`, s); localStorage.setItem(`ct-decks-${room}`, d); }, [room, save, decks]);
    await pat.evaluate(() => sessionStorage.setItem('__fullOnce', JSON.stringify('assets'))); // the asset store is full on the next boot
    await back(pat, invite);
    await okWait(toasted(pat, /^Couldn't move this table's save to the new storage: .+/), 'its images can\'t be stored: the host is told the save couldn\'t be moved');
    ok((await legacyKeys(pat)).length === 2, 'and the legacy keys stay (they hold the only copy of the images)');
    await okWait(L.until(async () => (await faces(pat)) === 2), 'the host plays on from memory, its images drawn');
    ok(!(await unbacked(pat, room)).length, 'no catalog record names an image the store lacks');
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

  await env.done();
})().catch(h.crash);
