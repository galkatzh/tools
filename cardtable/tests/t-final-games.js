// Final review, games end to end (3 desktop players): a hand card dropped on a
// pile lands on it (PT-1), the ⇅ display-only hand sort (PT-9), refusals on
// every screen (PT-8), the 🎲 picker asks before it discards a running game
// and the log says so (INT-3), another game's cards are set aside on a switch
// (PT-2), CAH: only the host sets the goal (SEC-F6), scripts can veto peeks
// (SEC-F4), and the game win gets its own confetti after the round win (INT-6).
const h = require('./h');
const { ok, section, logHas, toastHas } = h;
const { MOTION, cmd } = require('./fun-lib');

/** Drags hand card `idx` (display order) onto the table item matching `sel`. */
async function dropOn(page, idx, sel) {
  await page.locator('.hcard').nth(idx).scrollIntoViewIfNeeded();
  const hb = await page.locator('.hcard').nth(idx).boundingBox(), tb = await page.locator(sel).first().boundingBox();
  await page.mouse.move(hb.x + Math.min(12, hb.width / 2), hb.y + hb.height / 2); // the edge shows even in a fanned hand
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 });
  await page.mouse.up();
}
const pile = (name) => `.item.pile:has(.pname:text-is("${name}"))`;
const count = (page, name) => page.$eval(pile(name), (el) => +el.querySelector('.count').textContent).catch(() => 0);
const hand = (page) => page.$$eval('.hcard', (els) => els.map((el) => (el.querySelector('.std') ? el.querySelector('.mr').textContent + el.querySelector('.ms').textContent : 'txt')));
const chat = async (page, msg) => { await page.fill('#chat-input', msg); await page.press('#chat-input', 'Enter'); };
const banner = (page) => page.$eval('#announce', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
const BURSTS = () => document.addEventListener('DOMContentLoaded', () => {
  window.BURSTS = 0;
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('confetti')) window.BURSTS++; })
    .observe(document.body, { childList: true });
});

