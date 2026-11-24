// Card Table — the shipped rules scripts (see ENGINE.md §5) and the 🎲 game
// picker's catalog. Each template is the source text of a script, exactly as
// the 📜 dialog shows it and the host's rules runner evaluates it.

/** The code version (see core.js MODULE_V): the same in every cardtable module. */
export const MODULE_V = 1;

export const RULES_TEMPLATES = {
  blank: `({
  name: 'My game',
  // Runs once when you enable the rules.
  setup(t) { t.say('Rules are on.'); },
  // Return a string to BLOCK a player's action. a = {t, p, ...}; a.p is the
  // acting player's id, a.t the action type ('play', 'draw', 'move', ...).
  validate(t, a) { },
  // React AFTER an action applies — automations go here.
  onAction(t, a) { },
  // Buttons shown under the table ({pid: playerId} restricts who sees one).
  buttons: (t) => [],
  onButton(t, id, byPid) { },
  onJoin(t, p) { }, onLeave(t, p) { },
  // t.schedule(seconds, tag) later fires onTimer(t, tag).
  onTimer(t, tag) { },
})`,
  turns: `({
  name: 'Turn order',
  setup(t) {
    const ps = t.players();
    t.data.turn ??= ps[0]?.id; // a re-enable keeps whose turn it is
    // never leave the turn with someone who is away (nextSeat skips offline seats)
    if (!ps.some((p) => p.id === t.data.turn && p.online)) t.data.turn = t.nextSeat(t.data.turn);
    t.public.turn = t.data.turn;
    t.say('Turn order: ' + ps.map((p) => p.name).join(' → '));
  },
  onLeave(t, p) { if (p === t.data.turn) this.passOn(t); },
  // After a host reload a turn holder who never comes back gets no onLeave:
  // whenever someone (re)joins, give an absent turn holder 10 s to return.
  onJoin(t) { t.schedule(10, 'away'); },
  onTimer(t) { if (!t.players().some((p) => p.id === t.data.turn && p.online)) this.passOn(t); },
  passOn(t) {
    t.data.turn = t.public.turn = t.nextSeat(t.data.turn);
    t.say('The turn passes on — its player left');
  },
  validate(t, a) {
    const guarded = ['play', 'handPile', 'deal', 'draw', 'toHand'];
    if (guarded.includes(a.t) && a.p !== t.data.turn) return "It's not your turn";
  },
  onAction(t, a) {
    if (a.t === 'play' || a.t === 'handPile') {
      t.data.turn = t.nextSeat(t.data.turn);
      t.public.turn = t.data.turn;
    }
  },
})`,
  holdem: `({
  name: "Hold'em (chips)",
  // Full no-limit Hold'em with chip tracking: stacks live on the seat labels
  // (💰), blinds post automatically (dealer button rotates), betting rounds
  // are turn-enforced. The player to act gets buttons — Check/Call, Fold and
  // quick bets (Min raise, ½ pot, Pot, All-in; each shows the round total it
  // raises TO) — or types in chat: "!bet 50" / "!raise 50" (raise TO 50),
  // "!allin", "!check", "!call", "!fold". A short all-in doesn't reopen the
  // raising for players who already acted. Streets deal themselves when a
  // round closes, all-ins run out automatically, and the showdown returns an
  // uncalled bet, evaluates best-5-of-7, builds side pots, and pays every pot
  // to the right hands (ties split, odd chips left of the button).
  // Only online players are dealt in; a player who drops mid-hand has 20 s
  // to come back before they are folded (unless they're all-in). Between
  // hands anyone may deal, a busted player gets a "💰 Rebuy" button (or types
  // "!rebuy") and the host sets the blinds ("!blinds 5 10"). Mid-hand only
  // the host can call the hand off (every bet refunded): Abandon, pressed twice.
  // New hand gathers only this game's deck; another deck's cards in a hand
  // (say, from a game played before) go onto a "Set aside" pile.
  BUYIN: 1000,
  AWAY: 20, // seconds a dropped player has to return
  setup(t) {
    t.data.stacks ||= {};
    t.data.blinds ||= { sb: 5, bb: 10 };
    t.data.burn ||= []; // (a hand dealt by an older version of this script lacks these)
    t.data.canRaise ||= [];
    for (const p of t.players()) t.data.stacks[p.id] ??= this.BUYIN;
    this.badges(t);
    t.say("Hold'em: everyone starts with 💰" + this.BUYIN + '. Press New hand.');
  },
  onJoin(t, p) {
    const d = t.data;
    d.stacks ||= {};
    d.stacks[p] ??= this.BUYIN;
    this.badges(t);
    if (d.away && d.away[p]) { delete d.away[p]; t.tell(p, "You're back — still in the hand"); }
    else if (d.stage === 'hand' && (d.awayFolded || []).includes(p)) t.tell(p, 'You were folded: you left mid-hand');
  },
  // A player who still has to act would stall the hand, but phones drop
  // out all the time (a reload, a locked screen): fold them only if they're
  // still gone after AWAY seconds. An all-in player has nothing left to
  // decide and stays in to the showdown.
  onLeave(t, p) {
    const d = t.data;
    if (d.stage !== 'hand' || !this.active(t).some((x) => x.id === p)) return;
    d.awayN = (d.awayN || 0) + 1;
    d.away = Object.assign({}, d.away, { [p]: d.awayN }); // only this absence's timer may fold them
    t.schedule(this.AWAY, 'away:' + p + ':' + d.awayN);
    t.announce(this.nameOf(t, p) + ' disconnected — folding in ' + this.AWAY + ' s unless they return');
  },
  onTimer(t, tag) {
    const d = t.data, [kind, p, n] = tag.split(':');
    if (kind !== 'away' || !d.away || d.away[p] !== +n) return;
    delete d.away[p];
    if (d.stage !== 'hand' || !this.active(t).some((x) => x.id === p)) return;
    d.awayFolded = (d.awayFolded || []).concat(p);
    t.say(this.nameOf(t, p) + ' left mid-hand');
    if (d.turn === p) return this.doAction(t, p, 'fold');
    this.fold(t, p);
    t.say(this.nameOf(t, p) + ' folds');
    d.pending = d.pending.filter((x) => x !== p);
    if (this.contenders(t).length === 1) this.afterAction(t, p, false); // pays the last one standing
  },
  badges(t) {
    t.public.badges = Object.fromEntries(t.players().map((p) => [p.id, '💰' + (t.data.stacks[p.id] ?? 0)]));
  },
  nameOf(t, p) { return (t.players().find((x) => x.id === p) || {}).name || '?'; },
  // The game's deck: the biggest pile of one standard deck (not the muck,
  // and not another game's cards).
  deck(t) {
    const std = (p) => p.id !== t.data.muckId && p.cards.length && p.cards.every((c) => c.d === p.cards[0].d) && !!(t.card(p.cards[0]) || {}).rank;
    return t.piles().filter(std).sort((a, b) => b.cards.length - a.cards.length)[0];
  },
  // Cards of another deck than D leave the hands, onto a pile of their own
  // (only cards: a piece held in a hand stays there).
  aside(t, D) {
    const g = t.geom(), other = (c) => 'd' in c && c.d !== D;
    let id = null;
    for (const p of t.players()) {
      if (!t.hand(p.id).some(other)) continue;
      id = id || t.newPile([], { x: g.cx + 190, y: g.cy - 240, name: 'Set aside' });
      t.takeHand(p.id, id, other);
    }
  },
  // Who is in the hand: dealt two cards (a piece held in a hand doesn't count) and not folded.
  contenders(t) { return t.players().filter((p) => t.hand(p.id).filter((c) => 'd' in c).length === 2 && !t.data.folded.includes(p.id)); },
  active(t) { return this.contenders(t).filter((p) => t.data.stacks[p.id] > 0); },
  // The next player in list clockwise from p, by seat. Not t.nextSeat: that
  // skips offline players, and after a host reload everyone is offline until
  // they reconnect — the turn must wait for them, not vanish.
  nextFrom(t, p, list) {
    const ps = t.players(), i = ps.findIndex((x) => x.id === p);
    for (let k = 1; k <= ps.length; k++) {
      const q = ps[(i + k) % ps.length].id;
      if (list.some((x) => x.id === q)) return q;
    }
    return null;
  },
  put(t, p, amt) {
    const d = t.data;
    amt = Math.max(0, Math.min(amt, d.stacks[p]));
    d.stacks[p] -= amt;
    d.paid[p] = (d.paid[p] || 0) + amt;
    d.bet[p] = (d.bet[p] || 0) + amt;
    d.pot += amt;
    this.badges(t);
    return amt;
  },
  fold(t, p) {
    const d = t.data;
    d.folded.push(p);
    if (!t.items().some((x) => x.id === d.muckId)) {
      const g = t.geom();
      d.muckId = t.newPile([], { x: g.cx + 70, y: g.cy - 240, name: 'muck' });
    }
    t.takeHand(p, d.muckId, (c) => 'd' in c); // (the muck takes cards only)
  },
  /** Calls the hand off: every bet goes back to its owner. */
  abandon(t, msg) {
    const d = t.data;
    for (const [p, amt] of Object.entries(d.paid || {})) d.stacks[p] += amt;
    Object.assign(d, { stage: 'done', paid: {}, pot: 0, turn: null });
    t.public.turn = null;
    this.badges(t);
    t.say(msg);
  },
  buttons(t) {
    const d = t.data, p = d.turn;
    if (d.stage !== 'hand') { // deal; each busted player sees a Rebuy of their own
      return [{ id: 'new', label: '🂠 New hand' }].concat(t.players().filter((x) => !(d.stacks[x.id] > 0))
        .map((x) => ({ id: 'rebuy:' + x.id, label: '💰 Rebuy ' + this.BUYIN, pid: x.id })));
    }
    // Mid-hand only the host may call the hand off: the refund would let
    // anyone who is losing take their bets back instead of folding. It comes
    // last in the row and takes a second press (onButton): a mis-tap beside
    // Call must not undo the hand.
    const btns = [], abandon = { id: 'abandon', label: '🂠 Abandon hand (refund)', pid: t.hostId };
    if (!p) return [abandon];
    const owed = d.curBet - (d.bet[p] || 0), all = (d.bet[p] || 0) + d.stacks[p];
    btns.push(owed > 0 ? { id: 'call', label: 'Call ' + Math.min(owed, d.stacks[p]), pid: p } : { id: 'check', label: 'Check', pid: p },
      { id: 'fold', label: 'Fold', pid: p });
    if (all > d.curBet && d.canRaise.includes(p)) {
      // Quick raises, as round totals ("r:<total>"). A pot-sized raise is the
      // call plus the pot after calling. Sizes that aren't legal raises below
      // the stack are left out: the All-in button covers the rest.
      const pot = d.pot + owed;
      const sizes = [['Min raise', d.curBet + d.minRaise], ['½ pot', d.curBet + Math.floor(pot / 2)], ['Pot', d.curBet + pot]];
      for (const [name, to] of sizes) {
        if (to - d.curBet >= d.minRaise && to < all && !btns.some((b) => b.id === 'r:' + to)) btns.push({ id: 'r:' + to, label: name + ' → ' + to, pid: p });
      }
      btns.push({ id: 'allin', label: 'All-in → ' + all, pid: p });
    }
    return btns.concat(abandon);
  },
  onButton(t, id, byPid) {
    const d = t.data;
    if (id === 'new') return this.startHand(t, byPid);
    if (id === 'abandon') {
      if (Date.now() - (d.abandonArm || 0) > 4000) {
        d.abandonArm = Date.now();
        return t.tell(byPid, 'Press Abandon again to call the hand off (every bet is refunded)');
      }
      d.abandonArm = 0;
      return this.startHand(t, byPid);
    }
    if (id.startsWith('rebuy:')) return this.rebuy(t, byPid);
    if (id.startsWith('r:')) return this.doAction(t, byPid, 'bet', +id.slice(2));
    this.doAction(t, byPid, id);
  },
  onChat(t, msg, p) {
    const d = t.data;
    let m;
    if ((m = /^!(check|call|fold|allin)$/i.exec(msg))) return this.doAction(t, p, m[1].toLowerCase());
    if ((m = /^!(?:bet|raise)\\s+(\\d+)$/i.exec(msg))) return this.doAction(t, p, 'bet', +m[1]);
    if (/^!rebuy$/i.test(msg)) return this.rebuy(t, p);
    if ((m = /^!blinds\\s+(\\d+)\\s+(\\d+)$/i.exec(msg))) {
      if (p !== t.hostId) return t.tell(p, 'Only the host sets the blinds');
      if (d.stage === 'hand') return t.tell(p, 'After this hand');
      const sb = +m[1], bb = +m[2];
      if (!(sb > 0 && sb <= bb)) return t.tell(p, 'Use !blinds SB BB with 0 < SB ≤ BB');
      d.blinds = { sb, bb };
      return t.say('Blinds set to ' + sb + '/' + bb);
    }
  },
  rebuy(t, p) {
    const d = t.data;
    if (d.stage === 'hand') return t.tell(p, 'Rebuy after this hand');
    if ((d.stacks[p] || 0) > 0) return t.tell(p, 'Rebuy is only for a busted (0-chip) stack');
    d.stacks[p] = this.BUYIN;
    this.badges(t);
    t.say(this.nameOf(t, p) + ' rebuys for ' + this.BUYIN);
  },
  // by: who pressed (refusals go to them — the log is hidden on phones)
  startHand(t, by) {
    const d = t.data, deckP = this.deck(t), g = t.geom();
    if (d.stage === 'hand') this.abandon(t, 'Hand abandoned — bets refunded.');
    if (!deckP) return t.tell(by, 'No deck on the table!');
    const funded = t.players().filter((p) => p.online && (d.stacks[p.id] || 0) > 0);
    if (funded.length < 2) return t.tell(by, 'Need 2+ online players with chips (a busted player presses 💰 Rebuy)');
    // Gather this deck (D) only: its loose cards (face down — a face-up
    // card would show on the deck's top), its other piles (the muck), the hands.
    const D = deckP.cards[0].d, ours = (c) => c.d === D;
    for (const it of t.items()) if (it.k === 'c' && ours(it)) { if (it.up) t.flip(it.id); t.toPile(it.id, deckP.id); }
    for (const p of t.piles()) if (p.id !== deckP.id && p.cards.every(ours)) t.merge(p.id, deckP.id);
    this.aside(t, D);
    for (const p of t.players()) t.takeHand(p.id, deckP.id, ours);
    t.shuffle(deckP.id);
    // Layout: burns | deck | muck in a row above the board row through the
    // center — all clear of the hole cards revealed by the seats.
    t.move(deckP.id, g.cx - 50, g.cy - 240);
    for (const p of funded) { t.deal(deckP.id, { to: p.id }); t.deal(deckP.id, { to: p.id }); }
    Object.assign(d, { stage: 'hand', comm: [], burn: [], folded: [], muckId: null, paid: {}, bet: {}, pot: 0, away: {}, awayFolded: [], abandonArm: 0 });
    t.public.winners = null;
    d.dealer = d.dealer && funded.some((x) => x.id !== d.dealer) ? this.nextFrom(t, d.dealer, funded) : funded[0].id;
    const sb = funded.length === 2 ? d.dealer : this.nextFrom(t, d.dealer, funded);
    const bb = this.nextFrom(t, sb, funded);
    this.put(t, sb, d.blinds.sb);
    this.put(t, bb, d.blinds.bb);
    d.curBet = d.blinds.bb;
    d.minRaise = d.blinds.bb;
    const act = this.active(t);
    d.pending = act.map((x) => x.id);
    d.canRaise = [...d.pending]; // who may still raise this round (see afterAction)
    d.turn = this.nextFrom(t, bb, act);
    t.public.turn = d.turn;
    t.announce('New hand — blinds ' + d.blinds.sb + '/' + d.blinds.bb + ' (' + this.nameOf(t, sb) + '/' + this.nameOf(t, bb) + ')'
      + (d.turn ? ', ' + this.nameOf(t, d.turn) + ' to act' : ''));
    if (!d.turn) this.nextStreet(t); // everyone dealt in is all-in from the blinds: run it out
  },
  doAction(t, p, kind, amt) {
    const d = t.data;
    if (d.stage !== 'hand' || !d.turn) return t.tell(p, 'No betting right now');
    if (p !== d.turn) return t.tell(p, 'Not your turn');
    const name = this.nameOf(t, p);
    const owed = d.curBet - (d.bet[p] || 0);
    const closed = () => t.tell(p, 'Betting was not reopened — call or fold');
    if (kind === 'check') {
      if (owed > 0) return t.tell(p, 'You must call ' + owed + ' (or raise / fold)');
      t.say(name + ' checks');
    } else if (kind === 'call') {
      if (owed <= 0) return this.doAction(t, p, 'check');
      const paid = this.put(t, p, owed);
      t.say(name + ' calls ' + paid + (d.stacks[p] === 0 ? ' (all-in)' : ''));
    } else if (kind === 'fold') {
      this.fold(t, p);
      t.say(name + ' folds');
    } else if (kind === 'bet') {
      if (!(amt > 0)) return t.tell(p, 'Say "!bet 50" (the round total to raise to)');
      const maxTotal = (d.bet[p] || 0) + d.stacks[p];
      if (amt >= maxTotal) return this.doAction(t, p, 'allin');
      if (!d.canRaise.includes(p)) return closed();
      const delta = amt - d.curBet;
      if (delta < d.minRaise) return t.tell(p, 'Min raise to ' + (d.curBet + d.minRaise));
      this.put(t, p, amt - (d.bet[p] || 0));
      d.minRaise = delta;
      d.curBet = amt;
      t.say(name + ' raises to ' + amt);
      return this.afterAction(t, p, true, true);
    } else if (kind === 'allin') {
      const total = (d.bet[p] || 0) + d.stacks[p];
      if (total <= 0) return t.tell(p, 'No chips left — "!rebuy" after the hand');
      const raised = total > d.curBet, full = total - d.curBet >= d.minRaise;
      if (raised && !d.canRaise.includes(p)) return closed();
      this.put(t, p, d.stacks[p]);
      if (raised) { if (full) d.minRaise = total - d.curBet; d.curBet = total; }
      t.say(name + ' is ALL-IN for ' + total);
      return this.afterAction(t, p, raised, full);
    }
    this.afterAction(t, p, false);
  },
  // raised: everyone else must respond again. reopen: a full raise, so they
  // may also re-raise — a short all-in only raises the price (TDA rules).
  afterAction(t, p, raised, reopen) {
    const d = t.data, others = () => this.active(t).map((x) => x.id).filter((id) => id !== p);
    d.pending = raised ? others() : d.pending.filter((id) => id !== p);
    d.canRaise = reopen ? others() : d.canRaise.filter((id) => id !== p);
    const live = this.contenders(t);
    if (live.length === 1) {
      d.stacks[live[0].id] += d.pot;
      this.badges(t);
      d.stage = 'done';
      d.turn = null;
      t.public.turn = null;
      return t.win([live[0].id], live[0].name + ' takes the pot (' + d.pot + ') — everyone else folded');
    }
    if (!d.pending.length) return this.nextStreet(t);
    const waiting = this.active(t).filter((x) => d.pending.includes(x.id));
    d.turn = this.nextFrom(t, p, waiting);
    t.public.turn = d.turn;
  },
  nextStreet(t) {
    const d = t.data, g = t.geom(), deckP = this.deck(t);
    d.bet = {};
    d.curBet = 0;
    d.minRaise = d.blinds.bb;
    d.turn = null;
    t.public.turn = null;
    if (d.comm.length === 5) return this.showdown(t);
    if (!deckP) return this.abandon(t, 'The deck is gone — hand abandoned, bets refunded');
    const burn = t.deal(deckP.id, { x: g.cx - 170, y: g.cy - 240, up: false });
    if (burn) d.burn.push(burn.id);
    const n = d.comm.length === 0 ? 3 : 1;
    for (let i = 0; i < n; i++) { // the board: one row through the center
      const c = t.deal(deckP.id, { x: g.cx - 280 + d.comm.length * 115, y: g.cy - 70, up: true });
      if (c) d.comm.push({ d: c.d, i: c.i });
    }
    t.announce((n === 3 ? 'Flop' : d.comm.length === 4 ? 'Turn' : 'River') + ' — pot ' + d.pot);
    const act = this.active(t);
    if (act.length <= 1) return this.nextStreet(t); // all-in run-out
    d.pending = act.map((x) => x.id);
    d.canRaise = [...d.pending];
    d.turn = this.nextFrom(t, d.dealer, act);
    t.public.turn = d.turn;
  },
  // --- hand evaluation (best 5 of 7) ---
  HANDS: ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'],
  parsed(t, ref) {
    const n = t.cardName(ref), r = n.slice(0, -1);
    return { v: { A: 14, K: 13, Q: 12, J: 11 }[r] || parseInt(r, 10) || 0, s: n.slice(-1) };
  },
  score5(cs) {
    const vs = cs.map((c) => c.v).sort((a, b) => b - a);
    const flush = cs.every((c) => c.s === cs[0].s);
    const u = [...new Set(vs)];
    let straight = 0;
    if (u.length === 5) {
      if (u[0] - u[4] === 4) straight = u[0];
      else if (u[0] === 14 && u[1] === 5 && u[4] === 2) straight = 5; // the wheel
    }
    const cnt = {};
    for (const v of vs) cnt[v] = (cnt[v] || 0) + 1;
    const groups = Object.entries(cnt).map(([v, c]) => [+v, c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const kick = groups.flatMap(([v, c]) => Array(c).fill(v));
    if (flush && straight) return [8, straight];
    if (groups[0][1] === 4) return [7, ...kick];
    if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...kick];
    if (flush) return [5, ...vs];
    if (straight) return [4, straight];
    if (groups[0][1] === 3) return [3, ...kick];
    if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...kick];
    if (groups[0][1] === 2) return [1, ...kick];
    return [0, ...vs];
  },
  cmp(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  },
  best7(t, refs) {
    const cs = refs.map((r) => this.parsed(t, r));
    let best = null;
    for (let i = 0; i < 7; i++) {
      for (let j = i + 1; j < 7; j++) {
        const s = this.score5(cs.filter((_, k) => k !== i && k !== j));
        if (!best || this.cmp(s, best) > 0) best = s;
      }
    }
    return best;
  },
  /** Main + side pots from per-player contributions. Pure data -> data. */
  buildPots(paid, contenderIds) {
    const lvls = [...new Set(contenderIds.map((p) => paid[p] || 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of lvls) {
      let amt = 0;
      for (const v of Object.values(paid)) amt += Math.max(0, Math.min(v, lvl) - prev);
      const elig = contenderIds.filter((p) => (paid[p] || 0) >= lvl);
      if (amt > 0) pots.push({ amt, elig });
      prev = lvl;
    }
    return pots;
  },
  showdown(t) {
    const d = t.data, g = t.geom();
    // An uncalled bet (the top contributor's excess over everyone else) is
    // simply returned — it isn't a pot anyone won.
    const [top, second] = Object.keys(d.paid).sort((a, b) => d.paid[b] - d.paid[a]);
    const uncalled = d.paid[top] - (d.paid[second] || 0);
    if (uncalled > 0) {
      d.paid[top] -= uncalled;
      d.stacks[top] += uncalled;
      d.pot -= uncalled;
      t.say('Uncalled ' + uncalled + ' returned to ' + this.nameOf(t, top));
    }
    const players = this.contenders(t);
    const scores = {};
    for (const p of players) {
      // the hole cards and where they are in the hand (a piece held there stays)
      const hand = t.hand(p.id), at = hand.flatMap((c, k) => ('d' in c ? [k] : [])), hole = at.map((k) => hand[k]);
      // reveal by the seat, outside the board row (the last first: the others keep their index)
      const rad = (p.seat * Math.PI) / 180, tx = -Math.sin(rad), ty = Math.cos(rad);
      for (let k = hole.length - 1; k >= 0; k--) {
        t.playFromHand(p.id, at[k], {
          x: g.cx + Math.cos(rad) * (g.r - 130) + tx * (k * 72 - 36) - 50,
          y: g.cy + Math.sin(rad) * (g.r - 130) + ty * (k * 72 - 36) - 70,
          up: true, rot: ((p.seat - 90) % 360 + 360) % 360,
        });
      }
      scores[p.id] = this.best7(t, hole.concat(d.comm));
    }
    const pots = this.buildPots(d.paid, players.map((p) => p.id));
    const total = pots.reduce((s, x) => s + x.amt, 0);
    if (total < d.pot && pots.length) pots[pots.length - 1].amt += d.pot - total;
    // odd chips go to the first tied players left of the button
    const ids = t.players().map((p) => p.id), n = ids.length, di = ids.indexOf(d.dealer);
    const leftOfButton = (p) => (ids.indexOf(p) - di - 1 + n) % n;
    const winnersAll = new Set(), parts = [];
    pots.forEach((pot, i) => {
      let best = pot.elig[0];
      for (const p of pot.elig) if (this.cmp(scores[p], scores[best]) > 0) best = p;
      const tied = pot.elig.filter((p) => this.cmp(scores[p], scores[best]) === 0).sort((a, b) => leftOfButton(a) - leftOfButton(b));
      const share = Math.floor(pot.amt / tied.length);
      let odd = pot.amt - share * tied.length;
      for (const p of tied) { d.stacks[p] += share + (odd-- > 0 ? 1 : 0); winnersAll.add(p); }
      const names = tied.map((p) => this.nameOf(t, p)).join(' & ');
      parts.push(names + (tied.length > 1 ? ' split ' : ' wins ') + pot.amt
        + (pots.length > 1 ? (i === 0 ? ' (main)' : ' (side)') : '') + ' with ' + this.HANDS[scores[best][0]]);
    });
    this.badges(t);
    for (const p of players) if (d.stacks[p.id] === 0) t.tell(p.id, 'You are out of chips — press 💰 Rebuy to play on');
    d.stage = 'done';
    d.turn = null;
    t.public.turn = null;
    t.win([...winnersAll], parts.join(' · '));
  },
  validate(t, a) {
    const d = t.data;
    if (d.stage !== 'hand') {
      if (a.t === 'draw' || a.t === 'deal') return 'Use the New hand button';
      return;
    }
    if (['play', 'handPile', 'toHand', 'draw', 'deal', 'addDeck'].includes(a.t)) {
      return 'Hand in progress — act with the buttons or chat (!bet, !fold, ...)';
    }
    // The deck and the muck (folded hole cards) stay closed, the board and
    // burn cards stay where they are: none of them may be peeked at,
    // deleted, merged, shuffled, flipped or stacked mid-hand.
    const deckId = this.deck(t)?.id;
    const guarded = (id) => {
      if (!id) return false;
      if (id === deckId || id === d.muckId || d.burn.includes(id)) return true;
      const it = t.items().find((x) => x.id === id);
      return it && it.k === 'c' && d.comm.some((c) => c.d === it.d && c.i === it.i);
    };
    if (['del', 'merge', 'toPile', 'stack', 'shuffle', 'flip', 'peek'].includes(a.t) && [a.id, a.pile, a.onto].some(guarded)) {
      return 'The deck, muck and board stay put during a hand';
    }
  },
})`,
  bridge: `({
  name: 'Bridge',
  // Full flow: Deal -> AUCTION IN CHAT -> play. Bidding commands (in turn,
  // dealer first, rotating each deal): "!bid 1H" (or "!1H"; strains C D H S NT),
  // "!pass", "!double", "!redouble". Three passes after a bid fix the
  // contract (declarer = first of the winning side to name the strain);
  // four passes throw the hand in. "!contract 4H <name>" (the dealer or the
  // host, during the auction) skips it if you bid out loud instead. The four
  // players online at Deal play the hand in fixed seat order; if one drops,
  // play waits for them. Then: left of declarer leads, the dummy is
  // laid face up and played by the DECLARER (slide a dummy card to an empty
  // spot in the middle), turns and following suit are enforced, tricks are
  // resolved trump-aware and swept, and the winning side takes the trophy.
  STRAINS: ['C', 'D', 'H', 'S', 'NT'],
  SYMS: { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT' },
  setup(t) {
    const n = t.players().filter((p) => p.online).length;
    t.say(n === 4 ? 'Bridge: press Deal, then bid in chat ("!bid 1H", "!pass", ...).' : this.needFour(n));
  },
  // Everyone online holds a seat, so extras must leave before the deal.
  needFour: (n) => n < 4
    ? 'Bridge deals to exactly 4 online players (' + n + ' online) — waiting for ' + (4 - n) + ' more.'
    : 'Bridge deals to exactly 4 online players (' + n + ' online) — extra players must leave before the deal; anyone who joins later watches.',
  buttons: (t) => (t.data.phase === 'play' || t.data.phase === 'bid' ? [] : [{ id: 'deal', label: '🂠 Deal (13 each)' }]),
  deck(t) { return t.piles().filter((p) => p.cards.length && 'd' in p.cards[0]).sort((a, b) => b.cards.length - a.cards.length)[0]; }, // (the biggest pile of cards)
  suitOf(t, c) { return t.cardName(c).slice(-1); },
  rankOf(t, c) {
    const r = t.cardName(c).slice(0, -1);
    return { A: 14, K: 13, Q: 12, J: 11 }[r] || parseInt(r, 10) || 0;
  },
  // The four dealt players, frozen at Deal in seat order: partnerships and
  // turns never shift when someone joins, leaves or drops (t.nextSeat would
  // skip an offline player — here the turn waits for them instead).
  seats(t) { return t.data.seats || t.players().filter((p) => p.online).map((p) => p.id); },
  nextP(t, p) { const s = this.seats(t); return s[(s.indexOf(p) + 1) % s.length]; },
  sideOf(t, p) { return this.seats(t).indexOf(p) % 2; },
  sideName(t, s) { const q = this.seats(t); return this.nameOf(t, q[s]) + '–' + this.nameOf(t, q[s + 2]); },
  sidePids(t, s) { return this.seats(t).filter((_, i) => i % 2 === s); },
  // (all: a dealt player may have stood up to watch since — they keep their name, hand and partnership)
  nameOf(t, p) { return (t.players({ all: true }).find((x) => x.id === p) || {}).name || '?'; },
  /** Where player p sits (degrees): the bottom while they watch. */
  seatOf(t, p) { const x = t.players({ all: true }).find((y) => y.id === p); return x && x.seat != null ? x.seat : 90; },
  inCenter(t, x, y) { const g = t.geom(); return Math.hypot(x + 50 - g.cx, y + 70 - g.cy) < g.r * 0.4; },
  dummyRef(t, id) {
    const it = t.items().find((x) => x.id === id);
    return it && it.k === 'c' && (t.data.dummyCards || []).find((c) => c.d === it.d && c.i === it.i);
  },
  // by: who pressed Deal (a refusal tells them — phones hide the log)
  onButton(t, id, by) {
    if (id !== 'deal') return;
    if (t.data.phase === 'play' || t.data.phase === 'bid') return t.tell(by, 'Finish the hand first.');
    const ps = t.players().filter((p) => p.online);
    if (ps.length !== 4) return t.announce(this.needFour(ps.length));
    // This game's deck: the one dealt last time while any of it is still
    // around (after a passed-out hand it is all in the hands, with no pile
    // left), else the biggest pile. Other decks' cards and piles stay put.
    const has = (D) => D != null && (t.items().some((it) => it.d === D || (it.cards || []).some((c) => c.d === D))
      || t.players({ all: true }).some((p) => t.hand(p.id).some((c) => c.d === D)));
    const D = has(t.data.deckD) ? t.data.deckD : this.deck(t)?.cards[0].d;
    if (D == null) return t.tell(by, 'No deck on the table!');
    const ours = (p) => p.cards.every((c) => c.d === D);
    const g = t.geom(), mine = t.piles().filter(ours).sort((a, b) => b.cards.length - a.cards.length)[0];
    const deckId = mine ? mine.id : t.newPile([], { x: g.cx - 50, y: g.cy - 70, name: 'Deck' });
    // gather all 52: loose cards, both sides' trick piles, stray stacks, every
    // hand — after another deck's cards in a hand went onto a pile of their own
    for (const it of t.items()) if (it.k === 'c' && it.d === D) t.toPile(it.id, deckId);
    for (const p of t.piles()) if (p.id !== deckId && ours(p)) t.merge(p.id, deckId);
    let aside = null;
    const other = (c) => 'd' in c && c.d !== D; // (only cards: a piece held in a hand stays there)
    for (const p of t.players()) {
      if (!t.hand(p.id).some(other)) continue;
      aside = aside || t.newPile([], { x: g.cx + 250, y: g.cy - 390, name: 'Set aside' });
      t.takeHand(p.id, aside, other);
    }
    for (const p of t.players()) t.takeHand(p.id, deckId, (c) => c.d === D);
    if (!t.piles().find((p) => p.id === deckId).cards.length) { t.remove(deckId); return t.tell(by, 'No deck on the table!'); }
    t.data.deckD = D;
    t.shuffle(deckId);
    t.dealToAll(deckId, 13);
    const dealerIdx = ((t.data.dealerIdx ?? -1) + 1) % 4; // rotates every deal
    Object.assign(t.data, {
      phase: 'bid', dealerIdx, trump: null, level: null, declarer: null, dummy: null,
      trick: [], tricks: [0, 0], sidePiles: {}, firstLead: false, dummyCards: [],
      auction: { passes: 0, best: null, first: {}, dbl: '' }, away: [],
      seats: ps.map((p) => p.id), // dealToAll dealt exactly these four
    });
    t.data.turn = this.seats(t)[dealerIdx];
    t.public = { turn: t.data.turn };
    t.say('Dealt 13 to each (' + this.sideName(t, 0) + ' vs ' + this.sideName(t, 1) + ').');
    t.announce('Auction: ' + this.nameOf(t, t.data.turn) + ' bids first — "!bid 1H", "!pass", ...');
  },
  onChat(t, msg, p) {
    if (t.data.phase === 'bid') return this.onBid(t, msg.trim(), p);
    if (/^!contract\\b/i.test(msg.trim())) t.tell(p, '!contract works during the auction, after Deal');
  },
  // Manual override for tables that bid out loud: "!contract 4H Alice" —
  // during the auction only, by the dealer or the host.
  contract(t, msg, p) {
    const dealer = this.seats(t)[t.data.dealerIdx];
    if (p !== dealer && !t.players().some((x) => x.id === p && x.host)) {
      return t.tell(p, 'Only the dealer (' + this.nameOf(t, dealer) + ') or the host can set the contract');
    }
    const m = /^!contract\\s*([1-7])?\\s*(NT|[SHDC])\\s+(.+)$/i.exec(msg);
    if (!m) return t.tell(p, 'Usage: !contract 4H <declarer>');
    const name = m[3].trim().toLowerCase();
    const decl = this.seats(t).find((id) => this.nameOf(t, id).toLowerCase().startsWith(name));
    if (!decl) return t.tell(p, 'Nobody named "' + m[3].trim() + '" plays this hand');
    this.startPlay(t, m[1] ? +m[1] : null, m[2].toUpperCase(), decl, '');
  },
  onBid(t, msg, p) {
    const a = t.data.auction;
    const bid = /^!(?:bid\\s+)?([1-7])\\s*(NT|[SHDC])$/i.exec(msg);
    const pass = /^!p(?:ass)?$/i.exec(msg);
    const dbl = /^!double$/i.exec(msg) || /^!x$/i.exec(msg);
    const rdbl = /^!redouble$/i.exec(msg) || /^!xx$/i.exec(msg);
    if (/^!contract\\b/i.test(msg)) return this.contract(t, msg, p);
    if (!bid && !pass && !dbl && !rdbl) return; // ordinary chatter
    if (p !== t.data.turn) return t.tell(p, "It's not your turn to bid");
    const side = this.sideOf(t, p);
    if (bid) {
      const level = +bid[1], s = this.STRAINS.indexOf(bid[2].toUpperCase());
      const b = a.best;
      if (b && (level < b.level || (level === b.level && s <= b.s))) {
        return t.tell(p, 'Insufficient — you must outbid ' + b.level + this.SYMS[this.STRAINS[b.s]]);
      }
      a.best = { level, s, side, by: p };
      a.first[side + ':' + s] ??= p;
      a.passes = 0;
      a.dbl = '';
      t.say(this.nameOf(t, p) + ' bids ' + level + this.SYMS[this.STRAINS[s]]);
    } else if (dbl) {
      if (!a.best || a.best.side === side || a.dbl) return t.tell(p, 'Nothing to double');
      a.dbl = 'X';
      a.passes = 0;
      t.say(this.nameOf(t, p) + ' doubles');
    } else if (rdbl) {
      if (a.dbl !== 'X' || !a.best || a.best.side !== side) return t.tell(p, 'Nothing to redouble');
      a.dbl = 'XX';
      a.passes = 0;
      t.say(this.nameOf(t, p) + ' redoubles');
    } else {
      a.passes++;
      t.say(this.nameOf(t, p) + ' passes');
    }
    if (a.best && a.passes === 3) {
      const declarer = a.first[a.best.side + ':' + a.best.s] || a.best.by;
      return this.startPlay(t, a.best.level, this.STRAINS[a.best.s], declarer, a.dbl);
    }
    if (!a.best && a.passes === 4) {
      t.data.phase = 'done';
      t.public.turn = null;
      return t.announce('Passed out — press Deal for a new hand');
    }
    t.data.turn = this.nextP(t, p);
    t.public.turn = t.data.turn;
  },
  // Whose move the table waits on (⏳, the your-turn cue): the DECLARER
  // plays the dummy's cards. (data.turn stays the seat whose card is due.)
  pubTurn(t) { const d = t.data; t.public.turn = d.turn && d.turn === d.dummy ? d.declarer : d.turn; },
  startPlay(t, level, strain, declarer, dbl) {
    const s = this.seats(t);
    t.data.level = level;
    t.data.trump = strain === 'NT' ? null : this.SYMS[strain];
    t.data.declarer = declarer;
    t.data.dummy = s[(s.indexOf(declarer) + 2) % 4];
    t.data.phase = 'play';
    t.data.firstLead = true;
    t.data.trick = [];
    t.data.turn = this.nextP(t, declarer);
    this.pubTurn(t);
    t.public.badges = { [t.data.dummy]: '🃏 dummy' }; // the dummy's seat, once ⏳ no longer lands on it
    t.announce('Contract: ' + (level || '') + this.SYMS[strain] + (dbl ? ' ' + dbl : '') + ' by '
      + this.nameOf(t, declarer) + ' — ' + this.nameOf(t, t.data.turn) + ' leads');
  },
  // Lays the dummy's whole hand face up in two sorted rows by their seat,
  // oriented to face them; the declarer plays these by sliding to the middle.
  showDummy(t) {
    const dummy = t.players({ all: true }).find((p) => p.id === t.data.dummy);
    if (!dummy) return;
    const order = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
    const refs = t.hand(dummy.id).sort((a, b) =>
      (order[this.suitOf(t, a)] - order[this.suitOf(t, b)]) || (this.rankOf(t, b) - this.rankOf(t, a)));
    t.data.dummyCards = refs.map((c) => ({ d: c.d, i: c.i }));
    const seat = this.seatOf(t, dummy.id), g = t.geom(), rad = (seat * Math.PI) / 180;
    const tx = -Math.sin(rad), ty = Math.cos(rad); // tangent along the rim
    const rot = ((seat - 90) % 360 + 360) % 360; // upright for the dummy
    refs.forEach((c, k) => {
      const row = k < 7 ? 0 : 1, off = ((k < 7 ? k : k - 7) - 3) * 68;
      const rr = g.r - 260 + row * 155; // both rows clear of the r*0.4 'played' center zone
      const idx = t.hand(dummy.id).findIndex((h) => h.d === c.d && h.i === c.i);
      t.playFromHand(dummy.id, idx, {
        x: g.cx + Math.cos(rad) * rr + tx * off - 50,
        y: g.cy + Math.sin(rad) * rr + ty * off - 70,
        up: true, rot,
      });
    });
    t.say('Dummy (' + dummy.name + ') is on the table — the DECLARER slides dummy cards to an empty spot in the middle to play them.');
  },
  validate(t, a) {
    if (t.data.phase === 'bid') {
      // While bidding, all 52 cards stay where they are — hands in hands.
      if (['play', 'handPile', 'draw', 'deal', 'toHand', 'flip', 'addDeck'].includes(a.t)) {
        return 'Bidding — cards stay in hand ("!bid 1H", "!pass", ...)';
      }
      return;
    }
    if (t.data.phase !== 'play') {
      if (a.t === 'draw' || a.t === 'deal') return 'Use the Deal button';
      return;
    }
    if (['draw', 'deal', 'handPile', 'toHand', 'addDeck'].includes(a.t)) return 'The hand is in progress';
    // cards of the current trick must stay loose so the sweep can collect them
    const inTrick = (id) => {
      const it = t.items().find((x) => x.id === id);
      return it && it.k === 'c' && t.data.trick.some((c) => c.d === it.d && c.i === it.i);
    };
    if (['toPile', 'stack', 'del', 'flip'].includes(a.t) && ((a.id && inTrick(a.id)) || (a.onto && inTrick(a.onto)))) {
      return 'Those cards are mid-trick';
    }
    // the dummy's exposed cards: only the declarer touches them
    if (a.id && ['toPile', 'stack', 'del', 'flip'].includes(a.t) && this.dummyRef(t, a.id)) {
      return 'Slide dummy cards to an EMPTY spot in the middle to play them';
    }
    if (a.t === 'move' && a.id && this.dummyRef(t, a.id)) {
      if (a.p !== t.data.declarer) return 'Only the declarer plays the dummy';
      if (this.inCenter(t, a.x, a.y)) {
        if (t.data.turn !== t.data.dummy) return "Not dummy's turn yet";
        const it = t.items().find((x) => x.id === a.id);
        const led = t.data.trick[0] && this.suitOf(t, t.data.trick[0]);
        if (led && this.suitOf(t, it) !== led && (t.data.dummyCards || []).some((c) => this.suitOf(t, c) === led)) {
          return 'Dummy must follow ' + led;
        }
      }
      return;
    }
    if (a.t !== 'play') return; // arranging the table is otherwise free
    if (a.p !== t.data.turn) {
      return a.p === t.data.declarer && t.data.turn === t.data.dummy
        ? "Dummy's turn: slide one of the dummy's cards to the middle" : "It's not your turn";
    }
    if (!a.up) return 'Play your card face up';
    const led = t.data.trick[0] && this.suitOf(t, t.data.trick[0]);
    if (led && this.suitOf(t, a) !== led && t.hand(a.p).some((c) => this.suitOf(t, c) === led)) {
      return 'You must follow ' + led;
    }
  },
  recordPlay(t, card) {
    if (t.data.firstLead) { t.data.firstLead = false; this.showDummy(t); }
    t.data.trick.push(card);
    if (t.data.trick.length === 4) {
      t.data.turn = t.public.turn = null; // nobody plays until the sweep
      t.schedule(2.5, 'sweep'); // let everyone look at the trick first
    } else {
      t.data.turn = this.nextP(t, card.p);
      this.pubTurn(t);
    }
  },
  onAction(t, a) {
    if (t.data.phase !== 'play') return;
    if (a.t === 'play') return this.recordPlay(t, { p: a.p, d: a.d, i: a.i });
    // declarer sliding a dummy card into the middle = the dummy's play
    if (a.t === 'move' && a.p === t.data.declarer && t.data.turn === t.data.dummy) {
      const ref = this.dummyRef(t, a.id);
      const it = ref && t.items().find((x) => x.id === a.id);
      if (ref && this.inCenter(t, it.x, it.y)) {
        t.data.dummyCards = t.data.dummyCards.filter((c) => c !== ref);
        this.recordPlay(t, { p: t.data.dummy, d: ref.d, i: ref.i });
      }
    }
  },
  onTimer(t, tag) {
    if (tag !== 'sweep' || t.data.trick.length !== 4) return;
    const trick = t.data.trick;
    let win = trick[0];
    for (const c of trick.slice(1)) {
      const s = this.suitOf(t, c), ws = this.suitOf(t, win), tr = t.data.trump;
      if ((s === ws && this.rankOf(t, c) > this.rankOf(t, win)) || (tr && s === tr && ws !== tr)) win = c;
    }
    const side = this.sideOf(t, win.p);
    t.data.tricks[side]++;
    // sweep the four cards into the winning side's face-down trick pile
    let pileId = t.data.sidePiles[side];
    if (!pileId || !t.items().some((it) => it.id === pileId)) {
      // by a hand-holding seat: the dummy's seat is covered by its cards
      const by = side === this.sideOf(t, t.data.declarer) ? t.data.declarer : win.p;
      const g = t.geom(), rad = (this.seatOf(t, by) * Math.PI) / 180;
      pileId = t.newPile([], { x: g.cx + Math.cos(rad) * (g.r - 40) - 50, y: g.cy + Math.sin(rad) * (g.r - 40) - 70, name: this.sideName(t, side) + ' tricks' });
      t.data.sidePiles[side] = pileId;
    }
    for (const it of t.items()) {
      if (it.k === 'c' && trick.some((c) => c.d === it.d && c.i === it.i)) { t.flip(it.id); t.toPile(it.id, pileId); }
    }
    t.data.trick = [];
    t.say('Trick to ' + this.nameOf(t, win.p) + ' — ' + this.sideName(t, 0) + ' ' + t.data.tricks[0] + ' : ' + t.data.tricks[1] + ' ' + this.sideName(t, 1));
    if (t.data.tricks[0] + t.data.tricks[1] === 13) {
      const dSide = this.sideOf(t, t.data.declarer);
      const made = t.data.tricks[dSide];
      const target = t.data.level ? 6 + t.data.level : null;
      const success = target === null || made >= target;
      const winSide = success ? dSide : 1 - dSide;
      let msg = this.sideName(t, winSide) + ' win — declarer took ' + made + ' tricks';
      if (target) msg += success ? ' (contract MADE)' : ' (DOWN ' + (target - made) + ')';
      t.win(this.sidePids(t, winSide), msg + ' 🏆');
      t.data.phase = 'done';
      t.public.turn = null;
    } else {
      t.data.turn = win.p;
      this.pubTurn(t);
    }
  },
  // A dealt player who drops keeps their seat: their turn waits for them.
  onLeave(t, p) {
    const d = t.data;
    if ((d.phase !== 'bid' && d.phase !== 'play') || !this.seats(t).includes(p)) return;
    if (d.phase === 'play' && p === d.dummy) return; // the declarer plays the dummy
    d.away = (d.away || []).concat(p);
    t.announce(this.nameOf(t, p) + ' dropped out — the hand waits for them to rejoin');
  },
  onJoin(t, p) {
    const d = t.data;
    if (!(d.away || []).includes(p)) return;
    d.away = d.away.filter((x) => x !== p);
    t.say(this.nameOf(t, p) + ' is back — play on');
  },
})`,
  cah: `({
  name: 'Cards Against Humanity',
  // The printed rules, automated. Everyone holds 10 white cards. Each round
  // the Card Czar (👑) flips a black prompt; everyone else answers it (⏳) by
  // playing the required number of white cards from their hand (they go
  // FACE DOWN into the Answers pile — the 🂠 toggle locks on — or drop them
  // straight onto it). Once everyone has answered, the answers come out of
  // the pile in shuffled, numbered columns, upright for the Czar, who
  // presses 👉 1/2/3… to crown the funniest — the winner takes an Awesome
  // Point (⭐), the result stays up for a few seconds, everyone draws back to
  // 10, and the Czar rotates. First to the goal wins (the host's "!goal N"
  // changes it, default 5). The Czar can press "Judge now" to skip
  // stragglers; anyone can press "Skip Czar" while the Czar is away. PICK 2
  // prompts take two cards (in the order you play them); PICK 3 prompts deal
  // everyone 2 extra first. Another game's cards in a hand are set aside.
  // Card texts load from cah-cards.js (CC BY-NC-SA, Cards Against Humanity
  // LLC). Only the draw piles sit on the table; the rest of the ~1300-card
  // deck waits in script state to keep the shared state small.
  HAND: 10,
  CHUNK: 40,
  COLS: 30, // column markers #1..#30; card COLS of the marker deck is the 🏆
  setup(t) {
    if (!window.CAH_CARDS) throw new Error('cah-cards.js is missing');
    const d = t.data;
    d.goal = d.goal || 5;
    d.scores = d.scores || {};
    if (!d.wd) {
      d.wd = t.newDeck({ name: 'CAH White', back: '#f1f5f9',
        cards: window.CAH_CARDS.white.map((s) => ({ text: s })) });
      d.bd = t.newDeck({ name: 'CAH Black', back: '#0a0a0a',
        cards: window.CAH_CARDS.black.map((c) => ({ text: c[0], bg: '#0a0a0a', meta: { pick: c[1] } })) });
      d.wleft = this.shuf(window.CAH_CARDS.white.map((s, i) => i));
      d.bleft = this.shuf(window.CAH_CARDS.black.map((c, i) => i));
      d.wdisc = []; d.bdisc = [];
    }
    d.nd ||= t.newDeck({ name: 'CAH columns', back: '#fde047',
      cards: Array.from({ length: this.COLS }, (_, k) => ({ name: '#' + (k + 1), bg: '#fde047' }))
        .concat({ name: '🏆 Winner', bg: '#22c55e' }) });
    if (t.players().length < 3) t.say('CAH plays best with 3+ players — you can still try it.');
    if (!this.online(t, d.czar)) d.czar = (t.players().find((p) => p.online) || t.players()[0]).id;
    // another game's cards (another deck) leave the hands: refill counts only
    // answers (only cards: a piece held in a hand stays there)
    let aside = null;
    const other = (c) => 'd' in c && c.d !== d.wd;
    for (const p of t.players()) {
      if (!t.hand(p.id).some(other)) continue;
      aside = aside || t.newPile([], { ...this.at(t, 340, 0), name: 'Set aside' });
      t.takeHand(p.id, aside, other);
    }
    // setup re-runs on every Enable: a game in progress restarts its round
    if (d.phase !== 'over') { this.clearRound(t); this.startRound(t); }
  },
  shuf(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; } return a; },
  nameOf(t, p) { return (t.players().find((x) => x.id === p) || {}).name || '?'; },
  online(t, p) { return t.players().some((x) => x.id === p && x.online); },
  // Draw piles hold only a small window of the shuffled deck; refills come
  // from index lists in t.data, and discards reshuffle in when a list runs dry.
  stock(t, kind, need) {
    const d = t.data, deckId = kind === 'w' ? d.wd : d.bd;
    let pile = t.piles().find((p) => p.id === d[kind + 'pile']);
    while ((pile ? pile.cards.length : 0) < need) {
      if (!d[kind + 'left'].length) {
        if (!d[kind + 'disc'].length) throw new Error('the ' + (kind === 'w' ? 'white' : 'black') + ' deck ran dry');
        d[kind + 'left'] = this.shuf(d[kind + 'disc']); d[kind + 'disc'] = [];
        t.say('reshuffled the ' + (kind === 'w' ? 'white' : 'black') + ' discards back in');
      }
      const idxs = d[kind + 'left'].splice(0, this.CHUNK);
      const nid = t.newPile(idxs.map((i) => ({ d: deckId, i, up: false })),
        { ...this.pileAt(t, kind), name: kind === 'w' ? 'White deck' : 'Black deck' });
      if (pile) t.merge(nid, pile.id); else d[kind + 'pile'] = nid;
      pile = t.piles().find((p) => p.id === d[kind + 'pile']);
    }
    return pile;
  },
  dealWhite(t, p, n) {
    const pile = this.stock(t, 'w', n);
    for (let k = 0; k < n; k++) t.deal(pile.id, { to: p });
  },
  /** How many answers player p holds (a piece held in a hand isn't one). */
  answers(t, p) { return t.hand(p).filter((c) => 'd' in c).length; },
  refill(t) {
    for (const p of t.players()) {
      const n = this.HAND - this.answers(t, p.id);
      if (p.online && n > 0) this.dealWhite(t, p.id, n);
    }
  },
  badges(t) {
    const d = t.data;
    t.public.badges = Object.fromEntries(t.players().map((p) =>
      [p.id, '⭐' + (d.scores[p.id] || 0) + (p.id === d.czar && d.phase !== 'over' ? ' 👑' : '')]));
  },
  // A table spot in the Czar's frame, as t.deal options: dx to the Czar's
  // right, dy toward the Czar (from the center), upright for the Czar.
  at(t, dx, dy) {
    const g = t.geom(), s = (t.players().find((x) => x.id === t.data.czar) || { seat: 90 }).seat;
    const rot = ((s - 90) % 360 + 360) % 360, r = (rot * Math.PI) / 180;
    return { x: g.cx - 50 + dx * Math.cos(r) - dy * Math.sin(r), y: g.cy - 70 + dx * Math.sin(r) + dy * Math.cos(r), rot, up: true };
  },
  // The draw piles flank the center across the Czar's view (|dy| ≤ 70): clear
  // of a standard deck in the very center, the prompt (dy -220) and the
  // columns (dy ≥ 120). startRound moves them along when the Czar changes.
  pileAt(t, kind) { const o = this.at(t, kind === 'w' ? -170 : 170, 0); return { x: o.x, y: o.y }; },
  // Answer column gi: its #marker (k = -1) on top, then the answer cards
  // (each overlapping the one before, so the top lines of all stay readable).
  spot(t, gi, k) {
    return this.at(t, (gi - (t.data.order.length - 1) / 2) * 110, k < 0 ? 190 : 232 + k * 42);
  },
  // Lays cards [{d, i}] face up at the given spots as NEW table items, dealt
  // from a temporary pile: nothing links them to the items they came from.
  lay(t, cards, spots) {
    const tmp = t.newPile(cards.slice().reverse().map((c) => ({ d: c.d, i: c.i, up: true })), spots[0]);
    return spots.map((o) => t.deal(tmp, o).id);
  },
  startRound(t, lead) {
    const d = t.data;
    d.subs = {}; d.order = null; d.phase = 'submit'; d.round = (d.round || 0) + 1;
    this.refill(t);
    d.black = t.deal(this.stock(t, 'b', 1).id, this.at(t, 0, -220));
    for (const k of ['w', 'b']) { const o = this.pileAt(t, k); t.move(d[k + 'pile'], o.x, o.y); }
    d.pick = ((t.card(d.black) || {}).meta || {}).pick || 1;
    d.roundPlayers = t.players().filter((p) => p.online && p.id !== d.czar).map((p) => p.id);
    if (d.pick === 3) for (const p of d.roundPlayers) this.dealWhite(t, p, 2); // the printed rule: draw 2 for PICK 3
    t.public.turn = d.roundPlayers.slice(); // ⏳ + the your-turn cue: the answerers now, the Czar when judging
    t.public.winners = [];
    t.public.facedown = d.roundPlayers.slice(); // locks their 🂠 toggle on
    this.badges(t);
    t.announce((lead ? lead + ' — ' : '') + this.nameOf(t, d.czar) + ' is the Card Czar — answer with '
      + d.pick + ' card' + (d.pick > 1 ? 's' : '') + ', FACE DOWN (🂠)');
  },
  validate(t, a) {
    const d = t.data;
    if (!d.phase || d.phase === 'over') return;
    if (a.t === 'move' || a.t === 'rot') return; // arranging the table stays free
    if (a.t !== 'play' && !(a.t === 'handPile' && a.pile === d.ans)) return 'The game runs the cards here';
    if (d.phase !== 'submit') return 'Wait for the next black card';
    if (a.p === d.czar) return 'The Card Czar does not answer';
    if (!d.roundPlayers.includes(a.p)) return 'You deal in next round';
    if (a.d !== d.wd) return 'Answer with a white card';
    if (a.t === 'play' && a.up) return 'Submit FACE DOWN — toggle 🂠 in the hand bar';
    if ((d.subs[a.p] || []).length >= d.pick) return 'You already submitted';
  },
  onAction(t, a) {
    const d = t.data;
    if (d.phase !== 'submit' || !(a.t === 'play' || (a.t === 'handPile' && a.pile === d.ans))) return;
    if (a.t === 'play') {
      // straight into the face-down Answers pile: left where it was dropped,
      // the card's spot and item id would tell everyone who played it
      const it = t.items().find((x) => x.k === 'c' && x.d === a.d && x.i === a.i);
      if (!it) return;
      if (!t.piles().some((p) => p.id === d.ans)) d.ans = t.newPile([], { ...this.at(t, 0, 190), name: 'Answers' });
      t.toPile(it.id, d.ans);
    }
    (d.subs[a.p] = d.subs[a.p] || []).push({ d: a.d, i: a.i });
    const waiting = this.waiting(t);
    t.public.turn = waiting;
    if (!waiting.length) this.judge(t);
    else t.say('answers in: ' + (d.roundPlayers.length - waiting.length) + '/' + d.roundPlayers.length);
  },
  waiting(t) { const d = t.data; return d.roundPlayers.filter((p) => (d.subs[p] || []).length < d.pick); },
  judge(t) {
    const d = t.data;
    // shuffled columns so the Czar cannot tell who played what
    d.order = this.shuf(Object.keys(d.subs).filter((p) => d.subs[p].length === d.pick));
    if (!d.order.length) return this.endRound(t, null, 'No answers came in — new prompt');
    d.phase = 'judge';
    t.public.turn = d.czar;
    delete t.public.facedown;
    t.remove(d.ans); d.ans = null; // the answers come back out as new items
    const cards = [], spots = [];
    d.order.forEach((p, gi) => {
      cards.push({ d: d.nd, i: gi % this.COLS }); spots.push(this.spot(t, gi, -1));
      d.subs[p].forEach((c, k) => { cards.push(c); spots.push(this.spot(t, gi, k)); });
    });
    d.laid = this.lay(t, cards, spots);
    t.announce(this.nameOf(t, d.czar) + ' judges — press 👉 for the funniest answer');
  },
  onButton(t, id, by) {
    const d = t.data;
    if (id === 'newgame' && d.phase === 'over') {
      d.scores = {}; t.public.winners = []; d.czar = t.nextSeat(d.czar);
      return this.startRound(t);
    }
    if (id === 'skipczar' && (d.phase === 'submit' || d.phase === 'judge') && !this.online(t, d.czar)) {
      return this.endRound(t, null, 'The Card Czar is away — new prompt');
    }
    if (id === 'force' && by === d.czar && d.phase === 'submit') return this.judge(t);
    if (d.phase === 'judge' && by === d.czar && id.indexOf('pick') === 0) {
      const gi = +id.slice(4), winner = d.order[gi];
      if (!winner) return;
      d.scores[winner] = (d.scores[winner] || 0) + 1;
      // The result stays up a few seconds: 🏆 over the winning column, the
      // winner on the banner, log and seat — then the next round.
      d.phase = 'reveal'; d.winner = winner; t.public.turn = null;
      d.laid.push(...this.lay(t, [{ d: d.nd, i: this.COLS }], [this.spot(t, gi, -1)]));
      // the column's answers back on top, so the 🏆 heads it as its # did
      d.laid.slice(gi * (d.pick + 1) + 1, (gi + 1) * (d.pick + 1))
        .forEach((id, k) => { const o = this.spot(t, gi, k); t.move(id, o.x, o.y); });
      t.public.winners = [winner];
      this.badges(t);
      const texts = d.subs[winner].map((c) => (t.card(c) || {}).text).join(' / ');
      t.announce(this.nameOf(t, winner) + ' wins the round with #' + (gi + 1) + ': "' + texts + '" (⭐' + d.scores[winner] + ')');
      t.schedule(4, 'next' + d.round);
    }
  },
  onTimer(t, tag) {
    if (tag === 'next' + t.data.round && t.data.phase === 'reveal') this.endRound(t, t.data.winner);
  },
  // Clears the round's cards off the table into the discards.
  clearRound(t) {
    const d = t.data;
    for (const p of Object.keys(d.subs || {})) for (const c of d.subs[p]) d.wdisc.push(c.i);
    if (d.black) d.bdisc.push(d.black.i);
    for (const id of [d.ans, d.black && d.black.id].concat(d.laid || [])) if (id) t.remove(id);
    d.subs = {}; d.black = null; d.ans = null; d.laid = [];
  },
  endRound(t, winner, lead) {
    const d = t.data;
    this.clearRound(t);
    if (winner && d.scores[winner] >= d.goal) {
      d.phase = 'over'; t.public.turn = null; delete t.public.facedown; this.badges(t);
      return t.win([winner], this.nameOf(t, winner) + ' wins the game with ⭐' + d.scores[winner] + '!');
    }
    d.czar = t.nextSeat(d.czar);
    this.startRound(t, lead);
  },
  buttons(t) {
    const d = t.data;
    if (d.phase === 'over') return [{ id: 'newgame', label: '🔄 New game' }];
    if ((d.phase === 'submit' || d.phase === 'judge') && !this.online(t, d.czar)) return [{ id: 'skipczar', label: '⏭ Skip Czar' }];
    if (d.phase === 'submit') return [{ id: 'force', label: '⚖️ Judge now', pid: d.czar }];
    if (d.phase === 'judge') {
      return d.order.map((p, gi) => {
        const s = '👉 ' + (gi + 1) + ': ' + d.subs[p].map((c) => (t.card(c) || {}).text).join(' / ');
        return { id: 'pick' + gi, label: s.length > 30 ? s.slice(0, 29) + '…' : s, pid: d.czar };
      });
    }
    return [];
  },
  onChat(t, msg, p) {
    const m = msg.trim().toLowerCase();
    if (m.indexOf('!goal ') === 0) {
      if (p !== t.hostId) return t.tell(p, 'Only the host sets the goal');
      const n = parseInt(m.slice(6), 10);
      if (n > 0) { t.data.goal = n; t.say('the goal is now ⭐' + n); }
    }
  },
  onJoin(t, p) {
    const d = t.data;
    if (!d.phase || d.phase === 'over') return;
    const n = t.players().some((x) => x.id === p) ? this.HAND - this.answers(t, p) : 0;
    if (n > 0) this.dealWhite(t, p, n);
    // onJoin also fires on a reconnect: only a newcomer sits this round out
    if (p !== d.czar && !(d.roundPlayers || []).includes(p)) t.tell(p, 'You deal in next round');
  },
  onLeave(t, p) {
    const d = t.data;
    if (d.phase !== 'submit' && d.phase !== 'judge') return;
    if (p === d.czar) return this.endRound(t, null, 'The Card Czar left — new prompt');
    if (d.phase === 'submit' && d.roundPlayers.includes(p)) {
      // their answer is dropped (it stays hidden in the Answers pile until the reveal clears it)
      d.roundPlayers = d.roundPlayers.filter((x) => x !== p);
      for (const c of d.subs[p] || []) d.wdisc.push(c.i);
      delete d.subs[p];
      const waiting = this.waiting(t);
      t.public.turn = waiting;
      if (d.roundPlayers.length && !waiting.length) this.judge(t);
    }
  },
})`,
  dealer: `({
  name: 'Simple dealer',
  buttons: () => [{ id: 'deal1', label: 'Deal 1 to all' }],
  onButton(t, id, by) {
    const deck = t.piles().sort((a, b) => b.cards.length - a.cards.length)[0];
    if (!deck) return t.tell(by, 'No deck on the table — add one first');
    const n = t.players().filter((p) => p.online).length;
    if (deck.cards.length < n) t.announce('The deck is short (' + deck.cards.length + ' left) — the last seats get none');
    t.dealToAll(deck.id, 1);
  },
})`,
  chess: `(() => {
  // Chess with every rule, as a script (ENGINE.md). The pieces on the table
  // ARE the position: each hook reads it from where they stand
  // (readPosition), so the board and the rules can't drift apart. t.data
  // keeps what a board can't show: whose turn it is, the castling rights,
  // the en-passant square, the fifty-move clock, the positions seen (for
  // repetition), a pending promotion or draw offer, and the result.
  // A move is a drag. Picking a piece up hints its legal squares (onSelect);
  // handle() takes the drop and plays it — the capture, castling's rook, en
  // passant — or refuses it, saying why; a pawn reaching the last rank asks
  // its player what it becomes (t.ask, onAnswer). After every move endTurn()
  // looks for checkmate, stalemate and the draws the rules make automatic.
  // Strict: nothing else moves a piece.
  const rules = {
    name: 'Chess',
    strict: true,
    setup(t) {
      if (t.data.ready) return; // enabled again: the game goes on where it was
      const box = t.newBox(chessBox());
      clearOthers(t, box);
      t.setTable({ shape: 'rect', w: 1000, h: 1360 }); // (room by each edge for a seat label and its player's buttons)
      t.setSeats([
        { id: 'white', name: 'White', color: '#f5f5f4', edge: 'bottom' },
        { id: 'black', name: 'Black', color: '#1c1917', edge: 'top' },
      ]);
      if (!t.find({ type: box + '/board' }).length) t.spawn(box + '/board', { at: 'center' });
      Object.assign(t.data, { ready: true, box });
      newGame(t);
      t.say('Chess: drag a piece to move it — picking it up shows where it may go. White moves first.');
    },
    // Picking up one of your pieces on your turn shows its legal squares.
    onSelect(t, p, id) {
      const g = t.data, P = readPosition(t), from = P.b.findIndex((x) => x && x.id === id);
      if (g.over || g.promo || from < 0 || P.b[from].c !== g.turn || sideOf(t, p) !== g.turn) return t.hint(p, null);
      t.hint(p, { spaces: legalMoves(P).filter((m) => m.from === from).map((m) => square(m.to)) });
    },
    // Every drop of a piece: played if it is legal (true), else refused with the reason.
    handle(t, a) {
      if (a.t !== 'move') return; // strict refuses every other action
      const g = t.data, P = readPosition(t), from = P.b.findIndex((x) => x && x.id === a.id);
      if (from < 0) return; // not a chess piece (strict refuses it)
      const side = sideOf(t, a.p);
      if (g.over) return 'The game is over — press New game for another';
      if (!side) return 'Only the two players move the pieces';
      if (P.b[from].c !== side) return "That's not your piece";
      if (g.promo) return side === g.turn ? 'Choose what your pawn becomes first' : SIDE[g.turn] + ' is choosing what the pawn becomes';
      if (side !== g.turn) return "It's not your turn";
      if (!a.to) return 'Drop the piece on a square of the board';
      const to = index(a.to);
      if (to === from) return true; // put back where it was: no move
      const m = legalMoves(P).find((x) => x.from === from && x.to === to);
      if (!m) return whyNot(P, from, to);
      play(t, P, m, a.p);
      return true;
    },
    onAnswer(t, p, id, v) {
      const g = t.data, c = sideOf(t, p);
      if (id === 'promo' && g.promo) {
        t.remove(g.promo.id);
        t.spawn(g.box + '/' + g.turn + v, { at: g.promo.at, owner: 'seat:' + SEAT[g.turn] });
        g.promo = null;
        endTurn(t);
      } else if (id === 'draw' && g.offer) {
        if (v === 'Accept') return finish(t, null, 'Draw agreed');
        t.say(SIDE[other(g.offer)] + ' declines the draw');
        tellSide(t, g.offer, SIDE[other(g.offer)] + ' declines your draw offer');
        g.offer = null;
      } else if (id === 'resign' && v === 'Resign' && c && !g.over) {
        finish(t, other(c), SIDE[c] + ' resigns — ' + SIDE[other(c)] + ' wins');
      }
    },
    // Each player's buttons: offer a draw, resign; once the game is over, a new one.
    buttons(t) {
      const g = t.data, out = [];
      if (!g.ready) return out;
      if (g.over) return newButtons(t, occupant(t, 'w'), occupant(t, 'b'));
      for (const c of ['w', 'b']) {
        const pid = occupant(t, c);
        if (!pid) continue;
        if (!g.offer && occupant(t, other(c))) out.push({ id: 'draw-' + c, label: '½ Offer a draw', pid });
        out.push({ id: 'resign-' + c, label: '🏳 Resign', pid });
      }
      return out;
    },
    onButton(t, id, p) {
      const g = t.data, c = id.slice(-1), them = occupant(t, other(c));
      if (id.startsWith('new-')) return newGame(t); // (offered to the players and the host alone)
      if (id === 'draw-' + c && them) {
        g.offer = c;
        t.ask(them, { id: 'draw', prompt: SIDE[c] + ' offers a draw', options: ['Accept', 'Decline'] });
        t.say(SIDE[c] + ' offers a draw');
      }
      if (id === 'resign-' + c) t.ask(p, { id: 'resign', prompt: 'Resign this game?', options: ['Resign', 'Keep playing'] });
    },
    onJoin: (t) => showTurn(t),
    onAction: (t) => showTurn(t), // (after every action — a move, a button, an answer, a seat taken or left)
  };

  const FILES = 'abcdefgh', BACK_RANK = 'RNBQKBNR';
  const SIDE = { w: 'White', b: 'Black' }, SEAT = { w: 'white', b: 'black' };
  const NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
  // White's glyphs are the outlined ones, Black's the solid ones (the pawn
  // asks for its text form: iPhones draw a bare ♟ as an emoji).
  const GLYPHS = { w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' }, b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟\\uFE0E' } };
  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const SLIDES = { R: KING.filter(([x, y]) => !x || !y), B: KING.filter(([x, y]) => x && y), Q: KING };
  // Castling, by the king's landing square: its rook's [from, to]. And the
  // squares whose piece moving away (or being taken) loses a castling right.
  const ROOK_HOP = { 6: [7, 5], 2: [0, 3], 62: [63, 61], 58: [56, 59] };
  const LOSES = { 0: 'Q', 4: 'KQ', 7: 'K', 56: 'q', 60: 'kq', 63: 'k' };

  // Squares are numbered 0 (a1) to 63 (h8): file + 8 × rank.
  const index = (name) => FILES.indexOf(name[0]) + 8 * (name.slice(1) - 1);
  const square = (s) => FILES[s % 8] + (Math.floor(s / 8) + 1);
  const other = (c) => (c === 'w' ? 'b' : 'w');
  /** The square dx files and dy ranks away from s, or -1 off the board. */
  function step(s, dx, dy) {
    const f = (s % 8) + dx, r = Math.floor(s / 8) + dy;
    return f >= 0 && f < 8 && r >= 0 && r < 8 ? f + 8 * r : -1;
  }
  /** The player at side c's seat, or null. */
  const occupant = (t, c) => t.players().find((x) => x.seatId === SEAT[c])?.id ?? null;
  /** Player p's side, 'w' or 'b' — null for a watcher. */
  const sideOf = (t, p) => ({ white: 'w', black: 'b' })[t.players().find((x) => x.id === p)?.seatId] ?? null;
  /** Lights the seat of whoever is to move (nobody's once the game is over). */
  function showTurn(t) { t.public.turn = t.data.ready && !t.data.over ? occupant(t, t.data.turn) : null; }
  /** Tells the player at side c's seat msg (a toast on their screen alone), if anyone sits there. */
  function tellSide(t, c, msg) { const p = occupant(t, c); if (p) t.tell(p, msg); }
  /** "♻ New game" for each of the players pids and the host: a button each (a watcher has none). */
  const newButtons = (t, ...pids) => [...new Set([...pids, t.hostId].filter(Boolean))].map((pid) => ({ id: 'new-' + pid, label: '♻ New game', pid }));
  /** Takes every item that isn't of this game's box off the table, in one log line: the game lays
   *  out the whole table, and another game's board would stay the primary one (its addresses, not ours). */
  function clearOthers(t, box) { t.remove(t.items().filter((it) => !it.t?.startsWith(box + '/')).map((it) => it.id)); }

  /** The game's box: a drawn 8 × 8 board, and the twelve pieces as glyphs
   *  on round tokens that read upright on both players' screens. */
  function chessBox() {
    const board = { id: 'board', kind: 'board', name: 'Chessboard', w: 840, faces: [{ color: '#5c3a1e' }],
      grid: { type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, draw: 'checker', colors: ['#f0d9b5', '#b58863'], labels: 'chess' } };
    const pieces = ['w', 'b'].flatMap((c) => Object.keys(NAMES).map((k) => ({
      id: c + k, kind: 'token', name: SIDE[c] + ' ' + NAMES[k], shape: 'round', w: 88, stack: 'none', upright: true,
      faces: [{ color: c === 'w' ? '#f5f5f4' : '#1c1917', label: GLYPHS[c][k] }],
    })));
    return { name: 'Chess', pieces: [board, ...pieces] };
  }
  /** A new game: the 32 pieces in their places (any left from a game before
   *  go first), every question withdrawn, White to move. */
  function newGame(t) {
    const g = t.data, put = (c, k, s) => t.spawn(g.box + '/' + c + k, { at: square(s), owner: 'seat:' + SEAT[c] });
    for (const it of t.find({ kind: 'token' })) if (it.t.startsWith(g.box + '/')) t.remove(it.id);
    for (const p of t.players({ all: true })) t.cancelAsk(p.id);
    for (let f = 0; f < 8; f++) put('w', BACK_RANK[f], f);
    for (let f = 0; f < 8; f++) put('w', 'P', 8 + f);
    for (let f = 0; f < 8; f++) put('b', 'P', 48 + f);
    for (let f = 0; f < 8; f++) put('b', BACK_RANK[f], 56 + f);
    Object.assign(g, { turn: 'w', castle: 'KQkq', ep: null, half: 0, seen: {}, over: null, offer: null, promo: null });
    t.public.winners = [];
    remember(t, readPosition(t));
    showTurn(t);
  }
  /** The position as the table shows it: b[64] holds {c: 'w' | 'b', k: one
   *  of KQRBNP, id} or null; with t.data's side to move, castling rights
   *  ('KQkq', less those lost) and en-passant square (-1: none). */
  function readPosition(t) {
    const g = t.data, b = Array(64).fill(null);
    for (const it of t.find({ kind: 'token' })) {
      if (it.at && it.t.startsWith(g.box + '/')) b[index(it.at)] = { c: it.t.at(-2), k: it.t.at(-1), id: it.id };
    }
    return { b, turn: g.turn, castle: g.castle, ep: g.ep ? index(g.ep) : -1 };
  }

  // --- the moves -------------------------------------------------------------
  /** Every move of the side to move, its own king's safety aside: {from, to,
   *  cap (the square of the piece it takes, or -1), ep?, double?, promo?}. */
  function pseudoMoves(P) {
    const out = [], b = P.b, c = P.turn, fwd = c === 'w' ? 1 : -1;
    const add = (from, to, o) => out.push({ from, to, cap: b[to] ? to : -1, ...o });
    for (let from = 0; from < 64; from++) {
      const p = b[from];
      if (!p || p.c !== c) continue;
      if (p.k === 'P') {
        const one = step(from, 0, fwd), promo = Math.floor(one / 8) === (c === 'w' ? 7 : 0);
        if (one >= 0 && !b[one]) {
          add(from, one, { promo });
          const two = step(one, 0, fwd);
          if (Math.floor(from / 8) === (c === 'w' ? 1 : 6) && !b[two]) add(from, two, { double: true });
        }
        for (const dx of [-1, 1]) {
          const to = step(from, dx, fwd);
          if (to >= 0 && b[to] && b[to].c !== c) add(from, to, { promo });
          else if (to >= 0 && to === P.ep) out.push({ from, to, cap: to - 8 * fwd, ep: true });
        }
      } else if (p.k === 'N' || p.k === 'K') {
        for (const [dx, dy] of p.k === 'N' ? KNIGHT : KING) {
          const to = step(from, dx, dy);
          if (to >= 0 && b[to]?.c !== c) add(from, to);
        }
      } else {
        for (const [dx, dy] of SLIDES[p.k]) {
          for (let to = step(from, dx, dy); to >= 0 && b[to]?.c !== c; to = step(to, dx, dy)) {
            add(from, to);
            if (b[to]) break;
          }
        }
      }
    }
    return out;
  }
  /** The castlings of the side to move: the right kept, the squares between
   *  empty, the king neither in check nor passing an attacked square (where
   *  it lands, legalMoves checks). */
  function castlings(P) {
    const c = P.turn, home = c === 'w' ? 4 : 60, out = [];
    if (P.b[home]?.k !== 'K' || P.b[home].c !== c || inCheck(P.b, c)) return out;
    for (const [right, dir, between] of [['K', 1, [1, 2]], ['Q', -1, [1, 2, 3]]]) {
      if (P.castle.includes(c === 'w' ? right : right.toLowerCase()) && between.every((d) => !P.b[home + dir * d])
        && !attacked(P.b, home + dir, other(c))) out.push({ from: home, to: home + 2 * dir, cap: -1, castle: true });
    }
    return out;
  }
  /** Whether side c attacks square s on board b. */
  function attacked(b, s, c) {
    if (s < 0) return false;
    const has = (q, kinds) => q >= 0 && b[q]?.c === c && kinds.includes(b[q].k);
    if ([-1, 1].some((dx) => has(step(s, dx, c === 'w' ? -1 : 1), 'P'))) return true;
    if (KNIGHT.some(([dx, dy]) => has(step(s, dx, dy), 'N'))) return true;
    return KING.some(([dx, dy]) => {
      if (has(step(s, dx, dy), 'K')) return true;
      let q = step(s, dx, dy);
      while (q >= 0 && !b[q]) q = step(q, dx, dy);
      return has(q, dx && dy ? 'BQ' : 'RQ');
    });
  }
  const kingOf = (b, c) => b.findIndex((p) => p && p.c === c && p.k === 'K');
  const inCheck = (b, c) => attacked(b, kingOf(b, c), other(c));
  /** Board b after move m (a copy: b is left as it was). */
  function boardAfter(b0, m) {
    const b = b0.slice();
    if (m.cap >= 0) b[m.cap] = null;
    b[m.to] = b[m.from];
    b[m.from] = null;
    if (m.castle) { const [rf, rt] = ROOK_HOP[m.to]; b[rt] = b[rf]; b[rf] = null; }
    return b;
  }
  /** The legal moves of the side to move: those after which its king isn't attacked. */
  const legalMoves = (P) => [...pseudoMoves(P), ...castlings(P)].filter((m) => !inCheck(boardAfter(P.b, m), P.turn));
  /** Why moving from → to isn't legal, in a player's words. */
  function whyNot(P, from, to) {
    const p = P.b[from], c = p.c, home = c === 'w' ? 4 : 60;
    if (p.k === 'K' && from === home && Math.abs(to - from) === 2) {
      const dir = to > from ? 1 : -1, right = dir > 0 ? 'K' : 'Q';
      if (!P.castle.includes(c === 'w' ? right : right.toLowerCase())) return "You can't castle on that side any more: the king or that rook has moved";
      if ((dir > 0 ? [1, 2] : [1, 2, 3]).some((d) => P.b[home + dir * d])) return "You can't castle: there are pieces in the way";
      if (inCheck(P.b, c)) return "You can't castle out of check";
      return attacked(P.b, home + dir, other(c)) ? "You can't castle through check" : "You can't castle into check";
    }
    if (pseudoMoves(P).some((m) => m.from === from && m.to === to)) return inCheck(P.b, c) ? "You're in check — that move doesn't get you out of it" : 'That would leave your king in check';
    return 'The ' + NAMES[p.k] + " can't move there";
  }

  // --- playing a move, and the end of the game ---------------------------------
  /** Plays legal move m of player p on the table, then ends the turn — or
   *  first asks p what a pawn on the last rank becomes. */
  function play(t, P, m, p) {
    const g = t.data, piece = P.b[m.from];
    t.move(piece.id, square(m.to));
    if (m.cap >= 0) t.remove(P.b[m.cap].id);
    if (m.castle) { const [rf, rt] = ROOK_HOP[m.to]; t.move(P.b[rf].id, square(rt)); }
    for (const s of [m.from, m.to]) for (const r of LOSES[s] || '') g.castle = g.castle.replace(r, '');
    g.ep = m.double ? square((m.from + m.to) / 2) : null;
    g.half = piece.k === 'P' || m.cap >= 0 ? 0 : g.half + 1;
    if (g.offer) { // a move answers a draw offer, or withdraws the mover's own: it lapses
      for (const x of t.players({ all: true })) t.cancelAsk(x.id, 'draw');
      if (g.offer === g.turn) { // (the asked player's question vanished: both are told why)
        t.say(SIDE[g.turn] + ' moved: the draw offer is withdrawn');
        tellSide(t, g.turn, 'Your move withdrew your draw offer');
        tellSide(t, other(g.turn), SIDE[g.turn] + ' moved: the draw offer is withdrawn');
      } else {
        t.say('The draw offer lapses');
        tellSide(t, g.offer, 'Your draw offer lapses: ' + SIDE[g.turn] + ' moved');
      }
      g.offer = null;
    }
    if (m.promo) {
      g.promo = { id: piece.id, at: square(m.to) };
      return t.ask(p, { id: 'promo', prompt: 'Promote your pawn to', options: ['Q', 'R', 'B', 'N'].map((k) => ({ label: GLYPHS[g.turn][k], value: k })) });
    }
    endTurn(t);
  }
  /** Passes the move; then the game ends if the side to move is mated or
   *  stalemated, or a draw rule applies: a dead position, fifty moves with
   *  no capture or pawn move, a position seen for the third time. */
  function endTurn(t) {
    const g = t.data, mover = g.turn;
    g.turn = other(mover);
    const P = readPosition(t), moves = legalMoves(P), check = inCheck(P.b, g.turn), seen = remember(t, P, moves);
    if (!moves.length) return check ? finish(t, mover, 'Checkmate — ' + SIDE[mover] + ' wins') : finish(t, null, 'Stalemate — a draw');
    if (deadPosition(P.b)) return finish(t, null, 'Neither side can checkmate any more — a draw');
    if (g.half >= 100) return finish(t, null, 'Fifty moves without a capture or a pawn move — a draw');
    if (seen >= 3) return finish(t, null, 'The same position for the third time — a draw');
    if (check) t.announce(SIDE[g.turn] + ' is in check'); // (a banner: a phone's log is out of sight)
  }
  /** Counts position P in t.data.seen and returns how often it has come up.
   *  Its key: the pieces, the side to move, the castling rights, and the
   *  en-passant square while a capture there is legal. After a capture or a
   *  pawn move no earlier position can come back: the count starts afresh. */
  function remember(t, P, moves = legalMoves(P)) {
    const g = t.data;
    if (g.half === 0) g.seen = {};
    const key = P.b.map((p) => (p ? (p.c === 'w' ? p.k : p.k.toLowerCase()) : '.')).join('') + P.turn + P.castle + (moves.some((m) => m.ep) ? square(P.ep) : '');
    return (g.seen[key] = (g.seen[key] || 0) + 1);
  }
  /** Whether neither side can ever checkmate: kings and at most one knight
   *  or bishop, or only bishops all on squares of one colour (K+B v K+B
   *  with the bishops on opposite colours can still end in mate). */
  function deadPosition(b) {
    const minors = [];
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (!p || p.k === 'K') continue;
      if (p.k !== 'B' && p.k !== 'N') return false;
      minors.push({ k: p.k, shade: ((s % 8) + Math.floor(s / 8)) % 2 });
    }
    return minors.length <= 1 || minors.every((m) => m.k === 'B' && m.shade === minors[0].shade);
  }
  /** Ends the game: the winner ('w' or 'b'; null: a draw) gets 🏆, and every pending question goes. */
  function finish(t, winner, msg) {
    Object.assign(t.data, { over: msg, offer: null, promo: null });
    for (const p of t.players({ all: true })) t.cancelAsk(p.id);
    if (winner) t.win(occupant(t, winner), msg);
    else t.announce(msg);
  }
  return rules;
})()`,
  go9: goTemplate(9),
  go19: goTemplate(19),
  reversi: `(() => {
  // Reversi, the 19th-century game of discs that turn over, as a script
  // (ENGINE.md). Each player drags discs from their own pile onto the board:
  // a disc must outflank — close a line of the other colour between itself
  // and a disc of its own — and every line it closes turns over. A player
  // with no such square passes (said aloud); when neither has one, the
  // most discs win. The discs on the table are the position (readBoard);
  // t.data keeps whose turn it is and the result. Picking up your pile on
  // your turn hints where a disc may go (onSelect). Strict: nothing else moves.
  const rules = {
    name: 'Reversi',
    strict: true,
    setup(t) {
      if (t.data.ready) return; // enabled again: the game goes on where it was
      const box = t.newBox(reversiBox()), disc = box + '/disc';
      clearOthers(t, box);
      t.setTable({ shape: 'rect', w: 1000, h: 1360 }); // (room by each edge for a seat label and its player's buttons)
      t.setSeats([
        { id: 'dark', name: 'Dark', color: '#1c1917', edge: 'bottom' },
        { id: 'light', name: 'Light', color: '#f5f5f4', edge: 'top' },
      ]);
      if (!t.find({ type: box + '/board' }).length) t.spawn(box + '/board', { at: 'center' });
      // a pile for each player, by their own edge of the table (a supply: it never runs out)
      for (const [c, x, y] of [[DARK, 858, 1188], [LIGHT, 58, 88]]) {
        if (!t.find({ type: disc, owner: 'seat:' + SEAT[c] }).length) t.spawn(disc, { as: 'supply', f: c, owner: 'seat:' + SEAT[c], at: { x, y } });
      }
      Object.assign(t.data, { ready: true, box });
      newGame(t);
      t.say('Reversi: drag discs from your pile — picking it up shows where one may go. Dark moves first.');
    },
    // Picking up your pile on your turn shows where a disc may go.
    onSelect(t, p, id) {
      const g = t.data, it = t.item(id), c = sideOf(t, p);
      if (g.over || !it || it.k !== 's' || it.f !== c || c !== g.turn) return t.hint(p, null);
      const cells = readBoard(t).cells;
      t.hint(p, { spaces: cells.map((_, s) => s).filter((s) => flips(cells, s, c).length).map(square) });
    },
    // A disc taken from a pile and dropped on the board: placed if it outflanks, else refused.
    handle(t, a) {
      const g = t.data, it = t.item(a.id);
      if (!it?.t?.startsWith(g.box + '/')) return; // not this game's — a card, a pile, a bag too (strict refuses it)
      if (a.t !== 'take' || it.k !== 's') return a.t === 'move' && it.k === 'g' ? 'A disc stays where it is played' : undefined;
      const c = sideOf(t, a.p);
      if (g.over) return 'The game is over — press New game for another';
      if (c === null) return 'Only the two players play discs';
      if (it.f !== c) return 'Play from your own pile';
      if (c !== g.turn) return "It's not your turn";
      if (!a.to) return 'Put the disc on a square of the board';
      const B = readBoard(t), s = index(a.to);
      if (B.cells[s] !== null) return 'That square is taken';
      const turned = flips(B.cells, s, c);
      if (!turned.length) return 'A disc must outflank: close a line of the other colour';
      t.spawn(g.box + '/disc', { at: a.to, f: c, lock: true });
      t.setFace(turned.map((x) => B.ids[x]), c); // (one log line for the lot)
      nextTurn(t);
      return true;
    },
    buttons: (t) => (t.data.over ? newButtons(t, occupant(t, DARK), occupant(t, LIGHT)) : []),
    onButton(t, id) {
      if (id.startsWith('new-')) newGame(t); // (offered to the players and the host alone)
    },
    onJoin: (t) => show(t),
    onAction: (t) => show(t), // (after every action — a move, a button, a seat taken or left)
  };

  const DARK = 0, LIGHT = 1; // a side is the face its discs show
  const SIDE = ['Dark', 'Light'], SEAT = ['dark', 'light'], FILES = 'abcdefgh';
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  // Squares are numbered 0 (a1) to 63 (h8): file + 8 × rank.
  const index = (name) => FILES.indexOf(name[0]) + 8 * (name.slice(1) - 1);
  const square = (s) => FILES[s % 8] + (Math.floor(s / 8) + 1);
  /** The square dx files and dy ranks away from s, or -1 off the board. */
  function step(s, dx, dy) {
    const f = (s % 8) + dx, r = Math.floor(s / 8) + dy;
    return f >= 0 && f < 8 && r >= 0 && r < 8 ? f + 8 * r : -1;
  }
  /** The player at side c's seat, or null. */
  const occupant = (t, c) => t.players().find((x) => x.seatId === SEAT[c])?.id ?? null;
  /** Player p's side (DARK or LIGHT), or null for a watcher. */
  const sideOf = (t, p) => { const k = SEAT.indexOf(t.players().find((x) => x.id === p)?.seatId); return k < 0 ? null : k; };
  /** Lights the seat of whoever is to move (nobody's once the game is over),
   *  and shows each seated player's count of discs on their seat label. */
  function show(t) {
    const g = t.data, n = g.ready ? counts(readBoard(t).cells) : [0, 0], badges = {};
    for (const c of [DARK, LIGHT]) { const p = occupant(t, c); if (p) badges[p] = n[c] + (n[c] === 1 ? ' disc' : ' discs'); }
    Object.assign(t.public, { turn: g.ready && !g.over ? occupant(t, g.turn) : null, badges });
  }
  /** "♻ New game" for each of the players pids and the host: a button each (a watcher has none). */
  const newButtons = (t, ...pids) => [...new Set([...pids, t.hostId].filter(Boolean))].map((pid) => ({ id: 'new-' + pid, label: '♻ New game', pid }));
  /** Takes every item that isn't of this game's box off the table, in one log line: the game lays
   *  out the whole table, and another game's board would stay the primary one (its addresses, not ours). */
  function clearOthers(t, box) { t.remove(t.items().filter((it) => !it.t?.startsWith(box + '/')).map((it) => it.id)); }

  /** The game's box: a green 8 × 8 board, and one disc with two faces. */
  function reversiBox() {
    return { name: 'Reversi', pieces: [
      { id: 'board', kind: 'board', name: 'Reversi board', w: 840, faces: [{ color: '#14532d' }],
        grid: { type: 'square', cols: 8, rows: 8, cell: 100, x: 20, y: 20, draw: 'cells', colors: ['#15803d', '#052e16'], labels: 'chess' } },
      { id: 'disc', kind: 'token', name: 'Disc', shape: 'round', w: 84, stack: 'none',
        faces: [{ color: '#1c1917', name: 'Dark disc' }, { color: '#f5f5f4', name: 'Light disc' }] },
    ] };
  }
  /** A new game: the board cleared, the four centre discs crosswise (light
   *  on d4 and e5, dark on d5 and e4), Dark to move. */
  function newGame(t) {
    const g = t.data;
    for (const it of t.find({ type: g.box + '/disc' })) if (it.k === 'g') t.remove(it.id);
    for (const [at, f] of [['d4', LIGHT], ['e5', LIGHT], ['d5', DARK], ['e4', DARK]]) t.spawn(g.box + '/disc', { at, f, lock: true });
    Object.assign(g, { turn: DARK, over: null });
    t.public.winners = [];
    show(t);
  }
  /** The board as the table shows it: cells[64] (DARK, LIGHT or null) and the discs' ids. */
  function readBoard(t) {
    const cells = Array(64).fill(null), ids = Array(64).fill(null);
    for (const it of t.find({ type: t.data.box + '/disc' })) if (it.k === 'g' && it.at) { cells[index(it.at)] = it.f; ids[index(it.at)] = it.id; }
    return { cells, ids };
  }
  /** The discs a disc of side c on empty square s would turn over: in each
   *  direction, a run of the other side's discs closed by one of c's. */
  function flips(cells, s, c) {
    const out = [];
    if (cells[s] !== null) return out;
    for (const [dx, dy] of DIRS) {
      const run = [];
      let q = step(s, dx, dy);
      while (q >= 0 && cells[q] === 1 - c) { run.push(q); q = step(q, dx, dy); }
      if (q >= 0 && cells[q] === c) out.push(...run);
    }
    return out;
  }
  const canMove = (cells, c) => cells.some((_, s) => flips(cells, s, c).length > 0);
  /** After a move: the other side plays — or, with no square to play, passes
   *  (said aloud) — and when neither side can play, the game ends. */
  function nextTurn(t) {
    const g = t.data, cells = readBoard(t).cells, n = counts(cells), them = 1 - g.turn;
    if (canMove(cells, them)) g.turn = them;
    else if (canMove(cells, g.turn)) t.announce(SIDE[them] + ' has no move and passes — ' + SIDE[g.turn] + ' plays again');
    else {
      g.over = SIDE[DARK] + ' ' + n[DARK] + ' – ' + SIDE[LIGHT] + ' ' + n[LIGHT];
      if (n[DARK] === n[LIGHT]) t.announce(g.over + ': a draw');
      else { const w = n[DARK] > n[LIGHT] ? DARK : LIGHT; t.win(occupant(t, w), g.over + ': ' + SIDE[w] + ' wins'); }
    }
  }
  /** Each side's count of discs: [dark, light]. */
  const counts = (cells) => [DARK, LIGHT].map((c) => cells.filter((x) => x === c).length);
  return rules;
})()`,
};

