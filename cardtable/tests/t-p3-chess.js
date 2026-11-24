// Phase 3C, chess on real screens (spec §3l t-p3-chess; §3g "The demos":
// Chess; D160–D166). Alice hosts on a desktop (1280 × 800, the mouse), Bob
// plays on an iPhone 13 held upright (a finger, motion on), and Carol joins
// on one held sideways (motion on) to watch. Every move a player makes is a
// real drag on their own screen; __ct.act only sets up the stalemate's
// position and forges what a client never sends (an opponent's piece, a
// removal). The expectations are the laws of chess and the spec:
//  1. 🎲 Chess: the 32 pieces in their places on both screens, seats White
//     and Black (each player's own edge at the bottom), strict; a tap hints
//     a piece's legal squares on that player's screen alone.
//  2. Illegal moves are refused with a toast and snap back — off turn, an
//     opponent's piece (a drag on it pans the view, as for any piece a
//     player may not handle; a forged move is refused), a blocked path, a
//     move into check — and the opening moves by drag show on both screens.
//  3. Castling on both sides moves the rook; a watcher joins.
//  4. A draw offer is the opponent's ask; it lapses when the offerer moves;
//     Accept ends the game, a draw.
//  5. Castling out of check and through check refused; Resign gives the
//     other seat 🏆.
//  6. Fool's mate: 🏆 and confetti.
//  7. En passant; promotion through the ask, choosing ♘, with a host reload
//     while it is pending; a guest's forged `del` is not a move in this
//     game; then a threefold repetition (the knights out and back twice), an
//     automatic draw.
//  8. Loyd's stalemate, its last move by drag: a draw.
// Screenshots: shots/p3-chess-*.png.
'use strict';
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const S = require('./p3-lib');
const { shot } = require('./fun-lib');
const { pickGame } = require('./stones-lib');

const { devices } = h.playwright;
const J = JSON.stringify;
const FILES = 'abcdefgh', BACK = 'RNBQKBNR';
/** The start position, {square: type id} (wK, bP …). */
const START = Object.fromEntries([...FILES].flatMap((f, k) => [[`${f}1`, `w${BACK[k]}`], [`${f}2`, 'wP'], [`${f}7`, 'bP'], [`${f}8`, `b${BACK[k]}`]]));
/** A position ({square: type id}) as text that ignores the order of its squares. */
const posText = (pos) => J(Object.entries(pos).sort());

/** Init script: what this screen showed, though each toast and banner
 *  replaces the last — window.__cues: {toasts, anns (texts), bursts (each
 *  confetti burst's number of pieces)}. */
function cues() {
  const C = (window.__cues = { toasts: [], anns: [], bursts: [] });
  document.addEventListener('DOMContentLoaded', () => {
    for (const [id, list] of [['toast', C.toasts], ['announce', C.anns]]) {
      const el = document.getElementById(id);
      new MutationObserver(() => el.textContent && list.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    }
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('confetti')) C.bursts.push(n.childElementCount);
    }).observe(document.body, { childList: true });
  });
}

