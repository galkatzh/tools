# Tabletop Games — Design

These are design notes for growing the card table into a **general tabletop**.
It should cover classic board games (checkers, chess, go, backgammon), card-driven board games
(a deck plus a map plus tokens), and **big strategy games with hundreds of
pieces**. Rules stay **optional**. A free table must be pleasant to play on
by hand. A script must also be able to take over the rules **completely**:
legal moves, setup, scoring, hidden information and endgame.

These notes were written before implementation as the record of the approach. They are a
companion to [`ENGINE.md`](ENGINE.md) (the rules engine this builds on) and
[`README.md`](README.md) (how the table works today).

**Why this is feasible here:**
- The hard parts already exist and are game-agnostic.
- One authoritative host applies every action through `apply(p, a)`.
- Personalized views keep hidden identities on the host (`publicItems()`).
- Host messages are signed and bound to their recipient.
- Assets travel peer-to-peer once per deck.
- A rules engine can veto, automate, prompt and keep scores.

What's missing is a wider vocabulary of **things on the table**, a sense of
**space** (boards, grids, zones), and the **scale** work that hundreds of
pieces need.

## Guiding principles

1. **One piece model.**
   - A card is just a piece with two faces, one of them hidden.
   - Tokens, tiles, dice, boards and counters are the same thing with
     different faces, shapes and behaviours.
   - Hidden information, logging, flood control and scripts then work for
     every kind at once. Nothing is special-cased per component.
2. **The sandbox comes first, and scripts are optional.**
   - Every game must be playable by hand on a free table, as it is today.
   - That needs snapping, dice, locks, stacks and a supply of pieces.
   - A script adds enforcement and automation on top. It never becomes a
     requirement for a component to work.
3. **Scripts can own the rules completely.**
   - Anything a human can do, a script can do (the existing principle).
   - New here: a script can also **intercept and replace** any action, ask a
     player a question, show them private hints, and decide what each player
     may see.
4. **Scale is a requirement.**
   - 1,000 pieces and 8 players must stay smooth on a mid-range phone.
   - The sync, render and storage paths are designed for that from the start.
5. **No physics, no 3D.**
   - A flat table seen from above, with snapping, keeps the app light enough
     to run in a browser tab with no build step.
