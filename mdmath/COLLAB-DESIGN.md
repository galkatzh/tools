# Collaboration & P2P Design Notes

Design notes behind mdmath's real-time collaboration, plus the broader design
space it opens up: serverless multiplayer apps and ephemeral games built on the
same stack (Yjs CRDT + WebRTC + link-based rooms). Written as a record of the
approaches considered, what each buys, and where the hard limits are.

## 1. What mdmath ships today

- **Sync**: [Yjs](https://yjs.dev) CRDT bound to CodeMirror 6 via
  `y-codemirror.next` — concurrent edits merge conflict-free, remote cursors
  carry names/colors, undo is scoped to your own edits.
- **Transport**: peer-to-peer WebRTC via [Trystero](https://github.com/dmotz/trystero);
  connection handshakes go over public Nostr relays, so there is no server, no
  account, and no API key. Beyond discovery, traffic is direct and end-to-end
  encrypted. `window.MDMATH_COLLAB_RELAYS` overrides the relay list.
- **Rooms**: invite links are `#room~<id>~<password>~<seed>`. The password
  gates and encrypts signaling; the fragment never reaches any server.
- **Seeding**: the seed is the initial document encoded as a Yjs update with a
  **fixed clientID**, so every peer can apply the identical update
  idempotently. A late joiner with nobody else online still gets the document
  from the link alone, and when peers meet later, the shared prefix merges
  without duplicating text. (Naive per-peer seeding — each peer inserting the
  initial text itself — duplicates it on merge; the fixed-clientID trick is
  what avoids that.)

## 2. Transport tiers for real-time collaboration

The CRDT layer is settled (Yjs); the real design decision for a static-hosted
app is how peers find each other and exchange updates.

### Tier 1 — pure P2P, zero infrastructure *(implemented)*

WebRTC mesh; rendezvous over free public infrastructure (Nostr relays /
BitTorrent trackers / MQTT brokers via Trystero, or `y-webrtc`'s signaling
servers).

- **Pros**: nothing to run or pay for, no accounts, E2E-encrypted, link-based
  UX, resilience grows with peer count (any one open tab keeps the doc alive;
  updates relay through the mesh, so a partial mesh still converges; any peer
  can bootstrap a newcomer).
- **Cons**: the live document exists only while someone's tab is open (the
  invite's embedded seed is the fallback, frozen at creation time); public
  rendezvous infrastructure is best-effort; WebRTC can fail behind hostile
  NATs without a TURN relay; mesh traffic grows ~quadratically with peers —
  fine for text with ~3–15 collaborators, wrong for hundreds.

### Tier 2 — free hosted realtime backend

Liveblocks (Yjs storage + presence, domain-restricted key), PartyKit (~20-line
Yjs relay on Cloudflare), or Firebase/Supabase with a Yjs adapter.

- **Pros**: always-available document — peers can join at different times and
  nothing is lost when all tabs close; one WebSocket per client scales to
  hundreds; no NAT issues.
- **Cons**: an account and a client-visible API key; a third party carries
  (and can read, absent extra encryption) document traffic; vendor lifetime
  risk.

### Tier 3 — self-hosted relay

`y-websocket` (or a Trystero WebSocket relay) on Fly/Render/anywhere.

- **Pros**: full control, persistence on your terms.
- **Cons**: you now run a server, which this repo deliberately avoids.

**Chosen**: tier 1, with the provider isolated enough that a tier-2 backend
could be swapped in if P2P flakiness or the everyone-offline gap bites.

## 3. Ephemeral games on the same stack (Kahoot-style and beyond)

A quiz/party game is a small shared state machine: lobby roster, phase
(`lobby → question k → reveal → leaderboard`), per-player answers, scores.
That maps directly onto the existing pieces: `Y.Map`/`Y.Array` for game state,
awareness for the lobby (presence auto-expires when a tab dies), invite links
with the game packed into the seed, Trystero actions for fire-and-forget
events.

### 3.1 Host-as-authority (the baseline pattern)

Players only write to their own keys (`answers[playerId] = …` — conflict-free
by construction). Only the **host** writes phase transitions, scores, and the
leaderboard. This is client-server logic running over P2P transport, with Yjs
as the state bus.

Why an authority at all: **CRDTs guarantee convergence, not adjudication.**
Concurrent writes merge by deterministic-but-arbitrary rules (client IDs,
Lamport clocks), not by real-world order. "Who buzzed first," "did the answer
beat the timer" — there is no shared clock, timestamps are self-reported, and
latency differs per peer. Something must make the ruling; the host's observed
arrival order is the ruling (which is also how the real Kahoot works).

### 3.2 Host failover — the host is *not* a data SPOF

Every peer already holds the full public state, so a dead host loses no data.
The host is only a **role** (adjudication) and possibly a **secret custodian**.
Both can be made recoverable:

1. **Referee as a pure function.** Design the host logic so any decision
   (scoring, phase advance) is computable from the shared doc alone — no
   host-local mutable state. Then any peer can take over mid-round.
2. **Election via CRDT-arbitrated last-writer-wins.** Deterministic rule
   ("lowest alive peer ID claims the host role"), claim written as
   `hostId` + epoch counter into the shared map. If two candidates race, LWW
   converges everyone — including both candidates — to a single winner; the
   loser steps down on observing it. Textbook consensus (exactly-one-leader
   under partitions) is impossible without stronger machinery, but a few
   seconds of dual-hosting is reconcilable: highest epoch wins and recomputes
   scores from the raw answers (possible because of point 1).
3. **Partitions are the residual case.** Two halves each elect a host and play
   on; the merge after healing is semantic soup. Detectable (parallel epoch
   advances), resolved bluntly ("roll back to last common round") — acceptable
   for party games, not for money.

Net: host failure degrades from "game over" to "brief hiccup," at the cost of
the discipline above. The irreducible requirement is only that *someone* is
online for the game to progress.

### 3.3 Secrets — the actual impossibility

Yjs has no permissions: every peer holds the whole doc and may write anything.
The room key excludes outsiders, not players. And there is a clean
impossibility at the core: **if any player must be able to take over hosting,
then any player can learn what the host knows** — takeover-capability implies
secret-access. You choose a point on a spectrum:

| Approach | Cheat resistance | Failover | Cost |
|---|---|---|---|
| **No secrets** — questions *and* answers in the doc/seed | Devtools-level only | Perfect (anyone can referee) | None; right default for friendly play |
| **Commit-reveal** — host publishes `hash(answer+nonce)` up front; players commit `hash(choice+nonce)` before the deadline, reveal after | Strong for answer integrity (no copying, no retro-changes) | Successor can run the game but cannot grade the interrupted question (reveal nonce died with the host) | Small crypto layer (WebCrypto) |
| **Threshold secret sharing** — Shamir-split the answer key so no single player can read it, but any *k* of *n* can reconstruct on host death | Strong | Full | Real machinery; overkill for party games, but shows the limit is cost, not fundamentals |

Score-tampering resistance, in all cases, holds only while everyone runs the
unmodified client. Competitive-with-stakes needs a real authority (a server);
casual play does not.

### 3.4 Scale and genre limits

- **Player count**: data-only mesh is comfortable at a living-room/seminar
  scale (~10–30). Join storms (30 QR scans in ten seconds) stress public
  signaling — expect a slow first minute. Hundreds of players needs a star
  topology through the host or a tier-2 relay.
- **Genres in scope**: everything turn- or phase-based — quizzes, Codenames,
  drawing/guessing (a shared `Y.Array` of strokes is a collaborative canvas),
  chess, poker-with-commit-reveal.
- **Genres out of scope**: twitch real-time (physics at 30 ticks/s). CRDT
  metadata and reliable-ordered delivery are the wrong tool; that world wants
  raw unreliable data channels, snapshots, and interpolation. WebRTC offers
  those (and Trystero exposes plain action channels), but Yjs stops earning
  its keep.
- **Document growth**: Yjs docs grow monotonically (deletions leave
  tombstones). Irrelevant for a 20-minute game; long-lived worlds need doc
  rotation between rounds.
- **When to skip Yjs entirely**: a purely ephemeral game could run on bare
  Trystero actions + host authority. Yjs earns its place the moment late
  joiners must catch up mid-game, brief disconnects must self-heal, or the
  host role must be migratable from replicated state.

## 4. Summary of limits and their mitigations

| Limit | Fundamental? | Mitigation |
|---|---|---|
| No fair ordering / shared clock | Yes (for CRDTs) | Host-as-authority makes the ruling |
| No permissions or secrecy inside the doc | Yes | Secrecy spectrum (§3.3); accept devtools-cheating for casual play |
| Host offline stops progress | No — role is migratable | Pure-function referee + LWW election + epochs (§3.2) |
| Split-brain under partition | Yes (without consensus) | Detect via epochs, reconcile bluntly |
| Doc dies when all tabs close | Inherent to tier 1 | Seed-in-link fallback; snapshot URLs; or tier 2 |
| Mesh ~n² traffic, join storms | Yes for mesh | Fine ≤ ~30 data-only peers; star/relay beyond |
| NAT-hostile networks | Yes without TURN | Accept, or add a TURN/tier-2 fallback |
| Public rendezvous is best-effort | Inherent to tier 1 | Multiple relays; overridable relay list; self-host one |
