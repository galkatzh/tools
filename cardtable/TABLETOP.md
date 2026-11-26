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
- The question shows in a panel of its own, above the hand bar: it takes its
  room from the table, so it never covers a piece, a seat label or the turn
  cue, and it folds to a chip but can't be dismissed.
- The engine refuses any answer that wasn't offered, the way `rulesBtn`
  refuses a button that wasn't shown.
- Pending asks live in the engine's own state (never `t.data`, which a script
  could corrupt), so a host reload resumes them.

### Private UI: hints and per-player data

- `t.hint(pid, { items, spaces })`: highlights legal moves for one player.
  It is typically called from **`onSelect(t, pid, id)`**, which fires when a
  player picks up or selects a piece (a cheap new action): a tap, or the start
  of a drag. In a strict game that tap shows no action bar — its moves are
  drags, asks and buttons.
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
  `core.js` code, kept current because, while the rules are on, it makes
  every change itself (the guests' patches are public views, which could
  not keep a private mirror current).
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
2. **Pieces, dice and boards.** *Done.*
   - The piece model (`k:'g'`): tokens, tiles and dice with `roll`.
   - Board images, lock, owner and rotation steps.
   - Identical stacks ×N, supplies and bags.
   - Rectangular tables, named seats, and the hand bar hiding.
   - Free-table interactions and the hidden-face reduction in the public view.
   - *Demos:* draughts and backgammon, played by hand.
   - As built (README "Pieces, dice and boards"): game boxes in the
     catalog beside the decks, checked by one gate (`cleanBox`) wherever
     they come from, deduplicated by content and "built in" only by
     content; `grid.js` for board geometry and addresses; `pieces.js` for
     the drawing; state v3 (`table`, `seats`, the boards' z band). The
     decisions taken on the way:
     - A board's structure (grid, spaces, zones, links) is declared and
       drawn now, as an SVG our code builds from numbers only — no images,
       no markup from a box; what it *means* (snapping, addresses) comes in
       phase 3.
     - Dice and dominoes get their dots from a `pips` face field, not from
       Unicode glyphs, which iOS draws unevenly.
     - A piece can belong to a seat ("seat:white"): it follows whoever sits
       there. An offline player's named seat waits for them; the host can
       free it.
     - The host is held to owner checks like everyone, and gives pieces away
       instead.
     - On touch, a drag takes one piece from a ×N stack; "Move all" in its
       bar arms a whole-stack drag for 5 s (there is no Shift key).
     - `t.roll` and `t.random` come with the human roll; the other
       components from code wait for phase 3.
     - A piece whose box is gone stays on the table as a "?", never deleted.
     - Guests get a box without its setup, which may hold hidden
       information.
     - A hand holds at most 1,000 entries and a pile 5,000 members: a supply
       never runs out, and nothing may grow without end.
     - A bag remembers the box whose setup made it, which decides who may
       lock it; that is public (it names a box, never what the bag holds).
     - A back hides boards only or non-boards only, and the face-down
       pieces of a shuffled group must agree on what everyone sees of
       them (rotation, lock, count, owner): otherwise the shuffle would
       give them away.
     - One piece dragged off a ×N stack goes, in the same single action,
       wherever it is dropped: onto a matching stack, back into its
       supply, into a bag — never left lying on top of it.
     - A newcomer gets the boxes and decks before its first look at the
       table, so it never sees a "?" waiting for them; and a guest that
       has lost the host for a minute reloads itself, as one that never
       found the host does, so a link that never forms can't freeze it.
       It keeps the table it had across that reload, paused, so a host who
       simply left still leaves everyone the last table.
     - A supply's bar has "Move" too: on touch a drag takes a piece out of
       it, and there is no Shift key to move it instead.
     - With a piece selected, a tap on a board only puts the bar away; the
       next tap selects the board. A tap meant to deselect lands on the
       board more often than not.
     - Badges (a stack's ×N, a supply's ∞, an owner's dot) grow, up to
       three times, on a table drawn small, such as a phone's, so they stay
       readable.
     - An owner's dot shows on demand — on the piece you select, or under
       a mouse — not on every piece: a game whose men all belong to a seat
       would otherwise be covered in dots. A tap on any piece still shows
       whose it is, and its bar what you may do with it.
     - A board's coordinates read upright for every player, as on a chess
       app's flipped board: each stays by its own file or rank but turns to
       face the screen, so the player across the board never reads them
       upside down; on a phone they grow a little, as badges do, but no
       more than their margin holds. A space's or zone's label turns only by
       half turns: it is never upside down, and still runs along its space.
       The badges (a pile's count and name, ×N, ∞, 🔒) and a bag turn to
       face the screen too, and a pile's name sits under its pile on every
       screen. While two fingers turn or zoom the view, the badges move with
       the table and settle once the fingers lift: on a table of a thousand
       stacks, turning or resizing them all as the view moves would stutter.
       When the fingers rest mid-zoom (hold still a moment: a mere
       hesitation doesn't count) the badges take the size the view calls
       for, so they never stay swollen over the pieces being zoomed in on;
       a twist alone leaves their size until the lift. A resize costs a
       stutter of its own on such a table, so the badges wait for a real
       rest, and skip a change of under a quarter.
       The pieces' own faces stay as they lie.
     - A plain round piece (a checker, a man: no picture, label, text or
       pips, and as wide as it is high) looks the same at any angle, so its
       bar offers no turn buttons.
     - A guest whose host stays away reloads at the backoff's pace (40 s,
       80 s, then every 2 minutes), not every minute: the wait counts on
       across its reloads, and the notice says how long the host has been
       gone. A page whose own connection is down says so, never that the
       host is away. Its patience counts from when the player joins, not
       from when the page opened: a newcomer who takes a while to type a
       name is neither told the connection failed nor sent round again.
     - A page open for over a minute still links at once: the WebRTC
       library's ready-made connections, re-offered after a minute, went
       out empty in Chrome and Safari (every iPhone browser included), so
       half the guests joining or reloading into a room never linked. The
       app now hands the library a connection that keeps them whole, until
       the library itself is updated.
     - A host whose tab is hidden (a phone switching apps) saves at once,
       as one that closes does: a phone may never wake that tab again.
       Still one save at a time: a hidden tab lives on.
     - On a phone turned sideways the notices and the watchers' box keep to
       the margins beside the table as you see it, a long table seen from
       its side included.
3. **Space and full-rules scripting, in a Worker.**
   - Grids, spaces, zones, links and snapping, with addresses in the log.
   - Rules in a Worker with a watchdog, and atomic hooks.
   - `handle`, `strict`, `t.ask` / `onAnswer`, `onSelect` / `t.hint`,
     `t.secret`.
   - Components from code and the spatial helpers.
   - *Demos:* chess with full rules (§6), go 9×9 and 19×19 (up to 361 stones:
     a real scale test), reversi.
   - *Done*, in three parts: space, the Worker, then play. Space (README
     "Pieces, dice and boards", ENGINE.md "Addresses and the spatial
     helpers"): snapping, addresses, the spatial helpers, components from
     code, the snap preview, fanned spots and live drags; state v4, wire
     version 4. The Worker (README "Scriptable rules", ENGINE.md "Running
     in a Worker"): a rules script runs away from the host's page, under a
     watchdog. Play (README "Scriptable rules", ENGINE.md §4 and §5): the
     ask panel, the hint layer and the secret card, the terminal's `asks`,
     `answer` and `select`, and the demos — chess with every rule, go on
     9 × 9 and 19 × 19, and reversi, each a script a reader can learn
     from. The decisions taken on the way:
     - A space reaches as far as its drawn rectangle, not only a circle
       round its centre: a checker dropped on the far end of the tall bar
       lands on the bar, not on the point whose centre is nearer.
     - The address a script names is where the piece goes, even under a
       board lying on top; `free: true` leaves a piece where it is put,
       with no address. A person never names an address: a drop names a
       place, the host snaps it (the terminal's `place` resolves one first,
       and says so when it isn't on any board or could be on two).
     - Moving, turning or removing a board never moves a piece: the
       pieces read their spots again, whatever changed the boards.
     - Boards of one type number together across games (`board#2`), so a
       spot's name never means two places.
     - Pieces sharing a spot fan out as drawn — along a backgammon point
       from its base, even a lone checker; elsewhere a few units apart —
       and a press on the crowd takes the top one. The doubling cube now
       waits beside the board: on the bar it fanned in with every checker
       sent there.
     - Someone else's drag glides on your screen and changes nothing until
       the drop; it moves by a transform, so a big table never lays itself
       out mid-drag.
     - A script's run of placements or removals is one log line, naming
       the first spots.
     - A script's box with text decks is found again by content, decks
       included: a reset that runs the same setup adds nothing.
     - After its review: dice never snap (a die set down on a point joined
       the checkers' fan and took every press there); snapping, its
       preview and the terminal's `place` follow one rule, the host's; a
       piece's address is read again only when a board under it changes,
       and before anything reads one; a pull a script refuses keeps its
       draw for the bag's next pull, so refusing can't fish a bag; a press
       on a crowd takes your own piece, and backgammon's bar and trays fan
       too; a piece off a spot's centre is drawn where it lies; a guest's
       drop shows where the preview did; a client's `to`, `from`, `pick`
       and `handled` never reach a script.
     - After its second review: a piece on a board's edge spot stays
       centred on it across a host's reload and a table change (a new felt
       moves nothing); a press on a piece drawn off its spot's centre takes
       that piece, and once a piece is put on such a spot, the spot fans
       them all, so none is drawn over another.
     - The engine for full-rules scripts is built: a script can take
       an action over (`handle`), refuse whatever it didn't take over
       (`strict`, but for the actions it `allow`s; sitting down always
       works), ask one player a question (`t.ask`), highlight moves for
       one player when they pick up a piece (`t.hint`), and keep data for
       one player (`t.secret`). Each reaches only its player, as a hand
       does.
     - Hooks are atomic: a veto or an error leaves none of the script's
       moves behind; a hook that fails after the move keeps the move and
       drops only its own changes. Every action is journaled for this,
       and what it changed is exactly what a Worker will send the host.
     - A question and a hint show only while the rules run; a player's
       secret shows even while they are off, like their hand.
     - A script that touches the table from outside its hooks (an
       `async` hook's continuation) turns the rules off before the next
       action: hooks must be synchronous, and now they are made to be.
     - Rules run in a Worker that holds a copy of the table and makes
       every change while they are on; the host's page applies what each
       action changed. A script stuck in a loop is stopped after 4 s of the
       host's visible time (a phone that hides the tab stops the clock), its
       action dropped and the rules turned off — the host's page never
       freezes. A script written for the page (`alert`, `localStorage`,
       `setTimeout`) turns the rules off saying why, and what to use
       instead.
     - Enable is asynchronous: the dialog says "Starting…", and a script
       that doesn't start leaves the running rules as they were. A host
       reload starts the saved rules again without re-running their setup.
     - A function left in `t.data` costs the rules, not the game: they go
       off, keeping the data's plain part, as a save that couldn't copy it
       did before.
     - After the Worker's review: the host keeps every address exactly as
       the Worker read it, and a new Worker starts with the host's table as
       it is, highlights included, so the two never drift apart; the
       script's state must be plain JSON (a typed array, a `Map` or a
       `Date` fails its hook, saying so), and the host checks again what
       the Worker sends. A script can't post its Worker a job of its own
       (only the host's messages are read), and fonts, the site's file
       system and locks are taken away too. A player's arrival, departure
       or rename is never lost to a stuck script; a reconnect while the old
       connection's departure waits is counted as a return. The running
       rules crashing while new ones start begins the start again; a crash
       is said to everyone as "the script crashed", its words to the host
       alone. Enable evaluates a script once. Saved rules a reload can't
       start because the page and the files disagree stay on in the save,
       so the reload the toast asks for brings them back.
     - After its second review: a script shares the Worker's built-ins with
       the engine, so it could rewrite what the engine writes there. The
       host, on its own page, refuses any action's changes that speak for
       someone else — a log line or a name bubble of anyone but the acting
       player or the rules, a chat line that isn't their own words — so a
       script can't sign another player's name. The script's state is
       checked value by value on every action (a `Date` written over its
       own text fails too), and a change made outside a hook is named when
       it happens, not blamed on the next player's move. A change the host
       refuses ends the rules like a crash: a departure in it is kept, a
       player's move dropped with a notice.
     - After its third review: before a script runs, the Worker freezes
       every built-in it shares with the engine, so a script can't rewrite
       what the engine writes through them — a line's words, a player's
       name; and it keeps only a short list of globals, so no browser's
       extra API (the site's service workers in Safari and Firefox, a real
       timer, notifications, devices) is left to it. The host still checks
       each action's changes in full, and refuses them whole: a player
       appears, is renamed or changes colour only by their own join or
       rename, the rules' code changes only when the host enables a
       script, and nothing the host shows or saves can be malformed — a
       save with a broken record starts without it. When a script breaks a
       rule from outside a hook, everyone is told only that it did; which
       value, under which of its keys, goes to the host alone.
     - After its fourth review: a script could still import the engine's
       own files — the very modules its Worker runs — and change one of
       their exports, putting its words in a guest's line about the deck
       they added, and in the deck itself. Those exports are frozen now
       too, and the host checks a guest's deck, and their line about it,
       against what they sent. What the host carries out of a script's
       changes (a name bubble, a notice) is rebuilt from the fields the
       engine writes, so a malformed one can no longer stop every screen
       from following the table; a guest who renames themselves "0" no
       longer switches the rules off for everyone, and a `t.tell` to nobody
       is the script's own error, naming `t.tell`; a lie about how high the pieces are stacked can no longer cost a
       card on the next reload; the host is told what a reload couldn't
       read; and checking the script's state no longer slows down with
       long lists.
     - Playing (its first part): a question takes its own room above the
       hand bar, never covering the table; a tap in a strict game asks the
       rules for a hint and shows no buttons they would refuse; the
       terminal writes the same question text in both languages.
     - The demos: each game reads its position from the pieces where they
       stand, so the table and the rules can't drift apart, and plays
       every move itself or says why not. A chess glyph reads upright for
       both players (a piece type may ask for that; a piece's face
       otherwise still lies as it lies), and a reversi disc is named by the
       side it shows in the log. Their tables are taller than wide, with
       room by each edge for a seat label and its player's buttons, so a
       phone held upright draws the board as large as its width allows.
       🎲 starts each on a cleared table, afresh even over the same game.
       Chess's draws are automatic (no claim: a casual table has no
       arbiter); a draw offer is the opponent's question, resigning asks
       first. Go has no dead-stone marking: players capture dead stones
       before passing, and Count scores what is on the board.
     - After play's review: a go capture is one log line however many
       stones it takes (a script removing a list at once writes one line),
       and a reversi move's flips are one, naming the two faces. Chess, go
       and reversi take the whole table: started from the 📜 dialog over
       another game they clear it first, as 🎲 does, once the host agrees,
       and a card pile left under their rules is refused like any other
       foreign item, never a script error. What a phone's hidden log would
       keep is said on the screen — a check and a pass as a banner, a
       declined or lapsed draw offer to the player who made it, why a move
       waits on the opponent's promotion — and "New game" is the players'
       and the host's own button, never a watcher's; after two passes go
       offers Count or a stone, not a third pass. A bowl smaller than a
       fingertip is taken by a press beside it. On a phone held sideways
       the secret card keeps its head on screen; the question's fold button
       never takes a row of its own; a question asked again works at once.
       The terminal says an error again in the same words, says a select
       the rules would drop, and reads a typed number as an option's label
       first. A script can no longer re-point a frozen regex of the engine
       (`compile` is gone), and the host checks every deck a player's
       action adds against what they sent, whatever the patch's lines say.
     - After its second look: the 📜 dialog asks before an edited chess,
       go or reversi (still under its name), or one reset, clears the table
       and the hands; a script renamed takes the table's other items
       unasked, as any script may. The secret card's frame always holds
       its head, which gives way last, and buttons that don't fit scroll. A
       player whose own move withdraws their draw offer is told so, and
       the opponent, whose question vanished, is told why.
4. **Game boxes.**
   - `game.json` plus `.zip` upload, declarative setup and reset.
   - Export with the current position.
   - Multi-select and the stack inspector.
   - A box picker next to 🎲 Games.
   - *Demo:* a generated hex-map strategy skeleton: one map, 400 counters in
     ×N stacks, dice, a card deck and a turn script.
   - *Done* (game boxes: state v5, wire version 5), in two parts: the
     engine, 📦, uploads and export, then groups, multi-select, the stack
     inspector and Hexfront. The decisions taken on the way:
     - A box's setup happens whole or not at all: everything it needs is
       checked first — its decks, the seated players a "#k" names, the
       room on the table — and a spot it names that the table doesn't have
       undoes all of it.
     - An exported game resumes in another room: its items, its box and
       its decks keep their ids wherever they are free, a seated player
       travels as their place at the table (the k-th clockwise from the
       bottom), in owners and hands and in the script's saved state alike,
       and the box's rules start on that state right after the setup.
     - Where a box came from is the host's to say, never the box's: a
       guest's box shuffles its face-down piles by default, whatever the
       box or a script claims.
     - The host's own box is added only once its images are stored; a
       guest's leaves nothing in the host's storage until it is on the
       table, within the budget it shares with decks.
     - The 📦 box picker, the upload, Set up, Reset and the export are in
       too, and the terminal's `boxes`, `setup` and `reset`:
       - An upload is read within limits that hold whatever a zip claims
         (each file unzipped as a stream that stops at what it declared),
         and every image leaves as a plain picture a canvas drew — except
         one the browser already holds, kept as it is, so a game exported
         and imported again is the same game.
       - A box's rules wait for the host's click in the trust dialog, from
         the terminal too; only a built-in box, known by its content,
         skips it.
       - An export takes the rules and their state along by default only
         while they run.
       - Setting a box up stops the game that ran: its rules are switched
         off with the table they ruled (said in the confirm), as 🎲 does;
         a clear ends the box set up, so Reset never lays out a box the
         table no longer holds.
       - A shuffle of hidden pieces deals out what they are, never where
         they stand: the ids a box's author gave stay with the places, and
         pieces that would look different once dealt (a die never snaps)
         can't share the shuffle.
       - The trust dialog can't be answered by accident: its buttons wake
         half a second after it shows, and Cancel stands where the
         confirm's Set up was at any screen size (the questions stand on
         their bottom edge).
       - A box its rules lay out is set up — and reset — by its rules
         alone, never cleared for nothing while they are off; only the
         rules' own refusal of an upload is blamed on them, and only rules
         that run name an export.
     - A group (the selection acted on at once) is its members, each
       taken as if sent alone — the same owner, lock and hidden-piece
       checks, the same rules, its own undo — in one job: a member refused
       or vetoed is skipped alone, a rules script that fails while judging
       one stops the whole group, and the player hears one notice for the
       skipped ones; the log has one line for the group. Its cost against
       flood control grows with its size, and a group drag is one message
       however many it carries. The terminal has `group` too.
     - *Hexfront*, the demo, is generated from a fixed seed — the same box
       every time, so it is built in by what it is — and set up from 📦's
       built-in boxes with its turn script, which needs no trust dialog.
       Its event cards are tiles, so the box carries everything it needs.
     - Multi-select picks only what the player may move — never a board,
       nor what is locked or someone else's, each counted in a chip — up
       to the 200 one group takes. With Shift, a band starts wherever a
       plain drag would pan (the felt, a locked board, someone else's
       piece), and a press on a piece the player may move still drags it;
       with ⬚ on, any press but on a picked piece draws one, and a click
       only picks (a double one never flips or rolls). One piece picked is
       just selected, with its own bar.
       A member locked while picked stays picked, so the group bar can
       unlock it; the group's moves, turns and flips leave it out, as the
       host would.
     - A piece's bar and the inspector stand beside what they act on —
       above it when there is room, else below, else as low as they fit —
       never over it, and a piece's bar stands clear of the whole crowd on
       its spot, so a finger's next tap there never lands on a button.
       While a selection is being built its bar docks where no piece is
       drawn, in one row (✕ first, then the count; scrolling sideways when
       wider than the screen, so it is never deeper than the strip it
       found clear): along the top of the table when that strip is clear (a
       table seen whole leaves its rim there), else in the toolbar's place,
       as a phone's selection bar does — so it never covers a piece still
       to pick. Any piece, anyone's, that comes into its strip moves it out
       of the way; it holds its buttons a moment whenever it appears or
       moves, and 🗑 of more than five asks first, the question scrolled
       into sight. The row scrolls by a swipe or a mouse's wheel (a wheel
       over it, or over the inspector, never zooms the table); an end
       fades while more lies beyond it; what it opens (👜 Into bag ▸, Give
       ▸) or asks comes into sight, stays there as the bar moves, and once
       it is gone the row is back where the player left it. On a touch
       screen the bar's buttons are a fingertip tall (44 px), as far as the
       toolbar's height allows.
     - What review found and fixed: a group member refused by the table
       leaves nothing of what the rules wrote for it; a group move sends
       each peer the members' new places alone (a third of the bytes); a
       built-in box shuffles its face-down piles whenever it is laid out;
       a group under rules pays for the rules' state each member passes
       over, in flood tokens (past the burst too) and in watchdog time;
       Hexfront's events are the side to play's alone, by any route; a
       phone pans, pinches and turns the table without making the browser
       repaint the seat labels, restyle the table twice a frame, or lay the
       page out (each layout made the browser hit-test the whole table for
       hover): what the seat labels' places resize waits for the fingers
       to lift or the wheel to rest, and a piece's bar or the inspector
       open beside what the view moves follows it on the size it read
       before.
     - A tap on a ×N badge or a spot's ×k opens the inspector (a long press
       on a phone, in place of the zoom, for a stack); ⋯ Inspect is in the
       bar of a stack or crowded piece the player may move. Take all arms
       the whole-stack drag (✥) rather than moving the stack somewhere
       itself.
5. **Private material.**
   - `vis` (owner-visible pieces, dice under a cup), private areas beyond the
     hand (a tile rack, a screen), and peeking at any hidden piece.
   - *Demos:* dominoes and a hidden-units game.
   - *Done* (private material: state v6, wire version 6), in three parts
     and a review: the engine and the wire, the table and the terminal, the
     two demos, then what review found closed. With it the build order is
     complete.
   - The engine and the wire (part 1 of the phase):
     - A piece lies hidden for whom its `vis` names — a player, or a seat
       and so whoever sits there — and every other player gets its back.
       Each message carries, in the part addressed to one player, the full
       form of the pieces that player sees; a seat changing hands sends
       its pieces again, so its new occupant sees them and the one who
       left doesn't. Moving such a piece costs the others what moving any
       hidden piece does.
     - Hiding a piece (a cup over dice) makes it its hider's until it is
       revealed: nobody else may turn it over, roll it, set its face, take
       it into a hand or claim it, and the refusal is the same whatever it
       is; anyone may peek at it, on the record. The log never names a
       hidden piece, and a roll names the shown dice's values alone.
     - A rack or a screen is a zone of a small board: whatever is set down
       in it hides for its owner (and belongs to them, unless it already
       belongs to someone); off a rack it is face up again, out from
       behind a screen it stays hidden; a board moved under or away from a
       piece changes nothing. A zone never shows anyone a piece hidden from
       them: a screen keeps who sees a piece hidden for someone else, and a
       rack takes one over only from a hand that sees it.
     - Scripts hide, reveal and change who sees a piece; what a game hides
       beyond a piece's face (where things are, fog of war) stays the
       script's.
     - Exported games keep it all: a cup's dice, a screen's units that
       left it, and a script's hidden pieces as they were; a rack's tiles
       are hidden again by their rack when the game is set up, and what a
       zone wouldn't give back as it is is written as it lies.
   - The table and the terminal (part 2 of the phase):
     - A piece you see while the others see its back is drawn face up with
       🙈 on its corner and that corner faintly hatched; its tooltip names
       who else sees it. Everyone else sees its back, and nothing more.
     - Its bar: 🙈 Hide (on a die, a cup over it and the dice touching it),
       Reveal for a hidden piece, Peek for one hidden from you; the group
       bar hides a selection, and H hides from the keyboard. Rolled under
       the cup, the dice tumble as backs on the others' screens.
     - A rack or a screen is hatched in its owner's colour and says whose
       it is ("🔒 Alice's rack", "🔒 Your rack" on your own screen, "🔓
       Nobody's rack" while it hides nothing); a bag's 🔒 Draw to my rack
       draws straight into a free slot of yours.
     - The terminal hides, reveals and peeks at pieces, and marks the
       pieces only you see.
   - The demos (part 3 of the phase), both built-in boxes with their
     scripts, set up from 🎲 or 📦:
     - **Dominoes** (public domain): the double-six set — each tile a type
       of its own under one back, so a face-down tile says nothing and none
       can be turned into another — in a boneyard bag, and a rack for each
       of the two seats. *Draw 7* drops seven tiles into each rack, hidden
       as they land; the leader is drawn by lot, then the lead goes round.
       The script keeps the turn — the boneyard and a tile's way off a
       rack are the player to move's, a tile set down face up passes the
       turn — and forbids peeking; ⏭ *Pass* once the boneyard is empty, 🏆
       for the rack emptied first, *New round* puts every tile back. The
       ends, the spinner and the score are the players'.
     - **Veiled Ranks** (original): two armies of twelve hidden units on a
       10 × 10 field — a Banner, a Crown, Blades, Pikes, Lancers that step
       one or two squares, a Herald that parleys, Traps — each side's
       units face down for the other behind a screen on its three home
       rows, dealt out at random so that no square, id or order tells a
       rank. Both sides deploy, then *Ready*; a strict script plays every
       move: one step along a rank or a file, an attack that reveals both
       units (for good) and removes the lower rank, a Trap that takes its
       attacker, a parley that only reveals, and the Banner taken — or a
       side left with no move — to win, every unit then shown.
     - Each played as two players and a watcher on a desktop and on
       phones held both ways; a game exported mid-play sets up again with
       every hidden piece hidden for the same players.
   - What review found and fixed:
     - Nothing hidden from a player reaches them by a detour any more: not
       by dropping someone's private piece on one's own rack, nor by
       stacking it, bagging it or drawing it back out; not by a draw
       refused for what it would have drawn; not by where a hidden die
       lands beside a hidden token; not by a game's refusal of a move of
       one's own hidden unit (its words, "The Banner never moves", and its
       piece's way back are that player's alone, and nobody sees a hidden
       piece dragged); not by an export set up again (a unit in the other
       side's rows, a revealed one behind its own screen, a rack whose
       owner left are written as they lie, hidden from more, never shown).
     - Dominoes keeps the turn by seat (a player taking over a seat plays
       on), counts the tiles where they lie, plays a tile only by taking it
       off its rack on its seat's turn, and shows the racks at a round's
       end; its tiles draw each half's pips in its own half, and a full
       rack takes the next tile half a slot on. Veiled Ranks moves units as
       they are, announces every fight, calls a draw when neither side can
       move, and gives every kind its own label. The built-in dice wear a
       cup; a cup leaves a locked die out; a wheel over the 🔒 card scrolls
       it; and no board text is drawn while the view moves, so a labelled
       board or a rack costs a gesture nothing.

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
- **Questions take their own room:** a rules' ask is a panel between the table
  and the hand bar, never a card over the table — where a pick must be tapped
  (§5).
- **A tap is a selection in a strict game:** with rules that want selections,
  it asks them for a hint and shows no action bar, whose buttons they would
  refuse (§5).
- **The demos are scripts, not engine features:** chess, go and reversi use
  only the public `t` API; the table is their position, `t.data` only what
  a board can't show (§5, §6).
- **Upright glyphs on request:** a piece type may ask for its label to read
  upright on every screen (chess); every other face still lies as it lies
  on the table (§2).
- **One call, one line:** a script that removes or turns a list of pieces at
  once (a go capture, a reversi move) writes one log line for it; separate
  calls merge from four on, as before (§5).
- **A game that lays out the whole table clears it first**, from 🎲 or
  the 📜 dialog, once the host agrees — known by its name, so an edited
  copy asks too; a copy renamed is a script like any other (§7).
- **A fingertip's reach for small supplies only:** a bowl or a pile drawn
  smaller than a fingertip takes a press beside it; small pieces don't, so a
  finger on a crowded table still pans (§2).
- **A new game box replaces the game that ran:** a clearing Set up switches
  the running rules off (the box's own start after it, once the host
  trusts them), and a clear forgets the box set up (§4, §7).
- **An id names a place, never a hidden piece:** a shuffle of hidden pieces
  trades their identities among the places, so ids a box's author chose
  reveal nothing (§1, §4).
- **Whatever a shuffle deals must look alike once dealt:** the hidden
  pieces a group shuffles agree on everything that shows, being a die
  included — a die never snaps, so the spot it was dealt to would lose its
  address and show it (§1, §4).
- **A question's last button holds its place:** the 📦 questions stand on
  their bottom edge, so the confirm's *Set up* and the trust dialog's
  *Cancel* share one spot on every screen, wrapped buttons or not (§4).
- **Set up and Reset always lay something out:** a box its rules lay out is
  set up or reset only with those rules starting; with them off, 📦 offers
  no Reset and the engine refuses one, so the table is never cleared for
  nothing (§4).
- **A group is its members, each judged alone:** acting on a selection
  applies each item as if it were sent alone — the same checks, the same
  rules — skipping the ones refused and saying so once (§3, §5).
- **A built-in box may bring its own rules:** they start with the box, with
  no trust dialog, because the box is known by its content (Hexfront's turn
  script, §4).
- **A selection holds only what its player may move:** boards, locked
  pieces and other players' are never picked (a chip counts them), so the
  group bar never offers what the host would refuse (§3).
- **Tools stand beside what they act on:** the stack inspector and a
  piece's bar are placed next to their pieces — a crowded spot counted
  whole — never over them while the screen has room, with fingertip-sized
  buttons on a touch screen (§3, §4).
- **A selection being built has its bar where no piece is:** one row
  along the top of the table when no piece lies there, else over the
  toolbar (✕ gives it back), so it never covers a piece still to pick;
  when a piece comes into its strip it moves away, its buttons wait a
  moment whenever it appears or moves, and 🗑 of more than a few asks
  first (§3, §4).
- **A bar that scrolls keeps its place:** a one-row bar scrolls by a swipe
  or a wheel, its ends fading while more lies beyond; what it opens or
  asks is brought into sight and kept there wherever the bar moves, and
  afterwards the row goes back where its player left it — it never
  scrolls on its own otherwise (§3).
- **A gesture's frames move things, never size them:** while fingers pan,
  pinch or turn the view, or a wheel zooms it, what follows the view — a
  seat label, a piece's bar, the inspector — moves by transform alone, on
  sizes read before, and whatever would lay the page out waits for the
  lift or the wheel's rest — a layout makes the browser hit-test the whole
  table for hover (§2, §4).
- **A selection mode means selecting:** with ⬚ on, a drag draws a box
  wherever it starts (but on a picked piece, which carries the lot) and a
  click only picks — a double one never flips or rolls (§3).
- **Nothing hidden is in a known order:** a built-in box's face-down piles
  are shuffled whenever it is laid out, as a guest's box's are, since
  everyone can read its source (§4).
- **A move sends where things went:** a patch carries a moved item's new
  place alone, so a 200-piece group move costs each peer about 11 KB (§1,
  §3).
- **A group pays for what it costs:** while rules run, its price and its
  watchdog time grow with the rules' state each member passes over — its
  price past the burst too, so its sender waits the rest out and a flood of
  groups buys no more of the rules' time than single moves do (§5).
- **What you may see travels to you alone:** a piece hidden from others
  reaches the players who see it whole, in their own part of each message,
  and everyone else its back; a piece seen by a seat is seen by whoever
  sits there, and a move of such a piece costs the others no more than any
  hidden piece's (§3).
- **What would show a private piece is its owner's:** a piece you hide
  (dice under your cup) is yours until it is revealed; nobody else may turn
  it over, roll it, set its face, take it into a hand or claim it — the
  same refusal whatever it is — but anyone may peek at it, on the record
  (§2, §3).
- **Racks and screens hide whatever is set down in them:** a piece placed
  in one lies hidden for its owner — placed again, it hides again, even one
  revealed there; off a rack it is played face up, out from behind a screen
  it stays hidden; a board moved under or away from a piece changes
  nothing, and a piece with no hidden side can't go in (§2, §3).
- **What only you see is marked as yours:** a piece hidden from the others
  but not from you shows its face with 🙈 and a hatched corner, wherever it
  lies — in a rack too, whose label a phone may not show — so it is never
  mistaken for one the table sees (§2).
- **A rack says whose it is on every screen:** hatched in its owner's
  colour, labelled with their name (yours: "Your rack") beside it, on the
  side of the table's middle where no piece in it covers the label (§2, §4).
- **Drawing into your rack shows nothing:** Draw to my rack sets the piece
  down straight in a free slot of your rack, hidden as it lands, rather
  than face down beside the bag to be dragged over (§2).
- **A zone never shows anyone a piece hidden from them:** a screen keeps
  who sees a piece hidden for someone else, a rack takes one over only from
  a hand that sees it, and whatever would show a private piece or strip
  who sees it — a pile, a bag, a hand, a claim — is its viewers' or its
  owner's alone; a piece can also be set down "unzoned", exactly as it is
  (§2, §3).
- **A game's private pieces stay its sides':** Veiled Ranks moves every
  unit unzoned, so one hidden in the other side's rows stays its own
  side's and one combat revealed stays revealed; a side's units belong to
  its seat from the setup, so no zone hands them over (§2, §5).
- **A refusal about your own hidden piece is yours:** a game's words
  against a move of a piece only you see ("The Banner never moves") reach
  you alone, with no line on the log and nothing re-sent to the others —
  and nobody sees a hidden piece of yours dragged, only where it lands
  (§3, §5).
- **Hidden things look alike everywhere they could differ:** a hidden die
  and a hidden token under one back land alike (neither snaps), and a draw
  is never refused for what it would draw (§1, §2).
- **What a script says names nothing hidden:** a script's lines and
  banners may only say what the table shows — Dominoes draws its leader
  by lot rather than name who holds the highest double (§5).
- **Built-in games with their own rules are 🎲 games too:** Dominoes and
  Veiled Ranks start from the picker, which marks them playing while their
  rules run, as from 📦's Built-in section (§4, §7).