/** Go on an n × n board (9 or 19), as a script: the same text for the same
 *  n, so the 🎲 picker knows the game that runs (currentGame compares code). */
export function goTemplate(n) {
  const cell = n === 9 ? 100 : 60;
  return `(() => {
  // Go on a ${n} × ${n} board, as a script (ENGINE.md). Each player drags
  // stones from their own bowl onto the points. handle() takes the drop:
  // the point must be free, the stone takes every group of the other colour
  // it leaves without a liberty (one log line, however many stones), it may not end
  // with no liberty itself (suicide), and it may not bring back the position
  // before the other player's last move (ko). Pass, Resign, and after two
  // passes in a row, Count: area scoring (stones plus the empty points only
  // one colour surrounds), komi 6.5 to White. There is no dead-stone
  // marking: capture the dead stones before you pass. The stones on the
  // table are the position (readBoard); t.data keeps whose turn it is, the
  // position before the last move (for ko), the passes and the result.
  // Tapping a stone shows its group's liberties (onSelect).
  const N = ${n}, CELL = ${cell};
  const rules = {
    name: 'Go ${n} × ${n}',
    strict: true,
    setup(t) {
      if (t.data.ready) return; // enabled again: the game goes on where it was
      const board = 2 * MARGIN + (N - 1) * CELL, W = board + 80, H = board + 2 * BAND, x = 50 + STONE / 2;
      const box = t.newBox(goBox(board));
      clearOthers(t, box);
      t.setTable({ shape: 'rect', w: W, h: H });
      t.setSeats([
        { id: 'black', name: 'Black', color: '#1c1917', edge: 'bottom' },
        { id: 'white', name: 'White', color: '#f5f5f4', edge: 'top' },
      ]);
      if (!t.find({ type: box + '/board' }).length) t.spawn(box + '/board', { at: 'center' });
      // a bowl for each player, by their own edge of the table (a supply: it never runs out)
      for (const [c, cx, cy] of [['b', W - x, H - BAND / 2], ['w', x, BAND / 2]]) {
        if (!t.find({ type: box + '/' + c, kind: 'supply' }).length) t.spawn(box + '/' + c, { as: 'supply', owner: 'seat:' + SEAT[c], at: { x: cx - STONE / 2, y: cy - STONE / 2 } });
      }
      Object.assign(t.data, { ready: true, box });
      newGame(t);
      t.say('Go: drag stones from your bowl onto the points; tap a stone to see its liberties. Black plays first.');
    },
    // Every stone played from a bowl: placed if it may be, else refused with the reason.
    handle(t, a) {
      const g = t.data, it = t.item(a.id);
      if (!it?.t?.startsWith(g.box + '/')) return; // not this game's — a card, a pile, a bag too (strict refuses it)
      if (a.t !== 'take' || it.k !== 's') return a.t === 'move' && it.k === 'g' ? 'A stone stays where it is played' : undefined;
      const c = it.t.at(-1), side = sideOf(t, a.p);
      if (g.over) return 'The game is over — press New game for another';
      if (!side) return 'Only the two players play stones';
      if (c !== side) return 'Play from your own bowl';
      if (side !== g.turn) return "It's not your turn";
      if (!a.to) return 'Put the stone on a point of the board';
      const B = readBoard(t), s = index(a.to), cells = B.cells.slice();
      if (cells[s]) return 'That point is taken';
      cells[s] = side;
      const taken = [];
      for (const q of around(s)) {
        if (cells[q] !== other(side)) continue;
        const grp = group(cells, q);
        if (!grp.libs.size) for (const x of grp.stones) { cells[x] = null; taken.push(x); }
      }
      if (!group(cells, s).libs.size) return 'Suicide: that stone would have no liberty';
      if (key(cells) === g.prev) return 'Ko: play elsewhere before you take back';
      t.spawn(g.box + '/' + side, { at: a.to, lock: true });
      t.remove(taken.map((x) => B.ids[x])); // (a capture is one log line, however many stones)
      Object.assign(g, { prev: key(B.cells), passes: 0, turn: other(side) });
      return true;
    },
    // Tapping a stone on the board shows its group and the group's liberties.
    onSelect(t, p, id) {
      const it = t.item(id), B = readBoard(t), s = it && it.k === 'g' && it.at ? index(it.at) : -1;
      if (s < 0 || !B.cells[s]) return t.hint(p, null);
      const grp = group(B.cells, s);
      t.hint(p, { items: grp.stones.map((x) => B.ids[x]), spaces: [...grp.libs].map(point) }); // (at most N × N ≤ 361 in all)
    },
    // Pass for the player to move, Resign for both; once both have passed, Count (or play on: no third pass).
    buttons(t) {
      const g = t.data, out = [], mover = occupant(t, g.turn);
      if (!g.ready) return out;
      if (g.over) return newButtons(t, occupant(t, 'b'), occupant(t, 'w'));
      if (mover && g.passes < 2) out.push({ id: 'pass', label: '⏭ Pass', pid: mover });
      for (const c of ['b', 'w']) {
        const pid = occupant(t, c);
        if (pid && g.passes >= 2) out.push({ id: 'count-' + c, label: '🧮 Count', pid });
        if (pid) out.push({ id: 'resign-' + c, label: '🏳 Resign', pid });
      }
      return out;
    },
    onButton(t, id, p) {
      const g = t.data;
      if (id.startsWith('new-')) return newGame(t); // (offered to the players and the host alone)
      if (id === 'pass' && sideOf(t, p) === g.turn && g.passes < 2) {
        Object.assign(g, { prev: key(readBoard(t).cells), passes: g.passes + 1, turn: other(g.turn) });
        t.announce(g.passes >= 2 ? 'Both players passed — press Count to score, or play on' : COLOR[other(g.turn)] + ' passes — ' + COLOR[g.turn] + ' to play');
      }
      if (id.startsWith('count-') && g.passes >= 2) count(t);
      if (id.startsWith('resign-')) t.ask(p, { id: 'resign', prompt: 'Resign this game?', options: ['Resign', 'Keep playing'] });
    },
    onAnswer(t, p, id, v) {
      const c = sideOf(t, p);
      if (id === 'resign' && v === 'Resign' && c && !t.data.over) finish(t, other(c), COLOR[c] + ' resigns — ' + COLOR[other(c)] + ' wins');
    },
    onJoin: (t) => showTurn(t),
    onAction: (t) => showTurn(t), // (after every action — a move, a button, an answer, a seat taken or left)
  };

  const COLOR = { b: 'Black', w: 'White' }, SEAT = { b: 'black', w: 'white' };
  const LETTERS = 'ABCDEFGHJKLMNOPQRST'; // (go skips I)
  // A stone's size; the board's margin, where its coordinates stand clear of
  // the stones on its edge; the room by each edge of the table, for a seat
  // label, its player's buttons and their bowl.
  const STONE = Math.round(CELL * 0.94), MARGIN = Math.round(CELL * 1.5), BAND = 260;
  const other = (c) => (c === 'b' ? 'w' : 'b');
  // Points are numbered 0 (A${n}, top left) to ${n * n - 1}: column + N × row from the top.
  const index = (a) => LETTERS.indexOf(a[0].toUpperCase()) + N * (N - a.slice(1));
  const point = (s) => LETTERS[s % N] + (N - Math.floor(s / N));
  /** The points next to s, on the board. */
  function around(s) {
    const x = s % N, out = [];
    if (x > 0) out.push(s - 1);
    if (x < N - 1) out.push(s + 1);
    if (s >= N) out.push(s - N);
    if (s < N * (N - 1)) out.push(s + N);
    return out;
  }
  /** The group of the stone on s: {stones, libs (a Set of the free points next to it)}. */
  function group(cells, s) {
    const stones = new Set([s]), libs = new Set();
    for (const x of stones) for (const q of around(x)) { if (!cells[q]) libs.add(q); else if (cells[q] === cells[s]) stones.add(q); }
    return { stones: [...stones], libs };
  }
  /** The position as one string, for ko: '.', 'b' or 'w' per point. */
  const key = (cells) => cells.map((c) => c || '.').join('');
  /** The player at side c's seat, or null. */
  const occupant = (t, c) => t.players().find((x) => x.seatId === SEAT[c])?.id ?? null;
  /** Player p's colour, 'b' or 'w' — null for a watcher. */
  const sideOf = (t, p) => ({ black: 'b', white: 'w' })[t.players().find((x) => x.id === p)?.seatId] ?? null;
  /** Lights the seat of whoever is to move (nobody's once the game is over). */
  function showTurn(t) { t.public.turn = t.data.ready && !t.data.over ? occupant(t, t.data.turn) : null; }
  /** "♻ New game" for each of the players pids and the host: a button each (a watcher has none). */
  const newButtons = (t, ...pids) => [...new Set([...pids, t.hostId].filter(Boolean))].map((pid) => ({ id: 'new-' + pid, label: '♻ New game', pid }));
  /** Takes every item that isn't of this game's box off the table, in one log line: the game lays
   *  out the whole table, and another game's board would stay the primary one (its addresses, not ours). */
  function clearOthers(t, box) { t.remove(t.items().filter((it) => !it.t?.startsWith(box + '/')).map((it) => it.id)); }

  /** The game's box: a drawn board of points (go's coordinates, its star
   *  points) and a stone of each colour. */
  function goBox(w) {
    const stars = N === 9 ? ['C3', 'G3', 'E5', 'C7', 'G7'] : ['D4', 'K4', 'Q4', 'D10', 'K10', 'Q10', 'D16', 'K16', 'Q16'];
    const stone = (c) => ({ id: c, kind: 'token', name: COLOR[c] + ' stone', shape: 'round', w: STONE, stack: 'none', faces: [{ color: c === 'b' ? '#1c1917' : '#f5f5f4' }] });
    return { name: 'Go ${n} × ${n}', pieces: [
      { id: 'board', kind: 'board', name: 'Go board', w, faces: [{ color: '#dcb35c' }],
        grid: { type: 'square', snap: 'point', cols: N, rows: N, cell: CELL, x: MARGIN, y: MARGIN, draw: 'lines', colors: ['#dcb35c', '#3f2a12'], labels: 'go', marks: stars } },
      stone('b'), stone('w'),
    ] };
  }
  /** A new game: the board cleared, every question withdrawn, Black to play. */
  function newGame(t) {
    const g = t.data;
    for (const c of ['b', 'w']) for (const it of t.find({ type: g.box + '/' + c })) if (it.k === 'g') t.remove(it.id);
    for (const p of t.players({ all: true })) t.cancelAsk(p.id);
    Object.assign(g, { turn: 'b', prev: '', passes: 0, over: null });
    t.public.winners = [];
    showTurn(t);
  }
  /** The board as the table shows it: cells[N × N] ('b', 'w' or null) and the stones' ids. */
  function readBoard(t) {
    const cells = Array(N * N).fill(null), ids = Array(N * N).fill(null);
    for (const c of ['b', 'w']) {
      for (const it of t.find({ type: t.data.box + '/' + c })) if (it.k === 'g' && it.at) { cells[index(it.at)] = c; ids[index(it.at)] = it.id; }
    }
    return { cells, ids };
  }
  /** Area scoring: each side's stones, plus the empty regions that only its
   *  stones border; komi 6.5 to White. The higher score wins (never a tie). */
  function count(t) {
    const cells = readBoard(t).cells, n = { b: 0, w: 6.5 }, seen = new Set();
    cells.forEach((c, s) => {
      if (c) n[c]++;
      if (c || seen.has(s)) return;
      const region = new Set([s]), borders = new Set();
      for (const x of region) for (const q of around(x)) { if (!cells[q]) region.add(q); else borders.add(cells[q]); }
      for (const x of region) seen.add(x);
      if (borders.size === 1) n[[...borders][0]] += region.size;
    });
    const w = n.b > n.w ? 'b' : 'w';
    finish(t, w, 'Black ' + n.b + ' – White ' + n.w + ' (komi 6.5): ' + COLOR[w] + ' wins by ' + Math.abs(n.b - n.w));
  }
  /** Ends the game: the winner ('b' or 'w') gets 🏆, and every pending question goes. */
  function finish(t, winner, msg) {
    t.data.over = msg;
    for (const p of t.players({ all: true })) t.cancelAsk(p.id);
    t.win(occupant(t, winner), msg);
  }
  return rules;
})()`;
}

