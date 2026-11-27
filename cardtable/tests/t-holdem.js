// E2E: Hold'em over the network — quick-bet buttons, the host-only abandon
// button (t.hostId), host-only !blinds, a player leaving mid-hand is folded
// and an offline seat is not dealt in. (Game logic edge cases: t-holdem-logic.js.)
// (final overlay: Abandon is its own button ('abandon'), last in the row, and
// takes a second press (PT-11); a dropped player is folded only after a 20 s
// grace (PT-5).)
const h = require('./h');
const { ok, section, logHas, toastHas } = h;
(async () => {
  const env = await h.start();
  const { host, guest: bob } = await h.hostAndGuest(env);
  const carol = await env.page('Carol');
  await carol.goto(host.url());
  await h.joinAs(carol, 'Carol');
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3, null, { timeout: 30000 });
  const btns = (page) => page.$$eval('#rules-btns button', (bs) => bs.map((b) => b.dataset.rbtn + '=' + b.textContent));
  const dealtTo = (name) => host.evaluate((n) => (document.getElementById('log').textContent.match(new RegExp('to ' + n, 'g')) || []).length, name);

  await h.enableRules(host, { tpl: 'holdem' });
  await bob.waitForFunction(() => [...document.querySelectorAll('.seat')].filter((s) => s.textContent.includes('💰1000')).length === 3, null, { timeout: 15000 });
  ok(true, 'three stacks of 💰1000');

  section('GAME-17: only the host sets the blinds');
  await bob.fill('#chat-input', '!blinds 50 100');
  await bob.press('#chat-input', 'Enter');
  await toastHas(bob, 'Only the host sets the blinds');
  ok(true, "Bob's !blinds is refused privately");

  section('UX-I6 + GAME-2: buttons mid-hand');
  await host.click('#rules-btns [data-rbtn="new"]'); // dealer Alice, SB Carol, BB Bob: Alice acts first
  await h.waitHand(bob, 2); await h.waitHand(carol, 2);
  await host.waitForSelector('#rules-btns [data-rbtn="call"]', { timeout: 10000 });
  const mine = await btns(host);
  ok(['abandon=🂠 Abandon hand (refund)', 'call=Call 10', 'r:20=Min raise → 20', 'r:22=½ pot → 22', 'r:35=Pot → 35', 'allin=All-in → 1000'].every((x) => mine.includes(x)),
    `the host, to act, sees the abandon button and quick bets with amounts: ${mine.join(' | ')}`);
  ok(mine.at(-1).startsWith('abandon=') && mine[0].startsWith('call='), `Abandon comes last, the call first (${mine.map((x) => x.split('=')[0])})`);
  await bob.waitForFunction(() => document.querySelector('#rules-btns') && !document.querySelector('#rules-btns [data-rbtn="abandon"]'), null, { timeout: 10000 });
  ok(!(await btns(bob)).some((x) => /^(new|abandon|r:|allin)/.test(x)), `a guest who isn't to act sees neither (${(await btns(bob)).join(' | ') || 'no buttons'})`);
  await host.click('#rules-btns [data-rbtn="call"]');

  section('GAME-1: leaving mid-hand folds you; the hand goes on');
  await carol.waitForSelector('#rules-btns [data-rbtn="call"]', { timeout: 10000 }); // Carol (SB) to act
  await carol.context().close();
  await logHas(host, 'Carol disconnected — folding in 20 s unless they return', 30000);
  ok(!(await host.textContent('#log')).includes('Carol folds'), 'Carol is not folded the moment she drops');
  await logHas(host, 'Carol left mid-hand', 40000);
  await logHas(host, 'Carol folds');
  ok(true, 'Carol, on turn, is folded when she leaves');
  await bob.waitForSelector('#rules-btns [data-rbtn="r:20"]', { timeout: 10000 });
  ok(true, 'the turn moved on to Bob');
  await bob.click('#rules-btns [data-rbtn="r:20"]');
  await logHas(host, 'Bob raises to 20');
  ok(true, "Bob's Min raise button raises over the network");
  await host.click('#rules-btns [data-rbtn="call"]');
  await logHas(host, 'Flop — pot 45');
  ok(true, 'Alice calls; the flop deals itself');

  section('GAME-2 / GAME-1: the host abandons; the offline seat is not dealt in');
  const carolBefore = await dealtTo('Carol');
  await host.click('#rules-btns [data-rbtn="abandon"]');
  await toastHas(host, 'Press Abandon again');
  ok(!(await host.textContent('#log')).includes('Hand abandoned'), 'one press of Abandon only asks for a second');
  await host.click('#rules-btns [data-rbtn="abandon"]');
  await logHas(host, 'Hand abandoned — bets refunded');
  await h.waitHand(host, 2); await h.waitHand(bob, 2);
  await logHas(host, 'New hand — blinds 5/10 (Bob/Alice)'); // heads-up now: the button moved to Bob
  ok((await dealtTo('Carol')) === carolBefore, 'the new hand deals Alice and Bob only');
  const sum = await host.evaluate(() => [...document.querySelectorAll('.seat')].map((s) => +(s.textContent.match(/💰(\d+)/)?.[1] || 0)).reduce((a, b) => a + b, 0));
  ok(sum === 3000 - 15, `every bet was refunded: stacks + blinds = 3000 (${sum} + 15)`);
  await env.done();
})().catch(h.crash);
