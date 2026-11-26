# Scriptable Rules Engine — Design

Design notes for letting the **host write code** that turns the rules-free
simulator into an enforced, automated game — turn order, legal-move checks,
auto-dealing, a scripted poker dealer, or any tabletop game the host can
express in JavaScript. Written before implementation as the record of the
approach (companion to [`../mdmath/COLLAB-DESIGN.md`](../mdmath/COLLAB-DESIGN.md),
which documents the networking design space this app builds on).

**Why this is cheap here:** the host is already the single authority, and
every player action already flows through one function — `apply(p, a)`
(in `app.js` when this was written, now in the state core `core.js`). A
rules engine is a plugin at exactly that choke point.
**Why this is safe:** scripts run on the host only (in a Web Worker beside
the host's page: "Running in a Worker" below). Guests receive data
(state, decks, log) and never code, so there is no remote-code-execution
surface for guests; the host executing code they themselves typed is the
same trust tier as opening devtools.

## Guiding principle: the engine is game-agnostic

The engine defines *no* game concepts — no turns, rounds, suits, or bets.
It provides exactly three things:

1. **hooks** into the action pipeline,
2. the **complete set of table primitives** as a callable API,
3. **persistent scratch state** plus UI affordances (buttons, indicators,
   messages).

*All* game semantics live in the host-supplied script. Poker and turn-order
ship only as example scripts demonstrating the engine — deleting them
removes nothing from the engine. Adding a new game never touches the
engine, only a new script.

## 1. Script model (host-only execution)

A rules script is a JS object literal the host writes in a dialog:

```js
({
  name: 'Turn order + auto-deal',
  setup(t) {            // runs each time the host enables the rules
    t.data.turn ??= t.players()[0].id;
    const deck = t.find({ kind: 'pile' })[0];
    if (deck) t.dealToAll(deck.id, 2);
  },
  handle(t, a) {        // take the action over: before validate
    // undefined → go on (validate, then the default effect); 'reason' → veto;
    // true → handled: the script did what the action means (t.* ops), no default effect
  },
  strict: true,         // a ruled action handle() doesn't return true for is refused…
  allow: ['rot'],       // …unless it is listed here (seat never is refused)
  validate(t, a) {      // veto: return a string to block the action
    if (['play', 'draw', 'deal'].includes(a.t) && a.p !== t.data.turn)
      return "It's not your turn";
  },
  onAction(t, a) {      // automation: react after an action took effect
    if (a.t === 'play') t.data.turn = t.nextSeat(t.data.turn);
  },
  buttons: (t) => [{ id: 'flop', label: 'Deal flop' }],
  onButton(t, id, byPid) {},   // scripted UI buttons
  onChat(t, text, byPid) {},   // chat commands: bids, raises, votes, ...
  onJoin(t, pid) {},           // player joins/rejoins mid-game (see below)
  onLeave(t, pid) {},          // player disconnects
  onTimer(t, tag) {},          // fired by t.schedule(seconds, tag)
  onAnswer(t, pid, id, value) {}, // a player answered t.ask
  onSelect(t, pid, id) {},     // a player picked up or selected an item: t.hint
})
```

(It runs as it stands: paste it in 📜 and Enable. The **Blank** template,
the 📜 dialog's default, is the same skeleton with every hook commented;
**Chess** is a full-rules script that uses `handle`, `strict`, `t.ask` and
`t.hint`.)

Every hook is optional; a script implements only what its game needs. The
hook set — action veto, action react, UI events, join/leave, timers — is
sufficient to express arbitrary turn-based tabletop games.

Hook semantics worth knowing:

- **`setup` runs on every Enable.** Re-enabling a script with the same
  `name` (after fixing a bug, a Disable, or a script error) **keeps
  `t.data` and `t.public`** — chips, scores, pending timers — unless the
  host ticks *Reset game state* in the dialog; the log says which
  happened. So write `setup` idempotently (`t.data.stacks ||= {}`), and
  give a script a new `name` when its state shape changes.
- **`onAction` only sees actions that took effect.** A no-op — playing a
  card that isn't in the hand, drawing from a pile that is gone — never
  reaches it, so the ids in `a` (`a.d`/`a.i` of a `play`, …) have been
  matched against the host's state. It also runs after an action `handle`
  took over (with `a.handled === true`: one place for "after every move"
  bookkeeping — check `a.handled` to skip those), and after `chat`,
  accepted `rulesBtn` presses and accepted `answer`s — a press the engine
  refuses, of a button not offered to that player, reaches no hook at all.
- **`a` is frozen**: hooks get a deep, frozen copy of the action (with
  `p`, and the host's `to`, `from`, `pick`, `handled`), so a script can
  never change the action the engine goes on to apply.
- **`handle`, `validate` fail closed**: if either throws, the action is
  blocked and the rules disable themselves (an input that crashes the
  validator must not slip through unvalidated). Hooks are synchronous:
  one that returns a Promise or any thenable (an `async` hook) counts as
  throwing, since its veto would come too late — so an `async validate`
  blocks the action instead of letting it pass.
- **Hooks are atomic** (Phase 3). A veto takes back everything its hook
  did first (`handle` moved a piece, then returned a reason: the piece
  never moved). A hook that throws leaves none of its own ops behind: when
  `handle` or `validate` throws, nothing of the action applies; when a
  later hook throws (`onAction`, `onChat`, `onButton`, `onAnswer`,
  `onSelect`, `onJoin`, `onLeave`, `onTimer`, `setup`, `buttons`), the
  action's own effect stays (the move, the chat line, the timer taken off
  the list) and everything after it is undone (`public.buttons` keeps its
  last value). The engine journals each action: every item, player, deck
  and box it touches, and `t.data`, `t.public`, the asks, `t.secret` and
  the hints, so it can put them back.
- **State on the script object is not journaled**: `this.x = …` survives
  a rollback, and is lost on a host reload. Keep game state in `t.data`.
- **The facade is live only while a hook runs** (Phase 3). A call from
  anywhere else — the continuation of an `async` hook, a promise callback —
  throws "t.say was called outside a hook — rules hooks must be
  synchronous", and the rules disable ("Running in a Worker" below).
- **`onJoin` also fires on reconnect after a host reload**, without a
  preceding `onLeave`: a resumed host marks everyone offline, and each
  player's first message after the resume is a (re)join. A script that
  tracks who is "in" should treat `onJoin` of a player it already knows
  as a reconnect, not a newcomer.

Evaluated with `new Function('"use strict"; return (\n' + code + '\n);')()`
(so a trailing `// comment` is fine) wrapped in try/catch. Scripts run in
**strict mode**: assigning an undeclared variable throws (and disables the
rules). A script that fails
to evaluate on Enable changes nothing — the running rules keep running
and the error shows in the dialog. Any hook that throws: `console.error`
+ toast + log line + **auto-disable the rules** (fail loudly, never wedge
the game).

### Running in a Worker

A rules script never runs on the host's page. Enabling one starts a Web
Worker (`rules-worker.js`) holding a copy of the whole table — every hand
and hidden card, but no seat keys — that evaluates the script and, from
then on, runs every action on its copy: each player's, the host's own and
the timers', one at a time, in the order they arrived. What an action
changed goes back to the host's page, which takes it as it is and syncs
the players. While the rules are on, nothing else changes the table; while
they are off, no Worker exists.

- **Enable is asynchronous.** The 📜 dialog's button says "Starting…"
  until the Worker is up and `setup` has run (a few milliseconds, a few
  hundred on a big table); actions that arrive meanwhile wait their turn.
  A script that doesn't evaluate changes nothing: the running rules keep
  running, and the dialog shows why.
- **Hooks are atomic** (§1): a veto, or a hook that throws, leaves none of
  its own ops behind.
- **The watchdog.** Each action has 4 seconds of the host page's
  **visible** time (more for a box setup that lays out many items): a
  phone that hides or freezes the host's tab stops that clock, so a
  backgrounded host never loses healthy rules. A script that doesn't
  answer in time — an infinite loop — is stopped: its Worker ends, the
  rules disable ("rules disabled — the script took longer than 4 s
  (stopped)", the dialog's error line, a toast), the action is dropped
  (its player gets "🚫 The rules stopped responding — your action was not
  applied"), and the table goes on without rules. The host's page never
  freezes: the loop runs in the Worker. A Worker that crashes is handled
  the same way: the log says "rules disabled — the script crashed" for
  everyone, and the host's toast and dialog add the error's message (one
  line, never a stack). A player's arrival, departure or rename that was
  in flight is kept — it runs again with the rules off — so a stuck
  `onLeave` never leaves a ghost at the table. Enabling again starts a
  fresh Worker from the table as it now is (and evaluates the script once:
  its top level has the start's 10 seconds, not an action's 4).
- **No async code.** Hooks must be synchronous, and three guards make that
  a rule rather than advice:
  1. a hook that returns a Promise or any thenable (an `async` hook) counts
     as throwing, so `handle` and `validate` fail closed;
  2. `t` works only while one of the script's hooks runs: a call from a
     promise callback throws "t.say was called outside a hook — rules hooks
     must be synchronous", and the rules disable;
  3. once an action's hooks are done, the Worker lets every pending
     promise callback run, then checks that `t.data`, `t.public`, the asks
     and `t.secret` are exactly as the action left them — their JSON, and
     every value in them, so a function slipped into `t.data` or
     `t.secret`, or a `Date` written over its own text, is seen too: a
     callback that wrote one disables the rules ("the script changed t.data
     outside a hook", "the script changed t.secret outside a hook") before
     the next action, which is not blamed for it, and nothing it wrote
     reaches the table. Everyone's log says only those words; which value,
     under which of the script's keys, is for the host's toast and 📜
     dialog alone (a key of `t.data` may name a hidden card).

  `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`,
  `queueMicrotask`, `requestAnimationFrame` and `scheduler.postTask` throw
  ("setTimeout is not available to rules scripts — use t.schedule(seconds,
  tag)"): `t.schedule` and `onTimer` are the script's clock (and survive a
  host reload).
- **What a script can reach.** Before it evaluates the script, the Worker
  keeps only what is on a short list: the language's own built-ins
  (`Object`, `Array`, `Math`, `JSON`, `Date`, `Intl`, `Map`, the typed
  arrays, `WebAssembly`…), and of the platform `console`, `crypto`,
  `structuredClone`, `performance`, `TextEncoder` / `TextDecoder`, `URL`,
  `atob` / `btoa`, the event classes, `self` / `window` / `globalThis`,
  `location`, and a `navigator` of five plain values (`userAgent`,
  `language`, `languages`, `hardwareConcurrency`, `onLine`). Every other
  name goes, whatever the browser — the network (`fetch`, `WebSocket`,
  `FontFace`…), storage (`indexedDB`, `caches`, the origin's private file
  system, Web Locks — and the service workers of every app on the site,
  which Safari and Firefox expose in a Worker), other Workers and
  channels, notifications, devices (`navigator.usb`, `hid`, `serial`…),
  its own `postMessage`, and whatever a browser adds next; `close` throws
  (it would end the Worker silently). Calling one fails ("fetch is not
  defined"). The Worker reads only the host's own messages — one a script
  makes and dispatches to its Worker ends the rules.
- **The built-ins are frozen, and so is the engine.** The engine runs in
  the Worker next to the script, on the same built-ins, and a script can
  `import()` the engine's own files and get the very modules the Worker
  runs. So before the script is evaluated, the Worker freezes every
  built-in all the way down (the prototypes, the iterators `for…of` uses,
  `JSON`, `Object.entries`) and every export of `core.js`, `grid.js` and
  `templates.js`, and fixes the global names that hold the built-ins:
  `Array.prototype.push = …`, `Object.defineProperty(Object.prototype, …)`
  or a change to an imported `core.js` export throws a `TypeError`. That
  is what keeps a script from rewriting what the engine writes.
  `RegExp.prototype.compile` is gone too: it rewrites a regex in place,
  a frozen one's pattern included, so an imported `PID_RE` or `CTRL` could
  have been re-pointed. A script's own objects still take what
  scripts commonly give them: `obj.toString = …`, `this.name = 'MyError'`
  in an error class, a function's own `call`, any key on a plain object
  (`tally[word] = 1`, even for the word `__lookupGetter__`). And the host
  checks every action's changes again on its own page, where the script
  can't reach: every field as the engine writes it (items, players, the
  rules' state through the engine's gates, log lines, effects, the
  counters, a catalog that only grows), and against who acted — a player
  appears only by joining, a name changes only by its player's rename, a
  colour never, the rules' code only in the host's Enable; each log line
  and name bulb speaks for the action's player or the rules, a chat line
  only that player's own words, in their own chat; a player's added deck
  only as the host itself cleans what they sent, said once in their name
  ("added deck …") — a script that handles someone's `addDeck` by adding
  a deck of its own instead is refused too. A
  change that fails is refused whole and ends the rules ("rules disabled —
  the host could not apply the script's changes"): a script can't sign
  Bob's name to someone else's action, nor put words in anyone's chat.
  (What the acting player's other lines say — "moved the King to e4" — the
  host takes from the Worker; that a script can't reword them rests on the
  freeze.) That is defence in depth, not a sandbox — a script sees every
  hidden card and can tell it in game (`t.tell`), so enabling one is an
  act of trust, and dynamic `import()` can't be taken away (README, honest
  limits). `console.log`
  goes to the Worker's console in devtools; `window` is the Worker's
  global scope, with the page globals a template needs copied in — today
  `window.CAH_CARDS`, the CAH card texts (`WORKER_GLOBALS` in `app.js`).
- **State on `this` is not journaled**: `this.x = …` survives a rollback,
  and is lost on a host reload or a new Worker (every Enable starts one).
  Keep game state in `t.data`, which is journaled and saved. `t.data`,
  `t.public` and `t.secret` must stay plain JSON — objects, arrays,
  strings, finite numbers, `true`, `false`, `null`: a rollback or a save
  would hand back something else. A hook that leaves a typed array, a
  `Map`, a `Set`, a `Date`, `NaN`, an object of a class, an array with a
  hole (`new Array(64)`: fill it) or `undefined` in it, or a property
  JSON doesn't see (non-enumerable, symbol-keyed) in one fails
  ("onAction(): t.data.board[0] is a hole, not JSON …") — every action, even one whose JSON is unchanged
  (a `Date` over its own text) — as does a function in `t.secret`, or one
  in `t.data` or `t.public` that leaves their JSON as it was; a function
  written there with other changes disables the rules when its action is
  sent to the host, keeping their JSON part. A property hung on an array
  (`moves.turn = …`) isn't looked for — finding it would cost every action
  a list of every index — and JSON drops it on a save or a rollback: keep
  it in an object beside the array.
- **A host reload** starts a new Worker over the saved table: the rules go
  on where they were — `t.data`, `t.public`, the asks, `t.secret` and the
  pending timers are saved — without running `setup` again. A saved script
  that no longer loads disables the rules loudly ("Saved rules failed to
  load: …"). One that can't start for a reason that isn't the script's —
  a page of another version of Card Table than the files it loads
  ("Card Table was updated — reload this page to run rules"), a Worker
  that didn't load — is off on that page but stays on in the save, so the
  reload the toast asks for runs it again (until the host enables or
  disables rules).
- **Live drags are not validated** — only the drop is. While a guest drags
  a piece, the others see it glide, and nothing changes until the drop:
  the `move` the rules see.

**Migrating a script written for the page.** In the earlier Card Table a
script ran on the host's page, so it could touch it; in the Worker, any use of
`document`, `alert`, `localStorage` or `sessionStorage` throws "document
is not available: rules now run in a Worker, away from the page (see
ENGINE.md, 'Running in a Worker')", `setTimeout` throws as above, and the
rules disable with that
message in the 📜 dialog. Use `t.say` / `t.tell` (or `t.announce`) instead
of `alert`, `t.data` instead of `localStorage`, and `t.schedule(seconds,
tag)` with `onTimer` instead of `setTimeout`. A hook that threw halfway
used to leave its first ops on the table; now it leaves none. A script
can't add helpers to the built-ins or change their settings any more
(`Array.prototype.shuffle = …`, `Error.stackTraceLimit = 50` throw): use
functions of its own (`const shuffle = (list) => …`).

## 2. The `t` facade (script API)

A thin wrapper over the table's existing ops (today in `core.js`):

- **Reads**: `t.players()` (id/name/seat/online/handCount, seat-ordered;
  `host: true` marks the host's own seat, for host-only commands; `seatId`
  for a player in a named seat). **Watchers are left out** — the players
  who stood up, or found no free named seat — so a script that deals to
  `t.players()` never deals one in; `t.players({all: true})` includes them,
  with `seat: null`, last. Then `t.item(id)`, `t.find(q)`, `t.piles()`,
  `t.items()`, `t.hand(pid)` (the host already holds all hands, pile
  orders, face-down identities, hidden pieces and bag contents — guests
  never receive those, see README "Honest limits").
  - `t.item(id)` → `{id, ...item}` (a pile with its `cards`, a bag with its
    `of` and its `box`: the box whose setup made it, which decides who may
    lock it — public, like the box itself, while `of` never leaves the
    host), or `null`: one lookup, whatever the table's size.
  - `t.find({kind, name, up, type, owner})` → the matching items. `kind`:
    `'card'`, `'pile'`, `'piece'`, `'supply'`, `'bag'`, or a piece kind
    (`'token'`, `'tile'`, `'die'`, `'board'`: pieces of that kind); `name`:
    a pile's or a bag's name (exact, any case); `up`: the face a card
    shows (a pile: its top; a piece or supply: not hidden); `type`: a
    `'box/type'` ref, or a bare type id matched in any box; `owner`: a
    player id (it also matches items owned by that player's named seat,
    `'seat:<id>'`) or a `'seat:<id>'`. Any other key, or another kind,
    throws a `TypeError` naming the known ones. It starts from an index:
    the items of a `'box/type'` ref, else those of the owner, else those of
    the kinds asked for.
  - `t.type(ref)` → a piece type, copied: `{kind, name, w, h, shape, faces,
    back?, rotStep, hand, stack, meta, box}` (`box`: its box's name), or
    `null`. `ref` is a `'box/type'` string or an item's `{t}`. A type's
    (and a box's) `meta` is **public**: every player's page holds the
    boxes, so it is never a place for secrets — keep those in `t.data`.
  - `t.piles()` → every pile (the same index).
  - `t.items()` → every item: it copies the whole table, O(n) — on a
    1,000-card table, prefer `t.item` and `t.find`, especially in hooks that
    run on every action (`validate`, `onAction`, `buttons`).

  Every read returns copies: plain, mutable and detached — changing one never
  changes the table, and one kept across hooks never changes under the script.
- **Scratch state**: `t.data` — a plain object persisted inside
  `host.rules.data` (survives host reload via the existing `persist()`
  path), so turn pointers, phases, and pending timers live there. It must
  stay JSON and under 4,000,000 characters as JSON: after each action (or
  join, leave or timer) whose hooks left it larger, the rules disable loudly,
  naming those hooks (`t.data is too large (N chars, max 4,000,000)`). A
  value the save can't copy in `t.data` or `t.public` (a function, a DOM
  node) disables the rules too, and both keep only their JSON part.
- **Ops — the complete primitive set**, mirroring everything `apply()` can
  do (the switch bodies get refactored into named helpers — `opDeal`,
  `opShuffle`, … — used by both the switch and this API):
  `t.deal(pileId, {to: pid} | {x,y,up,rot})` (returns the dealt card:
  `{id, d, i}` on the table, `{d, i}` into a hand, `false` from an empty
  pile), `t.dealToAll(pileId, n, {onlineOnly})` (skips offline players
  unless `onlineOnly: false`), `t.draw(pid, pileId, n)`,
  `t.playFromHand(pid, idx, {x, y, rot, up})` (lands **face up** unless
  `up: false`, unlike a human play; returns the new card id, `false` for
  an index that isn't a card in the hand), `t.takeHand(pid, pileId, only)`
  (a hand onto a pile, face down — all of it, or the entries the optional
  `only({d, i} | {t, f, up?})` picks, e.g. `(c) => c.d === myDeck` to
  leave another game's cards; an entry that doesn't go onto that pile —
  a piece onto a card deck, a card onto a pile of pieces, another size —
  stays in the hand, with a `console.warn`; an empty pile takes cards
  when any are picked, so a fresh "Set aside" pile never becomes a pile
  of pieces), `t.toHand(pid, cardId)`,
  `t.shuffle`, `t.flip`, `t.move`, `t.rot`, `t.toPile`,
  `t.stack(cardId, ontoCardId)` (→ the new pile id), `t.merge`,
  `t.newPile(cards, {x,y,name})` (→ the new pile id), `t.remove`,
  `t.addStandardDeck({jokers, x, y})` (→ the new pile id), and
  `t.newDeck({name, cards, back})` — registering a script-defined deck of
  image-less cards (`{name, text, color, bg, meta}` each; `back` may be a
  solid color like `"#111"`, and nothing else: anything else throws a
  `TypeError`, since a script deck has no images) without creating a pile, so a script can hold
  a huge deck and only materialize small piles from it via
  `t.newPile([{d, i, up}])`, keeping the broadcast state light — so a
  script can set up its own material from scratch.
  - **Pieces** (Phase 2: game boxes bring tokens, tiles, dice, boards,
    supplies and bags). The same ops work on them, with the semantics of
    the human actions and without the owner and lock checks — scripts own
    the rules: `t.move` (a board keeps
    its place below everything else), `t.rot` (in steps of the type's
    `rotStep`), `t.flip` (a type with a back turns face down or up, two
    faces swap, more faces turn to the next; a die returns `false` with a
    `console.warn`: dice are rolled), `t.remove`, `t.toHand(pid, id)` (one
    piece of a ×N stack, of a type that may be held), `t.playFromHand` (a
    piece entry `{t, f}` lands as a piece), `t.deal` (from a pile of
    pieces: a piece, `{id, t, f}`), and `t.newPile([{t, f, up}])` (pieces
    that stack as a pile, of one size; a mix, or an unknown type or face,
    throws a `TypeError`). `t.roll(id)` rolls a die with the host's crypto
    RNG and returns its new face index (`false`: not a die, or gone); it
    logs "📜 Rules rolled 5", or "rolled a hidden die" for one face down.
    `t.random()` → a float in `[0, 1)` from the same RNG; an action's draws
    are logged once ("used randomness (3 draws)"). Every op that adds items
    stops at the table's 5,000 (it returns `false` with a `console.warn`;
    `t.addStandardDeck` then mints no deck either), every op that adds to
    a hand at 1,000 entries, every op that adds to a pile at 5,000 members
    (a supply never runs out: without these, pieces taken from one would
    grow a hand or a pile without end).

  Anything a human can do, a script can
  do — that is the operational definition of "can run arbitrary games".
  Ops performed by scripts act as a synthetic **"📜 Rules"** actor: they go
  through `logEvent`/`mark`, so automations are visible in the table log —
  the same anti-cheat property as human actions. (Name bulbs over the
  table are for human actors only: a single deal or judge does several
  ops, and a bulb per op would just pile up.)
- **Player interaction**: `t.say(msg)` (log line as Rules),
  `t.tell(pid, msg)` (targeted toast — a bridged tab also hands it to its
  terminal/bot as `note: …`; `pid` must be a player at the table, or it
  throws "t.tell: no player …"), `t.announce(msg)` (a big banner on
  every screen, also logged), `t.win(winners, msg)` (sets
  `public.winners`, rendered by the engine as 🏆 on the winners' seat
  labels — the generic way any game declares its outcome), scripted
  `buttons` (global, per-player, or host-only), and
  `t.schedule(seconds, tag)` → `onTimer` for turn clocks and reveal
  delays (timers persist in `t.data`; a non-numeric delay throws).
- **Asking players** (Phase 3): `t.ask(pid, spec)` puts a question to
  one player and returns nothing; their answer comes back through
  `onAnswer(t, pid, id, value)`. Forms (`spec`): `{id, prompt, options:
  ['♕', '♖', {label: 'Knight', value: 'N'}]}` (a plain label is its own
  value) — or `{id, prompt, pick, …}` with `pick: 'item'` and `among: [ids]`,
  `pick: 'space'` and `among: [addresses]`, `pick: 'hand'` and `count` (1
  by default: that many cards of their hand, which stay there), or `pick:
  'number'` with `min` and `max`. The value `onAnswer` gets: the chosen
  option's value, the item id, the address (display form), the hand cards
  as `[{d, i} | {t, f}]`, the number. The engine checks an answer the way
  it checks a button: only the asked player, only a pending id, only a
  value that was offered — anything else is refused ("🚫 That answer
  wasn't offered") and runs no hook. An ask with the same `id` replaces
  the pending one; at most 8 wait for a player (prompts ≤ 200 chars,
  labels ≤ 30, ≤ 20 options, ≤ 200 `among`, `count` ≤ 20, a number range ≤
  1,000,000). A malformed spec throws a `TypeError`. `t.cancelAsk(pid,
  id?)` withdraws one (or all of a player's) → whether there was any;
  `t.asks(pid)` → their pending asks, copied. Asks live in the engine's
  own `rules.asks`, not in `t.data`: they are saved (a host reload asks
  again), only the asked player sees them, and the log says only "Bob
  answered", never what.
- **Selections and hints** (Phase 3): a script with `onSelect(t, pid, id)`
  hears when a player picks up or selects an item (a `select` action:
  never one hidden from them, at most 5 a second each; it changes nothing
  by itself). Its usual answer is `t.hint(pid, {items, spaces})` —
  highlights for that player alone (≤ 500 items and addresses in all), or
  `t.hint(pid, null)` to clear them. A player's next gameplay action
  clears their hint (a vetoed one brings it back, so they can try again
  with the highlights still shown). Hints are never saved.
- **`t.secret`** (Phase 3): `t.secret[pid] = {text: 'Your target: Bob',
  …}` is script data for that player alone — a secret objective, their own
  score breakdown — the private counterpart of `t.public`; `delete
  t.secret[pid]` clears it. Each entry is JSON of at most 8,000 characters
  (their screen shows its `text`, at most 1,000; the terminal bridge gets
  it whole). Its keys must be player ids: a hook that writes another key
  (`t.secret['__proto__']`) or too much fails, and the rules disable. It
  is saved, and still sent while the rules are off (it is that player's,
  like a hand); asks and hints are sent only while they are on.
- **Convenience utils** (pure functions, no engine state):
  `t.hostId` (the host's own player id — for host-only buttons
  `{pid: t.hostId}` and host-only chat commands), `t.geom()` →
  `{shape, w, h, size, cx, cy, r}` (the table: round or rect, its width and
  height, `size` = `w`, its centre and `r` = min(w, h) / 2 − 110, the radius
  cards may lie within on a round table — for laying cards out on any
  table),
  `t.nextSeat(pid)` (the next seat clockwise whose player is **online** —
  offline players are skipped, `pid` itself counts even when offline; a
  fixed-partnership game that must wait for a dropped player rotates over
  `t.players()` itself), `t.cardName(ref)` (rank+suit, the card's name,
  or its quoted text), and
  `t.card(ref)` → `{name, rank, suit, text, meta, deck}` — `meta` being the
  free-form JSON a custom deck's `deck.json` manifest attached to the card,
  so scripts key game logic on `meta.cost`/`meta.type` instead of parsing
  names. Scripts own all actual game logic.

### Addresses and the spatial helpers (Phase 3)

A board's structure — its grid, spaces, zones and links — has meaning:
a **piece** (never a card, pile, supply, bag, board or die) placed on a
structured board **snaps** to the spot in reach of its centre on the
topmost board there (a grid cell; a go-style point within half a cell; a
hex; a space first — within its `r` of its centre, or anywhere inside its
`w × h` rectangle), centred on it, and records where (`at`). Every
placement snaps: a human move, take, pull, split, play or deal, a script's
`t.move`, `t.spawn`, `t.take`, `t.pull`, `t.playFromHand`, `t.deal`, and
setups. `{x, y, free: true}` skips it.

- **Addresses.** On a board, `'e4'` (chess labels), `'D4'` (go), `'3,4'`
  (`xy`), `'2,-1'` (hex axial), or a space's id (`'bar'`). Scripts see them
  in their **display form**: bare on the **primary board** (the oldest with
  `primary: true`, else the oldest with a grid, else with spaces; racks
  and mats with zones only never are), `'<typeId>:<local>'` on another
  (`'map:c3'`), `'<typeId>#<n>:<local>'` when several boards of that type id
  lie on the table (`n` counts them oldest first — it renumbers if an older
  one is removed). Every call that takes an address takes these forms, and
  a bare one names the primary board's spot, else the one other board's
  that has it; when several could be meant it throws `TypeError("t.move:
  address 'bar' is ambiguous — use 'tray#1:bar' or 'tray#2:bar'")`. An
  address no board has throws too. (Inside, an address is
  `'<board item id>:<local>'`; `t.item(id).at` is the display form.)
- **Moving a board moves nothing else.** After a board is moved, turned
  (quarter turns only), flipped or removed, or the table resized, every
  piece keeps its place, and the address of each piece on that board
  (where it was, or where it is) is read again, before anything reads one
  — the next action's `a.from`, a log line, `t.item(id).at` in the same
  hook: the spot under its centre, if one is in reach, else none. An
  address you gave (`t.move(id, 'map:c3')`, under a board lying on top)
  stands until a board under the piece changes. A table resize (or the
  host's resume) pulls stray items back onto the felt, but a piece that
  sits centred on its spot stays centred on it — on a board's edge spot
  too, past the playing area's margin; a new felt alone moves nothing.
- **Reads**: `t.where(id)` → the piece's address, or `null` (`false`: no
  such item); `t.at(addr)` → the pieces there, copied, bottom to top;
  `t.find({…, at, zone})` (`zone`: a zone id on any board, or
  `'<board>:<zone>'`); `t.zones(id)` → the zones a piece lies in;
  `t.spot(addr)` → its centre `{x, y}` on the table; `t.neighbors(addr,
  {diag})` → the 4 (or 8) squares or 6 hexes next to it, on the grid, or a
  space's links; `t.distance(a, b, {metric})` → steps on one board's grid
  (`'chebyshev'`, the default, or `'manhattan'`; hexes count steps) or
  `null` (across boards, or a space); `t.line(a, b)` → the spots strictly
  between, along a rank, a file, a diagonal or a hex line, or `null`;
  `t.linked(space)` → the spaces linked to it (links run both ways). They
  read indexes kept as pieces move: a script that checks every move of a
  400-piece game stays fast.
- **`t.move(id, addr)`** centres an item on a spot (`t.move(id, {x, y,
  free})` places its top-left, `t.move(id, x, y)` still works). A move
  logs its addresses: "moved White pawn e2 → e4". `t.move(id, addr,
  {unzoned: true})` sets a piece down as it is: no private zone where it
  lands hides it or changes who sees it (see *Private zones*).
- **What an action says** (`validate`, `onAction`): `a.to` is the address
  the piece it places will snap to — the moved piece, or the new piece of
  a `take`, `split`, `play`, `pull` or a `deal` from a pile of pieces (by
  its own size); `a.from` where a moved (or split) piece was; a `pull`'s
  `a.pick` is the bag member it draws (drawn before the hooks; a veto
  leaves the bag unchanged, and that member is what the bag's next pull
  takes: refusing pulls never draws again). Only the host sets these (and
  `a.handled`): whatever a client sends of them is dropped, on every
  action — but an `owner` action's own `to`, the new owner.

### Components from code

- `t.newBox({name, pieces, backs, decks})` registers a game box and
  returns its id, in the `game.json` format (README, "Game boxes", whose
  field reference lists every field): `pieces` a list of types with their `id` (and a board's `grid`,
  `spaces`, `zones`, `links` and `primary` on the piece itself), `backs` a
  list (`{id, color, label}`), `decks` text decks (`{name, back, cards:
  [{name, text, color, bg, meta, count}]}`, registered as ordinary decks:
  the box's `decks` maps their names to deck ids; at most 50). No images:
  a script's box is drawn from colours, labels and pips (any `img` throws).
  A type with `upright: true` draws its label (and text) upright on every
  player's screen, as the board's coordinates are, instead of as it lies on
  the table: a chess glyph for the player across the board too. A face's
  `name` (never drawn) is what the log calls a piece showing it when the
  face has no label: reversi's "Light disc".
  Ids are ids (`[A-Za-z0-9_-]`; never `__proto__`). The same box again — a
  reset re-running `setup` — is the box already there.
- `t.spawn('box/type', {at, f, n, owner, up, vis, rot, lock, as})` places a
  piece (`as: 'supply'`: a supply) at an address, `'center'` or `{x, y,
  free}` → its id (`false` at the 5,000-item cap); a board is locked unless
  `lock: false`. `t.newBag([{t, f, up, n}], {at, name, owner, hand})` → a
  bag. `t.take(supply, {at, to})` and `t.pull(bag, {at, to})` hand out a
  piece onto the table (next to it, or `at`) or into player `to`'s hand
  (`{hand: true, t, f}`). `t.setFace(id, f)` (a die too), `t.setCount(id, n)`
  (0 removes it), `t.lock(id, on)`, `t.setOwner(id, pid | 'seat:<id>' |
  null)`, `t.setSeats(defs | null)` and `t.setTable({shape, w, h, felt})`
  (setting the seats, or a new shape or size, starts every player's view
  afresh, as a new game: call them as the game starts). A malformed argument (an unknown type, a face out of range, a bad
  address) throws a `TypeError` naming the call; an item that is gone is
  `false`.
- **Their log lines aggregate**: in one action, four or more consecutive
  📜 Rules lines of the same kind — placed, removed, turned, counted,
  locked, unlocked, owner, used randomness — become one: "📜 Rules removed
  30 pieces: D4, E4, D5, …" (the first 8 addresses, or names; turns that
  all went between the same two faces say which: "turned 4 pieces from
  Light disc to Dark disc: d4, …").
- **One call, one line**: `t.remove(ids)` and `t.setFace(ids, f)` also take
  a list, and log it as one line from two items on, whatever the count —
  a go capture of two stones is "📜 Rules removed 2 pieces: A1, B1", a
  reversi move's flips one "turned … pieces" line. True when every item
  was there (the others are still done; one that is gone is `false` and a
  `console.warn`, as ever).
- **`t.data._timers`** is the engine's own key in `t.data`: what
  `t.schedule` keeps (at most 1,000 timers, tags of at most 100
  characters). Don't write it; a save holding a malformed one loses the bad
  entries loudly (`console.error`) when it loads.

### Game boxes (Phase 4)

A game box (README, "Game boxes") is a game's material and starting layout,
and often its rules too. A script reads the boxes on the table and lays one
out:

- `t.boxes()` → `[{id, name, src, builtin, types}]`: every box on the table,
  where it came from (`'host'`, `'upload'`: a guest's, `'script'`: a
  `t.newBox`), whether it is a built-in one (by its content), and its number
  of piece types.
- `t.box(id)` → the box as every player may see it, or `null`: its name,
  types, backs, decks (`{name: deckId}`), table, seats, `players` and
  `meta` (a box's own data, at most 8 KB, public), plus `src`, `by`,
  `builtin` and `hasRules`. Never its setup, rules or saved state.
- `t.layout(boxId, entries?)` lays out `entries` (or the box's own setup) in
  the setup grammar, as 📜 Rules, clearing nothing, and returns how many
  items it placed; one line, "placed N items of «X»". Everything is checked
  before the first item lands — a type, deck or seat it names, "#k" against
  the seated players, the room on the table — and a bad layout throws a
  `TypeError` ("t.layout: …"). An entry's `id` that an item on the table
  already holds is minted anew (`console.warn`). A script's own "Reset"
  button: `t.remove` what it laid out, then `t.layout`. The grammar is the
  README's: `{board, at}` names a board an entry before it places;
  `"off": [dx, dy]` beside an address sets a piece that far from the spot's
  centre and keeps it on the spot while it lies in reach (as a board moved
  under it leaves a piece); a `group` with `"shuffle": true` deals out the
  identities of its face-down pieces that share a back among their places —
  each item keeps its place, z, address and `id`, so an id names a place,
  never a piece; those pieces must agree on `rot`, `lock`, `n`, `owner` and
  on being a die (a die never snaps: its place would lose its address).

**A box's rules and trust.** A box may bring its rules (the script's text)
and its rules' saved state (`{data, public, asks, secret}`, written by an
export). They start only from the host's **Set up** with "Enable its rules",
and only after the trust dialog ("«X» comes with rules written by its
author … A rules script sees every hand and hidden piece and can reveal
them") — for every box but a built-in one, whoever added it, the host
included, and from the terminal too (its buttons wake half a second after
it shows, and its Cancel lies where the confirm's Set up was, so a double
click on Set up never enables the rules). A built-in box's rules — Hexfront's
turn script — start with its Set up from 📦's Built-in section, in the same
job (`loadBox {setup, clear, rules: true}`), with no dialog: built in by its
content, nothing a peer sends can make a box so. A box with rules and no layout
— one its rules lay out with `t.layout` — is set up by them alone: there
is no "Set up without rules" for it, and the engine refuses a `setup` or a
`reset` of it that wouldn't start them (its rules switched off, other rules
running): it would clear the table for nothing. A clearing Set up — or a Reset — first switches off any
other rules that run: the game they ran is cleared away with the table, as
🎲's games are (a strict game's rules, chess's say, would otherwise refuse
every move on the new layout). They start right after the setup
commits, as an Enable with a reset: on the box's saved state, every
`"@#k"` there read as the k-th seated player and every id the setup had to
change replaced by its new one (a script that stored a pile's id finds it);
an entry that fails the engine's gates (an ask of 500 options, a timer
whose `at` is no number, a secret keyed by no player) is dropped with
`console.error` and one toast to the host. They run as the box's rules
(`rules.box`), so **Reset** restarts them on that state; an Enable of any
other text does not. A `clear` (🎲's games start with one) ends the box set
up: no Reset is offered after it — while the box's own rules still run
(enabled: a Disable keeps `rules.box`, and then they lead nothing), an
export is that box's. A refusal the rules make (a veto, `strict`) reaches
the player as a notice the app knows for theirs: an upload refused so says
which rules refused it, and an engine's or a storage refusal never does. A box's setup and saved state never reach
a guest — only the host and the Worker read them.

### Private material (Phase 5)

A piece whose type has a back may lie face down for some players and face
up for others: its `vis` names who sees it — player ids, or `'seat:<id>'`,
which follows whoever sits there (at most 8). Everyone else gets its back,
and the host builds each viewer's full form in that viewer's own part of
every message, so nothing private ever reaches anyone it isn't for.

- `t.hide(id, refs = [])` lays piece `id` face down for `refs` alone (none:
  for nobody) → `true` (`false`: it is gone). A piece whose type has no
  back, or a board, throws a `TypeError`, as do refs that name no player at
  the table and no named seat. "📜 Rules hid {name}" (as it showed a
  moment ago); four or more in one action are one line, "hid 12 pieces: a1,
  b1, …".
- `t.reveal(id)` turns it face up for everyone: its `vis` goes, and so does
  an owner its hiding gave it ("revealed {name}"; `true` and no line when it
  was face up already).
- `t.setVis(id, refs | null)` changes who sees it, face down or not
  ("changed who sees a hidden piece").
- A piece lying hidden is always changed by `t.setVis` and `t.setFace`,
  even when its viewers or its face are already the ones asked: it gets
  the log line, the name bulb and the re-send all the same. Skipping it
  would tell every player which hidden pieces already showed that face, or
  were already seen by those refs (D301). A face-up piece already right is
  skipped, as before.
- `t.canSee(pid, id)` → whether `pid` sees what the item is: a piece by the
  rule above, a card or a pile's top by its side, a bag never.
- `t.spawn(type, {up: false, vis: refs, …})` places a piece hidden for
  `refs` from the start.
- **Reads see everything**, as ever: `t.item(id)`, `t.find(q)`, `t.at(a)`
  return a hidden piece whole — its `t` and `f`, `vis`, and the engine's
  marks `pv` (a private zone hides it) and `po` (its owner is the one its
  hiding gave it, which goes when it is revealed).

A player's own `hide` makes an unowned piece theirs until it is revealed —
a cup belongs to a person. A private piece (one with a `vis`) hidden from a
player is refused to them for whatever would show it to them or strip who
sees it — `flip`, `roll`, `face`, `toHand`, a claim, `stack` and `toPile`
(either side), `toBag`, a split onto a bag, and a move onto any rack or
screen that would take it in, its owner's own included — with one uniform
"🚫 That piece is hidden", unless they own it; anyone may `peek` at it, on the record ("peeked at a hidden piece"), and a
script's `validate` may veto that. Rolls of hidden dice log the shown
values alone ("rolled 4 dice (2 hidden): 3 · 5"; `t.roll` of one: "📜 Rules
rolled a hidden die"). A hidden piece under a back that a die of its box
wears never snaps to a spot, so where it lands never tells a die from a
token.

**A refusal about a player's own hidden piece is theirs alone.** When
`handle` or `validate` refuses an action that names a piece its player
sees while it lies hidden from others (their cupped die, their unit behind
its screen), the engine writes no "blocked …" line and re-sends nothing to
the others — the reason goes to that player alone, and their piece snaps
back on their screen alone. So a script may word a refusal by what the
piece is ("The Banner never moves"): nobody else hears it. A live drag of
such a piece is shown to nobody either; the others see where it lands.

**Private zones.** A board's zone with `private: 'reveal'` (a rack) or
`'keep'` (a screen) and an `owner` — `'board'` (the board item's owner) or
`'seat:<id>'` — hides every piece set down in it: face down for that owner
(`vis`), owned by them unless someone owns it already. Taken off a rack, a
piece is face up for everyone again; moved out from behind a screen, it
stays hidden until a flip or the script reveals it. This happens whenever a
piece is **placed** — by a player, a script (`t.move`, `t.spawn`,
`t.pull`, …) or a setup — and never because a board moved under it. A zone
never shows anyone a piece hidden from them:

- a **screen** never takes over a piece hidden for someone else: it keeps
  who sees it (a unit crossing into the other side's deployment rows stays
  its own side's);
- a **rack** takes such a piece for its owner — a tile handed from one rack
  to another — only when the one setting it down sees it or owns it; anyone
  else is refused, uniformly;
- a piece placed back in a zone (a unit revealed in combat that steps back
  into its owner's screen) is hidden again: move it with `{unzoned: true}`
  if your game keeps revealed pieces revealed — Veiled Ranks moves every
  unit so;
- a piece with no back can't go into one: a player's move is refused, a
  script's throws a `TypeError` (a bag's draw is never refused for what it
  draws: a piece with no back lands shown, as if unzoned).

In a setup, `"unzoned": true` on a piece entry lays it out as written — up,
`vis` and owner — whatever zone it lands in; an export writes it for a
piece its zone wouldn't give back as it is.

**Fog of war is the script's.** The engine hides what lies face down and
nothing else: positions, moves and ownership are public. A game that hides
where things are, or what a square holds, keeps that in `t.secret` (each
player's own) and shows each player what they should see. Dominoes and Veiled Ranks (§5, 9 and 10) show both kinds of zone: a
rack per seat whose board is owned by the seat (`"owner": "board"`), and
two screens on the main board owned by named seats.

## 3. Enforcement path (the one structural change)

In `apply(p, a)`, for a **ruled** action (every gameplay action: move,
flip, deal, play, take, roll, seat, …) while the rules are on (Phase 3,
spec §3f.4):

1. the player's hint is cleared;
2. `handle(t, a)` — a string vetoes, `true` handles it (no default
   effect; what the action names is re-sent, so a drop the script left
   alone snaps to where the script put the piece);
3. under `strict: true`, an action `handle` didn't take over is refused
   ("🚫 Not a move in this game") unless `allow` lists its type — `seat`
   never is;
4. `validate(t, a)` — a string vetoes;
5. the default effect (the op switch);
6. a checkpoint, then `onAction` (when the action took effect or was
   handled) and `buttons()`;
7. the engine's gates (`t.data` ≤ 4,000,000 chars, `t.secret`, the asks)
   — a hook that broke them is undone and the rules disable.

A veto is not an error: the actor gets a targeted `note` message → toast
on their screen (and, on a terminal-bridged tab, a `note: …` in the
bridge's `msgs`), and the log "📜 Rules blocked Bob: …". Any other action
— chat, a rules button, an answer, a selection, and the host's own jobs
(`_join` when a player arrives or comes back, `_leave`, `_tick` for due
timers, `_rulesOff`, `_name`: never accepted from a guest) — runs its
default effect, then the hooks it implies (`onChat`, `onButton`,
`onAnswer`, `onSelect`, `onJoin`, `onLeave`, `onTimer`, `setup`), then
`onAction` where §1 says, then `buttons()`. The veto re-sends the items the action
named (`id`, `pile`, `onto`, `bag`, the first few `ids`) and, for a hand action, the
actor's hand: the next patch carries their true state, and the actor's
optimistic drag reverts. An action that changes nothing (its target vanished
a moment earlier) re-sends them the same way, and so does an action that
flood control refused (those re-sends are themselves rate-limited). Exempt from validation: `hello`, `name`, `chat`,
`rulesBtn` (the engine itself refuses a button not offered to the
player), and the host-only `size` (= `table`), `setRules`, `loadBox`,
`clear` and `endSeats` (back to ordinary seating: every watcher sits)
actions. The piece actions (`roll`, `face`, `split`, `join`, `take`,
`pull`, `toBag`, `lock`, `owner`, `seat`) are validated like the card ones
(`split {id, n, onto}` names its target in `onto`: another ×N stack, the
stack's supply — the `n` go back — or a bag — they go in —, all at once);
one the engine itself refuses after `validate` (an item owned by someone
else, a locked one, a hidden one, a full table) tells the actor why and
runs no `onAction`. `peek` IS validated:
on a free table peeking stays a social (logged) action, but a game may
close its piles (CAH vetoes every peek, Hold'em the deck, muck and burns
mid-hand).

**A group** (Phase 4: the multi-selection's bar, the terminal's `group`)
is one action, `{t: 'group', op, ids, dx?, dy?, rot?, on?, bag?}` (`op`
one of move, rot, flip, roll, lock, del, toBag; at most 200 ids, each
once), run by the engine as one sub-action per member, bottom to top, each
exactly as if the player had sent it alone — `{t: op, id, …, group: N}`,
so a script tells a member by `a.group` (the group's size); a move carries
its `a.to` / `a.from` as any move does. Every member takes every check of
the single action (owner, lock, a hidden piece) and the whole pipeline
above from a **savepoint** of its own: `handle`, `strict`, `validate`,
the default effect, then its own `onAction` — so the next member's hooks
see this one's done, as two actions in a row would. Each member's gates
(t.data plain JSON, its size, the asks) are checked against the job's
start, as the patch is built from there: a function hidden while the
members took t.data away and back fails the job closed, as it would a
single action. A veto, or an engine
refusal, rolls back that member alone (`rollbackTo` its savepoint) — what
its `handle` and `validate` wrote too — and re-sends it; the others apply. A `handle` or `validate` that throws fails
the whole group closed (nothing of it stays, the rules switch off); an
`onAction` that throws keeps the members already done, undoes its own
writes, and skips the rest (the rules switch off). `buttons()` runs once,
at the end. A `roll` is one sub-action, `{t: 'roll', ids}`, of the dice
among the members the player can see. A move shifts every member by the
same `dx, dy` — cut, as the live drag's glide is, so that all of them stay
on the table — and each piece snaps on its own; a `rot` is a delta, each
member snapping it to its own turn step. The log has one line in the
player's name ("moved 8 items", "rolled 3 dice: 4 · 1 · 6": a hidden die's
value never shows; the faces as they were rolled, whatever an `onAction`
does with the dice after) and, when the rules vetoed members, one "blocked
Bob: {the first reason} (k of N)"; the player gets one notice, "k of N were
skipped: {the first reason}" (a refusal only when none applied; a group of
one says just what its single action would). There is
no `t.group` call: a script moves many pieces with the ops it has. A group
costs 1 + ⌊N/20⌋ of flood control's tokens — while the rules run, that
times ⌈t.data's size / 100 KB⌉, since each member passes over the rules'
state (its savepoint, its gates); past the burst of 40 it still goes from
a full bucket, and overdraws it, so its sender waits the rest out — and its watchdog
budget grows by 10 ms a member, plus 20 ms a member for each MB of
`t.data`; a stop names the limit the job had. A group drag (`drag {ids, dx, dy}`, the live glide) is
one token however many it carries, and never reaches the rules.

Flood control (host): a guest may send a burst of 40 actions, then 20 per
second; beyond that they are dropped and the sender is told to slow down
(once per 10 s). Private notes (`t.tell`, vetoes) to one guest are
limited the same way (10, then 5 per second), and chat/renames to 5 per
5 s. Decks that guests add share one budget per table (1.5M chars, saved
with the table), so nobody can fill the host's browser storage.

## 4. Transparency & UI

- `host.rules = { code, name, enabled, data, public, asks, secret, hints }`.
  Broadcast to everyone: `{ code, name, enabled, public }` (and, while
  enabled, `wants: ['select']` for a script with `onSelect`, `strict: true`
  for a strict one) — **not** `data`, which may hold hidden information
  (e.g. a planned deal). Each player's own asks, hint and `t.secret` entry
  travel in the body addressed to them alone, like their hand. Guests can
  **read the exact code being enforced** in a read-only view — the same
  everything-on-the-record philosophy as the table log.
- `public` is script-controlled JSON for UI: `{ turn: pid }` (or a list
  of pids, when the game waits on several players at once — CAH's
  answerers) highlights those players' **seat labels** (⏳ + glow) on every
  screen and alerts each of them (tab title "⏳ Your turn", pulsing own
  seat, amber hand bar, a short "Your turn" chip, a vibration on phones
  once they have tapped the page) whenever the turn becomes theirs. Set
  it to whoever must act now — Bridge names the declarer while the
  dummy's card is due; `winners` renders 🏆, and on every `t.win()` call
  (counted in `public.winSeq`) and whenever `winners` gains a name
  everyone gets an emoji confetti burst and the winners' phones buzz (not
  on joining or reloading into a finished game); `badges` ({pid: text}) appends per-player text to seat
  labels (chip stacks, scores, tricks won — any game's counters);
  `buttons` renders a scripted-button row (visibility per button), and
  clicks route back to `onButton` via a `rulesBtn` action;
  `facedown` (`true`, or a list of pids) forces those players' hand-play
  face-down mode on — their 🂠 toggle shows locked (🔒, tooltip "the rules
  require…") — for secret plays such as CAH submissions; unset, the
  toggle is the player's own. It is a client-side hint: `validate` still
  has to reject a face-up play.
- **What a player sees of their own asks, hint and secret** (Phase 3):
  - **Asks** show in a panel of their own between the table and the hand
    bar (a centred card on a wide screen): it takes its room from the
    table, which refits above it, so it never covers a piece, a seat
    label, the turn cue or the watchers. The first pending ask shows ("1
    of N" when more wait); ▾ folds it to a "❓ Rules ask" chip until that
    player opens it again or another question comes first — there is no
    close button: an ask goes when it is answered or the script cancels
    it, and a host reload brings it back. `options` are buttons (one-glyph
    labels such as ♕ ♖ ♗ ♘ drawn large); `pick: 'item'` outlines the
    offered items in violet and a tap on one answers (a tap elsewhere says
    "Pick one of the highlighted pieces"); `pick: 'space'` marks the
    offered spots in violet and a tap answers with the offered spot under
    it, or the nearest within reach; `pick: 'hand'` turns the hand's cards
    into toggles and "Confirm (k/n)" works at exactly `count`; `pick:
    'number'` is a stepper and a field with OK, which work only for a
    number in range. The page sends only what was offered; the engine
    checks again. The prompt and the labels are shown as text.
  - **Hints**: while the rules want selections (`onSelect`), a tap on an
    item — or the start of a drag — sends `select` (never for a piece
    hidden from that player). Hinted items get a dashed cyan outline;
    hinted cells and spaces a translucent cyan disc on their board, or a
    ring round a piece standing there — on that player's screen alone.
    Strict rules that want selections show no action bar on a tap: their
    game moves by drags, asks and buttons, and the bar would offer what
    they refuse, over the very squares the hint marks.
  - **`t.secret`**: its `text` shows on a "🔒 For you" card above the
    rules' buttons (a tap on its head folds it), as text, line breaks kept.
    Where the room above the buttons is short (a phone held sideways with
    an ask open), the card gives way first, its text scrolling, down to its
    head, which always shows inside its frame; then the buttons scroll.
  - The 📜 button's tooltip says "strict" while the rules are; the
    terminal bridge has `asks`, `answer <id> <value>` and `select <id>`,
    and prints each new ask, hint and secret as it arrives (README,
    "Terminal bridge").
- Host UI: a "📜 Rules" toolbar button → dialog with a monospace
  `<textarea>` editor (the game's name is the script's `name`), an
  examples dropdown, Enable / Disable, a *Reset game state* checkbox and a
  live error line (an Enable says "Starting…" until the Worker has
  started the script and run its setup; the dialog then closes, or stays
  open with the error — and a failure while it is open shows at once).
  Guests: the same dialog, read-only. "🎲 Games" (host only, and
  as a strip on a brand-new table) enables a shipped template in one click
  through the same `setRules` action — its catalog (emoji, title, pitch,
  player count) is `GAMES`, next to `RULES_TEMPLATES` — or disables the
  rules ("Free table"), or opens the 📜 dialog ("Custom script…").
  Switching away from a running game asks first: its state is discarded.
- The log announces lifecycle: "«Hold'em (chips)» enabled by Alice"
  (+ "(game state kept)" / "(game state reset)" on a re-enable, or
  "(«Bridge» game state discarded)" when another game's state is dropped), "rules
  disabled — script error in onAction()", "Rules blocked Bob: not your
  turn".

## 5. Example scripts (dialog dropdown — demos, not engine features)

Plain scripts using only the public `t` API; each doubles as documentation
for script authors. A "blank" template with the commented hook skeleton is
the default.

1. **Turn order** — locks play/deal/draw to the current turn, advances on
   `play`, shows ⏳ on the active seat, and never leaves the turn with an
   offline player (skipped at setup, passed on when they leave, or — after
   a host reload, which fires no `onLeave` — once a `t.schedule`d grace
   period after anyone rejoins runs out). A
   composable base for any game.
2. **No-limit Hold'em with chips** — stacks tracked per player and shown
   on seat labels (via the generic `public.badges`), automatic blinds with
   a rotating dealer button, turn-enforced betting rounds (buttons for the
   actor: Check/Call, Fold and quick bets — Min raise, ½ pot, Pot, All-in,
   each labelled with the total it raises to, illegal sizes left out;
   `!bet N` / `!raise N` / `!allin` in chat, with min-raise validation and
   no re-raise after a short all-in), streets that deal themselves when a
   round closes, automatic all-in run-outs, and a showdown that returns an
   uncalled bet, evaluates each contender's best 5 of 7 (all standard
   rankings, wheel included), builds main + side pots from the
   contribution ledger, and pays each pot to the best eligible hand — ties
   split, odd chips to the first winners left of the button. Only online
   players are dealt in; a player who still had to act and drops is folded
   if they are not back within 20 s (`onLeave` + `t.schedule`; told why on
   return). Between hands anyone deals, a busted player gets a *Rebuy*
   button (or `!rebuy`) and the host sets `!blinds a b`; mid-hand the host
   gets *Abandon hand* (every bet refunded; last in the row, pressed twice),
   and the deck, muck, board and burn cards are locked (no peeking either).
   New hand gathers only its own deck, face down; another deck's cards in
   a hand go onto a *Set aside* pile. Proves a complete money game runs as
   pure script.
3. **Cards Against Humanity** — the printed rules end to end: 10-card
   hands, a rotating Card Czar (👑, always an online player; ⏳ marks the
   answerers while they answer, then the Czar while judging), black
   prompts flipped from a draw pile, face-down submissions into an
   *Answers* pile (`public.facedown` locks the answerers' 🂠 toggle on;
   validated: the Czar can't answer, answers must be white cards, face
   down, at most PICK of them), an anonymous reveal — the answers are
   re-dealt as new items from a temporary pile, in shuffled numbered
   columns upright for the Czar — Czar-only 👉 buttons naming each
   answer, a result that stays up (🏆 on the winning column) until a
   `t.schedule`d next round, ⭐ scores as badges, PICK 2/3 handling,
   discard reshuffling, join/leave handling (⏭ *Skip Czar* when the Czar
   is away), and a win at the goal (the host's `!goal N`). Demonstrates
   `t.newDeck` + windowed draw piles for a ~1600-card game.
4. **Bridge** — a chat auction, then enforced turns over the four players
   frozen at Deal (a fixed rotation that waits for a dropped player
   rather than `t.nextSeat`), follow-suit, the dummy, trump-aware tricks
   swept face down, `!contract` for the dealer or the host
   (`t.players()`'s `host` flag), ⏳ on the declarer while the dummy's
   card is due, and a Deal that regathers its own 52 from hands, piles and
   loose cards (even after a passed-out hand left no pile) while other
   decks stay put (their cards in a hand go onto a *Set aside* pile).
5. **Simple dealer** — deal 1 to all on a button, saying so when the
   deck is short or gone; the minimal-script example.

Three more own their rules outright (Phase 3: `strict`, `handle`, `t.ask`,
`onSelect` / `t.hint`, components from code). Each is an expression that
calls a function, so its rules read first and its helpers are plain
functions below them; each builds its board in `setup` (`t.setTable`,
`t.setSeats`, `t.newBox`, `t.spawn`, guarded by `t.data.ready` so a
re-enable goes on where it was), taking first every item of another game
off the table (another game's board would stay the primary one, and its
addresses would be read as this game's), reads the position from the pieces where
they stand (`t.find`: the table and the rules can't drift apart), keeps
in `t.data` only what a board can't show, plays every move itself in
`handle` (returning `true`) or refuses it with the reason, sets
`public.turn` to the player to move, says on every screen what a phone's
hidden log would otherwise keep (`t.announce`: check, a pass; `t.tell`: a
declined or lapsed draw offer, or one the offerer's own move withdrew — to
both players), and ends with `t.win` or an announced draw
and a *New game* button for each seated player and the host (a button of
their own each, `pid`: a watcher has none). The 🎲 picker — and the 📜
dialog, for a text named as one of them (edited or not) that would start
afresh: over another game, or with Reset ticked — starts them on a cleared
table (and empty hands) with a fresh state (`clear: true` in `GAMES`), once
the host agrees. A copy renamed is a script like any other: its fresh setup
takes the other items off the table unasked, and leaves the hands alone.

6. **Chess** — legal moves for every piece, with check: `onSelect` hints
   the squares of the piece picked up, `handle` plays the drop (captures,
   castling's rook, en passant) or says why not ("You can't castle through
   check"), a pawn on the last rank asks its player ♕ ♖ ♗ ♘ (`t.ask`,
   `onAnswer`) before the turn passes. After each move: checkmate
   (`t.win`), stalemate, threefold repetition (positions counted in
   `t.data.seen`, the en-passant square only while a capture there is
   legal), the fifty-move rule and dead positions end the game; a draw
   offer is the opponent's ask, resigning asks for confirmation. Glyph
   tokens of an `upright` type.
7. **Go** (`goTemplate(9)`, `goTemplate(19)`) — stones taken from a bowl
   (a supply) onto the points; `handle` places them, removes every group
   left without a liberty (`t.remove(ids)`: one log line), refuses suicide
   and ko (the position before the opponent's last move, kept in
   `t.data.prev`); Pass, Resign, and after two passes in a row Count or a
   stone played on (no third pass): area scoring, komi 6.5. `onSelect` shows a
   tapped stone's group and liberties. No dead-stone marking: players
   capture dead stones before they pass.
8. **Reversi** — discs from each player's own pile; `handle` places one
   only where it outflanks, turns the closed lines with `t.setFace(ids, f)` (one line), passes
   for a player with no move (announced) and counts at the end;
   `onSelect` on your pile hints where a disc may go; the counts are seat
   badges (`public.badges`).

Two more are the scripts of built-in game boxes (Phase 5, private
material): the box lays the material out and does the hiding — racks and
screens are its boards' private zones — and its script, which starts with
the box (`rules.box`), keeps the game. They are in `BOXES` (`templates.js`),
not in the 📜 dropdown.

9. **Dominoes** (`BOXES.dominoes`) — light rules over the draw game for
   two: *Draw 7* (`t.pull(bag, {at})` into the seven slots of each rack: a
   tile lands hidden for the rack's seat), a lead seat by lot
   (`t.random()`) and then in turn — the turn is a seat's, so whoever sits
   there plays it —, `validate` keeping a rack's tiles to its seat (another
   seat's hidden tile left to the engine's uniform refusal), a tile's way
   off a rack and the boneyard's draws (into the drawer's own rack) to the
   seat to move, refusing turns, bags and hides of rack tiles and every
   peek, and noting the tile a play takes off its rack (`t.data.taking`);
   `onAction` counts that tile, laid on the table face up, as the play and
   passes the turn; ⏭ *Pass* once the boneyard is empty; a domino when a
   rack empties (`t.win`) or a blocked line, where every rack tile is
   revealed for the count; *New round* (`t.remove`, then `t.newBag` where
   the boneyard stood). What matches, the spinner and the score are the
   players'.
10. **Veiled Ranks** (`BOXES.ranks`) — strict, hidden units: deployment
    (`handle` moves a unit within its side's screen, swapping onto one of
    its own; ✓ *Ready* for each side), then one step a turn (a Lancer's
    two through an empty first square, `t.line`), attacks that `t.reveal`
    both units and remove the lower rank, a Trap that takes its attacker,
    a Herald's parley, every outcome announced (`t.announce`), the Banner
    taken or no move left to end it (`t.win`; neither side able to move,
    a draw), every unit revealed. `onSelect` hints a unit's moves. Every
    move is `t.move(id, sq, {unzoned: true})`: a unit keeps how it is seen
    wherever it lands — hidden for its side in the other side's rows,
    shown once combat showed it — and its owner is its seat's from the
    setup, never one a zone gave. Its refusals name ranks ("The Banner
    never moves"): the engine keeps them to the unit's player while the
    unit is hidden. *New game* lays the armies out again with `t.layout` (a
    shuffled group a side: nothing in their order tells a rank).

## What it deliberately does NOT do

- No betting/scoring arithmetic beyond what a script author writes.
- A malicious host could run different code than displayed — the same trust
  tier as the host already holding all hands (see README's honest-limits
  section).
- No sandbox beyond the Worker's: a script is trusted code that sees every
  hidden card ("Running in a Worker").

## Implementation map

- `cardtable/core.js`, the DOM-free state core (the page, Node tests and
  a rules Worker run the same code): `createTable(state, env)` holds
  the state and every op — `apply()` with its switch bodies as named op
  helpers, the ruled-action pipeline (`handle`, `strict`, `validate`, the
  hooks after the default effect), the internal jobs (`_join`, `_leave`,
  `_tick`, `_rulesOff`, `_name`), the public view and each player's own
  parts (`T.mine`) — plus the rules module: the journal (`T.begin`,
  `savepoint`, `rollbackTo`, `commit`), the hook runner (atomic, with
  auto-disable), the `t` facade (`T.api`), the engine-state gates
  (`cleanAsk`, `gateRules`), the RULES actor id. Scripts are evaluated by
  a runner (`env.hooks`, by default `scriptHooks()`, which hands the script
  a facade that is live only inside its hooks; tests inject their own).
  It is synchronous and same-thread: the table reads `validate`'s answer
  inline, and a hook that returns a thenable counts as a script error, so
  the veto fails closed. A rules Worker therefore wraps the whole table,
  not the runner: it runs `createTable()` on a mirror of the state, one
  `T.job(p, a)` per action, and the host applies what each job changed
  (its state patch, `T.applyStatePatch()`, which checks it all first and
  refuses it whole) and its effects; `T.digest()`
  proves both agree, and `T.guard()` catches a script that changed its
  state between jobs. The host's own table never runs the script (its
  runner only answers what the rules view says of it). Time, randomness and new ids
  are injectable too (`env.now`, `env.random`, `env.uid`), so a seeded
  table replays exactly. What used to touch the screen or the network
  (action markers, banners, private notes and peeks, new decks, the host's
  toasts) is queued as effects that `app.js` drains (`T.drain()`); what
  changed in the state (items, players, hands, log lines, the rules'
  public part) is recorded in dirty sets that `app.js` takes once per
  broadcast tick (`T.takeDirty()`) to build the patches.
- `cardtable/grid.js`: board geometry (pure): the address grammar,
  snapping, and the maths under `t.neighbors`, `t.distance`, `t.line`,
  `t.linked` and zones; `core.js` keeps the addresses (the primary board,
  display forms) and the `byAt` / `byZone` indexes.
- `cardtable/templates.js`: the example scripts (`RULES_TEMPLATES`: the
  card games, chess, go — `goTemplate(n)` — and reversi), the 🎲
  picker's catalog (`GAMES`) and the built-in game boxes (`BOXES`:
  Draughts, Backgammon, Hexfront, Dominoes and Veiled Ranks, the last three
  with their scripts).
- `cardtable/rules-worker.js`: the Worker — the version check, the
  hardening (the allowlist of globals, the throwing timers and page APIs,
  the lockdown that freezes the built-ins and the engine's modules), the
  script's evaluation, the mirror table and its jobs, `drain()` and `T.guard()` after each, and the
  error forwarding (`fatal`: the engine's fixed words, and a detail for the
  host alone).
- `cardtable/app.js`: the host's action queue (one FIFO; with the rules on,
  one job at a time through the Worker: `startWorker`, `toWorker`, `done`),
  the visible-time watchdog and what ends the rules (`rulesDown`), the
  `note`, `rulesBtn` and `setRules` messages; the rules' public part
  carried in the snapshots and patches, and saved; the timer tick (a
  `_tick` job); the rules dialog and game picker; turn indicator in
  `renderPlayers`; scripted-buttons row; each player's own parts — the
  ask panel (`renderAsk`, `answerV`: one conversion for the panel and the
  terminal), the hints (`renderHints`), the secret card (`renderSecret`),
  `select` on a tap (`tapSelect`, `noSelect`: what the host would drop) —
  and the terminal's `answer`, `select` and `asks`; a game that lays out
  the whole table started on a cleared one (`pickCleared`, from 🎲 or the
  📜 dialog); a fingertip's reach for small supplies (`nearTouch`); the 📦
  dialog (`renderBoxes`, `uploadBox`, `setUpBox` with the trust dialog,
  `resetBox`, the export) and the terminal's `boxes`, `setup` and `reset`.
- `cardtable/boxio.js`: game boxes in and out of files — a `game.json`
  with its images and rules file, or a `.zip` (JSZip from the CDN, every
  entry unzipped as a stream within its limits), read into the box `addBox`
  takes; `encodeImage` (every uploaded image checked by its header and
  redrawn, for decks too); the export (`exportFile`).
- `cardtable/pieces.js`: the hint layer's SVG (`hintSVG`, numbers only).
- `cardtable/index.html` / `style.css`: Rules button + dialog (editor,
  examples select, enable/disable, error line), buttons row, seat glow,
  the ask panel (`#ask`), the secret card (`#secret`), the hint styles.
- `cardtable/README.md`: "Scriptable rules" section including trust notes.
- `cardtable/tests/`: Playwright suites, and Node suites that run the
  templates on a real `core.js` table (see its README).

## Verification plan

Extend the existing Playwright harness (two browser contexts over a local
Nostr relay):

1. Host loads the **Turn order** template and enables it → both sides see
   "enabled rules" in the log and ⏳ on the first seat.
2. An out-of-turn guest tries to play from hand → blocked: no card appears
   on any table, the guest gets a "not your turn" toast, the log records
   the block.
3. The in-turn player plays → succeeds; the indicator advances.
4. Host loads **Hold'em (chips)**, presses *New hand* → every hand count
   becomes 2 (dealt by "Rules" in the log), blinds post themselves; once
   the betting round closes, the flop (3 face-up cards) deals itself on
   both screens.
5. Host reloads → rules (code + enabled + data) survive via the save;
   enforcement still active.
6. **Arbitrary-code proof**: the test types a novel script (not a shipped
   template) — e.g. `onJoin` auto-deals a joining player 3 cards and
   `t.schedule` flips a card after 2s — and verifies both behaviors,
   demonstrating the engine runs code it has never seen.
7. A script with a syntax error → loud toast, the error shows in the
   dialog, the running rules (if any) are untouched, the game is
   unaffected. Existing suites pass as regression.
8. A hook with an infinite loop → the host's page stays responsive, the
   rules stop within 5 s, and the table goes on without them.
