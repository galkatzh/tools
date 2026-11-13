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
Humanity, Bridge, turn order or a simple dealer, keeps the free table, or
opens the 📜 script editor; the **🎲 Games** button offers the same picker
any time.

The table is **round** and everyone gets a **seat** on the rim (host-assigned
into the largest empty arc, so two players sit opposite, a third between
them, …). Seat labels show every player's name and hand count at their spot,
and each player's view auto-rotates so their own seat is at the bottom —
opponents genuinely face each other. Each player also has a private zoom and
pan: scroll to zoom about the cursor, drag empty felt to pan, and on touch
screens a two-finger pinch zooms, rotates and pans in one anchored gesture;
🧭 resets everything back to the seat view. On a phone, swipe the hand
sideways to scroll through it and drag a card upward out of it to play;
tap a card to enlarge it (Esc or a click closes the enlarged card and the
action buttons on a desktop). Cards you play or deal land
facing you, so your tableau reads upright to you and upside-down to the
player across, like a physical table. A circle makes all of this work:
rotation never changes how the table fits the screen. The **host** can grow
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
short "Your turn" chip pops up in the hand bar and phones vibrate; a **win** rains emoji
confetti on every screen and buzzes the winners' phones. On touch screens,
**press and hold** a face-up card (or pile top) to read it full-screen; let
go to close. Drop a hand card onto a pile to put it on top. The **⇅** button
in the hand bar sorts your hand by suit and rank, on your screen only (the
choice is remembered). On a phone held sideways, game notices and the rules'
buttons move into the margins beside the round table, off the cards. With
*reduce motion* set in the OS, nothing glides, flips, pulses or falls — the
cues still show.

## How it works

Built on the stack mapped out in [`../mdmath/COLLAB-DESIGN.md`](../mdmath/COLLAB-DESIGN.md):

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
  cards never leave the host. Bare actions + full-state broadcast, no
  CRDT: state is small and single-writer, and late joiners catch up from the
  host's first broadcast.
- **Identity**: players get a persistent random id in `localStorage`, so a
  reloaded guest reclaims their hand (WebRTC peer ids change per page load).
  Every guest action carries that id + nickname, and the host registers the
  sender on *any* action — so a lost join handshake can't permanently mute a
  guest (guests also retry the hello every 3s until the first state arrives).
- **Signaling health**: public Nostr relays are best-effort, so the status
  dot shows the truth — green with a player count when peers are connected,
  `● …` while searching, red `● ✕` when zero relays are reachable. A watchdog
  recovers from dead signaling (or a guest that can't find its host) by
  auto-reloading with backoff (20s doubling to 2 min, persisted in
  sessionStorage) — a reload is the reset that provably clears wedged relay
  subscriptions, and it's safe here because the host resumes from its save
  and guests re-enter with identity and hand intact. Relay redundancy is
  raised to 10 (default 5) so two peers are more likely to share a live one.
- **Log**: the host authors log entries while adjudicating actions (it's the
  only peer that can name cards trustworthily), keeps the last 200 actions,
  the last 50 peeks and the last 100 chat lines and renames in state
  (separate caps, so neither chatter nor a flood of moves can push the
  record of a peek out), and pushes them on a dedicated channel only when
  the log changes; repeated drag/rotate entries collapse so moves don't
  flood it, and a guest may chat or rename at most 5 times per 5 seconds.
- **Flood control**: the host is the only authority, so a guest's action
  burst could freeze the table for everyone: each guest may send a burst
  of 40 actions, then 20 per second (more are dropped, and they're told to
  slow down), and the decks guests add share one 1.5M-char budget per
  table (saved with it), so nobody can fill the host's browser storage.
  Card and deck names lose their control characters on the way in.
- **Persistence**: the host throttle-saves the state to `localStorage` keyed
  by room id (`ct-save-<room>`), with the deck images in a separate key
  written only when a deck is added; reopening the invite link in the host's
  browser resumes the game. When storage is full, other rooms' saves are
  deleted oldest first (with a toast saying so; saves another tab wrote in
  the last 30 s are spared, and none are deleted when the table wouldn't fit
  even then); if the table still can't be
  saved, the stale snapshot is replaced by a "lost" marker, so a reload
  resets the table loudly instead of silently rewinding it. Each host start
  is a new state epoch, so guests follow a restarted host even when its
  counter restarts lower. If two hosts ever collide (stale resume, invite
  opened twice in the host's browser), the one holding older state demotes
  itself to guest.
- **Decks**: the standard 52-card deck renders as DOM/CSS; custom decks are
  uploaded images, downscaled client-side to ≤560px WebP data-URLs so they
  stay cheap to broadcast and persist (~25–50 KB per card on the wire).
  Deck traffic is minimized: guests send actions targeted at the host rather
  than broadcasting to the whole mesh, and the host relays newly added decks
  as per-deck deltas (guests merge), so each player downloads a deck once and
  adding a second deck never re-ships the first.

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

Scripting: `require('./cli.js')` / `from cli import Bridge` exposes the
bridge as a small API — the same in both languages: `state`, `send`,
`wait`, `on`, plus `chat`, `play`, `draw`, `btn`. `play()` names the card
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
- Rules scripts are trusted code on the host's machine: a runaway loop can
  freeze the host's tab (refresh recovers via the save), and a dishonest
  host could run different code than displayed — the same trust tier as the
  host already holding all hands.

## Testing

E2E-tested with Playwright: two isolated browser contexts (host + guest)
connected through a minimal local Nostr relay, exercising join, draw, deal,
flip, drag-move, play from hand, stacking, merging, shuffling, custom image
decks, face-down play, and host reload/resume.
