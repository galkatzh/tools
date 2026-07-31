# Card Table

A serverless multiplayer card-game **simulator** — no rules engine, just a
shared table: load decks, shuffle, draw, deal, move/rotate/flip cards, keep a
private hand, play face up or face down. Enough freedom to simulate most card
games the way a physical table does.

Open the page → you're hosting a room → **Copy invite** → friends join in
their browser and everyone sees the table live.

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
- **Persistence**: the host throttle-saves `{decks, state}` to `localStorage`
  keyed by room id; reopening the invite link in the host's browser resumes
  the game. If two hosts ever collide (stale resume, invite opened twice in
  the host's browser), the one holding older state demotes itself to guest.
- **Decks**: the standard 52-card deck renders as DOM/CSS; custom decks are
  uploaded images, downscaled client-side to ≤560px WebP data-URLs so they
  stay cheap to broadcast and persist.

## Honest limits

- The game lives in the host's open tab. Host offline = table frozen for
  guests (state survives in the host's browser). Host migration is possible on
  this stack (§3.2 of the design doc) but deliberately not built.
- Hands are genuinely private (never sent to other peers), but face-**down
  table cards** are identified in the broadcast state — a devtools-level
  cheat. Fine for friendly play (§3.3: "no secrets" tier).
- No pan/zoom; the fixed 16:10 table simply scales to fit, so portrait phones
  get a small table.

## Testing

E2E-tested with Playwright: two isolated browser contexts (host + guest)
connected through a minimal local Nostr relay, exercising join, draw, deal,
flip, drag-move, play from hand, stacking, merging, shuffling, custom image
decks, face-down play, and host reload/resume.