(async () => {
  const env = await h.start();
  /** A player in their own context (`ctx`: a device), with cues and p3-lib's actTap; `pid`, `who`, `touch`. */
  async function join(name, url, ctx) {
    const p = await env.page(name, ctx && { ctx });
    await p.addInitScript(cues);
    await p.addInitScript(S.actTap);
    await p.goto(url);
    await h.joinAs(p, name);
    await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
    Object.assign(p, { pid: await p.evaluate(() => localStorage.getItem('ct-pid')), who: name, touch: !!ctx?.hasTouch });
    return p;
  }
  const alice = await join('Alice', env.url);
  const bob = await join('Bob', alice.url(), { ...devices['iPhone 13'], reducedMotion: 'no-preference' });
  const pages = [alice, bob]; // the screens every move must reach (Carol's too, once she joins)
  let W, B, carol; // White's page and Black's (the rules seat them), and the watcher's

  // --- reading the screens ---------------------------------------------------
  /** Page p's position: {square: type id}. */
  const position = (p) => P.viewOf(p, 'Object.fromEntries(Object.values(v.items).filter((it) => it.at).map((it) => [it.at, it.t.slice(it.t.indexOf("/") + 1)]))');
  /** The type id (wR, bP …) of the piece on square `sq` in page p's view, or null. */
  const typeOn = (p, sq) => P.viewOf(p, 'Object.values(v.items).find((it) => it.at === a)?.t.split("/")[1] ?? null', sq);
  /** The id of the piece on square `sq` in page p's view, or null. */
  const pieceAt = (p, sq) => P.viewOf(p, 'Object.keys(v.items).find((id) => v.items[id].at === a) ?? null', sq);
  /** The centre of square `sq` on page p's screen (client px). */
  const squarePt = async (p, sq) => { const r = await p.evaluate((a) => window.__ct.resolve(a), sq); return S.screenOf(p, r.x, r.y); };
  /** How far (px) piece `id` is drawn from the centre of square `sq` on page
   *  p, once a glide or a snap back has ended (≤ 3 px, or after `ms`). */
  async function drawnOff(p, id, sq, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      const c = await S.centreOf(p, id), d = c ? S.dist(c, await squarePt(p, sq)) : Infinity;
      if (d <= 3 || Date.now() > end) return Math.round(d * 10) / 10;
      await h.sleep(100);
    }
  }
  const mark = (p) => p.evaluate(() => ({ toasts: window.__cues.toasts.length, anns: window.__cues.anns.length, bursts: window.__cues.bursts.length }));
  /** The `k` cues (toasts, anns, bursts) page p showed since mark m. */
  const since = (p, m, k) => p.evaluate(([m, k]) => window.__cues[k].slice(m[k]), [m, k]);
  /** The first `k` cue since mark m on page p matching `re`, once shown (null after ms). */
  const cue = (p, m, k, re, ms = 8000) => p.waitForFunction(([m, k, src, fl]) => window.__cues[k].slice(m[k]).find((x) => new RegExp(src, fl).test(x)), [m, k, re.source, re.flags], { timeout: ms })
    .then((x) => x.jsonValue(), () => null);
  /** The seat labels on page p that carry 🏆. */
  const trophies = (p) => p.evaluate(() => [...document.querySelectorAll('.seat')].filter((el) => el.textContent.includes('🏆')).map((el) => el.textContent));
  /** Page p's open ask: {prompt, options (labels)}, or null when no panel shows. */
  const askOf = (p) => p.evaluate(() => (document.getElementById('ask').classList.contains('hidden') ? null
    : { prompt: document.getElementById('ask-prompt').textContent, options: [...document.querySelectorAll('#ask-body button[data-k]')].map((b) => b.textContent) }));
  const askShows = (p, re, ms = 10000) => p.waitForFunction(([src, fl]) => !document.getElementById('ask').classList.contains('hidden') && new RegExp(src, fl).test(document.getElementById('ask-prompt').textContent), [re.source, re.flags], { timeout: ms }).then(() => true, () => false);
  const askGone = (p, ms = 10000) => p.waitForFunction(() => document.getElementById('ask').classList.contains('hidden'), null, { timeout: ms }).then(() => true, () => false);
  const press = async (p, sel) => (p.touch ? p.locator(sel).tap() : p.locator(sel).click());
  /** Page p answers its ask with the option labelled `label` (a tap on a phone). */
  const answer = (p, label) => press(p, `#ask-body button[data-k]:text-is("${label}")`);
  /** Page p presses its rules button labelled `text`. */
  const button = (p, text) => press(p, `#rules-btns button:has-text("${text}")`);
  const turn = () => P.viewOf(alice, 'v.rules?.public?.turn ?? null');

  // --- moving ------------------------------------------------------------------
  /** Page p's pointer presses item `id` at its drawn centre, moves over
   *  square `sq`, settles there 120 ms and lets go — the mouse, or a finger on
   *  a phone. (A finger lifted while still moving starts a fling in the
   *  emulated phone, and its next tap then only stops the fling: no click.) */
  async function swipe(p, id, sq) {
    const pts = S.steps(await S.centreOf(p, id), await squarePt(p, sq), 10);
    pts.at(-1).wait = 120;
    await S.gesture(p, pts, { touch: p.touch });
  }
  /** Page p drags the piece on `from` over square `to` (swipe). Its id. */
  async function drag(p, from, to) {
    const id = await pieceAt(p, from);
    if (!id) throw new Error(`${p.who}: no piece on ${from} (${J(await position(p))})`);
    await swipe(p, id, to);
    return id;
  }
  /** Page p sends, through __ct.act, the move of item `id` onto square `sq` a drop there would send (what a client may forge). */
  const forgeMove = async (p, id, sq) => p.evaluate(([id, c]) => window.__ct.act({ t: 'move', id, x: c.x - 44, y: c.y - 44 }), [id, await p.evaluate((a) => window.__ct.resolve(a), sq)]);
  /** Whether page p sent nothing that moves item `id` since its action count n (p3-lib's actTap). */
  const sentNothing = (p, n, id) => p.evaluate(([n, id]) => !window.__acts.slice(n).some((x) => x.a.id === id && ['move', 'drag'].includes(x.a.t)), [n, id]);
  /** Whether piece `id` stands on `to` on every screen (within 10 s). */
  const reached = async (id, to) => (await Promise.all(pages.map((q) => P.waitView(q, 'v.items[a.id]?.at === a.to', { id, to }, 10000)))).every(Boolean);
  /** The page of the player to move. */
  const mover = async () => { const t = await turn(); return pages.find((p) => p.pid === t) || null; };
  /** Plays moves "e2e4 e7e5 …", each by the player to move, dragged on their
   *  screen, each awaited on every screen: null, or the move that failed. */
  async function line(moves) {
    for (const m of moves.split(' ')) {
      const p = await mover(), id = p && await drag(p, m.slice(0, 2), m.slice(2, 4));
      if (!id || !(await reached(id, m.slice(2, 4)))) return `${m} (by ${p?.who ?? 'nobody: no turn'})`;
    }
    return null;
  }
  /** Checks that `moves` are all played (a section's moves that set up the position under test). */
  const plays = async (moves, what) => { const bad = await line(moves); ok(!bad, `${what}: ${moves} — played by drag, on every screen${bad ? ` (stuck at ${bad})` : ''}`); };
  /** Page p taps its piece on `sq` (on its turn): the rules hint its legal squares `want` ("f3,h3") on p's screen, and on nobody else's. */
  async function hinted(p, sq, want) {
    await P.clickItem(p, await pieceAt(p, sq), p.touch);
    ok(await P.waitView(p, 'v.hint && [...(v.hint.spaces || [])].sort().join() === a', want, 8000), `${p.who} taps the ${sq} knight: the rules hint ${want} (${J(await P.viewOf(p, 'v.hint'))})`);
    ok(await p.waitForFunction((n) => document.querySelectorAll('#table > .hint-layer circle').length === n, want.split(',').length, { timeout: 5000 }).then(() => true, () => false), `the marks show on ${p.who}'s board`);
    for (const q of pages.filter((x) => x !== p)) ok(!(await P.viewOf(q, 'v.hint')) && !(await q.$('#table > .hint-layer')), `${q.who}'s screen shows no hint`);
    await shot(p, `p3-chess-hint-${p.touch ? 'phone' : 'desk'}`);
  }
  /** An illegal move: page p drags from → to; refused with a 🚫 toast on p's
   *  screen matching `why`; the piece snaps back to `from` on every screen;
   *  nothing on the board changed. */
  async function refused(p, from, to, why, what) {
    const before = await position(alice), m = await mark(p), t0 = await turn();
    const id = await drag(p, from, to);
    const toast = await cue(p, m, 'toasts', /🚫/);
    ok(toast && why.test(toast), `${what}: refused, a toast on ${p.who}'s screen ("${toast}")`);
    const off = await Promise.all(pages.map((q) => drawnOff(q, id, from)));
    ok(off.every((d) => d <= 3), `${what}: the piece snaps back to ${from} on every screen (${pages.map((q, k) => `${q.who} ${off[k]} px`).join(', ')})`);
    const after = await Promise.all(pages.map(position));
    ok(after.every((x) => posText(x) === posText(before)) && await turn() === t0, `${what}: the board and the turn are as they were, everywhere`);
  }

  section('1. 🎲 Chess: the pieces in their places on both screens, White and Black seated, strict; a tap hints a piece\'s legal squares');
  {
    const asked = await pickGame(alice, 'chess');
    ok(/clear/i.test(asked || ''), `🎲 Chess on a table with a deck on it asks first ("${asked}")`);
    const laid = await Promise.all(pages.map((p) => P.waitView(p, 'v.rules?.enabled && Object.values(v.items).filter((it) => it.at).length === 32', null, 30000)));
    ok(laid.every(Boolean), 'chess runs, 32 pieces on the board on both screens');
    for (const p of pages) {
      const pos = await position(p);
      ok(posText(pos) === posText(START), `${p.who}'s screen: the start position (${Object.keys(pos).length} pieces: ${posText(pos).slice(0, 80)}…)`);
    }
    const owners = await P.viewOf(alice, 'Object.values(v.items).filter((it) => it.at).every((it) => it.owner === "seat:" + (it.t.split("/")[1][0] === "w" ? "white" : "black"))');
    ok(owners, 'each piece belongs to its side\'s seat (seat:white, seat:black)');
    const seats = await P.viewOf(alice, 'Object.fromEntries(Object.entries(v.players).map(([p, pl]) => [pl.seatId ?? "none", p]))');
    [W, B] = [pages.find((p) => p.pid === seats.white), pages.find((p) => p.pid === seats.black)];
    ok(W && B && W !== B, `Alice and Bob sit as White and Black (White: ${W?.who}, Black: ${B?.who})`);
    ok(await turn() === W.pid, 'White is to move: the turn cue lights White\'s seat');
    for (const p of pages) {
      const [own, far] = await Promise.all([squarePt(p, p === W ? 'e1' : 'e8'), squarePt(p, p === W ? 'e8' : 'e1')]);
      ok(own.y > far.y, `${p.who}'s own side of the board is at the bottom of their screen (their king's square at y ${Math.round(own.y)}, the other's at ${Math.round(far.y)})`);
      ok(await p.waitForFunction(() => /strict/.test(document.getElementById('rules-btn').title), null, { timeout: 10000 }).then(() => true, () => false), `${p.who}'s 📜 button says the rules are strict`);
    }
    await shot(alice, 'p3-chess-start-desk');
    await shot(bob, 'p3-chess-start-phone');
    await hinted(W, 'g1', 'f3,h3');
  }

  section('2. Illegal moves are refused with a toast and snap back; the opening moves by drag reach both screens');
  {
    await refused(B, 'e7', 'e5', /turn/, `off turn: ${B.who} (Black) moves before White`);
    // An opponent's piece: a drag on it pans the view (spec §3g: a drag on an item the player may not handle) …
    const pawn = await pieceAt(W, 'd7'), n0 = await W.evaluate(() => window.__acts.length), tf0 = await P.tf(W);
    await swipe(W, pawn, 'd5');
    await h.sleep(600);
    const tf1 = await P.tf(W);
    ok(await sentNothing(W, n0, pawn) && (tf1.px !== tf0.px || tf1.py !== tf0.py), `${W.who} drags Black's d7 pawn: nothing is sent, the view pans instead (${J(tf0)} → ${J(tf1)})`);
    ok((await Promise.all(pages.map((p) => pieceAt(p, 'd7')))).every((x) => x === pawn), 'the pawn is still on d7 everywhere');
    await press(W, '#view-btn');
    // … and a forged move of it (a terminal or a doctored page could send one) is refused
    const m = await mark(W), before = await position(alice);
    await forgeMove(W, pawn, 'd5');
    const toast = await cue(W, m, 'toasts', /🚫/);
    ok(toast && /piece/.test(toast), `a forged move of Black's d7 pawn by ${W.who} (White, on turn) is refused: "${toast}"`);
    ok(posText(await position(alice)) === posText(before) && await P.waitView(B, 'v.items[a]?.at === "d7"', pawn, 3000), 'the pawn stays on d7 on both screens');

    const e2 = await drag(W, 'e2', 'e4');
    ok(await reached(e2, 'e4'), `${W.who} drags e2 → e4 (${W.touch ? 'a finger' : 'the mouse'}): the pawn stands on e4 on both screens`);
    for (const p of pages) {
      ok(await drawnOff(p, e2, 'e4') <= 3 && !(await pieceAt(p, 'e2')), `${p.who}'s screen draws it on e4, e2 empty`);
      ok(await p.waitForFunction(() => window.__ct.log().some((e) => /e2 → e4/.test(e.txt)), null, { timeout: 5000 }).then(() => true, () => false), `${p.who}'s log says e2 → e4`);
    }
    ok(await turn() === B.pid, 'Black to move');
    await hinted(B, 'g8', 'f6,h6');
    const e7 = await drag(B, 'e7', 'e5');
    ok(await reached(e7, 'e5'), `${B.who} drags e7 → e5 (${B.touch ? 'a finger, on the iPhone' : 'the mouse'}): on both screens`);
    ok((await Promise.all(pages.map((p) => drawnOff(p, e7, 'e5')))).every((d) => d <= 3) && await turn() === W.pid, 'drawn on e5 on both, and White is to move');
    await refused(W, 'a1', 'a4', /can.t move there/, 'a blocked path: the a1 rook through the a2 pawn');
    await plays('g1f3 b8c6 f1c4 f8b4', '2. Nf3 Nc6 3. Bc4 Bb4 (the bishop pins the d2 pawn to White\'s king)');
    await refused(W, 'd2', 'd4', /check/, 'a move into check: the pinned d2 pawn steps off the pin');
  }

  section('3. Castling on both sides moves the rook; Carol joins and watches');
  {
    const k = await drag(W, 'e1', 'g1');
    ok(await reached(k, 'g1'), 'White drags the king e1 → g1: castling short');
    const r1 = await Promise.all(pages.map(async (p) => [await typeOn(p, 'f1'), await typeOn(p, 'h1')]));
    ok(r1.every(([f1, h1]) => f1 === 'wR' && h1 === null), `the h1 rook has moved to f1, on both screens (f1, h1: ${J(r1)})`);
    for (const p of pages) ok(await p.evaluate(() => window.__ct.log().some((e) => /h1 → f1/.test(e.txt))), `${p.who}'s log has the rook's h1 → f1`);
    await plays('d7d6 h2h3 c8e6 d2d3 d8d7 a2a3', '4… d6 5. h3 Be6 6. d3 Qd7 7. a3');
    const bk = await drag(B, 'e8', 'c8');
    ok(await reached(bk, 'c8'), `Black drags the king e8 → c8 on ${B.who}'s screen: castling long`);
    const r2 = await Promise.all(pages.map(async (p) => [await typeOn(p, 'd8'), await typeOn(p, 'a8')]));
    ok(r2.every(([d8, a8]) => d8 === 'bR' && a8 === null), `the a8 rook has moved to d8, on both screens (d8, a8: ${J(r2)})`);
    await shot(alice, 'p3-chess-castled-desk');
    await shot(bob, 'p3-chess-castled-phone');

    carol = await join('Carol', alice.url(), { ...devices['iPhone 13 landscape'], reducedMotion: 'no-preference' });
    const me = await P.viewOf(alice, 'v.players[a]', carol.pid);
    ok(me && me.seat === null && !me.seatId, `Carol joins as a watcher: no seat (${J(me)})`);
    ok(J(await P.viewOf(alice, '[v.players[a[0]].seatId, v.players[a[1]].seatId]', [W.pid, B.pid])) === J(['white', 'black']), 'White and Black keep their seats');
    ok(await P.waitView(carol, 'Object.values(v.items).filter((it) => it.at).length === 32', null, 15000) && posText(await position(carol)) === posText(await position(alice)), 'she sees the game as it stands');
    ok(await carol.evaluate(() => document.getElementById('rules-btns').querySelectorAll('button').length === 0), 'she has no buttons of a player (no draw offer, no resign)');
    const wp = await pieceAt(carol, 'a3'), n0 = await carol.evaluate(() => window.__acts.length);
    await swipe(carol, wp, 'a4');
    await h.sleep(600);
    ok(await sentNothing(carol, n0, wp), 'a drag of a white pawn on her screen sends nothing (the view pans)');
    await press(carol, '#view-btn');
    const m = await mark(carol);
    await forgeMove(carol, wp, 'a4');
    const toast = await cue(carol, m, 'toasts', /🚫/);
    ok(toast && await pieceAt(alice, 'a3') === wp, `and a forged move by her is refused: "${toast}", the pawn still on a3`);
    pages.push(carol);
  }

  section('4. A draw offer is the opponent\'s ask; it lapses when the offerer moves; Accept ends the game, a draw (no 🏆)');
  {
    await button(W, 'Offer a draw');
    ok(await askShows(B, /draw/i), `White offers a draw: ${B.who}'s screen asks (${J(await askOf(B))})`);
    ok(J((await askOf(B))?.options) === J(['Accept', 'Decline']), 'Accept or Decline');
    for (const p of [W, carol]) ok(!(await askOf(p)), `${p.who} sees no ask`);
    await shot(B, 'p3-chess-draw-ask');
    await plays('b1c3', 'White moves on instead (8. Nc3)');
    ok(await askGone(B), 'the offer lapses: Black\'s ask is gone');
    ok(await turn() === B.pid, 'Black to move');
    await button(B, 'Offer a draw');
    ok(await askShows(W, /draw/i), `Black offers a draw: ${W.who}'s screen asks`);
    for (const p of [B, carol]) ok(!(await askOf(p)), `${p.who} sees no ask`);
    const marks = await Promise.all(pages.map(mark));
    await answer(W, 'Accept');
    const anns = await Promise.all(pages.map((p, k) => cue(p, marks[k], 'anns', /draw/i)));
    ok(anns.every(Boolean), `${W.who} accepts: the game ends in a draw, announced on every screen (${J(anns)})`);
    ok((await Promise.all(pages.map(trophies))).every((t) => !t.length), 'a draw: no 🏆 on any seat');
    ok(await turn() === null, 'nobody is to move');
    const before = await position(alice);
    const m = await mark(B);
    await drag(B, 'a7', 'a6');
    ok(await cue(B, m, 'toasts', /🚫/) && posText(await position(alice)) === posText(before), 'a move after the end is refused');
    const old = await position(alice), mc = await mark(carol);
    await button(carol, 'New game');
    await h.sleep(1500);
    ok(posText(await position(alice)) === posText(old) && (await since(carol, mc, 'toasts')).length > 0, `the watcher's "New game" starts nothing (${J(await since(carol, mc, 'toasts'))})`);
  }

  /** Presses "New game" on page p: the start position everywhere, White to move. */
  async function newGame(p) {
    const n0 = await p.evaluate(() => window.__acts.length);
    await button(p, 'New game');
    const fresh = await Promise.all(pages.map((q) => P.waitView(q, 'Object.values(v.items).filter((it) => it.at).length === 32 && v.rules?.public?.turn === a', W.pid, 15000)));
    const wrong = (await Promise.all(pages.map(position))).filter((x) => posText(x) !== posText(START)).length;
    ok(fresh.every(Boolean) && !wrong, `${p.who} presses "♻ New game": the start position on every screen, White to move${fresh.every(Boolean) && !wrong ? ''
      : ` (${J(fresh)}, ${wrong} screens off; the turn: ${await turn()}, the buttons: ${J(await P.viewOf(alice, 'v.rules?.public?.buttons'))}; ${p.who} sent ${J(await p.evaluate((n) => window.__acts.slice(n).map((x) => x.a), n0))})`}`);
    if (!fresh.every(Boolean)) await shot(p, 'p3-chess-newgame-failed');
  }

  section('5. Castling out of check and through check are refused; Resign gives the other seat 🏆');
  {
    await newGame(W);
    await plays('g2g3 d7d5 f1h3 c8h3 g1f3 e7e6', '1. g3 d5 2. Bh3 Bxh3 3. Nf3 e6 (the h3 bishop covers f1)');
    await refused(W, 'e1', 'g1', /castle.*through check/, 'castling through check (f1 attacked)');
    await plays('d2d4 f8b4', '4. d4 Bb4+');
    await refused(W, 'e1', 'g1', /castle.*out of check/, 'castling out of check');
    await plays('c2c3', '5. c3');
    const marks = await Promise.all(pages.map(mark));
    await button(B, 'Resign');
    ok(await askShows(B, /resign/i), `${B.who} presses Resign: asked to confirm (${J(await askOf(B))})`);
    await answer(B, 'Resign');
    const won = await Promise.all(pages.map((p) => p.waitForFunction((n) => [...document.querySelectorAll('.seat')].some((el) => el.textContent.startsWith('🏆') && el.textContent.includes(n)), W.who, { timeout: 10000 }).then(() => true, () => false)));
    ok(won.every(Boolean), `${B.who} resigns: ${W.who} (White) gets 🏆 on every screen`);
    ok((await Promise.all(pages.map(trophies))).every((t) => t.length === 1), `and nobody else (${J(await trophies(alice))})`);
    const anns = await Promise.all(pages.map((p, k) => cue(p, marks[k], 'anns', /resign/i)));
    ok(anns.every(Boolean), `announced on every screen (${J(anns[0])})`);
  }

  section('6. Fool\'s mate: 🏆 for Black and confetti');
  {
    await newGame(B);
    const marks = await Promise.all(pages.map(mark));
    await plays('f2f3 e7e5 g2g4', '1. f3 e5 2. g4');
    const q = await drag(B, 'd8', 'h4');
    ok(await reached(q, 'h4'), `${B.who} drags the queen d8 → h4: mate`);
    const anns = await Promise.all(pages.map((p, k) => cue(p, marks[k], 'anns', /checkmate/i)));
    ok(anns.every(Boolean), `checkmate is announced on every screen (${J(anns[0])})`);
    const won = await Promise.all(pages.map((p) => p.waitForFunction((n) => [...document.querySelectorAll('.seat')].some((el) => el.textContent.startsWith('🏆') && el.textContent.includes(n)), B.who, { timeout: 10000 }).then(() => true, () => false)));
    ok(won.every(Boolean) && (await Promise.all(pages.map(trophies))).every((t) => t.length === 1), `${B.who} (Black) gets 🏆 on every screen, and nobody else`);
    await h.sleep(500);
    const bursts = await Promise.all([B, carol].map((p) => since(p, marks[pages.indexOf(p)], 'bursts')));
    ok(bursts.every((b) => b.length === 1), `confetti bursts on the screens with motion: ${B.who}'s and Carol's (${J(bursts)})`);
    ok(bursts[0][0] > bursts[1][0], `the winner's burst is the bigger (${bursts[0][0]} pieces against ${bursts[1][0]})`);
    await shot(B, 'p3-chess-mate-phone');
    const m = await mark(W), before = await position(alice);
    await drag(W, 'a2', 'a3');
    ok(await cue(W, m, 'toasts', /🚫/) && posText(await position(alice)) === posText(before), 'after the mate no move is played');
  }

  section('7. En passant; promotion through the ask, choosing ♘, with a host reload while it is pending; a forged del; a threefold repetition');
  {
    await newGame(W);
    await plays('a2a3 h7h5 a3a4 h5h4 g2g4', '1. a3 h5 2. a4 h4 3. g4 (a double step beside the h4 pawn)');
    const g4 = await pieceAt(alice, 'g4'), ep = await drag(B, 'h4', 'g3');
    ok(await reached(ep, 'g3'), `${B.who} drags h4 → g3: en passant`);
    ok((await Promise.all(pages.map((p) => P.waitView(p, '!v.items[a] && !Object.values(v.items).some((it) => it.at === "g4")', g4, 5000)))).every(Boolean), 'the white pawn on g4 is taken, on every screen');
    await plays('b2b3 g3h2 b3b4', '4. b3 gxh2 5. b4');
    const pawn = await drag(B, 'h2', 'g1');
    ok(await reached(pawn, 'g1'), `${B.who} drags the pawn h2 → g1, taking the knight: the last rank`);
    ok(await askShows(B, /promot/i), `${B.who}'s screen asks what the pawn becomes (${J(await askOf(B))})`);
    ok(J((await askOf(B))?.options) === J(['♛', '♜', '♝', '♞']), 'queen, rook, bishop or knight, in Black\'s glyphs');
    for (const p of [W, carol]) ok(!(await askOf(p)), `${p.who} sees no ask`);
    await shot(B, 'p3-chess-promo-phone');
    await refused(B, 'a7', 'a6', /🚫/, 'Black moves on before answering');
    await refused(W, 'b4', 'b5', /🚫/, 'White moves before Black has answered');

    const boot = await P.viewOf(B, 'v.boot');
    await alice.reload();
    ok(await alice.waitForFunction(() => window.__ct?.view().seq > 0 && window.__ct.jobs() === 0 && window.__ct.view().rules?.enabled, null, { timeout: 30000 }).then(() => true, () => false), 'the host reloads: the saved rules run again');
    ok(await P.waitView(B, 'v.boot !== a', boot, 20000), `${B.who}'s screen has the reloaded host's table`);
    ok(await askShows(B, /promot/i, 10000) && J((await askOf(B))?.options) === J(['♛', '♜', '♝', '♞']), `the promotion's ask is still on ${B.who}'s screen`);
    ok(!(await askOf(alice)), 'and on nobody else\'s');
    await answer(B, '♞');
    ok((await Promise.all(pages.map((p) => P.waitView(p, 'Object.values(v.items).some((it) => it.at === "g1" && it.t.endsWith("/bN")) && !v.items[a]', pawn, 10000)))).every(Boolean),
      `${B.who} taps ♞: a black knight stands on g1, the pawn gone, on every screen`);
    ok(await askGone(B) && await turn() === W.pid, 'the ask is gone; White to move');
    await shot(alice, 'p3-chess-promoted-desk');

    const m = await mark(B), mine = await pieceAt(B, 'a7');
    await B.evaluate((id) => window.__ct.act({ t: 'del', id }), mine);
    const toast = await cue(B, m, 'toasts', /🚫/);
    ok(toast === '🚫 Not a move in this game', `${B.who}'s forged removal of his a7 pawn: "${toast}"`);
    ok(await pieceAt(alice, 'a7') === mine && await pieceAt(carol, 'a7') === mine, 'the pawn is still there');

    const marks = await Promise.all(pages.map(mark));
    await plays('b1c3 b8c6 c3b1 c6b8 b1c3 b8c6 c3b1', 'knights out and back, and out and back again but for the last move');
    ok((await Promise.all(pages.map((p, k) => since(p, marks[k], 'anns')))).every((a) => !a.length) && await turn() === B.pid, 'the position after the promotion has come twice: the game goes on');
    const n = await drag(B, 'c6', 'b8');
    ok(await reached(n, 'b8'), 'Black\'s knight back to b8: the same position for the third time');
    const anns = await Promise.all(pages.map((p, k) => cue(p, marks[k], 'anns', /(same position|repetition|third time).*draw/i)));
    ok(anns.every(Boolean), `an automatic draw by repetition, announced on every screen (${J(anns[0])})`);
    ok((await Promise.all(pages.map(trophies))).every((t) => !t.length) && await turn() === null, 'no 🏆; nobody to move');
  }

  section('8. Loyd\'s stalemate: the position by a scripted sequence, its last move by drag — a draw');
  {
    await newGame(B);
    /** The player to move moves from → to through __ct.act, as their drop would (set-up only). */
    const scripted = async (from, to) => (await mover()).evaluate(([from, to]) => {
      const v = window.__ct.view(), id = Object.keys(v.items).find((k) => v.items[k].at === from), [bx, ty] = v.items[id].t.split('/');
      const T = window.__ct.boxes()[bx].types[ty], c = window.__ct.resolve(to);
      window.__ct.act({ t: 'move', id, x: c.x - T.w / 2, y: c.y - T.h / 2 });
    }, [from, to]);
    let stuck = null;
    for (const mv of 'e2e3 a7a5 d1h5 a8a6 h5a5 h7h5 h2h4 a6h6 a5c7 f7f6 c7d7 e8f7 d7b7 d8d3 b7b8 d3h7 b8c8 f7g6'.split(' ')) {
      const id = await pieceAt(alice, mv.slice(0, 2));
      await scripted(mv.slice(0, 2), mv.slice(2));
      if (!(await reached(id, mv.slice(2)))) { stuck = mv; break; }
    }
    ok(!stuck, `1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. h4 Rah6 5. Qxc7 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6, scripted (${stuck ?? 'every move played'})`);
    const marks = await Promise.all(pages.map(mark));
    const q = await drag(W, 'c8', 'e6');
    ok(await reached(q, 'e6'), `${W.who} drags the queen c8 → e6: Black, not in check, has no legal move`);
    const anns = await Promise.all(pages.map((p, k) => cue(p, marks[k], 'anns', /stalemate/i)));
    ok(anns.every((a) => a && /draw/i.test(a)), `stalemate: a draw, announced on every screen (${J(anns[0])})`);
    ok((await Promise.all(pages.map(trophies))).every((t) => !t.length) && await turn() === null, 'no 🏆; nobody to move');
    await shot(alice, 'p3-chess-stalemate-desk');
    const [wd, hd] = await Promise.all([alice.evaluate(() => window.__ct.workerDigest()), alice.evaluate(() => window.__ct.digest())]);
    ok(wd && wd === hd, 'after it all, the rules Worker\'s mirror and the host\'s table are one (digests equal)');
  }

  await env.done();
})().catch(h.crash);
