// E2E: custom decks — deck.json manifests, filename naming, text cards, meta → rules.
const h = require('./h');
const { ok, section, logHas } = h;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const img = (name) => ({ name, mimeType: 'image/png', buffer: PNG });
const json = (obj) => ({ name: 'deck.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(obj)) });
async function uploadDeck(page, files, name = '') {
  await page.click('#add-deck-btn');
  await page.waitForSelector('#deck-dialog[open]');
  await page.check('input[name="deck-kind"][value="img"]');
  if (name) await page.fill('#deck-name', name);
  await page.setInputFiles('#deck-files', files);
  await page.click('#deck-add');
}
(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);

  section('manifest deck: counts, meta, text card, back, unlisted extra image');
  await uploadDeck(host, [
    json({ name: 'TestGame', back: 'back.png', cards: [
      { name: 'Gold Coin', text: 'Worth 1 coin', color: '#eab308', count: 3 },
      { file: 'dragon.png', name: 'Ancient Dragon', count: 2, meta: { cost: 5, type: 'creature' } },
    ] }),
    img('dragon.png'), img('back.png'), img('extra_card.png'),
  ]);
  await logHas(host, 'added deck "TestGame" (6 cards)');
  ok(true, 'counts expand: 3 + 2 + 1 unlisted = 6');
  await guest.waitForFunction(() => [...document.querySelectorAll('.item.pile .count')].some((c) => c.textContent === '6'), null, { timeout: 15000 });
  // (images follow their deck: the guest pulls them from the host by hash)
  ok(await guest.waitForFunction(() => {
    const pile = [...document.querySelectorAll('.item.pile')].find((el) => el.querySelector('.count')?.textContent === '6');
    return !!pile?.querySelector('img.back');
  }, null, { timeout: 15000 }).then(() => true, () => false), 'manifest "back" image renders on the guest');

  section('rules script reads names + meta via t.card');
  await h.enableRules(host, { code: `({
    name: 'Meta test',
    buttons: () => [{ id: 'd5', label: 'Deal 5' }],
    onButton(t, id) {
      const pile = t.piles().find((p) => p.cards.length === 6);
      const seen = [];
      for (let k = 0; k < 5; k++) {
        const c = t.card(pile.cards.at(-1 - k));
        seen.push(c.name + (c.meta ? '/' + c.meta.cost : ''));
        t.deal(pile.id, { up: true, x: 210 + k * 150, y: 250 });
      }
      t.announce(seen.join(', '));
    },
  })` });
  await host.waitForFunction(() => !document.querySelector('#rules-dialog[open]'));
  await host.click('#rules-btns [data-rbtn="d5"]');
  await logHas(host, 'extra card, Ancient Dragon/5, Ancient Dragon/5, Gold Coin, Gold Coin');
  ok(true, 't.card returns names and meta in deal order');

  section('text cards render on every screen');
  await guest.waitForFunction(() => {
    const t = [...document.querySelectorAll('.item .face.txt')];
    return t.length === 2 && t.every((el) => el.textContent.includes('Gold Coin') && el.textContent.includes('Worth 1 coin'));
  }, null, { timeout: 10000 });
  ok(true, 'guest sees 2 text cards with name and rule text');

  section('named cards in the log for humans');
  await host.dblclick('.item.pile[data-sig*="p|1|"]');
  await host.waitForSelector('.hcard .face.txt');
  await h.playFromHand(host, 0, 0.35, 0.65);
  await logHas(guest, 'played Gold Coin');
  ok(true, '"played Gold Coin" in the shared log');

  section('copies share one image slot');
  let shared = false; // (decks are stored apart from the throttled state save: the room's catalog)
  for (let k = 0; k < 40 && !shared; k++, await h.sleep(250)) {
    const deck = (await h.idb(host, 'catalog')).map((r) => r.deck).find((d) => d.name === 'TestGame');
    const dr = deck?.cards.filter((c) => c.n === 'Ancient Dragon') || [];
    shared = dr.length === 2 && dr[0].g === dr[1].g && typeof deck.imgs[dr[0].g] === 'string';
  }
  ok(shared, 'both dragons reference one deck.imgs entry');

  section('no manifest: filenames name the cards');
  await uploadDeck(host, [img('fire_bolt.png'), img('ice-wall.png')], 'Spells');
  await logHas(host, 'added deck "Spells" (2 cards)');
  await host.dblclick('.item.pile[data-sig^="p|2|"]');
  await h.waitHand(host, 1);
  await h.playFromHand(host, 0, 0.65, 0.65);
  await logHas(guest, 'played ice wall');
  ok(true, '"ice-wall.png" played as "ice wall"');

  section('manifest errors are loud and abort');
  const before = await host.locator('.item.pile').count();
  await uploadDeck(host, [json({ name: 'Bad', cards: [{ file: 'missing.png' }] })]);
  await h.toastHas(host, 'missing.png');
  ok(true, 'missing image reference toasts');
  ok(await host.evaluate(() => !!document.querySelector('#deck-dialog[open]')), 'dialog stays open');
  await host.click('#deck-dialog button[value="cancel"]');
  ok((await host.locator('.item.pile').count()) === before, 'no deck added');
  await env.done();
})().catch(h.crash);
