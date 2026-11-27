// The Phase 3A fix-up's regressions on real screens (the reviews of 3A;
// spec §3g, D112–D120), on backgammon: Alice hosts on a desktop, Bob plays on
// an iPhone 13 in portrait, Carol watches on one in landscape, with motion on.
//  1. A Phase 2 (v3) save, its checkers spread up their points as Phase 2's
//     setup left them, resumes with every checker drawn where it lies, on its
//     point: a piece off its spot's centre is counted in the ×k, not fanned
//     (fanned from its own place, it was drawn off the board, D116), and a
//     press on it takes it; once a piece centred there joins them, the spot
//     fans them all, none drawn over another (D120).
//  2. A checker of each colour on the bar: both show (the bar fans down,
//     D115), and a press on the crowd takes the presser's own, whichever is
//     on top — Bob on his phone, Alice with the mouse.
//  3. A guest's drop: the checker is drawn where the preview's ghost showed
//     it (its place in the spot's fan) from the release on, never at the
//     spot's centre first.
//  4. A live glide ends without a step back on a watcher's screen (endLive:
//     translate alone runs out).
//  5. Dice never snap (D112): no preview over a point, no address, no fan.
//  6. A board move: the addresses follow (D106); on screen a piece no longer
//     centred on a spot is drawn where it lies (D116), and none is redrawn
//     (renderItems: an address alone).
// Screenshots: shots/p3r-*.png, for review only.
'use strict';
const path = require('path');
const h = require('./h');
const P = require('./p2t-lib');
const S = require('./p3-lib');
const L = require('./p1-lib');
const { shot } = require('./fun-lib');
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));
const { ok, section } = h;

const SP = Object.fromEntries(BOXES.backgammon.types.board.board.spaces.map((s) => [s.id, s]));
const MAN = 80, BH = 1000;