/** One entry per shipped template (k = its RULES_TEMPLATES key; `clear`: the
 *  game builds its own board, so it starts on a cleared table with a fresh
 *  state), the box games (`box`: a BOXES key — set up on a cleared table,
 *  rules off), the free table (rules off) and a custom script (the 📜 dialog). */
export const GAMES = [
  { k: 'holdem', emoji: '🃏', title: "Texas Hold'em", short: "Hold'em", pitch: 'No-limit poker: chips, blinds, betting rounds, automatic showdown', players: '2–8 players' },
  { k: 'cah', emoji: '😈', title: 'Cards Against Humanity', pitch: 'Fill in the blank; the Card Czar crowns the funniest answer', players: '3+ players' },
  { k: 'bridge', emoji: '🤝', title: 'Bridge', pitch: 'Partners bid in the chat, then tricks, trumps, the dummy and scoring', players: '4 players' },
  { k: 'chess', emoji: '♟️', title: 'Chess', clear: true, pitch: 'Every rule enforced: pick a piece up to see its moves; castling, en passant, promotion, mate and the draws', players: '2 players' },
  { k: 'go9', emoji: '⚫', title: 'Go 9 × 9', short: 'Go 9×9', clear: true, pitch: 'Stones from your bowl onto the points; captures and ko enforced; pass twice, then Count', players: '2 players' },
  { k: 'go19', emoji: '⚪', title: 'Go 19 × 19', short: 'Go 19×19', clear: true, pitch: 'The full board: 361 points, area scoring, komi 6.5 (capture dead stones before passing)', players: '2 players' },
  { k: 'reversi', emoji: '🔘', title: 'Reversi', clear: true, pitch: 'Outflank to turn discs over; your pile shows where a disc may go; the most discs win', players: '2 players' },
  { k: 'draughts', emoji: '⛀', title: 'Draughts', box: 'draughts', pitch: 'Checkers on an 8 × 8 board, played by hand: move, jump, crown with a double-click', players: '2 players' },
  { k: 'backgammon', emoji: '🎲', title: 'Backgammon', box: 'backgammon', pitch: 'The race around the board, played by hand: two dice and the doubling cube', players: '2 players' },
  { k: 'turns', emoji: '🔁', title: 'Turn order', short: 'Turns', pitch: 'Any game you like, one player at a time', players: '2+ players' },
  { k: 'dealer', emoji: '🤵', title: 'Simple dealer', short: 'Dealer', pitch: 'A "Deal 1 to all" button and nothing enforced', players: 'any number' },
  { k: 'free', emoji: '🖐', title: 'Free table', pitch: 'No rules: deal, move and flip cards however you like', players: 'any number' },
  { k: 'custom', emoji: '📜', title: 'Custom script…', short: 'Custom…', pitch: 'Write or paste your own rules', players: '' },
];

