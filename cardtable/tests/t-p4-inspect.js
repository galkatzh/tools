// Phase 4B, written from the spec (§4g "The stack inspector"; §4l
// t-p4-select item 6), independent of the implementation's own
// t-p4-select.js — real gestures on real screens: Alice hosts on a
// desktop, Bob inspects on a desktop (mouse and keyboard), Carol on an
// iPhone 13 upright and Dave on one held sideways (CDP touches).
//  - a ×N stack: opened by a tap of its ×N badge, by ⋯ Inspect in its bar,
//    by a long press on a phone; its count; Take [k] with the stepper (1 …
//    N−1) splitting k off next to it, snapped; Take all arming a drag of
//    the whole stack; a hidden stack showing its back and nothing of its
//    face; someone else's stack offering no Take;
//  - a crowded space: its ×k badge opens the member list (a face or a
//    back, a label, the owner's dot); a tap selects that piece with its
//    bar; a drag out of the list carries it;
//  - it closes on Esc, an outside tap, or when what it shows changes under
//    it — redrawn while the stack or the crowd still stands, closed when it
//    is gone.
'use strict';
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const P3 = require('./p3-lib');
const M = require('./p4m-lib');

const J = JSON.stringify;
// --- the box (original): a 12 × 8 plot of 100-unit cells with stacks and crowded cells on it ---
const BX = 400, BY = 400;
const cell = (c, r) => ({ x: BX + 100 * c + 50, y: BY + 100 * r + 50 });
const TL = (p, s = 60) => [p.x - s / 2, p.y - s / 2];
const SPOT = { S1: cell(1, 1), S2: cell(4, 1), S3: cell(7, 1), S4: cell(10, 1), S5: cell(1, 6), S6: cell(10, 6), K1: cell(3, 4), K2: cell(7, 4) };
const BOX = {
  name: 'Stack yard', imgs: [], lockable: 'anyone', table: { shape: 'rect', w: 2000, h: 1600 },
  backs: { ub: { face: { color: '#475569', label: '?' } } },
  types: {
    plot: { kind: 'board', name: 'Plot', w: 1200, h: 800, faces: [{ color: '#d9c9a3' }], board: { grid: { type: 'square', cols: 12, rows: 8, cell: 100, x: 0, y: 0, draw: 'lines' } } },
    tok: { kind: 'token', name: 'Token', faces: [{ color: '#f59e0b', label: 'T' }] },
    unit: { kind: 'token', name: 'Infantry', shape: 'rect', back: 'ub', faces: [{ color: '#16a34a', label: 'IN' }] },
    peg: { kind: 'token', name: 'Peg', shape: 'rect', w: 50, faces: [{ color: '#a855f7', label: 'P' }, { color: '#0ea5e9', label: 'Q' }] },
  },
  setup: [
    { piece: 'plot', at: [BX, BY] },
    { piece: 'tok', n: 10, at: TL(SPOT.S1) },
    { piece: 'unit', n: 6, up: false, at: TL(SPOT.S2) },
    { piece: 'tok', n: 4, at: TL(SPOT.S3) },
    { piece: 'tok', n: 5, at: TL(SPOT.S4) },
    { piece: 'tok', n: 3, at: TL(SPOT.S5) },
    { piece: 'tok', n: 3, at: TL(SPOT.S6) },
    // K1: four pieces on one cell — two pegs (one to be Alice's), a hidden unit, a token
    { piece: 'peg', f: 0, at: TL(SPOT.K1, 50) },
    { piece: 'peg', f: 1, at: TL(SPOT.K1, 50) },
    { piece: 'unit', up: false, at: TL(SPOT.K1) },
    { piece: 'tok', at: TL(SPOT.K1) },
    // K2: three pegs on one cell (Carol's)
    { piece: 'peg', count: 3, at: TL(SPOT.K2, 50) },
    // Dave's three tokens
    { piece: 'tok', count: 3, spread: [100, 0], at: TL(cell(8, 7)) },
  ],
};

