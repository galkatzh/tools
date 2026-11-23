// E2E: card images pulled by hash (spec §1b.5), late arrivals (§1g), and the
// attacker cases on images (§1j cases 2, 8, 9) — spec §1l t-p1-assets:
//   (1) pull      a guest joins and asks the host for the decks' images (≤ 64
//                 ids a request); every format renders, and is cached by hash
//   (2) warm      the guest reloads: 0 asset bytes, and no request (B8)
//   (3) damaged   the host's send flips a byte: the guest says so, asks once
//                 more, and renders the image; damaged twice, it gives up
//                 (an error toast, .face.missing)
//   (7)+(4) late  the host's image sends are held ≥ 2 s: a card in the guest's
//                 hand and one on the table show .face.loading, then their
//                 image, and so do an open zoom and a pile's image back;
//                 nothing else redraws. Mean-
//                 while Mallory (a raw peer) sends the guest a mismatched
//                 image, the right bytes of one it is waiting for, and one
//                 nobody asked for: all ignored, with console.warn, no toast
//   (6) case 8    another room's image, held by the host: Mallory's request for
//                 it gets neither the image nor a `missing` note
//       case 9    a PNG declaring 30,000 × 30,000 px: refused in Mallory's
//                 addDeck, and when the host's send swaps it in for a guest's
//                 image; no page ever decodes it
//   (5) upload    a guest adds an image deck (the deck dialog): no image bytes
//                 come back to it; another guest pulls them
//   (8) missing   an image deleted from the host's storage: the host's boot
//                 check, a `missing` note, .face.missing and a toast; with the
//                 note suppressed, the guest gives up after 20 s and one retry
//   (9) pacing    during a 34 MB pull, the host's moves reach the pulling guest
//                 in ≤ 1 s each: a timing budget, so this suite runs alone,
//                 in run-all.sh's SERIAL list (in the parallel batch, a CPU-
//                 starved transport alone once took a move 1.7 s, with no long
//                 task on either page)
// (§1j case 3, 1,000 `need` requests, is t-p1-flood.js: its budget is a host
// long task under 50 ms, so it runs alone too.)
// Images are made in code (assets-lib.js), so every asset id — the SHA-256 of
// the bytes — is known here, independently of the app.
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./h');
const L = require('./p1-lib');
const A = require('./assets-lib');
const { mallory } = require('./final-lib');
const { ok, section } = h;

// The texts spec §1b.5 gives.
const DAMAGED = 'A card image from the host was damaged in transit — retrying';
const MISSING = (n) => `${n} card images are missing on the host — ask them to re-add the deck`;
const BOOT_MISSING = (n) => `${n} card images of this table are missing from this browser's storage`;
const SLOW = '🚫 Too many image requests — slow down';
const BOMB_RE = /🚫 Deck rejected: card \d+: image is 30000 × 30000 px \(max 4096 per side, 16 Mpx\)/;
const FIX = path.join(__dirname, 'fixtures');
const FORMATS = [['37x23.png', 'image/png'], ['37x23-baseline.jpg', 'image/jpeg'], ['37x23-progressive.jpg', 'image/jpeg'],
  ['37x23.gif', 'image/gif'], ['37x23-vp8.webp', 'image/webp'], ['37x23-vp8l.webp', 'image/webp'], ['37x23-vp8x.webp', 'image/webp']];

