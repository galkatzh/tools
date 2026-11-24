// Phase 3C review fix-ups on real screens (D167–D171). Alice hosts on a
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

  section('1. The 📜 dialog starts a game that lays out the whole table as 🎲 does: over another game, only once the host agrees to clear it (D169)');
  {
    await G.pickGame(alice, 'chess');
    ok(await P.waitView(alice, "v.rules?.name === 'Chess' && Object.values(v.items).filter((it) => it.at).length === 32", null, 30000), 'chess from 🎲: 32 pieces on the board');
    /** Picks template `k` in the 📜 dialog and presses Enable, answering its confirm `yes` or not: the confirm's text, or null. */
    async function dialogEnable(k, yes) {
      let asked = null;
      const answer = (d) => { asked = d.message(); (yes ? d.accept() : d.dismiss()).catch((err) => console.error('confirm failed', err)); };
      alice.on('dialog', answer);
      try {
        await alice.click('#rules-btn');
        await alice.waitForSelector('#rules-dialog[open]');
        await alice.selectOption('#rules-tpl', k);
        await alice.click('#rules-enable');
        await alice.waitForFunction((y) => (y ? !document.querySelector('#rules-dialog[open]') : document.getElementById('rules-enable').textContent === 'Enable'), yes, { timeout: 20000 });
      } finally { alice.off('dialog', answer); }
      return asked;
    }
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

  section('2. A finger\'s reach (D170): go 19 × 19\'s bowl, 16 px wide on an upright phone, is taken by a press 12 px off its centre; bare felt far from it still pans');
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
    const press = { x: box.x - 8.5, y: box.y - 8.5 }; // (12 px off its centre, on bare felt)
    const tf0 = await P.tf(bob), n0 = await bob.evaluate(() => window.__acts.length), to = await bob.evaluate(() => window.__ct.resolve('K10'));
    const end = await S.screenOf(bob, to.x, to.y);
    await S.gesture(bob, [press, ...S.steps(press, end, 12, 16).slice(1), { ...end, wait: 120 }], { touch: true });
    ok(await P.waitView(alice, "Object.values(v.items).some((it) => it.k === 'g' && it.at === 'K10')", null, 10000), 'the press 12 px off the bowl took a stone, played on K10 (both screens)');
    const tf1 = await P.tf(bob);
    ok(Math.hypot(tf1.px - tf0.px, tf1.py - tf0.py) < 1, `and the view did not pan (${J([tf0, tf1])})`);
    const sent = await bob.evaluate((n) => window.__acts.slice(n).map((x) => x.a.t), n0);
    ok(sent.includes('take'), `Bob's tab sent a take (${J(sent)})`);
    const far = { x: box.x - 60, y: box.y - 60 }, n1 = await bob.evaluate(() => window.__acts.length);
    await S.gesture(bob, [far, ...S.steps(far, { x: far.x + 40, y: far.y - 40 }, 6, 16).slice(1)], { touch: true });
    const tf2 = await P.tf(bob), sent2 = await bob.evaluate((n) => window.__acts.slice(n).map((x) => x.a.t), n1);
    ok(Math.hypot(tf2.px - tf1.px, tf2.py - tf1.py) > 20 && !sent2.includes('take'), `a press 85 px off it pans the view, as ever, and takes nothing (${J(sent2)})`);
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

  await env.done();
})().catch(h.crash);
