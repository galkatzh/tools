// Phase 4A, resume elsewhere (spec §4l t-p4-boxes item 8; §4c "Ids and
// players on import", "Trust and the uploader"; §4g Export… and the trust
// dialog; D180, D181, D185, D191). Written apart from the implementation:
// every expectation is read off the spec.
//
// Room 1: Alice hosts on a desktop, Bob plays on an iPhone 13 held upright.
// They play Hold'em to the flop (Bob or Alice bets, the other owes a call),
// then chess to 1. e4 Nf6 2. e5 d5 (White to move, en passant on d6 open:
// a right only the game state knows). Alice exports each from 📦 → Export…,
// as a player would (the download is captured): Hold'em and chess with the
// rules and the game state, chess without the state, and chess without the
// rules.
//  R  Chess resumed in a fresh room (Carol hosts on an iPhone 13 upright,
//     Dave on a desktop): the real upload, the setup confirm, the trust
//     dialog; the same position, ids and box id (t.data.box) on both
//     screens, White's turn on White's new player; White takes en passant
//     and Black takes back, each by a drag on their own screen.
//  H  Hold'em resumed in a fresh room (Erin hosts on a desktop, Fay on an
//     iPhone 13 held sideways): each new player gets the hand, stack and bet
//     of the old player with the same "#k" (pids travel as "@#k"), the burn
//     card keeps its id (t.data.burn), the board's cards their deck's id;
//     the player owing the call presses Call on their own screen, and the
//     hand is played on to the showdown with no script error.
//  N  An export without "Include the rules", set up in a fresh room (Gus
//     hosts on an iPhone 13 held sideways, Hal on a desktop): no rules
//     question, no trust dialog, the position laid out with the rules off —
//     a pawn may step back. Then the export without "Include the game
//     state", set up with its rules there: the game starts afresh.
// B21 (an export's wall clock) is t-p4-resume-bench.js, in the serial batch.
// Screenshots: shots/p4-resume-*.png.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./h');
const { ok, section } = h;
const P = require('./p2t-lib');
const S = require('./p3-lib');
const { pickGame } = require('./stones-lib');
const { shot } = require('./fun-lib');
const { press, openBoxes, closeBoxes, settle, S: st, ranked, watchers } = require('./p4-lib');

const { devices } = h.playwright;
const J = JSON.stringify;
const FILES = 'abcdefgh', BACK = 'RNBQKBNR';
/** Chess's start position, {square: type id} (wK, bP …). */
const START = Object.fromEntries([...FILES].flatMap((f, k) => [[`${f}1`, `w${BACK[k]}`], [`${f}2`, 'wP'], [`${f}7`, 'bP'], [`${f}8`, `b${BACK[k]}`]]));
/** A type ref's own id ("ab12cd34/wP" → "wP"). */
const local = (t) => t.slice(t.indexOf('/') + 1);
/** The toasts that say an import changed ids or dropped saved state (§4c): none, on a clean resume. */
const IMPORT_TOAST = /ids had to change|weren't seated|was invalid and was dropped/;

