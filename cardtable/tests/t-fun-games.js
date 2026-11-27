// E2E (UX-I3): the 🎲 game picker and the non-modal "What are we playing?"
// strip on a brand-new table.
const h = require('./h');
const { ok, section, logHas } = h;
const { shot, MOTION, player, rect, overlap, visible, PILE } = require('./fun-lib');
const { devices } = h.playwright;

(async () => {
  const env = await h.start();

  // ------------------------------------------------------------------ UX-I3
  section('game picker: new-table strip (non-modal) and the 🎲 dialog');
  const host = await player(env, 'Alice', env.url, { ctx: MOTION });
  const url = await host.evaluate(() => location.href);
  ok(await visible(host, '#game-strip'), 'a brand-new table shows the "What are we playing?" strip to the host');
  ok(await visible(host, '#games-btn'), 'the host has a 🎲 Games toolbar button');
  ok(!(await host.$('dialog[open]')), 'the strip is not a modal dialog');
  const strip = (await host.$('#game-strip')) ? await rect(host, '#game-strip') : { l: 0, t: 0, r: 0, b: 0 };
  const covered = [];
  for (const sel of ['#toolbar', '#hand-bar', PILE]) if (overlap(strip, await rect(host, sel))) covered.push(sel);
  const felt = await rect(host, '#table');
  const fc = { l: (felt.l + felt.r) / 2 - 40, r: (felt.l + felt.r) / 2 + 40, t: (felt.t + felt.b) / 2 - 40, b: (felt.t + felt.b) / 2 + 40 };
  if (overlap(strip, fc)) covered.push('felt centre');
  ok(!covered.length, `the strip covers no toolbar, hand, deck or felt centre (${covered.join() || 'clear'})`);
  ok(await host.$$eval('#game-strip .games', (els) => els.length) && await host.$eval('#game-strip .games', (el) => [...el.querySelectorAll('[data-game]')].map((b) => b.dataset.game).join()) === 'holdem,cah,bridge,chess,go9,go19,reversi,draughts,backgammon,dominoes,ranks,turns,dealer,free,custom',
    'the strip offers every shipped game, a free table and a custom script');
  await shot(host, 'desk-strip');
  await host.dblclick(PILE); // the default deck stays usable under the strip
  await h.waitHand(host, 1);
  ok(true, 'the default deck is still double-clickable while the strip shows');

  const guest = await player(env, 'Bob', url, { ctx: MOTION });
  ok(!(await visible(guest, '#game-strip')) && !(await visible(guest, '#games-btn')), 'guests see neither the strip nor the 🎲 button');

  if (!(await visible(host, '#game-strip'))) { ok(false, 'the strip is missing: cannot continue'); await env.done(); }
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 2);
  await host.waitForSelector('#game-strip.compact', { timeout: 5000 }).catch(() => {});
  const seatHits = async (p) => { const s = await rect(p, '#game-strip'), r = []; for (const el of await p.$$('.seat')) { const b = await el.boundingBox(); if (overlap(s, { l: b.x, t: b.y, r: b.x + b.width, b: b.y + b.height })) r.push(await el.textContent()); } return r; };
  const sh = await seatHits(host);
  ok(await visible(host, '#game-strip.compact') && !sh.length, `once others sit down the strip shrinks off the rim: no seat label under it (${sh.join() || 'clear'})`);
  await shot(host, 'desk-strip-guest');
  await host.click('#game-strip-ask'); // its 🎲 opens the full picker
  await host.waitForSelector('#games-dialog[open]');
  await host.click('#games-list [data-game="turns"]');
  await logHas(host, '«Turn order» enabled');
  await logHas(guest, '«Turn order» enabled');
  ok(!(await visible(host, '#game-strip')), 'picking a game hides the strip');
  ok(await host.$eval('#rules-btn', (el) => el.classList.contains('on')), 'the 📜 button shows the rules active');
  ok(await host.evaluate(() => document.getElementById('rules-code').value.includes("name: 'Turn order'")), 'the 📜 dialog holds the script that runs');

  await host.click('#games-btn');
  await host.waitForSelector('#games-dialog[open]');
  const rows = await host.$$eval('#games-list [data-game]', (els) => els.map((b) => ({ k: b.dataset.game, on: b.classList.contains('on'), txt: b.textContent })));
  ok(rows.length === 15 && rows.every((r) => r.txt.length > 20), `the dialog lists each game with a pitch (${rows.length})`);
  ok(rows.find((r) => r.on)?.k === 'turns', 'the running game is marked "playing"');
  ok(/2–8 players/.test(rows.find((r) => r.k === 'holdem').txt) && /4 players/.test(rows.find((r) => r.k === 'bridge').txt), 'entries show the player count');
  await shot(host, 'desk-picker');
  await host.click('#games-list [data-game="free"]');
  await logHas(host, 'rules disabled by Alice');
  ok(!(await host.$('#games-dialog[open]')), 'picking closes the dialog');
  await host.click('#games-btn');
  await host.click('#games-list [data-game="custom"]');
  await host.waitForSelector('#rules-dialog[open]');
  ok(true, '"Custom script…" opens the 📜 rules dialog');
  await host.click('#rules-dialog button[value="cancel"]');

  // (final overlay, INT-1: public.turn follows whoever the round waits on —
  // the answerers while they answer, the Czar only once it is time to judge)
  section('one click starts Cards Against Humanity; the answerers, then the Card Czar, are alerted (public.turn)');
  // Turn order's state was kept by "Free table": switching games asks first
  host.once('dialog', (d) => d.accept().catch((e) => console.error(e)));
  await host.click('#games-btn');
  await host.click('#games-list [data-game="cah"]');
  await logHas(guest, '«Cards Against Humanity» enabled');
  await logHas(guest, 'is the Card Czar');
  const czar = await host.evaluate(() => [...document.getElementById('log').textContent.matchAll(/(\w+) is the Card Czar/g)].at(-1)[1]);
  const czarPage = czar === 'Alice' ? host : guest, other = czar === 'Alice' ? guest : host;
  await other.waitForFunction(() => document.title.startsWith('⏳ Your turn'));
  ok(!(await czarPage.evaluate(() => document.title.includes('Your turn'))), `while answers are due the answerer is alerted, the Czar (${czar}) is not`);
  const pick = await host.evaluate(() => +[...document.getElementById('log').textContent.matchAll(/answer with (\d) card/g)].at(-1)[1]);
  for (let k = 0; k < pick; k++) {
    const n = await h.handCount(other);
    await h.playFromHand(other, 0, 0.4 + k * 0.1, 0.72);
    await h.waitHand(other, n - 1);
  }
  await czarPage.waitForFunction(() => document.title.startsWith('⏳ Your turn'));
  ok(!(await other.evaluate(() => document.title.includes('Your turn'))), `once the answers are in, the Czar (${czar}) is alerted to judge and the answerer no longer is`);
  await host.click('#games-btn');
  ok(await host.$eval('#games-list .on', (el) => el.dataset.game) === 'cah', 'the dialog now marks Cards Against Humanity as playing');
  await host.click('#games-list [data-game="free"]');
  await logHas(guest, 'rules disabled');
  ok(await host.evaluate(() => document.title === 'Card Table'), 'a free table clears the alert');

  // A second fresh table: ✕ dismisses the strip; a reload (resume) never shows it.
  section('iPhone 13 host: the strip stays clear of the deck, hand and toolbar; ✕ dismisses it');
  const solo = await player(env, 'Solo', env.url, { ctx: devices['iPhone 13'] });
  const ps = await rect(solo, '#game-strip');
  const hits = [];
  for (const sel of ['#toolbar', '#hand-bar', PILE]) if (overlap(ps, await rect(solo, sel))) hits.push(sel);
  ok(await visible(solo, '#game-strip') && !hits.length, `phone: the strip covers nothing it must not (${hits.join() || 'clear'})`);
  await shot(solo, 'phone-strip');
  const gus = await player(env, 'Gus', await solo.evaluate(() => location.href), { ctx: devices['iPhone 13'] });
  await solo.waitForFunction(() => document.querySelectorAll('.seat').length === 2);
  await solo.waitForSelector('#game-strip.compact', { timeout: 5000 }).catch(() => {});
  const ph = await seatHits(solo);
  ok(await visible(solo, '#game-strip.compact') && !ph.length, `phone: with a guest the corner chip covers no seat label (${ph.join() || 'clear'})`);
  await shot(solo, 'phone-strip-guest');
  await gus.close();
  await solo.tap('#game-strip-x');
  ok(!(await visible(solo, '#game-strip')), '✕ dismisses the strip');
  await solo.reload();
  await solo.waitForSelector('.item.pile .count');
  ok(!(await visible(solo, '#game-strip')), 'a resumed table does not show the strip again');
  await solo.close();

  await env.done();
})().catch(h.crash);
