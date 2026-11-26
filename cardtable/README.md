# Card Table

A serverless multiplayer **tabletop**: cards, boards, dice and pieces on a
shared table — load decks, shuffle, draw, deal, move, rotate and flip, keep a
private hand or rack, play face up or face down — played by hand the way a
physical table is, or by an optional rules script that enforces a game and
automates its chores (chess, go, Hold'em, … are built in). Whole games come
in **game boxes**, from a classic board game to a wargame with hundreds of
counters.

Open the page → pick a nickname → you're hosting a room → **Copy invite**
(or show the invite as a **QR** code for phones to scan) → friends open the
link, pick their nickname, and everyone plays on the same live table. A
brand-new table asks the host *What are we playing?* in a slim strip along
its top edge (never a pop-up; once friends sit down it shrinks to a 🎲 chip
in the corner, clear of their seats): one click starts Hold'em, Cards Against
Humanity, Bridge, **Chess**, **Go** (9 × 9 or 19 × 19), **Reversi**,
**Draughts**, **Backgammon**, **Dominoes**, **Veiled Ranks**, turn order or
a simple dealer, keeps the free
table, or opens the 📜 script editor; the **🎲 Games** button offers the
same picker any time.

The table is **round** (a game box can bring a rectangle: see *Pieces, dice
and boards*) and everyone gets a **seat** on the rim (host-assigned
into the largest empty arc, so two players sit opposite, a third between
them, …). Seat labels show every player's name and hand count at their spot,
and each player's view auto-rotates so their own seat is at the bottom —
opponents genuinely face each other. Each player also has a private zoom and
pan: scroll to zoom about the cursor, drag empty felt to pan, and on touch
screens a two-finger pinch zooms, rotates and pans in one anchored gesture;
🧭 resets everything back to the seat view. A big hand fans out so every
card's corner shows (a 13-card Bridge hand fits a desktop bar); on a phone, swipe the hand
sideways to scroll through it and drag a card upward out of it to play;
tap a card to enlarge it (Esc or a click closes the enlarged card and the
action buttons on a desktop). Cards you play or deal land
facing you, so your tableau reads upright to you and upside-down to the
player across, like a physical table. A circle makes all of this work:
rotation never changes how the table fits the screen (a rectangle turns in
quarter turns, and refits). The **host** can grow
the table (small / medium / large — a shared, logged change that keeps items
centered) when more players squeeze in.

A **table log** panel records every action for all to see — who drew, dealt,
played, flipped, shuffled, took a card into their hand — plus a chat box.
Hidden information stays hidden in the log ("drew a card", "played a card
face down"), but the *fact* that something happened is always on record,
which is the anti-cheat mechanism: you can palm a card, but everyone sees
you palm it. **Peek** follows the same rule — you can privately look at a
face-down card or a pile's top card (the host reveals it to you alone), and
the log announces to everyone that you looked. (A game's rules may close
their piles to peeking: Hold'em's deck and muck mid-hand, every CAH pile.)

The table *feels* physical: other players' drags glide instead of jumping,
dealt cards slide out of the deck, cards played from a hand slide in from
that player's seat, cards dealt or drawn into hands fly to their owner's
seat as card backs, and flips turn the card over (your own drag is never
animated). When a game's rules say it's **your turn**, the tab title reads
"⏳ Your turn", your seat label pulses, your hand bar gets an amber edge, a
short "Your turn" chip pops up at the bottom right of the table (just above
the hand bar, when there is one) and phones vibrate; a **win** rains emoji
confetti on every screen and buzzes the winners' phones. On touch screens,
**press and hold** a face-up card (or pile top) to read it full-screen; let
go to close. Drop a hand card onto a pile to put it on top. The **⇅** button
in the hand bar sorts your hand by suit and rank, on your screen only (the
choice is remembered). On a phone held sideways, game notices and the rules'
buttons move into the margins beside the round table, off the cards. With
*reduce motion* set in the OS, nothing glides, flips, pulses or falls — the
cues still show.

## Pieces, dice and boards

Beyond cards, the table holds **game pieces**: tokens, tiles, dice and
boards, from a *game box* (a few KB of JSON: the piece types, their faces
and backs, the table, the seats and the starting layout). Draughts and
Backgammon ship built in, art-free: pick them from 🎲 (on a table in use the
host is asked first — the table is cleared, and the rules switched off:
these are played by hand), and so do **Dominoes** and **Veiled Ranks**,
whose scripts start with them (see *Private material*); so does
**Hexfront**, a hex-map wargame skeleton with its turn script, set up from
📦 (see *Game boxes*). Pieces look like pieces — discs with a rim,
tiles, dice with pips, meeples, pawns, hexes — and a board's squares,
points, lines and coordinates (a–h, 1–8) are drawn crisp at any zoom. The
coordinates read upright for every player, as on a chess app's flipped
board: each stays by its file or rank, turned to face your screen (a
space's or zone's label only ever turns by a half turn: it never reads
upside down, and still runs along its space). So do the badges — a pile's
count and name, ×N, ∞, 🔒 — and a bag, and a pile's name always sits under
its pile on your screen; while two fingers turn or zoom the view they move
with the table, take the zoom's size when the fingers rest a moment, and
settle when they lift. A piece's own face (its
label, text, pips, art) stays as it lies on the table — unless its type is
marked `upright` (chess pieces are): then its label reads upright on every
screen too, so the player across the board never reads a knight upside
down. A face may also carry a `name`, never drawn, which the log uses when
it has no label ("turned Light disc to Dark disc on d4").

Playing on the free table:

- **Drag** a piece to move it. A **×N stack** gives you one piece per drag
  (drop it on a matching stack, its supply or a bag to put it there);
  **Shift+drag** — on a touch screen, **✥ Move all** in the piece's bar —
  moves the whole stack. A **supply** (∞) hands out a new piece per drag
  (Shift+drag, or **✥ Move** in its bar, moves the supply itself). Drop a
  piece on a **matching stack** (same type, face and owner) to add it, back
  on its supply to return it, on a **bag** to put it in, on a tile of the
  same size (or a pile of them) to pile them, on the hand bar to hold it (if
  it can be held). A full bag, pile or hand takes nothing: the piece just
  lands there. ✥ stays armed 5 s (its bar button drains as the time runs
  out).
- **Double-click** turns a piece over (or to its next face), takes one out of
  a supply or a bag, and **rolls a die** — together with every die touching
  it (side by side means one throw: backgammon's two dice, a handful of
  three). Every screen sees the dice tumble.
- **Click** a piece for its bar: Flip, 🎲 Roll, ⟲ ⟳ (not on a die, nor on
  a plain round piece — a checker looks the same at any angle; an oval
  doesn't), ✂ Take 1, ✋ Hand,
  🔒 Lock, 👤 Claim / Release (and the host's Give ▸), 🗑. Keys, with a
  piece selected: **R** / **Shift+R** rotate, **F** flips, **Space** rolls,
  **Delete** removes, **Esc** deselects (a held key acts once). On a touch
  screen, press and hold a piece to read its face. The bar always matches
  the moment: when a seat changes hands, a seat-bound piece's bar changes
  with it.
- **Owners and locks.** A piece can belong to a player or to a seat (a
  coloured dot, shown on the selected piece or under the mouse, so a board
  full of men isn't covered in dots; draughts men belong to the Light and
  Dark seats, so they follow whoever sits there). A **locked** piece stays
  put; boards are locked from the start. Dragging something you may not
  move — locked, or someone else's — pans the view instead, so a board
  never gets in the way; the bar only ever offers what you may do. A tap
  on a board while a piece is selected only puts the piece's bar away (tap
  again to select the board). Badges (×N, ∞, a pile's name, the owner's
  dot, 🔒) and the selection ring grow on a table drawn small, so a phone
  can read them, and a board's coordinates grow a little too, as far as
  their margin holds; the table's notice ("The host left — …") stays the
  same size on the screen, whatever the zoom, on a plate that fits
  between the seat labels beside it.
- **Snapping.** A piece dropped on a board's squares, points, hexes or
  spaces snaps to the one in reach and sits centred on it: draughts men on
  their squares, a checker on its backgammon point, a stone on a go
  point. While you drag one over a board, a dashed outline shows where it
  will land, and a chip by your finger names the spot — **e4** (chess
  squares), **D4** (go points), **3,4** (other grids), **2,-1** (hexes),
  **p6** (a space). Spots on a game's main board read bare; on another,
  with its name first (*map:c3*, or *tray#2:bar* for the second tray). The
  log says where pieces went ("Alice moved Light man c3 → d4"). Moving a
  board moves nothing else: the pieces stay where they are, and know their
  new spots. Cards, piles, supplies, bags and dice never snap (a die set
  down on a backgammon point stays where it lands).
- **Pieces sharing a spot fan out** so each shows: a backgammon point's
  checkers line up from its base toward its tip, squeezed together when
  many (15 on one point still fit inside it), and so do the bar's (from its
  top end) and the trays'; elsewhere they step up a little. The top one
  carries an amber **×k** (how many are there); a tap or a drag on the
  crowd takes the top piece you may move — with a checker of each colour
  on the bar, each player takes their own. A piece left off a spot's
  centre (a board moved under it, a table saved before snapping) is drawn
  where it lies, and counted, and a press on it takes that very piece —
  until a piece is put on that spot: then the spot fans them all, so none
  hides another.
- **Several at once.** **Shift+drag** on the felt — or on a board, which
  counts as felt (a plain drag still pans) — draws a box: every piece drawn
  inside it is picked, up to 200; **Shift+click** picks one more, or puts a
  picked one back. On a touch screen, tap **⬚** (the table's bottom-left
  corner): then one finger draws the box — wherever it starts, but on a
  picked piece, which carries the lot — and a tap picks a piece or puts it
  back (a quick second tap puts it back: it never flips or rolls anything).
  Only what you may move is picked — never a board, nor anything
  locked or someone else's: a chip says how many were left out ("3 not
  selectable (locked or someone else's)"). The picked pieces wear the
  selection ring; drag any one of them and they all go, together — the
  others see them glide, one message every 60 ms however many there are —
  and land each on its own spot. While you pick, their bar docks where no
  piece is drawn, in one row (**✕** first, then the count; wider than the
  screen, it scrolls sideways by a swipe or the mouse's wheel, an end
  faded while more lies beyond; a list it opens or "Remove 8?" comes into
  sight, then the row goes back where you left it) — along the top of the
  table, or, when pieces lie
  there, in the toolbar's place (✕ brings the toolbar back) — so it never
  covers a piece you are about to pick: when a piece, anyone's, comes into
  its strip, it moves out of the way, and wherever it appears or moves to,
  its buttons wait a moment before they take a tap. It acts on
  them all with one action each: **⟲ ⟳** (by the
  largest turn step among them), **Flip**, **🎲 Roll** (their dice, as one
  throw, 20 at most), **🔒 / 🔓**, **👜 Into bag ▸** (the bags on the
  table; only pieces go in), **🗑** (more than five ask first: "🗑 Remove
  8?"), and **✕**; so do **R**, **F**, **Space** and **Delete**. **Esc**, a click on the felt, ✕ or
  ⬚ off clears them. One action for the lot means one log line ("moved 8
  items", "rolled 3 dice: 4 · 1 · 6"), and one notice for the members the
  table or the rules refused ("2 of 8 were skipped: That belongs to Bob").
- **What's in a stack or on a spot.** Tap a stack's **×N** (on a touch
  screen, press and hold the stack), a crowded spot's **×k**, or **⋯
  Inspect** in a piece's bar: the **inspector** opens beside it — for a
  stack its face (its back, when hidden), the count, **Take [k]** with a
  stepper (k pieces off, set down beside it) and **Take all** (arms ✥: the
  next drag carries the whole stack); for a crowded spot its pieces, the
  top one first, each with its face, name and owner's dot — tap one for its
  bar, or drag it out of the list. It follows what it shows as the table
  changes, and closes on Esc, ✕ or a tap outside it.
- **Live drags.** While someone drags a piece, everyone sees it glide; the
  table itself only changes when they let go (the drop is the one move, so
  a rules script judges only the drop).
- **Hidden pieces** show only their back, to everyone: nobody's screen, not
  even its traffic, learns what a face-down tile or a bag holds. A box's
  pieces and its `meta` data are public, though — anyone at the table can
  read them (rules scripts read `t.type(…).meta`): never put a secret there.

**Tables and seats.** A game can bring a **rectangular** table (draughts
1000 × 1360: taller than wide, so a phone held upright draws the board
large): it fits the screen whichever way it turns, and each view turns
in quarter turns so the player's own edge is at the bottom. The host's size
menu shows it (▭ 1000 × 1360); picking a round size switches back, after a
confirm. A new game starts everyone's view afresh, as 🧭 does: a box set
up or reset, a rules game starting, named seats set or ended, or a new
table shape or size (Chess, Draughts and Reversi share one size). A game can also name its **seats** (Light and Dark): players take
them in order, the rest **watch** (👀 top right, with how to sit — or that
every seat is taken; on a phone held sideways two small chips, "👀 2" and
"👀 Watching", that a tap opens for a few seconds). Tap a seat label for its
menu — *Sit here* on a free seat, *Stand up (watch)* on your own; the host
also seats players and moves them to the watchers, and *End the named
seats* goes back to ordinary seating, where every watcher sits (a label is
a button for the keyboard too: Tab, then Enter). A card game from 🎲 —
Hold'em, Cards Against Humanity, Bridge, the simple dealer — started over a
board game clears the table and ends its named seats, after a confirm, so
everyone is dealt in. An offline player's seat waits for them. With
ordinary seating, a watcher taps **Sit down**. A guest
that loses the host for a minute reloads itself, as one that never found
the host does.

**The hand bar hides** on a table with nothing to hold (draughts,
backgammon) while your hand is empty, so the board gets the whole screen;
it comes back as soon as something that can be held is on the table.

## Private material

A piece whose type has a back can lie face down for some players and face up
for others: dice under a cup, tiles on a rack, units behind a screen. Who
sees it travels with it — a player, or a seat and so whoever sits there —
and every other screen gets its back alone, in every message, the log
included ("Alice hid 3 pieces", "rolled 2 hidden dice": never what they are).

- **Hiding.** Select a piece with a hidden side and press **🙈 Hide** (or
  **H**; several at once from the group bar): it turns its back to everyone
  but you. On your screen it stays face up, with **🙈** on its corner and
  that corner faintly hatched — "Hidden from the others: only you can see
  it", says its tooltip. A piece you hide is yours until it is revealed:
  nobody else may turn it over, roll it, set its face, take it into a hand
  or claim it — nor put it where it would show them, or lose who sees it:
  onto a pile, into a bag, onto their own rack — and the refusal is the
  same whatever it is ("🚫 That piece is hidden"). While you drag a hidden
  piece of yours, the others see it only where you set it down.
- **Dice under a cup.** 🙈 Hide on a die cups it with the dice touching it
  (as 🎲 Roll throws them together; one locked in place stays out). The
  built-in dice — Backgammon's, Hexfront's — wear a cup. Roll them under the cup: everyone sees
  the cup shake, you alone see the faces, and the log says "rolled 3 hidden
  dice" — or, rolled with dice in the open, their values alone ("rolled 4
  dice (2 hidden): 3 · 5"). **Reveal** (or **F**) on one lifts the whole cup:
  its dice show to everyone.
- **Racks and screens.** A board can carry a private zone: a **rack** or a
  **screen**, hatched in its owner's colour and labelled "🔒 Alice's rack"
  ("🔒 Your rack" on your own screen; "🔓 Nobody's rack" while its board
  has no owner, when it hides nothing). Whatever is set down in one hides
  for its owner — and is theirs, unless it already belongs to someone. A
  zone never shows anyone a piece hidden from them: a piece hidden for
  someone else goes onto your rack only from a hand that sees it (handing
  a tile over), and behind a screen it stays theirs alone. A tile taken off
  a rack is played face up; a unit moved out from behind a screen stays
  hidden until it is revealed. A bag's **🔒 Draw to my rack** draws a
  piece straight into the first free slot of your rack, so it is never seen
  face up on the way (the slots full, it lands half a slot on, where it
  hides least of what lies there: Dominoes' rack holds a whole draw game,
  21 tiles, none more than half covered, but a rack too small for what it
  holds has to cover some; a piece with no hidden side lands there face
  up). In a box, a rack is a board's zone — a polygon in the board's own
  units — with `"private": "reveal"` (a screen: `"keep"`) and `"owner":
  "board"` (the board item's owner: `"owner": "seat"` in `forEachSeat`
  gives each seat its own) or `"seat:<id>"`, as in
  `{ "id": "rack", "kind": "board", "w": 700, "h": 120, "zones": [ { "id":
  "slots", "poly": [[0, 0], [700, 0], [700, 120], [0, 120]], "private":
  "reveal", "owner": "board", "label": "rack" } ] }` (the whole field list
  is under *Game boxes*); its label stands beside it on the side of the
  table's middle, so leave it room there, clear of the seat labels at the
  table's edge.
- **Peeking.** **Peek** at any piece hidden from you — someone's rack tile,
  a cup — shows you its face alone ("Only you can see this — everyone knows
  you peeked"); the log says *that* you peeked. A game's rules may forbid it.
- **Seats.** A piece hidden for a seat is seen by whoever sits there: stand
  up, and its back is all you see; the next player there sees its face.
- **Exporting.** An exported game keeps it all: a cup's dice stay cupped
  for the same player, a screen's units that left it stay hidden, a rack's
  tiles are hidden again by their rack when the game is set up, and what a
  zone wouldn't give back as it is — a unit standing in the other side's
  rows, one revealed behind its own screen — is written as it lies
  (`"unzoned": true`). Someone who sees a piece but isn't seated can't be
  written: it goes hidden from everyone, never shown.
- **Rules that refuse.** A game's refusal of a move of your own hidden
  piece is yours alone — the others get no "blocked" line and don't see
  which piece you reached for, since its words may name it ("The Banner
  never moves").
- **In the terminal**: `hide <id…>`, `reveal <id>` and `peek <id>` (see
  [Terminal bridge & bots](#terminal-bridge--bots-clijs--clipy)).

Two built-in games are made of it (🎲, or 📦's Built-in section; their
scripts start with them):

- **Dominoes** — the double-six set and the draw game for two, South and
  North. Each seat has a **rack** in front of it, two rows of nine:
  whatever lies on it is yours alone to see (🙈 on each tile), and a tile
  you take off it lands face up for everyone. A hand that grows past 18
  (draw the whole boneyard: 21) still shows every tile at least half. **Draw 7** fills both racks from the boneyard, and
  a player drawn by lot leads (then the lead goes round). On your turn,
  play a tile out of your rack onto the line — that passes the turn — or
  draw (the bag's **🔒 Draw to my rack** drops it straight into a free slot
  of yours) until you can; **⏭ Pass** once the boneyard is empty.
  Emptying your rack is a domino (🏆); at a domino or a blocked line every
  rack shows its tiles, for the count. Nobody peeks at a hidden tile;
  nobody but the player to move plays or draws; a tile leaves a rack only
  as a play — never turned over there — and only its own seat moves it.
  The turn belongs to a seat: someone who takes it over mid-round plays
  on. Which ends match, the spinner and the score are
  yours to keep, as at a kitchen table; **♻ New round** gathers every tile
  back into the boneyard.
- **Veiled Ranks** — an original game of hidden units for two (South and
  North) on a 10 × 10 field: capture the other side's Banner. Each side's
  twelve units — Banner (⚑), Crown (rank 4), two Blades (3), three Pikes
  (2), two Lancers (1»), a Herald (1✉) and two Traps (✕) — lie face down for the
  other side, behind **screens** on its three home rows, dealt out at
  random so no square tells which is which. **Deploy** by dragging your
  units within your rows (onto one of yours, the two swap), then
  **✓ Ready**; once both are, South moves. A turn is one unit one square
  along a rank or a file — a Lancer one or two, its first square empty; the
  Banner and the Traps never move. Picking a unit up shows where it may
  go. Moving onto an enemy attacks it: both are revealed for good, the
  higher rank stays and the lower is removed (both, if equal); a Trap takes
  its attacker with it; a **Herald parleys** — both revealed, nothing
  removed, the Herald back where it was. Every outcome is announced on
  every screen. A unit keeps how it is seen wherever it goes: a hidden one
  stays hidden in the other side's rows, a revealed one shown in yours.
  Take the Banner, or leave the other side no move, to win (neither side
  able to move is a draw): then every unit is turned over, and
  **♻ New game** deals new armies. The script enforces it all (a strict
  script: nothing else moves, and nobody peeks).

## How it works

Built on the stack mapped out in [`../mdmath/COLLAB-DESIGN.md`](../mdmath/COLLAB-DESIGN.md):

- **Code**: no build step — the page loads plain ES modules. `core.js` is
  the table's state and every operation on it (dealing, shuffling, the
  public view, the deck sanitizer, the rules engine and its `t` facade) with
  no DOM or network, so the page and the Node tests run the same code;
  `store.js` is storage (IndexedDB) and image checking; `grid.js` is board
  geometry (cells, hexes, addresses like `e4`); `pieces.js` draws pieces,
  bags and boards (a board's structure is one SVG built from numbers only);
  `boxio.js` reads game boxes in (`game.json`, zips, their images) and
  writes the table out as one; `app.js` is the network, rendering and input
  around them, `templates.js` holds the shipped rules scripts and game
  boxes, and `rules-worker.js` is the Web Worker a rules script runs in (on
  a copy of the table built by the same `core.js`). The implementation
  contract the code and the tests cite — its sections (`spec §3f.4`) and
  its numbered decisions (`D282`) — is [SPEC.md](SPEC.md).

- **Transport**: Trystero WebRTC, signaling over public Nostr relays — no
  server, no accounts. The room id + password live in the invite link's hash
  and never reach any server. `window.CARDTABLE_RELAYS` overrides the relay
  list (used by the tests, which run a tiny local NIP-01 relay).
- **Host as authority** (§3.1 of the design doc): the room opener's tab holds
  the authoritative state. Guests broadcast actions; the host applies them and
  sends each guest a personalized view — the public table, everyone's hand
  *counts*, and that guest's own hand. The public table is redacted: piles
  travel as a count plus their top card (just its back when it's face down)
  and face-down cards without their identity, so deck order and hidden
  cards never leave the host. Bare actions + host-authored deltas, no CRDT:
  state is single-writer.
- **Delta sync**: the host records what each action changed (core.js dirty
  sets) and, on a 40 ms broadcast tick, serializes one patch with just those
  items, players and log lines; each guest gets it spliced with its own
  fields (its hand, when that changed), signed and bound to its connection.
  A guest that arrives, reloads or re-registers gets a full snapshot
  instead. Patches are numbered per guest (each one says which seq it
  builds on), so a guest never applies one out of order: a stale one is
  ignored, and a gap (a lost message) makes it ask for a fresh snapshot (at
  most one per 3 s, and again every 3 s until it arrives; shown as
  "re-syncing" in the status tooltip). A guest's states go out one at a
  time, so a small patch never overtakes the big snapshot before it; the
  decks, game boxes and rules code take the same line, a newcomer's whole
  catalog just ahead of its first snapshot (held, unread, until that
  snapshot shows who hosts), so its first look at the table already draws
  every face. A
  refused or vetoed action (or one whose target had just vanished) re-sends
  the items it named and the actor's hand, so an optimistic drag snaps
  back. A guest whose connection stops draining doesn't pile up a backlog
  on the host: past 64 waiting states they are dropped, and it gets one
  fresh snapshot once it drains. A 1,000-card table costs a few hundred
  bytes per move, and every screen — the host's own included, through the
  same path — redraws only the items that changed.
- **Versions**: actions carry the wire version and host messages declare
  it; a peer on another version of Card Table is refused instead of
  misreading the table, and told which page must reload: an older guest
  "reload this page"; a newer one that the host's page is older ("ask the
  host to reload it"), while the host is told a player has a newer Card
  Table; a second hosting tab of another version, to close or reload it.
  Every module import carries the code version (`core.js?v=1`, and
  `style.css?v=1`), and the page stops with a "reload" banner if a cached
  module of another version slipped in, or a cached page of the previous
  Card Table runs this script; a rules Worker of
  another version refuses to start ("reload this page to run rules") —
  on a host's reload, the saved rules stay on in the save, so that reload
  runs them again.
- **Identity**: players get a persistent random id in `localStorage`, so a
  reloaded guest reclaims their hand (WebRTC peer ids change per page load).
  Every guest action carries that id + nickname, and the host registers the
  sender on *any* action — so a lost join handshake can't permanently mute a
  guest. Until a state addressed to it arrives, a guest repeats its hello
  every 3s, and the host answers each with a snapshot (at most one per 3s),
  so a lost answer heals even on a quiet table. A connection registers one
  player for good (a page that leaves and joins again under a new id is
  refused), a seat key is 16 to 64 characters, and the table takes new
  players 20 at once, then one every 3 s: the host's save keeps every
  player's key, so nobody can grow it at will. The rest keep knocking and
  get in in the order they first knocked (a connection that stops knocking
  for 9 s, or leaves, loses its place), so fresh connections knocking
  faster can't keep a newcomer out.
- **Signaling health**: public Nostr relays are best-effort, so the status
  dot shows the truth — green with a player count when peers are connected,
  `● …` while searching, red `● ✕` when zero relays are reachable. A watchdog
  recovers from dead signaling (or a guest that can't find its host, or
  has lost it for a minute — a link to a returning host that never forms
  would otherwise freeze its screen) by auto-reloading with backoff (20s doubling to 2 min, persisted in
  this tab's sessionStorage for the room, read only by the page that reload
  opens, however long it takes to load, and kept until the guest is back
  with its host; its 20s, like the hint's grace for the relays, count from
  when the page joins the room, not from a first visit's name dialog), with a notice that
  names the cause — our own relays first (with no peers and no relay, it
  never blames the host), then no host yet, or how long the host has been
  away; the table's hint says the same ("Connecting…", "Can't reach the
  signaling relays", "Connection lost", "Waiting for the host…", "The host
  left") — a reload is the reset that provably clears wedged relay
  subscriptions, and it's safe here because the host resumes from its save
  and guests re-enter with identity and hand intact. A guest that had the
  table keeps it across that reload (the view and the decks and boxes it
  draws with, and when it last saw the host, in this tab's sessionStorage,
  checked again on the way back in), so a host who simply left still
  leaves everyone the last table, paused, until they return. Relay redundancy is
  raised to 10 (default 5) so two peers are more likely to share a live one.
  Trystero 0.25.3 keeps 20 ready-made WebRTC offers per page and re-offers
  one older than a minute by an ICE restart that first rolls it back, which
  in Chromium and WebKit (Safari, every iOS browser) empties it (no data
  channel, no ICE credentials; Firefox keeps it): whoever answered never
  linked — half the guests joining or reloading into a room open for a
  minute. `connect()` hands Trystero a peer connection whose rollback of an
  offer never answered does nothing (`WholeOffers`), so the restart
  re-offers it whole. Trystero 0.26 skips that restart's rollback itself;
  `WholeOffers` skips every rollback of an unanswered offer, so an offer
  that collides with ours is left to `setRemoteDescription`, which rolls
  ours back implicitly.
- **Log**: the host authors log entries while adjudicating actions (it's the
  only peer that can name cards trustworthily), keeps the last 200 actions,
  the last 50 peeks and the last 100 chat lines and renames in state
  (separate caps, so neither chatter nor a flood of moves can push the
  record of a peek out), and sends new entries inside the patches (every
  peer trims with the same rule, so all copies agree); repeated drag/rotate
  entries collapse so moves don't flood it, and a guest may chat or rename
  at most 5 times per 5 seconds.
- **Flood control**: the host is the only authority, so a guest's action
  burst could freeze the table for everyone: each guest may send a burst
  of 40 actions, then 20 per second (more are dropped, and they're told to
  slow down) — a group of many items costs more, and under a rules script
  with a large state more again, past the burst too (the sender then waits
  it out) — and the decks guests add share one 1.5M-char budget per
  table (saved with it), so nobody can fill the host's browser storage.
  Card and deck names lose their control characters on the way in. An
  action nested deeper than 64 arrays or objects is refused at the door
  ("Malformed action"): copying it to the rules Worker would overflow the
  stack, and a peer could switch the host's rules off with it.
- **Persistence**: the host saves the table in IndexedDB (`store.js`,
  database `cardtable`): the state at most once a second (and a quarter
  second after the move that asked, never in its own burst of work; a
  page's first save at once), one write at a time, as a structured clone (a few ms on the main thread for 1,000
  cards), and each deck once, into the room's catalog, in the same
  transaction (its images just before, so the catalog never names an image
  the browser lacks). Reopening the invite link in the host's browser
  resumes the game; a save from before IndexedDB (localStorage
  `ct-save-<room>`) is moved over on its first resume, images included, and
  its keys are removed only once the new storage holds it all (or a later
  table of the room); until then a reload after failed saves resumes that
  old save, saying the last one was lost, rather than a fresh table. When storage
  is full, the image cache gives way first (images no table needs, least
  recently used first: they download again), then other rooms' saves,
  oldest first, with their images (with a toast saying so; saves another
  tab wrote in the last 30 s are spared, and none are deleted when the
  table wouldn't fit even then); if the table still can't be saved, the
  stale save is replaced by a "lost" marker (its decks go too), so a reload
  resets the table loudly instead of silently rewinding it (as does a save
  record that holds no table, its decks dropped too). A save the tab
  can't even read at start is never written over: the tab hosts by its host
  key, saves nothing, and says to reload. A rules script that leaves
  something that isn't JSON in `t.data` (a function) loses its rules, not
  the save. A tab that closes,
  or is hidden (a phone switching apps may never wake it again), saves at
  once (a hidden tab lives on, so its save still waits for one in flight;
  only a closing tab starts its own beside it). A write started as the tab
  goes away may never land — in Safari and every iOS browser it never does
  — so the tab also leaves what it meant to save in localStorage
  (`ct-pending-<room>`: the whole table, when it names no deck or box the
  saved catalog lacks and fits in 2 million characters, else its move
  number), and the next
  start resumes from it, or, with the number alone, says "the last moment
  of play before the reload wasn't saved". Any page's upkeep, a few
  seconds after it starts, removes what no start needs (the room's save
  holds it, as it does wherever the write landed after all, or the room
  has no table saved), and cuts a table left more than a day ago to its
  move number: localStorage is shared by every app of the site. A save the previous Card Table
  wrote after this one moved the table to IndexedDB (a tab of it left open
  across the deploy) is newer: it is resumed, and said so, never dropped;
  one that holds no table (that tab's own save failed, the browser's
  storage full) leaves this table as it is, resumed with a warning. A browser that blocks IndexedDB runs the table unsaved, and
  says so (no fallback); it still hosts its room after a reload, by the host
  key. A save written by a newer Card Table (a tab left open across a
  deploy) is never resumed or overwritten: the older tab says "reload this
  page" until it does. Each host start is a new state epoch, so guests
  follow a restarted host even when its counter restarts lower. If two
  hosts ever collide (stale resume, invite opened twice in the host's
  browser), the one holding older state demotes itself to guest.
- **Decks and images**: the standard 52-card deck renders as DOM/CSS; custom
  decks are uploaded images, downscaled client-side to ≤560px WebP. A deck
  names its images by **content hash** (the SHA-256 of their bytes), and the
  bytes travel apart: every peer keeps them in an IndexedDB cache shared by
  all its tables, and a guest asks the host only for those it lacks, so a
  player who has seen a deck downloads nothing on a rejoin, and one who
  uploads a deck never downloads it back. The host sends only images of the
  table at hand (never another room's), a few at a time per guest and after
  that guest's pending moves, so play stays live during a big download,
  and at most 64 MB a minute per player — all their tabs and reconnects
  share it — and 256 MB a minute to everyone: a bigger table's images come
  over more than one minute (the guest is told they come slowly). A deck is
  checked and hashed in slices, between which everyone's moves go on, and
  its images are kept only once it is on the table: a deck the rules or the
  budget refuse leaves nothing in the host's browser (a guest's decks are
  taken one at a time, and those waiting count against the budget). Every image is checked before any peer
  stores it: PNG, JPEG, WebP or GIF by its magic bytes, at most 2 MB, at most
  4,096 px a side and 16 Mpx in all — read from its header, so a tiny file
  that declares a huge picture is refused before anything decodes it — and,
  from the host, matching its hash. An image that doesn't come (the host
  lost it, or it arrived damaged twice) shows as a struck-out picture, with
  a notice. Unused cached images are deleted after 14 days, and a guest's
  cache is capped at 500 MB. Decks themselves travel once per player, as
  per-deck deltas, so adding a second deck never re-ships the first.

## Custom decks for custom games

Uploaded cards are **named after their files** — `dragon_rider.png` becomes
"dragon rider" — so the log can say *played dragon rider* instead of
"MyDeck #7". For full control, include a **`deck.json`** manifest in the
same file picker as the images:

```json
{ "name": "My Game", "back": "back.png",
  "cards": [
    { "file": "dragon.png", "name": "Ancient Dragon", "count": 2,
      "meta": { "cost": 5, "type": "creature", "power": 7 } },
    { "name": "Gold", "text": "Worth 1 coin", "color": "#eab308", "count": 20 }
  ] }
```

- `name`/`count` control display and copies; each image is stored **once**
  (cards reference a shared image table), so 20 copies cost the bytes of one.
- A card without a `file` renders as a **text card** — name, rule text, and
  an accent color drawn in DOM/CSS like the standard deck. A manifest-only
  deck needs no art at all and weighs a few KB, the fastest way to prototype
  a game.
- `meta` is free-form JSON the app never interprets: rules scripts read it
  via `t.card(ref)` (→ `{name, rank, suit, text, meta, deck}`), so a script
  can enforce `meta.cost` or `meta.type` instead of parsing card names.
- `back` names an uploaded image to use as the card back (the separate back
  picker still works and wins if both are given).
- `r` and `s` (a rank `A`…`K` or `JOKER`, a suit `♠ ♥ ♦ ♣ 🃏`, and `c`, `"r"`
  or `"b"`, its colour) make a standard card; an exported game writes a
  standard deck so.
- Fail-loudly validation: bad JSON, a `file` that matches no uploaded image,
  or an entry with no `file`, `name` or `text` abort the upload with a
  visible error. Uploaded images the manifest doesn't mention still join the
  deck, filename-named.
- Every image is checked by its header first (a PNG, JPEG, WebP or GIF by its
  real bytes — an SVG named `.png` is refused — at most 4,096 px a side),
  then redrawn at most 560 px on its long side as WebP (JPEG or PNG where the
  browser can't write WebP, as Safari may not) and stepped down to fit 2 MB.

## Game boxes

A **game box** is a whole game in one upload: its table, seats, boards,
pieces, dice, decks, starting layout and, optionally, its rules. The **📦**
button (next to 🎲) lists the boxes on this table — each with its size, who
added it and 📜 when it brings rules — the built-in ones (Draughts,
Backgammon, Hexfront, Dominoes, Veiled Ranks), **Upload a game…**, and, for
the host, **Export this table**.

**Hexfront**, the built-in demo (original, generated from a fixed seed, so
it is the same box every time), is a hex-map wargame skeleton for two:
Azure (bottom) against Ember (top) on a 24 × 16 map — a river with three
fords, woods, hills, eight towns — with 400 counters in 40 ×10 stacks
(infantry, armour, artillery, scouts; flip one to its reduced face for a
lost step), two dice and 24 event cards. Its turn script keeps the turns:
the side to play moves, splits and joins its own stacks, then **⚔ To
combat** — the dice, and losses each side takes on its own units — and
**⏭ End turn**; one event card a turn — drawn, or dealt out and taken up
— for the side to play alone. The rest — what a
roll means, what an event does — the players settle, as on a kitchen
table. Built in, its rules start with it: no trust dialog. Laid out
without them (unticked, or a Reset after they were switched off), its
face-down event cards are shuffled all the same, as every built-in box's
are: everyone can read their order in the source.

**The format** is a `game.json` (the one of [TABLETOP.md](TABLETOP.md) §4, a
little extended), uploaded with its images and its `rules.js` — picked
together, or as one **`.zip`** of them:

```jsonc
{
  "name": "Harbor Run", "players": [2, 2],
  "table": { "shape": "rect", "w": 1600, "h": 1100, "felt": "#1d4e5f" },
  "seats": [ { "id": "red", "name": "Red", "edge": "bottom" },          // optional: named seats (without them,
             { "id": "blue", "name": "Blue", "edge": "top" } ],         //  every player gets a seat of their own)
  "backs": [ { "id": "hold", "color": "#5b3a1e", "label": "?" } ],     // or "img": "back.png"
  "pieces": [
    { "id": "harbor", "kind": "board", "img": "board.png", "w": 600, "h": 400,
      "grid": { "type": "square", "cols": 6, "rows": 4, "cell": 100, "labels": "chess" } },
    { "id": "boat", "kind": "token", "w": 70, "faces": [ { "img": "boat-red.png" }, { "img": "boat-blue.png" } ] },
    { "id": "crate", "kind": "token", "w": 44, "img": "crate.png", "back": "hold" },
    { "id": "d6", "kind": "die" }
  ],
  "decks": [ { "name": "Tides", "back": "#0e3a4a",
               "cards": [ { "file": "calm.png", "name": "Calm", "count": 2 }, { "file": "storm.png", "name": "Storm" } ] } ],
  "setup": [
    { "piece": "harbor", "at": "center" },
    { "forEachSeat": [ { "piece": "boat", "at": "seat", "owner": "seat" } ] },
    { "piece": "crate", "at": "c2", "up": false },
    { "pile": [ { "deck": "Tides", "i": 0 }, { "deck": "Tides", "i": 1 } ], "at": [1380, 760] },
    { "hands": { "#1": [ { "deck": "Tides", "i": 2 } ] } }
  ],
  "rules": "rules.js",
  "meta": { "goal": "Bring three crates home" }
}
```

- **Pieces** are a list: a type's `id`, its `kind` (token, tile, die,
  board), size, `faces` (each a colour, a label, text, pips or an `img`, a
  file of the upload; `img` alone is the one-face shorthand) and its `back`
  (the face a hidden piece shows). A board carries its `grid`, `spaces`,
  `zones` and `links` (every field is in the reference below). **Decks** are
  `deck.json` manifests (above), each named; a card's `count` makes copies,
  so the deck above holds three cards: Calm (0 and 1) and Storm (2). Every
  file a box names is relative to `game.json`; a game whose files lie in
  folders goes up as a `.zip`, or as its files picked together (each is then
  found by its own name, so two files may not share one).
- **The setup** lays the game out: a `piece`, `supply` or `bag`; a `deck`
  (a face-down pile of the whole deck, `"shuffle": true` to shuffle it), a
  `pile` of cards or pieces, a `card`; `forEachSeat` (each seated player's
  material, `"at": "seat"`, `"owner": "seat"`); `hands` by seat (`"#1"` is
  the first seated player clockwise from the bottom, or a named seat). Every
  entry makes what it names: a `deck` entry lays the whole deck, and a hand's
  card is one more copy — to deal from a deck, lay a `pile` of the cards the
  hands don't take, as above. `at` is `"center"`, `[x, y]` (a top-left
  corner), `"seat"`, an address on one of the box's boards (`"c2"`,
  `"harbor:c2"`), or `{ "board": "harbor", "at": "c2" }` (a board an entry
  before it places); with an address, `"off": [dx, dy]` sets a piece that
  far from the spot's centre, still on it (an export writes one a moved
  board left so), and with `[x, y]`, `"free": true` sets it down without
  snapping. `owner` may be `"seat:<id>"` or `"#k"`. A face-down piece may
  say who sees it, `"vis"` (a seat, `"#k"`, `"seat"` in `forEachSeat`, or a
  list of up to eight), with `"po": true` when its owner is the one its
  hiding gave it; `"unzoned": true` lays a piece out exactly as written, in
  a private zone too (an export writes it). In a `group` with
  `"shuffle": true`, the face-down pieces that share a back are dealt out
  among the group's places (an `id` stays with its place); they must look
  alike once dealt — the same `rot`, `lock`, `n` and `owner`, and all dice
  or none (a die never snaps, so a spot without its address would show
  one). A setup is
  checked whole before anything moves — a deck or seat it names, the
  players it needs, the room on the table — and happens whole or not at
  all.
- **`meta`** (at most 8 KB) is for scripts (`t.box(id).meta`), and **public**:
  every player can read it. So are a box's name, pieces and decks' names;
  its setup, rules and saved rules state never leave the host.

**Every field.** Sizes and places are table units (a card is 100 × 140); an
item's `[x, y]` is its top-left corner, an address centres it. A field not
listed is refused, naming itself ("pieces[2] («crate»): stack must be one
of pile, count, none"). The quickest way to a box of your own is to set up
a built-in one (Draughts, Backgammon, Dominoes) and *Export this table*:
its `game.json` is a worked example of most of these.

| `game.json` | |
|---|---|
| `name` | up to 40 characters |
| `players` | `[min, max]`, 1–99 |
| `table` | `{shape: "round", w: 1300 \| 1800 \| 2400}` or `{shape: "rect", w: 800–6000, h: 600–4000}`; `felt`: a colour |
| `seats` | up to 12 named seats: `id`, `name` (24), `color`, and one place — `edge` (`bottom`, `top`, `left`, `right`; the default `bottom`), `angle` (degrees, 90 the bottom) or `at` (`[x, y]`) |
| `lockable` | `"anyone"`: every player may 🔒 the box's pieces (else only the host) |
| `pieces` | up to 500 types (below) |
| `backs` | up to 50: `id`, a face (`color`, `label`, `text`, `img`), and the flags it shares with its types |
| `decks` | up to 50 `deck.json` manifests, each with its `name` |
| `setup` | up to 2,000 entries (below), placing at most 3,000 items (and the table holds 5,000) |
| `rules` | `"rules.js"` (or the script's text): at most 200,000 characters |
| `meta` | any JSON, at most 8 KB: public |

| A piece type | |
|---|---|
| `id` | 1–32 of `A–Z a–z 0–9 _ -` |
| `kind` | `token` (a disc 60 wide, stacks by count), `tile` (a 100 square that piles and goes in a hand, turns by 90°), `die` (56, faces 1–6) or `board` (`w` required; locked, below everything) |
| `name` | what the log calls it (40; the id by default) |
| `w`, `h` | 8–6000 (`h` is `w` by default) |
| `shape` | `rect`, `round`, `disc`, `hex`, `meeple`, `pawn` |
| `faces` | up to 64 (a die 2–100), each a face; `img` alone is the one-face shorthand |
| `back` | a back's `id`: the piece can lie face down, hidden |
| `stack` | `count` (identical pieces stack ×N), `pile` (a pile of tiles), `none` |
| `hand` | `true`: it can be held in a hand |
| `rotStep` | 0 (turns freely), 15, 30, 45, 60 or 90 |
| `upright` | `true`: its label reads upright on every screen (a chess glyph) |
| `meta` | any JSON, at most 2,000 characters: public |
| a board's | `primary`, `grid`, `spaces`, `zones`, `links` (below) |

| A face | |
|---|---|
| `color` | a colour (`#rgb`, `#rrggbb`, a name) |
| `label` | up to 8 characters, drawn large |
| `text` | up to 300, drawn small (lines kept) |
| `img` | a file of the upload |
| `pips` | 0–9, or `[a, b]` for a domino's two halves |
| `name` | what the log calls this face (40), when it has no label |

A face may be just a number or a text: `3` is `{label: "3"}`, and on a die
`1`–`6` are pips.

| A board's structure | |
|---|---|
| `grid` | `type`: `square` or `hex`; `cols`, `rows` (1–64), `cell` (8–400 units), `x`, `y` (its origin on the board); square: `snap` (`cell`, or `point` for go's intersections); hex: `hex` (`pointy`, `flat`); `labels` (`chess`, `go`, `xy`; hex `axial`); `draw` (`checker`, `lines`, `cells`, `none`); `colors` (two, for `checker`); `fills` (address → colour); `marks` (up to 64 addresses: go's star points) |
| `spaces` | up to 1,000 named spots: `id` (not an address of the grid), `x`, `y` (the centre, board units), `r` (how near a drop snaps, 4–400), `mark` (`dot`, `ring`, `tri`, `rect`, `none`), `w`, `h`, `dir` (`up`, `down`, `left`, `right`: where pieces sharing it fan), `color`, `label` (12) |
| `zones` | up to 100 areas: `id`, `poly` (3–64 corners `[x, y]`, board units), `label` (24), `color`, `private` (`reveal`: a rack; `keep`: a screen), `owner` (`board` or `seat:<id>`) |
| `links` | up to 4,000 `[spaceA, spaceB]` pairs: the routes of a map (`t.neighbors`) |
| `primary` | `true`: its addresses are the bare ones (`e4`); another board's say its type (`map:e4`) |

| A setup entry | |
|---|---|
| `piece` | a type's id; `f` (its face), `up: false` (face down; it needs a back), `n` (a ×N stack, 2–999, of a type that stacks by count), `count` (1–200 copies) `spread` `[dx, dy]` apart |
| `supply` | a type's id, `f`: an endless source of that piece |
| `bag` | a list of members — a type's id, or `{t, f?, up?, n?}` — at most 1,000 pieces; `name`, `hand: true` (it may hold pieces for hands only) |
| `deck` | a deck's name: a face-down pile of all of it; `shuffle`, `up`, `name` |
| `pile` | a list of cards `{deck, i, up?}` or pieces `{piece, f?, up?}` (of one size, stacking as a pile); `name` |
| `card` | `{deck, i}`; `up` |
| `hands` | `{"#1": [...], "<seat id>": [...]}`: cards and pieces dealt into hands |
| `group` | a list of entries; `shuffle: true` deals its face-down pieces' identities among their places |
| `forEachSeat` | a list of entries made once for each seat (`"at": "seat"`, `"owner": "seat"`, `"vis": "seat"`) |
| with any | `at` (see above), `rot` (degrees), `lock`, `owner` (`"seat:<id>"`, `"#k"`), `id` (8 hex digits: kept when free); a face-down piece's `vis`, `po`; `free`, `off`, `unzoned` |

**Zips and their limits.** A zip is read in the browser (JSZip, fetched from
the CDN the first time one is picked), within limits that hold whatever the
zip claims: the file at most 64 MB, at most 2,100 files, at most 64 MB
unzipped in all and 16 MB a file (600 KB for `rules.js`) — each file is
unzipped as a stream that stops the moment it passes what its entry
declared, so a zip bomb or a lying directory costs nothing. A path with `..`
or a leading `/` refuses the zip; macOS's `__MACOSX/` copies are skipped.
`game.json` sits at the zip's root or in its one folder. Every image is
checked by its header before it is decoded (a 30,000 × 30,000 PNG is
refused unread), then redrawn: at most 2,048 px for a board's images, 560 px
for the others, as WebP (JPEG or PNG without WebP), stepped down in quality
and then in size until it fits 2 MB — so nothing but a plain picture is
ever stored. A box's images add up to at most 48 MB. Every failure is said
in the dialog and a toast, naming the file or the field ("map.png: not a
PNG, JPEG, WebP or GIF image", "game.json: pieces[0].img names "gone.png",
which isn't in the upload").

**Set up and Reset** are the host's. *Set up* (on a box with a layout, or
with rules that lay the table out themselves) asks first what there is to
decide: that it clears the table, that the rules running now are switched
off (the game they ran is cleared away with the table, as 🎲 does), "Enable
its rules" (ticked), and for a box a guest added "Shuffle face-down piles"
(ticked) under "{Bob} added this box and knows its starting layout" —
whoever uploads a box knows the order of its face-down piles and which
hands go where, so the host's table shuffles them by default. A box with
rules and no layout is set up by its rules alone: neither "Enable its
rules" nor *Set up without rules* is offered for it (the terminal wants
`--rules`). With "Set up
now" ticked, the host's own upload is set up at once (a box of pieces alone,
with nothing to lay out, is only added). *Reset* (offered on the box set up
last, also after a reload, until the table is cleared — 🎲's games clear it)
lays it out again on a cleared table and, when its rules were running,
restarts them; other rules are switched off. A box its rules lay out has
no Reset while they are off (it would clear the table for nothing): *Set
up* starts them again. Guests may upload too, within
the 1.5 M-character budget they share with their decks; their box is only
registered — setting it up is the host's call. A strict game's rules (chess,
go, reversi) take no new boxes while they run: the dialog says so, and the
host switches them off in 📜 first (only a refusal the rules made says
so: a full disk is said as such). The same box uploaded twice is one box.

**Trust.** A rules script sees every hand and hidden piece and can reveal
them, so a box's rules never run without the host's click: before them, the
**trust dialog** — "«X» comes with rules written by its author, added by
Bob. … Enable the rules?" — offers *Enable rules*, *Set up without rules*
or *Cancel*. Both questions stand on their bottom edge, so *Cancel* lies
where the confirm's *Set up* was at any screen size, its buttons wrapped
or not, and every button wakes half a second after the dialog shows: a
double click — or a burst of taps — on *Set up* never enables the rules.
Only a built-in box (by its content, never by anything a box can claim)
skips it; the terminal's `setup <box> --rules` waits for the same click on
the page.

**Export and resuming elsewhere.** *Export this table* (the host's) writes the
table as a box: its boards, pieces and decks, and a setup of the position
as it stands — every item where it lies, with its id, face, owner (by seat,
or `"#k"`), pile order and bag contents, and each seated player's hand —
with, as ticked, the rules and their state (scores, hidden script data;
each seated player written as `"@#k"`). It is a `.zip` with its images
(`game.json`, `images/…`, `rules.js`), or a `.json` when there are none.
Upload it in another room and set it up with its rules: the k-th seated
player there takes the k-th place, ids are kept wherever they are free (a
script that stored a pile's or its box's id finds it), and play goes on —
a chess game mid-move, a Hold'em hand mid-bet. The file holds every hidden
card and piece: keep it as you would the game box itself. Exporting and
importing the same table again gives the same game: an image the browser
already holds is kept byte for byte.

## Scriptable rules (📜)

The host can write JavaScript that turns the free-form simulator into an
enforced, automated game — see [`ENGINE.md`](ENGINE.md) for the full design.
The engine is game-agnostic: a script object with optional hooks
(`setup` / `validate` / `onAction` / `onButton` / `onChat` / `onJoin` /
`onLeave` / `onTimer`) plus a facade `t` exposing every table primitive (deal, draw,
shuffle, flip, piles, hands, …), persistent scratch state (`t.data`),
broadcast UI state (`t.public`, e.g. the ⏳ turn marker), scripted buttons,
timers, and player messaging. `validate` can veto any gameplay action with a
reason (the actor gets a toast; the block goes in the log); everything a
script does is logged as the "📜 Rules" actor. A script can also build its
game from code — `t.newBox` (piece types, boards with grids and spaces,
text decks), `t.spawn` (a piece onto `'e4'`), `t.newBag`, `t.setFace`, … —
and read the board: `t.where(id)`, `t.at('e4')`, `t.neighbors`,
`t.distance`, `t.line`, `t.linked` (ENGINE.md, "Addresses and the spatial
helpers"). Every action tells it where a piece goes (`a.to`, `a.from`: "e4"),
and a run of its own placements or removals is logged as one line
("📜 Rules removed 12 pieces: D4, E4, …"). Live drags never reach a script:
only the drop does.

A script can own the rules outright: `handle(t, a)` sees every
gameplay action first and may veto it, let it through, or carry it out
itself (`return true`: a castling king also moves its rook); with `strict:
true` nothing happens that `handle` didn't take over, except the action
types listed in `allow` (sitting down always works). Hooks are atomic: a
veto, or a hook that throws, leaves none of the script's own moves behind.
It can ask one player a question (`t.ask`: options, a piece, a space, cards
from their hand, a number — answered through `onAnswer`, checked against
what was offered, and asked again after a host reload), highlight legal
moves for one player when they pick up a piece (`onSelect` → `t.hint`), and
keep private per-player data (`t.secret[pid]`). Each of these reaches only
its player, as a hand does. On their screen a question shows in a panel of
its own above the hand bar — option buttons, the pieces or spots it offers
outlined in violet on the table, the hand's cards as toggles with "Confirm
(k/n)", a number stepper — which never covers the table (it takes its room
from it) and folds to a "❓ Rules ask" chip (▾) but can't be dismissed; a
hint is a cyan outline on items and translucent discs on squares (a ring
round a piece standing there); a secret's text shows on a "🔒 For you" card
by the rules' buttons. While a script wants selections, tapping a piece (or
starting to drag it) tells it; in a strict game that tap shows no action
bar, whose buttons it would refuse, and the 📜 button's tooltip says
"strict".

Scripts run **on the host only** — guests receive data, never code — and
everyone can read the exact script being enforced (read-only view in the
Rules dialog). On the host a script never runs on the page: Enable starts a
**Web Worker** that holds a copy of the table, runs the script and every
action on it, one at a time, and sends back what each changed (Enable says
"Starting…" for that moment). A **watchdog** gives each action 4 s of the
host tab's visible time (a phone that hides the tab stops the clock): a
script stuck in a loop is stopped, the action dropped, and the rules
disabled, while the host's page stays responsive throughout (a player's
arrival or departure in flight is kept, never dropped; a crash is said to
everyone as "the script crashed", and its message to the host). Hooks must be
synchronous — an `async` hook fails, and so does `t` used from a promise
callback — and `t.schedule` is the only timer. Live drags are not
validated, only the drop. A script error disables the rules loudly rather than wedging
the game (an action whose `validate` crashed is blocked, not waved through);
rules, their state, and pending timers survive host reloads — and
re-enabling the same game after a fix or a Disable keeps its state (chips,
scores) unless the host ticks *Reset game state*. Switching to another game
discards the old one's state (the 🎲 picker asks first, and the log says so).
A script written for the earlier Card Table, where rules ran on the host's
page, that touches the page — `document`, `alert`,
`localStorage`, `setTimeout` — now disables the rules with a message saying
so: use `t.say` / `t.tell` for messages, `t.data` for storage and
`t.schedule` for timers (ENGINE.md, "Running in a Worker").
Templates ship for turn order (skipping anyone offline), full **no-limit Hold'em with chips** (stacks
on the seat labels, automatic blinds with a rotating button, turn-enforced
betting via buttons — Check/Call, Fold, and quick bets *Min raise*, *½ pot*,
*Pot*, *All-in* labelled with their amounts — or chat: `!bet 50`, `!allin`;
short all-ins don't reopen the raising, streets deal themselves when a round
closes, all-ins run out, and an automatic showdown returns an uncalled bet,
evaluates best-5-of-7, builds side pots, and pays each pot to the right
hands. Only online players are dealt in, and dropping out mid-hand folds you
unless you're back within 20 s; a busted player gets a *Rebuy* button (or
types `!rebuy`) between hands, `!blinds 5 10` is the host's, and only the
host can abandon a hand in progress, refunding every bet (pressed twice, so
a mis-tap can't); New hand deals from its own deck only, setting another
game's cards in a hand aside), **Bridge** (exactly four players online at Deal play the hand
— anyone joining later watches; a real chat auction — `!bid 1H`,
`!pass`, `!double`, dealer rotation, insufficiency checks — then enforced
turns and follow-suit, the dummy laid face-up and played by the declarer,
trump-aware trick resolution, face-down trick piles, scoring, and a 🏆 for
the winning side; if a player drops out, the hand waits for them, and
`!contract 4H <name>` lets the dealer or the host skip the auction; ⏳ is on
the declarer while the dummy's card is due),
**Cards Against Humanity** (the printed rules automated: a rotating
Card Czar flips a black prompt, everyone else answers face down into an
*Answers* pile, the answers come back out shuffled and anonymous in
numbered columns upright for the Czar, who crowns the funniest with 👉
buttons naming each answer; the result stays up a few seconds before the
next round; ⏭ *Skip Czar* moves on when the Czar is away; ⭐ Awesome
Points on the seat labels, PICK 2/3 prompts, discard
reshuffling, and first-to-the-goal wins (`!goal N`, the host's) — card texts ship in
`cah-cards.js`, CC BY-NC-SA from Cards Against Humanity LLC's free
print-and-play PDF), and a simple dealer that says when the deck runs short — all plain scripts on the public
API, demos of the engine rather than features of it. The CAH template also
shows how a script keeps a ~1600-card game light on the wire: the full deck
is registered once via `t.newDeck` (script-defined text decks), while only
small draw piles sit on the table — the rest waits as indices in `t.data`. The generic engine primitives behind
winners and bidding are `onChat` (scripts parse any chat command),
`t.announce` (banner to all), and `t.win` (🏆 seat markers via
`public.winners`, plus the confetti). Any script that sets `public.turn`
(one player, or a list) gets the your-turn alert for free — the Hold'em
player to act, the CAH answerers and then the Card Czar included.

Three board games own their rules outright, as plain scripts built on the
same public API (`strict` scripts that build their own board with
`t.newBox`, read the position from the pieces where they stand, and carry
out every move in `handle`): 🎲 starts each on a cleared table, with named
seats and a table shaped for a phone held upright.

- **Chess**: every rule. Pick a piece up and its legal squares light up
  (captures as rings); a drop the rules refuse says why ("That would leave
  your king in check", "You can't castle through check") and the piece
  goes back. Castling moves the rook too, en passant takes the pawn
  passed, and a pawn on the last rank asks its player what it becomes
  (♕ ♖ ♗ ♘). Checkmate crowns the winner (🏆, confetti); stalemate,
  threefold repetition, fifty moves without a capture or a pawn move and
  positions where neither side can mate any more end in a draw on their
  own (K+B v K+B with bishops on opposite colours plays on). Each player
  has *½ Offer a draw* (the other player is asked; a move lets it lapse,
  and the offerer's own move withdraws it, both players told so)
  and *🏳 Resign* (asked to confirm). The glyphs read upright for both
  players.
- **Go**, 9 × 9 or 19 × 19: drag stones from your bowl onto the points.
  Captures (one log line for the stones a move takes), suicide refused, ko
  (the position before the opponent's last move can't come back). *Pass*
  (said on every screen), *Resign*, and once both players have passed in a
  row, *Count* or play on: area scoring, komi 6.5. Tap a stone to see its group's
  liberties. 361 stones stay quick (a move at stone 300 costs the rules
  under a millisecond).
- **Reversi** (the 19th-century public-domain game): light on d4 and e5,
  dark on d5 and e4, dark first. Pick up your pile and the squares where a
  disc may go light up; a disc that outflanks nothing is refused, every
  line it closes turns over, the seat labels count each side's discs, a
  player with no move passes (it's announced), and the most discs win.

After a game, *♻ New game* (the players' and the host's: a watcher has
none) sets the same game up again. A check, a go pass and a declined or
lapsed draw offer show on the screen too — on a phone the log is out of
sight.

## Terminal bridge & bots (cli.js / cli.py)

Play from a terminal — or script a player. A browser tab can't listen on a
port, but it can happily connect out to one: `node cli.js <invite-url>` (or
`python3 cli.py <invite-url>`, both dependency-free) starts a tiny bridge
server on `127.0.0.1` and prints a URL. Open it in a tab and the tab pairs
with your terminal: it mirrors its view over (hand with indices, table,
players, live log, the face-up top of each pile) and executes commands it
gets back — `hand`, `play 2 --down`, `discard 0 [pile]`, `draw`,
`chat !bid 1H`, `btn pick0`, … Every command goes through
the exact same `act()` path as a click, so rules validation, the table log
and the anti-cheat record all apply unchanged. Two modes:

- **Controller** (default): the URL keeps your identity — the terminal
  drives *your* seat while the tab keeps rendering.
- **Separate player** (`--as BotName`): the URL carries `~as~Name`, so the
  tab joins as a brand-new player with its own identity slot (it never
  hijacks the room save, even in the host's browser). That tab is a bot's
  body; your script is its brain.

Game pieces have their own commands (both REPLs; `help` lists them):

| Command | Does |
|---|---|
| `roll <id…>` / `roll all` | rolls dice together (`all`: every die you may handle — at most 20 in one roll; with more, it says so and rolls none: name them) |
| `face <id> <f>` | turns a piece to face `f` (0, 1, …) — not a die: dice are rolled |
| `take <supply> [x y] [--hand]` | takes a piece from a supply (an id or its type's name) |
| `pull <bag> [x y] [--hand]` | draws a random piece from a bag (an id or its name) |
| `split <id> [n] [x y]` | takes `n` (default 1) off a ×N stack |
| `place <ref> <addr>` | puts a piece on a board's spot (`e4`, `bar`, `map:c3`), centred; a supply (an id or its type's name) hands out a piece there. An address no board has, or one several boards could mean, is said and nothing is sent |
| `bag <id> <bag>` | puts a piece into a bag |
| `lock <id>` / `unlock <id>` | locks an item in place, or frees it |
| `claim <id>` / `release <id>` | makes an item yours, or nobody's |
| `seat <id>` / `seat -` / `seat +` | sits in a named seat; stands up to watch; sits down again |
| `asks` | lists the rules' questions waiting for you: `❓ promo: Promote to [0] ♕ [1] ♖ [2] ♗ [3] ♘`, and for a pick what to answer (an item, a spot, hand cards, a number) |
| `answer <id> <value>` | answers one: an option's label (any case) or its number — a label first, so `answer bid 3` means the option labelled 3 where there is one —, an offered item's id, an offered spot (`g7`), hand indices (`0,3`), a number. The tab checks it first: what wasn't offered is said, and nothing is sent |
| `select <id>` | selects a piece, as a tap does: rules that want it answer with a hint. A select the host would drop (rules that take none, a piece hidden from you) is said as an error |
| `boxes` | lists the game boxes on this table: `[cd34ef56] Beacon Watch — 2 piece types · 📜 rules · a guest's upload · set up` (📜: it brings rules; "set up": the box set up last) |
| `setup <box> [--keep] [--rules]` | the host's: sets a box up, named by its id or its name; `--keep` keeps the table's items, `--rules` runs its rules — which, unless the box is built in, still wait for the host's click in the trust dialog on the page |
| `reset` | the host's: lays the box set up last out again (its rules restarted when they run; a box its rules lay out, with them off, is refused — `setup <box> --rules` starts them again) |
| `group <op> <id,id,…> [dx dy \| deg \| bag]` | one action on many items, as the group bar does: `move dx dy`, `rot deg`, `flip`, `roll`, `lock`, `unlock`, `del`, `bag <bag>`, `hide` (items and the bag by id or name); one log line, one notice for the members refused |
| `hide <id…>` | hides pieces from the others, as 🙈 Hide does: you alone see their faces, and they are yours until revealed (dice: a cup). A piece with no hidden side, one hidden already, or one you can't see is refused, and then none is hidden |
| `reveal <id>` | turns a hidden piece face up for everyone (a `flip`); a piece face up already is said, and nothing is sent |
| `peek <id>` | a face-down card, a pile's top, or a piece hidden from you: its face comes back to you alone (`peek: 3\|4 Bone`), and the log says *that* you peeked; a piece you can see is said at once, with no line |

New questions, a new hint (`💡 hint: e3, e4`) and a new `t.secret`
(`🔒 for you: …`) print as they arrive, the same text in both REPLs (the
tab writes it). So a bot can play the board games too: `place <id> e4`
drops a chess piece there (the rules check it as they check a drag), `place
<bowl id> D4` plays a go stone, `select <id>` asks for a piece's moves, and
`answer promo 3` promotes to a knight.

`table` lists pieces too, one per line in the same `  [id] … @x,y` frame,
a piece's spot (`at:e4`), the owner and 🔒 after it when present:
`[ab12cd34] ♛ Light man (token) ×3 @412,620 owner:Alice 🔒`, `[3c4d5e6f]
Light man (token) @610,610 at:d4`, `[cd34ef56] hidden piece ×2 @80,90`,
`[ef56ab12] supply Gold (token) ∞ @200,200`, `[0a1b2c3d] bag "Tiles" ×42
@300,300`, `[1a2b3c4d] pile "stack" ×5 top: hidden piece @500,500`,
`[2b3c4d5e] board Chessboard (board) @0,0 🔒` (a piece or a supply whose
game box this tab lacks: `? unknown piece`), and a piece you see while the
others see its back `[4d5e6f7a] 3 d6 (die) @500,300 owner:Alice 🙈 hidden
from others`. `players` shows a named seat as `[light]`, and a watcher as
`(watching)`.

Scripting: `require('./cli.js')` / `from cli import Bridge` exposes the
bridge as a small API — the same in both languages: `state`, `send`,
`wait`, `on`, plus `chat`, `play`, `draw`, `btn`, `roll(*ids)`,
`take(supply, x, y, hand)`, `place(ref, addr)`, `seat(id)` (`'-'`
stands up, `'+'` sits down again), `answer(id, value)` (a value as the
`answer` command takes it — a number is an option's index —, or a list of hand indices), `select(id)`,
`setup(box, keep, rules)`, `reset()`, `group(op, ids, kw)` (Python:
`group(op, ids, **kw)`; kw `dx`, `dy`, `deg`, `bag`), `hide(...ids)`
(Python: `hide(*ids)`) and `reveal(id)`. A game box is uploaded from the
page's 📦 only (its images are read and redrawn by the tab).
The state also carries your own parts of the rules: `asks` (`[{id, prompt,
options: [labels]} | {id, prompt, pick, among?, count?, min?, max?}]`),
`hint` (`{items, spaces}` or null), `secret` (your whole `t.secret` entry,
or null) and `strict` (whether the running rules are strict; `rules` stays
the script's name); `boxes` (`[{id, name, types, rules, src, builtin}]`:
`rules` whether it brings rules, `src` `host`, `upload` or `script`) and
`lastSetup` (the box set up last: the host's to know, null on a guest). It also carries the table (`shape`, `w`, `h`), the
named `seats` (each with its `player`, or null), `me` (your `seat` angle
and `seatId`), and the pieces (`kind`, `type`, `typeRef`, `face`, `label`,
`at` when on a board's spot, …; a hidden one only `kind: "hidden"`, one
hidden from the others but not from you all its fields and
`hiddenFromOthers: true`). `play()` names the card
by its `key` (each hand card has one), so the tab's own state lag can't
change which card goes. Pass it the card itself — `play(s.hand[i])` from
a state you hold — when you play several: a bare index is resolved
against `state` as it is when you call, and a state push between two calls
shifts the indices. Feedback meant for the player — rules vetoes, `t.tell`
notices, failed sends, command errors, peeks — arrives in `state.msgs`
(`note: …` / `error: …` / `peek: …`), not only as a toast nobody watches.
Log lines written by the rules script carry `rules: true`; key bot logic
on that, since anyone can chat (or rename themselves to) the same words.
A throwing `on()` listener is logged and skipped, and a `wait()` whose
predicate throws fails with that error. `cah-bot.py` is a complete
example — a Cards Against Humanity player that answers prompts with random
white cards (re-sending any that didn't land), and, as Card Czar, judges
on its own and presses "Judge now" after `--patience` seconds (default
60) so an idle player can't stall the round.

Reliability: the tab keeps one long-poll open, and the newest poll always
wins, so commands sent while a tab reloads wait for its next poll instead
of vanishing into the dead one. The tab toasts whether the bridge is
connected, lost, unreachable or rejecting its token (a stale URL from an
earlier CLI run), and re-sends its full state after any bridge error, so a
restarted bridge catches up at once. The REPL warns when a command is
queued for a tab it hasn't heard from in 25 s.

A terminal `play` honours the rules' face-down requirement (CAH answers go
face down without `--down`), text cards print once, in full, and nothing
other players wrote (names, cards, log lines) can put control characters —
screen clears, title or clipboard escape sequences — on your terminal.

Security shape: the bridge binds localhost only and every request carries a
token minted by the CLI — without it, any website you have open could drive
your table through that local port (requests without the token get a 403).
Invite links and QR codes are rebuilt from the room id, so the private
bridge fragment in your URL never leaks to other players. Localhost is
exempt from HTTPS mixed-content blocking in Chrome and Firefox; Safari may
refuse the `https → http://127.0.0.1` fetch.

## Honest limits

- The game lives in the host's open tab. Host offline = table paused for
  guests (they see a notice; state survives in the host's browser). Host
  migration is possible on this stack (§3.2 of the design doc) but
  deliberately not built.
- Hidden information is hidden from guests, even with devtools: hands go
  only to their owner, and the broadcast table carries pile sizes but not
  their order, and face-down cards without their identity (a peek is
  answered privately by the host; host messages are signed and addressed to
  one connection, so no peer can relay them to pose as the host and collect
  seat keys). The **host** still sees everything — its tab holds the
  authoritative state — so the host has to be someone the table trusts,
  like the dealer at a home game.
- The table always starts fitted to the smaller screen dimension; zoom and
  pan are per-player remedies, not persisted between reloads.
- Browsers: current Chrome, Edge, Firefox and Safari, and Safari on iOS
  15.4 or later (every iOS browser is Safari inside). Safari deletes a
  site's storage after 7 days without a visit to it (its tracking
  prevention): a table its host hasn't opened for a week is gone, host key
  and all — **📦 Export this table** keeps one. The host is asked to keep
  storage for good (`navigator.storage.persist()`) from its first upload of
  a deck or a game box; browsers may say no.
- The image cache can be probed: a guest asks the host only for the images
  it doesn't hold, so a host can tell whether a guest has seen a deck before.
- Rules scripts are trusted code on the host's machine, and a dishonest
  host could run different code than displayed — the same trust tier as the
  host already holding all hands. The rules Worker keeps only a reviewed
  list of globals — the language's built-ins and a few harmless platform
  ones (ENGINE.md lists them) — so a script has no network or storage API,
  no other Workers or channels, no notifications or devices, and none of
  the site's service workers; it freezes the built-ins the engine shares
  with the script, and the engine's own modules (which a script could
  `import()`), before the script runs; and it reads only the host's own
  messages. That is defence in depth rather than a sandbox:
  dynamic `import()` can't be removed without headers GitHub Pages can't
  set, so a script could still load code or reach a server. The host's page checks
  each action's changes again where the script can't reach, and refuses
  them whole: every field as the engine writes it, the rules' state
  through the engine's gates, and against who acted — no player appears,
  is renamed or changes colour but by their own join or rename, the rules'
  code changes only in the host's Enable, a guest's deck arrives as they
  sent it, and every log line and chat line speaks only for the player
  whose action it was (or for the rules). A
  runaway loop no longer freezes the host's tab (the watchdog stops it
  within about 5 s). A script sees every hidden card and
  piece, so what it tells one player (`t.tell`, a hint, `t.secret`) may
  reveal it: the engine refuses a selection of a piece hidden from the
  player selecting it, but beyond that, what a script reveals is its
  author's choice.
- The board games are honest about what they leave out. Go has **no
  dead-stone marking**: the players capture the dead stones before they
  pass, and Count scores what is on the board. Chess's draws are automatic,
  never claimed (there is no arbiter at a casual table), and it has no
  clock; a move is logged as the rules' ("📜 Rules moved ♙ e2 → e4"), since
  the script plays it. On a phone held sideways the boards are small
  (they are shaped for a phone held upright): pinch to zoom — go 19 × 19
  wants a phone held upright, and zoomed in to play near the edges. Chess,
  go and reversi each lay out the whole table: started afresh over another
  game (from 🎲, or the 📜 dialog — an edited text still named "Chess",
  "Go 9 × 9", … and Reset included), they clear the table and the hands
  first, once the host agrees. A copy saved under a name of its own is a
  script like any other: its setup takes every other item off the table
  without asking, and leaves the cards in hands where they are.
- With an ask open on a phone held sideways, the 🔒 card above the rules'
  buttons may shrink to its head (tap ▾ to fold the ask: the card's text
  and every button come back), and buttons that don't fit scroll.
- A bowl or a pile smaller than a fingertip (go 19 × 19's is 16 px wide on
  an upright phone) is taken by a press up to 22 px from its centre; other
  small pieces are not, so a finger on a crowded, zoomed-out table can
  still pan.

## Testing

The suites live in [`tests/`](tests/README.md) (how to install, run and add
one is there); `tests/run-all.sh` runs them all. Playwright suites drive
isolated browser contexts (host, guests, a raw attacker peer) through a
minimal local Nostr relay, exercising join, draw, deal, flip, drag-move,
play from hand, stacking, merging, shuffling, custom image decks, face-down
play, host reload/resume, the rules engine and the terminal bridge. Node
suites run the state core and the rules templates without a browser; a
seeded fuzzer (`core-p1.test.mjs`) checks that the incremental public view
and every guest's view folded from patches equal full recomputes after each
of 600 random ops. Storage and images have suites of their own
(`t-p1-store.js`, `t-p1-assets.js`, and the review regressions in
`t-p1-review-store.js` and `t-p1-review-assets.js`: saves, migration,
quota, storage failures, the image pull and its checks), and
`t-p1-flood.js` floods the host with image requests and big decks while
asserting it never blocks for 50 ms. The benchmarks (`t-p1-bench.js`, `core-p1-bench.mjs`)
assert the Phase 1 budgets on a 1,000-card table: bytes per move, apply and
render times, phone panning (and no layout in a gesture's frames, a piece's bar open or not, a labelled board on the table or not), snapshot size, indexed reads, the save's
main-thread time and zero image bytes on a warm rejoin.
Pieces have theirs: `core-p2.test.mjs` (game boxes, every piece action and
refusal, the public view, seats; `core-p2-bench.mjs` times a 20-dice roll),
`t-p2-hidden.js` (a raw attacker peer finds no hidden piece in anything the
host sends), `t-p2-cli.js` (the terminal bridges' piece commands), and the
browser suites for the free-table gestures, rectangular tables, named seats
and the two demos; the benchmarks also run on a 1,000-piece table. Space and
the rules Worker have `core-p3.test.mjs`, `t-p3-space.js` (snapping and
addresses), `t-p3-worker.js` and `t-p3-attack.js` (the Worker, its watchdog
and hardening, and an attacker's tries), `t-p3-ui.js` (asks, hints and the
secret card on a desktop and on phones held upright and sideways) and
`t-p3-cli.js` (the terminal's `asks`, `answer` and `select`). Play has
`t-p3-term.js` (two bot REPLs, cli.js and cli.py, answering and selecting
line for line alike) and the three demos' suites: `t-p3-chess.js` (a
desktop and two phones, every rule by real drags), `t-p3-go.js` (9 × 9 by
hand and a 361-stone 19 × 19 fill; it runs in the serial batch for B13)
and `t-p3-reversi.js`; `t-p3c-review.js` keeps the 3C review's fix-ups
(the 📜 dialog's games, a fingertip's reach, the ask panel, the secret card
on a phone held sideways). Game boxes have `core-p4.test.mjs` (the engine:
the setup grammar, addBox, setup, reset, export and import),
`t-p4-wire.js`, `t-p4-boxes.js` (the 📦 dialog on a desktop and on phones:
uploads, every hostile zip, the trust dialog, Reset, export and re-import,
chess and Hold'em resumed in another room), `t-p4-cli.js` (`boxes`,
`setup`, `reset`, `group` in both REPLs) and `t-p4-bench.js` (a 64-photo zip
imported, and a box exported, against the clock); groups and Hexfront have
`t-p4-group.js` (the group action in the rules Worker), `t-p4-select.js`
(the band, Shift+click and ⬚, a 200-piece group drag, the group bar and
keys, the inspector — on a desktop and on a phone held both ways),
`t-p4-hexfront.js` (two turns played on a desktop and a phone, with a
watcher; B18 and B21, serial) and `core-p4-bench.mjs` (B18, B19); the suites written from
the spec apart from the code check the same again — `t-p4-box-ui.js` and
`t-p4-box-files.js` (every upload, hostile file and dialog on a desktop and
on phones), `t-p4-resume.js` (chess and Hold'em exported mid-game and
played on in fresh rooms), `t-p4-attack.js` (§4j's attacker case 8 and a
group's watchdog budget in a real Worker), `t-p4-gcli.js` (the terminal's
`group` in both REPLs), `t-p4-multi.js` and `t-p4-inspect.js` (multi-select,
the group bar and the inspector on a desktop and phones held both ways),
`t-p4-hexplay.js` and `t-p4-hexbox.js` (Hexfront played turn by turn, and
exported and resumed) — with their benches `t-p4-box-bench.js`,
`t-p4-resume-bench.js` and `t-p4-hex-bench.js` (B18 and B19 on Hexfront) in
the serial batch; `t-p4-fix.js` keeps the 4B review's fix-ups (the bar
where no piece is drawn while picking — one row, re-docked when another
player moves a piece into its strip, scrolled by a wheel, keeping what it
opens or asks in sight —, ⬚'s corner, a double click that only picks,
chess's group bar, a wheel zoom that lays the page out only at its rest) and `t-p4-gflood.js`, in the serial batch, a
guest's flood of groups under a 3 MB rules state. Private material has
`core-p5.test.mjs` (the engine and the per-recipient messages, a 500-op
fuzz scanning every body, the export round trip, B22 and B23),
`t-p5-wire.js` (a raw attacker's view of cups, racks and seats),
`t-p5-private.js` (the cue, the bar's Hide, Reveal and Peek, racks and
§5j's attacker cases on a desktop and a phone) and `t-p5-cli.js` (the
terminal's `hide`, `reveal` and `peek` in both REPLs); the suites written
from the spec apart from the code check it again — `t-p5-veil.js` (§5j's
attacker cases through a host reload, a demotion and an export, every body
an attacker gets scanned), `t-p5-veil-cli.js` (both REPLs),
`t-p5-bones.js` (Dominoes' racks against a watching attacker),
`t-p5-order.js` (twenty Veiled Ranks setups: no order tells a rank) and
`t-p5-demos.js` (both demos played on a desktop and a phone) — and
`t-p5-fix.js` keeps the Phase 5 review's fix-ups on the screen (a
domino's two halves, a full rack, a hidden unit's refusal kept to its
player, a cup over unlocked dice, a wheel over the 🔒 card).
