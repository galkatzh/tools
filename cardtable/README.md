# Card Table

A serverless multiplayer card-game **simulator** — no rules engine, just a
shared table: load decks, shuffle, draw, deal, move/rotate/flip cards, keep a
private hand, play face up or face down. Enough freedom to simulate most card
games the way a physical table does.

Open the page → pick a nickname → you're hosting a room → **Copy invite**
(or show the invite as a **QR** code for phones to scan) → friends open the
link, pick their nickname, and everyone plays on the same live table. A
brand-new table asks the host *What are we playing?* in a slim strip along
its top edge (never a pop-up; once friends sit down it shrinks to a 🎲 chip
in the corner, clear of their seats): one click starts Hold'em, Cards Against
Humanity, Bridge, **Draughts**, **Backgammon**, turn order or a simple
dealer, keeps the free table, or opens the 📜 script editor; the **🎲 Games**
button offers the same picker any time.

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
these are played by hand). Pieces look like pieces — discs with a rim,
tiles, dice with pips, meeples, pawns, hexes — and a board's squares,
points, lines and coordinates (a–h, 1–8) are drawn crisp at any zoom. The
coordinates read upright for every player, as on a chess app's flipped
board: each stays by its file or rank, turned to face your screen (a
space's or zone's label only ever turns by a half turn: it never reads
upside down, and still runs along its space). So do the badges — a pile's
count and name, ×N, ∞, 🔒 — and a bag, and a pile's name always sits under
its pile on your screen; while two fingers turn or zoom the view they move
with the table, and settle when the fingers lift. A piece's own face (its
label, text, pips, art) stays as it lies on the table.

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
- **Hidden pieces** show only their back, to everyone: nobody's screen, not
  even its traffic, learns what a face-down tile or a bag holds. A box's
  pieces and its `meta` data are public, though — anyone at the table can
  read them (rules scripts read `t.type(…).meta`): never put a secret there.

**Tables and seats.** A game can bring a **rectangular** table (draughts
1400 × 1200): it fits the screen whichever way it turns, and each view turns
in quarter turns so the player's own edge is at the bottom. The host's size
menu shows it (▭ 1400 × 1200); picking a round size switches back, after a
confirm. A game can also name its **seats** (Light and Dark): players take
them in order, the rest **watch** (👀 top right, with how to sit — or that
every seat is taken; on a phone held sideways two small chips, "👀 2" and
"👀 Watching", that a tap opens for a few seconds). Tap a seat label for its
menu — *Sit here* on a free seat, *Stand up (watch)* on your own; the host
also seats players and moves them to the watchers. An offline player's seat
waits for them. With ordinary seating, a watcher taps **Sit down**. A guest
that loses the host for a minute reloads itself, as one that never found
the host does.

**The hand bar hides** on a table with nothing to hold (draughts,
backgammon) while your hand is empty, so the board gets the whole screen;
it comes back as soon as something that can be held is on the table.

## How it works

Built on the stack mapped out in [`../mdmath/COLLAB-DESIGN.md`](../mdmath/COLLAB-DESIGN.md):

- **Code**: no build step — the page loads plain ES modules. `core.js` is
  the table's state and every operation on it (dealing, shuffling, the
  public view, the deck sanitizer, the rules engine and its `t` facade) with
  no DOM or network, so the page and the Node tests run the same code;
  `store.js` is storage (IndexedDB) and image checking; `grid.js` is board
  geometry (cells, hexes, addresses like `e4`); `pieces.js` draws pieces,
  bags and boards (a board's structure is one SVG built from numbers only);
  `app.js` is the network, rendering and input around them, and
  `templates.js` holds the shipped rules scripts and game boxes.

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
  it; a peer on another version of Card Table is refused with a "reload this
  page" notice instead of misreading the table. Every module import carries
  the code version (`core.js?v=1`), and the page stops with a "reload" banner
  if a cached module of another version slipped in.
- **Identity**: players get a persistent random id in `localStorage`, so a
  reloaded guest reclaims their hand (WebRTC peer ids change per page load).
  Every guest action carries that id + nickname, and the host registers the
  sender on *any* action — so a lost join handshake can't permanently mute a
  guest. Until a state addressed to it arrives, a guest repeats its hello
  every 3s, and the host answers each with a snapshot (at most one per 3s),
  so a lost answer heals even on a quiet table.
- **Signaling health**: public Nostr relays are best-effort, so the status
  dot shows the truth — green with a player count when peers are connected,
  `● …` while searching, red `● ✕` when zero relays are reachable. A watchdog
  recovers from dead signaling (or a guest that can't find its host, or
  has lost it for a minute — a link to a returning host that never forms
  would otherwise freeze its screen) by auto-reloading with backoff (20s doubling to 2 min, persisted in
  this tab's sessionStorage for the room, read only by the page that reload
  opens, and kept until the guest is back with its host), with a notice that
  names the cause — our own relays first (with no peers and no relay, it
  never blames the host), then no host yet, or how long the host has been
  away; the table's hint says the same ("Connecting…", "Can't reach the
  signalling relays", "Connection lost", "Waiting for the host…", "The host
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
  in Chromium empties it (no data channel, no ICE credentials): whoever
  answered never linked — half the guests joining or reloading into a room
  open for a minute. `connect()` hands Trystero a peer connection whose
  rollback of an offer never answered does nothing (`WholeOffers`, as
  Trystero 0.26 does), so the restart re-offers it whole.
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
  slow down), and the decks guests add share one 1.5M-char budget per
  table (saved with it), so nobody can fill the host's browser storage.
  Card and deck names lose their control characters on the way in.
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
  once. A write started as the tab goes away may never land, so the tab
  also leaves a
  `ct-pending-<room>` note in localStorage, and if the save behind it never
  committed the next start says "the last moment of play before the reload
  wasn't saved". A browser that blocks IndexedDB runs the table unsaved, and
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
  and at most 64 MB a minute per guest: a bigger table's images come over
  more than one minute (the guest is told they come slowly). A deck is
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
- Fail-loudly validation: bad JSON, a `file` that matches no uploaded image,
  or an entry with neither `file` nor `name` abort the upload with a visible
  error. Uploaded images the manifest doesn't mention still join the deck,
  filename-named.

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
script does is logged as the "📜 Rules" actor.