(async () => {
  const env = await h.start();
  const host = await env.page('Alice', { ctx: MOTION });
  await host.addInitScript(BURSTS);
  await host.goto(env.url);
  await h.joinAs(host, 'Alice');
  await host.waitForSelector('.item.pile .count');
  const url = await host.evaluate(() => location.href);
  const P = { Alice: host };
  for (const n of ['Bob', 'Carol']) {
    P[n] = await env.page(n, { ctx: MOTION });
    await P[n].addInitScript(BURSTS);
    await P[n].goto(url);
    await h.joinAs(P[n], n);
    await P[n].waitForSelector('.item.pile .count', { timeout: 30000 });
  }
  const bob = P.Bob;
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3, null, { timeout: 30000 });
  let dialogs = 0, accept = false;
  host.on('dialog', (d) => { dialogs++; (accept ? d.accept() : d.dismiss()).catch((e) => console.error(e)); });

  section('PT-1: a hand card dropped onto a pile lands on top of it');
  await bob.dblclick(pile('Standard'));
  await h.waitHand(bob, 1);
  await dropOn(bob, 0, pile('Standard'));
  await h.waitHand(bob, 0, 10000).catch(() => {});
  ok(await h.handCount(bob) === 0 && await count(host, 'Standard') === 52, 'the card left the hand and the pile is whole again');
  await logHas(host, 'from hand onto the Standard pile', 5000).then(() => ok(true, 'the drop is logged'), () => ok(false, 'the drop is logged'));

  section('PT-9: ⇅ sorts the hand on this screen only; plays still name the right card');
  await cmd(bob, pile('Standard'), 'shuffle');
  await logHas(host, 'Bob shuffled the Standard pile');
  for (let k = 1; k <= 7; k++) { await bob.dblclick(pile('Standard')); await h.waitHand(bob, k); }
  const held = await hand(bob);
  await bob.click('#sort-toggle');
  await bob.waitForFunction(() => document.getElementById('sort-toggle').classList.contains('on'));
  const shown = await hand(bob);
  const key = (c) => '♠♥♦♣'.indexOf(c.slice(-1)) * 100 - ({ A: 14, K: 13, Q: 12, J: 11 }[c.slice(0, -1)] || +c.slice(0, -1));
  ok(JSON.stringify(shown) === JSON.stringify([...held].sort((a, b) => key(a) - key(b))) && shown.join() !== held.join(), `shown by suit, high first: ${shown.join(' ')} (held ${held.join(' ')})`);
  ok(await bob.evaluate(() => localStorage.getItem('ct-sort')) === '1', 'the choice is remembered');
  await h.playFromHand(bob, 0, 0.5, 0.62);
  await h.waitHand(bob, 6);
  await logHas(host, `Bob played ${shown[0]} from hand`, 5000).then(() => ok(true, `the first card SHOWN (${shown[0]}) is the one played`), () => ok(false, `the first card SHOWN (${shown[0]}) is the one played`));

  section('PT-8: a refused Deal is shown on every screen');
  await host.click('#games-btn');
  await host.click('#games-list [data-game="bridge"]');
  await logHas(bob, '«Bridge» enabled');
  await bob.click('#rules-btns [data-rbtn="deal"]');
  await bob.waitForFunction(() => document.getElementById('announce').textContent.includes('Bridge deals to exactly 4 online players (3 online)'), null, { timeout: 10000 }).catch(() => {});
  ok((await banner(bob)).includes('(3 online)'), `Bob, who pressed Deal, sees why nothing happened ("${(await banner(bob)).slice(0, 60)}")`);
  ok(dialogs === 0, 'starting a game on a free table asks nothing');

  section('INT-3: the 🎲 picker asks before it discards a running game');
  await host.click('#games-btn');
  await host.click('#games-list [data-game="turns"]');
  await h.sleep(800);
  ok(dialogs === 1 && !(await host.textContent('#log')).includes('«Turn order» enabled'), 'switching away from Bridge asks first; "Cancel" keeps Bridge');
  ok(await host.getAttribute('#rules-btn', 'title') === 'Rules active: Bridge', 'Bridge still runs');
  accept = true;
  if (await host.isVisible('#games-dialog')) await host.click('#games-list [data-game="turns"]');
  else { await host.click('#games-btn'); await host.click('#games-list [data-game="turns"]'); }
  await logHas(host, '«Turn order» enabled by Alice («Bridge» game state discarded)');
  ok(dialogs === 2, 'once confirmed, the log says the old game\'s state is gone');

  section('PT-2: Cards Against Humanity sets another game\'s cards aside');
  await host.click('#games-btn');
  await host.click('#games-list [data-game="cah"]');
  await logHas(bob, '«Cards Against Humanity» enabled');
  await bob.waitForFunction(() => document.querySelectorAll('.hcard').length >= 10 && !document.querySelector('.hcard .std'), null, { timeout: 15000 }).catch(() => {});
  ok((await hand(bob)).every((c) => c === 'txt') && (await hand(bob)).length >= 10, `Bob holds only white cards (${(await hand(bob)).length})`);
  ok(await count(host, 'Set aside') === 6, `his six playing cards wait on a "Set aside" pile (${await count(host, 'Set aside')})`);

  section('SEC-F6: only the host sets the goal');
  await chat(bob, '!goal 1');
  await toastHas(bob, 'Only the host sets the goal');
  ok(!(await host.textContent('#log')).includes('the goal is now'), "Bob's !goal changes nothing");
  await chat(host, '!goal 1');
  await logHas(host, 'the goal is now ⭐1');
  ok(true, "the host's does");

  section('SEC-F4: a script can veto peeking (CAH keeps its piles closed)');
  await bob.click(pile('White deck'));
  await bob.waitForSelector('#action-bar:not(.hidden)');
  await bob.evaluate(() => { document.getElementById('toast').textContent = ''; });
  await bob.click('#action-bar [data-cmd="peek"]');
  await toastHas(bob, 'The game runs the cards here');
  ok(!(await bob.isVisible('#peek')) && !(await host.textContent('#log')).includes('Bob peeked'), 'Bob\'s peek at the White deck is vetoed: nothing shown, nothing peeked');

  section('PT-1 in CAH: an answer dropped onto the Answers pile counts; INT-6: round AND game win celebrate');
  const czar = await host.evaluate(() => [...document.getElementById('log').textContent.matchAll(/(\w+) is the Card Czar/g)].at(-1)[1]);
  const pick = await host.evaluate(() => +[...document.getElementById('log').textContent.matchAll(/answer with (\d) card/g)].at(-1)[1]);
  const [first, second] = Object.keys(P).filter((n) => n !== czar);
  for (let k = 0; k < pick; k++) {
    const n = await h.handCount(P[first]);
    await h.playFromHand(P[first], 0, 0.4 + k * 0.1, 0.72);
    await h.waitHand(P[first], n - 1);
  }
  await P[second].waitForSelector(pile('Answers'), { timeout: 10000 });
  for (let k = 0; k < pick; k++) {
    const n = await h.handCount(P[second]);
    await dropOn(P[second], 0, pile('Answers'));
    await h.waitHand(P[second], n - 1, 10000).catch(() => {});
  }
  await logHas(host, `${second} put a card face down from hand onto the Answers pile`, 5000).catch(() => {});
  await logHas(host, 'judges — press 👉', 10000).then(() => ok(true, `${second}'s answer, dropped on the Answers pile, completes the round`), () => ok(false, `${second}'s answer, dropped on the Answers pile, completes the round`));
  const before = await Promise.all(Object.values(P).map((p) => p.evaluate(() => window.BURSTS)));
  await P[czar].click('#rules-btns [data-rbtn="pick0"]');
  await logHas(host, 'wins the game with ⭐1', 15000);
  await h.sleep(2500);
  const after = await Promise.all(Object.values(P).map((p) => p.evaluate(() => window.BURSTS)));
  ok(after.every((n, k) => n - before[k] === 2), `every screen celebrates twice — the round, then the game (${before} → ${after})`);

  section("PT-2: Hold'em after CAH deals only playing cards; CAH after Hold'em, only white cards");
  const asked = dialogs;
  await host.click('#games-btn');
  await host.click('#games-list [data-game="holdem"]');
  await logHas(bob, "«Hold'em (chips)» enabled by Alice («Cards Against Humanity» game state discarded)");
  ok(dialogs === asked + 1, 'leaving the finished CAH game asked first');
  await host.click('#rules-btns [data-rbtn="new"]');
  for (const p of Object.values(P)) await h.waitHand(p, 2, 15000).catch(() => {});
  const holes = await Promise.all(Object.values(P).map(hand));
  ok(holes.every((hd) => hd.length === 2 && hd.every((c) => c !== 'txt')), `everyone holds 2 standard hole cards (${holes.map((x) => x.join(' ')).join(' | ')})`);
  ok(await count(host, 'Standard') === 52 - 6 && await count(host, 'White deck') > 0, `the whole Standard deck is gathered (set-aside cards too) and dealt from (${await count(host, 'Standard')} left); the CAH piles are left alone`);
  await host.click('#games-btn');
  await host.click('#games-list [data-game="cah"]');
  await logHas(bob, '«Cards Against Humanity» enabled by Alice («Hold\'em (chips)» game state discarded)');
  await bob.waitForFunction(() => document.querySelectorAll('.hcard').length >= 10 && !document.querySelector('.hcard .std'), null, { timeout: 15000 }).catch(() => {});
  ok((await hand(bob)).every((c) => c === 'txt'), 'mid-hand → CAH: the hole cards are set aside, Bob holds only white cards');
  section('recheck: a game kept by "Free table" is not discarded silently');
  const asked2 = dialogs;
  await host.click('#games-btn');
  await host.click('#games-list [data-game="free"]');
  await logHas(host, 'rules disabled by Alice');
  ok(dialogs === asked2, '"Free table" itself asks nothing (re-enabling keeps the state)');
  await host.click('#games-btn');
  await host.click('#games-list [data-game="turns"]');
  await logHas(host, '«Turn order» enabled by Alice («Cards Against Humanity» game state discarded)');
  ok(dialogs === asked2 + 1, 'picking another game after "Free table" asks first: the kept state would be lost');
  section('recheck: an edited copy of a template keeps its state — no needless "will be lost" prompt');
  const tweaked = '// my tweak\n' + await host.inputValue('#rules-code');
  await h.enableRules(host, { code: tweaked });
  await logHas(host, '«Turn order» enabled by Alice (game state kept)');
  const asked3 = dialogs;
  await host.click('#games-btn');
  await host.click('#games-list [data-game="free"]');
  await host.click('#games-btn');
  await host.click('#games-list [data-game="turns"]');
  await host.waitForFunction(() => (document.getElementById('log').textContent.match(/«Turn order» enabled by Alice \(game state kept\)/g) || []).length >= 2, null, { timeout: 15000 });
  ok(dialogs === asked3, 'same-named game after "Free table": no prompt, and the state is kept');
  await env.done();
})().catch(h.crash);