(async () => {
  const env = await h.start();
  const alice = await M.join(env, 'Alice', env.url);
  const bob = await M.join(env, 'Bob', alice.url());
  const carol = await M.join(env, 'Carol', alice.url(), { ctx: P.PHONE });
  const dave = await M.join(env, 'Dave', alice.url(), { ctx: h.playwright.devices['iPhone 13 landscape'] });
  const all = [alice, bob, carol, dave];
  alice.on('dialog', (d) => d.accept());
  const r0 = await alice.evaluate((box) => window.__ct.act({ t: 'loadBox', box, setup: true, clear: true }), BOX);
  ok(r0?.ok, `(Alice sets up the test box: ${J(r0)})`);
  for (const p of all) ok(await P.waitView(p, 'Object.keys(v.items).length === 17', null, 30000), `(${p.label} sees its 17 items)`);
  let its = await M.items(alice);
  /** The id of the item centred at table point q (size s), of type `ty` when given. */
  const at = (q, s = 60, ty) => M.idAt(its, q.x, q.y, s, (it) => !ty || it.t?.endsWith(`/${ty}`) || (ty === 'hidden' && !it.t));
  const S1 = at(SPOT.S1), S2 = at(SPOT.S2), S3 = at(SPOT.S3), S4 = at(SPOT.S4), S5 = at(SPOT.S5), S6 = at(SPOT.S6);
  const pegP = Object.keys(its).find((id) => its[id].t?.endsWith('/peg') && its[id].f === 0 && Math.abs(its[id].x + 25 - SPOT.K1.x) < 1);
  const pegQ = Object.keys(its).find((id) => its[id].t?.endsWith('/peg') && its[id].f === 1);
  const hidK1 = at(SPOT.K1, 60, 'hidden'), tokK1 = at(SPOT.K1, 60, 'tok');
  const K1 = [pegP, pegQ, hidK1, tokK1], K2 = Object.keys(its).filter((id) => its[id].t?.endsWith('/peg') && Math.abs(its[id].x + 25 - SPOT.K2.x) < 1);
  ok([S1, S2, S3, S4, S5, S6, ...K1].every(Boolean) && K2.length === 3, '(the stacks and the crowded cells are where the box put them)');
  for (const [id, to] of [[pegP, alice.pid], [S6, alice.pid]]) await alice.evaluate(([id, to]) => window.__ct.act({ t: 'owner', id, to }), [id, to]);
  for (const p of all) await P.waitView(p, 'a.every((id) => v.items[id]?.owner)', [pegP, S6]);
  its = await M.items(alice);
  const insp = (p) => p.evaluate(() => {
    const el = document.getElementById('inspector');
    if (!el || el.classList.contains('hidden') || !el.getClientRects().length || getComputedStyle(el).display === 'none') return null;
    const r = el.getBoundingClientRect(), btn = (re) => [...el.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
    return {
      text: el.textContent, box: { l: r.left, t: r.top, r: r.right, b: r.bottom },
      rows: [...el.querySelectorAll('li')].map((li) => ({ id: li.dataset.id, text: li.textContent })),
      btns: [...el.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), dis: b.disabled, h: b.getBoundingClientRect().height })),
      k: +(el.querySelector('output')?.textContent ?? NaN),
      take: btn(/^Take \d+$/)?.textContent.trim() || null,
    };
  });
  /** Presses the inspector's button whose text matches `re` (a tap on a touch screen). */
  const insPress = async (p, re) => {
    const b = p.locator('#inspector button:visible', { hasText: re }).first();
    if (p.touch) await b.tap(); else await b.click();
  };
  const PLUS = /^\+$/, MINUS = /^[−-]$/;
  const covers = (box, q) => q.x > box.l && q.x < box.r && q.y > box.t && q.y < box.b;

  // ===========================================================================
  section('6a. a ×N stack (Bob): its badge opens the inspector; the stepper; Take k; redrawn when it changes; Esc');
  {
    const b1 = await M.badge(bob, S1, 'count');
    ok(b1 && /10/.test(b1.text), `(S1 shows its ×N badge: "${b1?.text}")`);
    await M.click(bob, b1);
    let I = await insp(bob);
    ok(I && /\b10\b/.test(I.text), `a click on the ×10 badge opens the inspector with the count (“${I?.text.trim()}”)`);
    ok(I && I.k === 1 && I.btns.find((b) => MINUS.test(b.text))?.dis, `Take starts at 1, and − can't go below it (k = ${I?.k})`);
    const c1 = await M.centre(bob, S1);
    ok(I && !covers(I.box, c1), 'it stands beside the stack, not over it');
    for (let k = 0; k < 8; k++) await insPress(bob, PLUS);
    I = await insp(bob);
    ok(I.k === 9 && I.btns.find((b) => PLUS.test(b.text))?.dis, `the stepper goes up to N − 1 and no further: + is disabled there (k = ${I.k})`);
    for (let k = 0; k < 6; k++) await insPress(bob, MINUS);
    I = await insp(bob);
    ok(I.k === 3 && I.take === 'Take 3', `back down to 3: "${I.take}"`);
    const t0 = Date.now() - 5, before = await M.items(alice), s0 = await M.nSent(bob);
    await insPress(bob, /^Take 3$/);
    ok(await P.waitView(alice, 'v.items[a].n === 7', S1), 'Take 3 leaves ×7 on the stack');
    const after = await M.items(alice), fresh = Object.keys(after).filter((id) => !before[id]);
    const nw = after[fresh[0]], cx = nw && nw.x + 30, cy = nw && nw.y + 30;
    const onCell = nw && Math.abs(((cx - BX) % 100) - 50) < 0.5 && Math.abs(((cy - BY) % 100) - 50) < 0.5;
    const near = nw && Math.hypot(cx - SPOT.S1.x, cy - SPOT.S1.y) <= 150;
    ok(fresh.length === 1 && nw.n === 3 && nw.t === before[S1].t && nw.f === before[S1].f, `and puts a new ×3 of the same token on the table (${J(fresh.map((id) => ({ n: after[id].n, x: after[id].x, y: after[id].y })))})`);
    ok(onCell && near && !(Math.abs(cx - SPOT.S1.x) < 1 && Math.abs(cy - SPOT.S1.y) < 1), `next to the stack, snapped to a cell's centre (${cx}, ${cy}; the stack at ${SPOT.S1.x}, ${SPOT.S1.y})`);
    const ln = await M.lines(alice, bob.pid, t0), sent = (await M.sent(bob, s0)).map((x) => x.a);
    ok(sent.length === 1 && sent[0].t === 'split' && sent[0].id === S1 && sent[0].n === 3, `Take sends one split {n: 3} (${J(sent)})`);
    ok(ln.length === 1 && /^took 3 from /.test(ln[0]), `one log line: ${J(ln)}`);
    I = await insp(bob);
    ok(I && /\b7\b/.test(I.text) && !/\b10\b/.test(I.text), `the inspector stays open on the stack, redrawn: ×7 (“${I?.text.trim()}”)`);
    // the stack changes under it: Alice drags one off it
    const a1 = await M.centre(alice, S1), to = await M.pt(alice, cell(2, 3).x, cell(2, 3).y);
    await M.mouseDrag(alice, P3.steps(a1, to, 10));
    ok(await P.waitView(bob, 'v.items[a].n === 6', S1), '(Alice drags one off the stack: ×6)');
    ok(await M.until(async () => /\b6\b/.test((await insp(bob))?.text || ''), 3000, 100), `Bob's inspector follows: ×6 (“${(await insp(bob))?.text.trim()}”)`);
    await bob.keyboard.press('Escape');
    ok(!(await insp(bob)), 'Esc closes it');
  }

  // ===========================================================================
  section('6b. ⋯ Inspect in the bar, and Take all: the next drag carries the whole stack');
  {
    await M.click(bob, await M.centre(bob, S1));
    const b = await M.bar(bob);
    ok(b.on && b.btns.includes('⋯ Inspect'), `a click on the stack shows its bar with ⋯ Inspect (${J(b.btns)})`);
    await M.barPress(bob, '⋯ Inspect');
    const I = await insp(bob);
    ok(I && /\b6\b/.test(I.text) && I.btns.some((x) => /Take all/.test(x.text)), `⋯ Inspect opens the inspector on the stack, with Take all (“${I?.text.trim()}”)`);
    await insPress(bob, /Take all/);
    ok(!(await insp(bob)), 'Take all closes it');
    const before = await M.items(alice), t0 = Date.now() - 5;
    const from = await M.centre(bob, S1), to = await M.pt(bob, cell(1, 3).x, cell(1, 3).y);
    await M.mouseDrag(bob, P3.steps(from, to, 12), { pause: 20 });
    ok(await P.waitView(alice, 'v.items[a.id] && Math.abs(v.items[a.id].x + 30 - a.x) < 0.5 && Math.abs(v.items[a.id].y + 30 - a.y) < 0.5', { id: S1, ...cell(1, 3) }), 'the next drag carries the stack to the cell it is dropped on');
    const after = await M.items(alice);
    ok(after[S1].n === 6 && Object.keys(after).length === Object.keys(before).length, `whole: ×${after[S1].n} there, no piece split off (${Object.keys(after).length} items)`);
    ok((await M.lines(alice, bob.pid, t0)).length === 1, `(one line: ${J(await M.lines(alice, bob.pid, t0))})`);
    await bob.keyboard.press('Escape');
  }

  // ===========================================================================
  section('6c. a hidden stack shows its back; an outside click closes the inspector; someone else\'s stack offers no Take');
  {
    await M.click(bob, await M.badge(bob, S2, 'count'));
    const I = await insp(bob);
    const thumb = await bob.evaluate(() => [...document.querySelectorAll('#inspector *')].filter((e) => getComputedStyle(e).backgroundColor === 'rgb(71, 85, 105)').map((e) => e.textContent.trim()));
    ok(I && /\b6\b/.test(I.text), `a click on the hidden stack's ×6 opens the inspector, with its count (“${I?.text.trim()}”)`);
    ok(thumb.length > 0 && thumb.some((t) => t === '?'), `it shows the back: its colour and its "?" (${J(thumb)})`);
    ok(I && !/\bIN\b|Infantry/.test(I.text) && !(await bob.evaluate(() => /#16a34a|rgb\(22, 163, 74\)/i.test(document.getElementById('inspector').innerHTML))), 'and nothing of the face: no label, no type name, no face colour');
    const out = await M.pt(bob, 1800, 300);
    ok((await M.hit(bob, out)) === 'table', '(a felt point away from it)');
    await M.click(bob, out);
    ok(!(await insp(bob)), 'a click outside closes it');
    // Alice's stack: anyone's badge opens it, but it offers Bob no Take
    await M.click(bob, await M.badge(bob, S6, 'count'));
    const J6 = await insp(bob);
    ok(J6 && /\b3\b/.test(J6.text) && !J6.btns.some((x) => /^Take|Take all/.test(x.text)), `Alice's ×3: the inspector opens, with no Take for Bob (${J(J6?.btns.map((x) => x.text))})`);
    await bob.keyboard.press('Escape');
  }

  // ===========================================================================
  section('6d. a crowded cell: its ×k badge lists the members; a tap selects one with its bar; a drag out of the list carries one');
  {
    const top = await bob.evaluate((ids) => ids.find((id) => document.querySelector(`.item[data-id="${id}"] > .fanb`)), K1);
    const fb = top && (await M.badge(bob, top, 'fanb'));
    ok(fb && /4/.test(fb.text), `(the crowded cell shows its ×k badge: "${fb?.text}")`);
    await M.click(bob, fb);
    let I = await insp(bob);
    ok(I && I.rows.length === 4 && J(I.rows.map((r) => r.id).sort()) === J([...K1].sort()), `a click on it lists the cell's four pieces (${J(I?.rows.map((r) => r.text))})`);
    const row = (id) => I.rows.find((r) => r.id === id)?.text || '';
    ok(/\bP\b/.test(row(pegP)) && /\bQ\b/.test(row(pegQ)) && /\bT\b/.test(row(tokK1)), 'each shown piece with its label');
    ok(!/\bIN\b|Infantry/.test(row(hidK1)), `the hidden one with nothing of its face (“${row(hidK1)}”)`);
    const look = await bob.evaluate(([ids, alice]) => {
      const rgb = (hex) => `rgb(${[1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)).join(', ')})`;
      const col = rgb(window.__ct.view().players[alice].color);
      return Object.fromEntries(ids.map((id) => {
        const li = document.querySelector(`#inspector li[data-id="${id}"]`), els = li ? [...li.querySelectorAll('*')] : [];
        return [id, { pic: els.some((e) => e.getBoundingClientRect().width >= 12 && e.getBoundingClientRect().height >= 12 && getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'), dot: els.some((e) => getComputedStyle(e).backgroundColor === col), back: els.some((e) => getComputedStyle(e).backgroundColor === 'rgb(71, 85, 105)') }];
      }));
    }, [K1, alice.pid]);
    ok(K1.every((id) => look[id].pic), `each row has a picture (${J(look)})`);
    ok(look[hidK1].back && !look[pegQ].back, 'the hidden one\'s is its back');
    ok(look[pegP].dot && K1.filter((id) => id !== pegP).every((id) => !look[id].dot), 'Alice\'s peg carries her coloured dot, the others none');
    // a tap selects that piece and shows its bar
    await bob.locator(`#inspector li[data-id="${pegQ}"]`).click();
    const s = await M.selected(bob), b = await M.bar(bob);
    ok(!(await insp(bob)) && J(s) === J([pegQ]) && b.on && b.btns.length > 1, `a click on the Q peg's row closes the list and selects it, with its bar (${J(s)}, ${J(b.btns)})`);
    await bob.keyboard.press('Escape');
    // a drag out of the list carries a piece
    await M.click(bob, await M.badge(bob, top, 'fanb'));
    I = await insp(bob);
    ok(I && I.rows.length === 4, '(the list again)');
    const li = await bob.locator(`#inspector li[data-id="${tokK1}"]`).boundingBox(), from = { x: li.x + li.width / 2, y: li.y + li.height / 2 };
    const to = await M.pt(bob, cell(5, 6).x, cell(5, 6).y), t0 = Date.now() - 5;
    let midOpen = null;
    await M.mouseDrag(bob, P3.steps(from, to, 16), { pause: 20, mid: async () => { midOpen = !!(await insp(bob)); } });
    ok(midOpen === false, 'pressing on the token\'s row and dragging closes the list');
    for (const p of [alice, bob, carol]) ok(await P.waitView(p, 'v.items[a.id] && Math.abs(v.items[a.id].x + 30 - a.x) < 0.5 && Math.abs(v.items[a.id].y + 30 - a.y) < 0.5', { id: tokK1, ...cell(5, 6) }), `${p.label}: the dragged token lands on the cell it was dropped on`);
    ok((await M.lines(alice, bob.pid, t0)).length === 1, `(one line in Bob's name: ${J(await M.lines(alice, bob.pid, t0))})`);
    its = await M.items(alice);
    ok([pegP, pegQ, hidK1].every((id) => its[id].x === (id === hidK1 ? SPOT.K1.x - 30 : SPOT.K1.x - 25)), '(the other three stayed on the crowded cell)');
  }

  // ===========================================================================
  section('6e. the inspector follows what it shows: a crowd that thins is redrawn, gone it closes; a stack removed, it closes');
  {
    const left = [pegP, pegQ, hidK1];
    const top = async () => bob.evaluate((ids) => ids.find((id) => document.querySelector(`.item[data-id="${id}"] > .fanb`)), left);
    await M.click(bob, await M.badge(bob, await top(), 'fanb'));
    let I = await insp(bob);
    ok(I && I.rows.length === 3, `(Bob lists the crowd's three: ${J(I?.rows.map((r) => r.text))})`);
    // Alice drags pieces off the crowded cell, one at a time
    const away = async (c) => {
      const before = await M.items(alice), from = await M.centre(alice, Object.keys(before).find((id) => left.includes(id) && Math.abs(before[id].x + (before[id].t?.endsWith('/peg') ? 25 : 30) - SPOT.K1.x) < 1));
      await M.mouseDrag(alice, P3.steps(from, await M.pt(alice, c.x, c.y), 10), { pause: 20 });
      await P.waitView(bob, 'Object.values(v.items).filter((it) => Math.abs(it.x + (it.t?.endsWith("/peg") ? 25 : 30) - a.x) < 1 && Math.abs(it.y + (it.t?.endsWith("/peg") ? 25 : 30) - a.y) < 1).length === a.n', { ...SPOT.K1, n: left.length - (++gone) });
    };
    let gone = 0;
    await away(cell(0, 7));
    ok(await M.until(async () => (await insp(bob))?.rows.length === 2, 3000, 100), `a piece leaves the crowd: Bob's list is redrawn with two (${J((await insp(bob))?.rows.map((r) => r.text))})`);
    await away(cell(2, 7));
    ok(await M.until(async () => !(await insp(bob)), 3000, 100), 'one more leaves, and no crowd is left: the list closes');
    // a stack that goes away under it
    await M.click(bob, await M.badge(bob, S5, 'count'));
    ok(/\b3\b/.test((await insp(bob))?.text || ''), '(Bob inspects the ×3 on the plot\'s corner)');
    await M.click(alice, await M.centre(alice, S5));
    await M.barPress(alice, '🗑');
    ok(await P.waitView(bob, '!v.items[a]', S5), '(Alice removes that stack)');
    ok(await M.until(async () => !(await insp(bob)), 3000, 100), 'the stack is gone: Bob\'s inspector closes');
  }

  // ===========================================================================
  section('6f. on an iPhone 13 (Carol, upright): a long press opens it; Take k by taps; an outside tap closes it; a crowd\'s list');
  {
    const c3 = await M.centre(carol, S3);
    ok((await M.hit(carol, c3)) === S3, '(the ×4 stack is under Carol\'s finger)');
    await M.longPress(carol, c3, 800);
    let I = await insp(carol);
    const peek = await carol.evaluate(() => { const e = document.getElementById('peek'); return !!e && !e.classList.contains('hidden') && e.getClientRects().length > 0; });
    ok(I && /\b4\b/.test(I.text) && !peek, `a long press on the ×4 stack opens the inspector, not the zoom (“${I?.text.trim()}”)`);
    ok(I && (await M.inViewport(carol, I.box)), `on the screen (${J(I?.box)})`);
    ok(I && I.btns.every((b) => b.h >= 44), `finger-sized buttons (${J(I?.btns.map((b) => `${b.text} ${b.h.toFixed(0)}`))})`);
    await insPress(carol, PLUS);
    I = await insp(carol);
    ok(I.k === 2 && I.take === 'Take 2', `a tap on + makes it Take 2 ("${I.take}")`);
    const before = await M.items(alice);
    await insPress(carol, /^Take 2$/);
    ok(await P.waitView(alice, 'v.items[a].n === 2', S3), 'Take 2 leaves ×2');
    const after = await M.items(alice), fresh = Object.keys(after).filter((id) => !before[id]);
    ok(fresh.length === 1 && after[fresh[0]].n === 2, '(and a new ×2 beside it)');
    const out = await M.pt(carol, 1700, 1300);
    ok((await M.hit(carol, out)) === 'table', '(a felt point away from it)');
    await M.tap(carol, out);
    ok(!(await insp(carol)), 'a tap outside closes it');
    // a tap on a ×N badge opens it too
    await M.tap(carol, await M.badge(carol, S4, 'count'));
    ok(/\b5\b/.test((await insp(carol))?.text || ''), 'a tap on a ×N badge opens it');
    await M.tap(carol, out);
    // the crowd of three pegs
    const top = await carol.evaluate((ids) => ids.find((id) => document.querySelector(`.item[data-id="${id}"] > .fanb`)), K2);
    await M.tap(carol, await M.badge(carol, top, 'fanb'));
    I = await insp(carol);
    ok(I && I.rows.length === 3 && J(I.rows.map((r) => r.id).sort()) === J([...K2].sort()), `a tap on the crowd's ×3 lists its pegs (${I?.rows.length})`);
    ok(I && (await M.inViewport(carol, I.box)), '(on the screen)');
    const pick = K2.find((id) => id !== top);
    await carol.locator(`#inspector li[data-id="${pick}"]`).tap();
    await h.sleep(200);
    const s = await M.selected(carol), b = await M.bar(carol);
    ok(!(await insp(carol)) && J(s) === J([pick]) && b.on && (await M.inViewport(carol, b.box)), `a tap on a row selects that peg, with its bar on the screen (${J(s)})`);
    await M.shot(carol, 'p4m-iphone-inspector');
    await M.tap(carol, out);
  }

  // ===========================================================================
  section('6g. on an iPhone 13 held sideways (Dave): the inspector and the group bar fit the short screen');
  {
    const c4 = await M.centre(dave, S4);
    ok((await M.hit(dave, c4)) === S4, '(the ×5 stack is under Dave\'s finger)');
    await M.longPress(dave, c4, 800);
    let I = await insp(dave);
    ok(I && /\b5\b/.test(I.text) && (await M.inViewport(dave, I.box)), `a long press opens the inspector, wholly on the ${await dave.evaluate(() => `${innerWidth} × ${innerHeight}`)} screen (${J(I?.box)})`);
    await insPress(dave, /^Take 1$/);
    ok(await P.waitView(alice, 'v.items[a].n === 4', S4), 'Take 1 by a tap: ×4');
    await M.shot(dave, 'p4m-iphone-land-inspector');
    const out = await M.pt(dave, 1700, 1300);
    await M.tap(dave, out);
    ok(!(await insp(dave)), '(closed by a tap outside)');
    // ⬚ and a one-finger band over his three tokens
    const three = [8, 9, 10].map((c) => at(cell(c, 7)));
    await M.tap(dave, (await M.selMode(dave)).box);
    const a = await M.pt(dave, cell(8, 7).x - 70, cell(8, 7).y - 45), z = await M.pt(dave, cell(10, 7).x + 70, cell(10, 7).y + 45);
    await M.fingerDrag(dave, P3.steps(a, z, 10));
    const s = await M.selected(dave), b = await M.bar(dave);
    ok(J(s) === J([...three].sort()) && b.on && (await M.inViewport(dave, b.box)), `⬚ and a one-finger band pick the three; the group bar fits the screen (${s.length}, ${J(b.box)})`);
    await M.shot(dave, 'p4m-iphone-land-group');
    await M.barPress(dave, '✕');
    ok(!(await M.selected(dave)).length, '✕ clears them');
    await M.tap(dave, (await M.selMode(dave)).box);
  }

  await env.done();
})().catch(h.crash);
