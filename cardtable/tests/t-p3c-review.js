// Phase 3C review fix-ups on real screens (D167–D175). Alice hosts on a
// desktop; Bob plays on an iPhone 13 (a finger), upright and then sideways.
//  1. The 📜 dialog starts chess, go and reversi as 🎲 does (D169): over
//     another game, Enable asks to clear the table first — kept, nothing
//     changes and the dialog stays open; agreed, the new game's board is
//     the only one, and a stone plays on its centre point.
//  2. A finger's reach (D170): on go 19 × 19 the bowl is drawn 16 px wide on
//     an upright phone; a press 12 px from its centre takes a stone (it
//     panned the view before), and a press on bare felt far from it still pans.
//  3. The ask panel (D155): ▾ never takes a row of its own; a question asked
//     again under the same id answers at once (not after 3 s).
//  4. A phone held sideways, an ask open, the hand bar shown, a six-line
//     t.secret (D171): the 🔒 card's head stays on screen, below the
//     toolbar, and folds the card.
//  5. An edited demo (D173): chess's text with a comment line added, from
//     the 📜 dialog over a card game, asks first too — kept, nothing changes;
//     agreed, the table and the hands are cleared and the edited chess runs.
//     Reset ticked on the running chess asks again.
//  6. Playwright's iPhone 13 held sideways (750 × 342, the browser's bars
//     shown), an ask open, the hand bar shown, a secret and four buttons on
//     two rows (D174): the 🔒 card's frame holds its head, which is tappable;
//     the buttons scroll (a swipe brings the second row), and nothing
//     reaches the ask panel.
// Screenshots: shots/p3c-*.png.
'use strict';
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const S = require('./p3-lib');
const G = require('./stones-lib');
const { shot } = require('./fun-lib');

const J = JSON.stringify;

/** The rect of `sel` on page p (client px), or null. */
const rect = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, sel);