Scripts run **on the host only** — guests receive data, never code — and
everyone can read the exact script being enforced (read-only view in the
Rules dialog). A script error disables the rules loudly rather than wedging
the game (an action whose `validate` crashed is blocked, not waved through);
rules, their state, and pending timers survive host reloads — and
re-enabling the same game after a fix or a Disable keeps its state (chips,
scores) unless the host ticks *Reset game state*. Switching to another game
discards the old one's state (the 🎲 picker asks first, and the log says so).
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
| `bag <id> <bag>` | puts a piece into a bag |
| `lock <id>` / `unlock <id>` | locks an item in place, or frees it |
| `claim <id>` / `release <id>` | makes an item yours, or nobody's |
| `seat <id>` / `seat -` / `seat +` | sits in a named seat; stands up to watch; sits down again |

`table` lists pieces too, one per line in the same `  [id] … @x,y` frame,
the owner and 🔒 after it when present: `[ab12cd34] ♛ Light man (token)
×3 @412,620 owner:Alice 🔒`, `[cd34ef56] hidden piece ×2 @80,90`,
`[ef56ab12] supply Gold (token) ∞ @200,200`, `[0a1b2c3d] bag "Tiles" ×42
@300,300`, `[1a2b3c4d] pile "stack" ×5 top: hidden piece @500,500`,
`[2b3c4d5e] board Chessboard (board) @0,0 🔒` (a piece or a supply whose
game box this tab lacks: `? unknown piece`). `players` shows a named seat
as `[light]`, and a watcher as `(watching)`.

Scripting: `require('./cli.js')` / `from cli import Bridge` exposes the
bridge as a small API — the same in both languages: `state`, `send`,
`wait`, `on`, plus `chat`, `play`, `draw`, `btn`, `roll(*ids)`,
`take(supply, x, y, hand)` and `seat(id)` (`'-'` stands up, `'+'` sits
down again). The state also carries the table (`shape`, `w`, `h`), the
named `seats` (each with its `player`, or null), `me` (your `seat` angle
and `seatId`), and the pieces (`kind`, `type`, `typeRef`, `face`, `label`,
…; a hidden one only `kind: "hidden"`). `play()` names the card
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
- The image cache can be probed: a guest asks the host only for the images
  it doesn't hold, so a host can tell whether a guest has seen a deck before.
- Rules scripts are trusted code on the host's machine: a runaway loop can
  freeze the host's tab (refresh recovers via the save), and a dishonest
  host could run different code than displayed — the same trust tier as the
  host already holding all hands.

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
render times, phone panning, snapshot size, indexed reads, the save's
main-thread time and zero image bytes on a warm rejoin.
Pieces have theirs: `core-p2.test.mjs` (game boxes, every piece action and
refusal, the public view, seats; `core-p2-bench.mjs` times a 20-dice roll),
`t-p2-hidden.js` (a raw attacker peer finds no hidden piece in anything the
host sends), `t-p2-cli.js` (the terminal bridges' piece commands), and the
browser suites for the free-table gestures, rectangular tables, named seats
and the two demos; the benchmarks also run on a 1,000-piece table.