6. **Bundled games are public domain.**
   - The shipped demos are classics (draughts, chess, go, backgammon,
     reversi, mancala, dominoes, nine men's morris).
   - Commercial games are played from the players' own uploaded game boxes,
     exactly like custom decks today.

## 1. Components: one piece model

### Piece types

A **game box** (§4) generalizes today's deck. It holds a catalog of
**piece types**, and items on the table refer to a type instead of
repeating its data:

```js
PieceType = {
  kind: 'card' | 'token' | 'tile' | 'die' | 'board',
  name, w, h,                  // size in table units (a standard card is 100×140)
  shape: 'rect' | 'round' | 'hex' | 'meeple' | 'pawn' | 'disc',
  faces: [Face, …],            // card: [front]; token: 1–2; die: N; board: 1
  back: 'backId' | null,       // shared hidden face (a deck's back, a faction's
                               // unit back): what others see when it's hidden
  rotStep: 0 | 15 | 60 | 90,   // rotation snapping (0 = free); hex tiles use 60
  hand: true | false,          // may be held in a hand (cards, tiles, dominoes)
  stack: 'pile' | 'count' | 'none',  // ordered pile, identical stack (×N), or neither
  meta,                        // free-form JSON for scripts (as deck.json has today)
}
Face = { img: g, color, text, label }  // image (shared table, as decks do), or drawn in CSS:
                                       // a coloured shape with a label ("♛", "3", "+2")
```

Many pieces need **no art at all**:
- Chess sets can use the Unicode glyphs ♔♕♖♗♘♙.
- Go stones, checkers and reversi discs are coloured discs.
- Dice faces are pips or numbers.
- Generic counters are coloured shapes with a label.

So a full classic game can ship as a few KB of JSON, like the text-card decks
today.

### Items on the table

```js
// unchanged — cards keep their current wire shape (decks, saves, templates and
// the CLI keep working; internally `up` is face 0 vs. the back):
{ k: 'c', d, i, up, x, y, rot, z }        // a card
{ k: 'p', cards: [{d, i, up}], … }         // an ordered pile (deck, discard)
// new:
{ k: 'g', t: 'box/type', f, x, y, rot, z,  // a piece; f = its current face index
  n,       // count, for identical stacks ('count'): 12 infantry = ONE item ×12
  owner,   // pid: only the owner may move it (enforced even on a free table)
  lock,    // fixed in place (boards by default); toggled by the host, or by anyone if the box allows it
  vis }    // who sees its face when hidden: undefined = nobody, [pids] = those players
{ k: 'b', of: [{t, f}], … }                // a bag: unordered, contents hidden, draws at random
{ k: 's', t, f, … }                        // a supply: an unlimited source (a bowl of go
                                           // stones, the bank's coins): drawing spawns a piece
```

These new kinds cover the parts board games keep needing:
- **Counts** (`n`) turn "a stack of 20 identical armies" into one item, not 20.
  This is the single biggest win for large games.
- **Supplies** make "take a stone / a coin / a wound marker" a single drag,
  with no setup.
- **Bags** cover blind draws (tiles, cubes, chits).
- **Owner and lock** give a free table basic protection: nobody can bump the
  board or move another player's army by accident.

### Hidden information, generalized

`publicItems()` already reduces every item to what everyone may know. It
extends naturally:

| Item state | Everyone else receives |
|---|---|
| card face down | `{d, up:false}` — only its deck (today) |
| piece showing a hidden face (a tile face down, a Stratego-style unit) | `{back}` — the shared back, no type, no face |
| piece with `vis: [pids]` (your own hidden units, dice under your cup) | listed players: the full piece; others: `{back}` |
| pile / bag | count, plus the top card if it is face up; a bag shows its count only |

`vis` is the one new concept. It makes a broadcast **per-recipient for those
items only**. Every other item is shared, which matters for sync (§3). Peeking
generalizes to any hidden piece: it is a private exchange with the host, it is
logged, and a script can veto it.

### Dice and randomness

- `roll` is a host action that uses `crypto.getRandomValues`.
- The result is the die's new face, it is logged ("Alice rolled 5 · 2"), and
  it is animated with a short tumble on every screen.
- Dice under a cup are dice with `vis: [owner]`.
- Scripts get the same randomness through `t.roll(id)` and `t.random()`, so
  nobody, the host included, picks results by hand.

### What it looks like on a free table

| Kind | Default interactions (all of them can be scripted or vetoed) |
|---|---|
| token | drag; double-click flips (two faces); drop on the same type → stack ×N; drag from a ×N stack takes one, shift-drag takes all |
| tile | drag; rotate in `rotStep` steps; flip; into a hand if `hand` |
| die | drag; double-click or 🎲 rolls; select several and roll them together |
| board | locked; the bottom layer; its grid and spaces snap pieces (§2) |
| bag / supply | double-click draws (random / a fresh piece); drop to return |

Two editing tools become essential with many pieces:
- **Multi-select** (rubber band, or shift-click), so a group moves, rotates
  or is deleted in one action.
- **Stack inspector**: tap a ×N stack, or a crowded space, to see and pick
  its members.

## 2. Space: tables, boards, grids and zones

### Table shape

- Today the table is a round felt (1300–2400 units) with seats on its rim.
  That stays the default for card games.
- A box may ask for a **rectangular table** of any size up to about
  6000 × 4000 units, with seats spread along its edges.
- **Seats** are assigned automatically, as today (the middle of the largest
  free stretch of the rim or the edges), unless the seating matters. Then the
  box **names** them:
  ```json
  "seats": [ { "id": "white", "name": "White", "edge": "bottom", "color": "#f8fafc" },
             { "id": "black", "name": "Black", "edge": "top",    "color": "#111827" } ]
  ```
  - Each seat has an `edge` (`bottom`, `top`, `left` or `right`, spread
    along it) or an exact `at: [x, y]`.
  - A joining player takes the first free named seat, and anyone may move
    to a free one from their seat label's menu.
  - Players beyond the named seats watch.
  - Scripts read the seat through `t.players()`: `seatId: 'white'` alongside
    the angle.
- Pan, zoom and rotate-to-your-seat already work for any shape.
- `clampToFelt` becomes a per-shape clamp.
- **The hand bar hides** when nothing on the table can be held in a hand
  (no cards and no `hand: true` pieces) and your hand is empty. The board then
  gets the whole screen on a phone, and the bar comes back the moment a
  hand-held piece exists.

### Boards, grids and spaces

A board piece can declare its **structure**:

```js
board: {
  grid: { type: 'square' | 'hex', cols, rows, cell, x, y,  // origin on the board
          hex: 'pointy' | 'flat', labels: 'chess' | 'xy' | 'axial' },
  spaces: [{ id: 'bar', x, y, r }, …],     // named points (a map's cities, a track's slots)
  zones:  [{ id: 'p1-reserve', poly: [[x,y], …], owner }, …],   // named regions
  links:  [['berlin', 'warsaw'], …],       // point-to-point maps: adjacency
}
```

- **Snapping**: a piece dropped on a board snaps to the nearest cell or space
  within reach. The host snaps (it is the authority); the client snaps the
  preview so the drop feels instant. The `move` action then also carries the
  address it snapped to (`to`), which is what `validate`/`handle` reason with.
- **Addresses**: every snapped piece has a readable location: `e4`, hex
  `(q,r)`, `bar`, `berlin`. The log uses it ("Alice moved ♘ g1 → f3"), and
  scripts reason with it.
- **Stacking on a space**: several pieces on one cell fan out slightly with
  a count badge. The stack inspector opens them.
- Boards without structure (a plain image) are fine: pieces stay free-form,
  as cards are today.

## 3. Scale: hundreds of pieces

**Target:** 1,000 items and 8 players stay smooth. That means 60 fps pan and
zoom on a mid-range phone, and a single move costs under 1 KB per peer on the
wire. Here is where today's design stops scaling, and the changes it needs:

| Today | Cost at 1,000 items | Change |
|---|---|---|
| every change broadcasts the **whole** public state to each peer | ~100 KB × peers × each move (drags send ~16 moves/s) | **delta sync**: seq-numbered patches (changed and removed items), full snapshot on join, gap or reload |
| `publicItems()` recomputes every item per broadcast | O(n) per change | keep the public view incrementally; recompute only touched items (plus per-recipient `vis` items) |
| `renderItems()` visits and restyles every item per render | style work for 1,000 elements on each move | dirty-set rendering: touch only items whose public data changed; CSS `contain` on items |
| `zTop()` scans all items | O(n) per op | keep a running max z |
| `t.items()` deep-clones everything | O(n) per call; scripts loop → O(n²) | indexed reads: `t.item(id)`, `t.at(space)`, `t.find({kind, owner, zone})`, read-only views |
| decks and saves in `localStorage` (~5 MB per origin) | a big box's art doesn't fit | **IndexedDB** for boxes, assets and saves (hundreds of MB; async) |
| a rejoining guest re-downloads every deck | MBs again on every reload | assets keyed by **content hash** and cached in IndexedDB on every peer; the host sends hashes, peers fetch only what they miss |

Delta sync keeps the security model unchanged:
- Patches are sealed and addressed exactly as states are today (`to`/`tp`).
- They carry `seq` and `boot`.
- A guest that sees a gap (or a new `boot`) asks for a snapshot.
- The host keeps one shared patch per broadcast plus per-recipient entries
  only for `vis` items.

The DOM stays the renderer:
- The whole table is already one transformed element, so pan and zoom cost
  nothing per item.
- Incremental updates handle a few thousand elements comfortably.
- A canvas renderer is a later option only if the 1,000-piece benchmark says
  so.

## 4. Game boxes: packaging a game

`deck.json` grows into **`game.json`**. It is uploaded together with its
images, or as a single **`.zip`** read in the browser with JSZip from a CDN
(no build step):

```json
{
  "name": "My Game", "players": [2, 4],
  "table": { "shape": "rect", "w": 3200, "h": 2200, "felt": "#2c3e2f" },
  "pieces": [
    { "id": "board", "kind": "board", "img": "map.jpg", "w": 2000, "h": 1400,
      "grid": { "type": "hex", "hex": "pointy", "cols": 20, "rows": 14, "cell": 100 } },
    { "id": "inf", "kind": "token", "shape": "rect", "w": 60, "h": 60, "stack": "count",
      "faces": [{ "img": "inf.png" }, { "img": "inf-reduced.png" }], "meta": { "atk": 4 } },
    { "id": "d6", "kind": "die", "faces": [1, 2, 3, 4, 5, 6] },
    { "id": "gold", "kind": "token", "shape": "disc", "w": 40, "faces": [{ "color": "#eab308", "label": "1" }] }
  ],
  "decks": [ { "name": "Events", "cards": [ "…deck.json entries…" ] } ],
  "setup": [
    { "piece": "board", "at": "center" },
    { "supply": "gold", "at": [200, 200] },
    { "piece": "d6", "count": 2, "at": [2900, 200] },
    { "deck": "Events", "at": [2900, 1000], "shuffle": true },
    { "forEachSeat": [ { "piece": "inf", "n": 6, "at": "seat", "owner": "seat" } ] }
  ],
  "rules": "rules.js"
}
```

- **Setup** is declarative and optional. *Set up* in the box's menu lays it out
  (and *Reset* clears and re-lays it). `forEachSeat` places each player's
  material at their seat, owned by them.
- **Rules** are optional. When present, `rules.js` loads into the existing 📜
  dialog, and guests can read it as today.
- **Validation** fails loudly, as the deck upload does: a gate in the style of
  `cleanDeck` whitelists every field, checks references to images and pieces,
  and applies size caps. Today's guest budget and flood rules apply to boxes.
- A box is **saved with the table**. It can be **exported** again, with the
  current position as its setup, so a game in progress can be shared or kept.

## 5. Scripts that own the rules

Everything in [`ENGINE.md`](ENGINE.md) stays: hooks, the `t` facade, `t.data`,
`t.public`, buttons, timers, the "📜 Rules" actor, the fail-loudly error
handling and the readable code. To take over the rules completely, a script
needs these additions.

### Intercepting actions: `handle`

Today a script can **veto** an action (`validate`) or **react** to it
(`onAction`). A full-rules game also needs to **replace** what an action does.
For example:
- a king's drag that castles also moves the rook;
- a pawn reaching the last rank asks which piece to promote to;
- a go stone placed on the board removes the groups it captures.

```js
handle(t, a) {   // every gameplay action, before the engine applies it
  // return undefined → apply the default effect (then onAction runs, as today)
  // return 'reason'  → veto, as validate does
  // return true      → handled: the script did whatever the action means
  //                    (through t.* ops), the default effect is skipped
}
strict: true      // an action handle() does not return true for is refused
                  // ("Not a move in this game"): nothing moves unless the rules say so
```

`validate` stays as the simple veto-only form. `handle` is for scripts that
want the whole action.

### Asking players: `t.ask` / `onAnswer`

Games keep needing choices that are not drags: which piece to promote to,
which card to discard, how many to move, which territory to attack. Scripts
can't block and wait (the host must stay responsive, and state must survive a
reload), so asking is a persisted request:

