// The state core (core.js) in plain Node, no browser: a table is created,
// dealt, shuffled, played and redacted; cleanDeck turns a hostile deck away;
// the rules facade runs a template's setup and validate; a save round-trips
// (and an old-format or corrupt save still loads). Also: core.js stays
// DOM-free, hostile actions never throw out of apply, player ids and async
// hooks are refused, seeded tables replay alike, and shuffles batch crypto.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./h');
const { ok, section } = h;

const APP = path.join(h.APP_ROOT, 'cardtable');
const HOST = 'a'.repeat(16), BOB = 'b'.repeat(16), CAROL = 'c'.repeat(16);
const json = (o) => JSON.parse(JSON.stringify(o));

/** Runs one scenario; a throw is a failed check, not the end of the suite. */
function guard(fn) { try { fn(); } catch (e) { ok(false, 'scenario crashed: ' + e.stack); } }

(async () => {
  const core = await import(pathToFileURL(path.join(APP, 'core.js')));
  const { RULES_TEMPLATES } = await import(pathToFileURL(path.join(APP, 'templates.js')));
  const { createTable, cleanDeck, RULES, own } = core;
  /** A fresh table: the host (Alice) and Bob seated, one standard deck in the middle. */
  const fresh = (env = {}) => {
    const T = createTable({}, { pid: HOST, ...env });
    T.open('Alice');
    T.join(BOB, 'Bob', 'k'.repeat(32));
    return T;
  };
  const pileOf = (T) => Object.keys(T.state.items).find((id) => T.state.items[id].k === 'p');

  section('core.js is DOM-free and self-contained');
  const src = fs.readFileSync(path.join(APP, 'core.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // code only
  const used = src.match(/\b(window|document|localStorage|sessionStorage|setTimeout|setInterval|fetch|joinRoom)\b/g);
  ok(!used, `no DOM, storage, timer or network APIs (${used || 'none'})`);
  ok(!/^\s*import\b/m.test(src), 'it imports nothing');

  section('a table is created, dealt, shuffled and played');
  guard(() => {
    const T = fresh();
    const deck = pileOf(T);
    ok(T.state.items[deck].cards.length === 52, 'a fresh table holds one 52-card deck');
    ok(T.state.players[HOST].name === 'Alice' && T.state.players[BOB].seat === 270, 'Alice sits at the bottom (90°), Bob opposite (270°)');
    const before = T.state.items[deck].cards.map((c) => c.i).join();
    const seq = T.state.seq;
    ok(T.apply(HOST, { t: 'shuffle', id: deck }) && T.state.seq === seq + 1, 'a shuffle changes the table and renumbers it');
    const after = T.state.items[deck].cards.map((c) => c.i);
    ok(after.join() !== before && [...after].sort((a, b) => a - b).join() === [...Array(52).keys()].join(), 'the shuffle reorders the deck (a permutation of the 52)');
    T.apply(HOST, { t: 'deal', id: deck, x: 300, y: 300, up: false });
    const dealt = Object.entries(T.state.items).find(([, it]) => it.k === 'c');
    ok(dealt && dealt[1].up === false && T.state.items[deck].cards.length === 51, 'a deal puts a face-down card on the table');
    T.apply(BOB, { t: 'draw', id: deck });
    const card = T.state.players[BOB].hand[0];
    ok(T.state.players[BOB].hand.length === 1, 'Bob draws a card into his hand');
    T.apply(BOB, { t: 'play', idx: 0, d: card.d, i: card.i, x: 500, y: 500, up: true });
    const played = Object.values(T.state.items).find((it) => it.k === 'c' && it.up);
    ok(played && played.i === card.i && !T.state.players[BOB].hand.length, 'he plays it face up');
    ok(T.state.log.some((e) => e.p === BOB && /^played .+ from hand$/.test(e.txt)), `the log names the played card ("${T.state.log.at(-1).txt}")`);
    const fx = T.drain().filter((e) => e.t === 'fx');
    ok(fx.length >= 4 && fx.every((e) => e.f.id), `every op queued an action marker for the app (${fx.length})`);
    ok(!T.drain().length, 'drain() hands each effect over once');
  });

  section('an injected RNG drives shuffles (env.random)');
  guard(() => {
    const T = fresh({ random: () => 0 }); // j = 0 every step: a fixed rotation
    const deck = pileOf(T);
    T.apply(HOST, { t: 'shuffle', id: deck });
    ok(T.state.items[deck].cards.map((c) => c.i).join() === [...Array(51).keys()].map((i) => i + 1).concat(0).join(), 'the same RNG gives the same order');
  });

  section('the public view redacts hidden identities');
  guard(() => {
    const T = fresh();
    const deck = pileOf(T);
    T.apply(HOST, { t: 'deal', id: deck, x: 300, y: 300, up: false });
    T.apply(HOST, { t: 'deal', id: deck, x: 500, y: 300, up: true });
    T.apply(BOB, { t: 'draw', id: deck });
    const pub = T.publicItems();
    const down = Object.values(pub).find((it) => it.k === 'c' && !it.up), up = Object.values(pub).find((it) => it.k === 'c' && it.up);
    ok(down && !('i' in down) && down.d, 'a face-down card keeps its deck (for the back), not its index');
    ok(up && Number.isInteger(up.i), 'a face-up card shows its index');
    const p = pub[deck];
    ok(p.n === 49 && !('cards' in p) && p.top && !('i' in p.top) && p.top.up === false, 'a pile is a count plus a face-down top without identity');
    T.apply(HOST, { t: 'flip', id: deck });
    ok(Number.isInteger(T.publicItems()[deck].top.i), 'flipped face up, the pile shows its top card');
    const pl = T.publicPlayers()[BOB];
    ok(pl.handCount === 1 && !('hand' in pl) && !('key' in pl), 'players show hand counts, never hands or seat keys');
    const hidden = T.state.players[BOB].hand[0];
    ok(!JSON.stringify(T.publicPlayers()).includes('"hand"') && !Object.values(T.publicItems()).some((it) => it.k === 'c' && it.d === hidden.d && it.i === hidden.i), "Bob's hand card is nowhere in the public view");
  });

  section('cleanDeck turns hostile decks away');
  guard(() => {
    const throws = (d, why) => { try { cleanDeck(d); ok(false, why); } catch (e) { ok(true, `${why} (${e.message})`); } };
    throws(null, 'not a deck');
    throws({ cards: [] }, 'no cards');
    throws({ cards: 'x' }, 'cards not a list');
    throws({ cards: Array(5001).fill({ r: 'A', s: '♠' }) }, 'over 5000 cards');
    throws({ cards: [{ img: 'data:image/png;base64,' + 'A'.repeat(25e6) }] }, 'over 24 MB of images');
    const d = cleanDeck({
      name: '\u001b[2J<b>Evil</b> deck name way too long', back: 'url(javascript:alert(1))', imgs: ['javascript:alert(1)'],
      cards: [
        { img: 'data:text/html;base64,PHNjcmlwdD4=', col: 'red;background:url(x)', b: '#123', n: '\u001b[31mred\u0007', txt: 'one\ntwo\u0000', meta: { big: 'x'.repeat(3000) }, onload: 'alert(1)', g: 0 },
        { r: '<img>', s: '♠', meta: { cost: 3 } }, 'junk', { r: 'Q', s: '♥', c: 'x' },
      ],
    });
    const [a, b, c, q] = d.cards;
    ok(d.name === '[2J<b>Evil</b> deck name' && d.back === null && d.imgs[0] === null, 'the name loses control chars and is capped; a script back and image are dropped');
    ok(!a.img && !a.col && a.b === '#123' && !('onload' in a) && !('g' in a) && !('meta' in a), 'a non-image data URL, a CSS-injecting color, unknown fields, a dangling image ref and oversized meta are dropped');
    ok(a.n === '[31mred' && a.txt === 'one\ntwo', 'names and texts lose control characters (texts keep newlines)');
    ok(!b.r && b.meta.cost === 3 && JSON.stringify(c) === '{}' && q.r === 'Q' && q.c === 'b', 'bad ranks and non-object cards carry nothing; small meta survives');
    ok(Object.getPrototypeOf(cleanDeck({ cards: [JSON.parse('{"__proto__": {"x": 1}, "meta": {"__proto__": {"y": 1}}}')] }).cards[0]) === Object.prototype, 'a "__proto__" key pollutes nothing');
  });

  section("the facade runs a template's setup and validate");
  guard(() => {
    const T = fresh();
    T.join(CAROL, 'Carol', 'c'.repeat(32));
    T.drain();
    T.apply(HOST, { t: 'setRules', code: RULES_TEMPLATES.turns, enabled: true });
    const r = T.state.rules;
    ok(r?.enabled && r.name === 'Turn order' && !T.rulesError, '«Turn order» is enabled');
    ok(r.public.turn === HOST && r.data.turn === HOST, 'setup() gave the turn to the first seat');
    ok(T.state.log.some((e) => e.p === RULES && e.txt === 'Turn order: Alice → Carol → Bob'), 'setup() said the order in the log (as 📜 Rules)');
    const deck = pileOf(T);
    T.apply(BOB, { t: 'draw', id: deck });
    ok(!T.state.players[BOB].hand.length, "an out-of-turn draw is vetoed");
    ok(T.drain().some((e) => e.t === 'note' && e.p === BOB && e.msg === "🚫 It's not your turn"), 'and Bob is told why');
    T.apply(HOST, { t: 'draw', id: deck });
    const c = T.state.players[HOST].hand[0];
    T.apply(HOST, { t: 'play', idx: 0, d: c.d, i: c.i, up: true });
    ok(T.state.rules.public.turn === CAROL, 'a play passes the turn on (onAction)');
    T.apply(HOST, { t: 'setRules', code: RULES_TEMPLATES.holdem, enabled: true });
    ok(T.state.rules.name === "Hold'em (chips)" && T.api.data.stacks[BOB] === 1000 && T.api.public.badges[CAROL] === '💰1000', "Hold'em's setup gives everyone 💰1000");
    T.apply(HOST, { t: 'rulesBtn', id: 'new' });
    ok([HOST, BOB, CAROL].every((p) => T.state.players[p].hand.length === 2), 'its New hand button deals two hole cards each');
    T.apply(HOST, { t: 'setRules', code: '({ name: "Broken", setup() { throw new Error("boom"); } })', enabled: true });
    ok(!T.state.rules.enabled && T.rulesError === 'setup(): boom', 'a throwing setup() disables the rules, with the error for the dialog');
    ok(T.drain().some((e) => e.t === 'toast' && /Rules disabled — error in setup\(\): boom/.test(e.msg)), 'loudly (a toast for the host)');
  });

  section('every shipped template loads; flood control runs on the injected clock');
  guard(() => {
    const names = Object.entries(RULES_TEMPLATES).map(([k, code]) => [k, core.scriptHooks().load(code)]);
    ok(names.length >= 6 && names.every(([, n]) => n && n !== 'Rules'), `each evaluates to a named script (${names.map(([, n]) => n).join(', ')})`);
    let clock = 0;
    const T = fresh({ now: () => clock });
    const acts = Array.from({ length: 41 }, () => T.mayAct(BOB));
    ok(acts.slice(0, 40).every(Boolean) && !acts[40], 'a guest may send a burst of 40 actions, not 41');
    clock += 1000;
    ok(Array.from({ length: 21 }, () => T.mayAct(BOB)).filter(Boolean).length === 20, 'then 20 more per second');
    const said = Array.from({ length: 6 }, (_, k) => T.apply(BOB, { t: 'chat', msg: `hi ${k}` }));
    ok(said.slice(0, 5).every(Boolean) && !said[5] && T.drain().some((e) => e.t === 'note' && e.p === BOB && /Slow down/.test(e.msg)), 'chat: 5 per 5 s, then the guest is told to slow down (and nothing changes)');
    clock += 5001;
    ok(T.apply(BOB, { t: 'chat', msg: 'again' }), 'five seconds later they may talk again');
  });

  section('a save round-trips');
  guard(() => {
    const T = fresh();
    T.apply(HOST, { t: 'setRules', code: RULES_TEMPLATES.holdem, enabled: true });
    T.apply(HOST, { t: 'rulesBtn', id: 'new' });
    T.leave(BOB);
    const snap = T.snapshot();
    ok(!('decks' in snap) && 'decks' in T.state, 'the snapshot leaves the decks out (they are saved apart)');
    const saved = { state: json(snap), decks: json(T.state.decks) };
    const T2 = createTable({ ...saved.state, decks: saved.decks }, { pid: HOST });
    T2.resume('Alice');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const cards = (t) => Object.entries(t.state.decks).map(([id, d]) => [id, d.name, d.cards]);
    ok(same(T2.state.items, T.state.items) && same(cards(T2), cards(T)), 'the table and its decks come back as they were');
    ok(same(T2.state.players[BOB].hand, T.state.players[BOB].hand) && T2.state.keys[BOB] === 'k'.repeat(32), "Bob's hand and seat key are kept");
    ok(!T2.state.players[BOB].online && T2.state.players[HOST].online, 'everyone but the host waits offline until they reconnect');
    ok(T2.state.rules.enabled && same(T2.state.rules.data, T.state.rules.data) && T2.drain().some((e) => e.t === 'rules'), "Hold'em's code reloads, its state kept");
    ok(T2.state.seq === T.state.seq + 1 && T2.state.log.at(-1).txt === 'resumed the table', 'the resume is logged and renumbered');
    T2.apply(HOST, { t: 'rulesBtn', id: T2.api.public.buttons.find((b) => b.pid === HOST)?.id });
    ok(T2.state.seq > T.state.seq + 1, "and the resumed game plays on (the host's button works)");
  });
  guard(() => {
    // An old save: no log, no size, no seats, an item off the round felt, a broken script.
    const T = createTable({
      seq: 7,
      items: { x1: { k: 'c', x: 5000, y: -900, rot: 0, z: 1, d: 'dd', i: 0, up: true } },
      players: { [BOB]: { name: 'Bob', color: '#30bced', online: true, hand: [] } },
      rules: { code: '({ name: ', name: 'Old', enabled: true, data: {}, public: {} },
      decks: { dd: { name: 'Old', cards: [{ r: 'A', s: '♠' }], extra: '<script>' }, bad: { cards: [] } },
    }, { pid: HOST });
    T.resume('Alice');
    const it = T.state.items.x1, g = T.api.geom();
    ok(T.state.size === 1300 && Math.hypot(it.x + 50 - g.cx, it.y + 70 - g.cy) <= g.r + 1e-9, 'the size defaults and stranded items are pulled onto the felt');
    ok(T.state.players[BOB].seat === 90 && T.state.players[HOST].seat === 270, 'seats are assigned');
    ok(!T.state.rules.enabled && T.rulesError && T.drain().some((e) => e.t === 'toast' && /Saved rules failed to load/.test(e.msg)), 'a saved script that no longer loads disables the rules, loudly');
    ok(!('extra' in T.state.decks.dd) && !('bad' in T.state.decks), 'saved decks pass the sanitizer again (an unusable one is dropped)');
    ok(T.state.log.length === 1 && T.state.seq === 8, 'the log starts with the resume');
  });
  guard(() => {
    // Corrupt storage: the deck map saved as a string, or as an array.
    for (const [what, decks] of [['a string', 'xyz'], ['an array', [core.standardDeck(false)]]]) {
      const T = createTable({ items: {}, players: {}, decks }, { pid: HOST });
      try { T.resume('Alice'); } catch (e) { ok(false, `decks saved as ${what}: the resume crashed (${e.message})`); continue; }
      T.apply(HOST, { t: 'addDeck', deck: { name: 'Later', cards: [{ n: 'x' }] } });
      const back = Object.values(json(T.state.decks)).map((d) => d.name);
      ok(Object.getPrototypeOf(T.state.decks) === Object.prototype && back.at(-1) === 'Later' && back.length === (what === 'a string' ? 1 : 2),
        `decks saved as ${what}: the table resumes on a plain deck map, and a later deck is saved (${back})`);
    }
  });

  section('core reads the deck map afresh (a resync may replace it)');
  guard(() => {
    const T = fresh();
    T.state.decks = { ...T.state.decks, ab12cd34: { name: 'Fresh', back: null, imgs: [], cards: [{ n: 'Fresh card' }] } };
    const ref = { d: 'ab12cd34', i: 0 };
    ok(T.api.cardName(ref) === 'Fresh card' && T.api.card(ref)?.deck === 'Fresh', 't.cardName and t.card see the new map');
    const id = T.api.newDeck({ name: 'Scripted', cards: [{ name: 'one' }] });
    ok(T.state.decks[id]?.name === 'Scripted' && T.state.decks.ab12cd34, 'and new decks land in it');
  });

  section('hostile hand indexes are no-ops, not crashes');
  guard(() => {
    const T = fresh();
    const deck = pileOf(T), items = Object.keys(T.state.items).length;
    const hostile = [{ t: 'play', idx: 0 }, { t: 'play', idx: 7, x: 1, y: 1 }, { t: 'play', idx: -1 }, { t: 'handPile', idx: 0, pile: deck }, { t: 'handPile', idx: 3, d: 'x', i: 0, pile: deck }];
    for (const a of hostile) {
      try { T.apply(BOB, a); } catch (e) { ok(false, `${JSON.stringify(a)} from an empty hand threw: ${e.message}`); }
    }
    ok(Object.keys(T.state.items).length === items && T.state.items[deck].cards.length === 52, 'a play or discard past the end of an empty hand changes nothing');
    T.apply(BOB, { t: 'draw', id: deck });
    T.apply(BOB, { t: 'play', idx: 4 });
    ok(T.state.players[BOB].hand.length === 1, 'nor does one past the end of a hand of one');
  });

  section('a fuzzer of hostile actions never crashes the table');
  guard(() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const junk = [undefined, null, -1, 0, 1, 7, 1e9, NaN, Infinity, 1.5, 'x', '', '__proto__', 'constructor', {}, [], true];
    const kinds = [...core.RULED_ACTIONS, 'name', 'chat', 'size', 'rulesBtn', 'hello', 'bogus', '__proto__'];
    const crashes = {}, quiet = [console.warn, console.error];
    console.warn = console.error = () => {}; // the fuzzer provokes refusals by the thousand
    try {
      for (const tpl of [null, 'holdem']) {
        const T = fresh({ random: rnd });
        T.join(CAROL, 'Carol', 'c'.repeat(32));
        if (tpl) T.apply(HOST, { t: 'setRules', code: RULES_TEMPLATES[tpl], enabled: true });
        for (let n = 0; n < 1500; n++) {
          if (Object.keys(T.state.items).length < 4) T.api.addStandardDeck({ x: rnd() * 1000, y: rnd() * 1000 }); // deletes empty the table
          const ids = Object.keys(T.state.items), p = pick([HOST, BOB, CAROL, '__proto__', 'nobody']);
          const hand = own(T.state.players, p)?.hand || [], c = rnd() < 0.5 ? pick(hand) || {} : {};
          const any = () => (rnd() < 0.7 && ids.length ? pick(ids) : pick(junk));
          const a = {
            t: pick(kinds), id: any(), pile: any(), onto: any(), idx: rnd() < 0.5 ? Math.floor(rnd() * (hand.length + 2)) : pick(junk),
            d: c.d ?? pick(junk), i: c.i ?? pick(junk), x: rnd() < 0.8 ? rnd() * 2600 - 650 : pick(junk), y: rnd() * 1300, rot: pick([90, -45, ...junk]),
            up: pick(junk), msg: pick(['hi', ...junk]), name: pick(['N', ...junk]), size: pick([1800, ...junk]),
            deck: rnd() < 0.03 ? pick([{ cards: [{ n: 'a' }] }, { cards: [null, 'x', { r: 'A', s: '♠' }] }, ...junk]) : undefined,
          };
          if (a.t === 'rulesBtn') a.id = pick([...(T.state.rules?.public?.buttons || []).map((b) => b.id), ...junk]);
          try { T.apply(p, a); } catch (e) { const k = `${a.t}: ${e.message}`; crashes[k] = (crashes[k] || 0) + 1; }
          T.drain();
        }
        const items = Object.values(T.state.items);
        ok(items.every((it) => Number.isFinite(it.x) && Number.isFinite(it.y) && Number.isFinite(it.rot) && (it.k === 'c' || Array.isArray(it.cards))),
          `${tpl || 'free table'}: after 1500 hostile actions every item still has a finite place (${items.length} items)`);
      }
    } finally { [console.warn, console.error] = quiet; }
    ok(!Object.keys(crashes).length, `no action threw out of T.apply (${JSON.stringify(crashes)})`);
    ok(({}).online === undefined && ({}).seat === undefined && ({}).key === undefined, 'Object.prototype is untouched');
  });

  section('player ids are checked in core too');
  guard(() => {
    const T = fresh();
    const r = T.join('__proto__', 'Mallory', 'm'.repeat(32));
    ok(r.known === null && !r.back && ({}).online === undefined && ({}).key === undefined, 'join refuses "__proto__" (Object.prototype stays clean)');
    ok(T.join('Bob', 'Bob', 'k'.repeat(32)).known === null && !('Bob' in T.state.players), 'and any id that is not 16 hex digits');
    const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
    ok(throws(() => createTable({})) && throws(() => createTable({}, { pid: RULES })), "a table needs the host's own id: no actor passes as the host by sending none");
  });

  section('hooks are synchronous: a Promise fails closed');
  guard(() => {
    const T = fresh();
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Veto", async validate() { return "never"; } })' });
    const deck = pileOf(T);
    T.apply(BOB, { t: 'draw', id: deck });
    ok(!T.state.players[BOB].hand.length && T.state.items[deck].cards.length === 52, 'an async validate() blocks the action instead of letting it through');
    ok(!T.state.rules.enabled && /synchronous/.test(T.rulesError), `and disables the rules, loudly ("${T.rulesError}")`);
    const sh = core.scriptHooks(); // a runner that answers later (a Worker would)
    const T2 = fresh({ hooks: { ...sh, call: (...a) => Promise.resolve(sh.call(...a)) } });
    T2.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Veto", validate() { return "never"; } })' });
    T2.apply(BOB, { t: 'draw', id: pileOf(T2) });
    ok(!T2.state.players[BOB].hand.length && !T2.state.rules.enabled, 'so does an asynchronous rules runner');
  });

  section('seeded tables replay alike (env.now, env.random, env.uid)');
  guard(() => {
    const run = () => {
      let s = 1, n = 0, clock = 0;
      const T = createTable({}, {
        pid: HOST, now: () => (clock += 10), random: () => ((s = (s * 16807) % 2147483647) / 2147483647),
        uid: () => (++n).toString(16).padStart(8, '0'),
      });
      T.open('Alice');
      T.join(BOB, 'Bob', 'k'.repeat(32));
      const deck = pileOf(T);
      T.apply(HOST, { t: 'shuffle', id: deck });
      T.apply(HOST, { t: 'deal', id: deck, x: 300, y: 300, up: true });
      T.apply(BOB, { t: 'draw', id: deck });
      T.apply(BOB, { t: 'addDeck', deck: { name: 'D', cards: [{ n: 'a' }] } });
      return JSON.stringify(T.state);
    };
    const a = run();
    ok(a === run() && a.includes('"00000005"'), 'the same seeds give the same state: ids, order and log');
  });

  section('the default RNG draws crypto randomness in batches');
  guard(() => {
    const T = fresh();
    const pile = T.api.newPile(Array.from({ length: 5000 }, (_, i) => ({ d: 'x', i })));
    const gv = crypto.getRandomValues;
    let calls = 0;
    crypto.getRandomValues = function (a) { calls++; return gv.call(this, a); };
    try { T.apply(HOST, { t: 'shuffle', id: pile }); } finally { crypto.getRandomValues = gv; }
    const order = T.state.items[pile].cards.map((c) => c.i);
    ok(calls <= 6 && new Set(order).size === 5000 && order.some((v, k) => v !== k), `a 5000-card shuffle reads the crypto RNG ${calls} times, not once per card`);
  });

  // --- Phase 1: delta sync ------------------------------------------------------
  const { PROTO, trimLog, spliceBody, viewFromSnap, applyViewPatch, migrate, MIGRATE, STATE_V } = core;
  /** A seeded table: host Alice, guests Bob and Carol, a standard deck. */
  const seeded = (seed = 1) => {
    let s = seed, n = 0, clock = 1e12;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const T = createTable({}, { pid: HOST, now: () => (clock += 250), random: rnd, uid: () => (++n).toString(16).padStart(8, '0') });
    T.open('Alice');
    T.join(BOB, 'Bob', 'k'.repeat(32));
    T.join(CAROL, 'Carol', 'c'.repeat(32));
    return { T, rnd };
  };
  /** Top-level keys sorted: dict order on a guest follows patch arrival, not creation. */
  const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  /** One broadcast tick for recipients `views` ({to, view}), as the app runs
   *  it: takeDirty, one shared text, then per recipient a spliced snapshot
   *  (the one numbered `fresh`: a reload), a patch, or nothing. Returns how many got nothing. */
  const tick = (T, views, fresh = -1, boot = 1) => {
    const d = T.takeDirty(), content = T.patchContent(d), seq = T.state.seq;
    const shared = JSON.stringify({ v: PROTO, kind: 'patch', boot, seq, host: HOST, ...content });
    let skipped = 0;
    for (const [k, r] of views.entries()) {
      if (k === fresh) {
        const text = JSON.stringify({ v: PROTO, kind: 'snap', boot, seq, host: HOST, ...T.snapContent(), fx: [], ann: [] });
        r.view = viewFromSnap(JSON.parse(spliceBody({ to: r.to, tp: 'peer', ...(r.to ? { hand: T.state.players[r.to].hand } : {}) }, text)));
        continue;
      }
      const mine = r.to && d.hands.has(r.to);
      if (!Object.keys(content).length && !mine) { skipped++; continue; }
      const body = JSON.parse(spliceBody({ to: r.to, tp: 'peer', base: r.view.seq, ...(mine ? { hand: T.state.players[r.to].hand } : {}) }, shared));
      if (body.base !== r.view.seq || body.boot !== r.view.boot) throw new Error('a patch out of order');
      applyViewPatch(r.view, body);
    }
    return skipped;
  };
  /** A recipient's view from a fresh snapshot (taken right after a takeDirty, as the app does). */
  const snapView = (T, to, boot = 1) => {
    T.takeDirty();
    const text = JSON.stringify({ v: PROTO, kind: 'snap', boot, seq: T.state.seq, host: HOST, ...T.snapContent(), fx: [], ann: [] });
    return { to, view: viewFromSnap(JSON.parse(spliceBody({ to, tp: 'peer', ...(to ? { hand: T.state.players[to].hand } : {}) }, text))) };
  };

  section('Phase 1: T.pub and folded patches match full recomputes through 600 random ops');
  guard(() => {
    const { T, rnd } = seeded(11);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    T.apply(HOST, { t: 'setRules', code: RULES_TEMPLATES.turns, enabled: true });
    const views = [snapView(T, HOST), snapView(T, BOB), snapView(T, null)];
    let pubBad = 0, viewBad = '', skipped = 0, kinds = new Set();
    const quiet = [console.warn, console.error];
    console.warn = console.error = () => {}; // refusals and vetoes by the hundred
    try {
      for (let n = 0; n < 600; n++) {
        const ids = Object.keys(T.state.items), piles = [...T.byKind.get('p')], cards = [...T.byKind.get('c')];
        const p = pick([HOST, BOB, CAROL]), hand = T.state.players[p].hand, c = pick(hand) || {}, idx = hand.indexOf(c);
        const xy = () => ({ x: rnd() * 1000 + 100, y: rnd() * 1000 + 100 });
        const t = T.api;
        const ops = [
          () => T.apply(p, { t: 'move', id: pick(ids), ...xy() }),
          () => T.apply(p, { t: 'rot', id: pick(ids), rot: 90 }),
          () => T.apply(p, { t: 'flip', id: pick(ids) }),
          () => T.apply(p, { t: 'shuffle', id: pick(piles) }),
          () => T.apply(p, { t: 'draw', id: pick(piles) }),
          () => T.apply(p, { t: 'deal', id: pick(piles), up: rnd() < 0.5, ...xy() }),
          () => T.apply(p, { t: 'play', idx, d: c.d, i: c.i, up: rnd() < 0.5, ...xy() }),
          () => T.apply(p, { t: 'handPile', idx, d: c.d, i: c.i, pile: pick(piles) }),
          () => T.apply(p, { t: 'toHand', id: pick(cards) }),
          () => T.apply(p, { t: 'toPile', id: pick(cards), pile: pick(piles) }),
          () => T.apply(p, { t: 'stack', id: pick(cards), onto: pick(cards) }),
          () => T.apply(p, { t: 'merge', id: pick(piles), pile: pick(piles) }),
          () => T.apply(p, { t: 'del', id: pick(cards) }),
          () => T.apply(p, { t: 'peek', id: pick(ids) }),
          () => T.apply(p, { t: 'chat', msg: `hi ${n}` }),
          () => T.apply(p, { t: 'name', name: `N${n % 7}` }),
          () => T.apply(HOST, { t: 'size', size: pick([1300, 1800, 2400]) }),
          () => t.dealToAll(pick(piles), 1, { onlineOnly: false }),
          () => t.takeHand(p, pick(piles)),
          () => hand.length && t.playFromHand(p, 0, { ...xy(), up: rnd() < 0.5 }),
          () => t.toHand(p, pick(cards)),
          () => t.newPile([{ d: 'x', i: 1 }, { d: 'x', i: 2, up: true }], xy()),
          () => t.say('rules say ' + n),
          () => { t.public.note = n; t.data.n = n; }, // private and public rules data, no op
          () => T.leave(pick([BOB, CAROL])),
          () => T.join(pick([BOB, CAROL]), 'Back', 'k'.repeat(32)),
          () => T.runTimers(),
        ];
        if (ids.length < 6) t.addStandardDeck(xy());
        const k = Math.floor(rnd() * ops.length);
        kinds.add(k);
        ops[k]();
        T.drain();
        const full = T.publicItems();
        if (canon(Object.fromEntries(T.pub)) !== canon(full)) pubBad++;
        skipped += tick(T, views, rnd() < 0.15 ? pick([0, 1, 2]) : -1); // now and then a peer reloads: a snapshot
        for (const r of views) {
          const snap = T.snapContent(), want = r.to && T.state.players[r.to].hand;
          const bad = canon(r.view.items) !== canon(snap.items) ? 'items' : canon(r.view.players) !== canon(snap.players) ? 'players'
            : JSON.stringify(r.view.log) !== JSON.stringify(snap.log) ? 'log' : want && JSON.stringify(r.view.hand) !== JSON.stringify(want) ? 'hand'
              : JSON.stringify(r.view.rules) !== JSON.stringify(snap.rules) ? 'rules' : r.view.size !== snap.size ? 'size' : '';
          if (bad && !viewBad) viewBad = `op ${n} (#${k}), ${r.to || 'anonymous'}: ${bad}`;
        }
      }
    } finally { [console.warn, console.error] = quiet; }
    ok(kinds.size === 27, `every op kind ran (${kinds.size})`);
    ok(!pubBad, `T.pub deep-equals publicItems() after every op (${pubBad} mismatches)`);
    ok(!viewBad, `host, guest and anonymous views folded from patches equal a fresh snapshot after every tick, hands included${viewBad ? ` — first mismatch: ${viewBad}` : ''}`);
    ok(skipped > 0, `ticks with nothing for a recipient (private-only commits, others' hands) send nothing and keep its base (${skipped})`);
  });

  section('Phase 1: one tick, one patch: only what changed travels');
  guard(() => {
    const { T } = seeded(3);
    const pile = [...T.byKind.get('p')][0];
    for (let k = 0; k < 40; k++) T.api.deal(pile, { x: 100 + k * 20, y: 300, up: true });
    T.takeDirty();
    const card = [...T.byKind.get('c')][5];
    T.apply(BOB, { t: 'move', id: card, x: 700, y: 700 });
    const c = T.patchContent(T.takeDirty());
    ok(Object.keys(c.items).join() === card && c.log.length === 1 && !c.players && !c.del && !('rules' in c), `a move sends that item and its log line (${Object.keys(c).join(', ')})`);
    T.apply(BOB, { t: 'draw', id: pile });
    const d = T.takeDirty(), c2 = T.patchContent(d);
    ok(d.hands.has(BOB) && !d.hands.has(HOST) && Object.keys(c2.players).join() === BOB && !JSON.stringify(c2).includes('"hand"'), "a draw marks Bob's hand dirty; the shared part carries his count, never the hand");
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Quiet" })' });
    T.takeDirty();
    T.api.data.secret = 'x'.repeat(100);
    ok(!Object.keys(T.patchContent(T.takeDirty())).length, 'a change to t.data only (host-private) makes an empty patch');
    T.api.public.round = 2;
    ok(JSON.stringify(T.patchContent(T.takeDirty()).rules) === '{"name":"Quiet","enabled":true,"public":{"round":2}}', 't.public changed in place is found by comparison');
    const ids = Object.keys(T.snapContent().items);
    ok(ids.join() === [...ids].sort().join(), 'snapshot items are in sorted id order');
  });

  section('Phase 1: trimLog keeps the newest of each bucket, however entries are batched');
  guard(() => {
    let s = 5;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const mixed = Array.from({ length: 1000 }, (_, k) => ({ p: 'x', txt: `e${k}`, ts: k, ...(rnd() < 0.3 ? { c: 1 } : rnd() < 0.1 ? { k: 1 } : rnd() < 0.05 ? { n: 'old' } : {}) }));
    let one = [];
    for (const e of mixed) one = trimLog([...one, e]);                    // the host: after every entry
    let batched = [];
    for (let k = 0; k < 1000; k += 137) batched = trimLog(batched.concat(mixed.slice(k, k + 137))); // a guest: per patch
    const all = trimLog(mixed.slice());
    ok(JSON.stringify(one) === JSON.stringify(batched) && JSON.stringify(one) === JSON.stringify(all), `one by one, in batches and all at once agree (${one.length} entries kept)`);
    const count = (l, f) => l.filter(f).length;
    ok(count(one, (e) => e.c || 'n' in e) === 100 && count(one, (e) => e.k) === 50 && count(one, (e) => !e.c && !('n' in e) && !e.k) === 200, 'talk 100, peeks 50, actions 200');
    ok(one.every((e, k) => k === 0 || e.ts > one[k - 1].ts), 'in order');
    const short = [{ p: 'a', txt: 'x', ts: 1 }];
    ok(trimLog(short) === short, 'a log that fits comes back as is');
    // 250 act entries in ONE action: host and guest keep the same 200
    const { T } = seeded(2);
    const g = snapView(T, BOB);
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Spam", buttons: () => [{ id: "go", label: "Go" }], onButton(t) { for (let k = 0; k < 250; k++) t.say("line " + k); } })' });
    T.apply(HOST, { t: 'rulesBtn', id: 'go' });
    tick(T, [g]);
    const txt = T.state.log.map((e) => e.txt);
    ok(JSON.stringify(g.view.log) === JSON.stringify(T.state.log) && txt.length === 200 && txt.at(-1) === 'line 249' && !txt.includes('line 49') && txt.includes('line 50'),
      'one action logging 250 lines leaves the same newest 200 on both sides');
  });

  section('Phase 1: z is a running max');
  guard(() => {
    const { T } = seeded(4);
    const pile = [...T.byKind.get('p')][0], zs = [];
    for (let k = 0; k < 5; k++) { T.apply(HOST, { t: 'deal', id: pile, x: 300, y: 300 }); zs.push(T.state.zMax); }
    const card = [...T.byKind.get('c')][0];
    T.apply(HOST, { t: 'move', id: card, x: 500, y: 500 });
    ok(zs.every((z, k) => k === 0 || z > zs[k - 1]) && T.state.items[card].z === T.state.zMax, `zTop() rises with every op (${zs.join(' ')} … ${T.state.zMax}), the moved card on top`);
    const top = T.state.zMax;
    T.apply(HOST, { t: 'del', id: card });
    const T2 = createTable(json(T.snapshot()), { pid: HOST });
    ok(T2.state.zMax === top, 'createTable restores zMax from the save (not just the highest item left)');
    const T3 = createTable({ items: { a: { k: 'c', x: 0, y: 0, rot: 0, z: 41, d: 'x', i: 0, up: true } }, players: {} }, { pid: HOST });
    ok(T3.state.zMax === 41, 'and computes it for a save without one');
  });

  section('Phase 1: t.item and t.find return detached copies');
  guard(() => {
    const { T } = seeded(6);
    const t = T.api, pile = [...T.byKind.get('p')][0];
    t.deal(pile, { x: 300, y: 300, up: true });
    t.deal(pile, { x: 500, y: 300 });
    const named = t.newPile([{ d: 'x', i: 0, up: true }], { name: 'Discard' });
    const card = [...T.byKind.get('c')][0], it = t.item(card), p = t.item(pile);
    ok(it.id === card && it.k === 'c' && t.item('nope') === null && t.item('__proto__') === null, 't.item finds by id (null when absent)');
    it.x = -1; p.cards.length = 0; p.cards.push({ d: 'zz' });
    ok(T.state.items[card].x !== -1 && T.state.items[pile].cards.length === 50, 'mutating a copy (a pile\'s cards too) leaves the table alone');
    ok(t.find({ kind: 'pile' }).length === 2 && t.find({ kind: 'card' }).length === 2 && t.find().length === 4, 't.find by kind');
    ok(t.find({ name: 'discard' }).map((x) => x.id).join() === named && t.find({ kind: 'card', up: true }).length === 1 && t.find({ kind: 'pile', up: true }).map((x) => x.id).join() === named, 'by name (any case) and by face');
    const throws = (q) => { try { t.find(q); return ''; } catch (e) { return e instanceof TypeError ? e.message : ''; } };
    ok(throws({ zone: 'a' }) === "t.find: unknown filter 'zone' — known: kind, name, up" && /unknown kind/.test(throws({ kind: 'die' })) && /unknown kind/.test(throws({ kind: '__proto__' })), 'an unknown filter or kind throws a TypeError');
    ok(t.piles().length === 2 && t.piles().every((x) => x.k === 'p'), 't.piles() reads the pile index');
  });

  section('Phase 1: t.data has a size limit');
  guard(() => {
    const { T } = seeded(7);
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Hoard", buttons: () => [{ id: "go", label: "Go" }], onButton(t) { t.data.big = "x".repeat(4e6); } })' });
    T.drain();
    T.apply(HOST, { t: 'rulesBtn', id: 'go' });
    ok(!T.state.rules.enabled && /^onButton\(\): t\.data is too large \(4,000,0\d\d chars, max 4,000,000\)$/.test(T.rulesError), `a hook that grows t.data past 4e6 chars disables the rules ("${T.rulesError}")`);
    ok(T.drain().some((e) => e.t === 'toast' && /t\.data is too large/.test(e.msg)), 'loudly');
  });

  section('Phase 1: MIGRATE[1] lifts a v1 save');
  guard(() => {
    const v1 = { seq: 4, items: { a: { k: 'c', x: 0, y: 0, rot: 0, z: 7, d: 'x', i: 0, up: true }, b: { k: 'p', x: 0, y: 0, rot: 0, z: 12, name: '', cards: [] } },
      players: { [BOB]: { name: 'Bob', key: 'k'.repeat(32), hand: [], online: true, seat: 90 }, [CAROL]: { name: 'Carol', hand: [] } } };
    const s = MIGRATE[1](json(v1));
    ok(s.v === 2 && s.keys[BOB] === 'k'.repeat(32) && !('key' in s.players[BOB]) && !(CAROL in s.keys) && s.zMax === 12, 'keys move to state.keys, zMax is the highest z, v becomes 2');
    ok(STATE_V === 2 && migrate(json(v1)).v === 2 && migrate({ v: 2, x: 1 }).x === 1, 'migrate() runs the chain up to STATE_V');
    let err = '';
    try { migrate({ v: STATE_V + 1 }); } catch (e) { err = e.message; }
    ok(/newer Card Table/.test(err), 'a save from a newer version is refused, never downgraded');
    const T = createTable(json(v1), { pid: HOST });
    T.resume('Alice');
    ok(T.state.v === 2 && T.state.keys[BOB] === 'k'.repeat(32) && T.join(BOB, 'Bob', 'wrong'.padEnd(32, '!')) && T.state.keys[BOB] === 'k'.repeat(32), 'a v1 save resumes on v2, the seat still bound to its key');
    ok(!JSON.stringify(T.publicPlayers()).includes('k'.repeat(32)) && !JSON.stringify(T.patchContent(T.takeDirty())).includes('k'.repeat(32)), 'no seat key in a patch or the public view');
  });

  section('Phase 1: a refusal re-sends what the action named');
  guard(() => {
    const { T } = seeded(8);
    const pile = [...T.byKind.get('p')][0];
    T.apply(HOST, { t: 'deal', id: pile, x: 300, y: 300 });
    T.apply(BOB, { t: 'draw', id: pile });
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "No", validate: () => "no" })' });
    T.takeDirty();
    const card = [...T.byKind.get('c')][0], c = T.state.players[BOB].hand[0];
    T.apply(BOB, { t: 'move', id: card, x: 900, y: 900 });
    let d = T.takeDirty();
    ok(d.items.has(card) && T.state.items[card].x !== 900, 'a vetoed move touches the item (its true spot goes out again)');
    T.apply(BOB, { t: 'play', idx: 0, d: c.d, i: c.i, x: 500, y: 500 });
    d = T.takeDirty();
    ok(d.hands.has(BOB) && T.state.players[BOB].hand.length === 1, "a vetoed play re-sends Bob's hand");
    T.apply(BOB, { t: 'toPile', id: card, pile });
    d = T.takeDirty();
    ok(d.items.has(card) && d.items.has(pile), 'a vetoed drop touches the card and the pile');
    const seq = T.state.seq;
    ok(T.refreshFor(BOB, { t: 'move', id: card, onto: '__proto__' }) && T.state.seq === seq + 1 && T.takeDirty().items.has(card), 'refreshFor (a flood refusal) touches and renumbers; junk ids are ignored');
  });

  section('Phase 1: bodies are spliced from one shared text');
  guard(() => {
    const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const hand = [{ d: 'x', i: 1 }];
    const a = parse(spliceBody({ to: BOB, tp: 'p1', base: 4 }, '{}')), b = parse(spliceBody({ to: BOB, tp: 'p1', base: 4, hand }, '{}'));
    const c = parse(spliceBody({ to: null, tp: 'p2', base: 4 }, '{"v":2,"kind":"patch","seq":5}')), e = parse(spliceBody({ to: BOB, tp: 'p1', hand }, '{"v":2,"kind":"snap"}'));
    ok(a?.base === 4 && b?.hand?.[0].i === 1 && c?.seq === 5 && c.to === null && e?.kind === 'snap' && e.hand.length === 1, 'the body parses for an empty and a non-empty shared part, with and without a hand');
  });

  section('Phase 1: applyStatePatch mirrors a table (the seam for a rules Worker)');
  guard(() => {
    const { T } = seeded(9);
    const M = createTable(json(T.snapshot()), { pid: HOST });
    M.state.decks = json(T.state.decks);
    M.takeDirty();
    const pile = [...T.byKind.get('p')][0];
    T.takeDirty();
    T.apply(BOB, { t: 'draw', id: pile });
    T.apply(HOST, { t: 'deal', id: pile, x: 300, y: 300, up: true });
    T.apply(HOST, { t: 'addDeck', deck: { name: 'New', cards: [{ n: 'a' }] } });
    T.apply(HOST, { t: 'setRules', enabled: true, code: '({ name: "Mirror", setup(t) { t.public.x = 1; } })' });
    const d = T.takeDirty(), newDecks = T.drain().filter((e) => e.t === 'deck').map((e) => e.id);
    const patch = json({
      items: Object.fromEntries([...[...d.items].map((id) => [id, T.state.items[id]]), ...[...d.removed].map((id) => [id, null])]),
      players: Object.fromEntries([...d.players].map((p) => [p, T.state.players[p]])),
      decks: Object.fromEntries(newDecks.map((id) => [id, T.state.decks[id]])),
      rules: T.state.rules || undefined, log: d.log, zMax: T.state.zMax, refresh: [pile],
    });
    M.applyStatePatch(patch);
    const strip = (t) => json({ ...t.snapshot(), seq: 0, decks: t.state.decks });
    ok(JSON.stringify(strip(M)) === JSON.stringify(strip(T)), 'the mirror equals the table after the patch');
    const md = M.takeDirty();
    ok(canon(Object.fromEntries(M.pub)) === canon(M.publicItems()) && md.hands.has(BOB) && md.items.has(pile) && md.log.length === d.log.length, 'its dirty sets and T.pub follow (the hand that changed, the items, the log)');
    ok(M.drain().some((e) => e.t === 'deck'), 'a new deck is announced for the decks channel');
  });

  h.report();
})().catch(h.crash);
