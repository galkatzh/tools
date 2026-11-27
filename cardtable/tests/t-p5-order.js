// Phase 5, attacker case 10: order reveals nothing (spec §5j case 10, §2c
// "Hidden pieces carry no creation order", §2d, §0.2; D272, D274), written
// from the spec apart from the implementation. Over 20 fresh rooms (a new
// host each, so a new key and a new room), the host sets up Veiled Ranks with
// its rules, and Mallory — a raw peer, no app code — joins and keeps her
// first snapshot. From it she reads the 12 hidden North units (the ones
// whose back is North's): their z order, their key order in the body (§0.2:
// sorted ids), their ids and their squares. She knows the box (its source is
// public): the order in which its setup declares North's units and the
// square each was declared at. Her guessers:
//   - declared: the unit k-th in z order / in key order / in id order is the
//     k-th declared; the unit on a square is the one declared there;
//   - learned: for a place in an order (or a square), the rank most often
//     there in the first 10 rooms, guessed in the last 10.
// Each scores no better than the best constant guess (3 Pikes, or 3 rank-1
// units, in 12: 0.25), within the binomial 99 % bound (the declared ones over
// the 240 units; the learned ones trained on rooms 1–10, scored on 11–20).
// Her first snapshots carry no North unit's type, face or rank.
'use strict';
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const V = require('./p5v-lib');
const { BOXES } = require(path.join(h.APP_ROOT, 'cardtable/templates.js'));

const J = JSON.stringify;
const ROOMS = 20;
const RANKS = BOXES.ranks;
/** North's units as the box declares them: [{type, at}] in order (its setup's group whose pieces are North's). */
const DECL = RANKS.setup.filter((e) => e.group).flatMap((e) => e.group).filter((e) => RANKS.types[e.piece]?.back === 'north').map((e) => ({ type: e.piece, at: e.at }));
const rankOf = (type) => String(RANKS.types[type].meta.rank); // (a Trap's is null: "null")

(async () => {
  const env = await h.start();
  const rooms = [];
  section(`${ROOMS} fresh rooms of Veiled Ranks: Mallory's first snapshot of each`);
  ok(DECL.length === 12, `the box declares 12 North units (${DECL.map((d) => d.type).join(', ')})`);
  for (let k = 1; k <= ROOMS; k++) {
    const host = await env.page(`Host${k}`);
    await host.goto(env.url);
    await h.joinAs(host, `Host${k}`);
    await host.waitForFunction(() => window.__ct?.view().seq > 0, null, { timeout: 30000 });
    const r = await host.evaluate((box) => window.__ct.act({ t: 'loadBox', box, setup: true, clear: true, rules: true }), RANKS);
    await host.waitForFunction(() => window.__ct.jobs() === 0 && window.__ct.hostState()?.rules?.enabled, null, { timeout: 30000 });
    const st = await host.evaluate(() => window.__ct.hostState()), box = st.lastSetup;
    const Mal = await V.spy(env, host.url(), 1);
    const snap = await Mal.waitForFunction((back) => window.M.got.state.map(({ m }) => (typeof m?.b === 'string' ? JSON.parse(m.b) : m))
      .find((b) => b.kind === 'snap' && Object.values(b.items).filter((it) => it.b === back).length === 12), `${box}/north`, { timeout: 20000 }).then((x) => x.jsonValue(), () => null);
    if (!r?.ok || !snap) { ok(false, `room ${k}: set up (${J(r)}), and Mallory's first snapshot with North's 12 hidden units (${!!snap})`); await host.context().close(); await Mal.context().close(); continue; }
    const keys = Object.keys(snap.items);
    const north = keys.filter((id) => snap.items[id].b === `${box}/north`);
    // what she sees of each, and the truth (the host's), side by side
    rooms.push(north.map((id) => ({ id, z: snap.items[id].z, key: keys.indexOf(id), at: snap.items[id].at, rank: rankOf(st.items[id].t.split('/')[1]) })));
    const leak = V.scan(snap, [`${box}/n-`, 'meta']).concat(V.told([snap], north).map((x) => [x.id, J(x.f)]));
    if (leak.length) ok(false, `room ${k}: her first snapshot names a North unit: ${J(leak.slice(0, 3))}`);
    await host.context().close();
    await Mal.context().close();
  }
  ok(rooms.length === ROOMS, `${rooms.length} rooms recorded`);
  ok(rooms.every((us) => us.length === 12 && us.every((u) => typeof u.at === 'string')), 'each: 12 North units, each on a square');
  const rankAt = Object.fromEntries(DECL.map((d) => [d.at, rankOf(d.type)]));
  const declared = DECL.map((d) => rankOf(d.type));

  section('her guessers score no better than the best constant guess (0.25), within the binomial 99 % bound');
  const n = rooms.length * 12, cap = V.bound99(0.25, n);
  /** Each unit's place in room `us` by `by`: its rank among the room's 12 in that order (0–11), or its square. */
  const placeOf = (us, by) => (by === 'at' ? Object.fromEntries(us.map((u) => [u.id, u.at])) : Object.fromEntries([...us].sort((a, b) => (by === 'id' ? (a.id < b.id ? -1 : 1) : a[by] - b[by])).map((u, j) => [u.id, j])));
  /** Her accuracy guessing with `guess(us, u)` over the rooms `of` (indices). */
  const score = (guess, of = rooms.map((_, i) => i)) => of.reduce((s, i) => s + rooms[i].filter((u) => guess(rooms[i], u) === u.rank).length, 0) / (of.length * 12);
  for (const by of ['z', 'key', 'id', 'at']) {
    const acc = score((us, u) => (by === 'at' ? rankAt[placeOf(us, by)[u.id]] : declared[placeOf(us, by)[u.id]]));
    ok(acc <= cap, `"the unit ${by === 'at' ? 'on a square is the one declared there' : `k-th in ${by} order is the k-th declared`}": ${acc.toFixed(3)} ≤ ${cap.toFixed(3)} (${n} guesses)`);
  }
  // Learned: where each rank lay in the first half of the rooms, guessed in the other half (a guess made apart
  // from what it is scored on — a leave-one-out tally would tie each room's guesses to the others' and widen the
  // spread past the binomial's: 4 % over the bound in a simulation of the null, against 0.07 % for this split).
  const half = Math.floor(rooms.length / 2), train = rooms.slice(0, half), test = rooms.map((_, i) => i).slice(half), capL = V.bound99(0.25, test.length * 12);
  for (const by of ['z', 'key', 'at']) {
    const most = {};
    for (const vs of train) for (const v of vs) { const p = placeOf(vs, by)[v.id]; (most[p] ||= {})[v.rank] = (most[p][v.rank] || 0) + 1; }
    const guessAt = Object.fromEntries(Object.entries(most).map(([p, tally]) => [p, Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]]));
    const acc = score((us, u) => guessAt[placeOf(us, by)[u.id]], test);
    ok(acc <= capL, `"the rank most often at this ${by === 'at' ? 'square' : `place in ${by} order`} in rooms 1–${half}", in rooms ${half + 1}–${rooms.length}: ${acc.toFixed(3)} ≤ ${capL.toFixed(3)} (${test.length * 12} guesses)`);
  }
  const constant = Math.max(...['0', '1', '2', '3', '4', 'null'].map((r) => score(() => r)));
  console.log(`  (the best constant guess scored ${constant.toFixed(3)} over these rooms)`);
  await env.done();
})().catch(h.crash);
