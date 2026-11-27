// Phase 4B: Hexfront played on two screens, written from the spec (§4's
// demo, §4g, §4l t-p4-hexfront items 1–6) and the decisions it records
// (D217–D229: the group roll, the inspector, the selection; D221–D222:
// Hexfront from 📦, its turn script). Alice hosts on a desktop, Bob plays
// on an iPhone 13 held upright; each takes one full turn on their own
// screen, so every gesture runs on both.
//  1. Hexfront set up from 📦's Built-in section: one confirm (the table
//     had items), no trust dialog (built in by content, isBuiltin), its
//     rules on; the box a guest gets carries no setup, rules or state.
//  2. 400 counters in 40 stacks of ×10, 20 a side, each owned by its
//     side's seat and standing on a hex of the one hex map; dice; a face-
//     down pile of event cards; the two players in the two seats.
//  3. The turn script: out of turn, a player's own stack doesn't move; the
//     other side's stack is never theirs (a drag pans, a forged move is
//     refused); the side to play moves a stack a hex forward; ⚔ To combat
//     ends movement, ⏭ End turn hands the turn over.
//  4. A stack split with the inspector (Take 3: ×7 and ×3, the inspector
//     redrawn) and joined again by a drop onto the like stack (Shift+drag
//     on the desktop, ✥ Take all then a drag on the phone); a split out of
//     turn is refused.
//  5. Dice: refused before combat; in combat both picked and rolled as a
//     group (one line "rolled 2 dice: a · b", the faces as shown); the
//     other side's roll refused.
//  6. An event card drawn into a hand (its face in the hand bar, the pile
//     one fewer, the other player told only the count); a second draw and
//     a draw out of turn refused.
// B18 and B19 are t-p4-hex-bench.js's (serial). Every move is a real
// gesture; __ct.act sends only the forged move of section 3.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const { until, view, same, diff } = require('./p1-lib');
const B = require('./p4-lib');
const X = require('./p4h-lib');
const core = require(path.join(h.APP_ROOT, 'cardtable/core.js'));

const ZOOM = X.zoomFor;

