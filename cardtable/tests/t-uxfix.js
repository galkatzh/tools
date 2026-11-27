// E2E: UX defects — hand swipe vs drag-out (UX-1), tap-to-zoom on touch
// (UI-S1), action bar on a phone (UX-2), rules row vs own seat (UX-4), toast
// placement/colour (UX-5), log panel stacking (UX-6), phone landscape (UX-10),
// compact banner (UX-11), seat labels on screen (UX-12), name bulbs (UX-14),
// deck build guard (EDGE-10), Escape (EDGE-14).
// Desktop 1280x800 (Alice host, Bob), iPhone 13 portrait (Carol) and landscape (Dan).
// (final overlay: UX-5's landscape toast check expects the left-margin notices, PT-7.)
const h = require('./h');
const { ok, section, logHas } = h;
const { devices } = h.playwright;

const rect = (p, sel) => p.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
}, sel);
const overlap = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
/** Every seat label lies fully inside #table-wrap. */
const seatsInside = (p) => p.evaluate(() => {
  const w = document.getElementById('table-wrap').getBoundingClientRect();
  const seats = [...document.querySelectorAll('.seat')];
  return { n: seats.length, out: seats.filter((s) => { const r = s.getBoundingClientRect(); return r.left < w.left || r.right > w.right || r.top < w.top || r.bottom > w.bottom; }).map((s) => s.textContent) };
});
/** One-finger CDP touch drag; reports whether the #ghost card ever appeared. */
async function touchDrag(p, x0, y0, x1, y1) {
  const cdp = await p.context().newCDPSession(p);
  const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await tp('touchStart', x0, y0);
  let ghost = false;
  for (let k = 1; k <= 12; k++) {
    await tp('touchMove', x0 + ((x1 - x0) * k) / 12, y0 + ((y1 - y0) * k) / 12);
    ghost ||= await p.evaluate(() => !!document.getElementById('ghost'));
  }
  await tp('touchEnd');
  await cdp.detach();
  return ghost;
}
const SCRIPT = `({
  name: 'UX probe',
  setup(t) { t.announce('Alice is the Card Czar — answer with 1 card, FACE DOWN (🂠)'); },
  buttons: () => [{ id: 'tell', label: 'Tell me' }, { id: 'ann', label: 'New hand' }, { id: 'shuf', label: 'Shuffle' }],
  onButton(t, id, by) {
    if (id === 'tell') t.tell(by, 'Told you so — you cannot do that right now, the dealer is still shuffling the deck');
    if (id === 'ann') t.announce('Alice is the Card Czar — answer with 1 card, FACE DOWN (🂠)');
    if (id === 'shuf') t.shuffle(t.piles()[0].id);
  },
})`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const env = await h.start();
  const { host, guest } = await h.hostAndGuest(env);
  const carol = await env.page('Carol', { ctx: devices['iPhone 13'] });
  await carol.goto(host.url());
  await h.joinAs(carol, 'Carol');
  await carol.waitForSelector('.item.pile .count', { timeout: 30000 });
  const dan = await env.page('Dan', { ctx: devices['iPhone 13 landscape'] });
  await dan.goto(host.url());
  await h.joinAs(dan, 'Dan');
  await dan.waitForSelector('.item.pile .count', { timeout: 30000 });
  for (const p of [host, carol, dan]) await p.waitForFunction(() => document.querySelectorAll('.seat').length === 4, null, { timeout: 30000 });

  section('UX-12: seat labels stay on screen');
  for (const [n, p] of [['portrait', carol], ['landscape', dan], ['desktop', host]]) {
    const s = await seatsInside(p);
    ok(s.n === 4 && !s.out.length, `${n}: all ${s.n} seat labels inside the table area${s.out.length ? ` (cut: ${s.out})` : ''}`);
  }

  section('UX-2: the pile action bar fits a phone');
  for (const [n, p] of [['portrait', carol], ['landscape', dan]]) {
    await p.tap('.item.pile');
    await p.waitForSelector('#action-bar:not(.hidden)');
    const r = await p.evaluate(() => {
      const w = document.getElementById('table-wrap').getBoundingClientRect();
      const bs = [...document.querySelectorAll('#action-bar button')];
      return { n: bs.length, out: bs.filter((b) => { const q = b.getBoundingClientRect(); return q.left < w.left || q.right > w.right || q.top < w.top || q.bottom > w.bottom; }).map((b) => b.textContent) };
    });
    ok(r.n === 8 && !r.out.length, `${n}: all ${r.n} pile buttons are inside the table area${r.out.length ? ` (clipped: ${r.out})` : ''}`);
    await p.tap('#action-bar [data-cmd="draw"]');
    await h.waitHand(p, 1);
    ok(true, `${n}: Draw on the bar works`);
  }

  section('UX-10: phone landscape keeps room for the table');
  const land = await dan.evaluate(() => ({
    H: innerHeight, wrap: document.getElementById('table-wrap').getBoundingClientRect().height,
    card: document.querySelector('.hcard').getBoundingClientRect().height,
    logo: getComputedStyle(document.getElementById('logo')).display,
  }));
  ok(land.card === 76, `short screen: hand cards default to 76px (got ${land.card})`);
  ok(land.wrap >= land.H * 0.55, `table area is ${land.wrap | 0}px of ${land.H}px (≥ 55%)`);
  ok(land.logo === 'none', 'the logo makes way on a short screen');
  const desk = await guest.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--hch').trim());
  ok(desk === '120px', `desktop keeps the 120px default (${desk})`);

  section('UX-1: swipe scrolls the hand, a vertical drag plays a card');
  // (a crowded hand fans out first: it takes 20 cards to overflow a phone's hand twice over)
  for (let i = 0; i < 19; i++) await carol.dblclick('.item.pile');
  await h.waitHand(carol, 20);
  const hs = await carol.evaluate(() => [hand.scrollWidth, hand.clientWidth]);
  ok(hs[0] > hs[1] * 2, `20 cards overflow the phone's hand (${hs[0]} > ${hs[1]})`);
  const c2 = await rect(carol, '.hcard:nth-child(2)');
  let ghost = await touchDrag(carol, 300, c2.y + c2.h / 2, 60, c2.y + c2.h / 2);
  await carol.waitForFunction(() => hand.scrollLeft > 50, null, { timeout: 3000 }).catch(() => {});
  const sl = await carol.evaluate(() => hand.scrollLeft);
  ok(sl > 50, `a sideways swipe scrolls the hand (scrollLeft ${sl})`);
  ok(!ghost && !(await carol.$('#ghost')), 'a sideways swipe never pulls out a card');
  ok((await h.handCount(carol)) === 20, 'the hand is untouched by the swipe');
  // Let the swipe's fling settle: a touch during a fling only stops it.
  for (let last = -1, now; (now = await carol.evaluate(() => hand.scrollLeft)) !== last; last = now) await h.sleep(250);
  // The hand card nearest the hand's middle (the fling decides which one).
  const c5 = await carol.evaluate(() => {
    const hr = hand.getBoundingClientRect(), mid = hr.left + hr.width / 2;
    const r = [...document.querySelectorAll('.hcard')].map((e) => e.getBoundingClientRect())
      .sort((a, b) => Math.abs(a.left + a.width / 2 - mid) - Math.abs(b.left + b.width / 2 - mid))[0];
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const wr = await rect(carol, '#table-wrap'), cx = c5.x + c5.w / 2;
  const n0 = await h.handCount(carol);
  ghost = await touchDrag(carol, cx, c5.y + c5.h / 2, cx, wr.y + wr.h * 0.7);
  const played = await h.waitHand(carol, n0 - 1).then(() => true, () => false);
  ok(ghost && played, `a vertical touch drag pulls a card out (ghost) and plays it (${n0} → ${n0 - 1})`);
  await carol.evaluate(() => { hand.scrollLeft = 0; });
  const hb = await rect(carol, '#hand');
  await carol.mouse.move(hb.x + hb.w / 2, hb.y + hb.h / 2);
  await carol.mouse.wheel(0, 240);
  await carol.waitForFunction(() => hand.scrollLeft > 0, null, { timeout: 3000 }).catch(() => {});
  ok((await carol.evaluate(() => hand.scrollLeft)) > 0, 'a mouse wheel over the hand scrolls it sideways');
  // Desktop mouse: drag-to-play is unchanged, even when it starts sideways.
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  const gb = await rect(guest, '.hcard'), gt = await rect(guest, '#table');
  await guest.mouse.move(gb.x + gb.w / 2, gb.y + gb.h / 2);
  await guest.mouse.down();
  await guest.mouse.move(gb.x + gb.w / 2 + 40, gb.y + gb.h / 2, { steps: 4 });
  await guest.mouse.move(gt.x + gt.w * 0.3, gt.y + gt.h * 0.3, { steps: 10 });
  await guest.mouse.up();
  await h.waitHand(guest, 0);
  ok(true, 'desktop: a mouse drag that starts sideways still plays the card');

  section('UI-S1: tapping a hand card zooms it on touch');
  await carol.tap('.hcard', { position: { x: 10, y: 40 } }); // its visible edge: the hand is fanned
  await carol.waitForSelector('#peek:not(.hidden)', { timeout: 3000 }).catch(() => {});
  await h.sleep(400); // the tap's trailing click must not close it
  ok(await carol.isVisible('#peek'), 'the zoom overlay opens and stays open after the tap');
  if (await carol.isVisible('#peek')) {
    await carol.tap('#peek');
    await carol.waitForSelector('#peek.hidden', { state: 'attached' });
    ok(true, 'tapping the overlay closes it');
  }
  // A mouse drag dropped back onto its own card is not a click: no zoom.
  await guest.dblclick('.item.pile');
  await h.waitHand(guest, 1);
  const gb2 = await rect(guest, '.hcard');
  await guest.mouse.move(gb2.x + gb2.w / 2, gb2.y + gb2.h / 2);
  await guest.mouse.down();
  await guest.mouse.move(gb2.x + gb2.w / 2, gb2.y + gb2.h / 2 - 30, { steps: 4 });
  await guest.mouse.move(gb2.x + gb2.w / 2, gb2.y + gb2.h / 2, { steps: 4 });
  await guest.mouse.up();
  await h.sleep(300);
  ok(!(await guest.isVisible('#peek')) && (await h.handCount(guest)) === 1, 'a drag dropped back on its card neither zooms nor plays');
  await guest.click('.hcard');
  await guest.waitForSelector('#peek:not(.hidden)');
  ok(true, 'desktop: clicking a hand card still zooms it');

  section('EDGE-14: Escape');
  await guest.keyboard.press('Escape');
  await guest.waitForSelector('#peek.hidden', { state: 'attached', timeout: 3000 }).catch(() => {});
  ok(!(await guest.isVisible('#peek')), 'Escape closes the zoom overlay');
  if (await guest.isVisible('#peek')) await guest.click('#peek'); // keep going without the fix
  await guest.click('.item.pile');
  await guest.waitForSelector('#action-bar:not(.hidden)');
  await guest.click('#help-btn');
  await guest.waitForSelector('#help-dialog[open]');
  await guest.keyboard.press('Escape');
  await guest.waitForSelector('#help-dialog:not([open])', { state: 'attached' });
  ok(await guest.isVisible('#action-bar'), 'with a dialog open, Escape only closes the dialog');
  await guest.keyboard.press('Escape');
  await guest.waitForSelector('#action-bar.hidden', { state: 'attached', timeout: 3000 }).catch(() => {});
  ok(!(await guest.isVisible('#action-bar')), 'Escape dismisses the action bar');
  if (!(await guest.isVisible('#action-bar'))) await guest.click('.item.pile');
  await guest.waitForSelector('#action-bar:not(.hidden)');
  await guest.click('[data-cmd="peek"]');
  await guest.waitForSelector('#peek:not(.hidden)');
  await guest.keyboard.press('Escape');
  await guest.waitForSelector('#peek.hidden', { state: 'attached', timeout: 3000 }).catch(() => {});
  ok(!(await guest.isVisible('#peek')), 'Escape closes a private peek');
  if (await guest.isVisible('#peek')) await guest.click('#peek');
  await guest.keyboard.press('Escape');

  section('UX-11: compact announcement banner on phones');
  await h.enableRules(host, { code: SCRIPT });
  for (const [n, p, maxH] of [['portrait', carol, 100], ['landscape', dan, 90]]) {
    await p.waitForSelector('#announce:not(.hidden)');
    const a = await rect(p, '#announce'), W = p.viewportSize().width;
    ok(a.h <= maxH && a.x >= 0 && a.r <= W, `${n}: banner is ${a.w | 0}x${a.h | 0}px (≤ ${maxH}px tall, on screen)`);
  }
  const da = await rect(host, '#announce');
  ok(da.h < 80, `desktop: banner is one or two lines (${da.w | 0}x${da.h | 0})`);

  section('UX-4: the rules button row never hides your own seat label');
  for (const [n, p] of [['desktop', host], ['portrait', carol], ['landscape', dan]]) {
    await p.waitForSelector('#rules-btns:not(.hidden) button');
    await p.waitForFunction(() => document.querySelector('.seat.me'));
    const rb = await rect(p, '#rules-btns'), me = await rect(p, '.seat.me'), wrap = await rect(p, '#table-wrap');
    ok(!overlap(rb, me) && rb.b <= me.y + 1, `${n}: row (${rb.y | 0}–${rb.b | 0}) sits above my label (${me.y | 0}–${me.b | 0})`);
    ok(rb.y >= wrap.y && rb.b <= wrap.b, `${n}: the row is inside the table area`);
    const bh = await p.$$eval('#rules-btns button', (bs) => Math.max(...bs.map((b) => b.getBoundingClientRect().height)));
    ok(bh < 40, `${n}: two-word button labels stay on one line (button height ${bh | 0}px)`);
  }

  section('UX-6: the phone log panel covers the table, rules row included');
  await carol.tap('#log-btn');
  await carol.waitForSelector('#side:not(.hidden)');
  const cover = await carol.evaluate(() => {
    const side = document.getElementById('side').getBoundingClientRect();
    const pts = [...document.querySelectorAll('#rules-btns button, .seat')].map((e) => {
      const r = e.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }).filter(([x, y]) => x > side.left + 2 && x < side.right && y > side.top && y < side.bottom);
    // .seat is pointer-events:none; for the paint order, give it hit-testing.
    for (const s of document.querySelectorAll('.seat')) s.style.pointerEvents = 'auto';
    const hits = pts.map(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#side'));
    for (const s of document.querySelectorAll('.seat')) s.style.pointerEvents = '';
    return { n: hits.length, all: hits.every(Boolean) };
  });
  ok(cover.n >= 2 && cover.all, `the open log paints above all ${cover.n} table controls/labels under it`);
  await carol.tap('#log-btn');

  section('UX-5: toasts are click-through, clear of the controls and of the banner');
  for (const [n, p] of [['desktop', host], ['portrait', carol], ['landscape', dan]]) {
    await p.click('#rules-btns [data-rbtn="ann"]');
    await p.waitForSelector('#announce:not(.hidden):not(.fade)');
    await p.click('#rules-btns [data-rbtn="tell"]');
    await h.toastHas(p, 'Told you so');
    const t = await rect(p, '#toast'), a = await rect(p, '#announce'), W = p.viewportSize().width;
    ok(await p.isVisible('#announce') && !overlap(t, a) && t.y >= a.b, `${n}: toast [${t.y | 0}–${t.b | 0}] stacks below the banner [${a.y | 0}–${a.b | 0}]`);
    // (final overlay, PT-7: in phone landscape the notices sit in the empty margin beside the round felt)
    const feltL = await p.evaluate(() => { const w = document.getElementById('table-wrap').getBoundingClientRect(); return w.left + w.width / 2 - w.height / 2; });
    if (n === 'landscape') ok(t.r <= feltL + 1 && a.r <= feltL + 1 && t.h < 90, `${n}: banner and toast sit in the margin left of the felt (toast ${t.x | 0}–${t.r | 0}, banner –${a.r | 0}, felt from ${feltL | 0})`);
    else ok(t.h < 70 && (t.h < 45 || t.w > W * 0.6), `${n}: the toast is one line or uses the width (${t.w | 0}x${t.h | 0}px of ${W}px), not a narrow column`);
    const top = await p.evaluate(() => {
      const H = document.getElementById('table-wrap').getBoundingClientRect();
      const n = ['#toast', '#announce'].map((s) => document.querySelector(s).getBoundingClientRect());
      return [...document.querySelectorAll('.seat')].filter((e) => { const r = e.getBoundingClientRect(); return r.bottom < H.top + H.height / 3 && n.some((q) => q.left < r.right && r.left < q.right && q.top < r.bottom && r.top < q.bottom); }).map((e) => e.textContent);
    });
    ok(!top.length, `${n}: banner and toast leave the seat labels across the top readable${top.length ? ` (cover ${top})` : ''}`);
    const r = await p.evaluate(() => {
      const t = document.getElementById('toast'), tr = t.getBoundingClientRect();
      const ids = ['#rules-btns', '.seat.me', '#hand-bar', '#toolbar'];
      const hit = ids.filter((s) => { const q = document.querySelector(s).getBoundingClientRect(); return tr.left < q.right && q.left < tr.right && tr.top < q.bottom && q.top < tr.bottom; });
      const b = document.querySelector('#rules-btns button').getBoundingClientRect();
      return { pe: getComputedStyle(t).pointerEvents, hit, under: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('#rules-btns') != null };
    });
    ok(r.pe === 'none', `${n}: the toast is click-through`);
    ok(!r.hit.length, `${n}: the toast covers none of the toolbar, rules row, my seat or hand${r.hit.length ? ` (covers ${r.hit})` : ''}`);
    ok(r.under, `${n}: the rules button is clickable while the toast shows`);
  }
  await guest.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.base });
  await guest.click('#invite-btn');
  await h.toastHas(guest, 'Invite link copied');
  const bg = () => guest.$eval('#toast', (t) => getComputedStyle(t).backgroundColor);
  ok((await bg()) === 'rgb(5, 150, 105)', 'good news (invite copied) is green');
  await guest.click('#rules-btns [data-rbtn="tell"]');
  await h.toastHas(guest, 'Told you so');
  ok((await bg()) === 'rgb(220, 38, 38)', `a notice right after it is red again (${await bg()})`);

  section('UX-14: name bulbs');
  await host.click('#rules-btns [data-rbtn="shuf"]');
  await logHas(guest, 'Rules shuffled');
  ok(!(await guest.evaluate(() => [...document.querySelectorAll('.fx-bulb')].some((b) => b.textContent.includes('Rules')))), 'script ops show no "📜 Rules" bulbs (the log credits them)');
  await guest.dblclick('.item.pile');
  await host.waitForFunction(() => [...document.querySelectorAll('.fx-bulb')].some((b) => b.textContent === 'Bob'));
  const pos = () => host.evaluate(() => { const b = [...document.querySelectorAll('.fx-bulb')].find((x) => x.textContent === 'Bob'); return b?.style.translate; }); // (placed by a translation since the 2B fix-up 2)
  const p0 = await pos();
  const tw = await rect(host, '#table-wrap');
  await host.mouse.move(tw.x + tw.w * 0.3, tw.y + tw.h * 0.3);
  await host.mouse.wheel(0, -300);
  const p1 = await pos();
  ok(p1 && p1 !== p0, `a live bulb follows the view when zooming (${p0} → ${p1})`);

  section('EDGE-10: deck building is single-flight and cancellable');
  // Slow image decoding down so the build takes a while.
  await guest.evaluate(() => {
    const orig = window.createImageBitmap;
    window.createImageBitmap = async (...a) => { await new Promise((r) => setTimeout(r, 600)); return orig(...a); };
  });
  const decks = () => guest.evaluate(() => [...document.querySelectorAll('.item.pile .pname')].filter((e) => e.textContent === 'Deck').length);
  const files = [1, 2, 3].map((k) => ({ name: `c${k}.png`, mimeType: 'image/png', buffer: PNG }));
  const openForm = async () => {
    await guest.click('#add-deck-btn');
    await guest.waitForSelector('#deck-dialog[open]');
    await guest.check('input[name="deck-kind"][value="img"]');
    await guest.setInputFiles('#deck-files', files);
  };
  await openForm();
  await guest.click('#deck-add');
  const busy = await guest.$eval('#deck-add', (b) => [b.disabled, b.textContent]);
  ok(busy[0] && /Building/.test(busy[1]), `while building, Add is disabled and says "${busy[1]}"`);
  await guest.click('#deck-add', { force: true }).catch(() => {});
  await guest.waitForSelector('#deck-dialog:not([open])', { state: 'attached', timeout: 15000 });
  await guest.waitForFunction(() => [...document.querySelectorAll('.item.pile .pname')].some((e) => e.textContent === 'Deck'));
  await h.sleep(2500);
  ok((await decks()) === 1, `a second click while building adds no second deck (${await decks()} piles)`);
  ok(await guest.$eval('#deck-add', (b) => !b.disabled && b.textContent === 'Add deck'), 'the button is restored afterwards');
  await openForm();
  await guest.click('#deck-add');
  await guest.click('#deck-dialog button[value="cancel"]');
  await guest.waitForSelector('#deck-dialog:not([open])', { state: 'attached' });
  // Reopen while the cancelled build still runs: it must neither add its deck
  // nor close the fresh dialog.
  await guest.click('#add-deck-btn');
  await guest.waitForSelector('#deck-dialog[open]');
  ok(await guest.$eval('#deck-add', (b) => !b.disabled && b.textContent === 'Add deck'), 'reopened during a cancelled build: Add is ready, not "Building…"');
  await h.sleep(3000);
  ok((await decks()) === 1, `Cancel during the build adds nothing (${await decks()} piles)`);
  ok(await guest.isVisible('#deck-dialog'), 'the stale build leaves the reopened dialog open');
  ok(await guest.$eval('#deck-add', (b) => !b.disabled), 'the button is usable again after a cancelled build');
  await guest.click('#deck-dialog button[value="cancel"]');

  await env.done();
})().catch(h.crash);
