// E2E (Phase 1, spec §1l "t-p1-delta.js"): delta sync keeps every screen equal
// to the host. Ground truth is the host's own save, recomputed in Node by
// core.js (publicItems / publicPlayers, the log, each player's hand).
//   (6)  the version gate: `_v: 1` or no `_v` gets the reload note, no seat and no state
//   (1)  500 random UI and __ct.act actions from three screens: views and hands converge
//   (7)  the log rides inside patches: 250 actions, and one action of 250 lines, trim alike
//   (5)  a vetoed play reverts on the guest with deltas (Turn order); a veto re-sends what it names
//   (4)  a guest reloads: a snapshot brings its table and its hand back
//   (8)  private-only commits (Turn order's timer, a script writing only t.data): nothing is
//        sent, 0 snapshot requests, and the next patch still applies
//   (2)  a dropped patch: the gap is noticed, a snapshot is requested and the guest converges;
//        while waiting the status tooltip says so, and requests are rate-limited
//   1j-1 a patch signed with another key, and a host patch relayed to the wrong peer: dropped
//   (9)  knock spam (1j case 5) and snap spam (1j case 4): at most one snapshot per 3 s
//   1j-7 `_join` and `__proto__` actions are refused with no state change
//   (3)  the host reloads mid-game: guests take the new epoch's snapshot, hands intact
const h = require('./h');
const L = require('./p1-lib');
const { mallory } = require('./final-lib');
const { ok } = h;

const SEED = Number(process.env.SEED) || 20261122;
const T0 = Date.now();
/** A section header with the time since the start (this suite is long: it shows where the time goes). */
const section = (s) => h.section(`${s}  [${Math.round((Date.now() - T0) / 1000)} s]`);
const NAMES = { host: 'Alice', a: 'Bob', b: 'Carol' };

