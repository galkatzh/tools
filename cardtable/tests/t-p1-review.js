// E2E regressions for what the Phase 1A review found (delta sync on a
// 1,000-card table). Each section names the failure it guards against:
//   order     a guest that joins while the host keeps moving gets every state in
//             order: Trystero chunks each message on its own, so a small patch used
//             to overtake the big snapshot before it, and every patch after was a gap
//   players   a guest's move sends its item and log line, not the mover's player too
//   log       with the action bucket full, a patch appends one log row: no rebuild
//   no-op     an action that does nothing (its target is gone) re-sends what it
//             named, so an optimistic drop snaps back, on a guest and on the host
//   retry     a guest whose snapshot request was refused (flood control) asks again
//             until one arrives, so it converges on a table that has gone quiet
//   flood     a raw peer flooding refused actions that name many items makes the
//             host re-send little to everyone else
//   register  a reloading guest whose registering snapshot (the first addressed
//             to it) is lost still gets its hand back on a quiet table: its next
//             keyed hello asks for a snapshot (no change, so no patch to show a gap)
//   newer     a save from a newer Card Table (planted in IndexedDB): the tab says
//             so for good and still hosts, with no misleading errors after, and the
//             save is left alone
//   skew      a stale module that fails to link, or carries another MODULE_V (core.js,
//             store.js): the page says so (a banner), instead of staying dead or misbehaving
const h = require('./h');
const L = require('./p1-lib');
const { mallory } = require('./final-lib');
const { STATE_V } = require(require('path').join(h.APP_ROOT, 'cardtable/core.js'));
const { ok, section } = h;

/** The throwaway script of spec §1k: 20 standard decks, 1,000 cards dealt face up in a grid. */
const BUILD = `({ name: 'Big table', setup(t) {
  const g = t.geom(), piles = [];
  for (let k = 0; k < 20; k++) piles.push(t.addStandardDeck({ x: g.cx - 50, y: g.cy - 70 }));
  const side = g.r * Math.SQRT2 - 160, x0 = g.cx - side / 2, y0 = g.cy - side / 2;
  let p = 0;
  for (let n = 0; n < 1000; n++) {
    while (!t.item(piles[p])) p++;
    t.deal(piles[p], { x: x0 + (n % 40) * side / 39 - 50, y: y0 + Math.floor(n / 40) * side / 24 - 70, up: true });
  }
} })`;
const cardsOf = (p) => p.evaluate(() => { const v = window.__ct.view(); return Object.keys(v.items).filter((id) => v.items[id].k === 'c').sort(); });
/** Whether two pages show the same public table (items, players and log). */
const sameTable = async (x, y) => { const [a, b] = [await L.view(x), await L.view(y)]; return ['items', 'players', 'log'].every((k) => L.same(a[k], b[k])); };

