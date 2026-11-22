// E2E (sync cluster): host persistence and restarts. The table is saved in
// IndexedDB (store.js): h.idb() reads it, h.plantSave() plants saves, and
// h.quotaStub makes its writes fail as a full browser's would.
//   NET-13  decks are stored once (the room's catalog), the throttled save holds only the state
//   NET-1   a failed save never resumes stale: lost marker → loud fresh table; guests
//           accept the restarted host (state epoch) instead of freezing on old seqs
//           (and once storage frees up, the next save writes the decks again with the state)
//   NET-2   full storage: older rooms' saves are pruned oldest first; the host stays host;
//           saves another tab wrote moments ago are never pruned
//   NET-4   an unreadable save (e.g. {state:null}) no longer bricks the room's boot
const h = require('./h');
const { ok, section, logHas } = h;

/** Init script for every page of a context: counts IndexedDB writes per
 *  store (window.__w.saves, .catalog), failed ones included. It wraps the
 *  quota stub (h.quotaStub, added first): window.__quota = 'saves' makes
 *  saves fail as when storage is full. */
function instrument() {
  const put = IDBObjectStore.prototype.put;
  window.__w = {};
  IDBObjectStore.prototype.put = function (...a) {
    window.__w[this.name] = (window.__w[this.name] || 0) + 1;
    return put.apply(this, a);
  };
}
/** Init script: storage is full on this context's next app load only — {store, heal} as window.__quota (h.quotaStub). */
const fullOnce = (q) => { if (!sessionStorage.__full) { sessionStorage.__full = 1; window.__quota = q; } };
/** A page whose context counts and can fail IndexedDB writes. */
async function instrumented(env, name) {
  const p = await env.page(name);
  await p.context().addInitScript(h.quotaStub);
  await p.context().addInitScript(instrument);
  return p;
}
/** Plants `n` saves of other rooms ("0ld0", … — none of them hosted here), padded to `pad` chars, written at ts(k). */
const plantRooms = (page, prefix, n, pad, ts) => Promise.all(Array.from({ length: n }, (_, k) =>
  h.plantSave(page, `${prefix}${k}`, { v: 2, seq: 1, items: {}, players: {}, log: [], pad: 'x'.repeat(pad) }, {}, ts(k))));
const room = (p) => p.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
const counts = (p) => p.$$eval('.item.pile .count', (els) => els.map((e) => +e.textContent).sort((a, b) => a - b).join());
const isHost = (p) => p.evaluate(() => !document.getElementById('size-sel').classList.contains('hidden'));

