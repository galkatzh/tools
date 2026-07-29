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
- **Cons**: without local replicas, the live document exists only while
  someone's tab is open (the invite's embedded seed is the fallback, frozen at
  creation time) — see §4 for how far persistence can actually be pushed;
  public rendezvous infrastructure is best-effort; WebRTC can fail behind
  hostile NATs without a TURN relay; mesh traffic grows ~quadratically with
  peers — fine for text with ~3–15 collaborators, wrong for hundreds (see
  §3.5 for topologies beyond the mesh).

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
  topology through the host (§3.5) or a tier-2 relay.
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

### 3.5 Topologies beyond the full mesh

Topology = who holds a WebRTC connection to whom. All of these remain
serverless; they only redistribute connections.

- **Full mesh** (what mdmath ships): everyone connects to everyone —
  n(n−1)/2 connections room-wide, n−1 per device, and each local edit is
  uploaded n−1 times by its author. Trivial at 5 peers, creaky around 30
  (435 connections; phones on shared Wi-Fi juggling 29 channels each).
  Most resilient shape: any peer's death is a non-event.
- **Star**: every player connects only to a hub peer (naturally the game
  host); n connections total, exactly 1 per player. The hub applies incoming
  writes and fans state out — a browser tab playing the role a server would
  (the same reason SFU servers exist for video conferencing). Matches
  host-authority games perfectly, since the logical flow is already
  player→host→everyone. Costs: the hub's uplink is the bottleneck (n uploads
  per state change — fine for quiz-sized payloads into the low hundreds of
  players, but the hub shouldn't be a phone on hotel Wi-Fi); the hub becomes
  a *transport* single point of failure, not just a role one — hub death
  disconnects everyone, and failover means all n players re-handshake through
  signaling (a visible multi-second outage, vs. a hiccup in the mesh); and
  player→player latency doubles (two hops). Note Trystero rooms are
  inherently full-mesh, so a star is arranged in app code (e.g. non-host
  peers refuse channels to each other, or per-player pairwise rooms
  `room-<playerId>` with the host).
- **Partial mesh / gossip**: each peer keeps a handful of random connections
  and updates propagate hop-by-hop (y-webrtc's default, with a connection
  cap). Scales further than a full mesh without concentrating load on one
  peer, at the cost of multi-hop propagation delay. A reasonable middle
  ground for ~50 peers with no designated hub. Yjs is indifferent to all of
  this — updates are idempotent and commutative, so any connected graph
  converges.

## 4. Persistence: durability vs. availability

The naive framing — "the document dies when the last tab closes" — is wrong
once peers keep local replicas (`y-indexeddb`). Every replica holds the full
document and its history; any two replicas that ever meet again merge
correctly regardless of how long they were apart or how much each side
changed. The right mental model is git: everyone has a clone, there is no
origin, and sync happens whenever two clones touch — except the merge is
automatic and guaranteed convergent. A closed document isn't dead, it's
**dormant**.

So durability is essentially solved by replication. The real limits are:

1. **Sync requires temporal overlap** — the irreducible one. A server is at
   core a machine for decoupling sync *in time* (store-and-forward: Alice
   uploads Monday, Bob downloads Tuesday). Pure P2P moves state only while a
   holder of the new edits and a wanter of them are online *simultaneously* —
   and "online" means an open, foreground tab; suspended mobile tabs don't
   sync in passing. Consistency is eventual, where "eventually" is bounded by
   human rendezvous, not by the network.
2. **No one can know they're current.** Without an authoritative copy,
   "do I have the latest?" is locally unanswerable — "no new edits" and
   "edits exist on a sleeping laptop" look identical. Which replica is *the*
   document is a social convention, not a system property.
3. **Dormant divergence merges cleanly but blindly.** A week of disconnected
   edits to the same paragraph merges without conflict markers — valid CRDT
   interleavings that nobody is prompted to review, unlike a git merge.