```js
t.ask(pid, { id: 'promo', prompt: 'Promote to', options: ['♕', '♖', '♗', '♘'] })
t.ask(pid, { id: 'target', prompt: 'Attack which space?', pick: 'space', among: ['a3', 'b4'] })
t.ask(pid, { id: 'discard', prompt: 'Discard 2', pick: 'hand', count: 2 })
onAnswer(t, pid, id, value) { … }   // value checked against what was offered, as buttons are
```

- `pick` can be `'item' | 'space' | 'hand' | 'number'`. The player sees a
  prompt and the offered targets highlighted on their screen only.
- The engine refuses any answer that wasn't offered, the way `rulesBtn`
  refuses a button that wasn't shown.
- Pending asks live in `t.data`, so a host reload resumes them.

### Private UI: hints and per-player data

- `t.hint(pid, { items, spaces })`: highlights legal moves for one player.
  It is typically called from **`onSelect(t, pid, id)`**, which fires when a
  player picks up or selects a piece (a cheap new action).
- `t.secret[pid] = {…}`: script UI data sent **only** to that player, such as
  a secret objective, their own score breakdown or an option list. It is the
  private counterpart of `t.public`.

### Components from code

A script can build a game from nothing, as `t.newDeck` already allows:
- `t.newBox({ pieces, decks })` registers types without art, or with drawn art.
- `t.spawn(type, { at, f, n, owner, vis })` places a piece; `at` can be a
  cell, a space or `{x, y}`.
