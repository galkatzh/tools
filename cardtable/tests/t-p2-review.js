// Regressions for the Phase 2B review (the fix-up after the test authors and
// three reviewers): one section per issue, checked on the screens that show
// it — Alice hosts on a desktop, Bob plays on a desktop, Carol watches on an
// iPhone 13 — through real clicks, taps, drags and keys (actions only set
// things up).
//   frame      a piece played from the hand lands where the pointer let go;
//              a board set up at the centre sits in the middle of the felt
//   catalog    a new guest draws every piece with its face, once: never "?"
//   seat menu  a drop or a pan that ends on a seat label opens no menu, nor
//              does a click on a bar button over one that the click redraws
//   board tap  with a piece selected, a tap on a board only puts its bar away
//   give       Give ▸'s buttons are spaced like the bar's
//   ✥ armed    looks armed, and stops being so after 5 s; supplies have ✥ Move (touch)
//   drops      one piece off a stack onto a bag or its supply goes in or back;
//              dropped back on its own stack or supply, nothing is sent; a
//              bag that would overflow is not offered the drop
//   keys       a held key acts once
//   stale bar  a seat change redraws the bar of a selected seat-bound piece
//   phone      the dark seat's halo, a seat label's finger-sized hit box, the
//              watchers box clear of the labels, readable badges, the help
//              dialog inside the screen, Sit down's size, a watcher's squared view
//   turn cue   shows on a table with no hand bar
//   watchdog   a guest whose host has been gone a minute reloads itself, and
//              gets the table back when the host returns
// Screenshots go to shots/review-*.png for review (not asserted).
const h = require('./h');
const L = require('./p1-lib');
const P = require('./p2t-lib');
const { shot } = require('./fun-lib');
const { ok, section } = h;

/** The test box: a rect table, South and North seats (North near black), a
 *  board, a ×5 and a ×999 coin stack, a single coin, coin and tile supplies,
 *  a bag of three coins, a die, and a pawn per seat (seat-bound). */
const REV = {
  name: 'Review', imgs: [],
  table: { shape: 'rect', w: 1400, h: 1000 },
  seats: [{ id: 'south', name: 'South', color: '#e11d48', edge: 'bottom' }, { id: 'north', name: 'North', color: '#1c1917', edge: 'top' }],
  types: {
    coin: { kind: 'token', name: 'Coin', faces: [{ color: '#eab308' }] },
    pawn: { kind: 'token', name: 'Pawn', stack: 'none', shape: 'pawn', faces: [{ color: '#60a5fa' }] },
    die: { kind: 'die', name: 'Die' },
    tile: { kind: 'tile', name: 'Tile', faces: [{ color: '#f5f5f4', label: 'T' }] },
    mat: { kind: 'board', name: 'Mat', w: 400, h: 240, faces: [{ color: '#a16207' }] },
  },
  setup: [
    { piece: 'mat', at: [900, 380] },
    { piece: 'coin', n: 5, at: [200, 300] },
    { supply: 'coin', at: [400, 300] },
    { supply: 'tile', at: [380, 560] },
    { bag: ['coin', 'coin', 'coin'], name: 'Loot', at: [600, 280] },
    { piece: 'coin', n: 999, at: [200, 600] },
    { piece: 'die', at: [700, 700] },
    { piece: 'coin', at: [250, 800] },
    { forEachSeat: [{ piece: 'pawn', at: { seat: [200, 160] }, owner: 'seat' }] },
  ],
};
const PLAIN = { name: 'Plain', imgs: [], types: { peg: { kind: 'token', name: 'Peg', faces: [{ color: '#facc15' }] } }, setup: [{ piece: 'peg', at: [100, 100] }] };
const TURNS = `({ name: 'Turns', buttons: () => [{ id: 'go', label: 'My turn' }], onButton(t, id, p) { t.public.turn = p; } })`;