(async () => {
  const env = await h.start();
  const P = await L.trio(env); // {host, a, b}
  const { host, a, b } = P;
  const pids = {};
  for (const k of Object.keys(P)) pids[k] = await L.pidOf(P[k]);
  const invite = host.url();
  // every console line of each page (listeners survive reloads)
  const cons = {};
  for (const [k, p] of Object.entries(P)) { cons[k] = []; p.on('console', (m) => cons[k].push(`${m.type()}: ${m.text()}`)); }
  const consoleSince = (k, n, re) => cons[k].slice(n).filter((l) => re.test(l));
  const counters = async () => Object.fromEntries(await Promise.all(Object.entries(P).map(async ([k, p]) =>
    [k, await p.evaluate(() => ({ ...window.__ct.perf, seq: window.__ct.view().seq, boot: window.__ct.view().boot }))])));
  const ids = async (p) => Object.keys((await L.view(p)).items).sort();

  /** Waits for every screen to agree, then checks each: its view's items,
   *  players, log, rules and size equal the public table core recomputes from
   *  the host's save, and its hand equals that player's hand in the save. */
  async function converged(label, o = {}) {
    let last = { problems: { host: ['no save'] } };
    const check = async () => {
      const rec = await L.saved(host);
      if (!rec?.state) return false;
      const t = L.truthOf(rec, pids.host);
      const want = {
        items: t.items, players: t.players, log: t.log, size: rec.state.size,
        rules: t.rules ? { name: t.rules.name, enabled: t.rules.enabled, public: t.rules.public } : null,
      };
      const problems = {};
      const views = {};
      for (const [k, p] of Object.entries(P)) {
        const v = (views[k] = await L.view(p));
        problems[k] = ['items', 'players', 'log', 'rules', 'size'].map((f) => L.diff(v[f], want[f], f))
          .concat(L.diff(v.hand, t.hands[pids[k]], 'hand')).filter(Boolean);
      }
      last = { t, views, problems };
      return Object.values(problems).every((x) => !x.length);
    };
    await h.sleep(o.quiet ?? 1200);
    await L.until(check, o.timeout ?? 20000, 300);
    for (const k of Object.keys(P)) {
      const v = last.views?.[k];
      ok(!last.problems[k].length, `${label}: ${NAMES[k]}'s items, players, log and hand equal the host's table` +
        (last.problems[k].length ? ` — ${last.problems[k].slice(0, 2).join(' | ')}` : ` (${Object.keys(v.items).length} items, ${v.log.length} log lines, ${v.hand.length} in hand)`));
    }
    return last;
  }

  /** A raw Trystero peer (final-lib's Mallory: no app code), once she is
   *  connected to the three players and holds the public snapshot every
   *  newcomer is sent. What she receives is stamped with its arrival time. */
  async function rawPeer() {
    const R = await mallory(env, invite);
    await R.evaluate(() => {
      for (const ch of ['state', 'note']) {
        const arr = (window.M.got[ch] ||= []);
        arr.push = function (...xs) { for (const x of xs) x.at = performance.now(); return Array.prototype.push.apply(this, xs); };
      }
    });
    if (await L.until(() => R.evaluate(() => Object.keys(window.M.room.getPeers()).length >= 3 && window.M.got.state.length > 0), 40000, 250)) return R;
    console.error('  the raw peer never got going:', JSON.stringify(await R.evaluate(() => ({ peers: Object.keys(window.M.room.getPeers()), got: Object.fromEntries(Object.entries(window.M.got).map(([k, v]) => [k, v.length])) }))),
      '— host:', await host.$eval('#net-status', (el) => `${el.textContent} ${el.title}`));
    throw new Error('a raw peer could not join the room');
  }
  // Raw peers join first: in this harness a peer arriving once the room has
  // been up for a minute or so can take 20 s or more to connect (Trystero's
  // signalling; Phase 0 behaves the same), so a late one would time out.
  const M = await rawPeer(); // Mallory, anonymous until 1j case 7

  // =========================================================================
  section('(6) the version gate: another wire version gets the reload note, no seat and no state');
  for (const [label, v, vpid] of [['_v: 1', 1, 'eeeeeeeeeeeeeeee'], ['no _v', undefined, 'dddddddddddddddd']]) {
    const V = await rawPeer();
    await V.evaluate(({ v, vpid }) => window.M.send.act({ t: 'hello', ...(v === undefined ? {} : { _v: v }), _pid: vpid, _name: 'Old tab', _key: 'o'.repeat(32) }), { v, vpid });
    const noteOf = () => V.evaluate(() => window.M.notes().map((n) => n.msg).find(Boolean) || '');
    await L.until(noteOf, 10000, 200);
    const note = await noteOf();
    ok(/different version of Card Table — reload this page/.test(note), `${label}: refused with the reload note ("${note}")`);
    const states = await V.evaluate(() => window.M.got.state.length);
    await L.act(host, { t: 'chat', msg: `after the ${label} refusal` });
    await h.sleep(1500);
    ok(!(await L.view(host)).players[vpid] && !(L.truthOf(await L.saved(host), pids.host).players[vpid]), `${label}: no seat is created`);
    ok((await V.evaluate(() => window.M.got.state.length)) === states, `${label}: and no more state is sent to that peer`);
    await V.context().close();
  }

  // =========================================================================
  section('(1) 500 random actions from three screens: every view equals the host\'s table');
  const rnd = L.prng(SEED);
  console.log(`  (seed ${SEED}; SEED=… replays the same choices)`);
  const KINDS = [['move', 22], ['flip', 12], ['deal', 10], ['draw', 9], ['play', 12], ['handPile', 4], ['toHand', 5],
    ['toPile', 4], ['rot', 5], ['shuffle', 2], ['peek', 3], ['chat', 7], ['name', 5]];
  const total = KINDS.reduce((s, [, w]) => s + w, 0);
  const kindOf = (x) => { for (const [k, w] of KINDS) if ((x -= w / total) < 0) return k; return 'move'; };
  /** One action through window.__ct.act, built from that screen's own view (ids may be stale: fine). */
  const viaCt = (p, kind, r) => p.evaluate(({ kind, r }) => {
    const v = window.__ct.view(), hand = window.__ct.hand(), ids = Object.keys(v.items).sort();
    const cards = ids.filter((id) => v.items[id].k === 'c'), piles = ids.filter((id) => v.items[id].k === 'p');
    const pick = (xs, x) => xs[Math.floor(x * xs.length)];
    const at = { x: Math.round(250 + r[2] * 700), y: Math.round(230 + r[3] * 700) };
    const h = hand.length ? Math.floor(r[0] * hand.length) : -1;
    const a = {
      move: ids.length && { t: 'move', id: pick(ids, r[0]), ...at },
      flip: ids.length && { t: 'flip', id: pick(ids, r[0]) },
      rot: ids.length && { t: 'rot', id: pick(ids, r[0]), rot: Math.floor(r[1] * 4) * 90 },
      deal: piles.length && { t: 'deal', id: pick(piles, r[0]), up: r[1] < 0.5, rot: 0, ...at },
      draw: piles.length && { t: 'draw', id: pick(piles, r[0]) },
      shuffle: piles.length && { t: 'shuffle', id: pick(piles, r[0]) },
      peek: ids.length && { t: 'peek', id: pick(ids, r[0]) },
      toHand: cards.length && { t: 'toHand', id: pick(cards, r[0]) },
      toPile: cards.length && piles.length && { t: 'toPile', id: pick(cards, r[0]), pile: pick(piles, r[1]) },
      play: h >= 0 && { t: 'play', idx: h, d: hand[h].d, i: hand[h].i, up: r[1] < 0.5, rot: 0, ...at },
      handPile: h >= 0 && piles.length && { t: 'handPile', idx: h, d: hand[h].d, i: hand[h].i, pile: pick(piles, r[1]) },
      chat: { t: 'chat', msg: `chat ${Math.floor(r[0] * 1e6)}` },
    }[kind];
    if (!a) return null;
    window.__ct.act(a);
    return a.t;
  }, { kind, r });
  /** One action through the page's own UI (mouse and form events); false if
   *  there was nothing to do it on. */
  async function viaUi(p, kind, r) {
    await p.keyboard.press('Escape'); // closes a zoom or the action bar left by the last click
    const centers = (sel) => p.$$eval(sel, (els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }));
    const tb = await p.locator('#table').boundingBox();
    const spot = [tb.x + tb.width * (0.3 + 0.4 * r[1]), tb.y + tb.height * (0.3 + 0.4 * r[2])];
    switch (kind) {
      case 'move': case 'flip': {
        const cs = await centers('.item');
        if (!cs.length) return false;
        const [x, y] = cs[Math.floor(r[0] * cs.length)];
        if (kind === 'flip') { await p.mouse.dblclick(x, y); return true; } // a card flips, a pile draws
        await p.mouse.move(x, y);
        await p.mouse.down();
        await p.mouse.move(spot[0], spot[1], { steps: 8 });
        await p.mouse.up();
        return true;
      }
      case 'deal': {
        const cs = await centers('.item.pile');
        if (!cs.length) return false;
        await p.mouse.click(...cs[Math.floor(r[0] * cs.length)]);
        const btn = await p.waitForSelector(`#action-bar:not(.hidden) [data-cmd="${r[3] < 0.5 ? 'dealup' : 'dealdn'}"]`, { timeout: 800 }).catch(() => null);
        if (!btn) return false; // the click landed on a card lying on the pile
        await btn.click();
        return true;
      }
      case 'play': {
        const n = await h.handCount(p);
        if (!n) return false;
        await h.playFromHand(p, Math.floor(r[0] * n), 0.3 + 0.4 * r[1], 0.3 + 0.4 * r[2]);
        return true;
      }
      case 'chat':
        await p.evaluate((m) => { document.getElementById('chat-input').value = m; document.getElementById('chat-form').requestSubmit(); }, `said ${Math.floor(r[0] * 1e6)}`);
        return true;
      case 'name':
        await p.evaluate((m) => { const el = document.getElementById('name-input'); el.value = m; el.dispatchEvent(new Event('change')); }, `N${Math.floor(r[0] * 1e4)}`);
        return true;
      default: return false;
    }
  }
  const UI_KINDS = new Set(['move', 'flip', 'deal', 'play', 'chat', 'name']);
  const c1 = await counters();
  const done = { ct: 0, ui: 0, none: 0 }, talked = { host: 0, a: 0, b: 0 }, byKind = {};
  for (let n = 1; n <= 500; n++) {
    const who = ['host', 'a', 'b'][Math.floor(rnd() * 3)], r = [rnd(), rnd(), rnd(), rnd()];
    let kind = kindOf(rnd());
    // guests may chat or rename 5 times per 5 s (flood control): keep under it, so every talk counts
    if ((kind === 'chat' || kind === 'name') && Date.now() - talked[who] < 1300) kind = 'move';
    if (kind === 'chat' || kind === 'name') talked[who] = Date.now();
    const ui = kind === 'name' || (UI_KINDS.has(kind) && rnd() < 0.12);
    let did;
    try {
      did = ui ? await viaUi(P[who], kind, r) : await viaCt(P[who], kind, r);
    } catch (err) { // a UI target that moved under the mouse: not a sync failure, and counted below
      console.error(`  action ${n} (${who} ${kind}${ui ? ', UI' : ''}) failed to run:`, err.message.split('\n')[0]);
      did = false;
    }
    done[did ? (ui ? 'ui' : 'ct') : 'none']++;
    if (did) byKind[kind] = (byKind[kind] || 0) + 1;
    await h.sleep(20 + Math.floor(rnd() * 40));
    if (n === 250) await converged('after 250 actions');
  }
  console.log(`  ran ${done.ct} __ct.act and ${done.ui} UI actions (${done.none} had nothing to act on): ${JSON.stringify(byKind)}`);
  ok(done.ui >= 40 && done.ct >= 350, `both paths were exercised (${done.ui} UI actions, ${done.ct} through __ct.act)`);
  await converged('after 500 actions');
  const c2 = await counters();
  ok(c2.a.gaps === c1.a.gaps && c2.b.gaps === c1.b.gaps, `no patch ever missed its base in normal play (gaps: Bob ${c2.a.gaps - c1.a.gaps}, Carol ${c2.b.gaps - c1.b.gaps})`);
  ok(c2.a.snaps === c1.a.snaps && c2.b.snaps === c1.b.snaps && c2.a.patches > c1.a.patches + 100 && c2.b.patches > c1.b.patches + 100,
    `it all travelled as patches: no snapshot after joining (Bob ${c2.a.patches - c1.a.patches} patches/${c2.a.snaps - c1.a.snaps} snapshots, Carol ${c2.b.patches - c1.b.patches}/${c2.b.snaps - c1.b.snaps})`);

  // =========================================================================
  section('(7) the log arrives inside patches, trimmed to the same entries everywhere');
  await host.click('#add-deck-btn'); // a fresh pile for the sections below (the random play may have used them all up)
  await host.click('#deck-add');
  await h.logHas(host, 'added deck "Standard"');
  const actsOf = (log) => log.filter((e) => !e.c && !('n' in e) && !e.k);
  const c3 = await counters();
  {
    const [x, y] = await ids(host);
    for (let k = 0; k < 150; k++) {
      // alternating two different entries (a repeated line collapses into one)
      await L.act(host, k % 2 ? { t: 'rot', id: x, rot: (k % 4) * 90 } : { t: 'move', id: y, x: 300 + (k % 7) * 60, y: 400 });
    }
    for (let k = 0; k < 50; k++) {
      for (const g of [a, b]) await L.act(g, k % 2 ? { t: 'rot', id: y, rot: (k % 4) * 90 } : { t: 'move', id: x, x: 500, y: 300 + (k % 7) * 60 });
      await h.sleep(70); // well inside flood control (20 actions per second per guest)
    }
  }
  const lg = await converged('after 250 more actions');
  ok(actsOf(lg.views.host.log).length === 200, `the action bucket is trimmed to its newest 200 entries (${actsOf(lg.views.host.log).length})`);
  const SPAM = `({ name: 'Log spam', buttons: () => [{ id: 'spam', label: 'Spam' }],
    onButton(t) { for (let k = 0; k < 250; k++) t.say('spam line ' + k); } })`;
  await L.act(host, { t: 'setRules', code: SPAM, enabled: true });
  await L.act(host, { t: 'rulesBtn', id: 'spam' });
  const sp = await converged('after one action that logs 250 lines');
  for (const k of ['a', 'b']) {
    const acts = actsOf(sp.views[k].log).map((e) => e.txt);
    ok(acts.length === 200 && acts[0] === 'spam line 50' && acts[199] === 'spam line 249',
      `${NAMES[k]} keeps exactly lines 50–249 of the 250-line action (${acts[0]} … ${acts.at(-1)}, ${acts.length} action entries)`);
  }
  const c4 = await counters();
  ok(c4.a.snaps === c3.a.snaps && c4.b.snaps === c3.b.snaps, `all those lines came in patches (snapshots: Bob +${c4.a.snaps - c3.a.snaps}, Carol +${c4.b.snaps - c3.b.snaps})`);
  await L.act(host, { t: 'setRules', enabled: false });

  // =========================================================================
  section('(5) a vetoed play reverts on the guest with deltas (Turn order)');
  for (const g of [a, b]) { // each guest holds a card (drawing before the rules guard it)
    if ((await L.view(g)).hand.length) continue;
    const pile = Object.entries((await L.view(g)).items).find(([, it]) => it.k === 'p')[0];
    await L.act(g, { t: 'draw', id: pile });
    await L.until(async () => (await L.view(g)).hand.length > 0, 10000);
  }
  await h.enableRules(host, { tpl: 'turns' });
  await h.logHas(host, '«Turn order» enabled');
  await converged('Turn order on');
  const turn = (await L.view(host)).rules.public.turn;
  const offK = turn === pids.a ? 'b' : 'a', other = offK === 'a' ? 'b' : 'a', off = P[offK];
  ok(turn !== pids[offK], `${NAMES[offK]} is not the player to act (the turn is ${NAMES[Object.keys(pids).find((k) => pids[k] === turn)] || turn}'s)`);
  {
    const before = { host: await ids(host), a: await ids(a), b: await ids(b) };
    const hand0 = (await L.view(off)).hand;
    await off.evaluate(() => { window.__rtc.bodies = []; window.__rtc.keep = true; });
    await h.playFromHand(off, 0, 0.5, 0.38);
    ok(await h.toastHas(off, "It's not your turn").then(() => true, () => false), `${NAMES[offK]} is told it's not their turn`);
    await h.sleep(1500);
    for (const k of Object.keys(P)) {
      const now = await ids(P[k]), dom = await P[k].$$eval('.item', (els) => els.map((e) => e.dataset.id).sort());
      ok(L.same(now, before[k]) && L.same(dom, before[k]), `the card is not on ${NAMES[k]}'s table (${now.length} items, as before)`);
    }
    const v = await L.view(off);
    ok(L.same(v.hand, hand0), `it is back in ${NAMES[offK]}'s hand (${v.hand.length} cards)`);
    const bodies = await off.evaluate(() => { window.__rtc.keep = false; return window.__rtc.bodies.map((x) => x.body); });
    ok(bodies.some((d) => d.kind === 'patch' && L.same(d.hand, hand0)), `the refusal re-sent ${NAMES[offK]}'s hand in a patch (a veto touches the hand, §1c) — ${bodies.length} bodies seen`);
    // a vetoed deal: the pile it names is re-sent unchanged
    const g = P[other], gv = await L.view(g);
    const pile = Object.keys(gv.items).sort().find((id) => gv.items[id].k === 'p');
    if (turn !== pids[other]) {
      await g.evaluate(() => { window.__rtc.bodies = []; window.__rtc.keep = true; });
      await L.act(g, { t: 'deal', id: pile, up: true, x: 400, y: 400, rot: 0 });
      ok(await h.toastHas(g, "It's not your turn").then(() => true, () => false), `${NAMES[other]}'s deal is refused too`);
      await h.sleep(1000);
      const gb = await g.evaluate(() => { window.__rtc.keep = false; return window.__rtc.bodies.map((x) => x.body); });
      const pv = (await L.view(g)).items[pile];
      ok(gb.some((d) => d.kind === 'patch' && d.items && L.same(d.items[pile], pv)), `the refusal re-sent the pile it named, unchanged (n=${pv?.n})`);
      ok(L.same(await ids(g), Object.keys(gv.items).sort()), 'and no card was dealt');
    }
  }

  // =========================================================================
  section('(4) a guest reloads: it gets a snapshot, and its hand is intact');
  {
    const rec = await L.saved(host), handA = L.truthOf(rec, pids.host).hands[pids.a];
    ok(handA.length > 0, `Bob holds ${handA.length} cards before reloading`);
    await a.reload();
    await a.waitForFunction(() => window.__ct?.view().seq > 0 && window.__ct.view().players[localStorage.getItem('ct-pid')]?.online, null, { timeout: 60000 });
    const r4 = await converged('Bob reloaded');
    ok(L.same(r4.views.a.hand, handA), `Bob's hand is intact after the reload (${r4.views.a.hand.length} cards)`);
    ok(r4.views.a.perf.snaps >= 1, `Bob's fresh page was sent a snapshot (${r4.views.a.perf.snaps})`);
  }

  // =========================================================================
  section('(8) private-only commits: nothing is sent, no snapshot is requested, and the chain holds');
  {
    const k0 = await counters();
    const rec0 = await L.saved(host);
    const away = (rec) => (rec?.state.rules?.data?._timers || []).some((x) => x.tag === 'away');
    ok(rec0.state.rules?.name === 'Turn order' && away(rec0), "Bob's return armed Turn order's 10 s 'away' timer");
    const fired = await L.until(async () => !away(await L.saved(host)), 20000, 300);
    ok(fired, "Turn order's timer fired (a commit that only changes rules.data)");
    await h.sleep(1000);
    const k1 = await counters();
    ok(k1.a.patches === k0.a.patches && k1.b.patches === k0.b.patches, `that commit sent the guests nothing (patches: Bob +${k1.a.patches - k0.a.patches}, Carol +${k1.b.patches - k0.b.patches})`);
    const TIMERS = 12, CLICKS = 38; // with Turn order's timer: 51 private-only commits (the host ticks timers every 700 ms)
    const QUIET = `({ name: 'Quiet counter',
      setup(t) { t.data.n = 0; t.schedule(0, 'tick'); },
      onTimer(t, tag) { if (tag === 'tick' && ++t.data.n < ${TIMERS}) t.schedule(0, 'tick'); },
      buttons: () => [{ id: 'count', label: 'Count' }],
      onButton(t) { t.data.clicks = (t.data.clicks || 0) + 1; } })`;
    await L.act(host, { t: 'setRules', code: QUIET, enabled: true });
    await h.sleep(1000);
    const k2 = await counters();
    for (let n = 0; n < CLICKS; n++) { await L.act(host, { t: 'rulesBtn', id: 'count' }); await h.sleep(60); }
    const all = await L.until(async () => { const d = (await L.saved(host))?.state.rules?.data; return d?.n === TIMERS && d.clicks === CLICKS; }, 30000, 300);
    ok(all, `the script ran ${TIMERS} timers and ${CLICKS} button presses, writing only t.data`);
    await h.sleep(800);
    const k3 = await counters();
    ok(k3.a.patches === k2.a.patches && k3.b.patches === k2.b.patches && k3.a.snaps === k2.a.snaps && k3.b.snaps === k2.b.snaps,
      `those ${TIMERS + CLICKS} commits sent the guests nothing (Bob +${k3.a.patches - k2.a.patches} patches, Carol +${k3.b.patches - k2.b.patches})`);
    await L.act(host, { t: 'chat', msg: 'after the quiet commits' });
    for (const g of [a, b]) await h.logHas(g, 'after the quiet commits');
    const k4 = await counters();
    ok(k4.host.seq - k2.host.seq >= TIMERS + CLICKS + 1, `the next patch spans them (seq ${k2.host.seq} → ${k4.host.seq})`);
    ok(k4.a.seq === k4.host.seq && k4.b.seq === k4.host.seq, `and both guests applied it on their old base (seq ${k4.a.seq}, ${k4.b.seq})`);
    ok(k4.host.snapRequests === k0.host.snapRequests && k4.a.gaps === k0.a.gaps && k4.b.gaps === k0.b.gaps && k4.a.snaps === k0.a.snaps && k4.b.snaps === k0.b.snaps,
      `the guests sent 0 snapshot requests (host saw ${k4.host.snapRequests - k0.host.snapRequests}; gaps ${k4.a.gaps - k0.a.gaps}/${k4.b.gaps - k0.b.gaps}, snapshots ${k4.a.snaps - k0.a.snaps}/${k4.b.snaps - k0.b.snaps})`);
    await converged('after the private commits');
    await L.act(host, { t: 'setRules', enabled: false });
  }

  // =========================================================================
  section('(2) a dropped patch: the guest notices the gap, asks for a snapshot and converges');
  /** Host move number k: item k (in id order) to a spot of its own; returns {id, x, y}. */
  const hostMove = async (k) => {
    const all = await ids(host);
    const to = { id: all[k % all.length], x: 300 + ((k * 97) % 600), y: 330 + ((k * 61) % 500) };
    await L.act(host, { t: 'move', ...to });
    return to;
  };
  // the moves below must each name a different item
  for (let n = (await ids(host)).length; n < 12; n++) {
    const v = await L.view(host), pile = Object.keys(v.items).sort().find((id) => v.items[id].k === 'p');
    await L.act(host, { t: 'deal', id: pile, up: true, x: 300 + n * 40, y: 700, rot: 0 });
  }
  const at = async (p, m) => { const it = (await L.view(p)).items[m.id]; return !!it && Math.abs(it.x - m.x) < 0.5 && Math.abs(it.y - m.y) < 0.5; };
  const title = () => b.$eval('#net-status', (el) => el.title);
  {
    await converged('before the drop', { quiet: 400 });
    const k0 = await counters(), n0 = cons.b.length;
    await b.evaluate(() => { window.__rtc.drop = ['patch']; window.__rtc.dropped = []; });
    const m1 = await hostMove(1);
    await L.until(() => at(a, m1), 5000, 50);
    ok(await L.until(() => b.evaluate(() => window.__rtc.dropped.length === 1), 5000, 50), "one patch to Carol was dropped on the way");
    await h.sleep(300);
    const vb = await L.view(b);
    ok(vb.seq === k0.b.seq && !(await at(b, m1)), `Carol never applies a later patch out of order: she stays on seq ${vb.seq}`);
    const t0 = Date.now();
    const m2 = await hostMove(2);
    const healed = await L.until(async () => (await at(b, m2)) && (await at(b, m1)), 6000, 50);
    const took = Date.now() - t0;
    const k1 = await counters();
    ok(healed && took <= 3000, `the next patch shows a gap: Carol asks for a snapshot and has both moves ${took} ms later (≤ 3 s)`);
    ok(k1.b.gaps === k0.b.gaps + 1 && k1.b.snaps === k0.b.snaps + 1 && k1.host.snapRequests === k0.host.snapRequests + 1,
      `one gap, one request, one snapshot (gaps +${k1.b.gaps - k0.b.gaps}, host saw ${k1.host.snapRequests - k0.host.snapRequests} request, snapshots +${k1.b.snaps - k0.b.snaps})`);
    ok(consoleSince('b', n0, /state gap/).length === 1, `the gap is logged once (console.warn "state gap": ${consoleSince('b', n0, /state gap/).length})`);
    await converged('after the gap');

    // the snapshot that answers the request is lost too: the guest waits (and says so), asks again only after 3 s
    await h.sleep(3200); // past this guest's (and the host's) 3 s window
    const k2 = await counters();
    await b.evaluate(() => { window.__rtc.drop = ['patch', 'snap']; window.__rtc.dropped = []; });
    const m3 = await hostMove(3);
    await L.until(() => b.evaluate(() => window.__rtc.dropped.length === 1), 5000, 50);
    const asked = Date.now();
    const m4 = await hostMove(4);
    ok(await L.until(() => b.evaluate(() => window.__rtc.dropped.length === 2), 5000, 50), 'the snapshot sent in answer was dropped as well');
    ok((await title()).includes('re-syncing with the host…'), `meanwhile the status tooltip says so ("${(await title()).split(' · ').pop()}")`);
    ok(!(await at(b, m3)) && !(await at(b, m4)), 'and Carol shows neither move (no patch applied out of order)');
    const m5 = await hostMove(5); // another gap within 3 s of the request
    await L.until(() => at(a, m5), 5000, 50);
    await h.sleep(600);
    const k3 = await counters();
    ok(k3.host.snapRequests === k2.host.snapRequests + 1, `a gap within 3 s of the last request asks nothing more (host saw ${k3.host.snapRequests - k2.host.snapRequests} request so far)`);
    await h.sleep(Math.max(0, asked + 3600 - Date.now())); // past Carol's 3 s window (she asked just after `asked`)
    const m6 = await hostMove(6);
    const back = await L.until(async () => (await at(b, m6)) && (await at(b, m5)) && (await at(b, m3)), 6000, 50);
    const k4 = await counters();
    ok(back && k4.host.snapRequests === k2.host.snapRequests + 2, `after 3 s the next gap asks again and Carol catches up (requests ${k4.host.snapRequests - k2.host.snapRequests})`);
    ok(!(await title()).includes('re-syncing'), 'and the tooltip no longer says re-syncing');
    await converged('after the lost snapshot');
  }

  // =========================================================================
  section('1j case 1: a patch signed by another key, and a host patch relayed to another peer, are dropped');
  const bPeer = await b.evaluate(() => import('https://cdn.jsdelivr.net/npm/trystero@0.25.3/nostr/+esm').then((m) => m.selfId));
  {
    await converged('Mallory is in the room', { quiet: 600 });
    const vb = await L.view(b), n0 = cons.b.length;
    const id = Object.keys(vb.items).sort()[0];
    const forged = { to: null, tp: bPeer, base: vb.seq, v: h.PROTO, kind: 'patch', boot: vb.boot, seq: vb.seq + 1, host: vb.host,
      items: { [id]: { ...vb.items[id], x: 40, y: 600 } }, log: [{ p: 'RULES', txt: 'FORGED PATCH', ts: Date.now() }] };
    await M.evaluate(async ({ body, to }) => {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
      const text = JSON.stringify(body);
      const s = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(text));
      await window.M.send.state({ b: text, s: b64(s), k: b64(await crypto.subtle.exportKey('raw', kp.publicKey)) }, to);
    }, { body: forged, to: bPeer });
    await h.sleep(1000);
    const v1 = await L.view(b);
    ok(v1.seq === vb.seq && L.same(v1.items[id], vb.items[id]) && !JSON.stringify(v1.log).includes('FORGED'), "a patch signed with Mallory's own key changes nothing on Carol's screen");
    ok(consoleSince('b', n0, /not signed by the host/).length >= 1, 'Carol drops it as not signed by the host');

    // the real patch to Carol is lost, and Mallory relays her own (validly signed) copy instead
    await b.evaluate(() => { window.__rtc.drop = ['patch']; window.__rtc.dropped = []; });
    await M.evaluate((to) => {
      const n = window.M.got.state.length;
      const t = setInterval(() => {
        for (const { m } of window.M.got.state.slice(n)) {
          const d = typeof m.b === 'string' ? JSON.parse(m.b) : m;
          if (d.kind !== 'patch') continue;
          clearInterval(t);
          window.M.relayed = d;
          window.M.send.state(m, to);
          return;
        }
      }, 5);
    }, bPeer);
    const m7 = await hostMove(7);
    await L.until(() => M.evaluate(() => !!window.M.relayed), 5000, 50);
    await h.sleep(800);
    const relayed = await M.evaluate(() => window.M.relayed);
    const v2 = await L.view(b);
    ok(relayed?.base === v1.seq && relayed.tp !== bPeer, `Mallory relayed the host's patch that Carol missed (base ${relayed?.base}, bound to Mallory's connection)`);
    ok(v2.seq === v1.seq && !(await at(b, m7)), "Carol drops it: it isn't bound to her connection (tp)");
    ok(consoleSince('b', n0, /relayed by/).length >= 1, 'and says so (console.warn)');
    await h.sleep(2500); // Carol's last snapshot request was over 3 s ago
    const m8 = await hostMove(8);
    ok(await L.until(async () => (await at(b, m8)) && (await at(b, m7)), 6000, 50), 'the next real patch shows the gap and Carol catches up');
  }

  // =========================================================================
  section('(9) knock spam (1j case 5): at most one snapshot per 3 s');
  const snapsAfter = (since) => M.evaluate((since) => window.M.got.state.filter((x) => (x.at ?? 0) > since)
    .map(({ m, at }) => ({ at, kind: (typeof m.b === 'string' ? JSON.parse(m.b) : m).kind })).filter((x) => x.kind === 'snap'), since);
  // the host spaces them ≥ 3 s apart; arrival times jitter, so allow some slack (an unlimited host sends dozens)
  const spaced = (s) => s.every((x, k) => !k || x.at - s[k - 1].at >= 2500);
  {
    await h.sleep(3200); // Mallory's join snapshot is out of the window
    const n0 = cons.host.length;
    const t0 = await M.evaluate(async (v) => {
      const t0 = performance.now();
      for (let k = 0; k < 100; k++) { window.M.send.act({ t: 'hello', _v: v }); await new Promise((r) => setTimeout(r, 9)); }
      return t0;
    }, h.PROTO);
    await h.sleep(5500);
    const s = await snapsAfter(t0);
    ok(s.length >= 1 && s.length <= 2 && spaced(s), `100 anonymous knocks in ~1 s got ${s.length} snapshots in 6.5 s, ${s.length > 1 ? `${Math.round(s[1].at - s[0].at)} ms apart` : 'one'} (≤ 1 per 3 s)`);
    ok(consoleSince('host', n0, /snapshot request/i).length === 1, `the extra requests are reported once (${consoleSince('host', n0, /snapshot request/i).length} console.warn)`);
    // §0.2: every `items` object lists its ids in sorted order, so the order never tells which card came first
    const order = await M.evaluate(() => window.M.got.state.map(({ m }) => [...String(m.b).matchAll(/"([0-9a-f]{8})":\{"k"/g)].map((x) => x[1])));
    ok(order.length > 5 && order.every((l) => l.every((id, k) => !k || l[k - 1] < id)),
      `each of the ${order.length} snapshots and patches she got lists its items in id order (${order.reduce((n, l) => n + l.length, 0)} entries)`);
  }

  // =========================================================================
  section('1j case 7: `_join` and `__proto__` are refused, with no state change');
  {
    await M.evaluate(() => window.M.act({ t: 'hello' })); // Mallory takes a seat
    await host.waitForFunction(() => window.__ct.view().players.ffffffffffffffff, null, { timeout: 10000 });
    await h.sleep(1500);
    const s0 = (await L.saved(host)).state.seq, n0 = await M.evaluate(() => window.M.got.note.length), c0 = cons.host.length;
    await M.evaluate(() => { window.M.act({ t: '_join' }); window.M.act({ t: '__proto__' }); });
    await h.sleep(1500);
    const notes = await M.evaluate((n) => window.M.notes().slice(n).map((x) => x.msg), n0);
    ok(notes.some((m) => /Unknown action/.test(m)), `Mallory is told the action is unknown (${JSON.stringify(notes)})`);
    ok(consoleSince('host', c0, /refused an action/).length === 2, `the host refuses both (${consoleSince('host', c0, /refused an action/).length} console.warn)`);
    ok((await L.saved(host)).state.seq === s0, `the table did not change (seq ${s0})`);
    ok(await host.evaluate(() => Object.keys(Object.prototype).length === 0), 'Object.prototype is untouched');
  }

  section('1j case 4: 100 `snap` requests in 1 s from a seated peer: at most one snapshot per 3 s');
  {
    await h.sleep(3200); // her seat's snapshot is out of the window
    const t0 = await M.evaluate(async () => {
      const t0 = performance.now();
      for (let k = 0; k < 100; k++) { window.M.act({ t: 'snap' }); await new Promise((r) => setTimeout(r, 9)); }
      return t0;
    });
    await h.sleep(5500);
    const s = await snapsAfter(t0);
    ok(s.length >= 1 && s.length <= 2 && spaced(s), `she got ${s.length} snapshots in 6.5 s, ${s.length > 1 ? `${Math.round(s[1].at - s[0].at)} ms apart` : 'one'} (≤ 1 per 3 s)`);
  }
  await M.context().close();

  // =========================================================================
  section('(3) the host reloads mid-game: the guests take the new snapshot and converge');
  {
    await converged('before the host reloads', { quiet: 1500 });
    const rec = await L.saved(host), before = L.truthOf(rec, pids.host), k0 = await counters();
    await host.reload();
    await host.waitForFunction(() => window.__ct?.view().seq > 0, null, { timeout: 30000 });
    const ready = await L.until(async () => {
      const v = await L.view(host);
      return v.players[pids.a]?.online && v.players[pids.b]?.online;
    }, 40000, 300);
    ok(ready, 'both guests are back at the reloaded host');
    const r3 = await converged('host reloaded', { timeout: 30000 });
    const k1 = await counters();
    ok(k1.a.boot > k0.a.boot && k1.b.boot > k0.b.boot && k1.a.boot === k1.host.boot, `the guests follow the new epoch (boot ${k0.a.boot} → ${k1.a.boot})`);
    ok(k1.a.snaps > k0.a.snaps && k1.b.snaps > k0.b.snaps, 'by way of a snapshot');
    for (const k of ['a', 'b']) ok(L.same(r3.views[k].hand, before.hands[pids[k]]), `${NAMES[k]}'s hand survived the host's reload (${r3.views[k].hand.length} cards)`);
    ok(L.same(r3.views.a.items, before.items), 'the table is the one that was saved');
  }

  section('the retired `log` channel carries nothing');
  for (const [k, p] of Object.entries(P)) {
    const r = await p.evaluate(() => window.__rtc);
    ok(!r.sent.log && !r.recv.log, `${NAMES[k]} sent and received nothing on 'log' (state: ${r.recv.state || 0} B in, ${r.sent.state || 0} B out)`);
  }
  await env.done();
})().catch(h.crash);
