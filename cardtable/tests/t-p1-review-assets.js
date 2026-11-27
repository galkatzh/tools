// E2E: the image regressions the Phase 1B review found (spec §1b.5, §1c),
// one section each:
//   (1) refused   a guest's deck that is refused — its last image fails a check,
//                 or the rules veto it — leaves none of its images in the host's
//                 memory or storage; a guest's second deck, sent while the first
//                 is ingested, waits for it (one chain per player, §1c); a deck
//                 that commits is held, and saved with its images
//   (2) heal      an image the host lost shows again on the host once the deck is
//                 added again; serving images doesn't make the host keep copies
//   (3) upgrade   another tab upgrades the database: every tab says so, and the
//                 host answers no `missing` for images it can no longer read
//   (4) many      a guest pulls 3,000 images without tripping flood control
//   (5) away      the host leaves for 45 s while a guest waits for images: the
//                 guest doesn't call them missing, and gets them once it is back
'use strict';
const h = require('./h');
const L = require('./p1-lib');
const A = require('./assets-lib');
const { mallory } = require('./final-lib');
const { ok, section } = h;

const MISSING = /card images are missing on the host/;
/** Init script: while window.__slowHash is set, every SHA-256 digest takes 300 ms more (a deck's ingestion lasts). */
function slowHash() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = (...a) => (window.__slowHash ? new Promise((r) => setTimeout(r, 300)).then(() => digest(...a)) : digest(...a));
}
const roomOf = (p) => p.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
const toasts = (p) => A.toastsSince(p, 0);
/** Of images `ids`, those page p's store.js holds in memory (the app's own module instance). */
const inMemory = (p, ids) => h.withStore(p, (S, ids) => ids.filter((id) => S.holds(id)), ids);
/** Of images `ids`, those page p's IndexedDB holds. */
const inDB = async (p, ids) => Object.entries(await A.stored(p, ids)).filter(([, r]) => r).map(([id]) => id);
const distinct = A.distinctPngs;
async function settled(p, ms = 15000) {
  const room = await roomOf(p);
  return L.until(async () => (await h.idb(p, 'saves', room))?.state?.seq === await p.evaluate(() => window.__ct.view().seq), ms, 200);
}
/** How many of deck d's face-up table cards page draws as a decoded image, and as .face.missing. */
const looks = (page, d) => page.evaluate((d) => {
  const els = [...document.querySelectorAll('.item')].filter((el) => { const it = window.__ct.view().items[el.dataset.id]; return it?.k === 'c' && it.d === d && it.up; });
  return { img: els.filter((el) => el.querySelector('img.face')?.naturalWidth > 0).length, missing: els.filter((el) => el.querySelector('.face.missing')).length };
}, d);
const deckOfPile = (page, pile) => page.evaluate((id) => window.__ct.view().items[id]?.top?.d ?? null, pile);
const okWait = async (promise, msg) => ok(await promise.then((x) => x !== false, () => false), msg);