(async () => {
  const env = await h.start();
  const host = await instrumented(env, 'Alice');
  await host.goto(env.url);
  await h.joinAs(host, 'Alice');
  await host.waitForSelector('.item.pile .count');
  const guest = await env.page('Bob');
  await guest.goto(host.url());
  await h.joinAs(guest, 'Bob');
  await guest.waitForSelector('.item.pile .count', { timeout: 30000 });
  const id = await room(host), invite = host.url();
  const roomDecks = async () => (await h.idb(host, 'catalog')).filter((r) => r.room === id);

  section('NET-13: decks are saved once, the state on its own');
  for (let k = 0; k < 4; k++) { await guest.dblclick('.item.pile'); await h.waitHand(guest, k + 1); }
  await h.sleep(1500);
  const w = await host.evaluate(() => window.__w);
  const save = await h.idb(host, 'saves', id);
  ok((await roomDecks()).length === 1, 'the deck data lives in the room\'s catalog');
  ok(!!save?.state && !('decks' in save) && !('decks' in save.state) && Number.isFinite(save.ts), 'the room\'s save holds {room, ts, v, state} only');
  ok(w.catalog === 1 && w.saves >= 2, `play rewrites only the state (decks written ${w.catalog}×, state ${w.saves}×)`);
  await host.click('#add-deck-btn');
  await host.click('#deck-add');
  await logHas(host, 'added deck "Standard"');
  await h.sleep(1500);
  ok((await host.evaluate(() => window.__w.catalog)) === 2, 'adding a deck writes the catalog once more');

  section('NET-4: an unreadable save resets loudly instead of bricking the room');
  await host.goto(h.plain(env)); // pagehide saves the table; the app must not run while the save is spoiled
  await h.withStore(host, (S, room) => new Promise((res, rej) => {
    const r = indexedDB.open('cardtable');
    r.onsuccess = () => {
      const t = r.result.transaction('saves', 'readwrite');
      t.objectStore('saves').put({ room, ts: Date.now(), v: 2, state: null });
      t.oncomplete = () => { r.result.close(); res(); };
      t.onabort = () => rej(t.error);
    };
  }), id);
  await host.goto(invite);
  ok(await h.toastHas(host, "Couldn't resume this table", 15000).then(() => true, () => false), 'the host is told why its table was reset');
  await host.waitForSelector('.item.pile .count', { timeout: 15000 });
  ok(await isHost(host) && (await counts(host)) === '52', 'and keeps hosting a fresh table');
  await guest.waitForFunction(() => [...document.querySelectorAll('.item.pile .count')].map((e) => e.textContent).join() === '52', null, { timeout: 30000 })
    .then(() => ok(true, 'the guest follows the restarted host (new epoch, lower seq)'), () => ok(false, 'the guest follows the restarted host (new epoch, lower seq)'));

  section('NET-1: a failed save is never resumed as if it were current');
  await h.waitHand(guest, 0);
  await host.evaluate(() => { window.__quota = 'saves'; });
  for (let k = 0; k < 3; k++) { await guest.dblclick('.item.pile'); await h.waitHand(guest, k + 1); }
  ok(await h.toastHas(host, "Can't save this table (browser storage is full)").then(() => true, () => false), 'the host is told the real cause right away');
  await h.sleep(1500);
  ok((await h.idb(host, 'saves', id))?.lost === 'browser storage is full', 'the stale snapshot is replaced by a lost marker');
  await host.reload();
  ok(await h.toastHas(host, "Couldn't resume this table (browser storage is full)", 15000).then(() => true, () => false), 'reloading resets the table loudly (no silent rewind)');
  ok(await isHost(host), 'the tab is still the host');
  await guest.waitForFunction(() => document.querySelectorAll('.item.pile').length === 1 && document.querySelector('.item.pile .count').textContent === '52', null, { timeout: 30000 })
    .then(() => ok(true, "the guest's table matches the host's again"), () => ok(false, "the guest's table matches the host's again"));
  await h.waitHand(guest, 0).then(() => ok(true, "and the guest's hand follows the reset table"), () => ok(false, "and the guest's hand follows the reset table"));

  section('NET-1: once storage frees up, the next save writes the decks again with the state');
  await h.sleep(1500); // the reset table (decks included) is stored again
  await host.evaluate(() => { window.__quota = 'saves'; });
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  ok(await h.toastHas(host, "Can't save this table (browser storage is full)").then(() => true, () => false), 'the host is told the save failed');
  await h.sleep(1500);
  const written = await host.evaluate(() => window.__w.catalog);
  await host.evaluate(() => { window.__quota = null; });
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 2);
  await h.sleep(1500);
  const after = await h.idb(host, 'saves', id);
  ok((await host.evaluate(() => window.__w.catalog)) > written && (await roomDecks()).length >= 1 && !!after?.state, 'once storage frees up, the decks are stored again with the state');
  await host.reload();
  await logHas(host, 'Alice resumed the table', 20000).then(() => ok(true, 'reloading resumes the table'), () => ok(false, 'reloading resumes the table'));
  ok(!(await h.toastHas(host, "Couldn't resume", 3000).then(() => true, () => false)), 'with no "couldn\'t resume" reset');
  await h.waitHand(guest, 2, 30000).then(() => ok(true, "the guest's hand survived the reload"), () => ok(false, "the guest's hand survived the reload"));

  section('NET-2: full storage prunes older rooms oldest first');
  const p2 = await instrumented(env, 'Carol');
  await p2.goto(h.plain(env)); // same origin, no app: plant other rooms' saves
  await p2.evaluate(() => localStorage.setItem('ct-hostkey-0ld0', 'keep me'));
  await plantRooms(p2, '0ld', 6, 40000, (k) => 1000 + k);
  await p2.addInitScript(fullOnce, { store: 'saves', heal: 1 }); // full until one save is deleted
  await p2.goto(env.url);
  await h.joinAs(p2, 'Carol');
  await p2.waitForSelector('.item.pile .count');
  ok(await h.toastHas(p2, 'Browser storage was full — deleted 1 old table save', 15000).then(() => true, () => false), 'a new room makes space by deleting the oldest save, and says so');
  const left = new Set((await h.idb(p2, 'saves')).map((r) => r.room));
  ok(!left.has('0ld0') && [1, 2, 3, 4, 5].every((k) => left.has(`0ld${k}`)), 'only the oldest room was pruned');
  ok((await p2.evaluate(() => localStorage.getItem('ct-hostkey-0ld0'))) === 'keep me', 'host keys are never pruned');
  await p2.reload();
  await logHas(p2, 'Carol resumed the table', 20000).then(() => ok(true, 'reloading resumes the table (the host is not stranded as a guest of its own room)'), () => ok(false, 'reloading resumes the table (the host is not stranded as a guest of its own room)'));
  ok(await isHost(p2), 'the reloaded tab is the host');

  section('NET-2: saves another tab is writing right now are never pruned');
  const p3 = await instrumented(env, 'Dave');
  await p3.goto(h.plain(env));
  await plantRooms(p3, '1ive', 4, 40000, () => Date.now());
  await p3.addInitScript(fullOnce, { store: 'saves' });
  await p3.goto(env.url);
  await h.joinAs(p3, 'Dave');
  await p3.waitForSelector('.item.pile .count');
  ok(await h.toastHas(p3, "Can't save this table (browser storage is full)", 15000).then(() => true, () => false), 'the new table says it can\'t be saved');
  const live = new Set((await h.idb(p3, 'saves')).filter((r) => r.state).map((r) => r.room));
  ok([0, 1, 2, 3].every((k) => live.has(`1ive${k}`)), 'all 4 recently written saves are intact');
  await env.done();
})().catch(h.crash);
