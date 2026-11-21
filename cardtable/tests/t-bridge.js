// E2E: the Bridge template with 4 players — deal, chat auction, dummy, one full trick, !contract.
// Seating is read from the DOM (⏳ marker / log), so the suite does not hard-code who sits where.
// (wip-tabletop overlay of t-bridge.js: + a dropped player pauses the auction
// (ENG-7), no 5th card during the sweep (GAME-4), face-down trick piles by a
// hand-holding seat (BRIDGE-S2, GAME-19), "!contract" only by the dealer or
// the host during the auction (GAME-5), exactly 4 online players to Deal.)
const h = require('./h');
const { ok, section, logHas } = h;
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];
const RANK = { A: 14, K: 13, Q: 12, J: 11 };
const rankOf = (c) => RANK[c.slice(0, -1)] || +c.slice(0, -1);
const suitOf = (c) => c.slice(-1);

const turnOf = (page) => page.evaluate(() => {
  for (const s of document.querySelectorAll('.seat')) { const m = s.textContent.match(/⏳ (\S+)/); if (m) return m[1]; }
  return null;
});
const waitTurn = (page, name) => page.waitForFunction((n) =>
  [...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⏳ ' + n)), name, { timeout: 15000 });
/** Card names ("10♥") of the hand, in DOM (= hand index) order. */
const handOf = (page) => page.$$eval('.hcard', (els) => els.map((el) => el.querySelector('.mr').textContent + el.querySelector('.ms').textContent));
/** Loose face-up cards on the table: [{id, name}]. */
const looseUp = (page) => page.$$eval('.item:not(.pile)', (els) => els.filter((el) => el.querySelector('.std'))
  .map((el) => ({ id: el.dataset.id, name: el.querySelector('.mr').textContent + el.querySelector('.ms').textContent })));
const chat = async (page, msg) => { await page.fill('#chat-input', msg); await page.press('#chat-input', 'Enter'); };
/** Runs `fn` and waits for a fresh toast containing `txt` (clears the old text first: it outlives hiding). */
async function expectToast(page, txt, fn) {
  await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
  await fn();
  await h.toastHas(page, txt);
}
/** Drags table item `id` (grabbed at a visible, unoccluded point) to a fraction of the table's box. */
async function dragItem(page, id, fx, fy) {
  const pt = await page.evaluate((id) => {
    const el = document.querySelector(`.item[data-id="${id}"]`), r = el.getBoundingClientRect();
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
      const x = r.left + (r.width * i) / 8, y = r.top + (r.height * j) / 8;
      if (document.elementFromPoint(x, y)?.closest('.item') === el) return { x, y };
    }
    return null;
  }, id);
  if (!pt) throw new Error(`item ${id} is fully covered`);
  const tbl = await page.locator('#table').boundingBox();
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(tbl.x + tbl.width * fx, tbl.y + tbl.height * fy, { steps: 12 });
  await page.mouse.up();
}
/** Drops table card `id` onto card `onto` (at a visible point of it) → a 2-card pile. */
async function stackOnto(page, id, onto) {
  const f = await page.evaluate((onto) => {
    const el = document.querySelector(`.item[data-id="${onto}"]`), r = el.getBoundingClientRect();
    const t = document.getElementById('table').getBoundingClientRect();
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
      const x = r.left + (r.width * i) / 8, y = r.top + (r.height * j) / 8;
      if (document.elementFromPoint(x, y)?.closest('.item') === el) return [(x - t.left) / t.width, (y - t.top) / t.height];
    }
    return null;
  }, onto);
  if (!f) throw new Error(`item ${onto} is fully covered`);
  await dragItem(page, id, ...f);
}
/** Plays hand card `name` toward the player's own side of the center. */
async function playCard(page, name) {
  const idx = (await handOf(page)).indexOf(name);
  if (idx < 0) throw new Error(`${name} not in hand`);
  await h.playFromHand(page, idx, 0.5, 0.58);
}
/** A hand card legal on `led` (following suit when possible). */
const legal = (hand, led) => hand.find((c) => suitOf(c) === led) || hand[0];
const ofSuit = (hand, s) => hand.filter((c) => suitOf(c) === s).sort((a, b) => rankOf(a) - rankOf(b));
const contracts = (page) => page.$eval('#log', (el) => (el.textContent.match(/📣 Contract:/g) || []).length);

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env, NAMES[0], NAMES[1]);
  const P = { Alice: host, Bob: guest };
  for (const n of NAMES.slice(2)) {
    P[n] = await env.page(n);
    await P[n].goto(host.url());
    await h.joinAs(P[n], n);
    await P[n].waitForSelector('.item.pile .count', { timeout: 30000 });
    await host.waitForFunction((k) => document.querySelectorAll('.seat').length === k, NAMES.indexOf(n) + 1, { timeout: 30000 });
  }

  section('enable Bridge + Deal');
  await h.enableRules(host, { tpl: 'bridge' });
  await logHas(host, 'Bridge: press Deal');
  await P.Bob.waitForSelector('#rules-btns [data-rbtn="deal"]', { timeout: 10000 });
  ok(true, 'Bridge enabled with 4 seated; guests see the Deal button');
  await P.Bob.click('#rules-btns [data-rbtn="deal"]');
  for (const n of NAMES) await h.waitHand(P[n], 13);
  await Promise.all(NAMES.map((n) => P[n].waitForSelector('.hcard .mr')));
  const all = (await Promise.all(NAMES.map((n) => handOf(P[n])))).flat();
  ok(new Set(all).size === 52, 'Deal → 13 cards each, 52 distinct');
  await logHas(host, 'bids first');
  const p0 = (await host.$eval('#log', (el) => el.textContent.match(/Auction: (\S+) bids first/)[1]));
  await waitTurn(P.Bob, p0);
  ok(await host.locator('#rules-btns [data-rbtn="deal"]').count() === 0, `auction opens with ${p0} (⏳) and the Deal button is gone`);
  // seat order from "Dealt 13 to each (A–C vs B–D)": partners sit opposite
  const [[a0, a2], [a1, a3]] = (await host.$eval('#log', (el) => el.textContent.match(/Dealt 13 to each \((\S+) vs (\S+)\)/).slice(1))).map((s) => s.split('–'));
  const seatOrder = [a0, a1, a2, a3];
  const nextOf = (n) => seatOrder[(seatOrder.indexOf(n) + 1) % 4];

  section('auction: cards stay in hand');
  await expectToast(P[p0], 'Bidding — cards stay in hand', () => h.playFromHand(P[p0], 0, 0.5, 0.58));
  await h.waitHand(P[p0], 13);
  ok((await looseUp(host)).length === 0, 'playing a card during the auction is blocked');

  section('auction in chat');
  const order = [p0]; // bidding order, read off the ⏳ marker after each call
  const other = NAMES.find((n) => n !== p0);
  await expectToast(P[other], "not your turn to bid", () => chat(P[other], '!bid 1S'));
  ok(true, 'out-of-turn bid rejected privately');
  await chat(P[p0], '!bid 1H');
  await logHas(host, `${p0} bids 1♥`);
  await host.waitForFunction((n) => ![...document.querySelectorAll('.seat')].some((s) => s.textContent.includes('⏳ ' + n)), p0);
  order.push(await turnOf(host));
  await expectToast(P[order[1]], 'Insufficient — you must outbid 1♥', () => chat(P[order[1]], '!1C'));
  ok(true, '"!bid 1H" accepted; an insufficient "!1C" is rejected');

  // ENG-7: someone drops out before their call: the auction waits for them
  // instead of skipping them. (The host can't drop, so pick whoever is next.)
  async function dropDuring(name, call) {
    const ctx = P[name].context();
    await P[name].close();
    await logHas(host, `📣 ${name} dropped out — the hand waits for them to rejoin`, 20000);
    await call();
    await waitTurn(host, name);
    const after = nextOf(name);
    await expectToast(P[after], 'not your turn to bid', () => chat(P[after], '!pass'));
    ok(true, `${name} dropped out: the turn waits on them (⏳ ${name}), ${after} can't call in their place`);
    P[name] = await ctx.newPage();
    await P[name].goto(host.url());
    await logHas(host, `${name} is back — play on`, 30000);
    await h.waitHand(P[name], 13);
    ok(true, `${name} rejoins with their 13 cards and the auction goes on`);
  }
  const y = nextOf(order[1]);
  if (y !== 'Alice') await dropDuring(y, async () => { await chat(P[order[1]], '!pass'); await logHas(host, `${order[1]} passes`); });
  else { await chat(P[order[1]], '!pass'); await logHas(host, `${order[1]} passes`); }
  order.push(await turnOf(host));
  if (y === 'Alice') await dropDuring(nextOf('Alice'), async () => { await chat(P.Alice, '!2H'); await logHas(host, 'Alice bids 2♥'); });
  else { await chat(P[order[2]], '!2H'); await logHas(host, `${order[2]} bids 2♥`); } // p0's partner raises — p0 named hearts first, so p0 declares
  order.push(await turnOf(host));
  ok(new Set(order).size === 4 && order.every((n, k) => k === 0 || n === nextOf(order[k - 1])), `"!pass" / "!2H" accepted; turn rotates in seat order ${order.join(' → ')}`);
  ok([a0, a1, a2, a3].join() !== '' && ((order[0] === a0 && order[2] === a2) || (order[0] === a2 && order[2] === a0) || (order[0] === a1 && order[2] === a3) || (order[0] === a3 && order[2] === a1)), `${order[0]} and ${order[2]} are partners (${a0}–${a2} vs ${a1}–${a3})`);
  for (const k of [3, 0, 1]) { await chat(P[order[k]], '!pass'); if (k !== 1) await waitTurn(host, order[(k + 1) % 4]); }
  const [lead, dummy, rho, decl] = [order[1], order[2], order[3], order[0]];
  await logHas(host, `📣 Contract: 2♥ by ${decl} — ${lead} leads`);
  await waitTurn(P[rho], lead);
  ok(true, `three passes fix 2♥ by ${decl} (first of the side to name ♥); ${lead} leads`);

  section('play: turn order, opening lead, dummy');
  const dummyHand = await handOf(P[dummy]);
  const hands = { [lead]: await handOf(P[lead]), [rho]: await handOf(P[rho]), [decl]: await handOf(P[decl]) };
  // Lead a suit that the dummy and RHO both hold (so both follow-suit checks
  // below can bite) and, if possible, one where the dummy's top card takes
  // the trick (GAME-19: the declaring side's trick pile vs the dummy's cards).
  const declCard = (s) => ofSuit(hands[decl], s)[0] || (s === '♥' ? hands[decl][0] : hands[decl].find((c) => suitOf(c) !== '♥'));
  const common = ['♠', '♥', '♦', '♣'].filter((s) => [hands[lead], hands[rho], dummyHand].every((hd) => hd.some((c) => suitOf(c) === s)));
  const dummyWins = (s) => {
    const top = ofSuit(dummyHand, s).at(-1), dc = declCard(s);
    return dc && [ofSuit(hands[lead], s)[0], ofSuit(hands[rho], s)[0]].every((c) => rankOf(top) > rankOf(c))
      && (suitOf(dc) !== s ? suitOf(dc) !== '♥' : rankOf(top) > rankOf(dc));
  };
  const led = common.find(dummyWins) || common[0];
  if (!led) throw new Error('no suit common to leader, dummy and RHO (vanishingly rare deal) — rerun');
  if (!dummyWins(led)) console.log('  (no suit lets the dummy win the first trick: the GAME-19 check below is weaker)');
  await expectToast(P[rho], "It's not your turn", () => h.playFromHand(P[rho], 0, 0.5, 0.58));
  await h.waitHand(P[rho], 13);
  ok(true, 'out-of-turn play is blocked');
  const trick = [ofSuit(hands[lead], led)[0]];
  await playCard(P[lead], trick[0]);
  await h.waitHand(P[lead], 12);
  await h.waitHand(P[dummy], 0);
  await logHas(host, `Dummy (${dummy}) is on the table`);
  await P[rho].waitForFunction(() => document.querySelectorAll('.item:not(.pile) .std').length === 14, null, { timeout: 10000 });
  const onTable = (await looseUp(P[rho])).map((c) => c.name);
  ok(dummyHand.every((c) => onTable.includes(c)), "after the opening lead the dummy's 13 cards lie face up");
  // (final overlay, INT-2/PT-4: on the dummy's turn the table waits on the DECLARER, who plays its cards)
  await waitTurn(host, decl);
  await P[decl].waitForFunction(() => document.title.startsWith('⏳ Your turn'), null, { timeout: 10000 }).catch(() => {});
  ok(await P[decl].evaluate(() => document.title.startsWith('⏳ Your turn') && document.getElementById('hand-bar').classList.contains('myturn')),
    `on the dummy's turn the declarer (${decl}) gets ⏳ and the your-turn cue`);
  ok(await P[dummy].evaluate(() => !document.title.includes('Your turn') && !document.getElementById('hand-bar').classList.contains('myturn')),
    `the dummy (${dummy}), who cannot act, is not alerted`);
  ok(await host.evaluate((n) => [...document.querySelectorAll('.seat')].some((s) => s.textContent.startsWith(n + ' ') && s.textContent.includes('🃏 dummy')), dummy),
    "the dummy's seat is badged 🃏 dummy");

  await expectToast(P[decl], "Dummy's turn: slide one of the dummy's cards", () => h.playFromHand(P[decl], 0, 0.5, 0.58));
  await h.waitHand(P[decl], 13);
  ok(true, 'the cued declarer playing from their own hand is told to play the dummy instead (not "not your turn")');

  section('only the declarer plays the dummy; dummy must follow suit');
  const idOf = async (name) => (await looseUp(host)).find((c) => c.name === name).id;
  const dLegal = ofSuit(dummyHand, led).at(-1), dOff = dummyHand.find((c) => suitOf(c) !== led);
  await expectToast(P[dummy], 'Only the declarer plays the dummy', async () => dragItem(P[dummy], await idOf(dLegal), 0.5, 0.58));
  await expectToast(P[lead], 'Only the declarer plays the dummy', async () => dragItem(P[lead], await idOf(dLegal), 0.5, 0.5));
  ok(true, 'the dummy player and a defender cannot move dummy cards');
  await expectToast(P[decl], `Dummy must follow ${led}`, async () => dragItem(P[decl], await idOf(dOff), 0.5, 0.42));
  ok(true, 'an off-suit dummy card is rejected while the dummy holds the led suit');
  await dragItem(P[decl], await idOf(dLegal), 0.5, 0.42);
  trick.push(dLegal);
  await waitTurn(host, rho);
  ok(true, 'the declarer slides a dummy card to the middle → it counts as the dummy\'s play');

  section('follow suit, trick resolution and sweep');
  const rOff = hands[rho].find((c) => suitOf(c) !== led);
  await expectToast(P[rho], `You must follow ${led}`, () => playCard(P[rho], rOff));
  await h.waitHand(P[rho], 13);
  ok(true, 'a revoke (off-suit while holding the led suit) is blocked');
  trick.push(ofSuit(hands[rho], led)[0]);
  await playCard(P[rho], trick[2]);
  await waitTurn(host, decl);
  trick.push(declCard(led) || legal(hands[decl], led));
  await playCard(P[decl], trick[3]);
  await h.waitHand(P[decl], 12);
  await expectToast(P[decl], 'not your turn', () => playCard(P[decl], legal(hands[decl].filter((c) => c !== trick[3]), led)));
  ok(await h.handCount(P[decl]) === 12, 'no 5th card can join a full trick before the sweep (GAME-4)');
  const players = [lead, dummy, rho, decl];
  let w = 0;
  for (let k = 1; k < 4; k++) {
    const c = trick[k], b = trick[w];
    if ((suitOf(c) === suitOf(b) && rankOf(c) > rankOf(b)) || (suitOf(c) === '♥' && suitOf(b) !== '♥')) w = k;
  }
  const winner = players[w];
  await logHas(host, 'Trick to ', 10000);
  const got = await host.$eval('#log', (el) => el.textContent.match(/Trick to (\S+)/)[1]);
  ok(got === winner, `trick ${trick.join(' ')} (♥ trump) goes to ${winner} (log: ${got})`);
  const side = [decl, dummy].includes(winner) ? [decl, dummy] : [lead, rho];
  const pileName = await (await P[rho].waitForFunction((s) => {
    const p = [...document.querySelectorAll('.item.pile')].find((el) => el.textContent.includes('tricks'));
    return p?.querySelector('.count').textContent === '4' && s.some((n) => p.querySelector('.pname').textContent.startsWith(n)) && p.querySelector('.pname').textContent;
  }, side, { timeout: 10000 })).jsonValue();
  ok((await looseUp(P[rho])).length === 12, `the trick is swept into "${pileName}" (4 cards)`);
  ok(await P[rho].$eval('.item.pile', (el) => !!el.querySelector('.back')), 'the trick pile is face down (BRIDGE-S2)');
  // GAME-19: the declaring side's pile goes by the declarer, never onto the dummy's cards
  const anchor = side.includes(decl) ? decl : winner;
  const dist = await P[rho].evaluate(() => {
    const c = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const [px, py] = c(document.querySelector('.item.pile'));
    return Object.fromEntries([...document.querySelectorAll('.seat')].map((s) => {
      const [sx, sy] = c(s); return [s.textContent.match(/[A-Z][a-z]+/)[0], Math.hypot(sx - px, sy - py)];
    }));
  });
  const nearest = Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0];
  ok(nearest === anchor, `"${pileName}" lies by ${anchor}'s seat (nearest seat: ${nearest}${winner === dummy ? '; the dummy won the trick' : ''})`);
  await waitTurn(P[dummy], winner === dummy ? decl : winner); // the declarer leads for a winning dummy
  ok(true, `the trick winner (${winner}) leads next`);
  await expectToast(P.Bob, '!contract works during the auction', () => chat(P.Bob, '!contract 3NT bob'));
  ok(await contracts(host) === 1, 'a "!contract" mid-play is refused and changes nothing (GAME-5)');

  section('Deal needs exactly 4 players online (ENG-7)');
  // Re-enabling the same game keeps its state (ENG-3) — start over explicitly.
  await host.click('#rules-btn');
  await host.waitForSelector('#rules-dialog[open]');
  await host.selectOption('#rules-tpl', 'bridge');
  await host.check('#rules-reset');
  await host.click('#rules-enable');
  await P.Bob.waitForSelector('#rules-btns [data-rbtn="deal"]', { timeout: 10000 });
  await expectToast(P.Bob, '!contract works during the auction, after Deal', () => chat(P.Bob, '!contract 4H car'));
  ok(await contracts(host) === 1, '"!contract" before a deal is refused (GAME-5)');
  // two dummy cards become a 2-card pile: the next Deal must gather it too
  const visible = await host.evaluate((ids) => ids.filter((id) => {
    const el = document.querySelector(`.item[data-id="${id}"]`), r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + 12)?.closest('.item') === el;
  }), (await looseUp(host)).map((c) => c.id));
  await stackOnto(host, visible[0], visible[1]);
  await host.waitForFunction(() => [...document.querySelectorAll('.item.pile .count')].some((el) => el.textContent === '2'), null, { timeout: 10000 });
  const erin = await env.page('Erin');
  await erin.goto(host.url());
  await h.joinAs(erin, 'Erin');
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 5, null, { timeout: 30000 });
  const held = await h.handCount(host);
  await host.click('#rules-btns [data-rbtn="deal"]');
  await logHas(host, 'Bridge deals to exactly 4 online players (5 online) — extra players must leave before the deal');
  ok(await h.handCount(host) === held, 'with a 5th player online, Deal is refused');
  await erin.context().close();
  await host.waitForFunction(() => [...document.querySelectorAll('.seat.offline')].some((s) => s.textContent.includes('Erin')), null, { timeout: 20000 });
  await host.click('#rules-btns [data-rbtn="deal"]');
  for (const n of NAMES) await h.waitHand(P[n], 13);
  ok(true, "once Erin is gone, her empty seat doesn't stop the next Deal — which gathers all 52, from every pile");

  section('four passes throw the hand in; Deal deals again, other decks stay put');
  const lastDealer = () => host.$eval('#log', (el) => el.textContent.match(/Auction: (\S+) bids first/g).at(-1).split(' ')[1]);
  for (let k = 0, n = await lastDealer(); k < 4; k++, n = nextOf(n)) { await waitTurn(host, n); await chat(P[n], '!pass'); }
  await logHas(host, '📣 Passed out — press Deal for a new hand');
  await host.waitForFunction(() => !document.querySelector('.item.pile'), null, { timeout: 10000 });
  ok(true, 'passed out: all 52 are in the hands, no pile is left on the table');
  await host.click('#add-deck-btn');
  await host.click('#deck-add');
  await logHas(host, 'added deck "Standard"');
  const deals = () => host.$eval('#log', (el) => (el.textContent.match(/Dealt 13 to each/g) || []).length);
  const before = await deals();
  const passedOut = await Promise.all(NAMES.map((n) => handOf(P[n])));
  await host.click('#rules-btns [data-rbtn="deal"]');
  await host.waitForFunction((k) => (document.getElementById('log').textContent.match(/Dealt 13 to each/g) || []).length > k, before, { timeout: 10000 });
  // everyone held 13 already: wait until each screen shows its NEW hand
  for (const [k, n] of NAMES.entries()) {
    await P[n].waitForFunction((old) => {
      const hc = [...document.querySelectorAll('.hcard')].map((el) => el.querySelector('.mr')?.textContent + el.querySelector('.ms')?.textContent);
      return hc.length === 13 && hc.join() !== old;
    }, passedOut[k].join(), { timeout: 15000 });
  }
  const redealt = (await Promise.all(NAMES.map((n) => handOf(P[n])))).flat();
  ok(new Set(redealt).size === 52, 'Deal after a passed-out hand deals 13 each again (52 distinct)');
  const piles = await host.$$eval('.item.pile', (els) => els.map((el) => [el.querySelector('.pname')?.textContent, el.querySelector('.count').textContent]));
  ok(piles.length === 1 && piles[0][1] === '52' && !/(to|from|into) the Standard pile/.test((await host.textContent('#log')).split('added deck "Standard"').at(-1)), `the second deck stays whole and apart (${JSON.stringify(piles)})`);

  section('"!contract 4H <name>" shortcut: the dealer or the host, during the auction (GAME-5)');
  const dealer = await (await host.waitForFunction(() => document.getElementById('log').textContent.match(/Auction: (\S+) bids first/g)?.at(-1).split(' ')[1], null, { timeout: 10000 })).jsonValue();
  const outsider = NAMES.find((n) => n !== 'Alice' && n !== dealer);
  await expectToast(P[outsider], `Only the dealer (${dealer}) or the host`, () => chat(P[outsider], '!contract 4H car'));
  ok(true, `${outsider} (neither dealer nor host) cannot set the contract`);
  await expectToast(host, 'Usage: !contract 4H', () => chat(host, '!contract 4 hearts car'));
  await waitTurn(P.Bob, dealer);
  ok(await contracts(host) === 1 && await host.locator('#rules-btns [data-rbtn="deal"]').count() === 0, 'a malformed "!contract" is explained and the auction goes on');
  await chat(host, '!contract 4H car');
  const m = await (await host.waitForFunction(() => document.getElementById('log').textContent.match(/📣 Contract: 4♥ by (\S+) — (\S+) leads/g)?.at(-1), null, { timeout: 10000 })).jsonValue();
  const [, by, leads] = m.match(/by (\S+) — (\S+) leads/);
  ok(by === 'Carol', `the host sets 4♥ by Carol from a name prefix (${m})`);
  await waitTurn(P.Bob, leads);
  ok(await host.locator('#rules-btns [data-rbtn="deal"]').count() === 0, `play starts with ${leads} on lead; the auction is skipped`);
  await env.done();
})().catch(h.crash);
