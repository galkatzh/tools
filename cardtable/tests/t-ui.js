// E2E: UI surface — deck dialog, QR invite, card zoom, table size, view
// zoom/pan/reset, hand-tray resize, help, log panel, iPhone 13 layout.
const h = require('./h');
const { ok, section, logHas } = h;
const { devices } = h.playwright;

/** The #table view transform, parsed: {x, y, rot, s}. */
const tf = (page) => page.evaluate(() => {
  const m = document.getElementById('table').style.transform.match(/translate\((.+?)px, (.+?)px\) rotate\((.+?)deg\) scale\((.+?)\)/);
  return { x: +m[1], y: +m[2], rot: +m[3], s: +m[4], raw: m[0] };
});
/** A client point over bare felt (elementFromPoint hits #table itself), scanning out from the center. */
const feltPoint = (page) => page.evaluate(() => {
  const r = document.getElementById('table-wrap').getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let d = 60; d < Math.min(r.width, r.height) / 2; d += 20) {
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = cx + dx * d * 0.7, y = cy + dy * d * 0.7;
      if (document.elementFromPoint(x, y)?.id === 'table') return { x, y };
    }
  }
  throw new Error('no bare felt point found');
});
/** Waits until the #table transform differs from `raw`. */
const tfChanged = (page, raw) => page.waitForFunction((r) => document.getElementById('table').style.transform !== r, raw);
// New decks stack at the table center; the newest (last in the DOM) is on top.
const TOP_PILE = '.item.pile >> nth=-1';
/** True if every .item's center lies within the play radius (table size/2 − 110). */
const allOnFelt = (page) => page.evaluate(() => {
  const W = parseFloat(document.getElementById('table').style.width), R = W / 2 - 110;
  return [...document.querySelectorAll('.item')].every((el) =>
    Math.hypot(parseFloat(el.style.left) + 50 - W / 2, parseFloat(el.style.top) + 70 - W / 2) <= R + 0.5);
});
const addStdDeck = async (page, name, jokers) => {
  await page.click('#add-deck-btn');
  await page.waitForSelector('#deck-dialog[open]');
  await page.fill('#deck-name', name);
  if (jokers) await page.check('#deck-jokers');
  await page.click('#deck-add');
  await page.waitForSelector('#deck-dialog:not([open])', { state: 'attached' });
};

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const invite = await host.evaluate(() => location.href);

  section('+ Deck dialog');
  await addStdDeck(host, 'Plain', false);
  await logHas(guest, 'added deck "Plain" (52 cards)');
  ok(true, 'standard deck adds 52 cards (logged on the guest)');
  await addStdDeck(host, 'Jokers', true);
  await logHas(guest, 'added deck "Jokers" (54 cards)');
  await guest.waitForFunction(() => [...document.querySelectorAll('.item.pile .count')].some((c) => c.textContent === '54'));
  ok(true, '"+ 2 jokers" adds a 54-card pile that syncs to the guest');
  ok(!(await host.isChecked('#deck-jokers')), 'deck form resets after adding');

  section('QR invite');
  const qrCheck = async (page) => {
    await page.click('#qr-btn');
    await page.waitForSelector('#qr-dialog[open]');
    const r = await page.evaluate(() => {
      const c = document.getElementById('qr-canvas');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let k = 0; k < px.length; k += 4) if (px[k] < 128) dark++;
      return { w: c.width, dark, link: document.getElementById('qr-link').textContent };
    });
    await page.click('#qr-dialog button');
    await page.waitForSelector('#qr-dialog:not([open])', { state: 'attached' });
    return r;
  };
  const q = await qrCheck(host);
  ok(q.w >= 300 && q.dark > 1000, `QR canvas renders a code (${q.w}px wide, ${q.dark} dark px)`);
  ok(q.link === invite, 'QR link is the room invite');
  // A bot tab's own URL carries "~as~" extras; its QR must not leak them.
  const bot = await env.page('Carol');
  await bot.goto(`${invite}~as~Carol`);
  await bot.waitForSelector('.item.pile .count', { timeout: 30000 });
  const qb = await qrCheck(bot);
  ok(qb.link === invite && !/~(as|cli)~/.test(qb.link), `bot tab's QR link has no ~as~/~cli~ extras (${qb.link.split('#')[1]})`);
  await bot.context().close();

  section('card zoom overlay');
  await guest.dblclick(TOP_PILE);
  await h.waitHand(guest, 1);
  await guest.click('.hcard');
  await guest.waitForSelector('#peek:not(.hidden) #peek-inner .face');
  ok(true, 'clicking a hand card opens the zoom overlay with its face');
  await guest.click('#peek');
  await guest.waitForSelector('#peek.hidden', { state: 'attached' });
  ok(true, 'clicking the overlay closes it');

  section('table size selector');
  ok(await host.isVisible('#size-sel'), 'host sees the size selector');
  ok(!(await guest.isVisible('#size-sel')), 'guest does not');
  await host.selectOption('#size-sel', '2400');
  await guest.waitForFunction(() => document.getElementById('table').style.width === '2400px');
  await logHas(guest, 'set the table to round (large)'); // (Phase 2: the size selector sends `size`, which becomes `table`)
  ok(await guest.evaluate(() => [...document.querySelectorAll('.item.pile')].some((el) =>
    parseFloat(el.style.left) === 1150 && parseFloat(el.style.top) === 1130)), 'growing keeps the center pile centered (guest)');
  // Park a card far out on the large felt, then shrink: it must be pulled back on.
  await h.playFromHand(guest, 0, 0.5, 0.12);
  await guest.waitForFunction(() => [...document.querySelectorAll('.item:not(.pile)')].some((el) =>
    Math.hypot(parseFloat(el.style.left) + 50 - 1200, parseFloat(el.style.top) + 70 - 1200) > 700));
  await host.selectOption('#size-sel', '1300');
  await guest.waitForFunction(() => document.getElementById('table').style.width === '1300px');
  await logHas(guest, 'set the table to round (small)');
  ok(await allOnFelt(guest), 'shrinking clamps every item back onto the felt (guest)');
  ok(await allOnFelt(host), '... and on the host');

  section('view: wheel zoom, felt pan, 🧭 reset');
  const t0 = await tf(guest);
  let p = await feltPoint(guest);
  await guest.mouse.move(p.x, p.y);
  await guest.mouse.wheel(0, -400);
  await tfChanged(guest, t0.raw);
  const t1 = await tf(guest);
  ok(t1.s > t0.s * 1.3, `wheel up zooms in (scale ${t0.s.toFixed(3)} → ${t1.s.toFixed(3)})`);
  p = await feltPoint(guest);
  await guest.mouse.move(p.x, p.y);
  await guest.mouse.down();
  await guest.mouse.move(p.x + 80, p.y + 50, { steps: 6 });
  await guest.mouse.up();
  const t2 = await tf(guest);
  ok(Math.abs(t2.x - t1.x - 80) < 1 && Math.abs(t2.y - t1.y - 50) < 1 && t2.s === t1.s, 'dragging empty felt pans by the drag distance');
  // Two-finger twist (synthetic pointers: desktop Chromium has no multi-touch input).
  await guest.evaluate(() => {
    const tb = document.getElementById('table'), r = tb.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (type, id, x, y) => (type === 'pointerdown' ? tb : window).dispatchEvent(
      new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, button: 0, bubbles: true }));
    ev('pointerdown', 11, cx - 100, cy); ev('pointerdown', 12, cx + 100, cy);
    ev('pointermove', 11, cx - 70, cy - 70); ev('pointermove', 12, cx + 70, cy + 70);
    ev('pointerup', 11, cx - 70, cy - 70); ev('pointerup', 12, cx + 70, cy + 70);
  });
  const t3 = await tf(guest);
  ok(Math.abs(((t3.rot - t0.rot + 540) % 360) - 180) > 30, `two-finger twist rotates the view (${t0.rot}° → ${t3.rot.toFixed(1)}°)`);
  await guest.click('#view-btn');
  await guest.waitForFunction((r) => document.getElementById('table').style.transform === r, t0.raw);
  ok(true, '🧭 restores the seat view: zoom, pan and rotation');

  section('hand tray resize');
  await guest.dblclick(TOP_PILE);
  await h.waitHand(guest, 1);
  const hh = () => guest.$eval('.hcard', (el) => el.getBoundingClientRect().height);
  const h0 = await hh();
  const g = await guest.locator('#hand-resize').boundingBox();
  await guest.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await guest.mouse.down();
  await guest.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 60, { steps: 6 });
  await guest.mouse.up();
  const h1 = await hh();
  ok(Math.abs(h1 - h0 - 60) < 1, `dragging the grip up 60px grows hand cards (${h0} → ${h1}px)`);
  await guest.reload();
  await h.waitHand(guest, 1, 30000); // the host hands the guest its hand back
  ok(Math.abs((await hh()) - h1) < 1, 'hand card size persists across reload');

  section('help dialog & log panel');
  await host.click('#help-btn');
  await host.waitForSelector('#help-dialog[open]');
  ok(await host.isVisible('#help-dialog >> text=How to play'), 'help dialog opens');
  await host.click('#help-dialog button');
  await host.waitForSelector('#help-dialog:not([open])', { state: 'attached' });
  ok(await host.isVisible('#side'), 'log panel is open by default on desktop');
  await host.click('#log-btn');
  ok(!(await host.isVisible('#side')), '💬 hides the log panel');
  await host.click('#log-btn');
  ok(await host.isVisible('#side'), '💬 shows it again');
  await guest.fill('#chat-input', 'hello table');
  await guest.press('#chat-input', 'Enter');
  await logHas(host, 'hello table');
  ok(true, 'chat from the guest appears in the host log');

  section('iPhone 13');
  const phone = await env.page('Phone', { ctx: devices['iPhone 13'] });
  await phone.goto(invite);
  await h.joinAs(phone, 'Dana');
  await phone.waitForSelector('.item.pile .count', { timeout: 30000 });
  const lay = await phone.evaluate(() => {
    const W = innerWidth, H = innerHeight, rect = (s) => document.querySelector(s).getBoundingClientRect();
    const visible = [...document.querySelectorAll('#toolbar > *')].filter((el) => el.offsetParent);
    return {
      scroll: document.documentElement.scrollWidth - W,
      toolbarIn: visible.every((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= W && r.bottom <= H; }),
      toolbarH: rect('#toolbar').height,
      hand: rect('#hand-bar'), wrapH: rect('#table-wrap').height, H,
      sideHidden: document.getElementById('side').classList.contains('hidden'),
    };
  });
  ok(lay.scroll <= 0, `no horizontal page scroll (overflow ${lay.scroll}px)`);
  ok(lay.toolbarIn, 'every toolbar control is inside the viewport');
  ok(lay.hand.bottom <= lay.H + 0.5 && lay.hand.height >= 100, `hand bar is on screen (${lay.hand.top | 0}–${lay.hand.bottom | 0} of ${lay.H})`);
  ok(lay.wrapH > lay.H * 0.4, `table area keeps most of the screen (${lay.wrapH | 0}px; toolbar ${lay.toolbarH | 0}px)`);
  ok(lay.sideHidden, 'log panel starts hidden on a phone');
  await phone.tap('#help-btn');
  await phone.waitForSelector('#help-dialog[open]');
  await phone.tap('#help-dialog button');
  await phone.waitForSelector('#help-dialog:not([open])', { state: 'attached' });
  ok(true, 'tapping toolbar buttons works (help opens and closes)');
  await phone.dblclick(TOP_PILE);
  await h.waitHand(phone, 1);
  ok(await phone.$eval('.hcard', (el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }), 'the drawn card is in the hand tray, uncovered and tappable');
  // The zoom opens on click (not pointerup), so the tap's trailing click can't close it.
  await phone.tap('.hcard');
  await phone.waitForSelector('#peek:not(.hidden)', { timeout: 3000 });
  await h.sleep(300);
  ok(await phone.isVisible('#peek'), 'tapping a hand card zooms it (and it stays open)');

  await env.done();
})().catch(h.crash);