/** Init script: the most "?" placeholders ever drawn at once (window.__ph). */
function placeholderWatch() {
  window.__ph = 0;
  new MutationObserver(() => { window.__ph = Math.max(window.__ph, document.querySelectorAll('.pface.placeholder').length); })
    .observe(document, { subtree: true, childList: true });
}
/** Init script: every toast this page shows (window.__notes). */
function noticeWatch() {
  window.__notes = [];
  addEventListener('DOMContentLoaded', () => {
    const t = document.getElementById('toast');
    new MutationObserver(() => { if (!t.classList.contains('hidden')) window.__notes.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true, attributes: true });
  });
}

(async () => {
  const env = await h.start();
  /** Player `name` on its own page (`ctx`: a device), with the RTC hook and the watches, once it shows the table. */
  async function player(name, url, ctx) {
    const p = await env.page(name, { ctx });
    for (const f of [L.rtcHook, noticeWatch, placeholderWatch]) await p.addInitScript(f);
    await p.goto(url);
    await h.joinAs(p, name);
    await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
    p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
    return p;
  }
  const host = await player('Alice', env.url);
  const bob = await player('Bob', host.url());
  const act = (a) => L.act(host, a);
  const notes = (p) => p.evaluate(() => window.__notes || []);
  /** The client point of table point (x, y) on page p (a probe in #table: the view's turn, zoom and pan apply). */
  const scr = (p, x, y) => p.evaluate(([x, y]) => {
    const e = document.createElement('i');
    e.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
    document.getElementById('table').appendChild(e);
    const r = e.getBoundingClientRect();
    e.remove();
    return { x: r.left, y: r.top };
  }, [x, y]);
  const items = async (p = host) => (await L.view(p)).items;
  const selected = (p) => p.evaluate(() => document.querySelector('.item.selected')?.dataset.id || null);
  const barCmds = (p) => p.evaluate(() => (document.getElementById('action-bar').classList.contains('hidden') ? [] : [...document.querySelectorAll('#action-bar [data-cmd]')].map((b) => b.dataset.cmd)));
  const menuOpen = (p) => p.evaluate(() => !document.getElementById('seat-menu').classList.contains('hidden'));
  /** Clicks the empty felt on page p (deselects). */
  const felt = async (p, touch) => { const f = await P.feltPoint(p, { band: [0.3, 0.7] }); if (touch) await p.touchscreen.tap(f.x, f.y); else await p.mouse.click(f.x, f.y); await h.sleep(200); };

  section('setup: the review box on a rect table — Alice sits South, Bob North');
  ok((await act({ t: 'loadBox', box: REV, setup: true, clear: true })).ok, 'the host loads the review box');
  ok(await P.waitView(bob, "v.players[me]?.seatId === 'north' && Object.keys(v.items).length === 10"), 'Bob sits North and sees the 10 items');
  const ids = await host.evaluate(() => {
    const v = window.__ct.view(), ty = (it) => (it.t || '').split('/')[1], one = (f) => Object.keys(v.items).find((id) => f(v.items[id]));
    return {
      mat: one((it) => ty(it) === 'mat'), five: one((it) => ty(it) === 'coin' && it.n === 5), big: one((it) => it.n === 999),
      coin: one((it) => it.k === 'g' && ty(it) === 'coin' && !it.n), supply: one((it) => it.k === 's' && ty(it) === 'coin'),
      tiles: one((it) => it.k === 's' && ty(it) === 'tile'), bag: one((it) => it.k === 'b'), die: one((it) => ty(it) === 'die'),
      north: one((it) => it.owner === 'seat:north'), south: one((it) => it.owner === 'seat:south'),
    };
  });
  ok(Object.values(ids).every(Boolean), `every item found (${JSON.stringify(ids)})`);

  section('frame: a piece played from the hand lands centred where the pointer let go (the item frame is the whole table)');
  ok((await act({ t: 'take', id: ids.tiles, hand: true })).ok && await P.waitView(host, 'v.hand.length === 1'), '(Alice takes a tile into her hand)');
  const hc = await host.locator('.hcard').first().boundingBox(), to = await scr(host, 600, 470);
  const ids0 = Object.keys(await items());
  await P.mouseDrag(host, { x: hc.x + hc.width / 2, y: hc.y + hc.height / 2 }, to, { steps: 12 });
  ok(await P.waitView(host, 'Object.keys(v.items).length === a', ids0.length + 1), 'Alice drags it out of her hand onto the felt: it is played');
  const played = Object.keys(await items()).find((id) => !ids0.includes(id)), tv = played && (await items())[played];
  ok(!!tv && Math.abs(tv.x + 50 - 600) < 1 && Math.abs(tv.y + 50 - 470) < 1, `the tile is centred on table point (600, 470), where the pointer let go: its top-left is (${tv?.x}, ${tv?.y})`);
  await h.sleep(400); // (the emptied hand bar is a little shorter: the table refits)
  const at = played && await P.itemXY(host, played), probe = await scr(host, 600, 470);
  ok(!!at && Math.abs(at.x - probe.x) < 1 && Math.abs(at.y - probe.y) < 1, `and it is drawn there: a probe at (600, 470) in #table sits at its centre (${probe.x.toFixed(1)},${probe.y.toFixed(1)} vs ${at && `${at.x.toFixed(1)},${at.y.toFixed(1)}`})`);

  section('catalog: a guest joining draws every piece with its face, once — the boxes come before the first snapshot');
  const total = Object.keys(await items()).length, carol = await player('Carol', host.url(), P.PHONE);
  ok(await carol.waitForFunction((n) => document.querySelectorAll('.item').length >= n && window.__ct.perf.lastSnapRenderMs > 0, total, { timeout: 45000 }).then(() => true, () => false), `Carol's phone draws the table (${total} items)`);
  await h.sleep(1500); // (her registration snapshot follows: it redraws nothing)
  const cj = await carol.evaluate(() => ({ ph: window.__ph, drawn: window.__ct.perf.drawn, dom: document.querySelectorAll('.item').length, ms: window.__ct.perf.lastSnapRenderMs }));
  ok(cj.ph === 0, `no piece was ever drawn as a "?" placeholder (at most ${cj.ph} at once)`);
  ok(cj.drawn === cj.dom, `each item was drawn once: ${cj.drawn} draws for ${cj.dom} items (lastSnapRenderMs ${cj.ms.toFixed(1)} ms: the render of the faces)`);
  ok(await P.waitView(carol, 'v.players[me] && v.players[me].seat == null'), 'Carol watches: both named seats are taken');

  section('seat menu: only a tap on a label opens it — a drop or a pan that ends there does not');
  const southLabel = await P.label(host, /^South — Alice/);
  ok(same(await P.openMenu(host, /^South — Alice/), ['Stand up (watch)']), 'a click on Alice\'s own label opens her menu (Stand up)');
  await host.keyboard.press('Escape');
  ok(!(await menuOpen(host)), '(Escape closes it)');
  const c0 = await P.itemXY(host, ids.coin);
  await P.mouseDrag(host, c0, { x: southLabel.x, y: southLabel.y }, { steps: 12 });
  await h.sleep(700);
  ok(!(await menuOpen(host)), 'Alice drops a coin on her own label: no menu opens');
  ok(await P.waitView(host, 'Math.abs(v.items[a].y - 880) < 80', ids.coin), '(the coin moved there)');
  const f0 = await P.feltPoint(host, { band: [0.05, 0.4] });
  await P.mouseDrag(host, f0, { x: southLabel.x + southLabel.w / 2 - 4, y: southLabel.y }, { steps: 12 });
  await h.sleep(700);
  ok(!(await menuOpen(host)), 'a pan of the felt that ends on her label opens none either');
  await host.click('#view-btn');
  await h.sleep(300);
  // a bar button over a label, which the click redraws away (✥ redraws the bar): the click is the bar's, not the label's
  await P.clickItem(host, ids.five);
  const over = await host.evaluate(([lx, ly]) => {
    const bar = document.getElementById('action-bar'), b = bar.querySelector('[data-cmd="all"]').getBoundingClientRect();
    bar.style.left = `${parseFloat(bar.style.left) + lx - (b.left + b.width / 2)}px`;
    bar.style.top = `${parseFloat(bar.style.top) + ly - (b.top + b.height / 2)}px`;
    const r = bar.querySelector('[data-cmd="all"]').getBoundingClientRect();
    return document.elementFromPoint(lx, ly)?.dataset.cmd === 'all' && Math.abs(r.left + r.width / 2 - lx) < 1;
  }, [southLabel.x, southLabel.y]);
  ok(over, '(Alice selects the ×5 stack; its bar is put so that ✥ Move all lies right over her label)');
  await host.mouse.click(southLabel.x, southLabel.y);
  await h.sleep(500);
  ok(!(await menuOpen(host)) && await host.evaluate(() => !!document.querySelector('#action-bar [data-cmd="all"].on')), 'a click on ✥ arms it, and opens no seat menu (the button it pressed was redrawn away)');
  await host.keyboard.press('Escape');

  section('board tap: with a piece selected, a tap on the (locked) board only puts the bar away; the next one selects it');
  await P.clickItem(host, ids.die);
  ok((await selected(host)) === ids.die, '(Alice selects the die)');
  const matXY = await scr(host, 1250, 420); // (the board's top-right part: nothing lies there)
  await host.mouse.click(matXY.x, matXY.y);
  await h.sleep(300);
  ok((await selected(host)) === null && !(await barCmds(host)).length, 'a tap on the board deselects the die, and selects nothing');
  await host.mouse.click(matXY.x, matXY.y);
  await h.sleep(300);
  ok((await selected(host)) === ids.mat, 'a second tap selects the board');
  await host.keyboard.press('Escape');

  section('Give ▸: the host\'s player and seat buttons are spaced like the rest of the bar');
  await P.clickItem(host, ids.die);
  await host.click('#action-bar [data-cmd="give"]');
  const spacing = await host.evaluate(() => {
    const bs = [...document.querySelectorAll('#action-bar button')].map((b) => b.getBoundingClientRect()), out = [];
    for (let k = 1; k < bs.length; k++) if (Math.abs(bs[k].top - bs[k - 1].top) < 2) out.push(Math.round(bs[k].left - bs[k - 1].right));
    return { n: document.querySelectorAll('#action-bar .give button').length, out };
  });
  ok(spacing.n >= 4 && spacing.out.every((g) => g >= 3), `its ${spacing.n} buttons (the players, then the seats) sit apart, as every button of the bar does (gaps ${spacing.out.join(', ')} px)`);
  await host.keyboard.press('Escape');

  section('✥ Move all: armed, it looks it — and 5 s later it is not armed any more');
  await P.clickItem(bob, ids.five);
  const look = (p) => p.evaluate(() => { const b = document.querySelector('#action-bar [data-cmd="all"]'), cs = b && getComputedStyle(b); return b && { on: b.classList.contains('on'), bg: cs.backgroundColor, shadow: cs.boxShadow }; });
  const off = await look(bob);
  await bob.click('#action-bar [data-cmd="all"]');
  const on = await look(bob);
  ok(!!off && !!on && on.on && on.bg !== off.bg && /inset/.test(on.shadow), `the armed button looks armed (${off?.bg} → ${on?.bg}, ${on?.shadow})`);
  await bob.mouse.move(5, 5); // (off the button: no hover colour)
  await h.sleep(5400);
  const later = await look(bob);
  ok(!!later && !later.on && later.bg === off.bg, 'after 5 s it is disarmed, and looks it again');
  await felt(bob);

  section('drops: one coin off the ×5 stack onto the bag goes in; onto its supply goes back — no loose coin either time');
  const nItems = Object.keys(await items()).length;
  await P.mouseDrag(bob, await P.itemXY(bob, ids.five), await P.itemXY(bob, ids.bag), { steps: 12 });
  ok(await P.waitView(host, 'v.items[a.bag].n === 4 && v.items[a.five].n === 4 && Object.keys(v.items).length === a.n', { ...ids, n: nItems }),
    'Bob drags one coin onto the bag Loot: it holds 4, the stack 4, and no coin lies on the bag');
  ok(await P.waitView(host, "v.log.some((e) => e.txt === 'put Coin into the bag Loot')"), 'logged "put Coin into the bag Loot"');
  await P.mouseDrag(bob, await P.itemXY(bob, ids.five), await P.itemXY(bob, ids.supply), { steps: 12 });
  ok(await P.waitView(host, 'v.items[a.five].n === 3 && Object.keys(v.items).length === a.n', { ...ids, n: nItems }), 'one onto the coin supply: it goes back (×3 left), nothing new on the table');
  ok(await P.waitView(host, "v.log.some((e) => e.txt === 'returned Coin to the Coin supply')"), 'logged "returned Coin to the Coin supply"');

  section('drops: a piece taken out and dropped back on its own stack or supply sends nothing');
  for (const [id, what] of [[ids.five, 'the ×3 stack'], [ids.supply, 'the coin supply']]) {
    const s0 = await P.sentActs(bob), a = await P.itemXY(bob, id), v0 = await items();
    await bob.mouse.move(a.x, a.y);
    await bob.mouse.down();
    await bob.mouse.move(a.x + 70, a.y + 50, { steps: 8 });
    await bob.mouse.move(a.x + 2, a.y + 2, { steps: 8 });
    await bob.mouse.up();
    await h.sleep(1000);
    const v1 = await items();
    ok((await P.sentActs(bob)) === s0 && Object.keys(v1).length === Object.keys(v0).length && v1[id].n === v0[id].n, `out of ${what} and back onto it: nothing sent, nothing changed`);
  }

  section('drops: a stack that would overflow a bag is not offered to it (a plain move instead: no refusal)');
  const big0 = (await items())[ids.big];
  await P.mouseDrag(bob, await P.itemXY(bob, ids.big), await P.itemXY(bob, ids.bag), { shift: true, steps: 12 });
  ok(await P.waitView(host, 'v.items[a.big].x !== a.x0 && v.items[a.bag].n === 4', { ...ids, x0: big0.x }), 'Bob Shift-drags the ×999 stack onto the bag (4 + 999 > 1,000): it is moved there, the bag keeps 4');
  await h.sleep(800);
  ok(!(await notes(bob)).some((t) => /full/.test(t)), `and no "bag is full" refusal shows (${JSON.stringify(await notes(bob))})`);
  await P.mouseDrag(bob, await P.itemXY(bob, ids.big), await scr(bob, 250, 650), { shift: true, steps: 12 });
  await felt(bob);

  section('keys: a held Space rolls once');
  const rolls = async () => (await L.view(host)).log.filter((e) => /^rolled /.test(e.txt)).length;
  const r0 = await rolls();
  await P.clickItem(bob, ids.die);
  await bob.keyboard.down(' ');
  await bob.keyboard.down(' '); // (auto-repeats: repeat = true)
  await bob.keyboard.down(' ');
  await bob.keyboard.up(' ');
  await h.sleep(1200);
  ok((await rolls()) === r0 + 1, `one roll for one press, its auto-repeats ignored (${(await rolls()) - r0} rolls)`);
  await felt(bob);

  section('stale bar: a seat change redraws the bar of a selected seat-bound piece');
  await P.clickItem(bob, ids.north);
  ok((await barCmds(bob)).includes('del'), `Bob selects North's pawn (his seat): his bar offers 🗑 (${(await barCmds(bob)).join(' ')})`);
  ok((await act({ t: 'seat', watch: true, p: bob.pid })).ok, '(the host moves Bob to the watchers)');
  ok(await bob.waitForFunction(() => document.getElementById('action-bar').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false),
    'the pawn stays selected, and its bar empties (it is North\'s, and Bob no longer sits there)');
  const s1 = await P.sentActs(bob);
  await bob.keyboard.press('Delete');
  await h.sleep(1000);
  ok((await P.sentActs(bob)) === s1 && !!(await items())[ids.north] && !(await notes(bob)).some((t) => /belongs/.test(t)), 'Delete sends nothing, and no refusal shows');

  section('phone: a seat label\'s hit box is finger-sized; the watchers box stays clear of the labels');
  const ghost = await P.label(carol, /^North — empty/);
  ok(!!ghost && ghost.h < 32, `Carol's ghost label is drawn ${ghost?.h.toFixed(1)} px tall`);
  await carol.touchscreen.tap(ghost.x, ghost.y - ghost.h / 2 - 6); // 6 px above its top edge
  let m = [];
  await L.until(async () => (m = await P.menu(carol)).length > 0, 2000, 100);
  ok(same(m, ['Sit here']), `a tap 6 px above it still opens its menu (${JSON.stringify(m)})`);
  await felt(carol, true);
  const overlap = await carol.evaluate(() => {
    const w = document.getElementById('watch-box').getBoundingClientRect();
    return [...document.querySelectorAll('.seat')].filter((s) => { const r = s.getBoundingClientRect(); return r.left < w.right && w.left < r.right && r.top < w.bottom && w.top < r.bottom; }).map((s) => s.textContent);
  });
  ok(!overlap.length, `the watchers box covers no seat label (${JSON.stringify(overlap)})`);
  await shot(carol, 'review-phone-watching');
  ok((await act({ t: 'seat', id: 'north', p: bob.pid })).ok, '(the host seats Bob North again)');
  ok(await bob.waitForFunction(() => !!document.querySelector('#action-bar:not(.hidden) [data-cmd="del"]'), null, { timeout: 10000 }).then(() => true, () => false),
    'Bob\'s bar on the still-selected pawn offers 🗑 again');
  await felt(bob);

  section('phone: the near-black seat (North) keeps a visible outline; badges stay readable; the help dialog fits');
  const halo = await carol.evaluate(() => [...document.querySelectorAll('.seat')].map((s) => { const cs = getComputedStyle(s); return { t: s.textContent, o: cs.outlineStyle, w: parseFloat(cs.outlineWidth) }; }));
  const nh = halo.find((x) => x.t.startsWith('North')), sh = halo.find((x) => x.t.startsWith('South'));
  ok(nh?.o !== 'none' && nh?.w >= 1 && sh?.o === 'none', `North's label (#1c1917) has a light outline, South's doesn't (${JSON.stringify([nh, sh])})`);
  const badge = await carol.evaluate(([five, pawn]) => {
    const c = document.querySelector(`.item[data-id="${five}"] .count`).getBoundingClientRect(), d = document.querySelector(`.item[data-id="${pawn}"] .odot`).getBoundingClientRect();
    return { countH: c.height, dot: d.width };
  }, [ids.five, ids.north]);
  ok(badge.countH >= 10 && badge.dot >= 8, `on the phone's fit, the ×3 pill is ${badge.countH.toFixed(1)} px tall and the owner dot ${badge.dot.toFixed(1)} px wide (readable)`);
  await carol.tap('#help-btn');
  await carol.waitForSelector('#help-dialog[open]');
  const hd = await carol.evaluate(() => { const r = document.getElementById('help-dialog').getBoundingClientRect(); return { l: r.left, r: r.right, vw: innerWidth }; });
  ok(hd.l >= 0 && hd.r <= hd.vw, `the help dialog lies inside the 390 px screen (${hd.l.toFixed(0)}–${hd.r.toFixed(0)})`);
  await shot(carol, 'review-phone-help');
  await carol.evaluate(() => document.getElementById('help-dialog').close());

  section('phone: a supply moves by touch — ✥ Move in its bar arms it');
  await P.clickItem(carol, ids.supply, true);
  ok((await barCmds(carol)).includes('all'), `the supply's bar offers ✥ Move (${(await barCmds(carol)).join(' ')})`);
  await carol.locator('#action-bar [data-cmd="all"]').tap();
  const sp0 = (await items())[ids.supply], n1 = Object.keys(await items()).length, sa = await P.itemXY(carol, ids.supply);
  await P.touchDrag(carol, sa, { x: sa.x - 40, y: sa.y + 40 }, 12);
  ok(await P.waitView(host, '(v.items[a.id].x !== a.x || v.items[a.id].y !== a.y) && Object.keys(v.items).length === a.n', { id: ids.supply, x: sp0.x, y: sp0.y, n: n1 }),
    'Carol drags it: the supply moves, and no coin is taken');

  section('phone: Sit down is finger-sized (automatic seating)');
  ok((await act({ t: 'loadBox', box: PLAIN, setup: true })).ok, '(the host loads a box without seats: automatic seating)');
  ok(await P.waitView(carol, 'v.seats === null && v.players[me].seat != null'), '(Carol gets a seat)');
  ok((await act({ t: 'seat', watch: true, p: carol.pid })).ok, '(the host moves her to the watchers)');
  ok(await carol.waitForSelector('#sit-btn:not(.hidden)', { timeout: 10000 }).then(() => true, () => false), 'she has a Sit down button');
  const sit = await carol.locator('#sit-btn').boundingBox();
  ok(sit.height >= 32, `it is ${sit.height.toFixed(0)} px tall (≥ 32)`);
  ok(await P.waitView(carol, 'true') && (((await P.tf(carol)).rot % 90) + 90) % 90 < 0.5, `a watcher's view of a rectangle is squared to an edge (${(await P.tf(carol)).rot}°)`);

  section('draughts: the board is centred on the felt; the turn cue shows with no hand bar');
  await host.evaluate(() => { window.confirm = () => true; });
  await host.click('#games-btn');
  await host.click('#games-list [data-game="draughts"]');
  ok(await P.waitView(host, "Object.keys(v.items).length === 25 && v.table.w === 1400 && v.players[me].seatId === 'light'"), 'Alice sets up Draughts from 🎲 and sits Light');
  await h.sleep(500);
  const gaps = await host.evaluate(() => {
    const t = document.getElementById('table').getBoundingClientRect(), b = document.querySelector('.item.board').getBoundingClientRect();
    return { l: b.left - t.left, r: t.right - b.right, t: b.top - t.top, b: t.bottom - b.bottom };
  });
  ok(Math.abs(gaps.l - gaps.r) < 1.5 && Math.abs(gaps.t - gaps.b) < 1.5, `the board sits in the middle of the table (gaps left ${gaps.l.toFixed(1)}, right ${gaps.r.toFixed(1)}, top ${gaps.t.toFixed(1)}, bottom ${gaps.b.toFixed(1)} px)`);
  ok(await host.evaluate(() => document.body.classList.contains('nohand')), '(no hand bar: nothing on the table goes in a hand)');
  await h.enableRules(host, { code: TURNS });
  await host.waitForSelector('#rules-btns [data-rbtn="go"]');
  await host.click('#rules-btns [data-rbtn="go"]');
  ok(await host.waitForFunction(() => {
    const el = document.getElementById('turn-cue'), r = el.getBoundingClientRect();
    return !el.classList.contains('hidden') && r.width > 0 && r.height > 0 && r.bottom <= innerHeight && r.top >= 0;
  }, null, { timeout: 5000 }).then(() => true, () => false), 'Alice\'s "⏳ Your turn" cue shows, on screen, with the hand bar hidden');
  await shot(host, 'review-desk-turn');

  section('watchdog: a guest whose host has been gone a minute reloads itself, and gets the table back when the host returns');
  const hostUrl = host.url(), hctx = host.context();
  await bob.evaluate(() => { window.__stay = 1; });
  const reloaded = bob.waitForEvent('load', { timeout: 120000 }).then(() => true, () => false);
  const t0 = Date.now();
  await host.close();
  ok(await bob.waitForFunction(() => !document.getElementById('table-hint').classList.contains('hidden'), null, { timeout: 20000 }).then(() => true, () => false), 'Bob sees the host leave (the paused hint)');
  ok(await reloaded, `Bob's page reloads itself (after ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  ok(Date.now() - t0 > 55000, '…not before the host has been gone a minute');
  const back = await hctx.newPage();
  await back.goto(hostUrl);
  ok(await bob.waitForFunction(() => window.__ct?.view().seq > 0 && Object.keys(window.__ct.view().items).length === 25 && !window.__stay, null, { timeout: 60000 }).then(() => true, () => false),
    'once the host is back, Bob (a fresh page) shows the table again');

  await env.done();
})().catch(h.crash);

/** Whether two JSON values are equal. */
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