(async () => {
  const env = await h.start();
  const host = await S.join(env, 'Alice', env.url);
  await host.waitForSelector('.item.pile .count');
  const items = (p = host) => P.viewOf(p, 'v.items');
  const bgOn = "Object.values(v.items).filter((it) => it.k === 'g').length === 34";
  const boardOf = async (p) => { const its = await items(p); const id = Object.keys(its).find((k) => its[k].z < 0); return { id, ...its[id] }; };
  /** The ids at display address `at` on page p, bottom to top. */
  const crowd = (p, at) => P.viewOf(p, 'Object.keys(v.items).filter((k) => v.items[k].at === a).sort((x, y) => v.items[x].z - v.items[y].z)', at);
  const atOn = (p, id, at, ms = 15000) => P.waitView(p, 'v.items[a.id]?.at === a.at', { id, at }, ms);
  /** Where item `id` is drawn on page p: its element's left/top (__ct.drawn). */
  const drawn = (p, id) => p.evaluate((id) => window.__ct.drawn(id), id);
  /** Space `s`'s rectangle on the table (board at b): {l, t, r, b}. */
  const rectOf = (b, s) => ({ l: b.x + s.x - s.w / 2, t: b.y + s.y - s.h / 2, r: b.x + s.x + s.w / 2, b: b.y + s.y + s.h / 2 });
  /** Whether a checker drawn at d lies inside rectangle q (to a hair). */
  const inside = (d, q) => d && d.x >= q.l - 0.01 && d.x + MAN <= q.r + 0.01 && d.y >= q.t - 0.01 && d.y + MAN <= q.b + 0.01;
  /** Where the j-th of k checkers on space s (board at b) is drawn (§3g: from its base along dir, squeezed to fit). */
  const slot = (b, s, j, k) => {
    const L = s.h, step = k > 1 ? Math.min(MAN, (L - MAN) / (k - 1)) : 0, down = s.dir === 'down';
    return { x: b.x + s.x - MAN / 2, y: down ? b.y + s.y - L / 2 + j * step : b.y + s.y + L / 2 - MAN - j * step };
  };
  /** Every checker on a space of the board, as page p draws it: [{at, j, k, d}]. */
  async function fans(p, b) {
    const its = await items(p), by = {};
    for (const [id, it] of Object.entries(its)) if (it.at && SP[it.at]) (by[it.at] ||= []).push(id);
    const out = [];
    for (const [at, ids] of Object.entries(by)) {
      ids.sort((x, y) => its[x].z - its[y].z);
      for (const [j, id] of ids.entries()) out.push({ id, at, j, k: ids.length, d: await drawn(p, id) });
    }
    return out;
  }

  // ===========================================================================
  section('1. A Phase 2 save resumes with every checker drawn where it lies, on its point (D116)');
  ok((await L.act(host, { t: 'loadBox', box: BOXES.backgammon, setup: true, clear: true })).ok, '(Alice sets up Backgammon)');
  ok(await P.waitView(host, bgOn, null, 30000), '(the board, 30 checkers, two dice and the cube)');
  await h.sleep(600);
  const invite = host.url(), room = invite.match(/#room~([0-9a-f]+)/)[1];
  await host.goto(`${env.base}/cardtable/style.css`); // (pagehide saves the table)
  await h.sleep(500);
  const st = (await h.idb(host, 'saves', room)).state;
  {
    // Back to v3 as Phase 2 left it: no addresses; each point's checkers
    // spread from its base toward the middle, 80 apart (Phase 2's setup).
    const b = Object.values(st.items).find((it) => it.z < 0), groups = {};
    for (const [id, it] of Object.entries(st.items)) if (it.at) (groups[it.at] ||= []).push(id);
    for (const ids of Object.values(groups)) {
      ids.sort((x, y) => st.items[x].z - st.items[y].z);
      const top = st.items[ids[0]].y + MAN / 2 < b.y + BH / 2;
      ids.forEach((id, j) => { const it = st.items[id]; it.y = top ? b.y + 10 + MAN * j : b.y + BH - 10 - MAN - MAN * j; delete it.at; });
    }
    st.v = 3;
    if (st.rules) { delete st.rules.secret; delete st.rules.asks; }
  }
  await h.plantSave(host, room, st);
  await host.goto(invite);
  await host.waitForFunction(() => window.__ct?.view()?.seq > 0, null, { timeout: 30000 });
  ok(await P.waitView(host, bgOn, null, 30000), '(Alice reopens the table: the v3 save, resumed)');
  await h.sleep(500);
  {
    const b = await boardOf(host), f = await fans(host, b), its = await items();
    const spread = Object.values(its).filter((it) => it.at && SP[it.at] && it.y !== b.y + SP[it.at].y - MAN / 2);
    ok(f.length === 30 && spread.length > 0, `every checker reads its point by containment (30), and the state still holds Phase 2's spread (${spread.length} not centred on their point): nothing moved`);
    const off = f.filter(({ at, d }) => !inside(d, rectOf(b, SP[at])));
    ok(!off.length, `on Alice's screen each one is drawn inside its own point's triangle (${off.length} outside${off.length ? `: ${JSON.stringify(off.slice(0, 3))}` : ''})`);
    const bad = f.filter(({ id, d }) => Math.abs(d.x - its[id].x) > 0.01 || Math.abs(d.y - its[id].y) > 0.01);
    ok(!bad.length, `where the save has it: off its point's centre, it is counted, not fanned (${bad.length} elsewhere${bad.length ? `: ${JSON.stringify(bad[0])}` : ''})`);
    const tops = Object.keys(SP).filter((at) => f.some((m) => m.at === at)).map((at) => f.filter((m) => m.at === at).at(-1));
    const badges = await Promise.all(tops.map(({ id }) => host.evaluate((id) => document.querySelector(`.item[data-id="${id}"] > .fanb`)?.textContent ?? null, id)));
    ok(tops.every((m, k) => badges[k] === (m.k > 1 ? `×${m.k}` : null)), `each point's top checker carries its "×k" all the same (${badges.join(' ')})`);
    await shot(host, 'p3r-v3-resumed-desk');
    /** The checkers of point `at` drawn over one another on Alice's screen (pairs of ids). */
    const overlaps = async (at) => {
      const ds = await Promise.all((await crowd(host, at)).map(async (id) => [id, await drawn(host, id)])), out = [];
      ds.forEach(([a, p], k) => ds.slice(k + 1).forEach(([b, q]) => { if (Math.abs(p.x - q.x) < MAN - 0.01 && Math.abs(p.y - q.y) < MAN - 0.01) out.push([a, b]); }));
      return out;
    };
    // One checker moved off p6 and back is centred on it: the spot fans them all (D120) —
    // the four others in the fan's first slots, which are where Phase 2 spread them.
    const p6 = f.filter((m) => m.at === 'p6'), id = p6.at(-1).id, c = { x: b.x + SP.p6.x, y: b.y + SP.p6.y };
    await S.dragTo(host, id, { x: c.x, y: c.y + 100 });
    await P.waitView(host, 'v.items[a.id].x === a.x && v.items[a.id].y === a.y', { id, x: c.x - MAN / 2, y: c.y - MAN / 2 });
    await h.sleep(300);
    const ds = await Promise.all(p6.map(async (m) => [m.id, await drawn(host, m.id)])), far = ds.filter(([, d], j) => { const w = slot(b, SP.p6, j, 5); return Math.abs(d.x - w.x) > 0.01 || Math.abs(d.y - w.y) > 0.01; });
    ok(!far.length && ds.slice(0, 4).every(([k, d]) => Math.abs(d.y - its[k].y) < 0.01), `a checker dropped back on p6 is centred on it: p6 fans all five, the four others where they lay, it on top (${far.length} elsewhere${far.length ? `: ${JSON.stringify(far[0])}` : ''})`);
    ok(!(await overlaps('p6')).length, 'none of them drawn over another');
    // A press on a checker drawn where it lies (off its point's centre, no fan) takes that very checker (D120).
    const p8 = await crowd(host, 'p8'), low = p8[0];
    await S.dragTo(host, low, { x: b.x + SP.p7.x, y: b.y + SP.p7.y });
    ok(await atOn(host, low, 'p7'), 'Alice presses p8\'s lowest checker, at its base, and drags it to p7: that checker goes');
    ok(JSON.stringify(await crowd(host, 'p8')) === JSON.stringify(p8.slice(1)), 'the others stay on p8, the top one too');
    // One brought onto a point whose base is now bare: the fan closes up under it, nothing drawn over another.
    const from = (await crowd(host, 'p13')).at(-1);
    await S.dragTo(host, from, { x: b.x + SP.p8.x, y: b.y + SP.p8.y });
    ok(await atOn(host, from, 'p8'), 'Alice brings a checker from p13 to p8');
    await h.sleep(300);
    const p8d = await Promise.all((await crowd(host, 'p8')).map((k) => drawn(host, k)));
    ok(p8d.every((d, j) => Math.abs(d.y - slot(b, SP.p8, j, 3).y) < 0.01) && !(await overlaps('p8')).length, `p8 fans its three from the base, none drawn over another (${JSON.stringify(p8d.map((d) => d.y))})`);
    await shot(host, 'p3r-fans-desk');
  }

  // ===========================================================================
  section('Bob (iPhone 13, portrait) and Carol (iPhone 13 landscape, motion on) join');
  const bob = await S.join(env, 'Bob', host.url(), { ctx: P.PHONE });
  bob.touch = true;
  const carol = await S.join(env, 'Carol', host.url(), { ctx: { ...h.playwright.devices['iPhone 13 landscape'], reducedMotion: 'no-preference' } });
  for (const p of [bob, carol]) await P.waitView(p, bgOn, null, 30000);
  await h.sleep(600);
  await shot(bob, 'p3r-fans-phone');
  await shot(carol, 'p3r-fans-landscape');
  ok(await P.waitView(host, `v.players[me].seatId === 'light' && v.players[a].seatId === 'dark'`, bob.pid), 'Alice sits Light, Bob Dark; Carol watches');
  const bg = await boardOf(host), pt = (s) => ({ x: bg.x + SP[s].x, y: bg.y + SP[s].y });
  const ownerAt = async (at) => (await items())[(await crowd(host, at))[0]]?.owner;

  // ===========================================================================
  section('2. A checker of each colour on the bar: both show, and a press takes the presser\'s own (D115)');
  {
    const darkFrom = (await ownerAt('p12')) === 'seat:dark' ? 'p12' : 'p19', lightFrom = 'p13';
    const d1 = (await crowd(bob, darkFrom)).at(-1);
    await S.dragTo(bob, d1, pt('bar'), { touch: true });
    ok(await atOn(host, d1, 'bar'), 'Bob drags a Dark checker onto the bar (his phone)');
    const l1 = (await crowd(host, lightFrom)).at(-1);
    await S.dragTo(host, l1, pt('bar'));
    ok(await atOn(bob, l1, 'bar'), 'Alice sends a Light checker there too: Light on top of Dark');
    for (const [p, who] of [[host, 'Alice'], [bob, 'Bob']]) {
      await P.waitView(p, 'a.every((id) => v.items[id]?.at === "bar")', [d1, l1]);
      await h.sleep(300);
      const [a, b] = [await drawn(p, d1), await drawn(p, l1)], w = [slot(bg, SP.bar, 0, 2), slot(bg, SP.bar, 1, 2)];
      ok(Math.abs(a.y - w[0].y) < 0.01 && Math.abs(b.y - w[1].y) < 0.01 && a.x === w[0].x && b.x === w[1].x && inside(a, rectOf(bg, SP.bar)) && inside(b, rectOf(bg, SP.bar)),
        `${who}'s screen: both are on the bar, a whole checker apart from its top end down (Dark at y ${a.y}, Light at ${b.y}): each colour shows`);
    }
    await shot(bob, 'p3r-bar-both-phone');
    await shot(host, 'p3r-bar-both-desk');
    // Bob presses the crowd on Alice's Light checker, on top: he takes his own Dark one.
    await S.dragTo(bob, l1, pt('p16'), { touch: true });
    ok(await atOn(host, d1, 'p16'), 'Bob\'s finger on the Light checker on top of the bar takes his own Dark one to p16');
    ok((await items())[l1].at === 'bar', 'Alice\'s Light checker stays on the bar');
    // Now Dark on top: Bob sends another; Alice takes hers from under it.
    const d2 = (await crowd(bob, 'p19')).at(-1);
    await S.dragTo(bob, d2, pt('bar'), { touch: true });
    ok(await atOn(host, d2, 'bar') && JSON.stringify(await crowd(host, 'bar')) === JSON.stringify([l1, d2]), 'Bob sends another Dark checker to the bar: now on top of Alice\'s');
    await h.sleep(300);
    await S.dragTo(host, d2, pt('p20'));
    ok(await atOn(bob, l1, 'p20'), 'Alice\'s mouse on the Dark checker on top takes her own Light one to p20');
    ok((await items())[d2].at === 'bar', 'Bob\'s Dark checker stays on the bar');
  }

  // ===========================================================================
  section('3. A guest\'s drop is drawn where the preview showed it, from the release on');
  {
    const id = (await crowd(bob, 'p17')).at(-1), a = await S.centreOf(bob, id), b = await S.screenOf(bob, pt('p3').x, pt('p3').y);
    let spot = null;
    await S.gesture(bob, S.steps(a, b, 12, 30), {
      touch: true,
      mid: async () => {
        await h.sleep(120);
        spot = await bob.evaluate(() => window.__ct.spot());
        // from the release (after the app's own pointerup) on, every frame: where the checker is drawn
        await bob.evaluate((id) => {
          window.__trace = [];
          addEventListener('pointerup', () => {
            const t0 = performance.now(), tick = () => { window.__trace.push(window.__ct.drawn(id)); if (performance.now() - t0 < 700) requestAnimationFrame(tick); };
            tick();
          }, { once: true });
        }, id);
      },
    });
    ok(spot?.to === 'p3' && spot.slot, `mid-drag the preview names p3, and its ghost the checker's slot in the fan (${JSON.stringify(spot)})`);
    ok(await atOn(host, id, 'p3'), 'the host puts it on p3');
    await h.sleep(800);
    const tr = await bob.evaluate(() => window.__trace.filter(Boolean)), w = slot(bg, SP.p3, 0, 1);
    const off = tr.filter((d) => Math.abs(d.x - w.x) > 0.01 || Math.abs(d.y - w.y) > 0.01);
    ok(tr.length > 10 && !off.length && Math.abs(spot?.slot?.y - w.y) < 0.01, `on Bob's phone it is drawn at that slot (p3's base) in every one of ${tr.length} frames after the release${off.length ? ` — not in ${off.length}, e.g. ${JSON.stringify(off[0])}` : ''}`);
    ok((await items(bob))[id].y === pt('p3').y - MAN / 2, 'while the state keeps it centred on p3 (§3g)');
  }

  // ===========================================================================
  section('4. A live glide ends on a watcher\'s screen without a step back');
  {
    const id = (await crowd(host, 'p8')).at(-1), to = pt('p9');
    await carol.evaluate((id) => {
      window.__glide = [];
      const t0 = performance.now(), tick = () => {
        const el = document.querySelector(`.item[data-id="${id}"]`), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        window.__glide.push({ t: performance.now() - t0, x: r.left + r.width / 2, y: r.top + r.height / 2, live: !!window.__ct.lives()[id], lt: `${cs.left} ${cs.top}` });
        if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, id);
    const a = await S.centreOf(host, id), b = await S.screenOf(host, to.x, to.y);
    await S.gesture(host, S.steps(a, b, 10, 90));
    ok(await atOn(carol, id, 'p9'), 'Alice drags a Light checker to p9, slowly: Carol sees it glide live, then land');
    await h.sleep(1200);
    const g = await carol.evaluate(() => window.__glide), k0 = g.findIndex((s) => s.live), k1 = g.findIndex((s, k) => k > k0 && !s.live);
    const after = g.slice(k1), end = g.at(-1), dist = (s) => Math.hypot(s.x - end.x, s.y - end.y);
    const back = after.slice(1).map((s, k) => dist(s) - dist(after[k])).filter((d) => d > 1);
    ok(k0 >= 0 && k1 > k0, `Carol's screen showed the live glide (${k1 - k0} frames), then the commit`);
    ok(dist(after[0]) > 5 && after.filter((s) => dist(s) > 0.5).length >= 3, `from where the glide was it runs out over frames (${dist(after[0]).toFixed(1)} px to go, ${after.filter((s) => dist(s) > 0.5).length} frames)`);
    ok(!back.length, `and never steps back on its way (${back.length} frames moved away from the landing${back.length ? `: ${back.map((d) => d.toFixed(1)).join(', ')} px` : ''})`);
    const lts = new Set(after.map((s) => s.lt));
    ok(lts.size === 1, `its left/top stand still from the commit on — the translation alone runs out (endLive: nothing is laid out per frame) (${[...lts].slice(0, 3).join(' | ')})`);
    await shot(carol, 'p3r-landed-landscape');
  }

  // ===========================================================================
  section('5. Dice never snap (D112): no preview over a point, no address, no fan');
  {
    const its = await items(), die = Object.keys(its).find((k) => its[k].t?.endsWith('/die')), a = await S.centreOf(host, die), b = await S.screenOf(host, pt('p11').x, pt('p11').y + 100);
    let ghost = null;
    await S.gesture(host, S.steps(a, b, 10, 20), { mid: async () => { ghost = await host.evaluate(() => ({ spot: window.__ct.spot(), hidden: document.querySelector('.snap-ghost').classList.contains('hidden') })); } });
    ok(ghost && ghost.spot === null && ghost.hidden, `dragging a die over p11 shows no ghost and no chip (${JSON.stringify(ghost)})`);
    ok(await P.waitView(bob, 'v.items[a].z === Math.max(...Object.values(v.items).map((it) => it.z))', die), '(the die is moved)');
    const it = (await items(bob))[die], d = await drawn(bob, die);
    ok(it.at === undefined && Math.abs(d.x - it.x) < 0.01 && Math.abs(d.y - it.y) < 0.01 && !(await crowd(bob, 'p11')).length, `it lies where it was dropped, with no address, drawn there (${JSON.stringify({ at: it.at, x: it.x, y: it.y, d })})`);
    await shot(host, 'p3r-die-on-point-desk');
  }

  // ===========================================================================
  section('6. A board move redraws no piece; the addresses follow by containment (D106)');
  {
    ok((await L.act(host, { t: 'lock', id: bg.id, on: false })).ok && await P.waitView(bob, '!v.items[a].lock', bg.id), '(Alice unlocks the board)');
    await h.sleep(400);
    const before = await items(bob), d0 = await bob.evaluate(() => window.__ct.perf.drawn);
    const drawn0 = Object.fromEntries(await Promise.all(Object.keys(before).filter((k) => k !== bg.id).map(async (k) => [k, await drawn(bob, k)])));
    ok((await L.act(host, { t: 'move', id: bg.id, x: bg.x + 100, y: bg.y })).ok, 'Alice moves the board one column right');
    ok(await P.waitView(bob, 'v.items[a.id].x === a.x', { id: bg.id, x: bg.x + 100 }), '(Bob\'s screen has it)');
    await h.sleep(500);
    const after = await items(bob), d1 = await bob.evaluate(() => window.__ct.perf.drawn);
    const still = Object.keys(before).every((k) => k === bg.id || (after[k].x === before[k].x && after[k].y === before[k].y));
    const moved = Object.keys(before).filter((k) => before[k].at !== after[k].at).length;
    ok(still && moved > 0, `nothing else moved, and ${moved} pieces read a new address (or none) by containment`);
    // On screen: a piece off the centre of its spot (or on none) is drawn where
    // it lies — one fanned on the board before, too — and one drawn where it
    // lay stays put. (One the move left centred on a neighbouring point, a
    // column away, is fanned there: §3g.)
    const nb = { ...bg, x: bg.x + 100 }, centred = (it) => it.at && SP[it.at] && it.x + MAN / 2 === nb.x + SP[it.at].x && it.y + MAN / 2 === nb.y + SP[it.at].y;
    const shown = await Promise.all(Object.keys(before).filter((k) => k !== bg.id && !centred(after[k])).map(async (k) => [k, drawn0[k], await drawn(bob, k)]));
    const at = (d, it) => Math.abs(d.x - it.x) < 0.01 && Math.abs(d.y - it.y) < 0.01;
    const jumped = shown.filter(([k, a, b]) => !at(b, after[k]) || (at(a, before[k]) && !at(b, a)));
    ok(shown.length > 20 && !jumped.length, `on Bob's phone the ${shown.length} pieces now off any spot's centre are drawn where they lie: those that were stay put, the fanned ones leave their board's fan (${shown.filter(([k, a]) => !at(a, before[k])).length} of them) (${jumped.length} elsewhere${jumped.length ? `: ${JSON.stringify(jumped[0])}` : ''})`);
    ok(d1 === d0, `Bob's phone redrew no item for it (perf.drawn +${d1 - d0}): an address alone changes no drawing`);
    await shot(bob, 'p3r-board-moved-phone');
    ok((await L.act(host, { t: 'move', id: bg.id, x: bg.x, y: bg.y })).ok, '(and back)');
  }

  await env.done();
})().catch(h.crash);
