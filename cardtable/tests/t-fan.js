// A crowded hand fans out: on desktop a 13-card hand fits without scrolling,
// every card's corner stays visible and grabbable; on a phone the fan is
// capped (≥ 40% of each card shows) and the rest scrolls.
const h = require('./h');
const { ok, section } = h;
const { devices } = h.playwright;

/** Per card: is its left-edge corner the topmost element there? + the hand's scroll state. */
const fan = (page) => page.evaluate(() => {
  const hand = document.getElementById('hand'), cards = [...hand.querySelectorAll('.hcard')];
  const hr = hand.getBoundingClientRect();
  return {
    n: cards.length,
    scrolls: hand.scrollWidth > hand.clientWidth + 1,
    corners: cards.map((c) => { const r = c.getBoundingClientRect(); const x = r.left + 6, y = r.top + 12;
      return x < hr.left || x > hr.right || document.elementFromPoint(x, y)?.closest('.hcard') === c; }),
    shown: cards.slice(0, -1).map((c, k) => (cards[k + 1].getBoundingClientRect().left - c.getBoundingClientRect().left) / c.offsetWidth),
  };
});
async function draw(page, n) {
  for (let k = 0; k < n; k++) {
    const before = await h.handCount(page);
    await page.dblclick('.item.pile');
    await h.waitHand(page, before + 1);
  }
}

(async () => {
  const env = await h.start();

  section('desktop: 13 cards fan out to fit, every corner visible');
  const host = await env.page('Alice');
  await host.goto(env.url);
  await h.joinAs(host, 'Alice');
  await host.waitForSelector('.item.pile .count');
  await draw(host, 13);
  let f = await fan(host);
  ok(f.n === 13 && !f.scrolls, `the 13-card hand fits the bar without scrolling (${JSON.stringify({ n: f.n, scrolls: f.scrolls })})`);
  ok(f.corners.every(Boolean), "every card's corner index shows (no card is fully hidden)");
  await host.locator('.hcard').nth(12).hover();
  ok(await host.evaluate(() => getComputedStyle(document.querySelectorAll('.hcard')[3]).zIndex) === 'auto', 'cards stack in hand order');
  const before = await h.handCount(host);
  await h.playFromHand(host, 5, 0.5, 0.5); // grabbed by its visible edge
  await h.waitHand(host, before - 1);
  ok(true, 'a fanned card is played by dragging its visible part');
  await draw(host, 4); // 16 cards: tighter fan
  f = await fan(host);
  ok(f.shown.every((s) => s >= 0.39), `≥ 40% of each card shows (min ${Math.min(...f.shown).toFixed(2)})`);

  section('desktop: hovering never hides a neighbour (26 cards, tight fan)');
  await draw(host, 26 - (await h.handCount(host)));
  const sweep = await host.evaluate(() => [...document.querySelectorAll('.hcard')].map((c, k, all) => {
    const r = c.getBoundingClientRect(), next = all[k + 1]?.getBoundingClientRect();
    return { x: (r.left + (next ? next.left : r.right)) / 2, y: r.top + r.height / 2 };
  }));
  const missed = [];
  for (let k = 0; k < sweep.length; k++) { // left to right, as a hand is read
    await host.mouse.move(sweep[k].x, sweep[k].y);
    const hit = await host.evaluate(({ x, y }) => [...document.querySelectorAll('.hcard')].indexOf(document.elementFromPoint(x, y)?.closest('.hcard')), sweep[k]);
    if (hit !== k) missed.push(k);
  }
  ok(!missed.length, `a left-to-right sweep reaches every card's slice (missed: ${missed.join() || 'none'})`);

  section('the "Your turn" chip stays off the cards');
  const cueHits = (page) => page.evaluate(() => {
    const cue = document.getElementById('turn-cue');
    cue.classList.remove('hidden');
    const q = cue.getBoundingClientRect();
    const n = [...document.querySelectorAll('.hcard')].filter((c) => { const r = c.getBoundingClientRect();
      return r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom; }).length;
    cue.classList.add('hidden');
    return n;
  });
  ok((await cueHits(host)) === 0, 'desktop: the chip covers no hand card');

  section('phone: the fan is capped, the rest scrolls');
  const phone = await env.page('Bob', { ctx: { ...devices['iPhone 13'] } });
  await phone.goto(host.url());
  await h.joinAs(phone, 'Bob');
  await phone.waitForSelector('.item.pile .count', { timeout: 30000 });
  await draw(phone, 13);
  f = await fan(phone);
  ok(f.scrolls && f.shown.every((s) => s >= 0.39), `13 cards on an iPhone 13: capped fan (min ${Math.min(...f.shown).toFixed(2)}) and the hand scrolls`);
  ok((await cueHits(phone)) === 0, 'phone: the chip covers no hand card');
  await phone.evaluate(() => localStorage.setItem('ct-handh', '60'));
  await phone.reload();
  await phone.waitForSelector('.hcard', { timeout: 30000 });
  await h.waitHand(phone, 13);
  const px = await phone.evaluate(() => { const cs = [...document.querySelectorAll('.hcard')].map((c) => c.getBoundingClientRect().left);
    return Math.min(...cs.slice(1).map((x, k) => x - cs[k])); });
  ok(px >= 27.5, `smallest hand cards (60px): every slice stays ≥ 28px wide to tap (${px.toFixed(1)}px)`);
  await env.done();
})().catch(h.crash);