(async () => {
  const env = await h.start();
  /** A player in their own context (`ctx`: a device) with p3-lib's actTap (window.__acts) and stones-lib's record. */
  async function join(name, url, ctx) {
    const p = await env.page(name, ctx && { ctx });
    await p.addInitScript(S.actTap);
    await p.goto(url);
    await h.joinAs(p, name);
    await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
    p.pid = await p.evaluate(() => localStorage.getItem('ct-pid'));
    await G.record(p);
    return p;
  }
  const alice = await join('Alice', env.url);
  const bob = await join('Bob', alice.url(), P.PHONE);
  const both = [alice, bob];
  /** The page of the player sitting in seat `seat`, as Alice's view has it. */
  const seated = async (seat) => { const q = await P.viewOf(alice, 'Object.keys(v.players).find((p) => v.players[p].seatId === a)', seat); return both.find((x) => x.pid === q); };
  /** The id of the supply owned by seat `seat`. */
  const bowlOf = (seat) => P.viewOf(alice, "Object.keys(v.items).find((id) => v.items[id].k === 's' && v.items[id].owner === 'seat:' + a)", seat);

  /** Opens the 📜 dialog — on template `k` when given, its text then prefixed
   *  with `edit`, Reset ticked when `reset` — and presses Enable, answering its
   *  confirm `yes` or not: the confirm's text, or null. A kept table leaves
   *  the dialog open (the caller closes it). */
  async function dialogEnable(k, yes, { edit, reset } = {}) {
    let asked = null;
    const answer = (d) => { asked = d.message(); (yes ? d.accept() : d.dismiss()).catch((err) => console.error('confirm failed', err)); };
    alice.on('dialog', answer);
    try {
      await alice.click('#rules-btn');
      await alice.waitForSelector('#rules-dialog[open]');
      if (k) await alice.selectOption('#rules-tpl', k);
      if (edit) await alice.evaluate((e) => { const el = document.getElementById('rules-code'); el.value = e + el.value; }, edit);
      if (reset) await alice.check('#rules-reset');
      await alice.click('#rules-enable');
      await alice.waitForFunction((y) => (y ? !document.querySelector('#rules-dialog[open]') : document.getElementById('rules-enable').textContent === 'Enable'), yes, { timeout: 20000 });
    } finally { alice.off('dialog', answer); }
    return asked;
  }

  section('1. The 📜 dialog starts a game that lays out the whole table as 🎲 does: over another game, only once the host agrees to clear it (D169)');
  {
    await G.pickGame(alice, 'chess');
    ok(await P.waitView(alice, "v.rules?.name === 'Chess' && Object.values(v.items).filter((it) => it.at).length === 32", null, 30000), 'chess from 🎲: 32 pieces on the board');
    const kept = await dialogEnable('go9', false);
    ok(/Clear the table and set up Go 9 × 9\?/.test(kept || ''), `Go 9 × 9 from the 📜 dialog over chess asks first ("${kept}")`);
    await h.sleep(800);
    ok(await alice.evaluate(() => !!document.querySelector('#rules-dialog[open]')) && await P.viewOf(alice, "v.rules?.name === 'Chess' && Object.values(v.items).filter((it) => it.at).length === 32"),
      'the host keeps the table: still chess, 32 pieces, the dialog open');
    await alice.evaluate(() => document.getElementById('rules-dialog').close());
    const asked = await dialogEnable('go9', true);
    ok(!!asked, `asked again ("${asked}"), the host agrees`);
    ok(await G.everywhere(both, "v.rules?.name === 'Go 9 × 9' && Object.values(v.items).filter((it) => it.t?.endsWith('/board')).length === 1 && !Object.values(v.items).some((it) => it.k === 'g' && it.at) && Object.values(v.items).filter((it) => it.k === 's').length === 2", null, 30000),
      'on both screens: the go board alone (the chess board and pieces gone), its two bowls, no stone');
    const black = await seated('black'), bowl = await bowlOf('black'), t0 = await G.mark(black);
    await G.place(black, bowl, 'E5', black === bob);
    ok(await G.everywhere(both, "Object.values(v.items).some((it) => it.k === 'g' && it.at === 'E5')", null, 10000), `Black (${black === bob ? 'Bob' : 'Alice'}) plays the centre point E5: a stone there on both screens`);
    ok(!(await G.seen(black, 'toast', t0)).some((x) => /🚫/.test(x)), `no refusal (${J(await G.seen(black, 'toast', t0))})`);
    await shot(alice, 'p3c-dialog-go-desk');
  }

  section('2. A finger\'s reach (D170): go 19 × 19\'s bowl, 16 px wide on an upright phone, is taken by a press 14 px off its centre, and from its own corner by its centre; bare felt far from it still pans');
  {
    await G.pickGame(alice, 'go19');
    ok(await G.everywhere(both, "v.rules?.name === 'Go 19 × 19' && Object.values(v.items).filter((it) => it.k === 's').length === 2", null, 30000), 'Go 19 × 19 from 🎲');
    const seat = (await seated('black')) === bob ? 'black' : 'white';
    if (seat === 'white') { // (Black — Alice — plays first: Bob's own turn comes next)
      const r = await alice.evaluate((a) => { const c = window.__ct.resolve('A1'), v = window.__ct.view(), s = v.items[a]; const T = window.__ct.boxes()[s.t.split('/')[0]].types[s.t.split('/')[1]]; return window.__ct.act({ t: 'take', id: a, x: c.x - T.w / 2, y: c.y - T.w / 2 }); }, await bowlOf('black'));
      ok(r.ok && await P.waitView(bob, "v.rules.public.turn === me", null, 10000), '(Alice, Black, plays A1: Bob\'s turn)');
    }
    await bob.click('#view-btn');
    const bowl = await bowlOf(seat), box = await bob.evaluate((id) => { const r = document.querySelector(`.item[data-id="${id}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; }, bowl);
    ok(box.w < 30, `Bob's bowl is drawn ${box.w.toFixed(1)} px wide on his phone (well under a finger)`);
    const press = { x: box.x - 10, y: box.y - 10 }; // (14 px off its centre, on bare felt — clear of the bowl's own box, whatever an engine's hit-test rounds)
    const tf0 = await P.tf(bob), n0 = await bob.evaluate(() => window.__acts.length), to = await bob.evaluate(() => window.__ct.resolve('K10'));
    const end = await S.screenOf(bob, to.x, to.y);
    await S.gesture(bob, [press, ...S.steps(press, end, 12, 16).slice(1), { ...end, wait: 120 }], { touch: true });
    ok(await P.waitView(alice, "Object.values(v.items).some((it) => it.k === 'g' && it.at === 'K10')", null, 10000), 'the press 14 px off the bowl took a stone, played on K10 (both screens)');
    const tf1 = await P.tf(bob);
    ok(Math.hypot(tf1.px - tf0.px, tf1.py - tf0.py) < 1, `and the view did not pan (${J([tf0, tf1])})`);
    const sent = await bob.evaluate((n) => window.__acts.slice(n).map((x) => x.a.t), n0);
    ok(sent.includes('take'), `Bob's tab sent a take (${J(sent)})`);
    const far = { x: box.x - 60, y: box.y - 60 }, n1 = await bob.evaluate(() => window.__acts.length);
    await S.gesture(bob, [far, ...S.steps(far, { x: far.x + 40, y: far.y - 40 }, 6, 16).slice(1)], { touch: true });
    const tf2 = await P.tf(bob), sent2 = await bob.evaluate((n) => window.__acts.slice(n).map((x) => x.a.t), n1);
    ok(Math.hypot(tf2.px - tf1.px, tf2.py - tf1.py) > 20 && !sent2.includes('take'), `a press 85 px off it pans the view, as ever, and takes nothing (${J(sent2)})`);
    // A touch right on the bowl's own corner (a direct hit, dispatched to the bowl so that no engine's hit-test decides it):
    // the new stone is held by its centre, as nearTouch's is — by its corner it hung off the finger and missed the point (D206)
    const other = await bowlOf(seat === 'black' ? 'white' : 'black');
    await alice.evaluate((a) => { const c = window.__ct.resolve('T19'), s = window.__ct.view().items[a], T = window.__ct.boxes()[s.t.split('/')[0]].types[s.t.split('/')[1]]; return window.__ct.act({ t: 'take', id: a, x: c.x - T.w / 2, y: c.y - T.w / 2 }); }, other);
    ok(await P.waitView(bob, "v.rules.public.turn === me", null, 10000), "(Alice plays T19: Bob's turn again)");
    const k12 = await bob.evaluate(() => window.__ct.resolve('K12')), end2 = await S.screenOf(bob, k12.x, k12.y);
    await bob.evaluate(async ({ id, end }) => {
      const el = document.querySelector(`.item[data-id="${id}"]`), r = el.getBoundingClientRect(), from = { x: r.left + 1, y: r.top + 1 };
      const ev = (type, pt, target) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: pt.x, clientY: pt.y }));
      ev('pointerdown', from, el);
      for (let k = 1; k <= 12; k++) { ev('pointermove', { x: from.x + ((end.x - from.x) * k) / 12, y: from.y + ((end.y - from.y) * k) / 12 }, window); await new Promise((res) => setTimeout(res, 16)); }
      await new Promise((res) => setTimeout(res, 120));
      ev('pointerup', end, window);
    }, { id: bowl, end: end2 });
    ok(await P.waitView(alice, "Object.values(v.items).some((it) => it.k === 'g' && it.at === 'K12')", null, 10000), "a touch on the bowl's own corner: its stone lands where the finger ends (K12), held by its centre");
    await shot(bob, 'p3c-go19-reach-phone');
  }

  section('3. The ask panel: ▾ never takes a row of its own; the same question asked again answers at once (D155)');
  {
    const ASKER = `({ name: 'Asker',
      buttons: (t) => [{ id: 'ask', label: 'Ask me' }],
      onButton(t, id, p) { t.data.n = 1; t.ask(p, { id: 'q', prompt: 'Round 1: which way?', options: ['Left', 'Right'] }); },
      onAnswer(t, p, id, v) { t.data.n++; if (t.data.n <= 3) t.ask(p, { id: 'q', prompt: 'Round ' + t.data.n + ': which way?', options: ['Left', 'Right'] }); },
    })`;
    await h.enableRules(alice, { code: ASKER });
    ok(await P.waitView(bob, "v.rules?.name === 'Asker'", null, 15000), 'a script that asks the same question three times');
    await bob.locator('#rules-btns button:has-text("Ask me")').tap();
    ok(await bob.waitForFunction(() => /Round 1/.test(document.getElementById('ask-prompt').textContent), null, { timeout: 10000 }).then(() => true, () => false), 'Bob is asked "Round 1"');
    const lay = await bob.evaluate(() => {
      const r = (el) => el.getBoundingClientRect(), min = r(document.getElementById('ask-min'));
      const others = ['ask-head', 'ask-body'].map((id) => r(document.getElementById(id)));
      return { min: { t: min.top, b: min.bottom, l: min.left }, lowest: Math.max(...others.map((x) => x.bottom)), right: Math.max(...others.map((x) => x.right)), card: r(document.getElementById('ask-card')).height };
    });
    ok(lay.min.t < lay.lowest && lay.min.l >= lay.right - 0.5, `▾ sits at the card's right, beside its rows, never on a row of its own (${J(lay)})`);
    await shot(bob, 'p3c-ask-phone');
    for (const round of [2, 3]) {
      const t0 = Date.now();
      await bob.locator('#ask-body button[data-k="0"]').tap();
      const live = await bob.waitForFunction((n) => document.getElementById('ask-prompt').textContent.includes(`Round ${n}`) && !document.querySelector('#ask-body button[data-k="0"]').disabled, round, { timeout: 2500, polling: 20 }).then(() => true, () => false);
      ok(live, `Bob answers; "Round ${round}", asked under the same id, shows with its buttons working ${live ? `after ${Date.now() - t0} ms` : 'only after 2.5 s or more'}`);
    }
    await bob.locator('#ask-body button[data-k="1"]').tap();
    ok(await bob.waitForFunction(() => document.getElementById('ask').classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false), '(the third answer: no more questions)');
  }

  section('4. A phone held sideways, an ask open, the hand bar shown, a six-line secret: the 🔒 card\'s head stays on screen and folds it (D171)');
  {
    const SECRET = `({ name: 'Secret',
      setup(t) { t.addStandardDeck({ x: 60, y: 60 }); },
      buttons: (t) => [{ id: 'go', label: 'Deal me in' }],
      onButton(t, id, p) {
        t.draw(p, t.piles()[0].id, 3);
        t.secret[p] = { text: 'You are the spy.\\nYour contact wears red.\\nYour target is the vault.\\nSay nothing until the third round.\\nThen move, and trust nobody at the table — not even the host, who may be the other spy.' };
        t.ask(p, { id: 'plan', prompt: 'Which plan do you follow tonight, now that the guards have changed their rounds?', options: ['The roof', 'The cellar', 'The front door'] });
      },
    })`;
    await h.enableRules(alice, { code: SECRET });
    ok(await P.waitView(bob, "v.rules?.name === 'Secret'", null, 15000), 'a script that deals, tells a secret and asks');
    await bob.locator('#rules-btns button:has-text("Deal me in")').tap();
    ok(await bob.waitForFunction(() => !document.getElementById('secret').classList.contains('hidden') && !document.getElementById('ask').classList.contains('hidden') && document.querySelectorAll('#hand .hcard').length === 3, null, { timeout: 10000 }).then(() => true, () => false),
      'Bob: three cards in his hand, the 🔒 card and the question open');
    await bob.setViewportSize({ width: 844, height: 390 }); // (Bob turns his phone sideways)
    await h.sleep(700);
    const [head, bar, row] = await Promise.all([rect(bob, '#secret-head'), rect(bob, '#toolbar'), rect(bob, '#rules-row')]);
    ok(head && head.t >= bar.b - 0.5 && head.b <= 390 && row.t >= bar.b - 0.5, `the 🔒 card's head is on screen, below the toolbar (head ${J(head)}, toolbar bottom ${bar.b}, row top ${row.t})`);
    const hit = await bob.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [head.l + head.w / 2, head.t + head.h / 2]);
    ok(hit === 'secret-head', `nothing covers it: a tap there reaches it (${hit})`);
    await shot(bob, 'p3c-secret-sideways-phone');
    await bob.tap('#secret-head');
    ok(await bob.evaluate(() => document.getElementById('secret').classList.contains('shut')), 'a tap on it folds the card');
    await bob.tap('#secret-head');
    const text = await rect(bob, '#secret-text');
    ok(await bob.evaluate(() => !document.getElementById('secret').classList.contains('shut')) && text.t >= bar.b - 0.5, `another opens it again, its text below the head, scrolling in the room left (${J(text)})`);
  }

  section('5. An edited demo from the 📜 dialog asks first too: the table and the hands are cleared only once the host agrees; Reset ticked on the running game asks again (D173)');
  {
    const EDIT = "// my club's chess\n";
    const before = await P.viewOf(alice, "({ piles: Object.values(v.items).filter((it) => it.k === 'p').length, n: Object.keys(v.items).length })");
    ok(before.piles >= 1 && await P.viewOf(bob, 'v.hand.length === 3'), `the card game of section 4 is on the table (${J(before)}), three cards in Bob's hand`);
    const kept = await dialogEnable('chess', false, { edit: EDIT });
    ok(/Clear the table and set up Chess\?/.test(kept || ''), `chess's text with a comment line added asks first ("${kept}")`);
    await h.sleep(800);
    ok(await alice.evaluate(() => !!document.querySelector('#rules-dialog[open]')) && await P.viewOf(alice, "v.rules?.name === 'Secret' && Object.keys(v.items).length === a", before.n) && await P.viewOf(bob, 'v.hand.length === 3'),
      'kept: still the card game, every item on the table, Bob\'s three cards, the dialog open');
    await alice.evaluate(() => document.getElementById('rules-dialog').close());
    ok(!!await dialogEnable('chess', true, { edit: EDIT }), 'asked again, the host agrees');
    ok(await G.everywhere(both, "v.rules?.name === 'Chess' && Object.keys(v.items).length === 33 && Object.values(v.items).filter((it) => it.at).length === 32 && !v.hand.length", null, 30000),
      'on both screens: chess, its board and 32 pieces alone, no card in any hand');
    const lines = await P.viewOf(alice, 'v.log.map((e) => e.txt)');
    await bob.click('#rules-btn'); // (a guest's 📜 dialog shows the script the host runs)
    const runs = await bob.evaluate(() => document.getElementById('rules-code').value);
    await bob.evaluate(() => document.getElementById('rules-dialog').close());
    ok(lines.some((x) => /^cleared the table \(\d+ items, 3 cards from hands\)$/.test(x)) && runs.startsWith(EDIT),
      `the table cleared, Bob's cards with it ("${lines.findLast((x) => /^cleared/.test(x))}"), and the edited text is what runs (${J(runs.slice(0, 30))}…)`);
    const n0 = lines.filter((x) => /^cleared the table/.test(x)).length;
    const again = await dialogEnable(null, false, { reset: true });
    ok(/Clear the table and set up Chess\?/.test(again || ''), `Reset ticked on the running chess asks too ("${again}")`);
    await alice.evaluate(() => document.getElementById('rules-dialog').close());
    ok(!!await dialogEnable(null, true, { reset: true }) && await P.waitView(alice, "v.log.filter((e) => /^cleared the table/.test(e.txt)).length === a + 1 && v.rules?.name === 'Chess' && Object.values(v.items).filter((it) => it.at).length === 32", n0, 30000),
      'agreed: a fresh chess on a cleared table');
  }

  section('6. Playwright\'s iPhone 13 held sideways (750 × 342: the browser\'s bars shown), an ask open, the hand bar shown, a secret and four buttons on two rows: the 🔒 card holds its head, on screen and tappable; the buttons scroll (D174)');
  {
    const SQUEEZE = `({ name: 'Squeeze',
      setup(t) { t.addStandardDeck({ x: 60, y: 60 }); },
      buttons: (t) => ['Deal me in', 'Bid two clubs', 'Pass the turn', 'Show my hand'].map((label, i) => ({ id: 'b' + i, label })),
      onButton(t, id, p) {
        if (id === 'b3') t.say('A hand is shown');
        if (id !== 'b0') return;
        t.draw(p, t.piles()[0].id, 3);
        t.secret[p] = { text: 'You are the spy.\\nYour contact wears red.\\nYour target: Carol.' };
        t.ask(p, { id: 'plan', prompt: 'Which plan do you follow tonight, now that the guards have changed their rounds and the dogs are loose?', options: ['The roof', 'The cellar', 'The front door', 'Wait it out'] });
      },
    })`;
    await h.enableRules(alice, { code: SQUEEZE });
    ok(await P.waitView(bob, "v.rules?.name === 'Squeeze'", null, 15000), 'a script with four buttons that deals, tells a secret and asks');
    await bob.setViewportSize({ width: 390, height: 664 });
    await h.sleep(500);
    await bob.locator('#rules-btns button:has-text("Deal me in")').tap();
    ok(await bob.waitForFunction(() => !document.getElementById('secret').classList.contains('hidden') && !document.getElementById('ask').classList.contains('hidden') && document.querySelectorAll('#hand .hcard').length === 3, null, { timeout: 10000 }).then(() => true, () => false),
      'Bob: three cards, the 🔒 card and the question open');
    await bob.setViewportSize({ width: 750, height: 342 }); // (sideways, the browser's bars shown)
    await h.sleep(900);
    const m = await bob.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; }, $ = (id) => document.getElementById(id);
      const head = r($('secret-head')), card = r($('secret')), btns = $('rules-btns'), first = r(btns.firstElementChild), at = (x, y) => document.elementFromPoint(x, y);
      return { bar: r($('toolbar')).b, ask: r($('ask')).t, head, card, box: r(btns), first, over: btns.scrollHeight - btns.clientHeight,
        headHit: at((head.l + head.r) / 2, (head.t + head.b) / 2)?.id, below: !!at((card.l + card.r) / 2, card.b + 2)?.closest('#secret') };
    });
    ok(m.head.t >= m.card.t - 0.5 && m.head.b <= m.card.b + 0.5 && m.head.t >= m.bar - 0.5, `the card's frame holds its head, below the toolbar (head ${J(m.head)}, card ${J(m.card)}, toolbar bottom ${m.bar})`);
    ok(m.headHit === 'secret-head' && !m.below, `nothing covers the head (${m.headHit}), and nothing of the card shows below its frame`);
    ok(m.box.t >= m.card.b && m.box.b <= m.ask + 0.5, `the buttons stay between the card and the ask panel (box ${J(m.box)}, ask top ${m.ask})`);
    ok(m.over > 10 && m.first.t >= m.box.t && m.first.b <= m.box.b + 0.5, `they scroll (${m.over} px more), the first row in full view (${J(m.first)})`);
    await shot(bob, 'p3c-squeeze-sideways-phone');
    const mid = { x: (m.box.l + m.box.r) / 2, y: m.box.b - 6 };
    await S.gesture(bob, [mid, ...S.steps(mid, { x: mid.x, y: mid.y - 60 }, 10, 16).slice(1), { x: mid.x, y: mid.y - 60, wait: 300 }], { touch: true });
    const shown = await bob.evaluate(() => { const b = document.getElementById('rules-btns'), x = b.lastElementChild.getBoundingClientRect(); return { top: b.scrollTop, hit: document.elementFromPoint((x.left + x.right) / 2, (x.top + x.bottom) / 2) === b.lastElementChild }; });
    ok(shown.top > 0 && shown.hit, `a swipe up scrolls the buttons: "Show my hand" in full view (${J(shown)})`);
    await bob.locator('#rules-btns button:has-text("Show my hand")').tap();
    ok(await P.waitView(alice, "v.log.some((e) => e.txt === 'A hand is shown')", null, 10000), 'and a tap on it presses it');
    await bob.tap('#secret-head');
    ok(await bob.evaluate(() => document.getElementById('secret').classList.contains('shut')), 'a tap on the 🔒 head folds the card');
  }

  await env.done();
})().catch(h.crash);
