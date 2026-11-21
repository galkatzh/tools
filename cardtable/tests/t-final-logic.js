// Final review, template logic through the Node facade port (final-lib table()):
// Bridge publishes the declarer as the actor on the dummy's turn (INT-2/PT-4),
// keeps another deck's cards out of its deal (QUAL-1) and tells refusals
// (PT-8); Hold'em gathers only its own deck, face down (PT-2, PT-3), gives a
// dropped player a grace period (PT-5), Rebuy buttons (PT-10), told
// refusals (PT-8), and keeps the deck closed to peeks (SEC-F4).
const h = require('./h');
const { ok, section } = h;
const { table } = require('./final-lib');

/** Runs one scenario; a throw is a failed check, not the end of the suite. */
function guard(fn) { try { fn(); } catch (e) { ok(false, 'scenario crashed: ' + e.stack); } }
const allStd = (m, p) => m.host.players[p].hand.every((c) => c.d === 'std');

(async () => {
  const env = await h.start();

  section('Bridge: Deal sets another deck\'s cards aside (QUAL-1), refusals are told (PT-8)');
  guard(() => {
    const m = table('bridge', ['A', 'B', 'C', 'D']);
    m.foreign('B', 'blue', 1); // Bob drew a card of a second deck before the game
    m.btn('C', 'deal');
    const held = ['A', 'B', 'C', 'D'].map((p) => m.host.players[p].hand);
    ok(held.every((hd) => hd.length === 13) && ['A', 'B', 'C', 'D'].every((p) => allStd(m, p)), 'everyone holds 13 cards of the Bridge deck');
    ok(new Set(held.flat().map((c) => c.i)).size === 52, 'all 52 are dealt (none left behind for a foreign card)');
    const aside = Object.values(m.host.items).find((it) => it.name === 'Set aside');
    ok(aside && aside.cards.length === 1 && aside.cards[0].d === 'blue', 'the foreign card waits on a "Set aside" pile');
    m.btn('C', 'deal'); // (the button is gone mid-hand: nothing happens)
    m.script.onButton(m.t, 'deal', 'C'); // a stale press
    ok(/Finish the hand first/.test(m.lastTell('C')), `a Deal mid-hand is told to the presser ("${m.lastTell('C')}")`);
  });
  guard(() => {
    const m = table('bridge', ['A', 'B', 'C', 'D']);
    m.host.players.D.online = false;
    m.btn('B', 'deal');
    ok(m.log.some((x) => x.startsWith('📣 Bridge deals to exactly 4 online players (3 online)')), 'Deal with 3 online is announced on every screen, not just logged');
  });

  section('Bridge: on the dummy\'s turn the table waits on the declarer (INT-2/PT-4)');
  guard(() => {
    const m = table('bridge', ['A', 'B', 'C', 'D']);
    m.btn('A', 'deal');
    m.chat('A', '!contract 2NT B'); // the host sets it: B declares, D is the dummy, C leads
    const d = m.d();
    ok(d.declarer === 'B' && d.dummy === 'D' && m.pub().turn === 'C', `C leads (turn ${m.pub().turn})`);
    ok(m.pub().badges?.D === '🃏 dummy', "the dummy's seat is badged");
    const play = (p) => {
      const c = m.host.players[p].hand[0];
      m.t.playFromHand(p, 0, { up: true });
      m.script.onAction(m.t, { t: 'play', p, d: c.d, i: c.i, up: true });
    };
    play('C');
    ok(d.turn === 'D' && m.pub().turn === 'B', `the dummy's card is due (data.turn ${d.turn}) and ⏳ goes to the declarer (public.turn ${m.pub().turn})`);
    // the declarer slides a dummy card into the middle
    const ref = d.dummyCards[0], it = Object.entries(m.host.items).find(([, x]) => x.k === 'c' && x.d === ref.d && x.i === ref.i);
    const g = m.t.geom();
    m.t.move(it[0], g.cx - 50, g.cy - 70);
    m.script.onAction(m.t, { t: 'move', p: 'B', id: it[0], x: g.cx - 50, y: g.cy - 70 });
    ok(d.turn === 'A' && m.pub().turn === 'A', `then the next defender (${m.pub().turn})`);
  });

  section("Hold'em: New hand gathers only its own deck, face down (PT-2, PT-3)");
  guard(() => {
    const m = table('holdem', ['A', 'B', 'C']);
    m.foreign('A', 'cah', 10); // a previous game's ten white cards
    m.t.newPile(Array.from({ length: 60 }, (_, i) => ({ d: 'cah', i: 100 + i })), { name: 'White deck' }); // bigger than 52
    m.btn('A', 'new');
    ok(['A', 'B', 'C'].every((p) => m.host.players[p].hand.length === 2 && allStd(m, p)), 'everyone is dealt 2 standard hole cards');
    const piles = Object.values(m.host.items).filter((x) => x.k === 'p');
    ok(piles.find((x) => x.name === 'White deck').cards.length === 60, "another game's pile is left alone (not taken for the deck)");
    const aside = piles.find((x) => x.name === 'Set aside');
    ok(aside && aside.cards.length === 10 && aside.cards.every((c) => c.d === 'cah'), "A's white cards wait on a \"Set aside\" pile");
    ok(m.d().turn && m.script.contenders(m.t).length === 3, 'all three are in the hand');
  });
  guard(() => {
    const m = table('holdem', ['A', 'B']);
    let faceUp = 0;
    for (let k = 0; k < 6; k++) {
      m.btn('A', 'new');
      const deck = m.script.deck(m.t);
      faceUp += deck.cards.filter((c) => c.up).length;
      for (let s = 0; s < 40 && m.d().stage === 'hand' && m.d().turn; s++) {
        const b = m.buttons().find((x) => x.pid === m.d().turn && (x.id === 'check' || x.id === 'call'));
        m.btn(m.d().turn, b.id);
      }
      for (const p of ['A', 'B']) if (!(m.d().stacks[p] > 0)) m.chat(p, '!rebuy');
    }
    ok(faceUp === 0, `after each showdown the board and reveals go back FACE DOWN: no face-up card in the deck over 6 hands (${faceUp})`);
  });

  section("Hold'em: a dropped player has a grace period and is told (PT-5)");
  guard(() => {
    const m = table('holdem', ['A', 'B', 'C']);
    m.btn('A', 'new');
    const who = m.d().turn;
    m.script.onLeave(m.t, who);
    m.host.players[who].online = false;
    ok(!m.d().folded.includes(who) && m.log.some((x) => x.includes('folding in 20 s')), `${who} is not folded at once; the table is told why it waits`);
    m.host.players[who].online = true;
    m.script.onJoin(m.t, who);
    ok(/You're back — still in the hand/.test(m.lastTell(who)), `${who}, back in time, is told so`);
    m.expire();
    ok(!m.d().folded.includes(who) && m.d().turn === who, 'and the old timer does not fold them');
    m.script.onLeave(m.t, who);
    m.host.players[who].online = false;
    m.expire();
    ok(m.d().folded.includes(who), 'gone past the grace: folded');
    m.host.players[who].online = true;
    m.script.onJoin(m.t, who);
    ok(/folded: you left mid-hand/.test(m.lastTell(who)), `on return they learn why ("${m.lastTell(who)}")`);
  });

  section("Hold'em: Rebuy buttons for busted players (PT-10); refusals are told (PT-8)");
  guard(() => {
    const m = table('holdem', ['A', 'B', 'C']);
    m.d().stacks.B = 0;
    const rb = m.buttons().filter((b) => b.id.startsWith('rebuy'));
    ok(rb.length === 1 && rb[0].pid === 'B' && /Rebuy 1000/.test(rb[0].label), `between hands busted B (only) gets "${rb[0]?.label}"`);
    ok(!m.btn('A', 'rebuy:B'), 'nobody else can press it');
    m.btn('B', 'rebuy:B');
    ok(m.d().stacks.B === 1000 && !m.buttons().some((b) => b.id.startsWith('rebuy')), 'B rebuys to 1000 and the button goes');
    m.d().stacks.B = 0; m.d().stacks.C = 0;
    m.btn('C', 'new');
    ok(/Need 2\+ online players with chips/.test(m.lastTell('C')), `New hand without two funded players is told to the presser ("${m.lastTell('C')}")`);
    m.d().stacks.B = 1000;
    delete m.host.items.deck;
    m.btn('B', 'new');
    ok(/No deck/.test(m.lastTell('B')), 'and so is a missing deck');
  });

  section("Hold'em: the deck, muck and burns can't be peeked mid-hand (SEC-F4)");
  guard(() => {
    const m = table('holdem', ['A', 'B', 'C']);
    m.btn('A', 'new');
    m.btn(m.d().turn, 'fold'); // a muck
    const v = (id) => m.script.validate(m.t, { t: 'peek', p: 'B', id });
    ok(v(m.script.deck(m.t).id) && v(m.d().muckId), 'peeking at the deck or the muck is vetoed');
    m.d().stage = 'done';
    ok(!v(m.script.deck(m.t).id), 'between hands it is allowed');
  });

  await env.done();
})().catch(h.crash);