(async () => {
  const env = await h.start();

  // (5) runs alongside the others: most of it is waiting.
  const away = (async () => {
    const kim = await A.seat(env, 'Kim', env.url, [A.hostWire, A.toastLog]);
    const invite = kim.url(), imgs = distinct(2, 99), ids = imgs.map(A.sha256);
    const r = await A.addDeck(kim, A.imgDeck('Away', imgs), 900, 300);
    const d = await deckOfPile(kim, r.pile);
    for (const x of [400, 520]) await L.act(kim, { t: 'deal', id: r.pile, up: true, x, y: 500 });
    await settled(kim); // (its images are stored: the host comes back with them)
    await kim.evaluate(() => { window.__wire.hold = true; }); // the host's image sends never leave
    const jo = await A.seat(env, 'Jo', invite, [A.needLog, A.toastLog]);
    await L.until(async () => { const asked = await A.asked(jo); return ids.every((id) => asked.includes(id)); }, 20000);
    await kim.goto(h.plain(env)); // the host goes away, Jo's requests unanswered
    const t0 = Date.now();
    await h.sleep(45000);
    const meanwhile = (await toasts(jo)).filter((t) => MISSING.test(t));
    await kim.goto(invite); // and comes back
    await kim.waitForSelector('.item.pile .count', { timeout: 30000 });
    const back = await L.until(async () => (await looks(jo, d)).img === 2, 40000, 250);
    return { meanwhile, back, secs: (Date.now() - t0) / 1000, again: (await toasts(jo)).filter((t) => MISSING.test(t)) };
  })().catch((e) => ({ crashed: e.stack }));

  const host = await A.seat(env, 'Alice', env.url, [A.toastLog, slowHash]);
  const invite = host.url();
  await A.seat(env, 'Bob', invite); // (Mallory joins a room with two peers in it)
  const M = await mallory(env, invite);
  await M.act({ t: 'hello' });
  await L.until(() => M.evaluate(() => window.M.got.state.some(({ m }) => JSON.parse(m.b).to === 'ffffffffffffffff')));
  const notes = () => M.evaluate(() => window.M.notes().map((n) => n.msg || ''));

  section('(1) a guest\'s refused deck leaves nothing on the host');
  await (async () => {
    const good = distinct(3, 1), goodIds = good.map(A.sha256);
    await M.act({ t: 'addDeck', deck: A.imgDeck('Bad tail', [...good, A.bomb()]), x: 600, y: 600 });
    await okWait(L.until(async () => (await notes()).some((m) => /^🚫 Deck rejected: card 4: image is 30000 × 30000 px/.test(m))), 'a deck whose last image is a bomb is refused');
    await h.sleep(500);
    ok(!(await inMemory(host, goodIds)).length && !(await inDB(host, goodIds)).length, 'its 3 good images are neither in the host\'s memory nor in its storage');

    await L.act(host, { t: 'setRules', code: '({ name: "NoDecks", validate(t, a) { if (a.t === "addDeck") return "no decks today"; } })', enabled: true });
    const vetoed = distinct(3, 2), vetoedIds = vetoed.map(A.sha256);
    await M.act({ t: 'addDeck', deck: A.imgDeck('Vetoed', vetoed), x: 600, y: 600 });
    await okWait(L.until(async () => (await notes()).includes('🚫 no decks today')), 'a deck the rules veto is refused');
    await h.sleep(500);
    ok(!(await inMemory(host, vetoedIds)).length && !(await inDB(host, vetoedIds)).length, 'and leaves none of its images on the host either');
    const used = (await L.saved(host))?.state?.guestDeckChars ?? 0;
    ok(!used, `neither deck took any of the guests' deck budget (${used})`);
    await L.act(host, { t: 'setRules', enabled: false });

    const [one, two] = [distinct(4, 3), distinct(2, 4)], oneIds = one.map(A.sha256);
    await host.evaluate(() => { window.__slowHash = true; }); // One's ingestion takes a while
    await M.evaluate(async ([a, b]) => { // Two right behind One (all of One sent first: Trystero interleaves the chunks of two sends)
      await window.M.act({ t: 'addDeck', deck: a, x: 500, y: 600 });
      window.M.act({ t: 'addDeck', deck: b, x: 700, y: 600 });
    }, [A.imgDeck('One', one), A.imgDeck('Two', two)]);
    await okWait(L.until(async () => !!(await A.pileOf(host, 'One'))), 'the first one is added');
    await host.evaluate(() => { window.__slowHash = false; });
    await okWait(L.until(async () => !!(await A.pileOf(host, 'Two'))), 'and the second one, sent while the first was ingested, after it');
    const order = (await L.view(host)).log.map((e) => /^added deck "(One|Two)"/.exec(e.txt)?.[1]).filter(Boolean);
    ok(L.same(order, ['One', 'Two']) && !(await notes()).some((m) => /One|Two|still/.test(m)), `in the order they were sent, neither refused (${JSON.stringify(order)})`);
    await okWait(L.until(async () => (await inMemory(host, oneIds)).length === 4), 'the host holds the added deck\'s images');
    ok(await settled(host) && (await inDB(host, oneIds)).length === 4, 'and stores them with the save that writes the deck');
  })().catch((e) => ok(false, `(1) crashed: ${e.stack}`));

  section('(2) a lost image shows again once its deck is added again; serving keeps no copies');
  await (async () => {
    const imgs = distinct(2, 5), ids = imgs.map(A.sha256), deck = A.imgDeck('Heal', imgs);
    const r = await A.addDeck(host, deck, 300, 300), d = await deckOfPile(host, r.pile);
    for (const x of [300, 420]) await L.act(host, { t: 'deal', id: r.pile, up: true, x, y: 700 });
    ok(await settled(host), 'a deck of 2 images is saved');
    await h.withStore(host, (S, id) => new Promise((res, rej) => {
      const o = indexedDB.open('cardtable');
      o.onsuccess = () => { const t = o.result.transaction('assets', 'readwrite'); t.objectStore('assets').delete(id); t.oncomplete = () => { o.result.close(); res(); }; t.onabort = () => rej(t.error); };
    }), ids[0]);
    await host.reload();
    await host.waitForSelector('.item.pile .count', { timeout: 30000 });
    await okWait(L.until(async () => { const w = await looks(host, d); return w.missing === 1 && w.img === 1; }), 'after a reload, the host draws the image it lost as missing');
    ok((await A.addDeck(host, deck, 300, 300)).ok, 'the host adds the deck again');
    await okWait(L.until(async () => { const w = await looks(host, d); return w.img === 2 && !w.missing; }), 'and the card it showed as missing shows its image again');

    // Serving: a deck whose cards stay face down is never drawn on the host.
    const down = distinct(3, 6), downIds = down.map(A.sha256);
    await A.addDeck(host, A.imgDeck('Down', down), 900, 900);
    ok(await settled(host), 'a face-down deck of 3 images is saved');
    await host.reload();
    await host.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(!(await inMemory(host, downIds)).length, 'after a reload the host holds none of its images in memory');
    const bea = await A.seat(env, 'Bea', invite, [A.needLog]);
    await okWait(L.until(async () => (await inDB(bea, downIds)).length === 3, 20000), 'a guest pulls them');
    ok(!(await inMemory(host, downIds)).length, 'and the host still holds no copy of them in memory');
    await bea.context().close();
  })().catch((e) => ok(false, `(2) crashed: ${e.stack}`));

  section('(3) a database upgrade in another tab');
  await (async () => {
    const imgs = distinct(3, 7), ids = imgs.map(A.sha256);
    await A.addDeck(host, A.imgDeck('Up', imgs), 600, 900);
    ok(await settled(host), 'a face-down deck of 3 images is saved');
    await host.reload();
    await host.waitForSelector('.item.pile .count', { timeout: 30000 });
    const cy = await A.seat(env, 'Cy', invite, [A.toastLog]);
    const upgrade = (p) => p.context().newPage().then(async (tab) => {
      await tab.goto(h.plain(env));
      const r = await tab.evaluate(() => new Promise((res) => { const o = indexedDB.open('cardtable', 2); o.onsuccess = () => { o.result.close(); res('upgraded'); }; o.onerror = () => res(`failed: ${o.error}`); }));
      await tab.close();
      return r;
    });
    ok(await upgrade(host) === 'upgraded' && await upgrade(cy) === 'upgraded', 'another tab of the host\'s browser, and of a guest\'s, upgrades the database');
    await okWait(L.until(async () => (await toasts(host)).includes('Card Table was updated in another tab — reload this tab to keep saving')), 'the host says so');
    await okWait(L.until(async () => (await toasts(cy)).includes('Card Table was updated in another tab — reload this tab to keep caching card images')), 'so does the guest');
    const before = (await M.evaluate(() => window.M.notes().filter((n) => n.missing).length));
    await M.act({ t: 'need', a: ids });
    await h.sleep(3000);
    ok((await M.evaluate(() => window.M.notes().filter((n) => n.missing).length)) === before, 'images the host can no longer read are never reported missing');
    await cy.context().close();
  })().catch((e) => ok(false, `(3) crashed: ${e.stack}`));

  section('(4) a guest pulls 3,000 images');
  await (async () => {
    const xo = await A.seat(env, 'Xo', env.url, [A.toastLog]);
    const imgs = distinct(3000, 8), ids = imgs.map(A.sha256);
    ok((await A.addDeck(xo, A.imgDeck('Many', imgs), 600, 600)).ok, 'a host adds a deck of 3,000 images');
    const zed = await A.seat(env, 'Zed', xo.url(), [A.needLog, A.toastLog]);
    const t0 = Date.now();
    await okWait(L.until(async () => (await h.idb(zed, 'assets')).length >= 3000, 120000, 1000), 'a guest pulls all of them');
    console.log(`  pulled in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const reqs = await zed.evaluate(() => window.__needs);
    const asked = reqs.flatMap((n) => n.a), once = new Set(asked);
    ok(reqs.every((n) => n.a.length <= 64) && asked.length === 3000 && once.size === 3000 && ids.every((id) => once.has(id)), `in ${reqs.length} requests of ≤ 64 ids, each id once`);
    ok(!(await toasts(zed)).some((t) => /Too many actions/.test(t)), 'without ever tripping the host\'s flood control');
    await zed.context().close();
    await xo.context().close();
  })().catch((e) => ok(false, `(4) crashed: ${e.stack}`));

  section('(5) the host leaves for 45 s while a guest waits for images');
  const r5 = await away;
  if (r5.crashed) ok(false, `(5) crashed: ${r5.crashed}`);
  else {
    ok(!r5.meanwhile.length, `while the host is away, the guest never calls its images missing (${JSON.stringify(r5.meanwhile)})`);
    ok(r5.back && !r5.again.length, `once it is back, the guest draws them (${r5.secs.toFixed(0)} s after it left), still never calling them missing`);
  }

  await env.done();
})().catch(h.crash);
