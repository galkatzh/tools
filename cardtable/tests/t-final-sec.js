// Final review, the trust boundary against a raw peer ("Mallory", final-lib):
// control characters never survive a deck (SEC-F5), guests share one deck
// budget so they can't fill the host's storage (SEC-F1), the record of a peek
// survives an action flood (SEC-F3), a burst of actions can't freeze the host
// (SEC-F2), and a refused rules button never reaches the script (QUAL-4).
const h = require('./h');
const { ok, section, logHas } = h;
const { mallory } = require('./final-lib');

/** The host's saved decks (the room's catalog), and its save record. */
const savedDecks = async (page) => (await h.idb(page, 'catalog')).map((r) => r.deck);
const savedTable = (page) => page.evaluate(() => location.hash.match(/#room~([0-9a-f]+)/)[1]).then((room) => h.idb(page, 'saves', room));
const logText = (page) => page.textContent('#log');

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const M = await mallory(env, await host.evaluate(() => location.href));
  await M.act({ t: 'hello' });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3, null, { timeout: 15000 });
  const pileId = await host.evaluate(() => document.querySelector('.item.pile').dataset.id);

  section('SEC-F5: control characters never survive a deck');
  await M.act({ t: 'addDeck', deck: { name: '\x1b[2J\x1b]0;PWNED\x07Evil', cards: [{ n: 'N\x1b[31m\x9b', txt: 'line1\nline2\x1b[0m' }] } });
  await logHas(host, 'PWNED');
  const lines = (await logText(host)) + (await logText(guest));
  ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(lines) && lines.includes('added deck "[2J]0;PWNEDEvil"'), 'the deck name reaches the log without its ESC/BEL bytes');
  let evil;
  for (let k = 0; k < 40 && !evil; k++, await h.sleep(250)) evil = (await savedDecks(host)).find((d) => d.name.includes('PWNED'));
  ok(evil?.cards[0].n === 'N[31m' && evil.cards[0].txt === 'line1\nline2[0m', `card names and texts are stripped too, a text keeps its newline (${JSON.stringify(evil?.cards[0])})`);

  section('SEC-F1: guests share one deck budget');
  await M.evaluate(() => {
    const big = (k) => ({ name: 'Big' + k, cards: Array.from({ length: 2000 }, (_, i) => ({ txt: String(i).padEnd(300, 'x') })) }); // ≈ 0.62M chars
    for (let k = 1; k <= 3; k++) window.M.act({ t: 'addDeck', deck: big(k) });
  });
  await logHas(host, 'added deck "Big2"', 30000);
  const full = await M.waitForFunction(() => window.M.notes().some((n) => /deck budget for guests is full/.test(n.msg || '')), null, { timeout: 30000 }).then(() => true, () => false);
  ok(full, 'the third 0.6M-char deck from a guest is refused: the guests\' budget is full');
  await h.sleep(1500);
  ok(!(await logText(host)).includes('added deck "Big3"'), 'and it never reaches the table');
  let save;
  for (let k = 0; k < 40 && !(save?.state?.guestDeckChars > 1e6); k++, await h.sleep(250)) save = await savedTable(host);
  ok(save?.state?.guestDeckChars > 1e6 && !save.lost, `the budget used is saved with the table (${save?.state?.guestDeckChars}), and the table still saves`);

  section('SEC-F3: an action flood cannot push a peek out of the log');
  await M.act({ t: 'deal', id: pileId, up: false, x: 300, y: 300 });
  await logHas(host, 'Mallory dealt a card face down');
  const cardId = await host.evaluate(() => [...document.querySelectorAll('.item:not(.pile)')].at(-1).dataset.id);
  await M.act({ t: 'peek', id: pileId });
  await M.waitForFunction(() => window.M.notes().some((n) => n.peek), null, { timeout: 10000 });
  await logHas(guest, 'Mallory peeked at the top card');
  // 210 cheap actions, paced under the action rate limit (they must all land)
  await M.evaluate(async ({ pileId, cardId }) => {
    for (let k = 0; k < 210; k++) {
      window.M.act({ t: 'rot', id: k % 2 ? pileId : cardId, rot: k % 4 < 2 ? 0 : 90 });
      await new Promise((r) => setTimeout(r, 65));
    }
  }, { pileId, cardId });
  await host.waitForFunction(() => (document.getElementById('log').textContent.match(/rotated/g) || []).length >= 195, null, { timeout: 20000 }).catch(() => {});
  await h.sleep(1500);
  ok(((await logText(host)).match(/rotated/g) || []).length >= 195, 'the 210 rotations landed (and filled the action log)');
  ok((await logText(guest)).includes('Mallory peeked at the top card') && (await logText(host)).includes('Mallory peeked at the top card'), 'the peek is still on everyone\'s record');

  section('SEC-F2: a burst of actions cannot freeze the host');
  const meter = () => { window.LAG = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.LAG = Math.max(window.LAG, n - last - 50); last = n; }, 50); };
  await host.evaluate(meter);
  await M.evaluate(({ pileId, cardId }) => { for (let k = 0; k < 5000; k++) window.M.act({ t: 'rot', id: k % 2 ? pileId : cardId, rot: (k * 7) % 360 }); }, { pileId, cardId });
  const slowed = await M.waitForFunction(() => window.M.notes().some((n) => /Too many actions/.test(n.msg || '')), null, { timeout: 30000 }).then(() => true, () => false);
  ok(slowed, 'the flooding guest is told to slow down');
  await h.sleep(6000);
  const lag = await host.evaluate(() => window.LAG);
  ok(lag < 1000, `the host's main thread never stalled for a second (worst ${lag | 0} ms)`);
  await guest.dblclick('.item.pile', { force: true }); // (the guests' decks lie on top of the Standard one)
  await h.waitHand(guest, 1);
  ok(true, 'the table still answers Bob');

  section('QUAL-4: a refused rules button never reaches the script');
  await h.enableRules(host, { code: `({ name: 'Spy',
    buttons: () => [{ id: 'real', label: 'Real' }],
    onButton(t, id) { t.say('pressed ' + id); },
    onAction(t, a) { if (a.t === 'rulesBtn') t.say('onAction saw rulesBtn ' + a.id); },
  })` });
  await logHas(guest, '«Spy» enabled');
  await h.sleep(2500); // Mallory's action budget refills
  await M.act({ t: 'rulesBtn', id: 'ghost' });
  await M.waitForFunction(() => window.M.notes().some((n) => /not available/.test(n.msg || '')), null, { timeout: 10000 });
  await guest.click('#rules-btns [data-rbtn="real"]');
  await logHas(host, 'onAction saw rulesBtn real');
  ok(!(await logText(host)).includes('saw rulesBtn ghost'), 'onAction saw the offered button, never the refused one');
  await env.done();
})().catch(h.crash);
