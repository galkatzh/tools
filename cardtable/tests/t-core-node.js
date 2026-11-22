// The state core (core.js) in plain Node, no browser: a table is created,
// dealt, shuffled, played and redacted; the deck gates (cleanDeckV1 for
// uploads, cleanDeck for the catalog) turn a hostile deck away;
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
  const { createTable, cleanDeck, cleanDeckV1, RULES, own } = core;
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

  section('the transport gate (cleanDeckV1) turns hostile decks away');
  guard(() => {
    const throws = (d, why) => { try { cleanDeckV1(d); ok(false, why); } catch (e) { ok(true, `${why} (${e.message})`); } };
    throws(null, 'not a deck');
    throws({ cards: [] }, 'no cards');
    throws({ cards: 'x' }, 'cards not a list');
    throws({ cards: Array(5001).fill({ r: 'A', s: '♠' }) }, 'over 5000 cards');
    throws({ cards: [{ img: 'data:image/png;base64,' + 'A'.repeat(25e6) }] }, 'over 24 MB of images');
    const d = cleanDeckV1({
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
    ok(Object.getPrototypeOf(cleanDeckV1({ cards: [JSON.parse('{"__proto__": {"x": 1}, "meta": {"__proto__": {"y": 1}}}')] }).cards[0]) === Object.prototype, 'a "__proto__" key pollutes nothing');
  });

  section('the catalog gate (cleanDeck, v2) holds asset ids only');
  guard(() => {
    const H = 'a'.repeat(64), d = cleanDeck({
      name: 'V2', back: 'url(javascript:x)', backImg: 'b'.repeat(63), imgs: [H, 'javascript:x', H.toUpperCase()],
      cards: [{ g: 0, n: 'one' }, { g: 1 }, { g: 2 }, { g: 9 }],
    });
    ok(d.imgs[0] === H && d.imgs[1] === null && d.imgs[2] === null && d.back === null && !('backImg' in d), 'only hex SHA-256 ids survive as images (a bad back and backImg go)');
    ok(d.cards[0].g === 0 && d.cards.slice(1).every((c) => !('g' in c)), 'a card keeps its g only when it names a usable image');
    ok(cleanDeck({ cards: [{ n: 'x' }], backImg: H }).backImg === H, 'an asset id back is kept');
    for (const [what, deck] of [['imgs', { imgs: ['data:image/png;base64,AAAA'], cards: [{ g: 0 }] }], ['a card', { cards: [{ img: 'data:image/png;base64,AAAA' }] }], ['the back', { back: 'data:image/png;base64,AAAA', cards: [{ n: 'x' }] }]]) {
      let err = '';
      try { cleanDeck(deck); } catch (e) { err = e.message; }
      ok(/must be ingested first/.test(err), `a data URL in ${what} is refused, not dropped quietly (${err})`);
    }
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
    const junk = [undefined, null, -1, 0, 1, 7, 1e9, NaN, Infinity, 1.5, 'x', '', '__proto__', 'constructor', {}, [], true, { toString: 1 }, [{ toString: 1 }]];
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
            ids: rnd() < 0.2 ? [any(), any(), pick(junk)] : pick(junk),
          };
          if (a.t === 'rulesBtn') a.id = pick([...(T.state.rules?.public?.buttons || []).map((b) => b.id), ...junk]);
          try { T.apply(p, a); T.refreshFor(p, a); } catch (e) { const k = `${a.t}: ${e.message}`; crashes[k] = (crashes[k] || 0) + 1; }
          T.drain();
        }
        const items = Object.values(T.state.items);
        ok(items.every((it) => Number.isFinite(it.x) && Number.isFinite(it.y) && Number.isFinite(it.rot) && (it.k === 'c' || Array.isArray(it.cards))),
          `${tpl || 'free table'}: after 1500 hostile actions every item still has a finite place (${items.length} items)`);
      }
    } finally { [console.warn, console.error] = quiet; }
    ok(!Object.keys(crashes).length, `no action threw out of T.apply or T.refreshFor (a flood refusal), not even with {toString} ids (${JSON.stringify(crashes)})`);
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

  h.report();
})().catch(h.crash);
