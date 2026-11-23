// Phase 2 tables, seats and the hand bar (spec §2l "t-p2-tables.js", items
// 1–7; §2g "The rectangular table", "Named seats and the seat menu", "The
// hand bar hides"; §2h's migration). Alice hosts on a desktop, Bob plays on
// a desktop, Carol on an iPhone 13; every check is made on the screens that
// show it, through real clicks, taps and drags (actions only set things up).
//   1  a rect table: the fit at each 90° seat view, on a desktop and a phone;
//      the pan limit per axis; the zoom ceiling 4 · max(w, h) / 1300
//   2  named seats: the joiner takes the free seat, a third player watches
//      (the 👀 chip); the seat menu: Stand up, Sit here, the host's Move to
//      watchers and Seat ▸; t.players() leaves the watchers out (a tiny
//      script); with automatic seating, Move to watchers and Sit down
//   3  a seat-bound owner follows the seat: who may drag its piece changes
//   4  the hand bar hides with draughts, shows with a deck, hides without it
//      (and stays for a hand that holds a card), on every screen, and the
//      table refits
//   5  an old v2 save (size 1800) resumes as a round table
//   6  the host's size selector on a rect table: "▭ w × h", then a round
//      size asks first, and switches
//   7  a round table never refits as it turns (the other seat and layout
//      suites run unchanged on round tables)
// Screenshots go to shots/tables-*.png for review (not asserted).
const path = require('path');
const h = require('./h');
const L = require('./p1-lib');
const P = require('./p2t-lib');
const { shot } = require('./fun-lib');
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));
const { ok, section } = h;

/** Item 2's box: two named seats in their own colours (not a player's), a
 *  pawn owned by each seat (forEachSeat, owner 'seat') and a free one. */
const DUO = {
  name: 'Duo', imgs: [],
  table: { shape: 'rect', w: 1600, h: 1200 },
  seats: [{ id: 'white', name: 'White', color: '#e11d48', edge: 'bottom' }, { id: 'black', name: 'Black', color: '#7c3aed', edge: 'top' }],
  types: { pawn: { kind: 'token', name: 'Pawn', stack: 'none', faces: [{ color: '#d4d4d4' }] } },
  setup: [{ forEachSeat: [{ piece: 'pawn', at: { seat: [0, 300] }, owner: 'seat' }] }, { piece: 'pawn', at: [400, 570] }],
};
/** Item 1's box: a wide rectangle, one named seat per edge, a peg in each corner. */
const EDGES = { bottom: 0, right: 90, top: 180, left: 270 }; // the view turn that puts each edge at the bottom (CSS rotate: clockwise)
const QUAD = {
  name: 'Quad', imgs: [],
  table: { shape: 'rect', w: 2400, h: 1200, felt: '#1e3a5f' },
  seats: [{ id: 's', name: 'South', edge: 'bottom' }, { id: 'e', name: 'East', edge: 'right' }, { id: 'n', name: 'North', edge: 'top' }, { id: 'w', name: 'West', edge: 'left' }],
  types: { peg: { kind: 'token', name: 'Peg', stack: 'none', faces: [{ color: '#facc15' }] } },
  setup: [{ piece: 'peg', at: [80, 80] }, { piece: 'peg', at: [2260, 80] }, { piece: 'peg', at: [80, 1060] }, { piece: 'peg', at: [2260, 1060] }],
};
/** Automatic seating: a box with no seats (and no table: the table stays). */
const PLAIN = { name: 'Plain', imgs: [], types: { peg: QUAD.types.peg }, setup: [{ piece: 'peg', at: 'center' }] };
const SCRIPT = `({ name: 'Who plays', buttons: () => [{ id: 'who', label: 'Who plays?' }],
  onButton(t) {
    t.public.who = t.players().map((p) => p.name).sort();
    t.public.all = t.players({ all: true }).map((p) => p.name + ':' + (p.seat == null ? 'watching' : p.seatId)).sort();
  } })`;

