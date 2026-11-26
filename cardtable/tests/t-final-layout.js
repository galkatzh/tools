// Final review, layout: desktop notices centred over the table, not the log
// panel (INT-4); a toast never covers the new-table game strip (INT-5);
// Hold'em on phones — small see-through seat labels clear of the board
// (PT-6), and in landscape the button row and notices in the margins beside
// the felt, off the board, the reveals and the side seats (INT-7, PT-7); no
// blocked-vibrate console error after a reload on your turn (PT-12).
const h = require('./h');
const { ok, section, logHas } = h;
const { rects, overlapPast1px: overlap } = require('./final-lib'); // (contact within 1 px is no overlap here)
const { devices } = h.playwright;

const CLIP = ['clipboard-read', 'clipboard-write'];
const box = async (p, sel) => (await rects(p, sel))[0];
const centre = (r) => (r.l + r.r) / 2;
/** Face-up cards on the table (the board, reveals). */
const upCards = (p) => rects(p, '.item:not(.pile):has(.std)');
const hits = (as, bs) => as.flatMap((a) => bs.filter((b) => overlap(a, b)).map((b) => `${a.txt}×${b.txt}`));
/** Clicks Check/Call for whoever is to act, until `done()` holds. */
async function playUntil(P, done) {
  for (let k = 0; k < 40 && !(await done()); k++) {
    for (const p of P) {
      const b = await p.$('#rules-btns [data-rbtn="check"], #rules-btns [data-rbtn="call"]');
      if (b) { await b.click().catch(() => {}); await h.sleep(400); }
    }
    await h.sleep(300);
  }
}