4. **Browser storage is a replica, not an archive.** IndexedDB is evictable
   under quota pressure, Safari deletes it after 7 days of non-use unless the
   PWA is installed (§4.2), and every replica is welded to one browser
   profile on one device. Many independent copies make loss unlikely; each
   individual copy is second-class storage. If all replicas evaporate, only
   the invite's frozen seed survives.

### 4.1 Any byte channel is a sync channel

Yjs updates are commutative, idempotent byte blobs, so the rendezvous of
limit 1 doesn't have to be a live network connection — any medium that can
carry bytes can carry sync. The seed-in-URL trick already exploits this, and
it generalizes: a peer can export "my edits since we last met" as a
compressed `#update~…` link and send it over any messenger; the recipient's
replica merges it in. That's asynchronous P2P sync with the messaging app
(or an email, or a QR code) acting as the store-and-forward server. The
rendezvous requirement can't be eliminated, but it can be delegated to any
channel — including ones with humans in the middle.

And the fully-online endpoint of the same observation: in this architecture a
server is just a peer with good uptime. A Raspberry Pi running a headless
browser that holds the room open is a dumb, untrusted, always-on replica that
closes the availability gap entirely — tier 2 semantics without granting
anyone authority over the document.

### 4.2 What a PWA adds (and doesn't)

Gains:

- **Offline app shell** — a service worker caching the app plus the CDN
  libraries (MathJax fonts included) makes mdmath load and work with no
  network after one visit. This is the "standalone copy" goal achieved
  properly: the copy lives in the browser cache instead of an email
  attachment that Gmail flags as malware. Combined with `#lz~` URLs (decoded
  entirely client-side), bookmarked share links work offline.
- **Storage durability, especially iOS** — installation exempts the app from
  Safari's 7-day script-storage eviction and improves the odds that
  `navigator.storage.persist()` is granted. This is what upgrades local
  replicas (limit 4 above) from best-effort to trustworthy on phones.
- **Quality of life** — home-screen icon, standalone window (nicer for
  presenting rendered math), manifest shortcuts, Android share-target
  (share text into mdmath), desktop `.md` file-handler registration.

Non-gains — a PWA does not:

- keep collab sessions alive (service workers can't hold WebRTC; a locked
  phone still leaves the mesh — the host's screen must stay on);
- provide push notifications without running push infrastructure;
- make Background Sync useful here (Chromium-only, and there's no server to
  sync with).

Cost: `sw.js` + manifest + icons, and the repo's PWA discipline — bump
`CACHE_NAME` on every commit touching the app, or users run stale versions
(particularly dangerous here: a stale `app.js` against a fresh
`codemirror.js` breaks the editor).

## 5. Summary of limits and their mitigations

| Limit | Fundamental? | Mitigation |
|---|---|---|
| No fair ordering / shared clock | Yes (for CRDTs) | Host-as-authority makes the ruling |
| No permissions or secrecy inside the doc | Yes | Secrecy spectrum (§3.3); accept devtools-cheating for casual play |
| Host offline stops progress | No — role is migratable | Pure-function referee + LWW election + epochs (§3.2) |
| Split-brain under partition | Yes (without consensus) | Detect via epochs, reconcile bluntly |
| Fresh edits unreachable while every holder is offline | Yes — sync needs temporal overlap (§4) | Local replicas make docs dormant, not dead; update-over-any-channel (§4.1); an always-on dumb peer or tier 2 |
| No replica knows if it's current | Yes without an authority | Social convention; an always-on replica as de-facto reference |
| Replica storage is evictable | Browser reality | PWA install + `storage.persist()` (§4.2); many replicas |
| Mesh ~n² traffic, join storms | Yes for full mesh | Fine ≤ ~30 data-only peers; star or partial mesh (§3.5); tier-2 relay beyond |
| NAT-hostile networks | Yes without TURN | Accept, or add a TURN/tier-2 fallback |
| Public rendezvous is best-effort | Inherent to tier 1 | Multiple relays; overridable relay list; self-host one |
