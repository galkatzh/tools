// Final review, upgrades and mixed versions (a deploy lands while tables are
// open):
//   (1) the version gate names the side that must reload (D304): a guest
//       whose Card Table is newer than the host's is told to ask the host,
//       and the host is told; an older guest is told to reload; a hosting
//       tab that hears another hosting tab of another version says so.
//       Another version is played by a page whose core.js says another
//       PROTO (a route rewrites it, as t-p1-store's module skew does).
//   (2) a guest's catalog follows the host's whole catalog (D305): a box the
//       host's reload lost leaves Bob's 📦, and Bob, who uploaded it, is told.
//   (3) an index.html of the previous Card Table (no #box-btn, app.js with no
//       ?v= and no import() catch) running this app.js: the reload banner,
//       no TypeError, no table (D306).
//   (4) WebKit's pagehide (D308): an IndexedDB write that a pagehide starts
//       never commits there (here: every transaction from then on is a
//       stand-in that writes nothing and never completes). A move just
//       before a reload is kept all the same — the
//       state left pending in localStorage resumes — and with a deck the
//       catalog doesn't hold yet (the pending mark is a seq alone) the host
//       is told the moment was lost, as before.
//   (5) browsers (D307): on an iPhone, a touch on a hand card is never
//       cancelled (WebKit then drops its click: no zoom, no pick for a hand
//       ask — the harness drives Chromium, so this checks the cause); the app
//       loads with no constructable stylesheets (iOS before 16.4); the one-
//       row group bar is centred while it fits, and starts at ✕ once it
//       overflows; a trackpad pinch (Safari's GestureEvents) zooms the table; a
//       game box upload asks for persistent storage.
//   (6) what pages leave pending (D317): three tables, each left at once
//       after a move — Chromium's pagehide write commits, so their pending
//       states stay in localStorage, and the next page's upkeep removes
//       them; one ahead of its save is kept whole while fresh, cut to its
//       seq once over a day old (its room's next boot says the moment was
//       lost); one whose room saved no table goes.
'use strict';
const h = require('./h');
const L = require('./p1-lib');
const A = require('./assets-lib');
const B = require('./p4-lib');
const { pickGame } = require('./stones-lib');
const { ok, section } = h;

/** A page whose Card Table speaks wire version `proto` (its core.js
 *  rewritten), recording its toasts; it never gets a table, so the
 *  watchdog may reload it. */
async function versioned(env, label, proto, ctx) {
  const p = ctx ? await ctx.newPage() : await env.page(label, { watchdog: true });
  p.watchdogOK = true;
  await p.addInitScript(A.toastLog);
  await p.route('**/cardtable/core.js?v=*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace(`export const PROTO = ${h.PROTO};`, `export const PROTO = ${proto};`) });
  });
  return p;
}
/** Waits for a toast on p: one of `texts` (or matching a RegExp). */
const toasted = (p, texts, ms = 20000) => L.until(async () => (await A.toastsSince(p)).some((t) => (texts instanceof RegExp ? texts.test(t) : [texts].flat().includes(t))), ms, 200);

/** Init script: what WebKit does to a host's last save — an IndexedDB
 *  transaction opened as the page goes (from its first visibilitychange to
 *  hidden, or its pagehide) never commits, and nobody hears of it: here it
 *  is a stand-in whose requests and commit go nowhere. */
function dropPagehideSaves() {
  let gone = false;
  const go = () => { gone = true; };
  window.addEventListener('pagehide', go, true); // (before the app's own listeners)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') go(); }, true);
  const tx = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...a) {
    if (!gone) return tx.apply(this, a);
    const store = new Proxy({}, { get: (_, k) => (k === 'index' ? () => store : () => ({})) }); // (requests that never settle)
    return { objectStore: () => store, commit() {}, abort() {} }; // (its oncomplete and onabort are never called)
  };
}

