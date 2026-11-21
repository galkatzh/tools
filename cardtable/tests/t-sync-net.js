// E2E (sync cluster): host persistence and restarts.
//   NET-13  decks are stored once (ct-decks-*), the throttled save holds only the state
//   NET-1   a failed save never resumes stale: lost marker → loud fresh table; guests
//           accept the restarted host (state epoch) instead of freezing on old seqs
//           (also when only the state write fails: the decks are rewritten with the next save)
//   NET-2   full storage: older rooms' saves are pruned oldest first; the host stays host;
//           saves another tab wrote moments ago are never pruned
//   NET-4   an unreadable save (e.g. {state:null}) no longer bricks the room's boot
const h = require('./h');
const { ok, section, logHas } = h;

/** Instruments localStorage in every page of the context: counts writes per
 *  key kind; window.__quota = true makes big ct-save/ct-decks writes throw
 *  QuotaExceededError (window.__quotaSave: only ct-save writes); sessionStorage.__corrupt = key plants a {state:null}
 *  save before the app boots. */
function instrument() {
  const orig = Storage.prototype.setItem;
  window.__w = {};
  Storage.prototype.setItem = function (k, v) {
    if (this === localStorage) {
      const kind = k.replace(/-[0-9a-f]{16,}$/, '');
      window.__w[kind] = (window.__w[kind] || 0) + 1;
      if ((window.__quota && /^ct-(save|decks)-/.test(k) || window.__quotaSave && /^ct-save-/.test(k)) && v.length > 200) throw new DOMException('quota (test)', 'QuotaExceededError');
    }
    return orig.call(this, k, v);
  };
  const c = sessionStorage.getItem('__corrupt');
  if (c) { sessionStorage.removeItem('__corrupt'); localStorage.setItem(c, '{"state":null}'); }
}
const room = (p) => p.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
const counts = (p) => p.$$eval('.item.pile .count', (els) => els.map((e) => +e.textContent).sort((a, b) => a - b).join());
const isHost = (p) => p.evaluate(() => !document.getElementById('size-sel').classList.contains('hidden'));