/** Runs one section; a throw fails it (naming it) instead of ending the suite. */
async function guard(what, fn) {
  try { await fn(); } catch (e) { ok(false, `${what} crashed: ${e.stack || e}`); }
}
/** How many of deck d's cards page shows face up on the table, drawn from a blob: image that decoded. */
const drawn = (page, d) => page.evaluate((d) => [...document.querySelectorAll('.item')].filter((el) => {
  const it = window.__ct.view().items[el.dataset.id], side = it && (it.k === 'c' ? it : it.top), img = el.querySelector('img.face');
  return side?.d === d && side.up && img?.src.startsWith('blob:') && img.complete && img.naturalWidth > 0;
}).length, d);
/** Each of deck d's face-up table cards on page: {i, state: 'img' | 'loading' | 'missing' | '?', w: natural width}. */
const sides = (page, d) => page.evaluate((d) => [...document.querySelectorAll('.item')].flatMap((el) => {
  const it = window.__ct.view().items[el.dataset.id];
  if (it?.k !== 'c' || it.d !== d || !it.up) return [];
  const img = el.querySelector('img.face');
  const state = img?.src.startsWith('blob:') && img.complete && img.naturalWidth > 0 ? 'img'
    : el.querySelector('.face.loading') ? 'loading' : el.querySelector('.face.missing') ? 'missing' : '?';
  return [{ i: it.i, state, w: img?.naturalWidth ?? 0 }];
}), d);
/** The deck shown by the pile `pile` on page (its top card's deck). */
const deckOfPile = (page, pile) => page.evaluate((id) => window.__ct.view().items[id]?.top?.d ?? null, pile);
/** Deals every card of `pile` face up, in a row from (x, y). */
async function dealAll(host, pile, x, y) {
  const n = (await L.view(host)).items[pile].n;
  for (let k = 0; k < n; k++) await L.act(host, { t: 'deal', id: pile, up: true, x: x + (k % 8) * 110, y: y + Math.floor(k / 8) * 150 });
}
const count = (list, x) => list.filter((y) => y === x).length;
const b64 = (buf) => Buffer.from(buf).toString('base64');

