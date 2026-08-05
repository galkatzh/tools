# Card Table

A serverless multiplayer card-game **simulator** — no rules engine, just a
shared table: load decks, shuffle, draw, deal, move/rotate/flip cards, keep a
private hand, play face up or face down. Enough freedom to simulate most card
games the way a physical table does.

Open the page → pick a nickname → you're hosting a room → **Copy invite**
(or show the invite as a **QR** code for phones to scan) → friends open the
link, pick their nickname, and everyone plays on the same live table.

The table is **round** and everyone gets a **seat** on the rim (host-assigned
into the largest empty arc, so two players sit opposite, a third between
them, …). Seat labels show every player's name and hand count at their spot,
and each player's view auto-rotates so their own seat is at the bottom —
opponents genuinely face each other. Each player also has a private zoom and
pan: scroll to zoom about the cursor, drag empty felt to pan, and on touch
screens a two-finger pinch zooms, rotates and pans in one anchored gesture;
🧭 resets everything back to the seat view. Cards you play or deal land
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
face-down card or a pile's top card, and the log announces to everyone that
you looked.

## How it works

Built on the stack mapped out in [`../mdmath/COLLAB-DESIGN.md`](../mdmath/COLLAB-DESIGN.md):

- **Transport**: Trystero WebRTC, signaling over public Nostr relays — no
  server, no accounts. The room id + password live in the invite link's hash
  and never reach any server. `window.CARDTABLE_RELAYS` overrides the relay
  list (used by the tests, which run a tiny local NIP-01 relay).
- **Host as authority** (§3.1 of the design doc): the room opener's tab holds
  the authoritative state. Guests broadcast actions; the host applies them and
  sends each guest a personalized view — the public table, everyone's hand
  *counts*, and that guest's own hand. Bare actions + full-state broadcast, no
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
  only peer that can name cards trustworthily), keeps the last 200 in state,
  and pushes them on a dedicated channel only when the log changes; repeated
  drag/rotate entries collapse so moves don't flood it.
- **Persistence**: the host throttle-saves `{decks, state}` to `localStorage`
  keyed by room id; reopening the invite link in the host's browser resumes
  the game. If two hosts ever collide (stale resume, invite opened twice in
  the host's browser), the one holding older state demotes itself to guest.
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
(`setup` / `validate` / `onAction` / `onButton` / `onJoin` / `onLeave` /
`onTimer`) plus a facade `t` exposing every table primitive (deal, draw,
shuffle, flip, piles, hands, …), persistent scratch state (`t.data`),
broadcast UI state (`t.public`, e.g. the ⏳ turn marker), scripted buttons,
timers, and player messaging. `validate` can veto any gameplay action with a
reason (the actor gets a toast; the block goes in the log); everything a
script does is logged and bulb-marked as the "📜 Rules" actor.

Scripts run **on the host only** — guests receive data, never code — and
everyone can read the exact script being enforced (read-only view in the
Rules dialog). A script error disables the rules loudly rather than wedging
the game; rules, their state, and pending timers survive host reloads.
Templates ship for turn order, full **no-limit Hold'em with chips** (stacks
on the seat labels, automatic blinds with a rotating button, turn-enforced
betting via buttons and chat — `!bet 50`, `!allin`, `!rebuy` — streets that
deal themselves when a round closes, all-in run-outs, and an automatic
showdown that evaluates best-5-of-7, builds side pots, and pays each pot to
the right hands), **Bridge** (a real chat auction — `!bid 1H`,
`!pass`, `!double`, dealer rotation, insufficiency checks — then enforced
turns and follow-suit, the dummy laid face-up and played by the declarer,
trump-aware trick resolution, sweeping, scoring, and a 🏆 for the winning
side), **Cards Against Humanity** (the printed rules automated: a rotating
Card Czar flips a black prompt, everyone else answers face down, the columns
shuffle and reveal anonymously, the Czar crowns the funniest with 👉
buttons, ⭐ Awesome Points on the seat labels, PICK 2/3 prompts, discard
reshuffling, and first-to-the-goal wins — card texts ship in
`cah-cards.js`, CC BY-NC-SA from Cards Against Humanity LLC's free
print-and-play PDF), and a simple dealer — all plain scripts on the public
API, demos of the engine rather than features of it. The CAH template also
shows how a script keeps a ~1600-card game light on the wire: the full deck
is registered once via `t.newDeck` (script-defined text decks), while only
small draw piles sit on the table — the rest waits as indices in `t.data`. The generic engine primitives behind
winners and bidding are `onChat` (scripts parse any chat command),
`t.announce` (banner to all), and `t.win` (🏆 seat markers via
`public.winners`).

## Honest limits

- The game lives in the host's open tab. Host offline = table frozen for
  guests (state survives in the host's browser). Host migration is possible on
  this stack (§3.2 of the design doc) but deliberately not built.
- Hands are genuinely private (never sent to other peers), but face-**down
  table cards** are identified in the broadcast state — a devtools-level
  cheat. Fine for friendly play (§3.3: "no secrets" tier).
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