(async () => {
  const env = await h.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-resume-'));

  // --- players and rooms --------------------------------------------------------
  /** A player in its own context (`device`: a Playwright device name), joined at `url`: `pid`, `who`, `touch`. */
  async function player(name, url, device) {
    const ctx = device && { ...devices[device] };
    const p = await env.page(name, ctx ? { ctx } : {});
    await p.addInitScript(watchers);
    await p.goto(url);
    await h.joinAs(p, name);
    await p.waitForFunction(() => { const v = window.__ct?.view(); return v?.seq > 0 && !!v.players[localStorage.getItem('ct-pid')]; }, null, { timeout: 30000 });
    return Object.assign(p, { pid: await p.evaluate(() => localStorage.getItem('ct-pid')), who: name, touch: !!ctx?.hasTouch });
  }
  /** A fresh room: its host (a new context: a new key, so a new room) and one guest, both seen by the host. */
  async function room([a, da], [b, db]) {
    const host = await player(a, env.url, da), guest = await player(b, host.url(), db);
    await host.waitForFunction((q) => !!window.__ct.view().players[q], guest.pid, { timeout: 30000 });
    return [host, guest];
  }
  const close = (pages) => Promise.all(pages.map((p) => p.context().close()));
  /** Waits until `expr` holds of the host's state `s` (and `a`); false after `ms`. */
  const waitState = (p, expr, a, ms = 15000) => p.waitForFunction(([src, a]) => (0, eval)(`(s, a) => (${src})`)(window.__ct.hostState(), a), [expr, a], { timeout: ms, polling: 100 }).then(() => true, () => false); // eslint-disable-line no-eval
  /** Ticks or unticks checkbox `sel` by a press, when it isn't so. */
  const tick = async (p, sel, on) => { if ((await p.isChecked(sel)) !== on) await press(p, sel); };
  /** No rules error on host page p: none recorded, the rules on, and no "rules disabled" line in its log. */
  const clean = async (p) => {
    const s = await st(p), err = await p.evaluate(() => window.__ct.lastRulesError ?? null);
    return { ok: !err && !!s.rules?.enabled && !s.log.some((e) => /rules disabled/.test(e.txt)), err, enabled: !!s.rules?.enabled };
  };

  // --- 📦 ------------------------------------------------------------------------
  /** Host page p exports its table through 📦 → Export…, with "Include the
   *  rules" and "Include the game state" set to `rules` and `state`, and
   *  saves the download: {defaults (the two boxes as the dialog offered
   *  them), name (the file's), file (its path here), text, json (when a
   *  .json), msg (what the dialog then says)}. */
  async function exportTable(p, { rules, state }, tag) {
    await openBoxes(p);
    const defaults = await p.evaluate(() => ({ rules: document.getElementById('box-x-rules').checked, state: document.getElementById('box-x-state').checked }));
    await tick(p, '#box-x-rules', rules);
    await tick(p, '#box-x-state', state);
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), press(p, '#box-x-go')]);
    const name = dl.suggestedFilename(), file = path.join(tmp, `${tag}-${name}`);
    await dl.saveAs(file);
    await p.waitForFunction(() => /\S/.test(document.getElementById('box-x-msg').textContent) && !/^Exporting/.test(document.getElementById('box-x-msg').textContent), null, { timeout: 10000 }).then(() => true, () => false);
    const msg = await p.textContent('#box-x-msg');
    await closeBoxes(p);
    const text = fs.readFileSync(file, 'utf8');
    let json = null;
    try { json = /\.json$/.test(name) ? JSON.parse(text) : null; } catch (err) { console.error(`${name} is not JSON`, err); }
    return { defaults, name, file, text, json, msg };
  }
  /** Page p's open #box-ask once it is of `kind`: {title, lines, checks: {id: {on, label}}, buttons: {value: label}}, or null. */
  const asked = (p, kind) => p.waitForSelector(`#box-ask[open][data-kind="${kind}"]`, { timeout: 15000 }).then(() => p.evaluate(() => ({
    title: document.getElementById('box-ask-title').textContent,
    lines: [...document.querySelectorAll('#box-ask-body p')].map((e) => e.textContent),
    checks: Object.fromEntries([...document.querySelectorAll('#box-ask [data-c]')].map((c) => [c.dataset.c, { on: c.checked, label: c.closest('label')?.textContent.trim() }])),
    buttons: Object.fromEntries([...document.querySelectorAll('#box-ask-btns button')].map((b) => [b.value, b.textContent])),
  })), () => null);
  /** Page p answers its open #box-ask with the button of `value`. */
  const reply = (p, value) => press(p, `#box-ask-btns button[value="${value}"]`);
  /** Whether page p shows an open #box-ask of `kind` within `ms`. */
  const asks = (p, kind, ms) => p.waitForSelector(`#box-ask[open][data-kind="${kind}"]`, { timeout: ms }).then(() => true, () => false);
  /** Host page p picks `file` in its 📦 dialog ("Set up now" left as it is
   *  offered) and waits for what comes: a question, an error, or the dialog
   *  closed. {now: whether "Set up now" was ticked, err}. */
  async function upload(p, file) {
    await openBoxes(p);
    const now = await p.isChecked('#box-now');
    await p.setInputFiles('#box-files', file);
    await p.waitForFunction(() => !!document.querySelector('#box-ask[open]') || !!document.getElementById('box-err').textContent || !document.querySelector('#box-dialog[open]'), null, { timeout: 30000 });
    return { now, err: await p.textContent('#box-err') };
  }
  /** Page p's 📦 row of the box named `name`: its text, or null. */
  async function boxRow(p, name) {
    await openBoxes(p);
    await p.waitForFunction((n) => [...document.querySelectorAll('#box-list .box-row')].some((r) => r.querySelector('b')?.textContent === n), name, { timeout: 10000 }).then(() => true, () => false);
    const text = await p.evaluate((n) => [...document.querySelectorAll('#box-list .box-row')].find((r) => r.querySelector('b')?.textContent === n)?.textContent.replace(/\s+/g, ' ').trim() ?? null, name);
    await closeBoxes(p);
    return text;
  }

  // --- chess on the screens -------------------------------------------------------
  /** Page p's chess men: {square: "<item id> <type ref>"}. */
  const men = (p) => P.viewOf(p, 'Object.fromEntries(Object.entries(v.items).filter(([, it]) => it.at && it.k === "g").map(([id, it]) => [it.at, id + " " + it.t]))');
  /** {square: own type id} of men(). */
  const types = (m) => Object.fromEntries(Object.entries(m).map(([sq, x]) => [sq, local(x.split(' ')[1])]));
  const sorted = (o) => J(Object.entries(o).sort());
  /** Every item on page p: [id, type ref, at, x, y], by id. */
  const layout = (p) => P.viewOf(p, 'Object.entries(v.items).map(([id, it]) => [id, it.t ?? null, it.at ?? null, it.x, it.y]).sort()');
  /** Whether two layouts hold the same ids, types and spots, each within 0.5 of the same place. */
  const sameLayout = (a, b) => a.length === b.length && a.every((x, k) => J(x.slice(0, 3)) === J(b[k].slice(0, 3)) && Math.abs(x[3] - b[k][3]) <= 0.5 && Math.abs(x[4] - b[k][4]) <= 0.5);
  /** Page p drags its man on `from` over square `to` and lets go there (its finger on a phone): the man's id. */
  async function drag(p, from, to) {
    const id = await P.viewOf(p, 'Object.keys(v.items).find((id) => v.items[id].at === a) ?? null', from);
    if (!id) throw new Error(`${p.who}: no man on ${from}`);
    const r = await p.evaluate((a) => window.__ct.resolve(a), to);
    const pts = S.steps(await S.centreOf(p, id), await S.screenOf(p, r.x, r.y), 10);
    pts.at(-1).wait = 120; // (held still before the release: a finger let go mid-flick flings)
    await S.gesture(p, pts, { touch: p.touch });
    return id;
  }
  /** Whether every page of `pages` shows item `id` on square `sq`, and no item `gone`. */
  const shows = async (pages, id, sq, gone) => (await Promise.all(pages.map((q) => P.waitView(q, 'v.items[a.id]?.at === a.sq && !(a.gone && v.items[a.gone])', { id, sq, gone }, 10000)))).every(Boolean);
  /** The page of `pages` whose player holds seat `seatId`. */
  const holder = async (host, pages, seatId) => { const s = await st(host); return pages.find((p) => s.players[p.pid]?.seatId === seatId) || null; };
  /** Plays `move` ("e2e4") by a drag on the screen of the side to move in `pages` (host first): whether it shows on every screen. */
  async function play(pages, move) {
    const s = await st(pages[0]), side = s.rules.data.turn === 'w' ? 'white' : 'black', p = await holder(pages[0], pages, side);
    const id = p && await drag(p, move.slice(0, 2), move.slice(2, 4));
    return !!id && await shows(pages, id, move.slice(2, 4));
  }

  // --- Hold'em on the screens ---------------------------------------------------------
  /** Page p presses its rules button `id` (data-rbtn: new, call, check, r:10 …). */
  const button = async (p, id) => {
    const sel = `#rules-btns button[data-rbtn="${id}"]`;
    if (!(await p.waitForSelector(sel, { timeout: 10000 }).then(() => true, () => false))) throw new Error(`${p.who} has no "${id}" button (${J(await p.$$eval('#rules-btns button', (bs) => bs.map((b) => b.textContent)))})`);
    await press(p, sel);
  };
  /** The rules buttons page p shows: their labels — once one reads `want`, if given (its screen redraws a moment after the host's state). */
  const buttons = async (p, want) => {
    if (want) await p.waitForFunction((w) => [...document.querySelectorAll('#rules-btns button')].some((b) => b.textContent === w), want, { timeout: 10000 }).then(() => true, () => false);
    return p.$$eval('#rules-btns button', (bs) => bs.filter((b) => b.getClientRects().length).map((b) => b.textContent));
  };
  /** Page p's face-up cards on the table: "d:i" each, sorted. */
  const upCards = (p) => P.viewOf(p, 'Object.values(v.items).filter((it) => it.k === "c" && it.up).map((it) => it.d + ":" + it.i).sort()');
  /** Page p's own hand: "d:i" each, sorted. */
  const handOf = (p) => p.evaluate(() => window.__ct.hand().filter((c) => 'd' in c).map((c) => `${c.d}:${c.i}`).sort());
  const refs = (cards) => cards.map((c) => `${c.d}:${c.i}`).sort();
  /** The seat labels page p shows: their texts. */
  const seatTexts = (p) => p.$$eval('.seat', (els) => els.map((e) => e.textContent));

  // ================================================================================
  const [alice, bob] = await room(['Alice'], ['Bob', 'iPhone 13']);
  const r1 = [alice, bob];

  section("1 room 1: Hold'em to the flop, a bet to call; exported with the rules and the game state");
  let hold, H1; // the export; room 1's state at it
  {
    await pickGame(alice, 'holdem');
    ok(await waitState(alice, 's.rules?.enabled && /Hold.em/.test(s.rules.name)'), "Hold'em runs in room 1");
    await settle(alice);
    await button(alice, 'new');
    const dealt = await Promise.all(r1.map((p) => P.waitView(p, 'v.hand.length === 2')));
    let s = await st(alice);
    const dealer = s.rules.data.dealer, D = r1.find((p) => p.pid === dealer), B = r1.find((p) => p.pid !== dealer);
    ok(dealt.every(Boolean) && D && s.rules.data.turn === dealer, `a hand dealt (two cards each, on each screen); heads-up, ${D?.who} has the button and acts first`);
    await button(D, 'call'); // the small blind completes: 5
    ok(await waitState(alice, 's.rules.data.turn === a', B.pid), `${D.who} calls the small blind; ${B.who} to act`);
    await button(B, 'check');
    ok(await waitState(alice, 's.rules.data.comm.length === 3 && s.rules.data.turn === a', B.pid), `${B.who} checks: the flop is dealt, ${B.who} to act`);
    await button(B, 'r:10'); // "Min raise → 10": a bet of 10
    ok(await waitState(alice, 's.rules.data.turn === a.d && s.rules.data.curBet === 10 && s.rules.data.bet[a.b] === 10', { d: dealer, b: B.pid }), `${B.who} bets 10: ${D.who} owes the call`);
    const offered = await buttons(D, 'Call 10');
    ok(offered.includes('Call 10'), `${D.who}'s screen offers "Call 10" (${J(offered)})`);
    await settle(alice);
    H1 = await st(alice);
    hold = await exportTable(alice, { rules: true, state: true }, 'holdem');
    const d = H1.rules.data, K = ranked(H1), at = (q) => `@#${K.indexOf(q) + 1}`, f = hold.json, rs = f?.rulesState?.data;
    ok(hold.defaults.rules && hold.defaults.state, `with rules running, Export… offers "Include the rules" and "Include the game state" ticked (D191) (${J(hold.defaults)})`);
    ok(hold.name === "Hold'em (chips).json" && f, `a table without images (cards and no box): «${hold.name}», a .json named after its rules (§4g, D191); the dialog says "${hold.msg}"`);
    ok(f?.rules === H1.rules.code, 'the file holds the running script');
    ok(K.length === 2 && rs && rs.dealer === at(dealer) && rs.turn === at(dealer) && J(Object.keys(rs.stacks).sort()) === J(['@#1', '@#2'])
      && rs.stacks[at(dealer)] === d.stacks[dealer] && rs.stacks[at(B.pid)] === d.stacks[B.pid] && J(rs.bet) === J({ [at(B.pid)]: 10 }) && J(Object.keys(rs.paid).sort()) === J(['@#1', '@#2']),
    `the pid-keyed state travels as "@#k" by seat clockwise from the bottom (§4c): dealer ${rs?.dealer}, turn ${rs?.turn}, stacks ${J(rs?.stacks)}, bet ${J(rs?.bet)}, paid ${J(rs?.paid)}`);
    ok(!r1.some((p) => hold.text.includes(p.pid)), "no room-1 player id is left anywhere in the file (every seated pid is \"@#k\")");
    const ids = new Set((f?.setup || []).filter((e) => e.id).map((e) => e.id)), hands = (f?.setup || []).find((e) => e.hands)?.hands;
    ok(d.burn.length === 1 && d.burn.every((x) => ids.has(x)) && J(rs?.burn) === J(d.burn), `the burn card's item id (t.data.burn ${J(d.burn)}) is written as its setup entry's id`);
    ok(f?.decks?.length === 1 && f.decks[0].id === d.comm[0].d && J(rs?.comm) === J(d.comm), `the deck keeps its id (${f?.decks?.[0]?.id}), the board's cards refer to it (t.data.comm)`);
    ok(hands && J(Object.keys(hands).sort()) === J(['#1', '#2']) && K.every((q, k) => J(hands[`#${k + 1}`].map((c) => `${f.decks.find((x) => x.name === c.deck)?.id}:${c.i}`).sort()) === J(refs(H1.players[q].hand))),
      `the hands go as "#1" and "#2", each the cards its player held (${J(hands)})`);
  }

  section('2 room 1: chess to 1. e4 Nf6 2. e5 d5 — White to move, en passant open on d6; exported three ways');
  let chess, noState, noRules, C1, pos1, lay1; // the exports; room 1's state, men and layout at them
  {
    const asked1 = await pickGame(alice, 'chess');
    ok(await waitState(alice, 's.rules?.enabled && s.rules.name === "Chess" && Object.values(s.items).filter((it) => it.at).length === 32', null, 30000), `🎲 Chess (it asked "${asked1}"): 32 men on the board`);
    await settle(alice);
    for (const m of ['e2e4', 'g8f6', 'e4e5', 'd7d5']) ok(await play(r1, m), `${m}, dragged by the side to move, on both screens`);
    await settle(alice);
    C1 = await st(alice);
    pos1 = await men(alice);
    lay1 = await layout(alice);
    const g = C1.rules.data;
    ok(g.turn === 'w' && g.ep === 'd6' && typeof g.box === 'string' && C1.boxes[g.box], `room 1: White to move, en passant on ${g.ep}; t.data.box = ${g.box}, a box of this catalog`);
    chess = await exportTable(alice, { rules: true, state: true }, 'chess');
    const f = chess.json, ids = new Set((f?.setup || []).filter((e) => e.id).map((e) => e.id));
    ok(chess.name === 'Chess.json' && f, `«${chess.name}»: no image involved, so a .json (§4g); "${chess.msg}"`);
    ok(f?.id === g.box && f.rulesState?.data?.box === g.box && f.rules === C1.rules.code, `the file keeps the box's id (${f?.id}), t.data.box naming it, and the script`);
    ok(f?.rulesState?.data?.ep === 'd6' && f.rulesState.data.turn === 'w', 'the game state goes with it: White to move, en passant on d6');
    ok(Object.keys(C1.items).every((id) => ids.has(id)), `every item is written under its own id (${ids.size} of ${Object.keys(C1.items).length})`);
    const whiteK = ranked(C1).indexOf(Object.entries(C1.players).find(([, pl]) => pl.seatId === 'white')[0]) + 1;
    ok(f?.rulesState?.public?.turn === `@#${whiteK}` && !r1.some((p) => chess.text.includes(p.pid)), `the turn cue's pid is "@#${whiteK}" (White's player); no room-1 pid in the file (${J(f?.rulesState?.public?.turn)})`);
    noState = await exportTable(alice, { rules: true, state: false }, 'nostate');
    ok(noState.json && noState.json.rules === C1.rules.code && !('rulesState' in noState.json), `without "Include the game state": the script, no rulesState (${J(Object.keys(noState.json || {}))})`);
    noRules = await exportTable(alice, { rules: false, state: true }, 'norules');
    ok(noRules.json && !('rules' in noRules.json) && J(noRules.json.setup) === J(f?.setup), 'without "Include the rules": no script, the same layout');
  }
  await close(r1);

  section('3 chess resumed in a fresh room: Carol hosts on an iPhone 13, Dave on a desktop; the trust dialog, then play on');
  {
    const [carol, dave] = await room(['Carol', 'iPhone 13'], ['Dave']);
    const r2 = [carol, dave];
    const up = await upload(carol, chess.file);
    const q = await asked(carol, 'setup');
    ok(up.now && !up.err, `Carol picks «${chess.name}» in 📦 on her phone ("Set up now" ticked by default)${up.err ? ` — ${up.err}` : ''}`);
    ok(q && `${q.title} ${q.lines.join(' ')}`.includes('Set up «Chess»?') && q.lines.includes('This clears the table.') && q.checks.rules?.on && /^Enable its rules$/.test(q.checks.rules.label) && !q.checks.shuffle,
      `the confirm: "Set up «Chess»? This clears the table.", "Enable its rules" ticked, no shuffle (her own upload) (${J(q)})`);
    await reply(carol, 'ok');
    const t = await asked(carol, 'trust');
    ok(t && t.lines.join(' ') === '«Chess» comes with rules written by its author. A rules script sees every hand and hidden piece and can reveal them. Enable the rules?'
      && J(Object.values(t.buttons).sort()) === J(['Cancel', 'Enable rules', 'Set up without rules']), `the trust dialog (§4g), in its words, with Enable rules / Set up without rules / Cancel (${J(t)})`);
    await shot(carol, 'p4-resume-trust-phone');
    await reply(carol, 'enable');
    await settle(carol);
    const s = await st(carol), g = s.rules?.data, c = await clean(carol);
    ok(c.ok && s.rules.name === 'Chess' && !(await carol.$('#box-dialog[open]')), `the rules run, with no script error, and 📦 closed${c.err ? ` (${c.err})` : ''}`);
    ok(g?.box === C1.rules.data.box && s.boxes[g.box] && Object.values(s.items).every((it) => !it.t || it.t.startsWith(`${g.box}/`)),
      `t.data.box (${g?.box}) is room 1's, and it names the box this room set up: every man's type is in it (the id was free, so kept: §4c)`);
    ok(g?.turn === 'w' && g.ep === 'd6' && g.castle === C1.rules.data.castle && J(g.seen) === J(C1.rules.data.seen), `the game state goes on: White to move, en passant on d6, castling ${g?.castle}, the positions seen`);
    for (const p of r2) {
      const m = await men(p), l = await layout(p);
      ok(sorted(m) === sorted(pos1) && sameLayout(l, lay1), `${p.who}'s screen: room 1's position, every man and the board under its own id and type, in place (${Object.keys(m).length} men)`);
    }
    const W = await holder(carol, r2, 'white'), B = await holder(carol, r2, 'black');
    ok(W && B && W !== B, `the two new players hold White and Black (White ${W?.who}, Black ${B?.who})`);
    ok(await P.waitView(dave, 'v.rules?.public?.turn === a', W?.pid, 10000), `the turn cue ("@#k" mapped to this room's player) lights ${W?.who}, White`);
    ok(!(await carol.evaluate(() => window.__toasts)).some((x) => IMPORT_TOAST.test(x.msg)), 'no "ids had to change" or dropped-state toast: a fresh room keeps them all');
    const row = await boxRow(dave, 'Chess');
    ok(row && row.includes('📜') && row.includes('13 piece types') && row.includes('by Carol'), `Dave's 📦 (read-only) lists «Chess» with 📜, its 13 piece types and "by Carol" (§4g) ("${row}")`);
    const pawn = pos1.e5.split(' ')[0], black = pos1.d5.split(' ')[0];
    const id1 = await drag(W, 'e5', 'd6');
    ok(id1 === pawn && await shows(r2, pawn, 'd6', black), `${W.who} (White) takes en passant, e5×d6, by a drag on ${W.touch ? 'her phone' : 'his desktop'}: on both screens the pawn on d6, Black's d5 pawn gone`);
    ok(await waitState(carol, 's.rules.data.turn === "b" && !s.rules.data.ep'), "Black's turn now");
    const id2 = await drag(B, 'e7', 'd6');
    ok(await shows(r2, id2, 'd6', pawn) && await waitState(carol, 's.rules.data.turn === "w"'), `${B.who} (Black) takes back, e7×d6, by a drag: on both screens, White to move`);
    const c2 = await clean(carol);
    ok(c2.ok, `play went on with no script error${c2.err ? ` (${c2.err})` : ''}`);
    await shot(dave, 'p4-resume-chess-desk');
    await close(r2);
  }

  section("4 Hold'em resumed in a fresh room: Erin hosts on a desktop, Fay on an iPhone 13 held sideways; the call, then the hand to its showdown");
  {
    const [erin, fay] = await room(['Erin'], ['Fay', 'iPhone 13 landscape']);
    const r3 = [erin, fay];
    const up = await upload(erin, hold.file);
    const q = await asked(erin, 'setup');
    ok(up.now && !up.err && q?.lines.includes('This clears the table.') && q.checks.rules?.on, `Erin picks «${hold.name}»: Set up asks (the table clears; "Enable its rules" ticked)`);
    await reply(erin, 'ok');
    const t = await asked(erin, 'trust');
    ok(t?.lines.join(' ').startsWith("«Hold'em (chips)» comes with rules written by its author."), 'the trust dialog follows');
    await reply(erin, 'enable');
    await settle(erin);
    let s = await st(erin);
    const d1 = H1.rules.data, K1 = ranked(H1), K3 = ranked(s), map = (q) => K3[K1.indexOf(q)], d = s.rules?.data;
    const dealer = map(d1.dealer), bb = K3.find((q) => q !== dealer), D = r3.find((p) => p.pid === dealer), B = r3.find((p) => p.pid === bb);
    const c = await clean(erin);
    ok(c.ok && /Hold.em/.test(s.rules.name), `the rules run, with no script error${c.err ? ` (${c.err})` : ''}`);
    ok(K3.length === 2 && D && B && d?.dealer === dealer && d.turn === dealer && d.stage === 'hand',
      `"@#k" maps to this room's players by seat: ${D?.who} has the button and owes the call, as room 1's #${K1.indexOf(d1.dealer) + 1} did`);
    ok(d && K1.every((q) => d.stacks[map(q)] === d1.stacks[q] && (d.paid[map(q)] || 0) === (d1.paid[q] || 0)) && J(d.bet) === J({ [bb]: 10 }) && d.pot === d1.pot && d.curBet === 10,
      `stacks, chips paid and the bet are keyed by the new players: stacks ${J(d?.stacks)}, bet ${J(d?.bet)}, pot ${d?.pot}`);
    ok(J(d?.burn) === J(d1.burn) && d1.burn.every((x) => s.items[x]?.k === 'c' && !s.items[x].up && Math.abs(s.items[x].x - H1.items[x].x) <= 0.5 && Math.abs(s.items[x].y - H1.items[x].y) <= 0.5),
      `the burn card keeps its item id (t.data.burn ${J(d?.burn)}), face down where it lay`);
    ok(J(d?.comm) === J(d1.comm) && s.decks[d1.comm[0].d], `the deck keeps its id (${d1.comm[0].d}), so t.data.comm still names the board's cards`);
    for (const p of r3) {
      const k = K3.indexOf(p.pid), [hand, board, labels] = [await handOf(p), await upCards(p), await seatTexts(p)];
      ok(J(hand) === J(refs(H1.players[K1[k]].hand)), `${p.who}'s screen: her hand is room 1's #${k + 1}'s two cards (${J(hand)})`);
      ok(J(board) === J(refs(d1.comm)), `${p.who}'s screen: the flop, face up (${J(board)})`);
      ok(r3.every((x) => labels.some((l) => l.includes(x.who) && l.includes(`💰${d.stacks[x.pid]}`))), `${p.who}'s screen: each seat shows its stack (${J(labels)})`);
    }
    const mine = await buttons(D, 'Call 10'), theirs = await buttons(B);
    ok(mine.includes('Call 10') && !theirs.some((b) => /^Call|^Check/.test(b)), `only ${D.who}'s screen offers "Call 10" (${J(mine)} / ${J(theirs)})`);
    ok(!(await erin.evaluate(() => window.__toasts)).some((x) => IMPORT_TOAST.test(x.msg)), 'no "ids had to change" or dropped-state toast');
    await button(D, 'call');
    ok(await waitState(erin, 's.rules.data.comm.length === 4 && s.rules.data.turn === a', bb), `${D.who} calls 10 on ${D.touch ? 'her phone' : 'her desktop'}: the round closes and the turn card is dealt; ${B.who} to act`);
    s = await st(erin);
    ok(s.log.some((e) => e.txt === `${D.who} calls 10`) && s.rules.data.pot === 40 && s.rules.data.stacks[dealer] === 980 && s.rules.data.burn.length === 2 && J(s.rules.data.burn.slice(0, 1)) === J(d1.burn),
      `the log says "${D.who} calls 10"; pot 40, ${D.who}'s stack 980, a second card burnt beside the first`);
    const turnUp = await Promise.all(r3.map((p) => P.waitView(p, 'Object.values(v.items).filter((it) => it.k === "c" && it.up).length === 4', null, 10000)));
    ok(turnUp.every(Boolean), 'the turn card shows on both screens');
    await shot(fay, 'p4-resume-holdem-phone');
    const turnOf = (q, n) => `s.rules.data.turn === "${q}" && s.rules.data.comm.length === ${n}`;
    for (const [p, then, what] of [[B, turnOf(dealer, 4), ''], [D, turnOf(bb, 5), ': the river'], [B, turnOf(dealer, 5), ''], [D, 's.rules.data.stage === "done"', ': the showdown']]) { // checked down
      await button(p, 'check');
      ok(await waitState(erin, then, null, 10000), `${p.who} checks on ${p.touch ? 'her phone' : 'her desktop'}${what}`);
    }
    s = await st(erin);
    const st3 = s.rules.data.stacks, vals = Object.values(st3).sort((a, b) => a - b);
    ok(s.rules.data.stage === 'done' && (J(vals) === J([980, 1020]) || J(vals) === J([1000, 1000])) && s.log.some((e) => / (wins|split) 40 with /.test(e.txt)),
      `the showdown reads every card (their deck found by id) and pays the pot of 40 to the new players: stacks ${J(st3)} (${J(s.log.filter((e) => /wins|split/.test(e.txt)).map((e) => e.txt))})`);
    const c2 = await clean(erin);
    ok(c2.ok, `the hand played out with no script error${c2.err ? ` (${c2.err})` : ''}`);
    await close(r3);
  }

  section('5 without the rules, then without the game state: Gus hosts on an iPhone 13 held sideways, Hal on a desktop');
  {
    const [gus, hal] = await room(['Gus', 'iPhone 13 landscape'], ['Hal']);
    const r4 = [gus, hal];
    const up = await upload(gus, noRules.file);
    const q = await asked(gus, 'setup');
    ok(!up.err && q?.lines.includes('This clears the table.') && !q.checks.rules, `«${noRules.name}» without its rules: Set up asks only that the table clears — no "Enable its rules" (${J(q)})`);
    await reply(gus, 'ok');
    ok(!(await asks(gus, 'trust', 2000)), 'no trust dialog: there are no rules to trust');
    await settle(gus);
    const s = await st(gus);
    ok(!s.rules?.enabled && !s.rules?.box && !(await gus.$('#box-dialog[open]')), `set up with no rules running (rules ${J(s.rules && { enabled: s.rules.enabled, box: s.rules.box })})`);
    for (const p of r4) {
      ok(sorted(types(await men(p))) === sorted(types(pos1)) && await P.waitView(p, '!v.rules?.enabled', null, 5000), `${p.who}'s screen: room 1's position, the rules off`);
    }
    const row = await boxRow(hal, 'Chess');
    ok(row && !row.includes('📜'), `Hal's 📦 lists «Chess» with no 📜 ("${row}")`);
    await shot(gus, 'p4-resume-norules-phone');
    const W = await holder(gus, r4, 'white');
    if (!W) ok(false, `somebody holds White's seat in room 4 (${J(Object.values(s.players).map((pl) => pl.seatId ?? null))})`);
    else {
      const id = await drag(W, 'e5', 'e4'); // a pawn stepping back: no chess rule allows it
      ok(await shows(r4, id, 'e4'), `${W.who} (White) steps the e5 pawn back to e4 — taken, on both screens: nothing enforces chess`);
    }

    const up2 = await upload(gus, noState.file);
    const q2 = await asked(gus, 'setup');
    ok(!up2.err && q2?.checks.rules?.on, `«${noState.name}» without the game state: Set up offers "Enable its rules", ticked`);
    await reply(gus, 'ok');
    ok(!!(await asked(gus, 'trust')), 'the trust dialog');
    await reply(gus, 'enable');
    await settle(gus);
    const s2 = await st(gus), c = await clean(gus);
    ok(c.ok && s2.rules.name === 'Chess', `the rules run, with no script error${c.err ? ` (${c.err})` : ''}`);
    ok(s2.rules.data.turn === 'w' && !s2.rules.data.ep && J(Object.keys(s2.rules.data.seen || {})) !== J(Object.keys(C1.rules.data.seen)), `the game starts afresh: White to move, no en passant (${J({ turn: s2.rules.data.turn, ep: s2.rules.data.ep })})`);
    for (const p of r4) {
      ok(await P.waitView(p, 'Object.values(v.items).filter((it) => it.at).length === 32', null, 10000) && sorted(types(await men(p))) === sorted(START), `${p.who}'s screen: the start position`);
    }
    const W2 = await holder(gus, r4, 'white');
    ok(W2 && await play(r4, 'e2e4'), `${W2?.who} (White) opens e2e4 by a drag: the new game plays`);
    await shot(gus, 'p4-resume-nostate-phone');
    await close(r4);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  await env.done();
})().catch(h.crash);