(async () => {
  const env = await h.start();
  const host = await P.join(env, 'Alice', env.url);
  const act = (p, a) => L.act(p, a);
  /** A player's page by name, for messages. */
  const all = () => [host, bob, carol];
  const name = (p) => ({ [host.pid]: 'Alice', [bob?.pid]: 'Bob', [carol?.pid]: 'Carol' })[p.pid];
  let bob = null, carol = null;
  /** Waits until item `id` rests on the host (a guest's drag sends live moves, then its drop): the same spot and log twice, 500 ms apart. */
  const settled = (id) => L.until(async () => {
    const a = await L.view(host);
    await h.sleep(500);
    const b = await L.view(host);
    return a.items[id].x === b.items[id].x && a.items[id].y === b.items[id].y && a.log.length === b.log.length;
  }, 10000, 0);

  section('2: a box with named seats — the joiner takes the free one, a third player watches');
  ok((await act(host, { t: 'loadBox', box: DUO, setup: true, clear: true })).ok, 'the host loads a box with two named seats, White and Black');
  ok(await P.waitView(host, "v.players[me].seatId === 'white' && v.seats?.length === 2"), 'the host sits White');
  const ghost = await P.label(host, 'Black — empty');
  ok(!!ghost && ghost.ghost && ghost.style === 'dashed' && ghost.color === P.rgb('#7c3aed'),
    `a free named seat is a ghost label "Black — empty", dashed in its seat's colour (${JSON.stringify(ghost && { ghost: ghost.ghost, style: ghost.style, color: ghost.color })})`);
  const held = await P.label(host, 'White — Alice');
  const alice = await P.viewOf(host, 'v.players[me]');
  ok(!!held && !held.ghost && held.color === P.rgb('#e11d48') && held.color !== P.rgb(alice.color),
    `a held named seat reads "White — Alice", its border the seat's colour, not the player's (${held?.color} vs ${alice.color})`);
  await shot(host, 'tables-ghost-desk');

  bob = await P.join(env, 'Bob', host.url(), { rtc: true });
  ok(await P.waitView(bob, "v.players[me].seatId === 'black' && v.players[me].seat != null"), 'the guest who joins takes the second (first free) seat: Black');
  ok(!!(await P.label(bob, 'Black — Bob')) && !!(await P.label(host, 'Black — Bob')), 'both screens label it "Black — Bob"');
  carol = await P.join(env, 'Carol', host.url(), { rtc: true, ctx: P.PHONE });
  ok(await P.waitView(carol, 'v.players[me].seat === null && !v.players[me].seatId'), 'a third player finds no free seat: Carol watches (seat null, no seatId)');
  for (const p of all()) {
    ok(await p.waitForFunction(() => { const el = document.getElementById('watchers'); return !el.classList.contains('hidden') && el.textContent === '👀 Carol'; }, null, { timeout: 15000 }).then(() => true, () => false),
      `${name(p)}'s screen shows the watchers chip "👀 Carol"`);
  }
  ok(await P.shows(carol, '#watch-me') && (await carol.textContent('#watch-me-text')) === '👀 You are watching — tap a free seat to sit' && !(await P.shows(carol, '#sit-btn')),
    'Carol is told "👀 You are watching — tap a free seat to sit" (no Sit down button with named seats)');
  ok(!(await P.shows(bob, '#watch-me')) && !(await P.shows(host, '#watch-me')), 'the seated players are not told they watch');
  ok(await P.inViewport(carol, '#watch-box > :not(.hidden)'), 'on the phone the chip and the notice are on screen (top right)');
  const chip = await carol.evaluate(() => { const a = document.getElementById('watch-box').getBoundingClientRect(), b = document.getElementById('toolbar').getBoundingClientRect(); return a.top >= b.bottom - 0.5; });
  ok(chip, 'and below the toolbar');
  await shot(carol, 'tables-watch-phone');

  section('3: a seat-bound owner — Black\'s pawn is whoever sits Black');
  const its = await L.view(host).then((v) => v.items);
  const pawnOf = (seat) => Object.keys(its).find((id) => its[id].owner === `seat:${seat}`);
  const bp = pawnOf('black'), wp = pawnOf('white');
  ok(!!bp && !!wp, 'the setup gave each seat a pawn (owner seat:white, seat:black)');
  for (const p of all()) {
    const dot = await p.evaluate((id) => { const d = document.querySelector(`.item[data-id="${id}"] .odot`); return d && getComputedStyle(d).backgroundColor; }, bp);
    ok(dot === P.rgb('#7c3aed'), `${name(p)}'s screen: Black's pawn carries an owner dot in Black's colour (${dot})`);
  }
  /** Who may drag Black's pawn: `mover` drags it (it moves on the host), `panner` drags it (it pans, nothing is sent). */
  async function ownerFollows(mover, panner, tag) {
    const before = (await L.view(host)).items[bp];
    let a = await P.itemXY(mover, bp);
    await P.dragOn(mover, a, { x: a.x + 30, y: a.y + 24 }, mover === carol);
    ok(await P.waitView(host, 'v.items[a.id].x !== a.x || v.items[a.id].y !== a.y', { id: bp, x: before.x, y: before.y }),
      `${tag}: ${name(mover)} drags Black's pawn, and it moves on the host`);
    await settled(bp);
    const moved = (await L.view(host)).items[bp], log0 = (await L.view(host)).log.length, sent = await P.sentActs(panner), t0 = await P.tf(panner);
    await P.waitView(panner, 'v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id: bp, x: moved.x, y: moved.y });
    a = await P.itemXY(panner, bp);
    await P.dragOn(panner, a, { x: a.x - 40, y: a.y + 30 }, panner === carol);
    await h.sleep(800);
    const t1 = await P.tf(panner), after = await L.view(host), sent1 = await P.sentActs(panner);
    ok(Math.abs(t1.px - t0.px + 40) < 2.5 && Math.abs(t1.py - t0.py - 30) < 2.5,
      `${tag}: ${name(panner)}'s drag on it pans the view instead (pan moved by ${(t1.px - t0.px).toFixed(1)}, ${(t1.py - t0.py).toFixed(1)})`);
    ok(sent1 === sent && after.items[bp].x === moved.x && after.items[bp].y === moved.y && after.log.length === log0,
      `${tag}: and sends nothing (${sent1 - sent} bytes sent; the pawn ${after.items[bp].x === moved.x && after.items[bp].y === moved.y ? 'stays' : 'MOVED'}; ${after.log.length - log0} log lines)`);
    ok(!(await P.shows(panner, '#toast')), `${tag}: no notice on ${name(panner)}'s screen`);
  }
  await ownerFollows(bob, carol, 'Bob sits Black');

  section('2: the seat menu — Stand up (watch), Sit here');
  let m = await P.openMenu(bob, 'Black — Bob');
  ok(m.join('|') === 'Stand up (watch)', `Bob's own named seat offers exactly "Stand up (watch)" (${m.join(' | ')})`);
  await P.pick(bob, 'Stand up (watch)');
  ok(await P.waitView(host, 'v.players[a].seat === null && !v.players[a].seatId', bob.pid), 'Bob stands up: he watches');
  ok(!!(await P.label(carol, 'Black — empty')) && !!(await P.label(bob, 'Black — empty')), 'Black is a ghost again on the other screens');
  ok(await host.waitForFunction(() => /^👀 /.test(document.getElementById('watchers').textContent)
    && document.getElementById('watchers').textContent.slice(3).split(', ').sort().join() === 'Bob,Carol', null, { timeout: 15000 }).then(() => true, () => false),
  'the chip lists both watchers ("👀 Bob, Carol")');
  const row = await host.evaluate(() => { const r = [...document.querySelectorAll('#log .lg')].reverse().find((x) => x.textContent.includes('stood up to watch')); return r && getComputedStyle(r.querySelector('b')).color; });
  const bobColor = (await P.viewOf(host, 'v.players[a].color', bob.pid));
  ok(row === P.rgb(bobColor), `the log names him in his own colour, not a seat's (${row})`);
  m = await P.openMenu(carol, 'Black — empty', true);
  ok(m.join('|') === 'Sit here', `Carol taps the ghost Black on her phone: "Sit here" (${m.join(' | ')})`);
  await shot(carol, 'tables-menu-phone');
  ok(await P.inViewport(carol, '#seat-menu'), 'the menu is on the phone\'s screen');
  await P.pick(carol, 'Sit here', true);
  ok(await P.waitView(host, "v.players[a].seatId === 'black'", carol.pid), 'Carol sits Black');
  ok(!!(await P.label(host, 'Black — Carol')) && !!(await P.label(bob, 'Black — Carol')), 'everyone reads "Black — Carol"');
  ok(await bob.waitForFunction(() => document.getElementById('watchers').textContent === '👀 Bob', null, { timeout: 15000 }).then(() => true, () => false)
    && await carol.waitForFunction(() => document.getElementById('watch-me').classList.contains('hidden'), null, { timeout: 15000 }).then(() => true, () => false),
  'the chip reads "👀 Bob"; Carol is no longer told she watches');

  section('3: the seat changed hands — so did Black\'s pawn');
  await ownerFollows(carol, bob, 'Carol sits Black');

  section('2: the host\'s seat menu — Move to watchers, Seat ▸');
  m = await P.openMenu(bob, 'White — Alice');
  ok(!m.length, 'a guest\'s click on another player\'s label opens nothing');
  m = await P.openMenu(carol, 'White — Alice', true);
  ok(!m.length, 'neither does a tap on the phone');
  m = await P.openMenu(host, 'Black — Carol');
  ok(m.join('|') === 'Move to watchers', `the host's click on another player's label: "Move to watchers" (${m.join(' | ')})`);
  await P.pick(host, 'Move to watchers');
  ok(await P.waitView(carol, 'v.players[me].seat === null && !v.players[me].seatId'), 'Carol is moved to the watchers');
  ok(await carol.waitForFunction(() => !document.getElementById('watch-me').classList.contains('hidden'), null, { timeout: 15000 }).then(() => true, () => false), 'her phone tells her she watches');
  m = await P.openMenu(host, 'Black — empty');
  ok(m.includes('Sit here') && m.includes('Seat ▸ Bob') && m.includes('Seat ▸ Carol'),
    `the host's click on the free seat: "Sit here" and "Seat ▸" each other player (${m.join(' | ')})`);
  await shot(host, 'tables-menu-host');
  await P.pick(host, 'Seat ▸ Bob');
  ok(await P.waitView(bob, "v.players[me].seatId === 'black'"), 'Seat ▸ Bob: the host puts Bob in Black');
  ok(await P.waitView(host, 'v.log.some((e) => e.txt === "moved Bob to Black")'), 'logged "moved Bob to Black"');
  m = await P.openMenu(bob, 'White — Alice');
  ok(!m.length, 'Bob, seated again, still gets no menu on the host\'s label');

  section('2: t.players() leaves the watchers out (a tiny script)');
  ok((await act(host, { t: 'setRules', code: SCRIPT, enabled: true })).ok, 'the host enables a script with a "Who plays?" button');
  await host.waitForSelector('#rules-btns button[data-rbtn="who"]');
  await host.click('#rules-btns button[data-rbtn="who"]');
  ok(await P.waitView(bob, 'v.rules?.public?.who'), 'its button answers');
  const who = await P.viewOf(bob, 'v.rules.public');
  ok(JSON.stringify(who.who) === '["Alice","Bob"]', `t.players(): ${JSON.stringify(who.who)} — Carol, who watches, is not one`);
  ok(JSON.stringify(who.all) === '["Alice:white","Bob:black","Carol:watching"]', `t.players({all: true}) includes her, with seat null: ${JSON.stringify(who.all)}`);
  ok((await act(host, { t: 'setRules', enabled: false })).ok, 'the script is switched off');

  section('1: a rect table — the fit at each 90° seat view (Bob on a desktop, Carol on a phone)');
  ok((await act(host, { t: 'loadBox', box: QUAD, setup: true, clear: true })).ok, 'the host loads a 2400 × 1200 table with a seat on each edge');
  ok(await P.waitView(carol, "v.table.shape === 'rect' && v.table.w === 2400 && v.seats?.length === 4"), 'the phone has it');
  for (const p of [host, carol]) {
    const look = await p.evaluate(() => { const t = document.getElementById('table'), cs = getComputedStyle(t); return { rect: t.classList.contains('rect'), radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, img: cs.backgroundImage, shadow: cs.boxShadow, ring: getComputedStyle(t, '::before').content }; });
    ok(look.rect && look.radius === '24px' && look.bg === P.rgb('#1e3a5f') && look.img === 'none' && /inset/.test(look.shadow) && look.ring === 'none',
      `${name(p)}: #table.rect — 24 px corners, a solid felt in the box's colour with an inset shadow, no printed ring (${JSON.stringify({ radius: look.radius, bg: look.bg, img: look.img, ring: look.ring })})`);
  }
  for (const p of all()) await act(p, { t: 'seat', watch: true });
  ok(await P.waitView(host, 'Object.values(v.players).every((pl) => pl.seat === null)'), 'everyone stands up (setup)');
  for (const p of [bob, carol]) await p.click('#view-btn'); // (the drags above panned their views: 🧭 resets them)
  const TB = QUAD.table;
  /** Page p sits in seat `s` (a QUAD seat): its view turns to put that edge at the bottom, and fits. */
  async function seatView(p, s, k) {
    const want = EDGES[s.edge];
    const turned = await L.until(async () => (await P.viewOf(p, 'v.players[me].seatId')) === s.id && P.angDiff((await P.tf(p)).rot, want) < 0.01, 15000, 100);
    const t = await P.tf(p), w = await P.wrap(p), f = P.fit(TB, t.rot, w.W, w.H);
    ok(turned, `${name(p)} sits ${s.name} (${s.edge} edge): the view turns ${want}° to put that edge at the bottom (it reads ${t.rot}°)`);
    ok(Math.abs(t.s - f) / f < 0.002 && t.px === 0 && t.py === 0, `${name(p)}: the rotated bounding box fits the ${w.W} × ${w.H} area: scale ${t.s.toFixed(4)} = min(W / bw, H / bh) = ${f.toFixed(4)}, centred`);
    const box = await p.evaluate(() => { const r = document.getElementById('table').getBoundingClientRect(), a = document.getElementById('table-wrap').getBoundingClientRect(); return { l: r.left - a.left, t: r.top - a.top, r: r.right - a.left, b: r.bottom - a.top }; });
    ok(box.l >= -1 && box.t >= -1 && box.r <= w.W + 1 && box.b <= w.H + 1 && (Math.abs(box.r - box.l - w.W) < 1.5 || Math.abs(box.b - box.t - w.H) < 1.5),
      `${name(p)}: the whole table is on screen and fills the area's ${Math.abs(box.r - box.l - w.W) < 1.5 ? 'width' : 'height'}`);
    const me = (await P.labels(p)).find((l) => l.me), y = me && me.y - w.top, x = me && me.x - w.left;
    ok(!!me && y > box.t + 0.85 * (box.b - box.t) && Math.abs(x - (box.l + box.r) / 2) < 0.05 * (box.r - box.l),
      `${name(p)}: their own label sits at the table's bottom middle (${me && `${x.toFixed(0)}, ${y.toFixed(0)}; the table spans ${box.l.toFixed(0)}–${box.r.toFixed(0)} × ${box.t.toFixed(0)}–${box.b.toFixed(0)}`})`);
    if (k === 1) await shot(p, `tables-rect-${s.edge}-${p === carol ? 'phone' : 'desk'}`);
  }
  for (let k = 0; k < 4; k++) {
    const sb = QUAD.seats[k], sc = QUAD.seats[(k + 2) % 4];
    await act(bob, { t: 'seat', watch: true });
    await act(carol, { t: 'seat', watch: true });
    await P.waitView(host, 'v.players[a[0]].seat === null && v.players[a[1]].seat === null', [bob.pid, carol.pid]);
    await act(bob, { t: 'seat', id: sb.id });
    await act(carol, { t: 'seat', id: sc.id });
    await seatView(bob, sb, k);
    await seatView(carol, sc, k);
    if (k > 1) continue;

    section(`1: the pan limit is per axis (Bob, ${sb.name}: the view turned ${EDGES[sb.edge]}°)`);
    const t = await P.tf(bob), w = await P.wrap(bob);
    const a = (t.rot * Math.PI) / 180, bw = TB.w * Math.abs(Math.cos(a)) + TB.h * Math.abs(Math.sin(a)), bh = TB.w * Math.abs(Math.sin(a)) + TB.h * Math.abs(Math.cos(a));
    for (const [axis, lim] of [['x', (bw * t.s) / 2], ['y', (bh * t.s) / 2]]) {
      let pans = [];
      for (let n = 0; n < 8; n++) { // drag the felt as far as it goes, then once more
        const f = await P.feltPoint(bob, axis === 'x' ? { band: [0.3, 0.7] } : {});
        if (!f) break;
        const to = axis === 'x' ? { x: Math.min(f.x + 320, w.left + w.W - 8), y: f.y } : { x: f.x, y: Math.min(f.y + 320, w.top + w.H - 8) };
        await P.mouseDrag(bob, f, to);
        pans.push(axis === 'x' ? (await P.tf(bob)).px : (await P.tf(bob)).py);
      }
      const last = pans[pans.length - 1];
      ok(pans.length === 8 && Math.abs(last - lim) < 0.6 && Math.abs(pans[pans.length - 2] - lim) < 0.6,
        `dragging the felt along ${axis} stops at half the table's on-screen ${axis === 'x' ? 'width' : 'height'}: ${last.toFixed(1)} px = ${lim.toFixed(1)} (pans: ${pans.map((x) => x.toFixed(0)).join(', ')})`);
      await bob.click('#view-btn');
      await L.until(async () => { const x = await P.tf(bob); return x.px === 0 && x.py === 0; }, 5000, 100);
    }
    ok(Math.abs(bw - bh) > 100, `(the two limits differ: ${(bw * t.s / 2).toFixed(0)} px across, ${(bh * t.s / 2).toFixed(0)} px down)`);
  }

  section('1: the zoom ceiling on a rect table is 4 · max(w, h) / 1300');
  {
    const w = await P.wrap(bob), max = (4 * Math.max(TB.w, TB.h)) / 1300;
    await bob.mouse.move(w.left + w.W / 2, w.top + w.H / 2);
    for (let n = 0; n < 8; n++) { await bob.mouse.wheel(0, -700); await h.sleep(60); }
    await h.sleep(300);
    const t = await P.tf(bob), z = t.s / P.fit(TB, t.rot, w.W, w.H);
    ok(Math.abs(z - max) < 0.005 * max, `the wheel zooms Bob's view in to ${z.toFixed(3)}× the fit, and no further: ${max.toFixed(3)} (4 · 2400 / 1300)`);
    await bob.click('#view-btn');
    ok(await L.until(async () => { const x = await P.tf(bob); return Math.abs(x.s - P.fit(TB, x.rot, w.W, w.H)) < 1e-4; }, 5000, 100), '🧭 brings the fit back');
  }

  section('6: the size selector on a rect table — "▭ w × h", and a round size asks first');
  const sel = () => host.evaluate(() => { const s = document.getElementById('size-sel'), o = s.selectedOptions[0]; return { value: s.value, text: o?.textContent, disabled: o?.disabled, first: s.options[0].value, n: s.options.length, shown: !s.classList.contains('hidden') }; });
  let s = await sel();
  ok(s.shown && s.value === 'rect' && s.text === '▭ 2400 × 1200' && s.disabled && s.first === 'rect' && s.n === 4,
    `the host's #size-sel shows an extra, selected, disabled option "▭ 2400 × 1200" (${JSON.stringify(s)})`);
  ok(!(await P.shows(bob, '#size-sel')) && !(await P.shows(carol, '#size-sel')), 'the guests have no size selector');
  const dialogs = [];
  host.once('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await host.selectOption('#size-sel', '1800');
  await h.sleep(800);
  s = await sel();
  ok(dialogs[0] === 'Switch to a round table? Items outside it are pulled in.', `choosing "medium" asks first: "${dialogs[0]}"`);
  ok(s.value === 'rect' && (await P.viewOf(host, 'v.table.shape')) === 'rect', 'declined: the table stays a rectangle, and the selector names it again');
  host.once('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await host.selectOption('#size-sel', '1800');
  ok(dialogs[1] === 'Switch to a round table? Items outside it are pulled in.', 'asked again');
  for (const p of all()) {
    ok(await P.waitView(p, "JSON.stringify(v.table) === JSON.stringify({ shape: 'round', w: 1800, h: 1800 })"), `accepted: ${name(p)}'s table is round, 1800 across`);
  }
  ok(await host.waitForFunction(() => !document.getElementById('table').classList.contains('rect') && document.getElementById('size-sel').value === '1800'
    && !document.querySelector('#size-sel option[value="rect"]'), null, { timeout: 10000 }).then(() => true, () => false), 'the selector reads "medium", with no rectangle option');
  const its2 = await P.viewOf(host, 'v.items'), out = Object.values(its2).filter((it) => Math.hypot(it.x + 30 - 900, it.y + 30 - 900) > 790 + 0.5);
  ok(Object.keys(its2).length === 4 && !out.length, `the four corner pegs were pulled in, their centres within 790 of the centre (${out.length} outside)`);

  section('7: a round table never refits as the view turns');
  {
    const w = await P.wrap(bob), t0 = await P.tf(bob), want = Math.min(w.W, w.H) / 1800;
    ok(Math.abs(t0.s - want) / want < 0.002, `Bob's view of the round table (turned ${t0.rot}°) fits its diameter: ${t0.s.toFixed(4)} = ${want.toFixed(4)}`);
    await act(bob, { t: 'seat', watch: true });
    await act(bob, { t: 'seat', id: 's' });
    ok(await L.until(async () => P.angDiff((await P.tf(bob)).rot, 0) < 0.01, 10000, 100), 'Bob moves to South: his view turns');
    ok((await P.tf(bob)).s === t0.s, 'and the scale stays the same');
  }

  section('2: automatic seating — the host moves a player to the watchers, who taps Sit down');
  ok((await act(host, { t: 'loadBox', box: PLAIN, setup: true, clear: true })).ok, 'the host loads a box with no seats: automatic seating');
  ok(await P.waitView(host, 'v.seats === null && Object.values(v.players).every((pl) => pl.seat != null && !pl.seatId)'), 'every watcher is seated again, and no one has a named seat');
  const autoLabel = async (p, who) => P.label(p, new RegExp(`^${who}( |$)`));
  m = await P.openMenu(host, (await autoLabel(host, 'Carol')).text);
  ok(m.join('|') === 'Move to watchers', `the host's menu on Carol's label: "Move to watchers" only (${m.join(' | ')})`);
  for (const [p, who, touch] of [[host, 'Alice'], [bob, 'Bob'], [bob, 'Alice'], [carol, 'Alice', true]]) {
    const mm = await P.openMenu(p, (await autoLabel(p, who)).text, touch);
    ok(!mm.length, `${name(p)}'s ${touch ? 'tap' : 'click'} on ${who === name(p) ? 'their own' : `${who}'s`} label opens nothing`);
    if (mm.length) await p.keyboard.press('Escape');
  }
  await P.pick(host, 'Move to watchers').catch(async () => { await P.openMenu(host, (await autoLabel(host, 'Carol')).text); await P.pick(host, 'Move to watchers'); });
  ok(await P.waitView(carol, 'v.players[me].seat === null'), 'Carol watches');
  ok(await carol.waitForFunction(() => !document.getElementById('watch-me').classList.contains('hidden') && !document.getElementById('sit-btn').classList.contains('hidden'), null, { timeout: 15000 }).then(() => true, () => false)
    && (await carol.textContent('#sit-btn')) === 'Sit down',
  `her phone says she watches ("${await carol.textContent('#watch-me-text')}"), with a Sit down button`);
  ok(await P.inViewport(carol, '#sit-btn'), 'the button is on screen');
  ok(await host.waitForFunction(() => document.getElementById('watchers').textContent === '👀 Carol', null, { timeout: 15000 }).then(() => true, () => false), 'the host sees "👀 Carol"');
  await shot(carol, 'tables-sitdown-phone');
  await carol.tap('#sit-btn');
  ok(await P.waitView(host, 'v.players[a].seat != null && !v.players[a].seatId', carol.pid), 'Carol taps Sit down: she has a seat again');
  ok(await carol.waitForFunction(() => document.getElementById('watch-me').classList.contains('hidden'), null, { timeout: 15000 }).then(() => true, () => false)
    && !!(await autoLabel(host, 'Carol')), 'her label is back, and the notice is gone');

  section('4: the hand bar hides with nothing to hold, on every screen, and the table refits');
  /** Page p's hand bar: hidden (body.nohand, display none), and the table fitted to the area it leaves. */
  const bar = (p) => p.evaluate(() => ({ nohand: document.body.classList.contains('nohand'), shown: getComputedStyle(document.getElementById('hand-bar')).display !== 'none', handBarTop: document.getElementById('hand-bar').getBoundingClientRect().top, wrapBottom: document.getElementById('table-wrap').getBoundingClientRect().bottom, vh: innerHeight }));
  async function handBar(p, want, why) {
    const done = await p.waitForFunction((want) => document.body.classList.contains('nohand') === !want && (getComputedStyle(document.getElementById('hand-bar')).display !== 'none') === want, want, { timeout: 15000 }).then(() => true, () => false);
    const b = await bar(p);
    ok(done, `${name(p)}: the hand bar ${want ? 'shows' : 'hides'} ${why}`);
    ok(want ? Math.abs(b.wrapBottom - b.handBarTop) < 1 : Math.abs(b.wrapBottom - b.vh) < 1, `${name(p)}: the table area reaches ${want ? 'the hand bar' : 'the bottom of the screen'} (${b.wrapBottom.toFixed(0)} of ${b.vh})`);
    const fitted = await L.until(async () => { const t = await P.tf(p), w = await P.wrap(p), tb = await P.viewOf(p, 'v.table'); return Math.abs(t.s - P.fit(tb, t.rot, w.W, w.H)) / t.s < 0.002; }, 5000, 100);
    ok(fitted, `${name(p)}: the table refits the area`);
  }
  for (const p of all()) await p.click('#view-btn');
  ok((await act(host, { t: 'loadBox', box: BOXES.draughts, setup: true, clear: true })).ok, 'the host sets up draughts: nothing on it goes in a hand, and the hands are empty');
  for (const p of all()) await handBar(p, false, 'with draughts');
  await shot(host, 'tables-nohand-desk');
  await shot(carol, 'tables-nohand-phone');
  await host.click('#add-deck-btn');
  await host.waitForSelector('#deck-dialog[open]');
  await host.click('#deck-add');
  ok(await P.waitView(host, "Object.values(v.items).some((it) => it.k === 'p')"), 'the host adds a standard deck (+ Deck)');
  for (const p of all()) await handBar(p, true, 'once a deck is on the table');
  const pile = await P.viewOf(host, "Object.keys(v.items).find((id) => v.items[id].k === 'p')");
  await P.waitView(bob, '!!v.items[a]', pile);
  const pc = await P.itemXY(bob, pile);
  await bob.mouse.dblclick(pc.x, pc.y);
  ok(await P.waitView(bob, 'v.hand.length === 1'), 'Bob draws a card into his hand (double-click)');
  await P.clickItem(host, pile);
  await host.waitForSelector('#action-bar [data-cmd="del"]');
  await host.click('#action-bar [data-cmd="del"]');
  ok(await P.waitView(host, `!Object.values(v.items).some((it) => it.k === 'p' || it.k === 'c')`), 'the host removes the deck (🗑)');
  await handBar(host, false, 'when the deck is gone');
  await handBar(carol, false, 'when the deck is gone');
  await h.sleep(500);
  await handBar(bob, true, 'for Bob, whose hand holds a card');
  await h.playFromHand(bob, 0, 0.5, 0.42);
  ok(await P.waitView(host, "Object.values(v.items).some((it) => it.k === 'c')"), 'Bob plays it to the table');
  for (const p of all()) await handBar(p, true, 'with a card on the table');
  const card = await P.viewOf(host, "Object.keys(v.items).find((id) => v.items[id].k === 'c')");
  await P.waitView(bob, '!!v.items[a]', card);
  await P.clickItem(bob, card);
  await bob.waitForSelector('#action-bar [data-cmd="del"]');
  await bob.click('#action-bar [data-cmd="del"]');
  for (const p of all()) await handBar(p, false, 'once the card is removed too');

  section('5: an old v2 save (size 1800) resumes as a round table');
  {
    const olga = await P.join(env, 'Olga', env.url);
    await olga.waitForSelector('.item.pile .count');
    const invite = olga.url(), room = invite.match(/#room~([0-9a-f]+)/)[1];
    await olga.goto(h.plain(env)); // (its pagehide saves the table)
    const s3 = (await h.idb(olga, 'saves', room)).state;
    // A Phase 1 save, as it was written then: `size`, no table, seats or boardSeq; Olga sat at 120°.
    const players = Object.fromEntries(Object.entries(s3.players).map(([p, { seatId, ...pl }]) => [p, { ...pl, seat: 120 }]));
    const v2 = { v: 2, seq: s3.seq, size: 1800, items: s3.items, players, keys: s3.keys, log: s3.log, guestDeckChars: s3.guestDeckChars, zMax: s3.zMax };
    await h.plantSave(olga, room, v2);
    await olga.goto(invite);
    await olga.waitForSelector('.item.pile .count', { timeout: 30000 });
    ok(await P.waitView(olga, "JSON.stringify(v.table) === JSON.stringify({ shape: 'round', w: 1800, h: 1800 }) && v.seats === null"), 'the host resumes it as a round table, 1800 across, with automatic seating');
    const look = await olga.evaluate(() => ({ rect: document.getElementById('table').classList.contains('rect'), w: document.getElementById('table').offsetWidth, sel: document.getElementById('size-sel').value, opt: !!document.querySelector('#size-sel option[value="rect"]') }));
    ok(!look.rect && look.w === 1800 && look.sel === '1800' && !look.opt, `it is drawn round, 1800 wide, and the size selector reads "medium" (${JSON.stringify(look)})`);
    const v = await L.view(olga);
    const kept = Object.keys(s3.items).sort().join() === Object.keys(v.items).sort().join() && Object.entries(s3.items).every(([id, it]) => v.items[id].x === it.x && v.items[id].y === it.y);
    ok(v.players[olga.pid]?.seat === 120 && kept, `Olga keeps her seat angle (${v.players[olga.pid]?.seat}°), and every item keeps its place`);
    const pete = await P.join(env, 'Pete', invite);
    ok(await P.waitView(pete, "JSON.stringify(v.table) === JSON.stringify({ shape: 'round', w: 1800, h: 1800 })") && !(await pete.evaluate(() => document.getElementById('table').classList.contains('rect'))),
      'a guest who joins sees the same round table');
    let rec = null;
    ok(await L.until(async () => (rec = await h.idb(olga, 'saves', room))?.state?.players?.[pete.pid], 15000, 200)
      && rec.v === 3 && rec.state.v === 3 && !('size' in rec.state) && JSON.stringify(rec.state.table) === JSON.stringify({ shape: 'round', w: 1800, h: 1800 }) && rec.state.seats === null && rec.state.boardSeq === 0,
    `the next save is v3: table round 1800, no size, seats null, boardSeq 0 (${JSON.stringify(rec && { v: rec.v, table: rec.state.table, size: rec.state.size, seats: rec.state.seats, boardSeq: rec.state.boardSeq })})`);
  }

  await env.done();
})().catch(h.crash);
