// E2E (UX-I1, UX-I5): remote deals, flips, moves and draws animate (motion
// on; nothing under reduced motion), a guest's own drop never snaps back, and
// a touch long-press zooms a face-up card without breaking drags or pinches.
const h = require('./h');
const { ok, section, logHas } = h;
const { shot, MOTION, player, visible, cmd, PILE } = require('./fun-lib');
const { devices } = h.playwright;

(async () => {
  const env = await h.start();
  const host = await player(env, 'Alice', env.url, { ctx: MOTION });
  const url = await host.evaluate(() => location.href);
  const guest = await player(env, 'Bob', url, { ctx: MOTION });
  const calmPage = await player(env, 'Cal', url); // reduced motion (the harness default)
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3);

  // ------------------------------------------------------------------ UX-I1
  section('motion: remote deals, flips, moves and draws glide (motion on)');
  const ids = (p) => p.$$eval('.item', (els) => els.map((el) => el.dataset.id));
  /** Starts a recorder on page p: every animation that starts on .item/.fly elements (a move's glide:
   *  left/top, or since Phase 3 translate — a live drag's end runs out on translate alone). */
  const record = (p) => p.evaluate(() => {
    window.SEEN = { deal: 0, flip: 0, move: 0, fly: 0 };
    const tick = () => {
      for (const a of document.getAnimations()) {
        const el = a.effect?.target, k = a.transitionProperty ? (el?.classList.contains('item') && /^(left|top|translate)$/.test(a.transitionProperty) ? 'move' : null) : el?.classList.contains('fly') ? 'fly' : el?.classList.contains('cardbox') ? 'flip' : el?.classList.contains('item') ? 'deal' : null;
        if (k && !a.__seen) { a.__seen = 1; window.SEEN[k]++; }
      }
      window.REC = requestAnimationFrame(tick);
    };
    tick();
  });
  const seen = (p) => p.evaluate(() => window.SEEN);
  await record(guest);
  await record(calmPage);
  const before = await ids(guest);
  await cmd(host, PILE, 'dealup');
  await guest.waitForFunction((n) => document.querySelectorAll('.item').length > n, before.length);
  await guest.waitForFunction(() => window.SEEN.deal > 0, null, { timeout: 3000 }).catch(() => {});
  ok((await seen(guest)).deal > 0, 'a dealt card slides out of the deck');
  const card = (await ids(guest)).find((id) => !before.includes(id));
  const CARD = `.item[data-id="${card}"]`;
  await cmd(host, CARD, 'flip');
  await guest.waitForFunction((s) => document.querySelector(s).dataset.sig.includes('|false|'), CARD);
  await guest.waitForFunction(() => window.SEEN.flip > 0, null, { timeout: 3000 }).catch(() => {});
  ok((await seen(guest)).flip > 0, 'a flip turns the card over');
  // A host drag arrives at the guest as a position change: it glides.
  const hb = await host.locator(CARD).boundingBox();
  await host.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await host.mouse.down();
  await host.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2 + 40, { steps: 8 });
  ok(await host.$eval(CARD, (el) => getComputedStyle(el).transitionDuration.split(',').every((d) => parseFloat(d) === 0)), 'the local drag itself is never animated');
  await host.mouse.up();
  await guest.waitForFunction(() => window.SEEN.move > 0, null, { timeout: 3000 }).catch(() => {});
  ok((await seen(guest)).move > 0, 'a remote move glides');
  await host.dblclick(PILE); // a draw: a card back flies to Alice's seat
  await guest.waitForFunction(() => window.SEEN.fly > 0, null, { timeout: 3000 }).catch(() => {});
  ok((await seen(guest)).fly > 0, 'a draw sends a card back flying to the drawer\'s seat');
  await guest.waitForFunction(() => !document.querySelector('.fly'), null, { timeout: 3000 });
  ok(true, 'flights clean up after themselves');
  const cs = await seen(calmPage);
  ok(!cs.deal && !cs.flip && !cs.move && !cs.fly, `reduced motion: nothing animates (${JSON.stringify(cs)})`);

  section('motion: a guest\'s own drop never snaps back to a stale spot');
  const gb = await guest.locator(CARD).boundingBox();
  await guest.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await guest.mouse.down();
  for (let k = 1; k <= 8; k++) { await guest.mouse.move(gb.x + gb.width / 2 - 14 * k, gb.y + gb.height / 2 + 6 * k); await h.sleep(30); }
  const drop = await guest.$eval(CARD, (el) => [el.style.left, el.style.top].join());
  await guest.evaluate((s) => { window.POS = []; const el = document.querySelector(s); new MutationObserver(() => window.POS.push([el.style.left, el.style.top].join())).observe(el, { attributes: true, attributeFilter: ['style'] }); }, CARD);
  await guest.mouse.up();
  await logHas(host, 'Bob moved');
  await h.sleep(400); // let any stale in-flight state land
  const pos = await guest.evaluate(() => window.POS);
  ok(pos.every((p) => p === drop), `the card stays where it was dropped (${[...new Set(pos)].join(' | ') || drop})`);

  // ------------------------------------------------------------------ UX-I5
  section('touch long-press zooms a face-up card');
  const phone = await player(env, 'Pia', url, { ctx: devices['iPhone 13'] });
  await phone.waitForSelector(CARD);
  await cmd(host, CARD, 'flip'); // face up again
  await phone.waitForFunction((s) => document.querySelector(s).dataset.sig.includes('|true|'), CARD);
  const cdp = await phone.context().newCDPSession(phone);
  const centre = async (sel) => { const b = await phone.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  let c = await centre(CARD);
  await touch('touchStart', [c]);
  await phone.waitForSelector('#peek:not(.hidden)', { timeout: 2000 }).catch(() => {});
  ok(await visible(phone, '#peek') && await phone.$eval('#peek-inner', (el) => !!el.querySelector('.face')), 'holding a face-up card for ~½ s zooms its face');
  await shot(phone, 'phone-longpress');
  await h.sleep(300);
  ok(await visible(phone, '#peek'), 'the zoom stays while the finger is down');
  await touch('touchEnd', []);
  await phone.waitForSelector('#peek.hidden', { state: 'attached', timeout: 2000 }).catch(() => {});
  ok(!(await visible(phone, '#peek')), 'lifting the finger closes it');
  ok(!(await visible(phone, '#action-bar')), 'and the long-press does not also select the card');

  c = await centre(CARD); // a touch drag still moves the card, without zooming
  await touch('touchStart', [c]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [{ x: c.x + 8 * k, y: c.y - 6 * k }]);
  await h.sleep(600);
  await touch('touchEnd', []);
  await logHas(host, 'Pia moved');
  ok(!(await visible(phone, '#peek')), 'a touch drag moves the card and never zooms');

  c = await centre(CARD); // two fingers: a pinch, not a long-press
  await touch('touchStart', [c, { x: c.x + 60, y: c.y + 60 }]);
  await touch('touchMove', [{ x: c.x - 10, y: c.y - 10 }, { x: c.x + 80, y: c.y + 80 }]);
  await h.sleep(600);
  await touch('touchEnd', []);
  ok(!(await visible(phone, '#peek')), 'a pinch never zooms the card');

  c = await centre(PILE); // the deck's top is face down: nothing to show
  await touch('touchStart', [c]);
  await h.sleep(600);
  await touch('touchEnd', []);
  ok(!(await visible(phone, '#peek')), 'a long-press on a face-down pile reveals nothing');

  const hb2 = await host.locator(CARD).boundingBox(); // the mouse keeps click-to-select
  await host.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  const barWas = await visible(host, '#action-bar');
  await host.mouse.down();
  await h.sleep(600);
  await host.mouse.up();
  ok(!(await visible(host, '#peek')) && (await visible(host, '#action-bar')) !== barWas, 'a long mouse press just (de)selects (desktop unchanged)');
  await shot(phone, 'phone-table');
  const cm = await phone.evaluate((s) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.querySelector(`${s} .cardbox`).dispatchEvent(e); return e.defaultPrevented; }, CARD);
  ok(cm, 'a card\'s long-press context menu (Android "Download image…") is suppressed');

  section('motion: a guest\'s drop the host moves on elsewhere still shows the host\'s spot');
  // The script snaps every moved card to a 100-px grid: the confirming state
  // matches neither the drop spot nor the origin, so the guest's hold on its
  // drop must time out by itself (no further state arrives on a quiet table).
  await h.enableRules(host, { code: `({ name: 'Snap', onAction(t, a) {
    const it = a.t === 'move' && t.items().find((i) => i.id === a.id);
    if (it && (it.x % 100 || it.y % 100)) t.move(a.id, Math.round(it.x / 100) * 100, Math.round(it.y / 100) * 100);
  } })` });
  await logHas(guest, '«Snap» enabled');
  const sb = await guest.locator(CARD).boundingBox();
  await guest.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await guest.mouse.down();
  for (let k = 1; k <= 8; k++) { await guest.mouse.move(sb.x + sb.width / 2 + 17 * k, sb.y + sb.height / 2 + 9 * k); await h.sleep(30); }
  await guest.mouse.up();
  const t0 = Date.now();
  // Where the script puts the card: the drop spot (held on the guest's
  // screen), snapped. The mid-drag moves are snapped too, so on a loaded
  // machine the host can still show an earlier grid spot when it is read.
  const final = await guest.$eval(CARD, (el) => [el.style.left, el.style.top].map((v) => `${Math.round(parseFloat(v) / 100) * 100}px`).join());
  await logHas(host, 'Bob moved');
  const at = (s) => { const el = document.querySelector(s[0]); return [el.style.left, el.style.top].join() === s[1]; };
  await host.waitForFunction(at, [CARD, final], { timeout: 5000 }).catch(() => {});
  const want = await host.$eval(CARD, (el) => [el.style.left, el.style.top].join());
  await guest.waitForFunction(at, [CARD, want], { timeout: 4000 }).catch(() => {});
  const got = await guest.$eval(CARD, (el) => [el.style.left, el.style.top].join());
  ok(want === final && got === want && Date.now() - t0 < 3000, `the guest shows the card where the host has it within ~2 s (${got} vs ${want}, snapped drop ${final}, ${Date.now() - t0} ms)`);

  await env.done();
})().catch(h.crash);