(async () => {
  const env = await h.start();
  const host = await L.player(env, 'Alice', env.url);
  const bob = await L.player(env, 'Bob', host.url());
  await L.act(host, { t: 'size', size: 2400 });
  await L.act(host, { t: 'setRules', code: BUILD, enabled: true });
  ok(await L.until(async () => (await cardsOf(bob)).length >= 1000, 60000, 500), 'Bob sees the 1,000-card table');

  section('order: a guest joins while the host keeps moving cards');
  const moving = host.evaluate(() => new Promise((done) => { // a move every 5 ms for 7 s (a script, the terminal bridge)
    const v = window.__ct.view(), ids = Object.keys(v.items).filter((id) => v.items[id].k === 'c');
    let k = 0;
    const t = setInterval(() => window.__ct.act({ t: 'move', id: ids[k++ % ids.length], x: 600 + (k % 40) * 12, y: 700 + (k % 7) * 20 }), 5);
    setTimeout(() => { clearInterval(t); done(k); }, 7000);
  }));
  const carol = await L.player(env, 'Carol', host.url());
  const moves = await moving;
  ok(await L.until(() => sameTable(carol, host), 15000), `Carol, who joined during ${moves} host moves, converges on the host's table`);
  const cp = (await L.view(carol)).perf;
  ok(cp.gaps === 0 && cp.patches > 50, `and applied every patch in order: ${cp.patches} patches, ${cp.snaps} snapshots, ${cp.gaps} gaps`);

  section("players: a guest's move carries its item and log line only");
  const cards = await cardsOf(bob);
  await carol.evaluate(() => { window.__rtc.keep = true; window.__rtc.bodies.length = 0; });
  await L.act(bob, { t: 'move', id: cards[5], x: 333, y: 444 });
  ok(await L.until(() => carol.evaluate((id) => window.__ct.view().items[id].x === 333, cards[5])), 'Carol sees the move');
  const bodies = await carol.evaluate(() => window.__rtc.bodies.map((b) => b.body));
  const mv = bodies.find((b) => b.kind === 'patch' && b.items?.[cards[5]]);
  ok(mv && !('players' in mv) && Object.keys(mv.items).length === 1, `the patch Carol got holds ${mv ? Object.keys(mv).filter((k) => !['v', 'kind', 'boot', 'seq', 'base', 'host', 'to', 'tp'].includes(k)).join(', ') : 'nothing'}`);
  await carol.evaluate(() => { window.__rtc.keep = false; });

  section('log: with the action bucket full, a patch appends one row');
  const acts = (await L.view(bob)).log.filter((e) => !e.c && !('n' in e) && !e.k).length;
  ok(acts === 200, `Bob's log holds a full bucket of actions (${acts})`);
  await bob.evaluate(() => {
    window.__logMut = { added: 0, removed: 0 };
    new MutationObserver((ms) => { for (const m of ms) { window.__logMut.added += m.addedNodes.length; window.__logMut.removed += m.removedNodes.length; } })
      .observe(document.getElementById('log'), { childList: true });
  });
  for (let k = 0; k < 3; k++) await L.act(host, { t: 'move', id: cards[10 + k], x: 500 + 40 * k, y: 500 });
  ok(await L.until(() => bob.evaluate((id) => window.__ct.view().items[id].x === 580, cards[12])), 'Bob sees three more moves');
  await h.sleep(300);
  const mut = await bob.evaluate(() => window.__logMut);
  ok(mut.added === 3 && mut.removed === 3, `each appended one row and dropped the oldest (${mut.added} added, ${mut.removed} removed: no rebuild of ~350 rows)`);

  section('no-op: an action whose target is gone re-sends what it named');
  for (const [who, p, a] of [['Bob', bob, { t: 'toPile', pile: 'deadbeef' }], ['the host', host, { t: 'stack', onto: 'deadbeef' }]]) {
    const id = cards[20 + (p === host)];
    const at = await p.evaluate((id) => {
      const el = document.querySelector(`.item[data-id="${id}"]`);
      el.style.left = '5px'; // where an optimistic drop would have left it
      el.style.top = '5px';
      return window.__ct.view().items[id];
    }, id);
    await L.act(p, { ...a, id });
    const back = await L.until(() => p.evaluate(([id, x]) => Math.abs(parseFloat(document.querySelector(`.item[data-id="${id}"]`).style.left) - x) < 0.5, [id, at.x]), 5000);
    ok(back, `${who}'s card dropped on a vanished target is drawn where the table has it again`);
  }

  section('retry: a refused snapshot request is asked again on a quiet table');
  const flood = bob.evaluate(async (id) => {
    for (let k = 0; k < 150; k++) {
      if (k === 70) window.__rtc.drop.push('patch'); // a lost patch, once flood control has no tokens left for the snapshot request
      window.__ct.act({ t: 'rot', id, rot: (k % 4) * 90 });
      await new Promise((r) => setTimeout(r, 10));
    }
    return window.__ct.perf.gaps;
  }, cards[30]);
  const g0 = await flood;
  ok(await L.until(() => sameTable(bob, host), 12000), `after a gap during his own flood (${g0} gaps seen), Bob converges once the table is quiet`);
  ok(await L.until(() => bob.evaluate(() => !document.getElementById('net-status').title.includes('re-syncing')), 5000), 'and the status tooltip no longer says re-syncing');

  section('flood: refused actions naming many items make the host re-send little');
  const M = await mallory(env, host.url());
  await M.act({ t: 'hello' });
  await h.sleep(1500);
  const c0 = await carol.evaluate(() => window.__rtc.recv.state || 0);
  await M.evaluate(async (ids) => {
    for (let k = 0; k < 300; k++) {
      window.M.act({ t: 'rot', id: ids[k % 50], rot: 90, ids: ids.slice(0, 200) });
      if (k % 10 === 9) await new Promise((r) => setTimeout(r, 30));
    }
  }, cards);
  await h.sleep(3000);
  const kb = ((await carol.evaluate(() => window.__rtc.recv.state || 0)) - c0) / 1024;
  ok(kb < 150, `Carol received ${kb.toFixed(0)} KB of states while Mallory sent 300 actions naming 200 items each (≤ 150 KB)`);

  section('register: a reloading guest loses the snapshot that registers it');
  const pile = await host.evaluate(() => Object.keys(window.__ct.view().items).find((id) => window.__ct.view().items[id].k === 'p'));
  for (let k = 0; k < 3; k++) await L.act(carol, { t: 'draw', id: pile });
  ok(await L.until(() => carol.evaluate(() => window.__ct.hand().length === 3)), 'Carol holds 3 cards');
  await carol.addInitScript(() => window.__rtc.drop.push('reg'));
  await carol.reload();
  ok(await L.until(() => carol.evaluate(() => window.__rtc.dropped.includes('snap')), 20000, 200), 'the first snapshot addressed to her is lost on the way');
  const healed = await L.until(async () => (await carol.evaluate(() => window.__ct?.hand().length === 3)) && sameTable(carol, host), 15000, 300);
  ok(healed, `with nothing else moving, Carol gets her 3 cards and the table back (${JSON.stringify(await carol.evaluate(() => ({ hand: window.__ct.hand().length, ...window.__ct.perf })))})`);

  section('newer: a save from a newer Card Table');
  const zed = await env.page('Zed');
  const errs = [];
  zed.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await zed.goto(env.url);
  await h.joinAs(zed, 'Zed');
  await zed.waitForSelector('.item.pile .count');
  const room = zed.url(), id = room.match(/#room~([0-9a-f]+)/)[1];
  await zed.goto(h.plain(env)); // leaving saves the table (pagehide); the app must not run while the save is planted
  const { state } = await h.idb(zed, 'saves', id);
  await h.plantSave(zed, id, { ...state, v: STATE_V + 1 }); // (a version this Card Table doesn't know yet)
  const planted = JSON.stringify(await h.idb(zed, 'saves', id));
  await zed.goto(room);
  await h.toastHas(zed, 'saved by a newer Card Table');
  const n0 = errs.length;
  await h.sleep(3500);
  const toast = await zed.textContent('#toast');
  ok(/This table was saved by a newer Card Table — reload this page/.test(toast), `the tab says so, and it stays up ("${toast}")`);
  ok(errs.length === n0 && !errs.some((e) => /Cannot read properties/.test(e)), `and nothing fails after it (${errs.length - n0} more console errors)`);
  ok(!(await zed.isHidden('#size-sel')), 'the tab still hosts the room (the save proves it)');
  await zed.goto(h.plain(env)); // pagehide
  ok(JSON.stringify(await h.idb(zed, 'saves', id)) === planted, 'the newer save is left byte for byte');

  section('skew: a module from another version');
  for (const [what, file, edit, want] of [
    ['a core.js that lacks an export app.js needs', 'core.js', (src) => src.replace('export const PUBLIC_ACTIONS', 'const PUBLIC_ACTIONS'), /failed to load .*PUBLIC_ACTIONS.* — reload this page/],
    ['a core.js of another MODULE_V', 'core.js', (src) => src.replace('export const MODULE_V = ', 'export const MODULE_V = 1000 + '), /updated while this page loaded — reload this page/],
    ['a store.js of another MODULE_V', 'store.js', (src) => src.replace('export const MODULE_V = ', 'export const MODULE_V = 1000 + '), /updated while this page loaded — reload this page/],
  ]) {
    const p = await env.page('Skewed');
    await p.route(`**/cardtable/${file}?v=*`, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: edit(await res.text()) });
    });
    await p.goto(env.url);
    const shown = await p.waitForSelector('#skew-banner', { timeout: 15000 }).then((el) => el.textContent(), () => '');
    ok(want.test(shown), `${what}: the page shows "${shown}"`);
    ok(!(await p.isVisible('#name-dialog[open]')), 'and does not start');
  }

  await env.done();
})().catch(h.crash);
