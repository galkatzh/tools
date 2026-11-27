// E2E: Simple dealer fails loudly (GAME-20); Turn order never waits on an
// offline player (not even one gone during a host reload) and keeps its turn
// across a re-enable (GAME-15).
const h = require('./h');
const { ok, section, logHas, toastHas } = h;
const turnOn = (page, name) => page.waitForFunction((n) =>
  [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⏳ ' + n)), name, { timeout: 15000 });
/** Joins `name` from a fresh browser context; resolves once the host sees `seats` seats. */
async function join(env, host, name, seats) {
  const p = await env.page(name);
  await p.goto(host.url());
  await h.joinAs(p, name);
  await p.waitForFunction((k) => document.querySelectorAll('.seat').length === k, seats, { timeout: 30000 });
  await host.waitForFunction((k) => document.querySelectorAll('.seat').length === k, seats, { timeout: 30000 });
  return p;
}
const offline = (page, name) => page.waitForFunction((n) =>
  [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes(n) && s.classList.contains('offline')), name, { timeout: 20000 });

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const carol = await join(env, host, 'Carol', 3);

  section('Simple dealer: a short or missing deck is said out loud (GAME-20)');
  await h.enableRules(host, { tpl: 'dealer' });
  await guest.waitForSelector('#rules-btns [data-rbtn="deal1"]', { timeout: 10000 });
  for (let k = 1; k <= 17; k++) { // 52 = 17 × 3 + 1
    await guest.click('#rules-btns [data-rbtn="deal1"]');
    await h.waitHand(carol, k);
  }
  await guest.click('#rules-btns [data-rbtn="deal1"]');
  await logHas(carol, 'The deck is short (1 left) — the last seats get none');
  ok(true, 'dealing past the end of the deck is announced in the log');
  await host.waitForFunction(() => !document.querySelector('.item.pile'), null, { timeout: 10000 });
  await guest.click('#rules-btns [data-rbtn="deal1"]');
  await toastHas(guest, 'No deck on the table');
  ok(true, 'pressing Deal with no deck tells the presser');

  section('Turn order: an offline first seat is skipped at setup (GAME-15)');
  const dave = await join(env, host, 'Dave', 4); // the 4th joiner sits at 0°: first in seat order
  await dave.context().close();
  await offline(host, 'Dave');
  await h.enableRules(host, { tpl: 'turns' });
  await logHas(host, 'Turn order: Dave');
  await turnOn(guest, 'Alice');
  ok(true, '⏳ starts on Alice, not on the offline Dave');

  section('Turn order: a re-enable keeps the turn');
  await h.playFromHand(host, 0, 0.6, 0.6);
  await turnOn(guest, 'Carol');
  await h.enableRules(host, { tpl: 'turns' });
  await logHas(host, '(game state kept)');
  await h.sleep(1500); // nothing to wait for: the turn must simply stay put
  await turnOn(guest, 'Carol');
  ok(true, 'after re-enabling, ⏳ is still on Carol');

  section('Turn order: the turn moves on when its player leaves');
  await carol.context().close();
  await turnOn(guest, 'Bob');
  await logHas(host, 'The turn passes on');
  ok(true, 'Carol left on her turn → ⏳ Bob');
  await h.playFromHand(guest, 0, 0.6, 0.6);
  await turnOn(host, 'Alice');
  ok(true, 'Bob can play, and the turn returns to Alice past the offline seats');

  section('Turn order: a turn holder who never returns after a host reload loses the turn');
  const erin = await join(env, host, 'Erin', 5);
  await h.playFromHand(host, 0, 0.6, 0.6);
  await turnOn(erin, 'Bob');
  // the host goes away, Bob leaves meanwhile (so no onLeave), and the host resumes
  const url = host.url();
  await host.goto('about:blank');
  await guest.context().close();
  await host.goto(url);
  const onlineTurn = () => [...document.querySelectorAll('.seat')].some((s) => /⏳ (Alice|Erin)/.test(s.textContent));
  await host.waitForFunction(onlineTurn, null, { timeout: 60000 });
  await erin.waitForFunction(onlineTurn, null, { timeout: 15000 });
  ok(true, 'once the rejoin grace period runs out, ⏳ leaves the absent Bob for an online player');
  await env.done();
})().catch(h.crash);