(async () => {
  const env = await h.start();

  section('INT-5: on a new table a toast never covers the game strip');
  for (const [tag, ctx] of [['desktop', { permissions: CLIP }], ['phone', { ...devices['iPhone 13'], permissions: CLIP }]]) {
    const p = await env.page('Solo-' + tag, { ctx });
    await p.goto(env.url);
    await h.joinAs(p, 'Solo');
    await p.waitForSelector('#game-strip:not(.hidden)');
    await p.click('#invite-btn');
    await h.toastHas(p, 'Invite link copied');
    const s = await box(p, '#game-strip'), t = await box(p, '#toast');
    ok(!overlap(s, t) && t.t >= s.b, `${tag}: the toast (${t.t | 0}–${t.b | 0}) sits below the strip (${s.t | 0}–${s.b | 0})`);
    await p.click('#game-strip-x');
    await p.click('#invite-btn');
    await h.sleep(300);
    ok((await box(p, '#notices')).t < s.b, `${tag}: once the strip is dismissed the notices move back up`);
    await p.close();
  }

  section('INT-4: desktop notices are centred over the table, clear of the log panel');
  const host = await env.page('Alice', { ctx: { ...devices['iPhone 13 landscape'], permissions: CLIP } });
  const carol = await env.page('Carol');
  await host.goto(env.url);
  await h.joinAs(host, 'Alice');
  await host.waitForSelector('.item.pile .count');
  await carol.goto(host.url());
  await h.joinAs(carol, 'Carol');
  await carol.waitForSelector('.item.pile .count', { timeout: 30000 });
  await h.enableRules(host, { code: "({ name: 'Banner', setup(t) { t.announce('Hello there, table') } })" });
  await carol.waitForSelector('#announce:not(.hidden)', { timeout: 10000 });
  const wrap = await box(carol, '#table-wrap'), side = await box(carol, '#side'), ann = await box(carol, '#announce');
  ok(await carol.isVisible('#side') && Math.abs(centre(ann) - centre(wrap)) < 3 && ann.r <= side.l, `the banner is centred on the table (${centre(ann) | 0} vs ${centre(wrap) | 0}) and ends before the log panel (${ann.r | 0} ≤ ${side.l | 0})`);
  await carol.click('#log-btn');
  await h.sleep(200);
  ok(Math.abs(centre(await box(carol, '#notices')) - centre(await box(carol, '#table-wrap'))) < 3, 'with the panel closed, the notices span the (wider) table again');
  await carol.click('#log-btn');

  section("PT-6 / PT-7 / INT-7: Hold'em on phones");
  const bob = await env.page('Bob', { ctx: devices['iPhone 13'] });
  await bob.goto(host.url());
  await h.joinAs(bob, 'Bob');
  await bob.waitForSelector('.item.pile .count', { timeout: 30000 });
  await host.waitForFunction(() => document.querySelectorAll('.seat').length === 3, null, { timeout: 30000 });
  const P = [host, bob, carol];
  host.on('dialog', (d) => d.accept().catch((e) => console.error(e)));
  await host.click('#games-btn');
  await host.click('#games-list [data-game="holdem"]');
  await logHas(bob, "«Hold'em (chips)» enabled");
  await host.click('#rules-btns [data-rbtn="new"]');
  await h.waitHand(bob, 2);
  ok(await host.evaluate(() => document.getElementById('main').classList.contains('gutters')), 'iPhone 13 landscape: the felt leaves margins (.gutters)');
  ok(await bob.evaluate(() => document.getElementById('table-wrap').classList.contains('small-table')), 'iPhone 13 portrait: the table is drawn small (.small-table)');
  // the host always has a row mid-hand (Abandon); wait for its turn: the full betting row
  await playUntil(P, () => host.$('#rules-btns [data-rbtn="r:20"], #rules-btns [data-rbtn="allin"]').then(Boolean));
  const row = await box(host, '#rules-btns'), seats = await rects(host, '.seat');
  const lines = await host.$$eval('#rules-btns button', (bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
  // the "Your turn" chip (host to act) sits in the free left margin: off the row, the felt and the notices
  // (it shows for ~2 s: hold it up to measure)
  await host.evaluate(() => document.getElementById('turn-cue').classList.remove('hidden'));
  const cue = await box(host, '#turn-cue');
  await host.evaluate(() => document.getElementById('turn-cue').classList.add('hidden'));
  const felt = await box(host, '#table'), cueOver = hits([cue], [row, ...(await rects(host, '#announce:not(.hidden), #toast:not(.hidden)'))]);
  ok(cue && !cueOver.length && cue.r <= felt.l + 2, `landscape: the "Your turn" chip sits in the left margin, clear of the button row and notices (${cueOver.join() || 'clear'})`);
  ok(!hits([row], seats).length, `landscape: the host's ${await host.locator('#rules-btns button').count()} buttons (${lines} line(s)) hide no seat label (${hits([row], seats).join() || 'clear'})`);
  await playUntil(P, () => host.textContent('#log').then((t) => t.includes('Flop')));
  await host.waitForFunction(() => document.querySelectorAll('.item:not(.pile) .std').length >= 3, null, { timeout: 10000 });
  await h.sleep(500);
  for (const [n, p] of [['landscape', host], ['portrait', bob]]) {
    const up = await upCards(p), lab = await rects(p, '.seat');
    ok(up.length >= 3 && !hits(lab, up).length, `${n}: no seat label covers a flop card (${hits(lab, up).join() || 'clear'})`);
    const over = await rects(p, '#rules-btns:not(.hidden), #announce:not(.hidden)');
    ok(!hits(over, up).length, `${n}: neither the button row nor the "Flop" banner covers the board (${hits(over, up).join() || 'clear'})`);
  }
  await playUntil(P, () => host.textContent('#log').then((t) => /wins \d|split \d/.test(t)));
  await host.waitForFunction(() => document.querySelectorAll('.item:not(.pile) .std').length >= 11, null, { timeout: 10000 }).catch(() => {});
  await h.sleep(500);
  const up = await upCards(host), over = await rects(host, '#rules-btns:not(.hidden), #announce:not(.hidden), #toast:not(.hidden)');
  ok(up.length >= 11 && !hits(over, up).length, `landscape showdown: the reveals and board stay clear of the row and the result banner (${up.length} cards; ${hits(over, up).join() || 'clear'})`);

  section('PT-12: a reload on your turn logs no blocked-vibrate error');
  await host.click('#games-btn');
  await host.click('#games-list [data-game="turns"]');
  await logHas(host, '«Turn order» enabled');
  await host.waitForFunction(() => document.title.startsWith('⏳ Your turn'), null, { timeout: 10000 });
  const errs = [];
  host.on('console', (m) => { if (m.type() === 'error' && /vibrate/.test(m.text())) errs.push(m.text()); });
  await host.reload();
  await host.waitForSelector('.item.pile .count', { timeout: 30000 });
  await host.waitForFunction(() => document.title.startsWith('⏳ Your turn'), null, { timeout: 30000 });
  await h.sleep(1000);
  ok(!errs.length, `the resumed host is told it's their turn without a console error (${errs.join() || 'none'})`);
  await env.done();
})().catch(h.crash);
