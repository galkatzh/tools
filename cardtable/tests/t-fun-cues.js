// E2E (UX-I2, UX-I4): the your-turn alert and the win celebration.
// navigator.vibrate is stubbed per page to record its patterns.
const h = require('./h');
const { ok, section, logHas } = h;
const { shot, MOTION, player, visible, rect, overlap, PILE } = require('./fun-lib');
const { devices } = h.playwright;

(async () => {
  const env = await h.start();
  const host = await player(env, 'Alice', env.url, { ctx: MOTION });
  const url = await host.evaluate(() => location.href);
  const guest = await player(env, 'Bob', url, { ctx: MOTION });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 2);
  await host.dblclick(PILE);
  await h.waitHand(host, 1);

  // ------------------------------------------------------------------ UX-I2
  section('your-turn alert');
  await h.enableRules(host, { tpl: 'turns' });
  await logHas(guest, '«Turn order» enabled');
  // Turn order starts with the first player (Alice, the host).
  await host.waitForFunction(() => document.title.startsWith('⏳ Your turn'), null, { timeout: 8000 }).catch(() => {});
  ok(await host.evaluate(() => document.title.startsWith('⏳ Your turn')), 'the player to act gets "⏳ Your turn" in the tab title');
  ok(await host.$eval('#hand-bar', (el) => el.classList.contains('myturn')), 'their hand bar is highlighted');
  ok(await visible(host, '#turn-cue'), 'a short "Your turn" cue shows');
  ok(await host.evaluate(() => { const el = document.getElementById('turn-cue'); return !!el && getComputedStyle(el).pointerEvents === 'none'; }), 'the cue never blocks clicks');
  ok(await host.evaluate(() => getComputedStyle(document.querySelector('.seat.me.turn')).animationName === 'seat-pulse'), 'their own seat label pulses');
  ok(await host.evaluate(() => window.VIB.some((v) => Array.isArray(v) && v.length === 3)), 'their phone buzzes');
  ok(await guest.evaluate(() => !document.title.includes('Your turn') && !document.getElementById('hand-bar').classList.contains('myturn')), 'nobody else is alerted');
  await shot(host, 'desk-turn');
  await host.waitForFunction(() => document.getElementById('turn-cue')?.classList.contains('hidden'), null, { timeout: 5000 }).catch(() => {});
  ok(!(await visible(host, '#turn-cue')) && await host.$('#turn-cue'), 'the cue goes away on its own');
  await h.playFromHand(host, 0, 0.62, 0.62); // the turn passes to Bob
  await logHas(host, 'Alice played');
  await guest.waitForFunction(() => document.title.startsWith('⏳ Your turn'), null, { timeout: 8000 }).catch(() => {});
  ok(await host.evaluate(() => document.title === 'Card Table'), 'the title is restored when the turn moves on');
  ok(!(await host.$eval('#hand-bar', (el) => el.classList.contains('myturn'))), 'the alert clears when the turn moves on');
  ok(await visible(guest, '#turn-cue') && await guest.evaluate(() => document.title.startsWith('⏳ Your turn')), 'and fires for the next player');

  // ------------------------------------------------------------------ UX-I4
  section('win celebration');
  await host.click('#rules-btn');
  await host.fill('#rules-code', `({ name: 'Winner', buttons: () => [{ id: 'win', label: 'Win' }], onButton(t, id, p) { t.win([p], 'yay'); } })`);
  await host.click('#rules-enable');
  await guest.waitForSelector('#rules-btns [data-rbtn="win"]');
  const calmPage = await player(env, 'Cal', url); // reduced motion
  await guest.click('#rules-btns [data-rbtn="win"]');
  await logHas(host, 'yay');
  await host.waitForSelector('.confetti span', { timeout: 5000 }).catch(() => {});
  await guest.waitForSelector('.confetti span', { timeout: 5000 }).catch(() => {});
  ok(await host.$('.confetti span') && await guest.$('.confetti span'), 'everyone gets an emoji confetti burst');
  ok(await guest.$$eval('.confetti span', (s) => s.length) > await host.$$eval('.confetti span', (s) => s.length), 'the winner\'s burst is bigger');
  ok(await host.evaluate(() => document.querySelector('.confetti') && getComputedStyle(document.querySelector('.confetti')).pointerEvents === 'none'), 'confetti never blocks clicks');
  ok(await guest.evaluate(() => window.VIB.some((v) => Array.isArray(v) && v.length === 5)), 'the winner\'s phone buzzes');
  ok(!(await host.evaluate(() => window.VIB.some((v) => Array.isArray(v) && v.length === 5))), 'a loser\'s does not');
  await shot(guest, 'desk-confetti');
  await host.waitForFunction(() => !document.querySelector('.confetti'), null, { timeout: 4000 }).catch(() => {});
  ok(!(await host.$('.confetti')), 'the confetti removes itself');
  await logHas(calmPage, 'yay');
  ok(!(await calmPage.$('.confetti')), 'reduced motion: no confetti');
  const late = await player(env, 'Late', url, { ctx: MOTION }); // joins after the win
  await late.waitForFunction(() => document.querySelector('.seat.winner'));
  ok(!(await late.$('.confetti')), 'joining a finished game does not replay the celebration');
  await late.close();

  section('re-enabling a kept game does not replay its win');
  await host.click('#rules-btn');
  await host.click('#rules-disable');
  await host.click('#rules-dialog button[value="cancel"]').catch((err) => console.error('dialog already closed', err.message));
  await logHas(guest, 'rules disabled');
  await guest.waitForFunction(() => !document.querySelector('.seat.winner'));
  await h.enableRules(host, {});
  await logHas(guest, 'game state kept');
  await guest.waitForFunction(() => document.querySelector('.seat.winner'));
  await host.waitForFunction(() => document.querySelector('.seat.winner'));
  ok(!(await host.$('.confetti')) && !(await guest.$('.confetti')), 'no confetti for an old win');
  ok(await guest.evaluate(() => window.VIB.filter((v) => Array.isArray(v) && v.length === 5).length === 1), 'and no second winner buzz');

  section('iPhone 13: the "Your turn" chip stays clear of a table banner and the button row');
  const phone = await player(env, 'Pia', url, { ctx: { ...devices['iPhone 13'], ...MOTION } });
  await h.enableRules(host, { code: `({ name: 'Banner', buttons: () => [{ id: 'go', label: 'Go' }, { id: 'b2', label: 'Another' }, { id: 'b3', label: 'Third one' }],
    onButton(t, id, p) { t.public.turn = p; t.announce('New hand — blinds 5/10 (Pia/Bob), Pia to act'); } })` });
  await phone.waitForSelector('#rules-btns [data-rbtn="go"]');
  await phone.tap('#rules-btns [data-rbtn="go"]');
  await phone.waitForSelector('#turn-cue:not(.hidden)', { timeout: 5000 }).catch(() => {});
  await phone.waitForSelector('#announce:not(.hidden)', { timeout: 5000 }).catch(() => {});
  const cue = await rect(phone, '#turn-cue');
  const covers = [];
  for (const sel of ['#announce', '#rules-btns', '.seat.me']) if (await visible(phone, sel) && overlap(cue, await rect(phone, sel))) covers.push(sel);
  ok(await visible(phone, '#turn-cue') && !covers.length, `the chip shows, uncovered (${covers.join() || 'clear'})`);
  // (it now sits just above the hand bar, off the fanned cards' corners) — nothing paints over it:
  ok(await phone.evaluate(() => { const el = document.getElementById('turn-cue'), r = el.getBoundingClientRect(), bar = document.getElementById('hand-bar').getBoundingClientRect();
    el.style.pointerEvents = 'auto'; const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); el.style.pointerEvents = '';
    return top === el && r.bottom <= bar.top && r.bottom > bar.top - 20; }), 'it sits just above the hand bar, on top');
  await shot(phone, 'phone-turn-banner');

  await env.done();
})().catch(h.crash);