(async () => {
  const env = await h.start();
  const alice = await X.player(env, 'Alice', env.url);
  const bob = await X.player(env, 'Bob', alice.url(), { ctx: P.PHONE });
  const asked = [];
  alice.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
  bob.on('dialog', (d) => { console.error('Bob: a dialog nobody expected', d.message()); d.dismiss(); });
  const both = [alice, bob];
  const other = (p) => (p === alice ? bob : alice);

  section('1. Hexfront set up from 📦\'s Built-in section (no trust dialog: built in by content)');
  await B.openBoxes(alice);
  const row = alice.locator('#box-builtins .box-row', { hasText: 'Hexfront' });
  ok((await row.count()) === 1, `📦's Built-in section lists Hexfront ("${(await row.first().textContent()).replace(/\s+/g, ' ').trim()}")`);
  const t1 = Date.now();
  await row.locator('button', { hasText: 'Set up' }).click();
  ok(await until(async () => { const v = await view(bob); return v.rules?.enabled && v.rules.name === 'Hexfront' && v.rules.public?.turn; }, 20000), "Set up: Hexfront's rules run, on Bob's phone too (its turn cue set)");
  ok(asked.length === 1 && /Hexfront/.test(asked[0]), `one confirm first, naming it: the table had items ("${asked.join(' | ')}")`);
  const modals = await alice.evaluate((t) => window.__modals.filter((m) => m.at >= t), t1);
  ok(!modals.some((m) => m.id === 'box-ask'), `no trust dialog, nor any other question of 📦 (${JSON.stringify(modals)})`);
  ok(await alice.evaluate(() => !document.getElementById('box-dialog').open), '📦 closes on the table set up');
  const S1 = await B.S(alice), box = S1.boxes[S1.lastSetup];
  ok(!!box && box.name === 'Hexfront' && S1.rules?.enabled && S1.rules.box === S1.lastSetup, `the host's state: «${box?.name}» set up (lastSetup ${S1.lastSetup}), its own rules running (rules.box)`);
  ok(core.isBuiltin(box), 'the box the host stored is built in by its content (core isBuiltin)');
  const pub = await bob.evaluate((id) => window.__ct.boxes()[id], S1.lastSetup);
  ok(!!pub && !('setup' in pub) && !('rules' in pub) && !('rulesState' in pub), `Bob's copy of the box (the boxes channel) has no setup, rules or rulesState (keys: ${Object.keys(pub || {}).join(', ')})`);
  for (const p of both) {
    await B.openBoxes(p);
    const r = await B.row(p, S1.lastSetup);
    ok(!!r && /built in/.test(r.text) && r.text.includes('📜'), `${p.who}'s 📦 lists it on this table, built in, with its 📜 ("${r?.text}")`);
    await B.closeBoxes(p);
  }

  section('2. 400 counters in 40 stacks on both screens; one hex map, dice, a face-down pile of event cards, the two seats taken');
  const H0 = { alice: await X.hexOf(alice), bob: await X.hexOf(bob) };
  for (const p of both) {
    const H = H0[p.who.toLowerCase()], u = H.units.map((id) => H.items[id]);
    const sides = [...new Set(H.units.map((id) => H.side[id]))].sort();
    ok(!!H.map && H.map.grid.rows > 0 && H.map.grid.cols > 0, `${p.who}: one hex map (${H.map?.grid.cols} × ${H.map?.grid.rows}, ${H.map?.grid.hex})`);
    ok(H.units.length === 40 && u.every((it) => it.n === 10) && u.reduce((n, it) => n + it.n, 0) === 400, `${p.who}: 40 stacks of ×10, 400 counters (${H.units.length} stacks, ${u.reduce((n, it) => n + (it.n || 1), 0)} counters)`);
    ok(sides.length === 2 && sides.every((s) => H.units.filter((id) => H.side[id] === s).length === 20), `${p.who}: two sides of 20 stacks (${sides.map((s) => `${s} ${H.units.filter((id) => H.side[id] === s).length}`).join(', ')})`);
    ok(H.units.every((id) => H.items[id].owner === `seat:${H.side[id]}`), `${p.who}: each stack belongs to its side's seat`);
    const off = H.units.filter((id) => { const q = X.hexNear(H.map, X.centre(H, id)); return !(q.d < 0.5 && q.at === H.items[id].at); });
    ok(!off.length && new Set(u.map((it) => it.at)).size === 40, `${p.who}: each on a hex of its own, centred, its address public (${off.length} off; ${new Set(u.map((it) => it.at)).size} hexes)`);
    ok(H.dice.length >= 2, `${p.who}: dice (${H.dice.length})`);
    const ev = H.events && H.items[H.events];
    ok(!!ev && ev.n === 24 && ev.top?.up === false && !!H.eventRef, `${p.who}: the Events pile, face down, 24 cards (D222) of one type (${ev?.n}, ${H.eventRef})`);
    ok(Object.keys(H.seats).length === 2 && H.seats[Object.keys(H.seats)[0]] !== H.seats[Object.keys(H.seats)[1]] && [alice, bob].every((q) => Object.values(H.seats).includes(q.pid)),
      `${p.who}: Alice and Bob sit in the two seats (${JSON.stringify(H.seats)})`);
  }
  ok(same(H0.alice.items, H0.bob.items), `the two screens hold the same table${diff(H0.alice.items, H0.bob.items) ? `: ${diff(H0.alice.items, H0.bob.items)}` : ''}`);
  const badges = await bob.evaluate((ids) => ids.map((id) => document.querySelector(`#table .item[data-id="${id}"] > .count`)?.textContent), H0.bob.units);
  ok(badges.every((b) => b === '×10'), `Bob's phone draws ×10 on every stack (${[...new Set(badges)].join(', ')})`);
  await bob.screenshot({ path: path.join(__dirname, 'shots', 'p4-hexplay-iphone.png') });

  const SIDE = Object.fromEntries(Object.entries(H0.alice.seats).map(([s, pid]) => [pid, s]));
  const DIR = Object.fromEntries(Object.keys(H0.alice.seats).map((s) => [s, X.forward(H0.alice, s)]));
  /** Which way page p's side moves forward on the table: −1 up, +1 down (towards the map's middle, as the game began). */
  const fwd = (p) => DIR[SIDE[p.pid]];
  /** Page p's stacks, the most forward first (then left to right), as the table is now. */
  const front = (H, p) => X.frontOf(H, SIDE[p.pid], fwd(p));
  const scr = (p, q) => P3.screenOf(p, q.x, q.y);
  const { putAway, moveStack } = X;
  /** Page p opens the inspector on its stack `id`: a click on its ×N on the desktop, a long press on the phone. */
  async function inspect(p, id) {
    const H = await X.hexOf(p);
    await X.focus(p, X.centre(H, id), ZOOM(p));
    if (p.touch) await X.longPress(p, await P3.centreOf(p, id));
    else await X.tapAt(p, await X.badgeOf(p, id));
    return until(async () => !!(await X.inspector(p)), 6000, 100).then(() => X.inspector(p));
  }
  /** Page p rolls die `id` alone: a double click on the desktop; a tap and the bar's 🎲 Roll on the phone. */
  async function rollOne(p, id) {
    const H = await X.hexOf(p);
    await X.focus(p, X.centre(H, id), ZOOM(p));
    const c = await P3.centreOf(p, id);
    if (!p.touch) { await p.mouse.dblclick(c.x, c.y); return; }
    await X.tapAt(p, c);
    if (await until(async () => (await X.bar(p))?.cmds.includes('roll'), 5000, 100)) await X.press(p, '#action-bar [data-cmd="roll"]');
    else ok(false, `${p.who}: no 🎲 Roll in the die's bar`);
  }
  /** Page p draws from the Events pile: a double click on the desktop; a tap and the bar's Draw on the phone. */
  async function drawEvent(p, ev) {
    const H = await X.hexOf(p);
    await X.focus(p, X.centre(H, ev), ZOOM(p));
    const c = await P3.centreOf(p, ev);
    if (!p.touch) { await p.mouse.dblclick(c.x, c.y); return; }
    await X.tapAt(p, c);
    if (await until(async () => (await X.bar(p))?.cmds.includes('draw'), 5000, 100)) await X.press(p, '#action-bar [data-cmd="draw"]');
    else ok(false, `${p.who}: no Draw in the pile's bar (${JSON.stringify(await X.bar(p))})`);
  }
  const unitsOf = (H, p) => H.units.filter((id) => H.side[id] === SIDE[p.pid]);
  /** Whether stack `id` stands as it stood in `H` (its count, place and address) on page p, and p's side has no new stack. */
  const asWas = async (p, H, id, q) => {
    const now = await X.hexOf(p), a = now.items[id], b = H.items[id];
    return !!a && a.n === b.n && a.at === b.at && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && unitsOf(now, q).length === unitsOf(H, q).length;
  };

  /** One full turn of page A's side, page O out of turn. */
  async function turn(A, O) {
    const dev = (p) => `${p.who}${p.touch ? ' (phone)' : ' (desktop)'}`;
    let H = await X.hexOf(alice);
    section(`3. ${dev(A)}'s turn: out of turn ${dev(O)} moves nothing; ${A.who} can't move ${O.who}'s side; ${A.who} moves a stack a hex forward`);
    ok(H.rules.public.turn === A.pid, `the turn cue names ${A.who} (public.turn)`);
    ok((await X.ruleBtns(A)).length > 0 && !(await X.ruleBtns(O)).length, `the phase button shows on ${A.who}'s screen alone (${JSON.stringify(await X.ruleBtns(A))})`);
    const [o1, o2, o3] = front(H, O), [m1, m2] = front(H, A);
    let t0 = Date.now(), s0 = await X.now(O);
    await moveStack(O, o1, X.ahead(H, o1, fwd(O)));
    if (O !== alice) { // (the host's own actions never cross the wire: its refusal below says the host had it)
      const sent = await X.sentSince(O, s0);
      ok(sent.some((a) => a.t === 'move' && a.id === o1), `${O.who} drags a stack of theirs forward: the move goes to the host (${[...new Set(sent.map((a) => a.t))].join(', ')})`);
    }
    const no1 = await X.refusal(O, t0);
    ok(!!no1, `out of turn it is refused: "${no1}"`);
    ok(await until(() => asWas(alice, H, o1, O), 5000) && await until(() => asWas(bob, H, o1, O), 5000), 'the stack stays where it stood, whole, on both screens');
    await putAway(O);

    s0 = await X.now(A);
    t0 = Date.now();
    const a2 = await (async () => { const Hn = await X.hexOf(A); await X.focus(A, X.centre(Hn, o2), ZOOM(A)); return P3.centreOf(A, o2); })();
    await X.dragFrom(A, a2, await scr(A, X.ahead(H, o2, fwd(O))), { shift: !A.touch });
    // (a guest's page sends nothing; the host's own page refuses nothing — it would have sent its move to its own table)
    const tried = A === alice ? [] : (await X.sentSince(A, s0)).filter((a) => !['drag', 'select'].includes(a.t)), no0 = await X.refusal(A, t0, 1500);
    ok(!tried.length && !no0 && await asWas(alice, H, o2, O), `${A.who}'s drag on ${O.who}'s stack sends nothing (${JSON.stringify(tried)}, no refusal: ${no0}): it isn't theirs to move`);
    t0 = Date.now();
    const tgt = X.ahead(H, o2, fwd(O)), sz = H.size[o2];
    await A.evaluate((a) => window.__ct.act(a), { t: 'move', id: o2, x: tgt.x - sz.w / 2, y: tgt.y - sz.h / 2 });
    const no2 = await X.refusal(A, t0);
    ok(!!no2 && await until(() => asWas(alice, H, o2, O), 3000), `a forged move of it (what the page never sends) is refused by the host: "${no2}"`);
    await putAway(A);

    const to1 = X.ahead(H, m1, fwd(A)), tm = Date.now();
    await moveStack(A, m1, to1);
    ok(await until(async () => { for (const p of both) { const it = (await X.hexOf(p)).items[m1]; if (!(it?.at === to1.at && it.n === 10)) return false; } return true; }, 8000),
      `${A.who} moves a whole stack a hex forward, to ${to1.at}, on both screens`);
    ok(await until(() => X.logged(O, A.pid, /^moved\b/, tm), 5000), `the log says ${A.who} moved it`);
    await putAway(A);

    section(`4. ${dev(A)} splits a stack with the inspector (Take 3) and joins it again; ${O.who}'s split out of turn is refused`);
    H = await X.hexOf(alice);
    let ins = await inspect(A, m2);
    ok(!!ins && /×10\b/.test(ins.text) && ['less', 'more', 'take', 'all'].every((b) => ins.buttons.includes(b)), `${A.touch ? 'a long press' : 'a click on its ×10'}: the inspector, ×10, Take [k] and Take all ("${ins?.text}")`);
    await X.press(A, '#inspector [data-ins="more"]');
    await X.press(A, '#inspector [data-ins="more"]');
    ok((await X.inspector(A))?.k === 3, `two + : Take 3 (${(await X.inspector(A))?.k})`);
    await X.press(A, '#inspector [data-ins="take"]');
    let N = null;
    ok(await until(async () => {
      for (const p of both) {
        const Hn = await X.hexOf(p), it = Hn.items[m2];
        N = Hn.units.find((id) => !H.items[id] && Hn.items[id].t === it?.t);
        if (!(it?.n === 7 && N && Hn.items[N].n === 3 && Hn.items[N].owner === it.owner && Hn.items[N].at && Hn.items[N].at !== it.at)) return false;
      }
      return true;
    }, 8000), `Take 3: ×7 stays, a ×3 of its kind stands on a hex of its own beside it, on both screens (${N})`);
    ok(await until(async () => /×7\b/.test((await X.inspector(A))?.text || ''), 6000), `the inspector stays open on the stack that changed, redrawn ("${(await X.inspector(A))?.text}")`);
    if (A.touch) await X.tapAt(A, await X.feltAt(A));
    else await A.keyboard.press('Escape');
    ok(await until(async () => !(await X.inspector(A)), 5000), `${A.touch ? 'a tap outside' : 'Esc'} closes it`);
    await putAway(A);

    t0 = Date.now();
    const mineO = front(await X.hexOf(alice), O).find((id) => id !== o1 && id !== o2) || o3, Hb = await X.hexOf(alice);
    ins = await inspect(O, mineO);
    ok(!!ins?.buttons.includes('take'), `${O.who} opens the inspector on a stack of theirs ("${ins?.text}")`);
    await X.press(O, '#inspector [data-ins="take"]');
    const no3 = await X.refusal(O, t0);
    ok(!!no3 && await until(() => asWas(alice, Hb, mineO, O), 3000), `Take out of turn is refused, the stack still ×10: "${no3}"`);
    if (O.touch) await X.tapAt(O, await X.feltAt(O));
    else await O.keyboard.press('Escape');
    await putAway(O);

    const Hj = await X.hexOf(A);
    if (A.touch) {
      await X.focus(A, X.centre(Hj, N), ZOOM(A));
      await X.tapAt(A, await X.badgeOf(A, N));
      ok(await until(async () => /×3\b/.test((await X.inspector(A))?.text || ''), 6000), `a tap on the ×3: its inspector ("${(await X.inspector(A))?.text}")`);
      await X.press(A, '#inspector [data-ins="all"]');
      await X.dragFrom(A, await P3.centreOf(A, N), await P3.centreOf(A, m2));
    } else {
      await X.focus(A, X.centre(Hj, N), ZOOM(A));
      await X.dragFrom(A, await P3.centreOf(A, N), await P3.centreOf(A, m2), { shift: true });
    }
    ok(await until(async () => { for (const p of both) { const it = (await X.hexOf(p)).items; if (!(it[m2]?.n === 10 && !it[N])) return false; } return true; }, 8000),
      `${A.touch ? '✥ Take all, then a drag' : 'A Shift+drag'} of the ×3 onto the ×7: joined, ×10 again, on both screens`);
    await putAway(A);

    section(`6. ${dev(A)} draws an event card into the hand; a second draw, and ${O.who}'s out of turn, are refused`);
    H = await X.hexOf(alice);
    const ev = H.events, n0 = H.items[ev].n, oHand = (await X.hexOf(O)).hand.length;
    await drawEvent(A, ev);
    ok(await until(async () => (await X.hexOf(A)).hand.length === 1, 8000), `${A.who}'s hand holds one card`);
    const HA = await X.hexOf(A), card = HA.hand[0], face = HA.types[card?.t]?.faces?.[card?.f];
    ok(card?.t === H.eventRef && !!face, `it is an event card (${card?.t}, face ${card?.f}: «${face?.name}»)`);
    const shown = await A.locator('#hand .hcard').allTextContents();
    ok(shown.length === 1 && !!face?.name && shown[0].includes(face.name), `${A.who}'s hand bar shows its face ("${shown[0]?.replace(/\s+/g, ' ').slice(0, 60)}")`);
    ok(await until(async () => { const Ho = await X.hexOf(O); return Ho.items[ev].n === n0 - 1 && (await view(O)).players[A.pid].handCount === 1; }, 5000), `${O.who} sees the pile one fewer (${n0 - 1}) and ${A.who} holding one card`);
    if (O !== alice) { // (the host holds every card: what a guest is sent is what matters)
      // (an event card is a piece {t, f}; the face-down pile shows only its back {b}: outside O's own hand, no piece of that type may reach O)
      const leak = await O.evaluate((ref) => {
        let n = 0;
        const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.t === ref) n++; Object.values(v).forEach(walk); } };
        for (const { body } of window.__rtc.bodies) walk({ ...body, hand: undefined });
        return { n, bodies: window.__rtc.bodies.length };
      }, H.eventRef);
      ok(leak.bodies > 0 && !leak.n, `${O.who} never received an event card's identity outside their own hand (${leak.n} in ${leak.bodies} bodies)`);
    }
    await putAway(A);
    t0 = Date.now();
    await drawEvent(A, ev);
    const no4 = await X.refusal(A, t0);
    ok(!!no4 && (await X.hexOf(A)).hand.length === 1, `a second draw this turn is refused (one event a turn, D222): "${no4}"`);
    await putAway(A);
    t0 = Date.now();
    await drawEvent(O, ev);
    const no5 = await X.refusal(O, t0);
    ok(!!no5 && (await X.hexOf(O)).hand.length === oHand && (await X.hexOf(alice)).items[ev].n === n0 - 1, `${O.who}'s draw out of turn is refused, their hand and the pile as they were: "${no5}"`);
    await putAway(O);

    section(`5. ${dev(A)}: dice refused before combat; ⚔ To combat ends movement; both dice rolled as a group; ${O.who}'s roll refused; ⏭ End turn`);
    H = await X.hexOf(alice);
    let from = Date.now();
    t0 = Date.now();
    await rollOne(A, H.dice[0]);
    const no6 = await X.refusal(A, t0);
    ok(!!no6 && !(await X.logged(alice, A.pid, /^rolled/, from)), `${A.who}'s roll before combat is refused: "${no6}"`);
    await putAway(A);
    const btn0 = await X.ruleBtns(A), combat = btn0.find((b) => /combat/i.test(b.label));
    ok(!!combat, `${A.who}'s phase button: "${combat?.label}"`);
    await X.press(A, `#rules-btns button[data-rbtn="${combat?.id}"]`);
    ok(await until(async () => { const b = await X.ruleBtns(A); return b.length && !b.some((x) => x.id === combat?.id); }, 5000), `pressed: the phase moves on — ${A.who}'s button now "${(await X.ruleBtns(A)).map((b) => b.label).join(', ')}"`);
    ok(await until(async () => { const v = await view(O); return v.rules.public.badges?.[A.pid] !== H.rules.public.badges?.[A.pid]; }, 5000), `${O.who} sees ${A.who}'s phase badge change ("${H.rules.public.badges?.[A.pid]}" → "${(await view(O)).rules.public.badges?.[A.pid]}")`);
    t0 = Date.now();
    const Hm = await X.hexOf(alice);
    await moveStack(A, m2, X.ahead(Hm, m2, fwd(A)));
    const no7 = await X.refusal(A, t0);
    ok(!!no7 && await until(() => asWas(alice, Hm, m2, A), 3000), `in combat, movement is over: "${no7}"`);
    await putAway(A);

    from = Date.now();
    const [d1, d2] = H.dice;
    await X.focus(A, X.centre(H, d1), ZOOM(A));
    if (A.touch) {
      await X.press(A, '#sel-mode');
      for (const d of [d1, d2]) await X.tapAt(A, await P3.centreOf(A, d));
    } else {
      await A.keyboard.down('Shift');
      for (const d of [d1, d2]) await X.tapAt(A, await P3.centreOf(A, d));
      await A.keyboard.up('Shift');
    }
    const gb = await X.bar(A);
    ok(/^2 selected/.test(gb?.text || '') && gb.cmds.includes('roll'), `${A.touch ? '⬚ and two taps' : 'Shift+click on each'}: both dice picked, the group bar offers 🎲 Roll ("${gb?.text}")`);
    if (A.touch) await X.press(A, '#action-bar [data-cmd="roll"]');
    else await A.keyboard.press(' ');
    let rolled = [];
    ok(await until(async () => (rolled = await X.linesBy(alice, A.pid, /^rolled/, from)).length > 0, 8000)
      && rolled.length === 1 && /^rolled 2 dice: \d · \d$/.test(rolled[0]), `one line: "${A.who} ${rolled.join(' | ')}"`);
    const vals = /^rolled 2 dice: (\d) · (\d)$/.exec(rolled[0] || '')?.slice(1).map(Number);
    // (the line is read on Alice's screen, the host's: the roll's patch may still be on its way to Bob's)
    let faces = [];
    await until(async () => { const Hr = await X.hexOf(O); faces = [d1, d2].sort().map((d) => Hr.items[d].f + 1); return !!vals && vals.join() === faces.join(); }, 5000);
    ok(!!vals && vals.join() === faces.join(), `the values said are the faces the dice show, on ${O.who}'s screen too (${vals?.join(', ')} / ${faces.join(', ')})`);
    await putAway(A);
    from = Date.now();
    t0 = from;
    await rollOne(O, d1);
    const no8 = await X.refusal(O, t0);
    ok(!!no8 && !(await X.logged(alice, O.pid, /^rolled/, from)), `${O.who}'s roll is refused: "${no8}"`);
    await putAway(O);

    const end = (await X.ruleBtns(A)).find((b) => /end/i.test(b.label));
    ok(!!end, `${A.who}'s next phase button: "${end?.label}"`);
    await X.press(A, `#rules-btns button[data-rbtn="${end?.id}"]`);
    ok(await until(async () => (await view(alice)).rules.public.turn === O.pid && (await view(bob)).rules.public.turn === O.pid, 8000), `⏭ ${end?.label}: ${O.who}'s turn on both screens`);
    ok(await until(async () => (await X.ruleBtns(O)).length > 0 && !(await X.ruleBtns(A)).length, 5000), `the phase button moves to ${O.who}'s screen`);
  }

  const first = H0.alice.rules.public.turn, A1 = first === alice.pid ? alice : bob;
  ok([alice.pid, bob.pid].includes(first), `turn 1 opens with a seated player's side (${SIDE[first]}: ${A1.who})`);
  await turn(A1, other(A1));
  await turn(other(A1), A1);
  ok(await until(async () => (await view(bob)).rules.public.turn === first, 5000), `turn 2: back to ${A1.who}'s side`);
  await alice.screenshot({ path: path.join(__dirname, 'shots', 'p4-hexplay-desktop.png') });
  await B.settle(alice);
  const [va, vb] = [await view(alice), await view(bob)];
  ok(same(va.items, vb.items) && same(va.players, vb.players), `the two screens agree, item for item${diff(va.items, vb.items) ? `: ${diff(va.items, vb.items)}` : ''}`);
  await env.done();
})().catch(h.crash);