// --- the built-in game boxes (spec §2g) -----------------------------------------
// Art-free classics, a few KB of JSON each, in the Box shape that core.js's
// cleanBox checks (faces shorthand and defaults included); their coordinates
// are computed by the small generators below. They enter a table's catalog
// only when the host loads one (loadBox).
const range = (n) => Array.from({ length: n }, (_, k) => k);

/** Draughts: an 8 × 8 board, 12 men a side on the dark squares (rows 0–2
 *  dark, 5–7 light, counted from the top), crowned by a flip (face 1: ♛). */
function draughts() {
  const W = 1400, H = 1200, B = 840, bx = (W - B) / 2, by = (H - B) / 2, cell = 100, o = 20, man = 80;
  /** A man's top-left on square (c, r), in table coordinates. */
  const at = (c, r) => [bx + o + c * cell + (cell - man) / 2, by + o + r * cell + (cell - man) / 2];
  const men = (rows, side) => rows.flatMap((r) => range(8).filter((c) => (c + r) % 2 === 1).map((c) => ({ piece: side, at: at(c, r), owner: `seat:${side}` })));
  const face = (color) => [{ color }, { color, label: '♛' }];
  return {
    name: 'Draughts',
    imgs: [],
    table: { shape: 'rect', w: W, h: H },
    seats: [{ id: 'light', name: 'Light', color: '#f5f5f4', edge: 'bottom' }, { id: 'dark', name: 'Dark', color: '#1c1917', edge: 'top' }],
    players: [2, 2],
    types: {
      board: {
        kind: 'board', name: 'Draughts board', w: B, faces: [{ color: '#5c3a1e' }],
        board: { grid: { type: 'square', cols: 8, rows: 8, cell, x: o, y: o, draw: 'checker', colors: ['#f0d9b5', '#b58863'], labels: 'chess' } },
      },
      light: { kind: 'token', name: 'Light man', w: man, stack: 'none', faces: face('#f5f5f4') },
      dark: { kind: 'token', name: 'Dark man', w: man, stack: 'none', faces: face('#1c1917') },
    },
    setup: [{ piece: 'board', at: 'center' }, ...men([5, 6, 7], 'light'), ...men([0, 1, 2], 'dark')],
  };
}