(async () => {
  const env = await h.start();
  const alice = await A.seat(env, 'Alice', env.url, [A.toastLog]);
  const invite = alice.url();
  const bob = await A.seat(env, 'Bob', invite, [A.toastLog]);
  const logOf = () => L.view(alice).then((v) => v.log.map((e) => e.txt).join('\n'));

  section('(1) the version gate names the side that must reload (D304)');
  {
    const log0 = await logOf();
    const nina = await versioned(env, 'Nina', h.PROTO + 1);
    await nina.goto(invite);
    await h.joinAs(nina, 'Nina');
    // (by the host's refusal of her first action; a host that sent her its state first is named the same way)
    ok(await toasted(nina, ['🚫 The host runs an older Card Table — ask them to reload', "The host's page runs an older Card Table — ask the host to reload it"]), 'a guest with a newer Card Table is told the host must reload, not this page');
    ok(await toasted(alice, 'A player has a newer Card Table — reload this page to let them in'), 'and the host is told so');
    ok(!(await A.toastsSince(nina)).some((t) => /reload this page/.test(t)), `Nina is never told to reload her own page (${JSON.stringify(await A.toastsSince(nina))})`);
    const otto = await versioned(env, 'Otto', h.PROTO - 1);
    await otto.goto(invite);
    await h.joinAs(otto, 'Otto');
    ok(await toasted(otto, ['🚫 This table runs a different version of Card Table — reload this page', 'The host runs a newer Card Table — reload this page']), 'a guest with an older Card Table is told to reload');
    await h.sleep(1000);
    const log1 = await logOf();
    ok(log1 === log0, `neither joined the table${log1 === log0 ? '' : ` (the log added: ${JSON.stringify(log1.slice(log0.length))})`}`);
    await nina.context().close();
    await otto.context().close();
    // A second tab of the host's own browser, on another version, opens the table: both host it.
    const tab = await versioned(env, 'Alice', h.PROTO + 1, alice.context());
    await tab.goto(invite);
    ok(await toasted(alice, 'Another tab hosts this table on another Card Table version — close it or reload it'), 'a hosting tab that hears another of another version says so');
    await tab.close();
  }

  section("(2) a guest's catalog follows the host's whole catalog (D305)");
  {
    const room = await alice.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
    const name = 'Harbor Run', boxNamed = (p) => p.evaluate((n) => Object.keys(window.__ct.boxes()).find((id) => window.__ct.boxes()[id].name === n) ?? null, name);
    await bob.evaluate(() => window.__ct.act({ t: 'addBox', box: { name: 'Harbor Run', pieces: [{ id: 'boat', kind: 'token', faces: ['B'] }] } }));
    ok(await L.until(async () => !!(await boxNamed(bob)) && !!(await boxNamed(alice))), `Bob uploads «${name}»: it is on the table`);
    const id = await boxNamed(alice);
    ok(await L.until(async () => (await h.idb(alice, 'catalog')).some((r) => r.room === room && r.id === id)), '…and in the host\'s save');
    // The host's reload loses it (its save never held it: a pagehide that didn't commit, here a record taken out).
    await alice.goto(h.plain(env));
    await alice.evaluate(([room, id]) => new Promise((res, rej) => {
      const r = indexedDB.open('cardtable');
      r.onerror = () => rej(r.error);
      r.onsuccess = () => { const tx = r.result.transaction('catalog', 'readwrite'); tx.objectStore('catalog').delete([room, id]); tx.oncomplete = () => { r.result.close(); res(); }; tx.onabort = () => rej(tx.error); };
    }), [room, id]);
    await alice.goto(invite);
    await alice.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(!(await boxNamed(alice)), 'the host resumed without it');
    ok(await L.until(async () => !(await boxNamed(bob)), 20000), "Bob's 📦 no longer lists it");
    ok(await toasted(bob, `The host's reload lost «${name}» — upload it again`), 'and Bob, who uploaded it, is told to upload it again');
  }

  section('(3) an index.html of the previous Card Table with this app.js (D306)');
  {
    const p = await env.page('Skew', { watchdog: true });
    await p.route('**/cardtable/', async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace('id="box-btn"', 'id="old-btn"').replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="app.js"></script>');
      await route.fulfill({ response: res, body: html });
    });
    await p.goto(env.url);
    const text = await p.waitForSelector('#skew-banner', { timeout: 15000 }).then((el) => el.textContent(), () => '(no banner)');
    ok(text === 'Card Table was updated while this page loaded — reload this page', `the page shows "${text}"`);
    await h.sleep(1000);
    ok(!(await p.isVisible('#name-dialog[open]')) && !/#room~/.test(p.url()), 'and does not start: no name dialog, no room (and no page error: the harness fails on one)');
  }

  section("(4) a pagehide whose save never commits, as in WebKit (D308)");
  {
    const w = await A.seat(env, 'Wes', env.url, [A.toastLog, dropPagehideSaves]);
    const room = await w.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]), pile = await A.pileOf(w, 'Standard');
    const saved = () => h.idb(w, 'saves', room).then((r) => r?.state);
    const settled = () => L.until(async () => (await saved())?.seq === await w.evaluate(() => window.__ct.view().seq), 15000, 200);
    const LOST = "The last moment of play before the reload wasn't saved (the browser closed first)";
    await L.act(w, { t: 'move', id: pile, x: 500, y: 500 });
    ok(await settled(), 'the host has saved its table');
    await L.act(w, { t: 'move', id: pile, x: 520, y: 540 });
    await w.reload(); // (at once: the move's save is not even due yet)
    await w.waitForSelector('.item.pile .count', { timeout: 30000 });
    const it = (await L.view(w)).items[pile];
    ok(it?.x === 520 && it?.y === 540, `a move just before the reload is kept (${JSON.stringify(it && [it.x, it.y])})`);
    ok(await L.until(async () => (await saved())?.items[pile]?.x === 520), 'and saved once the page is back');
    await h.sleep(500);
    ok(!(await A.toastsSince(w)).includes(LOST), 'with no warning');
    // (reloaded as the deck commits: its save is not due for SAVE_DEFER_MS yet)
    await Promise.all([w.waitForNavigation(), w.evaluate(() => window.__ct.act({ t: 'addDeck', deck: { name: 'Late', cards: [{ r: 'A', s: '♠' }] }, x: 300, y: 300 }).then(() => location.reload()))]);
    await w.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await toasted(w, LOST), 'a deck the catalog lacked just before the reload: the state is not kept, and the host is told the moment was lost');
    ok(!(await A.pileOf(w, 'Late')), '(the table is the save\'s, without that deck)');
    // localStorage too full for the state: its seq is still left pending, and the lost moment said
    await w.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).startsWith('ct-pending-') && String(v).length > 100) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return set.call(this, k, v);
      };
    });
    await w.reload();
    await w.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await settled(), '(reloaded with a full localStorage: the table saved)');
    await L.act(w, { t: 'move', id: pile, x: 560, y: 580 });
    await w.reload();
    await w.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await toasted(w, LOST) && (await L.view(w)).items[pile]?.x !== 560, 'a state too big for localStorage: its seq is left pending instead, and the host is told the moment was lost');
  }

  section('(5) browsers (D307)');
  {
    // a touch on a hand card: never cancelled (in WebKit a cancelled pointerdown loses its tap's click); a mouse's is
    const ph = await env.page('Pia', { ctx: { ...h.playwright.devices['iPhone 13'] } });
    await ph.addInitScript(() => { window.__downs = []; window.addEventListener('pointerdown', (e) => { if (e.target.closest?.('#hand')) window.__downs.push(`${e.pointerType}:${e.defaultPrevented}`); }); });
    await ph.goto(env.url);
    await h.joinAs(ph, 'Pia');
    await ph.waitForSelector('.item.pile .count');
    await ph.evaluate(() => window.__ct.act({ t: 'draw', id: Object.keys(window.__ct.view().items).find((id) => window.__ct.view().items[id].k === 'p') }));
    await h.waitHand(ph, 1);
    await ph.tap('.hcard');
    ok(await ph.waitForFunction(() => !document.getElementById('peek').classList.contains('hidden'), null, { timeout: 5000 }).then(() => true, () => false)
      && (await ph.evaluate(() => window.__downs)).join() === 'touch:false', `a tap on a hand card zooms it, its pointerdown not cancelled (${await ph.evaluate(() => window.__downs.join())})`);
    await ph.context().close();
    const d = await env.page('Dee');
    await d.addInitScript(() => { window.__downs = []; window.addEventListener('pointerdown', (e) => { if (e.target.closest?.('#hand')) window.__downs.push(`${e.pointerType}:${e.defaultPrevented}`); }); });
    await d.goto(env.url);
    await h.joinAs(d, 'Dee');
    await d.waitForSelector('.item.pile .count');
    await d.evaluate(() => window.__ct.act({ t: 'draw', id: Object.keys(window.__ct.view().items).find((id) => window.__ct.view().items[id].k === 'p') }));
    await h.waitHand(d, 1);
    await d.click('.hcard');
    ok((await d.evaluate(() => window.__downs)).join() === 'mouse:true', `a mouse's pointerdown on it is cancelled: no selection, no native drag (${await d.evaluate(() => window.__downs.join())})`);
    await d.context().close();
    // no constructable stylesheets (Safari and iOS before 16.4)
    const o = await env.page('Olaf');
    await o.addInitScript(() => {
      Object.defineProperty(window, 'CSSStyleSheet', { value: function CSSStyleSheet() { throw new TypeError('Illegal constructor'); }, configurable: true, writable: true });
      delete Document.prototype.adoptedStyleSheets;
    });
    await o.goto(env.url);
    await h.joinAs(o, 'Olaf');
    ok(await o.waitForSelector('.item.pile .count', { timeout: 15000 }).then(() => true, () => false), 'with no constructable stylesheets the app loads and draws the table');
    const zoomed = await o.evaluate(() => { // a trackpad pinch: Safari's GestureEvents, as plain events with a scale
      const t = document.getElementById('table'), z0 = t.style.transform, r = document.getElementById('table-wrap').getBoundingClientRect();
      for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 1.5], ['gestureend', 1.5]]) document.getElementById('table-wrap').dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      return [z0, t.style.transform];
    });
    const sc = (tf) => +/scale\(([-\d.e]+)/.exec(tf)?.[1];
    ok(sc(zoomed[1]) > sc(zoomed[0]) * 1.4, `a trackpad pinch (gesturechange, scale 1.5) zooms the table (${sc(zoomed[0])} → ${sc(zoomed[1])})`);
    await o.context().close();
    // the one-row group bar: centred while it fits, ✕ in reach once it overflows
    const g = await env.page('Gus', { viewport: { width: 360, height: 740 } });
    await g.goto(env.url);
    await h.joinAs(g, 'Gus');
    await g.waitForSelector('.item.pile .count');
    await pickGame(g, 'backgammon');
    await g.waitForFunction(() => Object.values(window.__ct.view().items).filter((it) => it.k === 'g').length >= 30, null, { timeout: 20000 });
    // One point a space whose checkers Gus may pick, where a checker of it is on top: a Shift+click picks a
    // space's top checker, so a second point on that space put the same checker back, and the other seat's
    // pick nothing — which ones came first followed the random ids, and sometimes left 1 picked.
    const points = () => g.evaluate(() => {
      const v = window.__ct.view(), me = Object.values(v.players).find((pl) => pl.name === 'Gus'), seen = new Set(), out = [];
      for (const el of document.querySelectorAll('#table .item')) {
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, at = document.elementFromPoint(x, y), it = v.items[at?.closest('.item')?.dataset.id];
        const spot = it?.at ?? at?.closest('.item')?.dataset.id;
        if (y > 120 && it?.k === 'g' && !it.lock && (!it.owner || it.owner === `seat:${me?.seatId}`) && !at.closest('.count') && !seen.has(spot)) { seen.add(spot); out.push({ x, y }); }
      }
      return out;
    });
    // (read once the table is still — the same in two reads 300 ms apart — and each pick waited for before the next click)
    let pts = await points();
    for (const t0 = Date.now(); Date.now() - t0 < 10000;) { await h.sleep(300); const again = await points(); if (JSON.stringify(again) === JSON.stringify(pts)) break; pts = again; }
    const bar = () => g.evaluate(() => {
      const b = document.getElementById('action-bar'), r = b.getBoundingClientRect(), btns = [...b.querySelectorAll('button')].filter((x) => x.offsetParent).map((x) => x.getBoundingClientRect());
      b.scrollLeft = 0;
      const left = Math.min(...btns.map((x) => x.left)), right = Math.max(...btns.map((x) => x.right));
      return { row: b.classList.contains('row'), w: b.scrollWidth, over: b.scrollWidth > b.clientWidth + 1, first: [...b.querySelectorAll('button')].filter((x) => x.offsetParent).sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left)[0]?.dataset.cmd,
        gapL: Math.round(left - r.left), gapR: Math.round(r.right - right) };
    });
    await g.keyboard.down('Shift');
    for (const [k, p] of pts.slice(0, 6).entries()) {
      await g.mouse.click(p.x, p.y);
      await g.waitForFunction((n) => document.querySelectorAll('#table .item.selected').length >= n, k + 1, { timeout: 3000 }).catch((err) => console.error(`pick ${k + 1} not shown`, err.message));
    }
    await g.keyboard.up('Shift');
    await h.sleep(600);
    const picked = await g.evaluate(() => document.querySelectorAll('#table .item.selected').length);
    const at = async (width) => { await g.setViewportSize({ width, height: 740 }); await h.sleep(800); return bar(); };
    const fits = await at(800), narrow = fits.w - 60, over = await at(narrow); // (a screen 60 px narrower than the bar: whatever the pick shows)
    ok(picked >= 2 && fits.row && !fits.over && Math.abs(fits.gapL - fits.gapR) <= 2, `${picked} pieces picked, on an 800 px screen the one-row bar fits, centred (${JSON.stringify(fits)})`);
    ok(over.row && over.over && over.first === 'none' && over.gapL >= 0 && over.gapL <= 8, `…on a ${narrow} px one it overflows, and starts at ✕, in reach (${JSON.stringify(over)})`);
    await g.context().close();
    // a game box upload asks for persistent storage, as a deck's does
    const u = await env.page('Uma');
    await u.addInitScript(() => { window.__persist = 0; const sm = navigator.storage, f = sm?.persist; if (f) sm.persist = (...a) => { window.__persist++; return f.apply(sm, a); }; });
    await u.goto(env.url);
    await h.joinAs(u, 'Uma');
    await u.waitForSelector('.item.pile .count');
    await B.upload(u, [B.file('game.json', JSON.stringify({ name: 'Kept', pieces: [{ id: 'k', kind: 'token', faces: ['K'] }] }))]);
    ok(await u.evaluate(() => window.__persist) === 1, `a game box upload asks for persistent storage (${await u.evaluate(() => window.__persist)} call)`);
    await u.context().close();
  }

  section("(6) what pages leave pending goes once nothing needs it (D317)");
  {
    const o = await A.seat(env, 'Ola', env.url, [A.toastLog]), rooms = [];
    const roomOf = () => o.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]);
    const marks = () => o.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('ct-pending-')).map(([k, v]) => [k.slice(11), v])));
    for (let r = 0; r < 3; r++) {
      if (r) { await o.goto(env.url); await o.waitForSelector('.item.pile .count', { timeout: 30000 }); } // (a new table each time)
      const room = await roomOf(), invite = o.url(), pile = await A.pileOf(o, 'Standard');
      ok(await L.until(async () => (await h.idb(o, 'saves', room))?.state?.seq === await o.evaluate(() => window.__ct.view().seq), 15000, 200), `table ${r + 1} is saved`);
      await L.act(o, { t: 'move', id: pile, x: 300 + 40 * r, y: 400 });
      const seq = await o.evaluate(() => window.__ct.view().seq);
      await o.goto(h.plain(env)); // (left at once: pagehide's flushSave)
      rooms.push({ room, invite, seq });
    }
    const saved = (room) => h.idb(o, 'saves', room).then((r) => r?.state?.seq);
    ok(await L.until(async () => (await Promise.all(rooms.map(({ room }) => saved(room)))).every((s, k) => s === rooms[k].seq), 10000, 200), "each table's last save committed (Chromium)");
    const left = await marks();
    ok(rooms.every(({ room, seq }) => JSON.parse(left[room] || '{}').seq === seq && JSON.parse(left[room]).state), `…and each left its whole state pending all the same (${Object.values(left).map((v) => v.length).join(', ')} characters)`);
    // table 2's pending state ahead of its save, left two days ago; table 3's ahead and fresh; a room that saved no table
    const ahead = (k, at) => JSON.stringify({ ...JSON.parse(left[rooms[k].room]), seq: rooms[k].seq + 5, at });
    await o.evaluate(([a, b, c]) => { for (const [k, v] of [a, b, c]) localStorage.setItem(`ct-pending-${k}`, v); },
      [[rooms[1].room, ahead(1, Date.now() - 2 * 864e5)], [rooms[2].room, ahead(2, Date.now())], ['ab'.repeat(12), JSON.stringify({ seq: 9, at: Date.now(), state: {} })]]);
    await o.goto(env.url); // (any page of the app: its upkeep sweeps, 5 s after it settles)
    await o.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await L.until(async () => !(await marks())[rooms[0].room], 20000, 250), 'the next page removes the pending state its save holds');
    const m = await marks();
    ok(!m['ab'.repeat(12)], 'and the one whose room saved no table');
    ok(m[rooms[1].room] === String(rooms[1].seq + 5), `a state ahead of its save, left two days ago, keeps its seq alone (${String(m[rooms[1].room]).slice(0, 20)})`);
    ok(JSON.parse(m[rooms[2].room] || '{}').state && JSON.parse(m[rooms[2].room]).seq === rooms[2].seq + 5, 'a fresh one ahead of its save is kept whole');
    await o.goto(h.plain(env));
    await o.goto(rooms[1].invite); // (a page load: from the last table's page, only the hash would change)
    await o.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await toasted(o, "The last moment of play before the reload wasn't saved (the browser closed first)"), "table 2's next boot says its last moment wasn't saved");
    await o.context().close();
  }

  await env.done();
})().catch(h.crash);