(async () => {
  const env = await h.start();
  const host = await env.page('Alice');
  await host.context().addInitScript(instrument);
  await host.goto(env.url);
  await h.joinAs(host, 'Alice');
  await host.waitForSelector('.item.pile .count');
  const guest = await env.page('Bob');
  await guest.goto(host.url());
  await h.joinAs(guest, 'Bob');
  await guest.waitForSelector('.item.pile .count', { timeout: 30000 });
  const id = await room(host);

  section('NET-13: decks are saved once, the state on its own');
  for (let k = 0; k < 4; k++) { await guest.dblclick('.item.pile'); await h.waitHand(guest, k + 1); }
  await h.sleep(1500);
  const w = await host.evaluate(() => window.__w);
  const store = await host.evaluate((id) => ({ save: localStorage.getItem(`ct-save-${id}`), decks: localStorage.getItem(`ct-decks-${id}`) }), id);
  ok(!!store.decks && Object.keys(JSON.parse(store.decks)).length === 1, 'the deck data lives in ct-decks-<room>');
  ok(!!store.save && !('decks' in JSON.parse(store.save)) && Number.isFinite(JSON.parse(store.save).ts), 'ct-save-<room> holds {ts, state} only');
  ok(w['ct-decks'] === 1 && w['ct-save'] >= 2, `play rewrites only the state (decks written ${w['ct-decks']}×, state ${w['ct-save']}×)`);
  await host.click('#add-deck-btn');
  await host.click('#deck-add');
  await logHas(host, 'added deck "Standard"');
  await h.sleep(1500);
  ok((await host.evaluate(() => window.__w['ct-decks'])) === 2, 'adding a deck rewrites the deck store once');

  section('NET-4: an unreadable save resets loudly instead of bricking the room');
  await host.evaluate((id) => sessionStorage.setItem('__corrupt', `ct-save-${id}`), id);
  await host.reload();
  ok(await h.toastHas(host, "Couldn't resume this table", 15000).then(() => true, () => false), 'the host is told why its table was reset');
  await host.waitForSelector('.item.pile .count', { timeout: 15000 });
  ok(await isHost(host) && (await counts(host)) === '52', 'and keeps hosting a fresh table');
  await guest.waitForFunction(() => [...document.querySelectorAll('.item.pile .count')].map((e) => e.textContent).join() === '52', null, { timeout: 30000 })
    .then(() => ok(true, 'the guest follows the restarted host (new epoch, lower seq)'), () => ok(false, 'the guest follows the restarted host (new epoch, lower seq)'));

  section('NET-1: a failed save is never resumed as if it were current');
  await h.waitHand(guest, 0);
  await host.evaluate(() => { window.__quota = true; });
  for (let k = 0; k < 3; k++) { await guest.dblclick('.item.pile'); await h.waitHand(guest, k + 1); }
  ok(await h.toastHas(host, "Can't save this table (browser storage is full)").then(() => true, () => false), 'the host is told the real cause right away');
  await h.sleep(1500);
  ok(await host.evaluate((id) => JSON.parse(localStorage.getItem(`ct-save-${id}`)).lost === 'browser storage is full', id), 'the stale snapshot is replaced by a lost marker');
  await host.reload();
  ok(await h.toastHas(host, "Couldn't resume this table (browser storage is full)", 15000).then(() => true, () => false), 'reloading resets the table loudly (no silent rewind)');
  ok(await isHost(host), 'the tab is still the host');
  await guest.waitForFunction(() => document.querySelectorAll('.item.pile').length === 1 && document.querySelector('.item.pile .count').textContent === '52', null, { timeout: 30000 })
    .then(() => ok(true, "the guest's table matches the host's again"), () => ok(false, "the guest's table matches the host's again"));
  await h.waitHand(guest, 0).then(() => ok(true, "and the guest's hand follows the reset table"), () => ok(false, "and the guest's hand follows the reset table"));

  section('NET-1: a save where only the state write failed recovers fully');
  await h.sleep(1500); // the reset table (decks included) is stored again
  await host.evaluate(() => { window.__quotaSave = true; });
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  ok(await h.toastHas(host, "Can't save this table (browser storage is full)").then(() => true, () => false), 'the host is told the save failed');
  await host.evaluate(() => { window.__quotaSave = false; });
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 2);
  await h.sleep(1500);
  ok(await host.evaluate((id) => !!localStorage.getItem(`ct-decks-${id}`) && !!JSON.parse(localStorage.getItem(`ct-save-${id}`)).state, id), 'once storage frees up, the decks are stored again with the state');
  await host.reload();
  await logHas(host, 'Alice resumed the table', 20000).then(() => ok(true, 'reloading resumes the table'), () => ok(false, 'reloading resumes the table'));
  ok(!(await h.toastHas(host, "Couldn't resume", 3000).then(() => true, () => false)), 'with no "couldn\'t resume" reset');
  await h.waitHand(guest, 2, 30000).then(() => ok(true, "the guest's hand survived the reload"), () => ok(false, "the guest's hand survived the reload"));

  section('NET-2: full storage prunes older rooms oldest first');
  const p2 = await env.page('Carol');
  await p2.context().addInitScript(instrument);
  await p2.goto(`${env.base}/cardtable/cah-cards.js`); // same origin, no app: fill its storage
  const filled = await p2.evaluate(() => {
    localStorage.setItem('ct-hostkey-0ld0', 'keep me');
    let k = 0;
    for (const size of [400000, 40000, 4000, 1000]) {
      for (;;) {
        try { localStorage.setItem(`ct-save-0ld${k}`, JSON.stringify({ ts: 1000 + k, pad: 'x'.repeat(size) })); k++; } catch { break; }
      }
    }
    for (let j = 1; j <= 2; j++) localStorage.removeItem(`ct-save-0ld${k - j}`); // room for keys/pid/name, not for a table
    return k - 2;
  });
  await p2.goto(env.url);
  await h.joinAs(p2, 'Carol');
  await p2.waitForSelector('.item.pile .count');
  ok(await h.toastHas(p2, 'Browser storage was full — deleted 1 old table save', 15000).then(() => true, () => false), 'a new room makes space by deleting the oldest save, and says so');
  const left = await p2.evaluate((n) => ({ oldest: !!localStorage.getItem('ct-save-0ld0'), newest: !!localStorage.getItem(`ct-save-0ld${n - 1}`), key: localStorage.getItem('ct-hostkey-0ld0') }), filled);
  ok(!left.oldest && left.newest, 'only the oldest room was pruned');
  ok(left.key === 'keep me', 'host keys are never pruned');
  await p2.reload();
  await logHas(p2, 'Carol resumed the table', 20000).then(() => ok(true, 'reloading resumes the table (the host is not stranded as a guest of its own room)'), () => ok(false, 'reloading resumes the table (the host is not stranded as a guest of its own room)'));
  ok(await isHost(p2), 'the reloaded tab is the host');

  section('NET-2: saves another tab is writing right now are never pruned');
  const p3 = await env.page('Dave');
  await p3.context().addInitScript(instrument);
  await p3.goto(`${env.base}/cardtable/cah-cards.js`);
  const live = await p3.evaluate(() => {
    let k = 0;
    for (const size of [400000, 40000, 4000, 1000]) {
      for (;;) {
        try { localStorage.setItem(`ct-save-1ive${k}`, JSON.stringify({ ts: Date.now(), pad: 'x'.repeat(size) })); k++; } catch { break; }
      }
    }
    for (let j = 1; j <= 2; j++) localStorage.removeItem(`ct-save-1ive${k - j}`);
    return k - 2;
  });
  await p3.goto(env.url);
  await h.joinAs(p3, 'Dave');
  await p3.waitForSelector('.item.pile .count');
  ok(await h.toastHas(p3, "Can't save this table (browser storage is full)", 15000).then(() => true, () => false), 'the new table says it can\'t be saved');
  ok(await p3.evaluate((n) => Array.from({ length: n }, (_, k) => localStorage.getItem(`ct-save-1ive${k}`)).every(Boolean), live), `all ${live} recently written saves are intact`);
  await env.done();
})().catch(h.crash);
