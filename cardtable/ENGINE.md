# Scriptable Rules Engine — Design

Design notes for letting the **host write code** that turns the rules-free
simulator into an enforced, automated game — turn order, legal-move checks,
auto-dealing, a scripted poker dealer, or any tabletop game the host can
express in JavaScript. Written before implementation as the record of the
approach (companion to [`../mdmath/COLLAB-DESIGN.md`](../mdmath/COLLAB-DESIGN.md),
which documents the networking design space this app builds on).

**Why this is cheap here:** the host is already the single authority, and
every player action already flows through one function — `apply(p, a)` in
`app.js`. A rules engine is a plugin at exactly that choke point.
**Why this is safe:** scripts run on the host only. Guests receive data
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
  setup(t) {            // runs once when the host enables the rules
    t.data.turn = t.players()[0].id;
    t.dealToAll(deckPileId, 2, { toHand: true });
  },
  validate(t, a) {      // veto: return a string to block the action
    if (PLAY_ACTIONS.includes(a.t) && a.p !== t.data.turn)
      return "It's not your turn";
  },
  onAction(t, a) {      // automation: react after an action applies
    if (a.t === 'play') t.data.turn = t.nextSeat(t.data.turn);
  },
  buttons: (t) => [{ id: 'flop', label: 'Deal flop' }],
  onButton(t, id, byPid) { ... },   // scripted UI buttons
  onChat(t, text, byPid) { ... },   // chat commands: bids, raises, votes, ...
  onJoin(t, pid) { ... },           // player joins/rejoins mid-game
  onLeave(t, pid) { ... },          // player disconnects
  onTimer(t, tag) { ... },          // fired by t.schedule(seconds, tag)
})
```

Every hook is optional; a script implements only what its game needs. The
hook set — action veto, action react, UI events, join/leave, timers — is
sufficient to express arbitrary turn-based tabletop games.

Evaluated with `new Function('return (' + code + ')')()` wrapped in
try/catch. Any hook that throws: `console.error` + toast + **auto-disable
the rules** (fail loudly, never wedge the game). No worker/WASM sandbox in
v1 — an infinite loop can freeze the host tab; documented limitation, with
quickjs-emscripten (interrupt-handler loop protection) as the upgrade path
if it ever matters.

## 2. The `t` facade (script API)

A thin wrapper over existing internals in `app.js`:

- **Reads**: `t.players()` (id/name/seat/handCount, seat-ordered),
  `t.items()`, `t.piles()`, `t.hand(pid)` (the host already holds all
  hands).
- **Scratch state**: `t.data` — a plain object persisted inside
  `host.rules.data` (survives host reload via the existing `persist()`
  path), so turn pointers, phases, and pending timers live there.
- **Ops — the complete primitive set**, mirroring everything `apply()` can
  do (the switch bodies get refactored into named helpers — `opDeal`,
  `opShuffle`, … — used by both the switch and this API):
  `t.deal(pileId, {to: pid} | {x,y,up,rot})`, `t.dealToAll`,
  `t.draw(pid, pileId, n)`, `t.playFromHand(pid, idx, …)`,
  `t.toHand(pid, cardId)`, `t.shuffle`, `t.flip`, `t.move`, `t.rot`,
  `t.toPile`, `t.stack`, `t.merge`, `t.newPile(cards, {x,y,name})`,
  `t.remove`, `t.addStandardDeck({jokers, x, y})`, and
  `t.newDeck({name, cards, back})` — registering a script-defined deck of
  image-less cards (`{name, text, color, bg, meta}` each; `back` may be a
  solid color like `"#111"`) without creating a pile, so a script can hold
  a huge deck and only materialize small piles from it via
  `t.newPile([{d, i, up}])`, keeping the broadcast state light — so a
  script can set up its own material from scratch. Anything a human can do, a script can
  do — that is the operational definition of "can run arbitrary games".
  Ops performed by scripts act as a synthetic **"📜 Rules"** actor: they go
  through `logEvent`/`mark`, so automations are visible in the table log
  and as name bulbs — the same anti-cheat property as human actions.
- **Player interaction**: `t.say(msg)` (log line as Rules),
  `t.tell(pid, msg)` (targeted toast), `t.announce(msg)` (a big banner on
  every screen, also logged), `t.win(winners, msg)` (sets
  `public.winners`, rendered by the engine as 🏆 on the winners' seat
  labels — the generic way any game declares its outcome), scripted
  `buttons` (global, per-player, or host-only), and
  `t.schedule(seconds, tag)` → `onTimer` for turn clocks and reveal
  delays (timers persist in `t.data`).
- **Convenience utils** (pure functions, no engine state):
  `t.nextSeat(pid)` (next occupied seat clockwise), `t.cardName(ref)`, and
  `t.card(ref)` → `{name, rank, suit, text, meta, deck}` — `meta` being the
  free-form JSON a custom deck's `deck.json` manifest attached to the card,
  so scripts key game logic on `meta.cost`/`meta.type` instead of parsing
  names. Scripts own all actual game logic.

## 3. Enforcement path (the one structural change)

In `apply(p, a)`: before the switch, if rules are enabled and `validate`
returns a reason — and the actor is not the host-script itself — skip the
mutation and send the actor a targeted `note` message (new tiny Trystero
action) → toast on their screen. The next state broadcast reverts their
optimistic drag automatically (the same mechanism that reconciles any
rejected move today). Exempt from validation: `hello`, `name`, `chat`,
`peek` (peeking stays a social action), and the host-only `size`/`setRules`
actions.

## 4. Transparency & UI

- `host.rules = { code, name, enabled, data, public }`. Broadcast to
  everyone: `{ code, name, enabled, public }` — **not** `data`, which may
  hold hidden information (e.g. a planned deal). Guests can **read the
  exact code being enforced** in a read-only view — the same
  everything-on-the-record philosophy as the table log.
- `public` is script-controlled JSON for UI: `{ turn: pid }` highlights
  that player's **seat label** (⏳ + glow) on every screen; `winners`
  renders 🏆; `badges` ({pid: text}) appends per-player text to seat
  labels (chip stacks, scores, tricks won — any game's counters);
  `buttons` renders a scripted-button row (visibility per button), and
  clicks route back to `onButton` via a `rulesBtn` action.
- Host UI: a "📜 Rules" toolbar button → dialog with name, a monospace
  `<textarea>` editor, an examples dropdown, Enable / Disable, and a live
  error line. Guests: the same dialog, read-only.
- The log announces lifecycle: "Alice enabled rules «Hold'em dealer»",
  "Rules blocked Bob: not your turn".

## 5. Example scripts (dialog dropdown — demos, not engine features)

Plain scripts using only the public `t` API; each doubles as documentation
for script authors. A "blank" template with the commented hook skeleton is
the default.

1. **Turn order** — locks play/deal/draw to the current turn, advances on
   `play`, shows ⏳ on the active seat. A composable base for any game.
2. **No-limit Hold'em with chips** — stacks tracked per player and shown
   on seat labels (via the generic `public.badges`), automatic blinds with
   a rotating dealer button, turn-enforced betting rounds (Check/Call/Fold
   buttons for the actor; `!bet N` / `!raise N` / `!allin` in chat, with
   min-raise validation), streets that deal themselves when a round
   closes, automatic all-in run-outs, and a showdown that evaluates each
   contender's best 5 of 7 (all standard rankings, wheel included), builds
   main + side pots from the contribution ledger, and pays each pot to the
   best eligible hand — ties split, odd chips forward. `!rebuy` and
   `!blinds a b` between hands. Proves a complete money game runs as pure
   script.
3. **Cards Against Humanity** — the printed rules end to end: 10-card
   hands, a rotating Card Czar (⏳👑), black prompts flipped from a draw
   pile, face-down submissions (validated: the Czar can't answer, answers
   must be white cards, face down, at most PICK of them), anonymous
   shuffled reveal columns, Czar-only 👉 judging buttons, ⭐ scores as
   badges, PICK 2/3 handling, discard reshuffling, join/leave handling,
   and a win at the goal (`!goal N`). Demonstrates `t.newDeck` +
   windowed draw piles for a ~1600-card game.
4. **War / simple dealer** — deal N to all, flip top on a button; the
   minimal-script example.

## What it deliberately does NOT do

- No betting/scoring arithmetic beyond what a script author writes.
- A malicious host could run different code than displayed — the same trust
  tier as the host already holding all hands (see README's honest-limits
  section).
- No loop protection in v1: a runaway script freezes the host's own tab;
  a refresh recovers the game via the existing save/resume.

## Implementation map

- `cardtable/app.js` (~+300 lines): refactor `apply()` switch bodies into
  named op helpers; a rules module (eval, hook runner with try/catch +
  auto-disable, `t` facade, RULES actor id); the validate-veto in
  `apply()`; new `note`, `rulesBtn`, `setRules` actions; rules carried in
  broadcast/`handleState`/`persist`; turn indicator in `renderPlayers`;
  scripted-buttons row.
- `cardtable/index.html` / `style.css`: Rules button + dialog (editor,
  examples select, enable/disable, error line), buttons row, seat glow.
- `cardtable/README.md`: "Scriptable rules" section including trust notes.
- Example scripts embedded as string constants in `app.js`.

## Verification plan

Extend the existing Playwright harness (two browser contexts over a local
Nostr relay):

1. Host loads the **Turn order** template and enables it → both sides see
   "enabled rules" in the log and ⏳ on the first seat.
2. An out-of-turn guest tries to play from hand → blocked: no card appears
   on any table, the guest gets a "not your turn" toast, the log records
   the block.
3. The in-turn player plays → succeeds; the indicator advances.
4. Host loads **Poker dealer**, presses *New hand* → every hand count
   becomes 2 (dealt by "Rules" in the log); *Flop* → 3 face-up cards on
   both screens.
5. Host reloads → rules (code + enabled + data) survive via the save;
   enforcement still active.
6. **Arbitrary-code proof**: the test types a novel script (not a shipped
   template) — e.g. `onJoin` auto-deals a joining player 3 cards and
   `t.schedule` flips a card after 2s — and verifies both behaviors,
   demonstrating the engine runs code it has never seen.
7. A script with a syntax error → loud toast, rules stay disabled, the
   game is unaffected. Existing suites pass as regression.