- `t.setFace(id, f)`, `t.setCount(id, n)`, `t.lock(id, on)`,
  `t.setOwner(id, pid)` and `t.setVis(id, pids)` change a piece.
- `t.roll(id)` and `t.random()` use the host's RNG and are logged.
- `t.move(id, at)` also accepts an address (`'e4'`, `'bar'`) besides `x, y`.

### Spatial reads

`t.where(id)` returns the piece's cell or space. The other reads:
- `t.at(cell)` lists what is on a cell or space; `t.find({kind, type, owner, zone})` finds pieces.
- `t.neighbors(cell)`, `t.distance(a, b)` and `t.line(a, b)` work on square
  and hex grids.
- `t.linked(space)` follows `links` on point-to-point maps.

These are pure helpers over indexed state (§3), so a script that checks every
move of a 400-unit game stays fast.

### Running heavy scripts

Big games make a runaway or slow script likelier, and today it would freeze
the host's own tab (ENGINE.md's honest limit). So **rules run in a Web Worker**,
introduced together with `handle`. That way the one change to how scripts run
happens once, early:
- The Worker keeps a **mirror** of the host's state. It is the shared DOM-free
  `core.js` code, kept current with the same patches that sync the guests
  (§3).
- A ruled action is processed in the Worker: `handle` or `validate`, then the
  default effect through the same core ops, then `onAction`. The Worker
  returns the resulting **patch**, plus its log lines, notices and banners.