(async () => {
  const env = await h.start();
  const host = await A.seat(env, 'Alice', env.url, [A.hostWire, A.toastLog, A.decodeWatch]);
  const invite = host.url();
  const room = invite.match(/#room~([0-9a-f]+)/)[1];
  const guestHooks = [A.needLog, A.toastLog, A.decodeWatch];

  // The decks: one image of each format the app takes (the 37 × 23 fixtures),
  // and 66 small PNGs (more than one request holds).
  const fmt = FORMATS.map(([f, mime]) => ({ buf: fs.readFileSync(path.join(FIX, f)), mime }));
  const fmtIds = fmt.map((x) => A.sha256(x.buf));
  const many = A.tinyPngs(66, 1), manyIds = many.map(A.sha256);
  let fmtDeck = null, manyDeck = null, bob = null, M = null, tamIds = [], tamDeck = null, lateIds = [], swapId = null;
  // The standard deck the host's table starts with: a card dealt from it moves in (9).
  const stdPile = Object.entries((await L.view(host)).items).find(([, it]) => it.k === 'p')[0];

  await guard('setup', async () => {
    const f = await A.addDeck(host, A.imgDeck('Formats', fmt.map((x) => x.buf), fmt.map((x) => x.mime)), 200, 900);
    const m = await A.addDeck(host, A.imgDeck('Many', many), 900, 900);
    ok(f.ok && f.pile && m.ok && m.pile, 'the host adds a deck of the 7 image formats and one of 66 images');
    fmtDeck = await deckOfPile(host, f.pile);
    manyDeck = await deckOfPile(host, m.pile);
    await dealAll(host, f.pile, 230, 260);
    ok(await L.until(async () => (await drawn(host, fmtDeck)) === 7), 'the host draws its own 7 faces');
  });

  section('(1) a guest joins and pulls the images by hash');
  await guard('(1)', async () => {
    bob = await A.seat(env, 'Bob', invite, guestHooks);
    ok(await L.until(async () => (await drawn(bob, fmtDeck)) === 7, 30000), 'Bob draws all 7 faces');
    const s = await sides(bob, fmtDeck);
    ok(s.length === 7 && s.every((x) => x.state === 'img' && x.w === 37), `every format decodes, 37 px wide (${s.map((x) => `${FORMATS[x.i][0]}:${x.w}`).join(', ')})`);
    const all = [...fmtIds, ...manyIds];
    ok(await L.until(async () => Object.values(await A.stored(bob, all)).every((r) => r?.ok)), "Bob's IndexedDB holds all 73 images, each under the SHA-256 of its bytes");
    const rec = await A.stored(bob, fmtIds);
    ok(fmtIds.every((id, k) => rec[id].mime === fmt[k].mime && rec[id].size === fmt[k].buf.length), 'each with its MIME type and size');
    const reqs = await bob.evaluate(() => window.__needs.map((n) => n.a));
    const ids = reqs.flat();
    ok(reqs.length >= 2 && reqs.every((a) => a.length >= 1 && a.length <= 64), `requests carry ≤ 64 ids (${reqs.map((a) => a.length).join(' + ')})`);
    ok(all.every((id) => ids.includes(id)) && ids.every((id) => all.includes(id)), 'Bob asked for exactly the 73 ids the decks name');
    ok(ids.length === new Set(ids).size, 'each one once');
    const bytes = await A.assetBytes(bob), payload = [...fmt.map((x) => x.buf), ...many].reduce((n, b) => n + b.length, 0);
    ok(bytes >= payload, `the bytes came on the asset channel (${bytes} B, framing included, for ${payload} B of images)`);
  });

  section('(2) the guest reloads: its cache answers (B8)');
  await guard('(2)', async () => {
    await bob.reload();
    await bob.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await L.until(async () => (await drawn(bob, fmtDeck)) === 7, 30000), 'Bob draws the 7 faces again');
    await h.sleep(2000); // a request would be on its way by now
    ok((await A.assetBytes(bob)) === 0, 'with 0 asset bytes received');
    ok((await A.asked(bob)).length === 0, 'and no image asked for');
  });

  section('(3) a transfer damaged on the way');
  await guard('(3)', async () => {
    const tam = A.tinyPngs(2, 2);
    tamIds = tam.map(A.sha256);
    await host.evaluate(() => { window.__wire.tamper = 1; });
    const t0 = Date.now();
    const r = await A.addDeck(host, A.imgDeck('Tamper', tam), 1000, 300);
    tamDeck = await deckOfPile(host, r.pile);
    await dealAll(host, r.pile, 760, 520);
    ok(await L.until(async () => (await drawn(bob, tamDeck)) === 2, 30000), 'Bob draws both images in the end');
    const hit = await host.evaluate(() => window.__wire.tampered);
    ok(hit.length === 1 && tamIds.includes(hit[0]), 'the host’s send damaged one of them (its last byte flipped)');
    const toasts = await A.toastsSince(bob, t0);
    ok(count(toasts, DAMAGED) === 1, `Bob shows "${DAMAGED}" once (${JSON.stringify(toasts)})`);
    ok(bob.logs.some((x) => x.type === 'error' && x.at >= t0), 'and logs a console.error');
    const ids = (await bob.evaluate((t) => window.__needs.filter((n) => n.at >= t).flatMap((n) => n.a), t0));
    ok(count(ids, hit[0]) === 2 && count(ids, tamIds.find((x) => x !== hit[0])) === 1, 'he asked again for the damaged image only, once');
    const rec = await A.stored(bob, tamIds);
    ok(tamIds.every((id, k) => rec[id]?.ok && rec[id].size === tam[k].length), 'and stored the true bytes of both');
  });
  await guard('(3) twice', async () => {
    const [img] = A.tinyPngs(1, 4), id = A.sha256(img);
    await host.evaluate(() => { window.__wire.tamper = 2; }); // the image, and its one retry
    const t0 = Date.now();
    const r = await A.addDeck(host, A.imgDeck('Tamper twice', [img]), 1000, 500);
    const d = await deckOfPile(host, r.pile);
    await L.act(host, { t: 'deal', id: r.pile, up: true, x: 980, y: 520 });
    ok(await L.until(async () => (await sides(bob, d))[0]?.state === 'missing', 30000), 'damaged twice, the image shows as .face.missing on Bob');
    await h.sleep(1000);
    const toasts = await A.toastsSince(bob, t0);
    ok(count(toasts, DAMAGED) === 1 && toasts.length >= 2 && toasts.at(-1) !== DAMAGED, `after one "retrying" toast he gives up with another (${JSON.stringify(toasts)})`);
    ok(count(await bob.evaluate((t) => window.__needs.filter((n) => n.at >= t).flatMap((n) => n.a), t0), id) === 2, 'having asked for it twice in all');
    ok((await A.stored(bob, [id]))[id] === null, 'and stored neither copy');
  });

  await host.evaluate(() => { window.__wire.tamper = 0; });

  section('(7) late arrival, and (4) Mallory’s images, while the host’s sends are held');
  await guard('(7)+(4)', async () => {
    M = await mallory(env, invite);
    await M.act({ t: 'hello' });
    ok(await L.until(() => M.evaluate(() => window.M.got.state.some(({ m }) => JSON.parse(m.b).to === 'ffffffffffffffff'))), 'Mallory (a raw peer) is seated');
    const late = A.tinyPngs(3, 3), back = A.png(20, 28, { rgb: [30, 60, 160] }), backId = A.sha256(back);
    lateIds = late.map(A.sha256);
    await host.evaluate(() => { window.__wire.hold = true; });
    const r = await A.addDeck(host, { ...A.imgDeck('Late', late), back: A.dataURL(back) }, 1000, 700); // an image back too
    const lateDeck = await deckOfPile(host, r.pile);
    ok(await L.until(async () => { const ids = await A.asked(bob); return [...lateIds, backId].every((id) => ids.includes(id)); }), 'Bob asks for the 3 new faces and the back');
    const askedAt = await bob.evaluate(() => window.__needs.at(-1).at);
    await L.act(bob, { t: 'draw', id: r.pile });
    await L.act(host, { t: 'deal', id: r.pile, up: true, x: 560, y: 640 });
    ok(await L.until(async () => { const v = await L.view(bob); return v.hand.some((c) => c.d === lateDeck) && Object.values(v.items).some((it) => it.k === 'c' && it.d === lateDeck); }),
      'a card of it reaches Bob’s hand, another his table');
    await bob.click('.hcard');
    const look = () => bob.evaluate((d) => {
      const tableEl = [...document.querySelectorAll('.item')].find((el) => window.__ct.view().items[el.dataset.id]?.d === d);
      const state = (el) => (!el ? 'none' : el.querySelector('img.face[src^="blob:"]') ? 'img' : el.querySelector('.face.loading') ? 'loading' : el.querySelector('.face.missing') ? 'missing' : '?');
      return { hand: state(document.querySelector('.hcard')), table: state(tableEl), zoom: document.getElementById('peek').classList.contains('hidden') ? 'closed' : state(document.getElementById('peek-inner')) };
    }, lateDeck);
    const before = await look();
    ok(!(await bob.evaluate((id) => document.querySelector(`.item[data-id="${id}"] img`), r.pile)), 'the face-down pile has no back image yet');
    ok(before.hand === 'loading' && before.table === 'loading' && before.zoom === 'loading', `hand, table and open zoom show .face.loading (${JSON.stringify(before)})`);
    // Nodes that must survive the arrival: another deck's drawn face, and the standard pile.
    await bob.evaluate(([d, m]) => {
      window.__keep = [...document.querySelectorAll('.item')].filter((el) => window.__ct.view().items[el.dataset.id]?.d === d).map((el) => el.querySelector('img.face'))[0];
      window.__keepPile = [...document.querySelectorAll('.item.pile')].find((el) => window.__ct.view().items[el.dataset.id]?.top?.d === m)?.firstElementChild;
    }, [fmtDeck, manyDeck]);

    // (4) Mallory, to everyone: another image's bytes under an id Bob waits for,
    // the right bytes of another id he waits for, and an image nobody asked for.
    const v = await L.view(bob);
    const inHand = v.hand.find((c) => c.d === lateDeck).i, onTable = Object.values(v.items).find((it) => it.k === 'c' && it.d === lateDeck).i;
    const stray = A.png(31, 17, { rgb: [1, 2, 3] }), strayId = A.sha256(stray);
    const warns0 = bob.logs.filter((x) => x.type === 'warning').length, tM = Date.now();
    await M.evaluate(([sends]) => {
      const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      for (const [data, id] of sends) window.M.send.asset(bytes(data), null, { h: id, mime: 'image/png' });
    }, [[[b64(late[(inHand + 1) % 3]), lateIds[inHand]], [b64(late[onTable]), lateIds[onTable]], [b64(stray), strayId]]]);
    await h.sleep(Math.max(1500, 2000 - (Date.now() - askedAt)));
    ok((await A.toastsSince(bob, tM)).length === 0, 'Mallory’s images make Bob show no toast');
    ok(bob.logs.filter((x) => x.type === 'warning').length - warns0 >= 3, `and he logs them with console.warn (${bob.logs.filter((x) => x.type === 'warning').length - warns0})`);
    const mid = await look();
    ok(mid.hand === 'loading' && mid.table === 'loading', `he took none of them: still loading (${JSON.stringify(mid)})`);
    const rec = await A.stored(bob, [...lateIds, strayId]);
    ok(Object.values(rec).every((x) => x === null), 'and stored none of them');
    ok((await A.asked(bob)).filter((id) => lateIds.includes(id)).length === 3, 'nor asked again for any');

    ok(Date.now() - askedAt >= 2000, 'the host’s image sends were held ≥ 2 s');
    ok((await host.evaluate(() => window.__wire.release())) > 0, 'then they go out');
    ok(await L.until(async () => { const x = await look(); return x.hand === 'img' && x.table === 'img' && x.zoom === 'img'; }, 15000),
      'the hand card, the table card and the open zoom redraw with the image');
    ok(await L.until(() => bob.evaluate((id) => !!document.querySelector(`.item[data-id="${id}"] img.back[src^="blob:"]`), r.pile)), 'and the face-down pile with its image back');
    ok(await bob.evaluate(() => !!window.__keep && document.contains(window.__keep) && !!window.__keepPile && document.contains(window.__keepPile)),
      'other items were not redrawn (another deck’s face, the standard pile)');
    const after = await A.stored(bob, [...lateIds, strayId]);
    ok(lateIds.every((id, k) => after[id]?.ok && after[id].size === late[k].length) && after[strayId] === null, 'Bob stored the host’s true bytes, and never Mallory’s stray image');
    await bob.keyboard.press('Escape');
  });
  await host.evaluate(() => window.__wire.release()); // (held frames go out whatever failed above)

  section('(6) 1j case 8: another room’s image, held by this host');
  await guard('(6) case 8', async () => {
    const other = A.png(40, 30, { rgb: [10, 200, 120] }), otherId = A.sha256(other);
    const p2 = await host.context().newPage(); // the host's browser, another tab
    await p2.goto(h.plain(env));
    await h.withStore(p2, (S, data) => S.putAsset(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), 'image/png'), b64(other));
    await h.plantSave(p2, 'f00dfeedf00dfeed', { v: 2, seq: 3, size: 1300, items: {}, players: {}, keys: {}, log: [], guestDeckChars: 0, zMax: 0 },
      { abcd1234: { name: 'Other', back: null, imgs: [otherId], cards: [{ g: 0 }] } }, Date.now() - 3600e3);
    await p2.close();
    ok((await A.stored(host, [otherId]))[otherId]?.ok, "the host's storage holds an image of another room (its catalog names it)");
    const got = () => M.evaluate(() => (window.M.got.asset || []).map((x) => x.metadata?.h));
    const missingNotes = () => M.evaluate(() => window.M.got.note.map(({ m }) => (typeof m.b === 'string' ? JSON.parse(m.b) : m)).filter((n) => n.missing).length);
    const warns0 = host.logs.filter((x) => x.type === 'warning').length;
    await M.act({ t: 'need', a: [otherId] });
    await h.sleep(1500);
    await M.act({ t: 'need', a: [otherId, fmtIds[0]] }); // with one this table shows: the request itself is served
    ok(await L.until(async () => (await got()).includes(fmtIds[0]), 10000), 'Mallory gets the image of this table she asked for');
    await h.sleep(1500);
    ok(!(await got()).includes(otherId), 'but never the other room’s');
    ok((await missingNotes()) === 0, 'and no `missing` note about it either');
    ok(host.logs.filter((x) => x.type === 'warning').length > warns0, 'the host logs a console.warn');
    // §1j: `need` requires a registered player — an anonymous one (no seat) gets nothing.
    await M.evaluate(([v, id]) => window.M.send.act({ _v: v, t: 'need', a: [id] }), [h.PROTO, fmtIds[1]]);
    await h.sleep(1500);
    ok(!(await got()).includes(fmtIds[1]), 'an anonymous `need` (no seat) gets nothing either');
  });

  section('(6) 1j case 9: a PNG that declares 30,000 × 30,000 px');
  const bomb = A.bomb(), bombId = A.sha256(bomb);
  await guard('(6) case 9 addDeck', async () => {
    ok(bomb.length <= 1024, `the bomb is ${bomb.length} bytes`);
    const t0 = Date.now();
    await M.act({ t: 'addDeck', deck: A.imgDeck('Bomb', [bomb]), x: 600, y: 600 });
    const told = () => M.evaluate(() => window.M.notes().map((n) => n.msg || ''));
    ok(await L.until(async () => (await told()).some((m) => BOMB_RE.test(m)), 15000), `Mallory's addDeck is refused: "${(await told()).find((m) => BOMB_RE.test(m)) || (await told()).join(' | ')}"`);
    await h.sleep(500);
    ok(!(await host.evaluate(() => window.__ct.log().some((e) => /Bomb/.test(e.txt)))) && !(await A.pileOf(host, 'Bomb')) && !(await A.pileOf(bob, 'Bomb')), 'no deck is added');
    ok((await A.stored(host, [bombId]))[bombId] === null, 'and the host stores nothing of it');
    ok(host.logs.some((x) => x.type === 'error' && x.at >= t0), 'the host logs a console.error');
  });
  await guard('(6) case 9 injected', async () => {
    const real = A.tinyPngs(1, 5)[0], realId = (swapId = A.sha256(real));
    await host.evaluate((data) => { window.__wire.swap = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); }, b64(bomb));
    const t0 = Date.now();
    const r = await A.addDeck(host, A.imgDeck('Swap', [real]), 300, 560);
    const swapDeck = await deckOfPile(host, r.pile);
    await L.act(host, { t: 'deal', id: r.pile, up: true, x: 420, y: 760 });
    ok(await L.until(() => host.evaluate(() => window.__wire.swapped.length === 1)), 'the host’s send carries the bomb in place of a requested image');
    ok((await host.evaluate(() => window.__wire.swapped[0])) === realId, '(under that image’s id and type)');
    ok(await L.until(async () => (await drawn(bob, swapDeck)) === 1, 30000), 'Bob refuses it, asks again, and draws the real image');
    ok(bob.logs.some((x) => x.type === 'error' && x.at >= t0 && /30000 × 30000/.test(x.text)), "Bob's console.error names the refused size (imageDims on the receive path)");
    ok((await A.toastsSince(bob, t0)).includes(DAMAGED), `as a damaged image: "${DAMAGED}"`);
    const rec = await A.stored(bob, [bombId, realId]);
    ok(rec[bombId] === null && rec[realId]?.ok, 'he stored the real image, never the bomb');
    // The same check guards putAsset itself, whatever the hash: the bomb under its own id.
    const err = await h.withStore(bob, (S, data) => S.putAsset(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), 'image/png').then(() => 'stored', (e) => e.message), b64(bomb));
    ok(/30000 × 30000/.test(err), `store.putAsset refuses it too: "${err}"`);
    for (const [n, p] of [['the host', host], ['Bob', bob]]) ok(!(await A.decodedBomb(p)), `${n} never decoded it (no blob or bitmap of it, no data: image)`);
  });
  await host.evaluate(() => { window.__wire.swap = null; });

  section('(5) a guest adds an image deck from the dialog');
  let carol = null;
  await guard('(5)', async () => {
    carol = await A.seat(env, 'Carol', invite, guestHooks);
    const known = [...fmtIds, ...manyIds, ...tamIds, ...lateIds, swapId];
    ok(await L.until(async () => Object.values(await A.stored(carol, known)).every((x) => x?.ok), 30000), 'Carol pulls the table’s images first');
    let last = -1;
    await L.until(async () => { const n = await A.assetBytes(carol); const still = n === last; last = n; return still; }, 15000, 1000); // and nothing more is coming
    const c0 = await A.assetBytes(carol), n0 = (await A.asked(carol)).length, b0 = (await A.asked(bob)).length;
    const files = A.tinyPngs(2, 7).map((buffer, k) => ({ name: `mine_${k}.png`, mimeType: 'image/png', buffer }));
    await carol.click('#add-deck-btn');
    await carol.waitForSelector('#deck-dialog[open]');
    await carol.check('input[name="deck-kind"][value="img"]');
    await carol.fill('#deck-name', 'Mine');
    await carol.setInputFiles('#deck-files', files);
    await carol.click('#deck-add');
    await h.logHas(host, 'added deck "Mine" (2 cards)');
    const pile = await A.pileOf(host, 'Mine'), mineDeck = await deckOfPile(host, pile);
    await dealAll(host, pile, 230, 560);
    // (the dialog re-encodes uploads: the ids are the host's, read from its catalog)
    let mineIds = [];
    ok(await L.until(async () => { mineIds = (await h.idb(host, 'catalog')).find((c) => c.room === room && c.id === mineDeck)?.deck.imgs || []; return mineIds.length === 2; }), 'the host stores the deck, naming its 2 images by hash');
    ok(await L.until(async () => (await drawn(carol, mineDeck)) === 2, 20000), 'Carol draws her 2 faces');
    ok(await L.until(async () => (await drawn(bob, mineDeck)) === 2, 20000), 'Bob draws them too');
    await h.sleep(1000);
    ok((await A.assetBytes(carol)) === c0, `no image bytes came back to Carol (${(await A.assetBytes(carol)) - c0} B)`);
    ok(!(await A.asked(carol)).slice(n0).some((id) => mineIds.includes(id)), 'she never asked for them: she ingested them herself');
    ok((await A.asked(bob)).slice(b0).filter((id) => mineIds.includes(id)).length === 2, 'Bob, who lacked them, asked the host');
  });
  await carol?.close();

  section('(8) an image the host lost');
  let dave = null;
  await guard('(8) missing', async () => {
    const lost = tamIds[0];
    await h.withStore(host, (S, id) => new Promise((res, rej) => {
      const r = indexedDB.open('cardtable');
      r.onsuccess = () => { const t = r.result.transaction('assets', 'readwrite'); t.objectStore('assets').delete(id); t.oncomplete = () => { r.result.close(); res(); }; t.onabort = () => rej(t.error); };
      r.onerror = () => rej(r.error);
    }), lost);
    ok((await A.stored(host, [lost]))[lost] === null, "one of deck Tamper's images is deleted from the host's IndexedDB");
    await host.reload();
    await host.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await L.until(async () => (await A.toastsSince(host)).includes(BOOT_MISSING(1)), 15000), `the host's boot check says "${BOOT_MISSING(1)}"`);
    const hs = () => sides(host, tamDeck);
    ok(await L.until(async () => { const s = await hs(); return s.length === 2 && s.filter((x) => x.state === 'missing').length === 1 && s.filter((x) => x.state === 'img').length === 1; }),
      `the host draws that card as .face.missing, the other with its image (${JSON.stringify(await hs())})`);
    const t0 = Date.now();
    dave = await A.seat(env, 'Dave', invite, guestHooks);
    ok(await L.until(async () => (await A.toastsSince(dave)).includes(MISSING(1)), 30000), `Dave, who joins, gets a \`missing\` note: "${MISSING(1)}"`);
    const ds = () => sides(dave, tamDeck);
    ok(await L.until(async () => { const s = await ds(); return s.length === 2 && s.filter((x) => x.state === 'missing').length === 1 && s.filter((x) => x.state === 'img').length === 1; }),
      `he draws it as .face.missing, the other with its image (${JSON.stringify(await ds())})`);
    ok(dave.logs.some((x) => x.type === 'error' && x.at >= t0), 'and logs a console.error');
    await h.sleep(1000);
    ok(count(await A.asked(dave), lost) === 1, 'he does not ask for it again');
  });
  await dave?.close();

  section('(8) a `missing` note that never arrives: the guest gives up');
  let erin = null;
  await guard('(8) timeout', async () => {
    const lost = tamIds[0];
    erin = await A.seat(env, 'Erin', invite, [A.needLog, A.toastLog, A.dropMissingNotes]);
    ok(await L.until(() => erin.evaluate((id) => window.__needs.some((n) => n.a.includes(id)), lost), 30000), 'Erin asks for the lost image');
    ok(await L.until(async () => (await A.toastsSince(erin)).includes(MISSING(1)), 80000, 500), `she gives up: "${MISSING(1)}"`);
    const reqs = await erin.evaluate((id) => window.__needs.filter((n) => n.a.includes(id)).map((n) => n.at), lost);
    const gaveUp = await erin.evaluate((s) => window.__toasts.find((x) => x.msg === s).at, MISSING(1));
    console.log(`  asked at +0, +${((reqs[1] - reqs[0]) / 1000).toFixed(1)} s; gave up at +${((gaveUp - reqs[0]) / 1000).toFixed(1)} s`);
    ok(reqs.length === 2 && reqs[1] - reqs[0] >= 19900, 'after asking once more, 20 s or more after the first request');
    ok(gaveUp - reqs[0] >= 39900 && gaveUp - reqs[0] <= 70000, 'and only once that retry went 20 s unanswered too (and not much later)');
    ok((await erin.evaluate(() => window.__droppedMissing)) >= 2, '(the host’s `missing` notes, both suppressed)');
    const s = await sides(erin, tamDeck);
    ok(s.filter((x) => x.state === 'missing').length === 1, `the card shows .face.missing (${JSON.stringify(s)})`);
    ok(erin.logs.some((x) => x.type === 'error'), 'with a console.error');
  });
  await erin?.close();

  section('(9) pacing: the host’s moves reach a guest pulling 34 MB');
  await guard('(9)', async () => {
    const big = A.bigDecks();
    await L.act(host, { t: 'deal', id: stdPile, up: true, x: 300, y: 650 });
    const mover = Object.entries((await L.view(host)).items).filter(([, it]) => it.k === 'c').sort(([, a], [, b]) => b.z - a.z)[0][0];
    await bob.addInitScript(A.paceMonitor, mover);
    // Bob steps away while the host takes the decks in (their ingestion is
    // the host's own work, not the pull's), then comes back and pulls them.
    await bob.goto(h.plain(env));
    for (const [d, imgs] of big.decks.entries()) ok((await A.addDeck(host, A.imgDeck(`Big ${d + 1}`, imgs), 400 + 300 * d, 300)).ok, `the host adds a deck of 9 noise images (${(imgs.reduce((n, b) => n + b.length, 0) / 1e6).toFixed(1)} MB)`);
    await A.startMoves(host, mover);
    await bob.goto(invite);
    await bob.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await L.until(async () => (await A.assetBytes(bob)) >= big.bytes, 60000, 250), `Bob, back, pulls all ${(big.bytes / 1e6).toFixed(1)} MB`);
    const { samples, moves } = await A.stopMoves(host, bob);
    const start = samples.find(([, b]) => b > 0)?.[0], end = samples.find(([, b]) => b >= big.bytes)?.[0];
    const during = moves.filter((m) => m.at >= start && m.at <= end);
    console.log(`  pull: ${((end - start) / 1000).toFixed(2)} s; ${during.length} moves during it, latency at Bob (ms): ${during.map((m) => m.ms).join(', ')}`);
    ok(during.length >= 3, `the host moved ${during.length} times during the pull`);
    ok(during.every((m) => m.ms <= 1000), `each of those moves reached Bob in ≤ 1 s (max ${Math.max(...during.map((m) => m.ms))} ms)`);
    ok(moves.filter((m) => m.at >= start).every((m) => m.ms < Infinity), 'all of them reached him');
    const rec = await A.stored(bob, big.ids);
    ok(big.ids.every((id) => rec[id]?.ok), 'and he stored all 18 images');
  });

  for (const [n, p] of [['the host', host], ['Bob', bob]]) ok((await p.evaluate(() => window.__decode.dataImgs)) === 0, `${n} drew every image from a blob: URL, never a data: URL`);
  await env.done();
})().catch(h.crash);