/** Backgammon: 24 points (light's numbering: light's home board is the
 *  bottom right, point 1 next to the trays), the bar, two trays, 15 checkers
 *  a side in the standard start, two dice side by side and the doubling cube.
 *  Checkers snap to a point (or the bar, or a tray) and fan along it (a
 *  point's `dir`: from its base toward its tip, spec §3g); the cube waits
 *  beside the board, off every space, so the checkers sent to the bar never
 *  fan in with it. */
function backgammon() {
  const W = 1800, H = 1300, BW = 1400, BH = 1000, bx = (W - BW) / 2, by = (H - BH) / 2, man = 80;
  /** Point k's column centre, board-local (the bar is at 610–690, the trays right of 1300). */
  const colX = (k) => (k <= 6 ? 1240 - 100 * (k - 1) : k <= 12 ? 560 - 100 * (k - 7) : k <= 18 ? 60 + 100 * (k - 13) : 740 + 100 * (k - 19));
  const top = (k) => k > 12;
  const spaces = range(24).map((j) => {
    const k = j + 1;
    return { id: `p${k}`, x: colX(k), y: top(k) ? 220 : 780, r: 200, mark: 'tri', w: 100, h: 420, dir: top(k) ? 'down' : 'up', color: k % 2 ? '#b91c1c' : '#f1e4c3' };
  });
  // The bar and the trays fan their checkers too: on the bar, from its top
  // end down, so a checker of each colour sent there shows (and a press takes
  // the player's own, D115); in a tray, from its outer end toward the middle.
  spaces.push(
    { id: 'bar', x: 650, y: 500, r: 200, mark: 'rect', w: 80, h: 980, dir: 'down', color: '#2b1a0c' },
    { id: 'off-dark', x: 1345, y: 250, r: 120, mark: 'rect', w: 90, h: 480, dir: 'down', color: '#2b1a0c' },
    { id: 'off-light', x: 1345, y: 750, r: 120, mark: 'rect', w: 90, h: 480, dir: 'up', color: '#2b1a0c' },
  );
  /** n checkers of `side` on point k, from its base toward the board's middle. */
  const point = (k, n, side) => ({
    piece: side, owner: `seat:${side}`, count: n, spread: [0, top(k) ? man : -man],
    at: [bx + colX(k) - man / 2, by + (top(k) ? 10 : BH - 10 - man)],
  });
  return {
    name: 'Backgammon',
    imgs: [],
    table: { shape: 'rect', w: W, h: H },
    seats: [{ id: 'light', name: 'Light', color: '#f5f5f4', edge: 'bottom' }, { id: 'dark', name: 'Dark', color: '#1c1917', edge: 'top' }],
    players: [2, 2],
    types: {
      board: { kind: 'board', name: 'Backgammon board', w: BW, h: BH, faces: [{ color: '#4a2e17' }], board: { spaces } },
      light: { kind: 'token', name: 'Light checker', w: man, stack: 'none', faces: [{ color: '#f5f5f4' }] },
      dark: { kind: 'token', name: 'Dark checker', w: man, stack: 'none', faces: [{ color: '#1c1917' }] },
      die: { kind: 'die', name: 'Die' },
      cube: { kind: 'token', name: 'Doubling cube', shape: 'rect', w: 64, stack: 'none', faces: ['64', '2', '4', '8', '16', '32'] },
    },
    setup: [
      { piece: 'board', at: 'center' },
      point(24, 2, 'light'), point(13, 5, 'light'), point(8, 3, 'light'), point(6, 5, 'light'),
      point(1, 2, 'dark'), point(12, 5, 'dark'), point(17, 3, 'dark'), point(19, 5, 'dark'),
      { piece: 'die', count: 2, spread: [64, 0], at: [bx + 960, by + BH / 2 - 28] },
      { piece: 'cube', at: [bx + BW + (W - bx - BW) / 2 - 32, H / 2 - 32] },
    ],
  };
}

/** The built-in boxes, by key: what the 🎲 picker's box games load (built
 *  in by content, core.js isBuiltin). */
export const BOXES = { draughts: draughts(), backgammon: backgammon() };