- The host applies the patch and broadcasts it. Hooks become **atomic**: a
  script that throws halfway leaves no half-applied moves behind.
- To the script, `t` is still synchronous, because it reads and writes the
  mirror. Only the engine around it is asynchronous, and actions queue in
  order.
- A **watchdog** terminates a Worker that doesn't answer within a few seconds.
  It then disables the rules loudly; the table itself is untouched.
- Randomness (shuffles, rolls) happens inside the Worker's ops and travels in
  the patch, so there is a single source of truth.

## 6. A complete example: chess as pure script

```js
({
  name: 'Chess', strict: true,
  setup(t) {          // no box needed: a drawn 8×8 board and Unicode pieces
    if (t.data.ready) return;
    const box = t.newBox({ pieces: [boardType(), ...pieceTypes()] });   // helpers in the template
    t.spawn(box + '/board', { at: 'center' });
    for (const [type, cell] of START) t.spawn(box + '/' + type, { at: cell, owner: ownerOf(type) });
    Object.assign(t.data, { ready: true, turn: 'w', box });   // t.data is the persisted object itself
    t.public.turn = seatOf(t, 'w');
  },
  onSelect(t, p, id) { if (mine(t, p, id)) t.hint(p, { spaces: legalTargets(t, id) }); },
  handle(t, a) {
    if (a.t !== 'move') return;                       // strict: every other action is refused
    if (!mine(t, a.p, a.id) || !legal(t, a.id, a.to)) return 'Illegal move';
    capture(t, a.to); t.move(a.id, a.to);             // + castling's rook, en passant
    if (promotes(t, a.id)) return t.ask(a.p, { id: 'promo', prompt: 'Promote to', options: ['♕', '♖', '♗', '♘'] }), true;
    endTurn(t);
    return true;
  },
  onAnswer(t, p, id, v) { if (id === 'promo') { promote(t, v); endTurn(t); } },
})
```

`endTurn` covers the rest:
- It detects check, checkmate and stalemate, and calls `t.win` or announces a
  draw.
- It flips `t.public.turn`, so the your-turn cue works unchanged.
- It can run clocks with `t.schedule`.

None of this needs a game-specific engine feature.

## 7. Phases

Each phase ships on its own, keeps every existing suite green, and comes with
public-domain demos that prove the new primitives. The build order puts the
foundations first: scale before pieces, so pieces are built on incremental
sync and rendering, and the Worker together with `handle`.

0. **Core and harness.** *Done.*
   - The DOM-free state core (`core.js`: the state model, ops, the public
     view, the validation gates) is extracted from `app.js`, so the page, the
     rules Worker and Node tests all run the same code.
   - The templates move to `templates.js`.
   - The end-to-end harness moves into the repo (`cardtable/tests/`).
   - No change in behaviour.
1. **Scale.** *Done.*
   - Delta sync, incremental public view and rendering.
   - IndexedDB storage and content-hash asset caching.
   - Indexed script reads.
   - *Proof:* a synthetic 1,000-piece benchmark suite (wire bytes per move,
     frame time while panning on an emulated phone, host apply time).
   - As built (README "How it works"): per-recipient patch bases, snapshots
     on join, gap or reload, and a wire version gate; the log travels inside
     the patches; seat keys moved to `state.keys` (state v2); refusals
     re-send what they named; host saves and the deck catalog in IndexedDB
     (one transaction per save, a `ct-pending-<room>` marker for a write the
     closing tab couldn't finish, a newer version's save never touched, the
     host key as the fallback proof of ownership); images by SHA-256,
     pulled by guests from the host only, paced and budgeted, and checked
     (magic bytes, size, header pixel size, hash) before any peer stores
     them; decks ingested outside the action queue; every module import
     versioned (`?v=MODULE_V`).
2. **Pieces, dice and boards.**
   - The piece model (`k:'g'`): tokens, tiles and dice with `roll`.
   - Board images, lock, owner and rotation steps.
   - Identical stacks ×N, supplies and bags.
   - Rectangular tables, named seats, and the hand bar hiding.
   - Free-table interactions and the hidden-face reduction in the public view.
   - *Demos:* draughts and backgammon, played by hand.
3. **Space and full-rules scripting, in a Worker.**
   - Grids, spaces, zones, links and snapping, with addresses in the log.
   - Rules in a Worker with a watchdog, and atomic hooks.
   - `handle`, `strict`, `t.ask` / `onAnswer`, `onSelect` / `t.hint`,
     `t.secret`.
   - Components from code and the spatial helpers.
   - *Demos:* chess with full rules (§6), go 9×9 and 19×19 (up to 361 stones:
     a real scale test), reversi.
4. **Game boxes.**
   - `game.json` plus `.zip` upload, declarative setup and reset.
   - Export with the current position.
   - Multi-select and the stack inspector.
   - A box picker next to 🎲 Games.
   - *Demo:* a generated hex-map strategy skeleton: one map, 400 counters in
     ×N stacks, dice, a card deck and a turn script.
5. **Private material.**
   - `vis` (owner-visible pieces, dice under a cup), private areas beyond the
     hand (a tile rack, a screen), and peeking at any hidden piece.
   - *Demos:* dominoes and a hidden-units game.

The terminal bridge follows each phase:
- pieces and boxes appear in its snapshot;
- `roll`, `place <piece> <cell>` and `answer <id> <value>` join its commands;
- bots can play board games the way the CAH bot plays CAH.

## 8. Verification plan

The Playwright harness (a local Nostr relay and server for each suite) lives
in `cardtable/tests/`, with a README on running it. Logic suites import
`core.js` directly in Node. The harness extends with:

1. **Pieces:** every kind on desktop and iPhone 13 (stack, split, flip,
   rotate step, roll, lock, owner refusal, supply and bag draws), checked
   from two players' points of view.
2. **Hidden pieces:** an attacker peer (as in `t-sec.js`) never receives the
   type or face of a hidden piece, a `vis` piece it isn't listed on, a bag's
   contents or an unrevealed die. Forged `roll` results, faces and counts are
   refused.
3. **Sync:**
   - Deltas match a full snapshot after a random 500-action run.
   - A dropped patch triggers a snapshot request.
   - Host reloads and guest rejoins converge.
4. **Scale benchmark:**
   - 1,000 pieces with 8 players: wire bytes per move under 1 KB.
   - Host apply plus broadcast under 5 ms.
   - Steady 60 fps panning on an emulated mid-range phone.
   - The suite fails if any budget regresses.
5. **Full-rules scripts:**
   - Chess: legal and illegal moves, castling, en passant, promotion through
     `t.ask`, checkmate ends the game.
   - Go: captures, ko, counting.
   - Strict mode refuses everything else.
   - A host reload mid-ask resumes the question.
6. **Boxes:** malformed `game.json` and zips fail loudly. Size caps and the
   guest budget hold. Export, then import, reproduces the position.

## What it deliberately does NOT do

- **No 3D, no physics, no tabletop "throwing".** Dice are rolled by the host,
  not simulated.
- **No hosted asset library.** Players bring their own boxes, and the app ships
  only public-domain demos.
- **No hidden movement or fog of war in the engine.** `vis` and `t.secret` give
  scripts the tools, and the policy is theirs.
- **No server.** The host's browser still holds the game. A big box lives in the
  host's IndexedDB and on each peer that has fetched it.

## Decisions

- **Seats:** automatic by default, or named by the box when the seating matters
  (§2).
- **Hand bar:** hidden when nothing can be held in a hand and yours is empty
  (§2).
- **Worker:** rules move into a Web Worker together with `handle` (phase 3),
  so the one change to how scripts run happens once, early (§5).
